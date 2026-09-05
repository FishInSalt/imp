import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import { SessionStore } from "../src/core/session/store.js";

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
