import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	compactHistory,
	compactSession,
	estimateContextTokens,
	estimateTokens,
	findCutIndex,
	serializeForSummary,
	shouldCompact,
	summarizeBranchSegment,
	summarizerMaxTokens,
} from "../src/core/compaction.js";
import { type AgentMessage, type AssistantMessage, contentText } from "../src/core/messages.js";
import { SessionStore, summaryToMessage } from "../src/core/session/store.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { assistant, scriptedProvider } from "./helpers/fakes.js";

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

describe("settings env parsing", () => {
	it("invalid env values fall back with a warning instead of NaN-disabling compaction", async () => {
		const { vi } = await import("vitest");
		vi.stubEnv("IMP_KEEP_RECENT", "20k");
		vi.stubEnv("IMP_CONTEXT_WINDOW", "128k");
		vi.resetModules();
		const mod = await import("../src/core/compaction.js");
		expect(mod.DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe(20000);
		expect(mod.DEFAULT_COMPACTION_SETTINGS.contextWindow).toBe(131072);
		vi.unstubAllEnvs();
		vi.resetModules();
	});
});

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

	it("cuts at an assistant boundary in tool-heavy runs (single user message)", () => {
		// one user prompt, then four tool turns — no interior user message exists;
		// the cut must land on an assistant (valid tail head: it carries its toolCalls)
		const messages = [
			user("do the task"),
			assistantToolCall,
			toolResult,
			assistantToolCall,
			toolResult,
			assistantToolCall,
			toolResult,
		];
		const cut = findCutIndex(messages, 5); // threshold met early → retain recent units
		expect(messages[cut]?.role).toBe("assistant");
		const tail = messages.slice(cut);
		expect(tail[0]?.role).not.toBe("toolResult"); // pair-safety still holds
		// the summarized prefix ends with a complete pair too
		const head = messages.slice(0, cut);
		if (head.length > 0) expect(head[head.length - 1]?.role).toBe("toolResult");
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
	function summarizerProvider(
		summary: string,
		calls: AssistantMessage[] = [],
		requests: LLMRequest[] = [],
	): LLMProvider {
		return {
			name: "mock",
			async *stream(request) {
				requests.push(request);
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

		const requests: LLMRequest[] = [];
		const result = await compactSession({
			session,
			provider: summarizerProvider("## Goal\nfind the bug", [], requests),
			model: "m",
			settings: { reserveTokens: 16_384, keepRecentTokens: 4, contextWindow: 131_072 },
			thinking: "high", // #thinking-levels: the summarizer rides the session level (pi :549)
		});
		expect(requests[0]?.thinking).toBe("high");

		expect(result).not.toBeNull();
		expect(result?.summary).toContain("## Goal");
		// transcript only contains the OLD messages
		// (verified via the summarizer request below in the second test)
		const context = session.buildContext();
		expect(context.compacted).toBe(true);
		expect(context.messages.length).toBeLessThan(6);
		expect(context.messages[0]?.role).toBe("user"); // framed summary
		// the old turns collapsed into the summary; the recent tail starts at a
		// valid boundary (assistant carries its own toolCalls) and keeps pairs intact
		expect(context.messages.some((m) => m.role === "user" && m.content === "old question one")).toBe(false);
		expect(context.messages.some((m) => m.role === "user" && m.content === "old question two")).toBe(false);
		for (const m of context.messages.slice(1)) {
			expect(m.role).not.toBe("toolResult");
		}
		const tail = context.messages.slice(1);
		if (tail.length > 0) expect(["user", "assistant"]).toContain(tail[0]?.role);
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

describe("isContextOverflowError (overflow-grace)", () => {
	it("matches every provider's phrasing; rejects unrelated errors", async () => {
		const { isContextOverflowError } = await import("../src/core/compaction.js");
		expect(
			isContextOverflowError(
				new Error(
					'Anthropic API error 400: {"error":{"message":"prompt is too long: 500000 tokens > 200000 maximum"}}',
				),
			),
		).toBe(true);
		expect(
			isContextOverflowError(new Error('OpenAI API error 400: {"error":{"code":"context_length_exceeded"}}')),
		).toBe(true);
		expect(
			isContextOverflowError(
				new Error("OpenAI Codex API error 400: This model's maximum context length is 272000 tokens"),
			),
		).toBe(true);
		expect(isContextOverflowError(new Error("request failed: too many input tokens"))).toBe(true);
		expect(
			isContextOverflowError(
				new Error('OpenAI Codex API error 400: {"detail":"Unsupported parameter: max_output_tokens"}'),
			),
		).toBe(false);
		expect(isContextOverflowError(new Error("OpenAI API error 401: bad key"))).toBe(false);
		expect(isContextOverflowError("just a string")).toBe(false);
	});
});

describe("summary quality gate + UPDATE mode (prompt-audit P2/P3)", () => {
	function overflowishHistory(turns: number): AgentMessage[] {
		const messages: AgentMessage[] = [{ role: "user", content: "go" }];
		for (let i = 0; i < turns; i++) {
			messages.push({
				role: "assistant",
				blocks: [{ type: "text", text: `turn ${i} ${"x".repeat(400)}` }],
				usage: { inputTokens: 10, outputTokens: 10 },
				stopReason: "end_turn",
			});
			messages.push({ role: "user", content: `next ${i}` });
		}
		return messages;
	}

	it("a max_tokens-capped summary is rejected — never persisted as a checkpoint", async () => {
		const provider = scriptedProvider([
			assistant([{ type: "text", text: "## Goal\nhalf a summary" }], "max_tokens"),
		]);
		const settings = { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 };
		await expect(
			compactHistory({ messages: overflowishHistory(6), provider, model: "m", settings }),
		).rejects.toThrow("token cap");
	});

	// #derived-budget: pi parity — min(0.8 × reserveTokens, model maxTokens
	// ?? Infinity). No magic constants; the reserve share is the always-present
	// bound. glm-5.3's thinking blocks count against max_tokens and the old
	// hard 2048 rejected honest full summaries (live /compact failure).
	it("summarizer budget derives from reserveTokens; a small model cap shrinks it further", async () => {
		const seen: number[] = [];
		const provider: LLMProvider = {
			name: "mock",
			async *stream(req) {
				seen.push(req.maxTokens);
				yield { type: "text_delta", text: "## Goal\nok" };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text: "## Goal\nok" }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn",
					},
				};
			},
		};
		const settings = { reserveTokens: 16384, keepRecentTokens: 1, contextWindow: 131072 };
		// No model cap → the reserve share alone (0.8 × 16384).
		await compactHistory({ messages: overflowishHistory(3), provider, model: "m", settings });
		// A 4096 model cap clamps below the reserve share.
		await compactHistory({
			messages: overflowishHistory(3),
			provider,
			model: "m",
			settings,
			modelMaxTokens: 4096,
		});
		expect(seen).toEqual([Math.floor(0.8 * 16384), 4096]);
	});

	it("summarizerMaxTokens: pi's min(0.8x reserve, modelMax) — undefined model data means reserve only", () => {
		expect(summarizerMaxTokens(16384)).toBe(13107);
		expect(summarizerMaxTokens(16384, 64000)).toBe(13107); // model cap ABOVE share: share wins
		expect(summarizerMaxTokens(16384, 4096)).toBe(4096); // model cap BELOW share: model wins
		expect(summarizerMaxTokens(16384, 0)).toBe(13107); // garbage model data ignored, not zero
	});

	it("branch summary: same max_tokens gate", async () => {
		const provider = scriptedProvider([assistant([{ type: "text", text: "half" }], "max_tokens")]);
		await expect(
			summarizeBranchSegment({ messages: overflowishHistory(3), provider, model: "m" }),
		).rejects.toThrow("token cap");
	});

	it("second compaction UPDATES the previous summary instead of re-summarizing it", async () => {
		// Round 1: CREATE. The spliced history starts with the framed summary.
		const summary1 = "## Goal\nfirst checkpoint";
		const provider1 = scriptedProvider([assistant([{ type: "text", text: summary1 }])]);
		const settings = { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 };
		const round1 = await compactHistory({
			messages: overflowishHistory(6),
			provider: provider1,
			model: "m",
			settings,
		});
		expect(round1).not.toBeNull();
		const spliced: AgentMessage[] = [summaryToMessage(round1!.summary), ...round1!.retainedTail];
		// More work happens, then round 2 compact fires.
		spliced.push(
			{
				role: "assistant",
				blocks: [{ type: "text", text: "later work".padEnd(600, ".") }],
				usage: { inputTokens: 10, outputTokens: 10 },
				stopReason: "end_turn",
			},
			{ role: "user", content: "and more" },
			{
				role: "assistant",
				blocks: [{ type: "text", text: "even later".padEnd(600, ".") }],
				usage: { inputTokens: 10, outputTokens: 10 },
				stopReason: "end_turn",
			},
		);
		const sink: LLMRequest[] = [];
		const provider2 = scriptedProvider([assistant([{ type: "text", text: "## Goal\nupdated" }])], sink);
		const round2 = await compactHistory({ messages: spliced, provider: provider2, model: "m", settings });
		expect(round2).not.toBeNull();
		const first = sink[0]?.messages[0];
		const sent = contentText(first !== undefined && first.role === "user" ? first.content : "");
		expect(sent).toContain("<previous-summary>");
		expect(sent).toContain("first checkpoint");
		expect(sent).toContain("PRESERVE all existing information");
		// The framed summary itself must NOT ride along as conversation.
		expect(sent).not.toContain("[Conversation summary");
	});

	it("first compaction stays CREATE-shaped (no previous-summary tag)", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "## Goal\nfresh" }])], sink);
		const settings = { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 };
		await compactHistory({ messages: overflowishHistory(6), provider, model: "m", settings });
		const first = sink[0]?.messages[0];
		const sent = contentText(first !== undefined && first.role === "user" ? first.content : "");
		expect(sent).not.toContain("<previous-summary>");
		expect(sent).toContain("conversation to summarize");
	});

	it("empty-transcript guard: only the old summary predates the boundary → null", async () => {
		const settings = { reserveTokens: 16, keepRecentTokens: 200000, contextWindow: 131072 };
		const provider = scriptedProvider([assistant([{ type: "text", text: "unused" }])]);
		const result = await compactHistory({
			messages: [summaryToMessage("old summary"), { role: "user", content: "hi" }],
			provider,
			model: "m",
			settings,
		});
		expect(result).toBeNull();
	});
});

// ============================================================================
// #compaction-ux F1 — anchor validity across the compaction boundary
// ============================================================================

describe("estimateContextTokens minAnchorIndex (F1)", () => {
	const u = (inputTokens: number) =>
		assistant([{ type: "text", text: "x" }], "end_turn", { inputTokens, outputTokens: 1 });

	it("default 0 keeps the legacy behavior: anchors on the last assistant usage", () => {
		const messages: AgentMessage[] = [u(100), { role: "user", content: "q" }, u(500)];
		const est = estimateContextTokens(messages);
		expect(est.tokens).toBe(501); // 500 anchor + no trailing
		expect(est.measured).toBe(true);
	});

	it("assistants before the floor never anchor; estimate degrades to chars/4 of everything", () => {
		// Post-compaction shape: [summary(user), ...tail] — the tail's last
		// assistant carries the STALE pre-compaction usage (e.g. 224852).
		const stale = u(224852);
		const tail: AgentMessage[] = [
			{ role: "user", content: "old question" },
			stale,
			{ role: "toolResult", results: [{ toolCallId: "c1", toolName: "t", content: "r", isError: false }] },
		];
		const messages: AgentMessage[] = [{ role: "user", content: "SUMMARY-TEXT ".repeat(10) }, ...tail];
		// The floor is 1 + tail.length = 4 (everything is pre-boundary) → no
		// anchor survives → pure char estimate, far below the stale reading.
		const est = estimateContextTokens(messages, 4);
		expect(est.measured).toBe(false);
		expect(est.tokens).toBeLessThan(2000); // not ~225k
		expect(est.tokens).toBeGreaterThan(0);
		// Without the floor the same history anchors on the stale usage —
		// this is the bug F1 fixes (the false "22.5% right after compaction").
		expect(estimateContextTokens(messages).tokens).toBeGreaterThan(224000);
	});

	it("assistants AFTER the floor still anchor (resume/fork: floor must not disable them)", () => {
		// A resumed compacted session: boundary at 2; a fresh post-resume
		// assistant at index 3 with real usage IS a valid anchor.
		const messages: AgentMessage[] = [
			{ role: "user", content: "summary" }, // 0
			u(224852), // 1 — stale, pre-boundary
			{ role: "user", content: "post-resume question" }, // 2 (boundary)
			u(31000), // 3 — fresh, post-boundary: valid anchor
		];
		const est = estimateContextTokens(messages, 2);
		expect(est.measured).toBe(true);
		expect(est.tokens).toBe(31001); // anchored on the FRESH usage, not the stale one
	});

	it("trailing messages after a valid anchor are still char-estimated", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "summary" },
			u(224852), // stale
			{ role: "user", content: "q" }, // boundary at 2
			u(31000), // fresh anchor
			{ role: "user", content: "a".repeat(400) }, // trailing: 100 tokens
		];
		const est = estimateContextTokens(messages, 2);
		expect(est.tokens).toBe(31001 + 100);
	});
});

describe("SessionStore.buildContext compactionBoundary (F1)", () => {
	it("uncompacted session: boundary 0", async () => {
		const dir = await mkdtemp(`${tmpdir()}/imp-f1-`);
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "cwd");
		store.appendMessage({ role: "user", content: "q" });
		const ctx = store.buildContext();
		expect(ctx.compactionBoundary).toBe(0);
		expect(ctx.compacted).toBe(false);
	});

	it("compacted session: boundary = 1 + retainedTail.length; messages after the boundary still count", async () => {
		const dir = await mkdtemp(`${tmpdir()}/imp-f1-`);
		const store = SessionStore.create(path.join(dir, "s.jsonl"), "cwd");
		const tail: AgentMessage[] = [
			{ role: "user", content: "kept q" },
			assistant([{ type: "text", text: "kept a" }], "end_turn", { inputTokens: 9, outputTokens: 1 }),
		];
		store.appendMessage({ role: "user", content: "old" });
		store.appendCompaction("SUMMARY", tail, 12345, undefined);
		store.appendMessage({ role: "user", content: "after compaction" });
		const ctx = store.buildContext();
		expect(ctx.compacted).toBe(true);
		expect(ctx.compactionBoundary).toBe(3); // summary[0] + tail[1..2] → first post-splice = 3
		expect(ctx.messages).toHaveLength(4);
		// The stale tail assistant (index 1) is below the boundary; a future
		// post-boundary assistant would anchor at index >= 3.
	});
});

describe("post-compaction estimate floor kills the false auto-compact trigger (F1, design §2 test ④)", () => {
	it("a compacted history on a 200k window does NOT re-cross shouldCompact once the floor is passed", () => {
		// The real-world shape: retained tail's last assistant reported the
		// PRE-compaction usage (224k on a 200k window). Without the floor the
		// next onBeforeTurn re-triggers (and the "nothing safe to compact"
		// note fires); with it the estimate is the new shape's char estimate.
		const stale = assistant(
			[{ type: "text", text: "answer" }],
			"end_turn",
			{ inputTokens: 224_852, outputTokens: 1 },
		);
		const post: AgentMessage[] = [
			{ role: "user", content: "SUMMARY of everything before" }, // summary message
			{ role: "user", content: "recent question" }, // retained tail (small)
			stale, // stale usage anchor — must NOT count
		];
		const settings = { reserveTokens: 16_384, keepRecentTokens: 20_000, contextWindow: 200_000 };
		// No floor: the stale anchor reads 224k → over the 200k-window threshold.
		expect(shouldCompact(estimateContextTokens(post).tokens, settings)).toBe(true);
		// With the boundary floor (everything is pre-boundary): char estimate
		// of the small new shape → far under the threshold → no re-trigger.
		const est = estimateContextTokens(post, post.length);
		expect(shouldCompact(est.tokens, settings)).toBe(false);
		expect(est.measured).toBe(false);
	});
});
