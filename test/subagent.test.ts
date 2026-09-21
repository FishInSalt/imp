import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { SubagentOutcome } from "../src/core/subagent.js";
import { CHILD_SUFFIX, childUsageTrailer, finalAssistantText, runSubagent } from "../src/core/subagent.js";
import type { Tool } from "../src/core/tools/types.js";
import type { LLMRequest } from "../src/provider/types.js";
import { assistant, type Gate, gate, type ScriptStep, scriptedProvider, user } from "./helpers/fakes.js";

/** A tool that settles when the gate opens OR its signal aborts — the loop
 *  awaits execute() unconditionally, so abort/timeout tests need a tool that
 *  honors the signal (as bash does in production). */
function abortAwareTool(g: Gate, name = "gated"): Tool {
	return {
		name,
		description: "resolves on gate or abort",
		parameters: Type.Object({ message: Type.String() }),
		async execute(args, signal) {
			await Promise.race([
				g.promise,
				new Promise<void>((resolve) => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				}),
			]);
			return { output: `${name}: ${String(args.message)}` };
		},
	};
}

const echo: Tool = {
	name: "echo",
	description: "echoes",
	parameters: Type.Object({ message: Type.String() }),
	async execute(args) {
		return { output: `echo: ${String(args.message)}` };
	},
};

const PARENT_SYSTEM = "You are imp (test). # Tools\n- bash: …";

describe("finalAssistantText", () => {
	it("returns the last assistant message's first non-empty text", () => {
		const messages: AgentMessage[] = [
			user("go"),
			assistant([{ type: "text", text: "first" }]),
			assistant([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }]),
			{
				role: "toolResult",
				results: [{ toolCallId: "t1", toolName: "echo", content: "ok", isError: false }],
			},
			assistant([
				{ type: "toolCall", id: "t2", name: "echo", arguments: {} },
				{ type: "text", text: "" },
			]),
		];
		// text-less final message → backward scan falls to the earlier one
		expect(finalAssistantText(messages)).toBe("first");
	});

	it("returns undefined when no assistant text exists anywhere", () => {
		const messages = [user("go"), assistant([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }])];
		expect(finalAssistantText(messages)).toBeUndefined();
	});
});

describe("runSubagent", () => {
	it("gives the child a fresh context: one user message, parent system + CHILD_SUFFIX, tools passed through", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])], sink);
		const fakeTask: Tool = {
			name: "task",
			description: "x",
			parameters: Type.Object({}),
			async execute() {
				return { output: "never" };
			},
		};
		const outcome = await runSubagent({
			provider,
			model: "glm-5.3",
			system: PARENT_SYSTEM,
			tools: [fakeTask, echo],
			prompt: "find the bug",
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.text).toBe("done");
		expect(sink).toHaveLength(1);
		const request = sink[0] as LLMRequest;
		expect(request.messages).toEqual([user("find the bug")]); // nothing of the parent's history
		expect(request.system).toBe(PARENT_SYSTEM + CHILD_SUFFIX);
		expect(request.system).toContain("You do not\nhave the task tool");
		// runSubagent does NOT filter the pool — excluding `task` is the task
		// tool's job (asserted in task-tool.test.ts / the runner integration test).
		expect(request.tools.map((t) => t.name)).toEqual(["task", "echo"]);
		expect(request.model).toBe("glm-5.3");
	});

	it("reports max_iterations after CHILD_MAX_TURNS tool-calling turns", async () => {
		const toolCallStep: ScriptStep = assistant([
			{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "again" } },
		]);
		const provider = scriptedProvider([toolCallStep]); // repeats forever
		const outcome: SubagentOutcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "loop",
		});
		expect(outcome.status).toBe("max_iterations");
		expect(outcome.turns).toBe(40);
		expect(outcome.text).toBeUndefined();
	}, 20000);

	it("maps a parent-signal abort to status 'aborted'", async () => {
		const g = gate();
		const controller = new AbortController();
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "c1", name: "gated", arguments: { message: "hold" } }]),
		]);
		const pending = runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [abortAwareTool(g)],
			prompt: "go",
			signal: controller.signal,
		});
		await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		const outcome = await pending;
		expect(outcome.status).toBe("aborted");
		expect(outcome.turns).toBe(1); // the tool returned when the signal fired
	});

	it("maps the child clock to status 'timeout' and leaves the parent signal live", async () => {
		const g = gate(); // never released: the abort race must win
		const controller = new AbortController();
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "c1", name: "gated", arguments: { message: "hold" } }]),
		]);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [abortAwareTool(g)],
			prompt: "go",
			signal: controller.signal,
			timeoutMs: 1000,
		});
		expect(outcome.status).toBe("timeout");
		expect(controller.signal.aborted).toBe(false); // only the child's clock fired
		expect(outcome.turns).toBe(1);
	});

	it("crash: partial text survives, turns/usage recomputed from history", async () => {
		const provider = scriptedProvider([
			assistant(
				[
					{ type: "text", text: "partial answer" },
					{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } },
				],
				"tool_use",
				{ inputTokens: 100, outputTokens: 7 },
			),
			() => {
				throw new Error("endpoint exploded");
			},
		]);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.reason).toBe("endpoint exploded");
		expect(outcome.text).toBe("partial answer"); // survived the crash
		expect(outcome.turns).toBe(1); // recomputed from history, not lost with the throw
		expect(outcome.usage).toEqual({
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	it("crash on the first request: zero turns, no text", async () => {
		const provider = scriptedProvider([
			() => {
				throw new Error("connection refused");
			},
		]);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.turns).toBe(0);
		expect(outcome.text).toBeUndefined();
		expect(outcome.reason).toBe("connection refused");
	});
});

describe("#overflow-recovery (child): one compact-and-retry (docs/overflow-pagination-design.md §3)", () => {
	/** Settings that make tiny test histories compactable/threshold-crossing:
	 *  keepRecentTokens 1 → cut > 0 on a 3-message history; small window for
	 *  the breaker test's onBeforeTurn path. */
	const TINY = { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 };
	const OVERFLOW = () => {
		throw new Error("prompt is too long: 300000 tokens > 262144 tokens maximum");
	};
	/** compactHistory sends the summarizer with maxTokens 2048 and no tools —
	 *  the loop's own requests carry 8192 + tools. */
	const isSummarizerCall = (r: LLMRequest): boolean => r.maxTokens === 2048 && r.tools.length === 0;

	it("overflow → compact → retry succeeds; no duplicated prompt (D3 accounting from history)", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant(
					[
						{ type: "text", text: "working" },
						{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } },
					],
					"tool_use",
					{ inputTokens: 100, outputTokens: 7 },
				),
				OVERFLOW,
				assistant([{ type: "text", text: "summary of the child work" }]),
				assistant([{ type: "text", text: "recovered" }], "end_turn", { inputTokens: 50, outputTokens: 5 }),
			],
			sink,
		);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
			settings: TINY,
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.text).toBe("recovered");
		expect(sink).toHaveLength(4); // turn → overflow → summarizer → retry
		// The failed attempt left the prompt in history exactly once; the retry
		// passed userMessage: undefined so it never re-appended.
		const retryRequest = sink[3] as LLMRequest;
		const goPrompts = retryRequest.messages.filter(
			(m) => m.role === "user" && (m as { content?: string }).content === "go",
		);
		expect(goPrompts).toHaveLength(0); // compacted into the summary message
		expect(retryRequest.messages.filter((m) => m.role === "user")).toHaveLength(1);
		// Both rounds' cost lives in history (assistant turns >= 1).
		expect((outcome.turns ?? 0) >= 1).toBe(true);
	});

	it("second overflow → crash with the guidance text; exactly one real summarizer call", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } }], "tool_use"),
				OVERFLOW,
				assistant([{ type: "text", text: "summary text" }]),
				OVERFLOW,
			],
			sink,
		);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
			settings: TINY,
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.reason ?? "").toContain("still over the window after one compaction");
		// Exactly one summarizer call (the retry's onBeforeTurn may re-enter
		// compactChildHistory, but that path never reaches an LLM here — the
		// retry threw before its first turn).
		expect(sink.filter(isSummarizerCall)).toHaveLength(1);
	});

	it("breaker tripped → overflow crashes with the disabled guidance, no summarizer call", async () => {
		const sink: LLMRequest[] = [];
		const toolStep: ScriptStep = assistant(
			[{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "again" } }],
			"tool_use",
		);
		const summarizerBoom = () => {
			throw new Error("401 Unauthorized");
		};
		const provider = scriptedProvider(
			[toolStep, summarizerBoom, toolStep, summarizerBoom, toolStep, summarizerBoom, OVERFLOW],
			sink,
		);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
			// Tiny window: every turn boundary crosses the threshold and retries
			// compaction — three summarizer failures trip the breaker.
			settings: { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 8 },
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.reason ?? "").toContain("compaction disabled after repeated failures");
		expect(sink.filter(isSummarizerCall)).toHaveLength(3); // the tripping calls, nothing after
	});

	it("nothing safe to compact (single-message history) → crash, guidance says so, zero summarizer calls", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([OVERFLOW], sink);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.reason ?? "").toContain("nothing safe to compact");
		expect(sink.filter(isSummarizerCall)).toHaveLength(0);
	});

	it("clock timeout DURING the recovery compaction → status timeout, not a misattributed crash (review P1-1)", async () => {
		const sink: LLMRequest[] = [];
		// Custom provider: the loop request overflows; the summarizer hangs until
		// its (forwarded child) signal aborts, then rejects — exactly what a real
		// provider does mid-stream.
		let call = 0;
		const provider = {
			name: "hang",
			async *stream(request: LLMRequest) {
				sink.push({ ...request, messages: [...request.messages] });
				call += 1;
				if (call === 1) {
					// A real first turn so the recovery compaction has a cut > 0.
					const message = assistant(
						[{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } }],
						"tool_use",
					);
					yield { type: "tool_call_start", id: "c1", name: "echo" } as never;
					yield { type: "message_end", message } as never;
					return;
				}
				if (!isSummarizerCall(request)) {
					throw new Error("context window exceeded");
				}
				await new Promise<never>((_, reject) => {
					if (request.signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
				yield { type: "text_delta", text: "" } as never;
			},
		};
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
			settings: TINY,
			timeoutMs: 700,
		});
		expect(sink).toHaveLength(3); // real turn + overflow attempt + hung summarizer
		expect(outcome.status).toBe("timeout");
	});

	it("summarizer 401 during recovery → crash carries the real cause (not nothing-to-compact)", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } }], "tool_use"),
				OVERFLOW,
				() => {
					throw new Error("401 Unauthorized");
				},
			],
			sink,
		);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
			settings: TINY,
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.reason ?? "").toContain("401 Unauthorized");
		expect(outcome.reason ?? "").not.toContain("nothing safe to compact");
	});
});

it("M6a: onToolCall forwards to the child loop — blocked calls return an isError result the child can recover from", async () => {
	const sink: LLMRequest[] = [];
	const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
	const provider = scriptedProvider(
		[
			assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } }]),
			assistant([{ type: "text", text: "gate blocked me, adjusting" }]),
		],
		sink,
	);
	const outcome = await runSubagent({
		provider,
		model: "m",
		system: "PARENT",
		tools: [echo],
		prompt: "go",
		onToolCall: (call) => {
			seen.push({ name: call.name, args: call.args });
			return { block: true, reason: "not allowed in scout mode" };
		},
	});
	expect(seen).toEqual([{ name: "echo", args: { message: "hi" } }]);
	// the child saw the block reason as its tool result (request 2 carries it)
	const second = JSON.stringify((sink[1] as LLMRequest).messages);
	expect(second).toContain("not allowed in scout mode");
	expect(outcome.status).toBe("completed");
	expect(outcome.text).toBe("gate blocked me, adjusting");
});

it("extraSystem (M5c) lands after CHILD_SUFFIX, append-only", async () => {
	const sink: LLMRequest[] = [];
	const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])], sink);
	await runSubagent({
		provider,
		model: "m",
		system: "PARENT",
		tools: [echo],
		prompt: "go",
		extraSystem: "AGENT-BODY",
	});
	const system = (sink[0] as LLMRequest).system;
	expect(system.startsWith("PARENT")).toBe(true);
	expect(system.indexOf("Subagent mode")).toBeGreaterThan("PARENT".length - 1);
	expect(system.indexOf("# Agent profile")).toBeGreaterThan(system.indexOf("Subagent mode"));
	expect(system.indexOf("AGENT-BODY")).toBeGreaterThan(system.indexOf("# Agent profile"));
});

describe("childUsageTrailer", () => {
	it("formats turns and tokens; cache segment only when cache read > 0", () => {
		expect(childUsageTrailer(7, { inputTokens: 12345, outputTokens: 1400, cacheReadTokens: 9800 })).toBe(
			"(child: 7 turns, 12k in / 1.4k out / 9.8k cache)",
		);
		expect(childUsageTrailer(1, { inputTokens: 10, outputTokens: 5 })).toBe(
			"(child: 1 turns, 10 in / 5 out)",
		);
		expect(childUsageTrailer(1, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 })).toBe(
			"(child: 1 turns, 10 in / 5 out)",
		);
	});
});
