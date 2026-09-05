import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { SessionStore } from "../src/core/session/store.js";
import { replaySession } from "../src/repl/replay.js";

function fakeSession(messages: AgentMessage[]): SessionStore {
	return { buildContext: () => ({ messages, compacted: false }) } as unknown as SessionStore;
}

function run(messages: AgentMessage[], ansi = false, markdown = false): string {
	const chunks: string[] = [];
	const n = replaySession({ write: (s) => chunks.push(s), ansi, markdown }, fakeSession(messages));
	expect(n).toBe(messages.length);
	return chunks.join("");
}

describe("replaySession", () => {
	it("replays user lines, assistant text, tool calls with ⎿ summaries", () => {
		const out = run([
			{ role: "user", content: "fix the bug in login.ts" },
			{
				role: "assistant",
				blocks: [
					{ type: "text", text: "I'll look at the file first." },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/login.ts" } },
				],
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "tool_use",
			},
			{
				role: "toolResult",
				results: [{ toolCallId: "t1", toolName: "read", content: "line 1\nline 2\nline 3", isError: false }],
			},
			{
				role: "assistant",
				blocks: [{ type: "text", text: "Found it — off-by-one on line 2." }],
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "end_turn",
			},
		]);
		expect(out).toContain("> fix the bug in login.ts");
		expect(out).toContain("I'll look at the file first.\n\n");
		expect(out).toContain('● read {"path":"src/login.ts"} ✓');
		expect(out).toContain("⎿  line 1 (+2 lines)");
		expect(out).toContain("Found it — off-by-one on line 2.");
	});

	it("multi-line user messages show first line + (+N lines)", () => {
		const out = run([{ role: "user", content: "first line\nsecond\nthird" }]);
		expect(out).toContain("> first line (+2 lines)");
		expect(out).not.toContain("second\nthird");
	});

	it("compaction summary frame renders as a note + dim body", () => {
		const out = run([
			{
				role: "user",
				content:
					"[Conversation summary — earlier messages were compacted to save context space. Treat this as established context, not as a new request.]\n\n## Goal\nShip the parser.",
			},
		]);
		expect(out).toContain("conversation summary (earlier messages were compacted)");
		expect(out).toContain("## Goal"); // body shown (dim, unrendered)
		expect(out).not.toContain("> [Conversation summary");
	});

	it("dangling tool_use (interrupted session) is reported, not silently dropped", () => {
		const out = run([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				blocks: [{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "sleep 99" } }],
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "tool_use",
			},
		]);
		expect(out).toContain("● bash $ sleep 99 … no result (interrupted)");
	});

	it("markdown mode renders assistant text; plain mode stays verbatim", () => {
		const msgs: AgentMessage[] = [
			{
				role: "assistant",
				blocks: [{ type: "text", text: "## Title\n\n- item **one**" }],
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "end_turn",
			},
		];
		const md = run(msgs, true, true);
		expect(md).toContain("\x1b[1mTitle\x1b[0m");
		expect(md).toContain("• item \x1b[1mone\x1b[0m");
		const plain = run(msgs, false, false);
		expect(plain).toContain("## Title");
		expect(plain).not.toContain("\x1b");
	});

	it("empty session replays nothing", () => {
		const chunks: string[] = [];
		const n = replaySession({ write: (s) => chunks.push(s), ansi: false, markdown: false }, fakeSession([]));
		expect(n).toBe(0);
		expect(chunks.join("")).toBe("");
	});
});
