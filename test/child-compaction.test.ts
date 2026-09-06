import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { CompactionSettings } from "../src/core/compaction.js";
import { compactHistory } from "../src/core/compaction.js";
import { createSession, sessionsDirFor } from "../src/core/session/manager.js";
import { SessionStore, SUMMARY_MARK } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import { createTaskTool } from "../src/core/tools/task.js";
import type { Tool } from "../src/core/tools/types.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { assistant, type ScriptStep } from "./helpers/fakes.js";

/**
 * Child (subagent) auto-compaction — the machinery mirroring the main loop's
 * onBeforeTurn hook (runner.runTurnInner). All hermetic: a routing scripted
 * provider plays both roles — the child's LLM and the compaction summarizer
 * (distinguished by compactHistory's `tools: []` request shape).
 */

/** Tiny injected settings: threshold = 2500 - 500 = 2000 estimated tokens. */
const TINY_SETTINGS: CompactionSettings = {
	reserveTokens: 500,
	keepRecentTokens: 40,
	contextWindow: 2500,
};

/** Tool result payload: `${marker}:` + ~600 tokens of filler (chars/4). */
const FILLER = "r".repeat(2400);
const bigEcho: Tool = {
	name: "big_echo",
	description: "echoes with a big result",
	parameters: Type.Object({ message: Type.String() }),
	async execute(args) {
		return { output: `${String(args.message)}:${FILLER}` };
	},
};

const toolTurn = (id: string, marker: string, inputTokens: number): ScriptStep =>
	assistant([{ type: "toolCall", id, name: "big_echo", arguments: { message: marker } }], "tool_use", {
		inputTokens,
		outputTokens: 5,
	});

interface Routed {
	provider: LLMProvider;
	/** The child loop's own LLM requests, in order. */
	loopRequests: LLMRequest[];
	/** Summarizer requests (compactHistory), in order. */
	summaryRequests: LLMRequest[];
}

/** Routes by request shape: the child loop always carries its tool pool;
 *  compactHistory's summarizer call carries none (compaction.ts, tools: []). */
function routingProvider(steps: ScriptStep[], summary: string, failSummaryAttempts: number[] = []): Routed {
	const loopRequests: LLMRequest[] = [];
	const summaryRequests: LLMRequest[] = [];
	let step = 0;
	let attempt = 0;
	const provider: LLMProvider = {
		name: "mock-routed",
		async *stream(request) {
			if (request.tools.length === 0) {
				attempt++;
				summaryRequests.push({ ...request, messages: [...request.messages] });
				if (failSummaryAttempts.includes(attempt)) throw new Error("summary endpoint down");
				yield { type: "text_delta", text: summary };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text: summary }],
						usage: { inputTokens: 3, outputTokens: 2 },
						stopReason: "end_turn",
					},
				};
				return;
			}
			loopRequests.push({ ...request, messages: [...request.messages] });
			const s = steps[Math.min(step, steps.length - 1)];
			step++;
			const message = typeof s === "function" ? await s() : s;
			for (const block of message.blocks) {
				if (block.type === "text") yield { type: "text_delta", text: block.text };
				if (block.type === "toolCall") yield { type: "tool_call_start", id: block.id, name: block.name };
			}
			yield { type: "message_end", message };
		},
	};
	return { provider, loopRequests, summaryRequests };
}

const messageCounts = (requests: LLMRequest[]): number[] => requests.map((r) => r.messages.length);

describe("compactHistory (pure computation)", () => {
	const summarizer: LLMProvider = {
		name: "mock",
		async *stream() {
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					blocks: [{ type: "text", text: "SUMMARY-TEXT" }],
					usage: { inputTokens: 1, outputTokens: 1 },
					stopReason: "end_turn",
				},
			};
		},
	};

	it("summarizes the prefix and returns the retained tail — no session involved", async () => {
		const messages = [
			{ role: "user", content: "old question" } as const,
			assistant([{ type: "text", text: "old answer" }]),
			{
				role: "toolResult",
				results: [{ toolCallId: "t1", toolName: "x", content: "old result", isError: false }],
			},
			{ role: "user", content: "recent question" } as const,
			assistant([{ type: "text", text: "recent answer" }]),
		];
		const result = await compactHistory({
			messages: [...messages],
			provider: summarizer,
			model: "m",
			settings: { reserveTokens: 16_384, keepRecentTokens: 4, contextWindow: 131_072 },
		});
		expect(result).not.toBeNull();
		expect(result?.summary).toBe("SUMMARY-TEXT");
		// the retained tail is the self-contained checkpoint: valid head (the
		// threshold is met inside the newest assistant message, which carries
		// its own toolCalls — a legal tail head)
		expect(result?.retainedTail.length).toBe(1);
		expect(result?.retainedTail[0]?.role).toBe("assistant");
		expect(result?.tokensAfter).toBeLessThan(result?.tokensBefore as number);
		expect(result?.usage).toEqual({
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	it("returns null when everything fits the keep window — caller must not splice", async () => {
		const result = await compactHistory({
			messages: [
				{ role: "user", content: "only message" } as const,
				assistant([{ type: "text", text: "reply" }]),
			],
			provider: summarizer,
			model: "m",
			settings: { reserveTokens: 16_384, keepRecentTokens: 20_000, contextWindow: 131_072 },
		});
		expect(result).toBeNull();
	});
});

describe("runSubagent between-turn compaction (no session — sessions disabled)", () => {
	it("crosses the threshold mid-run: history shrinks, framed summary replaces the prefix, child completes", async () => {
		const routed = routingProvider(
			[
				toolTurn("c1", "one", 500),
				toolTurn("c2", "two", 1000),
				toolTurn("c3", "three", 1500),
				assistant([{ type: "text", text: "all done" }]),
			],
			"SUMMARY-TEXT",
		);
		const outcome = await runSubagent({
			provider: routed.provider,
			model: "m",
			system: "PARENT",
			tools: [bigEcho],
			prompt: "do the big job",
			settings: TINY_SETTINGS,
		});

		expect(outcome.status).toBe("completed");
		expect(outcome.text).toBe("all done");
		// turn budget intact: 3 tool turns + the final text — compaction bought
		// context room, not extra turns (CHILD_MAX_TURNS never resets)
		expect(outcome.turns).toBe(4);

		const counts = messageCounts(routed.loopRequests);
		// without compaction counts strictly increase (1,3,5,7): a drop proves the splice
		expect(counts).toEqual([1, 3, 5, 3]);
		expect(routed.summaryRequests).toHaveLength(1);

		const postCompaction = routed.loopRequests[3]?.messages as Array<{ role: string; content?: string }>;
		// summary message shape: framed user message, SUMMARY_MARK + the summary body
		const summaryMessage = postCompaction[0];
		expect(summaryMessage?.role).toBe("user");
		expect(summaryMessage?.content?.startsWith(SUMMARY_MARK)).toBe(true);
		expect(summaryMessage?.content).toContain("SUMMARY-TEXT");
		// retained tail keeps pairs intact: valid head, newest turn verbatim
		expect(postCompaction[1]?.role).toBe("assistant");
		const tail = JSON.stringify(postCompaction.slice(1));
		expect(tail).toContain("three");
		expect(tail).not.toContain("one");
		// the summarizer saw only the pre-cut prefix
		const transcript = JSON.stringify(routed.summaryRequests[0]?.messages);
		expect(transcript).toContain("one");
		expect(transcript).toContain("two");
		expect(transcript).not.toContain("three");
	});

	it("a failing summarizer call does not kill the child: continues un-compacted, retries next turn", async () => {
		const routed = routingProvider(
			[
				toolTurn("c1", "one", 500),
				toolTurn("c2", "two", 1500),
				toolTurn("c3", "three", 1500),
				assistant([{ type: "text", text: "survived" }]),
			],
			"SUMMARY-ON-RETRY",
			[1], // first summarizer attempt throws
		);
		const outcome = await runSubagent({
			provider: routed.provider,
			model: "m",
			system: "PARENT",
			tools: [bigEcho],
			prompt: "do the big job",
			settings: TINY_SETTINGS,
		});

		expect(outcome.status).toBe("completed");
		expect(outcome.text).toBe("survived");
		expect(routed.summaryRequests).toHaveLength(2);
		// first attempt failed → the next turn ran with the un-compacted history
		// (r3 still 5 messages); the retry at the following boundary succeeded →
		// the final-text turn saw the compacted 3-message history
		expect(messageCounts(routed.loopRequests)).toEqual([1, 3, 5, 3]);
		const final = routed.loopRequests[3]?.messages as Array<{ role: string; content?: string }>;
		expect(final[0]?.content).toContain("SUMMARY-ON-RETRY");
	});

	it("over threshold but nothing safe to cut: compactHistory null → no splice, loop continues", async () => {
		const routed = routingProvider(
			[toolTurn("c1", "one", 500), assistant([{ type: "text", text: "done" }])],
			"NEVER-USED",
		);
		const outcome = await runSubagent({
			provider: routed.provider,
			model: "m",
			system: "PARENT",
			tools: [bigEcho],
			prompt: "do the big job",
			// threshold below the estimate, but keepRecentTokens swallows the whole history
			settings: { reserveTokens: 500, keepRecentTokens: 100_000, contextWindow: 800 },
		});
		expect(outcome.status).toBe("completed");
		expect(routed.summaryRequests).toHaveLength(0);
		expect(messageCounts(routed.loopRequests)).toEqual([1, 3]); // untouched
	});
});

describe("runSubagent between-turn compaction (session store wired)", () => {
	it("appends a compaction entry; buildContext replays summary + tail; the reopened file agrees", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-child-compact-"));
		const session = SessionStore.create(path.join(dir, "child.jsonl"), dir);
		const routed = routingProvider(
			[
				toolTurn("c1", "one", 500),
				toolTurn("c2", "two", 1500),
				assistant([{ type: "text", text: "session done" }]),
			],
			"SESSION-SUMMARY",
		);
		const outcome = await runSubagent({
			provider: routed.provider,
			model: "m",
			system: "PARENT",
			tools: [bigEcho],
			prompt: "do the big job",
			settings: TINY_SETTINGS,
			session,
			// the task tool's persistence contract: onMessage mirrors history into the store
			onMessage: (message) => session.appendMessage(message),
		});

		expect(outcome.status).toBe("completed");
		const compactions = session.getEntries().filter((e) => e.type === "compaction");
		expect(compactions).toHaveLength(1);
		const entry = compactions[0];
		expect(entry?.type === "compaction" && entry.summary).toContain("SESSION-SUMMARY");
		if (entry?.type === "compaction") {
			expect(entry.retainedTail.length).toBe(2);
			expect(entry.retainedTail[0]?.role).toBe("assistant");
			expect(entry.tokensBefore).toBeGreaterThan(0);
		}

		// replay: [framed summary, retained tail..., messages after the entry]
		// (buildContext honors the entry; the final assistant text follows it)
		const context = session.buildContext();
		expect(context.compacted).toBe(true);
		expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(context.messages[0]?.role).toBe("user");
		expect((context.messages[0] as { content: string }).content.startsWith(SUMMARY_MARK)).toBe(true);

		// the live history was spliced from the same buildContext (runner mirror)
		const finalRequest = routed.loopRequests[2]?.messages as Array<{ role: string; content?: string }>;
		expect(finalRequest.length).toBe(3);
		expect(finalRequest[0]?.content).toContain("SESSION-SUMMARY");

		// the file on disk replays identically after reopen
		const reopened = SessionStore.open(session.filePath);
		expect(reopened.buildContext().compacted).toBe(true);
		expect(reopened.buildContext().messages.map((m) => m.role)).toEqual(context.messages.map((m) => m.role));
	});
});

describe("task tool end-to-end (default settings, real session seam)", () => {
	it("a context-overflowing child auto-compacts with DEFAULT settings; the children/ file gains a compaction entry", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-task-compact-"));
		const cwd = path.join(baseDir, "proj");
		const parent = createSession(cwd, baseDir);
		// ~115k estimated tokens: one tool result crosses the default threshold
		// (131072 - 16384 = 114688) without any injected settings
		const huge: Tool = {
			name: "huge",
			description: "returns a huge result",
			parameters: Type.Object({ message: Type.String() }),
			async execute(args) {
				return { output: `${String(args.message)}:${"x".repeat(460_000)}` };
			},
		};
		const routed = routingProvider(
			[
				assistant([{ type: "toolCall", id: "c1", name: "huge", arguments: { message: "load" } }], "tool_use"),
				assistant([{ type: "text", text: "e2e done" }]),
			],
			"E2E-SUMMARY",
		);
		const task = createTaskTool({
			provider: routed.provider,
			getModel: () => "m",
			getSystem: () => "PARENT",
			getTools: () => [huge],
			getSession: () => parent,
			sessionBaseDir: baseDir,
		});

		const result = await task.execute({ prompt: "read the huge thing" }, new AbortController().signal);

		expect(result.isError ?? false).toBe(false);
		expect(result.output).toContain("e2e done");
		expect(routed.summaryRequests).toHaveLength(1);

		const { readdirSync } = await import("node:fs");
		const childrenDir = path.join(sessionsDirFor(cwd, baseDir), "children");
		const files = readdirSync(childrenDir).filter((f) => f.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		const child = SessionStore.open(path.join(childrenDir, files[0] as string));
		expect(child.header.parent).toBe(parent.header.id);
		const compactions = child.getEntries().filter((e) => e.type === "compaction");
		expect(compactions).toHaveLength(1);

		// replay after compaction: framed summary first, then the retained pair,
		// then the final assistant text that followed the compaction point
		const context = child.buildContext();
		expect(context.compacted).toBe(true);
		const roles = context.messages.map((m) => m.role);
		expect(roles[0]).toBe("user");
		expect((context.messages[0] as { content: string }).content).toContain("E2E-SUMMARY");
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(
			(context.messages[roles.length - 1] as { blocks?: Array<{ type: string; text?: string }> }).blocks?.[0]
				?.text,
		).toBe("e2e done");
	}, 20000);
});

describe("IMP_AUTOCOMPACT=0 (main-loop parity)", () => {
	it("disables child compaction: no entry, no splice, no summarizer call", async () => {
		vi.stubEnv("IMP_AUTOCOMPACT", "0");
		try {
			const dir = await mkdtemp(path.join(tmpdir(), "imp-child-nocompact-"));
			const session = SessionStore.create(path.join(dir, "child.jsonl"), dir);
			const routed = routingProvider(
				[
					toolTurn("c1", "one", 500),
					toolTurn("c2", "two", 1000),
					toolTurn("c3", "three", 1500),
					assistant([{ type: "text", text: "never compacted" }]),
				],
				"NEVER-USED",
			);
			const outcome = await runSubagent({
				provider: routed.provider,
				model: "m",
				system: "PARENT",
				tools: [bigEcho],
				prompt: "do the big job",
				settings: TINY_SETTINGS,
				session,
				onMessage: (message) => session.appendMessage(message),
			});

			expect(outcome.status).toBe("completed");
			expect(routed.summaryRequests).toHaveLength(0);
			// strictly increasing — nothing was ever spliced out
			expect(messageCounts(routed.loopRequests)).toEqual([1, 3, 5, 7]);
			expect(session.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
			expect(session.buildContext().compacted).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("M7 review coverage: repeat compactions, session-path retry, failure cap, crash accounting", () => {
	it("TWO consecutive compactions in one child run: both entries persist, replay honors the latest", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-child-compact2-"));
		const session = SessionStore.create(path.join(dir, "child.jsonl"), dir);
		const routed = routingProvider(
			[
				toolTurn("c1", "one", 500),
				toolTurn("c2", "two", 1500),
				toolTurn("c3", "three", 1500),
				toolTurn("c4", "four", 1500),
				toolTurn("c5", "five", 1500),
				assistant([{ type: "text", text: "still standing" }]),
			],
			"SUMMARY-TEXT",
		);
		const outcome = await runSubagent({
			provider: routed.provider,
			model: "m",
			system: "PARENT",
			tools: [bigEcho],
			prompt: "do the big job",
			settings: TINY_SETTINGS,
			session,
			onMessage: (message) => session.appendMessage(message),
		});

		expect(outcome.status).toBe("completed");
		const compactions = session.getEntries().filter((e) => e.type === "compaction");
		expect(compactions.length).toBeGreaterThanOrEqual(2);
		// buildContext replays ONLY the last compaction's checkpoint (latest wins)
		const context = session.buildContext();
		const summaryMessages = context.messages.filter(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SUMMARY_MARK),
		);
		expect(summaryMessages).toHaveLength(1);
		// the reopened file agrees — persistence of the second splice is real
		const reopened = SessionStore.open(session.filePath);
		expect(reopened.buildContext().messages.length).toBe(context.messages.length);
		// and the live request history shows repeated re-compaction: each boundary
		// after the first normally grows by +2 messages; a non-increase marks a splice
		const counts = messageCounts(routed.loopRequests);
		let splices = 0;
		for (let i = 1; i < counts.length; i++) if ((counts[i] ?? 0) <= (counts[i - 1] ?? 0)) splices++;
		expect(splices).toBeGreaterThanOrEqual(2);
	});

	it("SESSION path: a failing summarizer retries at the next boundary and persists (mirror of the no-session test)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-child-compact3-"));
		const session = SessionStore.create(path.join(dir, "child.jsonl"), dir);
		const routed = routingProvider(
			[
				toolTurn("c1", "one", 500),
				toolTurn("c2", "two", 1500),
				toolTurn("c3", "three", 1500),
				assistant([{ type: "text", text: "survived too" }]),
			],
			"SESSION-SUMMARY-ON-RETRY",
			[1],
		);
		const outcome = await runSubagent({
			provider: routed.provider,
			model: "m",
			system: "PARENT",
			tools: [bigEcho],
			prompt: "do the big job",
			settings: TINY_SETTINGS,
			session,
			onMessage: (message) => session.appendMessage(message),
		});

		expect(outcome.status).toBe("completed");
		expect(routed.summaryRequests).toHaveLength(2); // one failure, one success
		const compactions = session.getEntries().filter((e) => e.type === "compaction");
		expect(compactions).toHaveLength(1);
		const final = routed.loopRequests.at(-1)?.messages as Array<{ role: string; content?: string }>;
		expect(final[0]?.content).toContain("SESSION-SUMMARY-ON-RETRY");
	});

	it("failure cap: 3 consecutive summarizer failures disable compaction for the run (one stderr note, run continues)", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const routed = routingProvider(
				[
					toolTurn("c1", "one", 500),
					toolTurn("c2", "two", 1500),
					toolTurn("c3", "three", 1500),
					toolTurn("c4", "four", 1500),
					toolTurn("c5", "five", 1500),
					assistant([{ type: "text", text: "gave up quietly" }]),
				],
				"NEVER-USED",
				[1, 2, 3, 4, 5, 6, 7, 8], // every attempt fails
			);
			const outcome = await runSubagent({
				provider: routed.provider,
				model: "m",
				system: "PARENT",
				tools: [bigEcho],
				prompt: "do the big job",
				settings: TINY_SETTINGS,
			});

			expect(outcome.status).toBe("completed");
			expect(outcome.text).toBe("gave up quietly");
			// exactly 3 summarizer attempts — the cap stopped the bleeding
			expect(routed.summaryRequests).toHaveLength(3);
			// one teaching note, once
			const notes = stderr.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes("child compaction failed"));
			expect(notes).toHaveLength(1);
			// history never spliced: strictly increasing request sizes
			const counts = messageCounts(routed.loopRequests);
			for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1] ?? 0);
		} finally {
			stderr.mockRestore();
		}
	});

	it("crash AFTER a compaction: the trailer counts the summarized-away turns and usage, not just the spliced tail", async () => {
		const routed = routingProvider(
			[
				toolTurn("c1", "one", 500),
				toolTurn("c2", "two", 1500),
				() => {
					throw new Error("endpoint exploded");
				},
			],
			"SUMMARY-TEXT",
		);
		const outcome = await runSubagent({
			provider: routed.provider,
			model: "m",
			system: "PARENT",
			tools: [bigEcho],
			prompt: "do the big job",
			settings: TINY_SETTINGS,
		});

		expect(outcome.status).toBe("crash");
		expect(outcome.reason).toBe("endpoint exploded");
		expect(routed.summaryRequests).toHaveLength(1); // exactly one compaction happened
		// crash turns count ASSISTANT messages in history + the summarized-away
		// ones: post-splice history keeps a2 (1), a1 was summarized (1) → 2 —
		// without the accumulator the trailer would undercount at 1
		expect(outcome.turns).toBe(2);
		// usage: spliced-history stats (c2: 1500 in / 5 out)
		//      + summarized-away c1 (500 in / 5 out)
		//      + the summarizer call itself (3 in / 2 out)
		expect(outcome.usage.inputTokens).toBe(1500 + 500 + 3);
		expect(outcome.usage.outputTokens).toBe(5 + 5 + 2);
	});
});
