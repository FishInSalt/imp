import { existsSync, appendFileSync as fsAppend, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import { BRANCH_MARK, SessionStore, SUMMARY_MARK } from "../src/core/session/store.js";

function mkpath(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "imp-session-"));
}

const user = (content: string): AgentMessage => ({ role: "user", content });
const assistantText = (text: string): AgentMessage => ({
	role: "assistant",
	blocks: [{ type: "text", text }],
	usage: { inputTokens: 100, outputTokens: 20 },
	stopReason: "end_turn",
});

describe("SessionStore", () => {
	it("creates a session file with a header and appends message entries", async () => {
		const dir = await mkpath();
		const file = path.join(dir, "s.jsonl");
		const store = SessionStore.create(file, "/proj");
		expect(existsSync(file)).toBe(true);

		store.appendMessage(user("hello"));
		store.appendMessage(assistantText("hi there"));

		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.length).toBe(3);
		const header = JSON.parse(lines[0] as string);
		expect(header.type).toBe("session");
		expect(header.version).toBe(1);
		expect(header.cwd).toBe("/proj");
		const entry = JSON.parse(lines[2] as string);
		expect(entry.type).toBe("message");
		expect(entry.message.role).toBe("assistant");
		// tree links
		const e1 = JSON.parse(lines[1] as string);
		expect(e1.parentId).toBeNull();
		expect(entry.parentId).toBe(e1.id);
		expect(store.getLeafId()).toBe(entry.id);
	});

	it("round-trips through open()", async () => {
		const dir = await mkpath();
		const file = path.join(dir, "s.jsonl");
		const original = SessionStore.create(file, "/proj");
		original.appendMessage(user("hello"));
		original.appendMessage(assistantText("hi"));
		original.appendMessage(user("bye"));

		const reopened = SessionStore.open(file);
		expect(reopened.header.cwd).toBe("/proj");
		expect(reopened.getEntries().length).toBe(3);
		const context = reopened.buildContext();
		expect(context.messages.length).toBe(3);
		expect(context.compacted).toBe(false);
		expect(context.messages[0]).toEqual(user("hello"));
	});

	it("open() rejects interior corruption but drops a torn final line", async () => {
		const dir = await mkpath();
		const badHeader = path.join(dir, "bad1.jsonl");
		const fsp = await import("node:fs");
		fsp.writeFileSync(badHeader, "not json\n");
		expect(() => SessionStore.open(badHeader)).toThrow(/first line/);

		// interior corruption: a valid line AFTER the bad one proves it is not a torn tail
		const badEntry = path.join(dir, "bad2.jsonl");
		const ok = SessionStore.create(badEntry, "/p");
		ok.appendMessage(user("a"));
		fsp.appendFileSync(badEntry, '{"type":"message","id":"x"}\n');
		ok.appendMessage(user("b")); // appends a valid line after the corrupt one
		expect(() => SessionStore.open(badEntry)).toThrow(/line 3/);

		// torn final line (crash mid-append): dropped, session still loads
		const torn = path.join(dir, "torn.jsonl");
		const t = SessionStore.create(torn, "/p");
		t.appendMessage(user("kept"));
		fsp.appendFileSync(torn, '{"type":"message","id":"partial');
		const reopened = SessionStore.open(torn);
		expect(reopened.getEntries().length).toBe(1);
		expect(reopened.buildContext().messages[0]).toEqual(user("kept"));
	});

	it("getBranch() throws on a broken parentId chain (truncated walk)", async () => {
		// open() tolerates a dangling parentId (it only validates structure),
		// so getBranch is the last line of defense: a walk that never reaches a
		// root must throw, not silently return a truncated branch whose head
		// could be a toolResult (orphaned on resume — the exact 400 that 9b432c6
		// prevents).
		const dir = await mkpath();
		const file = path.join(dir, "chain.jsonl");
		const store = SessionStore.create(file, "/p");
		store.appendMessage(user("q"));
		store.appendMessage(assistantText("a"));
		const entries = store.getEntries();
		const leaf = entries[entries.length - 1];
		void leaf;
		const fsp = await import("node:fs");
		const lines = fsp.readFileSync(file, "utf8").trimEnd().split("\n");
		const leafObj = JSON.parse(lines[lines.length - 1] as string);
		leafObj.parentId = "deadbeef"; // simulate a dangling parentId
		lines[lines.length - 1] = JSON.stringify(leafObj);
		fsp.writeFileSync(file, `${lines.join("\n")}\n`);

		const reopened = SessionStore.open(file); // structural checks pass
		expect(() => reopened.getBranch()).toThrow(/broken parentId chain/);
	});

	it("stats() throws on a broken parentId chain — pinned at the unit that owns it (M7 review)", async () => {
		const dir = await mkpath();
		const file = path.join(dir, "chain2.jsonl");
		const store = SessionStore.create(file, "/p");
		store.appendMessage(user("q"));
		const fsp = await import("node:fs");
		const lines = fsp.readFileSync(file, "utf8").trimEnd().split("\n");
		const leafObj = JSON.parse(lines[lines.length - 1] as string);
		leafObj.parentId = "missing-parent";
		lines[lines.length - 1] = JSON.stringify(leafObj);
		fsp.writeFileSync(file, lines.join("\n"));
		const reopened = SessionStore.open(file);
		expect(() => reopened.stats()).toThrow(/broken parentId chain/);
	});

	it("forkBefore: the leaf moves, appends grow a NEW branch, the old tail stays on disk (#10)", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/w");
		const u1 = store.appendMessage(user("first question"));
		store.appendMessage(assistantText("first answer"));
		const u2 = store.appendMessage(user("second question"));
		store.appendMessage(assistantText("second answer"));
		// fork before "second question": 2 kept, 2 abandoned
		const { retained, abandoned } = store.forkBefore(u2);
		expect(retained).toBe(2);
		expect(abandoned).toBe(2);
		// new appends grow the sibling branch — the old tail is off-path
		store.appendMessage(user("a different second question"));
		const onBranch = store
			.getBranch()
			.map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : ""));
		expect(onBranch.join("|")).toContain("a different second");
		expect(onBranch.join("|")).not.toContain("second answer");
		// the abandoned entries are still in the FILE (append-only tree)
		const raw = readFileSync(store.filePath, "utf8");
		expect(raw).toContain("second answer");
		// stats follow the current branch only
		expect(store.stats().messageCount).toBe(3);
	});

	it("forkBefore the FIRST user message empties the branch (retained 0) — a legal fresh start", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/w");
		const u1 = store.appendMessage(user("first"));
		store.appendMessage(assistantText("answer"));
		const { retained, abandoned } = store.forkBefore(u1);
		expect(retained).toBe(0);
		expect(abandoned).toBe(2);
		expect(store.getBranch()).toEqual([]);
		store.appendMessage(user("clean slate")); // appends at the ROOT
		expect(store.stats().messageCount).toBe(1);
	});

	it("forkBefore rejects non-user targets and entries on OTHER branches", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/w");
		store.appendMessage(user("q1"));
		const a1 = store.appendMessage(assistantText("a1"));
		const u2 = store.appendMessage(user("q2"));
		store.appendMessage(assistantText("a2"));
		store.forkBefore(u2); // abandon the a2 tail
		// an assistant entry is not a seam
		expect(() => store.forkBefore(a1)).toThrow(/not a user message/);
		// the abandoned branch's entries are reachable in-file but not forkable
		expect(() => store.forkBefore(u2)).toThrow(/not on the current branch/);
	});

	it("userForkPoints lists user messages on the CURRENT branch, oldest first", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/w");
		store.appendMessage(user("q1"));
		store.appendMessage(assistantText("a1"));
		store.appendMessage(user("q2"));
		store.appendMessage(assistantText("a2"));
		store.appendMessage(user("q3"));
		const points = store.userForkPoints();
		const texts = points.map((e) => (e.message as { role: "user"; content: string }).content);
		expect(texts).toEqual(["q1", "q2", "q3"]);
		store.forkBefore(points[1]!.id);
		const after = store.userForkPoints().map((e) => (e.message as { role: "user"; content: string }).content);
		expect(after).toEqual(["q1"]); // the tail is gone from the path
	});

	it("/tree ops: otherBranchTips, splitBranches, switchBranch (#10 batch 2)", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/w");
		store.appendMessage(user("q1"));
		store.appendMessage(assistantText("a1"));
		const u2 = store.appendMessage(user("q2"));
		store.appendMessage(assistantText("a2-old")); // abandoned tip
		store.forkBefore(u2);
		store.appendMessage(user("q2-new"));
		store.appendMessage(assistantText("a2-new")); // current tip
		// one other tip: the abandoned branch, labeled by its first user message
		const tips = store.otherBranchTips();
		expect(tips).toHaveLength(1);
		expect(tips[0]?.label).toBe("q2");
		expect(tips[0]?.count).toBe(2); // q2 + a2-old
		// the split: each side holds exactly its divergent segment
		const split = store.splitBranches(tips[0]!.id);
		expect(split.other).toHaveLength(2);
		expect(split.abandoned).toHaveLength(2); // q2-new + a2-new
		// switch: leaf moves; the old tip is back on the current path
		store.switchBranch(tips[0]!.id);
		const texts = store
			.getBranch()
			.map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : ""))
			.filter((t) => t !== "");
		expect(texts).toEqual(["q1", "q2"]);
	});

	it("switchBranch rejects the current tip, interior nodes, and off-file ids", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/w");
		store.appendMessage(user("q1"));
		const a1 = store.appendMessage(assistantText("a1"));
		const u2 = store.appendMessage(user("q2"));
		store.appendMessage(assistantText("a2"));
		expect(() => store.switchBranch(store.getLeafId() ?? "")).toThrow(/already on that branch/);
		expect(() => store.switchBranch(a1)).toThrow(/has children/); // interior
		store.forkBefore(u2);
		expect(() => store.switchBranch("deadbeef")).toThrow(/not found/);
	});

	it("branchSummary entries round-trip, join the context, and skip stats (#10 batch 2)", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/w");
		store.appendMessage(user("q1"));
		store.appendBranchSummary("tried X, failed with EACCES");
		store.appendMessage(user("q2"));
		// round-trip
		const reopened = SessionStore.open(store.filePath);
		const { messages, compacted } = reopened.buildContext();
		expect(compacted).toBe(false);
		expect(messages).toHaveLength(3); // q1 + framed summary + q2
		const framed = messages[1] as { role: string; content: string } | undefined;
		expect(framed?.content ?? "").toContain("tried X, failed with EACCES");
		expect(framed?.content ?? "").toContain(BRANCH_MARK);
		// stats: only real messages count
		expect(reopened.stats().messageCount).toBe(2);
	});

	it("position markers: a fork or switch survives a restart (review P1-2)", async () => {
		const dir = await mkpath();
		const file = path.join(dir, "s.jsonl");
		const store = SessionStore.create(file, "/w");
		store.appendMessage(user("q1"));
		store.appendMessage(assistantText("a1"));
		const u2 = store.appendMessage(user("q2"));
		store.appendMessage(assistantText("a2"));
		store.forkBefore(u2); // NO write after the fork — the classic loss case
		// reopen: the write head is where the fork put it, and the abandoned
		// tip is listable (/tree can switch back — the note's promise holds)
		const reopened = SessionStore.open(file);
		const after = reopened.userForkPoints().map((e) => (e.message as { content: string }).content);
		expect(after).toEqual(["q1"]);
		expect(reopened.otherBranchTips()).toHaveLength(1);
		expect(reopened.otherBranchTips()[0]?.label).toBe("q2");
		// a subsequent append implies its own leaf — the entry wins over the marker
		reopened.appendMessage(user("q3"));
		const again = SessionStore.open(file);
		const texts = again
			.getBranch()
			.map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : ""))
			.filter((t) => t !== "");
		expect(texts).toEqual(["q1", "q3"]);
	});

	it("position markers: switching persists too; null leaf and corrupt ids are safe", async () => {
		const dir = await mkpath();
		const file = path.join(dir, "s2.jsonl");
		const store = SessionStore.create(file, "/w");
		store.appendMessage(user("q1"));
		store.appendMessage(assistantText("a1"));
		store.appendMessage(user("q2"));
		store.appendMessage(assistantText("a2"));
		const tip = store.otherBranchTips()[0]; // none yet — switch needs a fork first
		expect(tip).toBeUndefined();
		const points = store.userForkPoints();
		store.forkBefore(points[1]!.id);
		store.appendMessage(user("q-new")); // the forked branch needs an entry to have a tip
		const oldTip = store.otherBranchTips()[0]!;
		store.switchBranch(oldTip.id);
		expect(SessionStore.open(file).otherBranchTips()).toHaveLength(1); // the forked branch's tip
		// fork before the FIRST message → null leaf persists as an empty branch
		const fresh = SessionStore.create(path.join(dir, "s3.jsonl"), "/w");
		const first = fresh.appendMessage(user("only"));
		fresh.forkBefore(first);
		expect(SessionStore.open(path.join(dir, "s3.jsonl")).getBranch()).toEqual([]);
		// a position line naming a missing id is ignored (falls back to last entry)
		fsAppend(file, `${JSON.stringify({ type: "position", leafId: "deadbeef" })}\n`);
		expect(SessionStore.open(file).stats().messageCount).toBeGreaterThan(0);
	});

	it("branchSummary after a compaction: the else branch renders both frames in order (review F4)", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s4.jsonl"), "/w");
		store.appendMessage(user("q1"));
		store.appendMessage(assistantText("a1"));
		store.appendCompaction("compacted away", [user("q1"), assistantText("a1")], 500);
		store.appendBranchSummary("left a branch");
		store.appendMessage(user("q2"));
		const { messages, compacted } = store.buildContext();
		expect(compacted).toBe(true);
		const userFrames = messages.filter((m) => m.role === "user") as Array<{ content: string }>;
		expect(userFrames.some((m) => m.content.startsWith(SUMMARY_MARK))).toBe(true);
		expect(userFrames.some((m) => m.content.startsWith(BRANCH_MARK))).toBe(true);
		// order: compaction frame first, branch frame after
		expect(userFrames.findIndex((m) => m.content.startsWith(SUMMARY_MARK))).toBeLessThan(
			userFrames.findIndex((m) => m.content.startsWith(BRANCH_MARK)),
		);
	});

	it("stats() aggregates assistant usage and turns", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		store.appendMessage(user("q"));
		store.appendMessage(assistantText("a1"));
		store.appendMessage(assistantText("a2"));
		const stats = store.stats();
		expect(stats.messageCount).toBe(3);
		expect(stats.turnCount).toBe(2);
		expect(stats.inputTokens).toBe(200);
		expect(stats.outputTokens).toBe(40);
	});

	it("stats() ignores compaction entries: not messages, usage not folded in", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		store.appendMessage(user("q"));
		store.appendMessage(assistantText("a1"));
		// compaction carries its own summary-LLM usage — it must stay out of stats
		store.appendCompaction("SUMMARY TEXT", [user("q"), assistantText("a1")], 50_000, {
			inputTokens: 999,
			outputTokens: 999,
		});
		store.appendMessage(user("after"));
		const stats = store.stats();
		expect(stats.messageCount).toBe(3); // 2 before compaction + 1 after; compaction is not a message
		expect(stats.turnCount).toBe(1);
		expect(stats.inputTokens).toBe(100);
		expect(stats.outputTokens).toBe(20);
	});

	it("stats() on a linear session matches hand-computed totals (regression pin)", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		store.appendMessage(user("q1"));
		store.appendMessage({
			role: "assistant",
			blocks: [{ type: "text", text: "a1" }],
			usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 500 },
			stopReason: "end_turn",
		});
		// toolResult messages count toward messageCount but carry no usage
		store.appendMessage({
			role: "toolResult",
			results: [{ toolCallId: "call1", toolName: "bash", content: "ok", isError: false }],
		});
		store.appendMessage({
			role: "assistant",
			blocks: [{ type: "text", text: "a2" }],
			usage: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 2000 },
			stopReason: "end_turn",
		});
		store.appendMessage(user("q2"));

		// Hand-computed: 5 message entries, 2 assistant turns; usage from
		// assistants only: input 120+80, output 30+40, cacheRead 1000+2000,
		// cacheWrite 500 (+0 when absent).
		expect(store.stats()).toEqual({
			messageCount: 5,
			turnCount: 2,
			inputTokens: 200,
			outputTokens: 70,
			cacheReadTokens: 3000,
			cacheWriteTokens: 500,
		});
	});

	it("stats() counts only the current branch after a fork", async () => {
		const dir = await mkpath();
		const file = path.join(dir, "s.jsonl");
		const store = SessionStore.create(file, "/p");
		store.appendMessage(user("question A"));
		store.appendMessage(assistantText("answer A"));

		// Fork: append a sibling turn rooted BEFORE "answer A" — the file is
		// append-only, so the tree grows a second branch and the old one stays.
		const forkParentId = store.getEntries()[0]?.id ?? null;
		const fsp = await import("node:fs");
		fsp.appendFileSync(
			file,
			`${JSON.stringify({
				type: "message",
				id: "aa11bb22",
				parentId: forkParentId,
				timestamp: new Date().toISOString(),
				message: user("question B"),
			})}\n`,
		);

		// Reopen: the forked entry is the new leaf, so turn B grows on it.
		const reopened = SessionStore.open(file);
		reopened.appendMessage(assistantText("answer B"));

		// Whole file still holds 4 entries (append-only; answer A is not deleted)
		expect(reopened.getEntries().length).toBe(4);
		// ...but stats reflects the head branch only: [question A, question B, answer B]
		const stats = reopened.stats();
		expect(stats.messageCount).toBe(3);
		expect(stats.turnCount).toBe(1); // answer A is on the abandoned branch
		expect(stats.inputTokens).toBe(100);
		expect(stats.outputTokens).toBe(20);
		// context walks the same branch — stats and buildContext must agree
		const context = reopened.buildContext();
		expect(context.messages.map((m) => (m.role === "user" ? m.content : m.role))).toEqual([
			"question A",
			"question B",
			"assistant",
		]);
	});

	it("compaction entry collapses older messages in buildContext()", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		store.appendMessage(user("old question 1"));
		store.appendMessage(assistantText("old answer 1"));
		store.appendMessage(user("recent question"));
		store.appendMessage(assistantText("recent answer"));

		const tail: AgentMessage[] = [user("recent question"), assistantText("recent answer")];
		store.appendCompaction("SUMMARY TEXT", tail, 50_000);

		const context = store.buildContext();
		expect(context.compacted).toBe(true);
		expect(context.messages.length).toBe(3);
		// summary first, framed so the model knows it is context, not a request
		const first = context.messages[0];
		if (first?.role !== "user") throw new Error("expected user message");
		expect(first.content).toContain("SUMMARY TEXT");
		expect(first.content).toContain("[Conversation summary");
		// retained tail follows verbatim
		expect(context.messages[1]).toEqual(user("recent question"));
		// original entries are still in the file (nothing deleted)
		expect(store.getEntries().length).toBe(5);
	});

	it("entries after a compaction stay in context", async () => {
		const dir = await mkpath();
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		store.appendMessage(user("old"));
		store.appendCompaction("S", [user("kept")], 1000);
		store.appendMessage(user("after compaction"));
		const context = store.buildContext();
		expect(context.messages.length).toBe(3);
		expect(context.messages[2]).toEqual(user("after compaction"));
	});
});
