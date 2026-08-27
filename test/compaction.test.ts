import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	compactSession,
	estimateContextTokens,
	estimateTokens,
	findCutIndex,
	serializeForSummary,
	shouldCompact,
} from "../src/core/compaction.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import { SessionStore } from "../src/core/session/store.js";
import type { LLMProvider } from "../src/provider/types.js";

const user = (content: string): AgentMessage => ({ role: "user", content });
const assistantText = (text: string, inputTokens = 100): AgentMessage => ({
	role: "assistant",
	blocks: [{ type: "text", text }],
	usage: { inputTokens, outputTokens: 20 },
	stopReason: "end_turn",
});
const assistantToolCall: AgentMessage = {
	role: "assistant",
	blocks: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
	usage: { inputTokens: 200, outputTokens: 30 },
	stopReason: "tool_use",
};
const toolResult: AgentMessage = {
	role: "toolResult",
	results: [{ toolCallId: "t1", toolName: "bash", content: "file-a\nfile-b", isError: false }],
};

describe("token estimation", () => {
	it("estimates by chars/4 per message kind", () => {
		expect(estimateTokens(user("abcd"))).toBe(1); // 4 chars = 1 token
		expect(estimateTokens(user("a".repeat(400)))).toBe(100);
		const longResult: AgentMessage = {
			role: "toolResult",
			results: [{ toolCallId: "x", toolName: "read", content: "b".repeat(400), isError: false }],
		};
		expect(estimateTokens(longResult)).toBe(100);
	});

	it("anchors on the last assistant usage, estimates only the trailing messages", () => {
		const messages = [user("hi"), assistantToolCall, toolResult];
		const est = estimateContextTokens(messages);
		// usage of last assistant (200+30) + estimated toolResult (14 chars/4)
		expect(est.measured).toBe(true);
		expect(est.tokens).toBe(230 + estimateTokens(toolResult));
	});

	it("falls back to pure estimation when no usage exists", () => {
		const est = estimateContextTokens([user("hello world!")]);
		expect(est.measured).toBe(false);
		expect(est.tokens).toBe(estimateTokens(user("hello world!")));
	});

	it("shouldCompact triggers when context nears the window", () => {
		const settings = { reserveTokens: 16_384, keepRecentTokens: 20_000, contextWindow: 131_072 };
		expect(shouldCompact(100_000, settings)).toBe(false);
		expect(shouldCompact(120_000, settings)).toBe(true);
	});
});

describe("cut point", () => {
	it("keeps recent tokens and snaps forward to a user-message boundary", () => {
		// 3 turns; each user message ~400 tokens
		const big = "x".repeat(1600); // 400 tokens
		const messages = [
			user(big),
			assistantText(big),
			user(big),
			assistantText(big),
			user(big),
			assistantText(big),
		];
		// keep ~800 tokens: cut must land on a user message near the end
		const cut = findCutIndex(messages, 800);
		expect(messages[cut]?.role).toBe("user");
		const tail = messages.slice(cut);
		// tail starts with user message and is well-formed for the provider
		expect(tail[0]?.role).toBe("user");
		// never cuts mid-tool-pair: a toolResult can never be the first retained message
		const withTools = [user(big), assistantToolCall, toolResult, user("small")];
		const cut2 = findCutIndex(withTools, 50);
		expect(withTools[cut2]?.role).not.toBe("toolResult");
	});

	it("returns 0 when everything fits in the recent window", () => {
		expect(findCutIndex([user("hi"), assistantText("ok")], 20_000)).toBe(0);
	});
});

describe("serializeForSummary", () => {
	it("renders a readable transcript with roles and truncation", () => {
		const text = serializeForSummary([
			user("find the bug"),
			assistantToolCall,
			toolResult,
			assistantText("done"),
		]);
		expect(text).toContain("[user]\nfind the bug");
		expect(text).toContain("[assistant calls bash]");
		expect(text).toContain("[tool result bash]");
		expect(text).toContain("[assistant]\ndone");
		// long tool results are truncated for the summarizer
		const longMsg: AgentMessage = {
			role: "toolResult",
			results: [{ toolCallId: "x", toolName: "read", content: "y".repeat(5000), isError: false }],
		};
		expect(serializeForSummary([longMsg])).toContain("[truncated");
	});
});

describe("compactSession", () => {
	function summarizerProvider(summary: string, calls: AssistantMessage[] = []): LLMProvider {
		return {
			name: "mock",
			async *stream(request) {
				calls.push({
					role: "assistant",
					blocks: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					stopReason: "end_turn",
				});
				// sanity: the summarizer sees no tools and a single user prompt
				expect(request.tools.length).toBe(0);
				expect(request.messages.length).toBe(1);
				for (const chunk of summary) yield { type: "text_delta", text: chunk };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text: summary }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn",
					},
				};
			},
		};
	}

	it("summarizes older messages, appends a compaction entry, context shrinks", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-compact-"));
		const session = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		// turn 1+2 (old), turn 3 (recent); tiny messages, so keepRecentTokens is small too
		session.appendMessage(user("old question one"));
		session.appendMessage(assistantText("old answer one"));
		session.appendMessage(user("old question two"));
		session.appendMessage(assistantText("old answer two"));
		session.appendMessage(user("recent question"));
		session.appendMessage(assistantText("recent answer"));

		const result = await compactSession({
			session,
			provider: summarizerProvider("## Goal\nfind the bug"),
			model: "m",
			settings: { reserveTokens: 16_384, keepRecentTokens: 4, contextWindow: 131_072 },
		});

		expect(result).not.toBeNull();
		expect(result?.summary).toContain("## Goal");
		// transcript only contains the OLD messages
		// (verified via the summarizer request below in the second test)
		const context = session.buildContext();
		expect(context.compacted).toBe(true);
		expect(context.messages.length).toBeLessThan(6);
		expect(context.messages[0]?.role).toBe("user"); // framed summary
		expect(context.messages.some((m) => m.role === "user" && m.content === "recent question")).toBe(true);
		expect(context.messages.some((m) => m.role === "user" && m.content === "old question one")).toBe(false);
	});

	it("sends only the pre-cut messages to the summarizer", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-compact-"));
		const session = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		session.appendMessage(user("summarize me"));
		session.appendMessage(assistantText("ok"));
		session.appendMessage(user("keep me"));

		let seenPrompt = "";
		const provider: LLMProvider = {
			name: "mock",
			async *stream(request) {
				seenPrompt = (request.messages[0] as { content: string }).content;
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text: "summary!" }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn",
					},
				};
			},
		};
		const result = await compactSession({
			session,
			provider,
			model: "m",
			settings: { reserveTokens: 16_384, keepRecentTokens: 1, contextWindow: 131_072 },
		});
		expect(result).not.toBeNull();
		expect(seenPrompt).toContain("summarize me");
		expect(seenPrompt).not.toContain("keep me");
		expect(seenPrompt).toContain("## Goal"); // format instructions included
	});

	it("returns null when there is nothing old enough to summarize", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-compact-"));
		const session = SessionStore.create(path.join(dir, "s.jsonl"), "/p");
		session.appendMessage(user("only message"));
		session.appendMessage(assistantText("reply"));
		const result = await compactSession({
			session,
			provider: summarizerProvider("nope"),
			model: "m",
			settings: { reserveTokens: 16_384, keepRecentTokens: 20_000, contextWindow: 131_072 },
		});
		expect(result).toBeNull();
		expect(session.getEntries().length).toBe(2); // untouched
	});
});
