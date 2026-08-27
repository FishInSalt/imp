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
