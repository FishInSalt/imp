import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/core/loop.js";
import type { AgentMessage } from "../src/core/messages.js";
import type { SubagentOutcome } from "../src/core/subagent.js";
import { CHILD_SUFFIX, childUsageTrailer, finalAssistantText, runSubagent } from "../src/core/subagent.js";
import type { Tool } from "../src/core/tools/types.js";
import { loadCatalogCache, resetCatalogForTest } from "../src/provider/catalog.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { assistant, type Gate, gate, type ScriptStep, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

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

const PARENT_SYSTEM = "You are Ink (test). # Tools\n- bash: …";

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

	it("runs past 60 tool-calling turns to completion (uncapped, #loop-health)", async () => {
		// 65 DISTINCT tool turns — past the removed 60 wall; the final answer
		// ends the run. Distinct args keep the health monitor silent.
		const steps: ScriptStep[] = [];
		for (let i = 0; i < 65; i++) {
			steps.push(
				assistant([{ type: "toolCall", id: `c${i}`, name: "echo", arguments: { message: `again-${i}` } }]),
			);
		}
		steps.push(assistant([{ type: "text", text: "done after 66" }]));
		const outcome: SubagentOutcome = await runSubagent({
			provider: scriptedProvider(steps),
			model: "m",
			system: "",
			tools: [echo],
			prompt: "loop",
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.turns).toBe(66);
		expect(outcome.text).toBe("done after 66");
		expect(outcome.health).toEqual([]);
	}, 20000);

	it("repeated identical turns record a repeat-loop fact and relay one live health event", async () => {
		const steps: ScriptStep[] = [];
		for (let i = 0; i < 6; i++) {
			steps.push(
				assistant([{ type: "toolCall", id: `r${i}`, name: "echo", arguments: { message: "again" } }]),
			);
		}
		steps.push(assistant([{ type: "text", text: "recovered" }]));
		const events: AgentEvent[] = [];
		const outcome: SubagentOutcome = await runSubagent({
			provider: scriptedProvider(steps),
			model: "m",
			system: "",
			tools: [echo],
			prompt: "loop",
			onEvent: (event) => events.push(event),
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.health).toHaveLength(1);
		expect(outcome.health[0]).toMatchObject({ code: "repeat-loop", count: 6, turn: 6 }); // peak evidence moves together
		const relayed = events.filter(
			(event): event is Extract<AgentEvent, { type: "health" }> => event.type === "health",
		);
		expect(relayed).toHaveLength(1);
		// First-fire snapshot (count 5); later growth updates the outcome facts, not the relay.
		expect(relayed[0]?.signal).toMatchObject({ code: "repeat-loop", count: 5, turn: 5 });
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

	it("abort with an open tool: nothing fires after settle (#loop-health)", async () => {
		// Fake timers (design §6 item 7): no real-time race — the settled run is
		// advanced deterministically. Amendment 1 removed the only timer
		// (tool-open), so this pins the absence of post-settle facts outright.
		vi.useFakeTimers();
		try {
			const g = gate();
			const controller = new AbortController();
			const events: AgentEvent[] = [];
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
				onEvent: (event) => events.push(event),
			});
			await vi.advanceTimersByTimeAsync(0); // flush the turn to the open tool
			controller.abort();
			const outcome = await pending;
			expect(outcome.status).toBe("aborted");
			expect(outcome.health).toEqual([]);
			// Well past any former threshold: a leaked timer would have fired.
			await vi.advanceTimersByTimeAsync(1000);
			expect(events.filter((event) => event.type === "health")).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	}, 20000);

	it("INK_HEALTH=0 disables the monitor entirely (no facts, no emits)", async () => {
		const saved = process.env.INK_HEALTH;
		process.env.INK_HEALTH = "0";
		try {
			const steps: ScriptStep[] = [];
			for (let i = 0; i < 5; i++) {
				steps.push(
					assistant([{ type: "toolCall", id: `d${i}`, name: "echo", arguments: { message: "again" } }]),
				);
			}
			steps.push(assistant([{ type: "text", text: "done" }]));
			const events: AgentEvent[] = [];
			const outcome = await runSubagent({
				provider: scriptedProvider(steps),
				model: "m",
				system: "",
				tools: [echo],
				prompt: "loop",
				onEvent: (event) => events.push(event),
			});
			expect(outcome.status).toBe("completed");
			expect(outcome.health).toEqual([]);
			expect(events.filter((event) => event.type === "health")).toHaveLength(0);
		} finally {
			if (saved === undefined) delete process.env.INK_HEALTH;
			else process.env.INK_HEALTH = saved;
		}
	}, 20000);

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
		expect(outcome.turns).toBe(1); // counted from reports, not lost with the throw
		expect(outcome.usage).toEqual({
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		// SA-04: the second stream started and threw without a report
		expect(outcome.usageDetail.incomplete).toBe(true);
		expect(outcome.usageDetail.task).toEqual(outcome.usage);
		expect(outcome.usageDetail.summarizer).toEqual({ inputTokens: 0, outputTokens: 0 });
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
		// SA-04/A: a started stream threw before any report — disclosed, never
		// guessed (the flag says "not captured", not "not billed").
		expect(outcome.usageDetail.incomplete).toBe(true);
		expect(outcome.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});
});

describe("#overflow-recovery (child): one compact-and-retry (docs/design/overflow-pagination-design.md §3)", () => {
	/** Settings that make tiny test histories compactable/threshold-crossing:
	 *  keepRecentTokens 1 → cut > 0 on a 3-message history; small window for
	 *  the breaker test's onBeforeTurn path. */
	const TINY = { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 };
	const OVERFLOW = () => {
		throw new Error("prompt is too long: 300000 tokens > 262144 tokens maximum");
	};
	/** compactHistory sends the summarizer with maxTokens 2048 and no tools —
	 *  the loop's own requests carry 8192 + tools. */
	// #derived-budget: the summarizer budget is derived from the settings in
	// play — with TINY (reserveTokens 16) that is floor(0.8 × 16) = 12; the
	// mock model "m" resolves no catalog cap. The loop's own requests carry
	// the maxTokens they were configured with + tools.
	const isSummarizerCall = (r: LLMRequest): boolean =>
		r.maxTokens === Math.floor(0.8 * 16) && r.tools.length === 0;

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
		// D3 pin — the retry's own counters would report turns=1 / 50in-5out;
		// round-1-only would report 100/7. Truthful accounting is both rounds
		// plus the summarizer's own call: turns 2, 160 in / 17 out.
		expect(outcome.turns).toBe(2);
		expect(outcome.usage).toEqual({
			inputTokens: 160,
			outputTokens: 17,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		// SA-04 split: 100+50 task in / 7+5 task out, plus the summarizer 10/5;
		// the overflowed request started and threw, so incompleteness is disclosed.
		expect(outcome.usageDetail.task).toEqual({
			inputTokens: 150,
			outputTokens: 12,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(outcome.usageDetail.summarizer).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(outcome.usageDetail.summarizerCalls).toBe(1);
		expect(outcome.usageDetail.incomplete).toBe(true);
	});

	it("#loop-health: a repeat run crosses the retry boundary on one monitor (cumulative turn)", async () => {
		// 4 identical tool turns, then the overflow error, then the 5th identical
		// turn fires repeat-loop on the SAME monitor (the retry shares it) —
		// count 5, turn 5 (cumulative across both launches).
		const sink: LLMRequest[] = [];
		const call = (i: number) =>
			assistant(
				[{ type: "toolCall", id: `c${i}`, name: "echo", arguments: { message: "again" } }],
				"tool_use",
			);
		const provider = scriptedProvider(
			[
				call(0),
				call(1),
				call(2),
				call(3),
				OVERFLOW,
				assistant([{ type: "text", text: "summary of the child work" }]),
				call(4),
				assistant([{ type: "text", text: "recovered" }]),
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
		expect(outcome.health).toHaveLength(1);
		expect(outcome.health[0]).toMatchObject({ code: "repeat-loop", count: 5, turn: 5 });
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

// ── #subagent-softlanding rev 4: mode-aware clock semantics ──

describe("child clock — rev 4 semantics", () => {
	it("no timeoutMs → no clock: a hung tool ends only via the parent signal, status 'aborted'", async () => {
		// The old implicit 30-min CHILD_TIMEOUT_MS is gone. A gate that never
		// opens + no timeoutMs = the run lives until the parent aborts; the
		// abort-aware tool resolves on the forwarded child signal.
		const g = gate();
		const controller = new AbortController();
		const run = runSubagent({
			provider: scriptedProvider([
				assistant([{ type: "toolCall", id: "c1", name: "gated", arguments: { message: "hold" } }]),
			]),
			model: "m",
			system: "",
			tools: [abortAwareTool(g)],
			prompt: "go",
			signal: controller.signal,
			// deliberately NO timeoutMs — no clock may exist
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort(); // the ONLY terminator available
		const outcome = await run;
		expect(outcome.status).toBe("aborted"); // never 'timeout' — no clock exists
		expect(outcome.turns).toBe(1); // stopped at the gated tool — nothing else ran (catches a 0/NaN-clock bug)
	});

	it("timeoutMs set but not fired + parent abort → 'aborted', not 'timeout'", async () => {
		const g = gate();
		const controller = new AbortController();
		const run = runSubagent({
			provider: scriptedProvider([
				assistant([{ type: "toolCall", id: "c1", name: "gated", arguments: { message: "hold" } }]),
			]),
			model: "m",
			system: "",
			tools: [abortAwareTool(g)],
			prompt: "go",
			signal: controller.signal,
			timeoutMs: 60_000, // far away — the parent abort wins the race
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort();
		const outcome = await run;
		expect(outcome.status).toBe("aborted");
	});

	it("timeout firing inside the overflow-recovery retry loop → status 'timeout'", async () => {
		// call 1: a real tool-call turn (recovery needs cut > 0);
		// call 2: overflow error → compact (summarizer answers) → retry loop;
		// retry: gated tool call; the 300ms clock fires while it hangs.
		const g = gate();
		const controller = new AbortController();
		let call = 0;
		const isSummarizer = (r: LLMRequest) => r.maxTokens === Math.floor(0.8 * 16) && r.tools.length === 0;
		const provider = {
			name: "retry-timeout",
			async *stream(request: LLMRequest) {
				call += 1;
				if (call === 1) {
					const message = assistant(
						[{ type: "toolCall", id: "c1", name: "gated", arguments: { message: "hi" } }],
						"tool_use",
					);
					yield { type: "tool_call_start", id: "c1", name: "gated" } as never;
					yield { type: "message_end", message } as never;
					return;
				}
				if (call === 2 && !isSummarizer(request)) {
					throw new Error("context window exceeded");
				}
				if (isSummarizer(request)) {
					const summary = assistant([{ type: "text", text: "summary" }], undefined);
					yield { type: "text_delta", text: "summary" } as never;
					yield { type: "message_end", message: summary } as never;
					return;
				}
				const message = assistant(
					[{ type: "toolCall", id: "r1", name: "gated", arguments: { message: "hold" } }],
					"tool_use",
				);
				yield { type: "tool_call_start", id: "r1", name: "gated" } as never;
				yield { type: "message_end", message } as never;
				await g.promise;
			},
		};
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [abortAwareTool(g)],
			prompt: "go",
			signal: controller.signal,
			timeoutMs: 300,
			settings: { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 8 },
		});
		expect(outcome.status).toBe("timeout");
		expect(outcome.turns).toBeGreaterThanOrEqual(1);
	});

	it("default (no timeoutMs) completed run: a post-run parent abort is clean (finally removed listeners)", async () => {
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])]);
		const controller = new AbortController();
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [],
			prompt: "go",
			signal: controller.signal,
		});
		expect(outcome.status).toBe("completed");
		controller.abort(); // must not throw (dangling relay would only warn; pin cleanliness)
		expect(controller.signal.aborted).toBe(true);
	});
});

describe("SA-04 accounting (red evidence on baseline)", () => {
	it("R3: a mid-stream abort keeps known totals and discloses incomplete", async () => {
		const controller = new AbortController();
		let call = 0;
		const provider: LLMProvider = {
			name: "r3-abort",
			async *stream() {
				call++;
				if (call === 1) {
					yield {
						type: "message_end",
						message: assistant(
							[{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } }],
							"tool_use",
							{ inputTokens: 100, outputTokens: 7 },
						),
					};
					return;
				}
				yield { type: "text_delta", text: "partial answer" };
				controller.abort(); // the caller aborts while the request is in flight
				return; // abortSafe shape: the stream ends without a message_end
			},
		};
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
			signal: controller.signal,
		});
		expect(outcome.status).toBe("aborted");
		expect(outcome.turns).toBe(1);
		expect(outcome.usage).toEqual({
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(outcome.usageDetail.incomplete).toBe(true);
		expect(outcome.usageDetail.task).toEqual({
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	it("R3b: a clean completed attempt has a zero summarizer bucket and carries no incompleteness", async () => {
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])]);
		const outcome = await runSubagent({ provider, model: "m", system: "", tools: [], prompt: "go" });
		expect(outcome.status).toBe("completed");
		expect(outcome.usageDetail.summarizer).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(outcome.usageDetail.summarizerCalls).toBe(0);
		expect(outcome.usageDetail.incomplete).toBe(false);
		expect(outcome.usage).toEqual(outcome.usageDetail.task);
	});

	it("R3c: a timeout mid-stream is disclosed as incomplete with preserved totals", async () => {
		const provider: LLMProvider = {
			name: "hold",
			async *stream(request) {
				yield { type: "text_delta", text: "partial" };
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) return resolve();
					request.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return; // abortSafe shape: the clock fired, no message_end
			},
		};
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [],
			prompt: "go",
			timeoutMs: 40,
		});
		expect(outcome.status).toBe("timeout");
		expect(outcome.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(outcome.usageDetail.incomplete).toBe(true);
	});
});

describe("#output-truncation D3b (child request budget)", () => {
	it("the child request carries the catalog limit for its canonical reference", async () => {
		const dir = mkTempDir("ink-child-budget-");
		const saved = process.env.INK_CATALOG_PATH;
		process.env.INK_CATALOG_PATH = join(dir, "catalog.json");
		writeFileSync(
			process.env.INK_CATALOG_PATH,
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: {
						checkedAt: Date.now(),
						models: { "test-model": { id: "test-model", maxTokens: 60000 } },
					},
				},
			}),
			"utf-8",
		);
		loadCatalogCache();
		try {
			const sink: LLMRequest[] = [];
			const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])], sink);
			const outcome = await runSubagent({
				provider,
				model: "test-model",
				modelReference: "anthropic/test-model",
				system: PARENT_SYSTEM,
				tools: [],
				prompt: "go",
			});
			expect(outcome.status).toBe("completed");
			expect(sink[0]?.maxTokens).toBe(60000);
		} finally {
			if (saved === undefined) delete process.env.INK_CATALOG_PATH;
			else process.env.INK_CATALOG_PATH = saved;
			resetCatalogForTest();
		}
	});

	it("a catalog miss keeps the child on the loop floor (8,192)", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])], sink);
		const outcome = await runSubagent({ provider, model: "m", system: "", tools: [], prompt: "go" });
		expect(outcome.status).toBe("completed");
		expect(sink[0]?.maxTokens).toBe(8192);
	});

	it("SA-09: the resolved thinking level rides every request as-is — including `off`", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])], sink);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [],
			prompt: "go",
			thinking: "off",
		});
		expect(outcome.status).toBe("completed");
		expect(sink[0]?.thinking).toBe("off"); // design D2: raw, providers clamp/express
	});

	it("SA-09: absent thinking stays undefined (legacy callers keep the family fallback)", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])], sink);
		await runSubagent({ provider, model: "m", system: "", tools: [], prompt: "go" });
		expect(sink[0]?.thinking).toBeUndefined();
	});

	it("SA-09: the overflow retry rides the same level and the summarizer rides it too (D5)", async () => {
		const sink: LLMRequest[] = [];
		// Local copies of the runSubagent describe's fixtures (these tests live in
		// the D3b describe; identical values keep the trigger behavior in sync).
		const overflow = () => {
			throw new Error("prompt is too long: 300000 tokens > 262144 tokens maximum");
		};
		const tiny = { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 };
		const provider = scriptedProvider(
			[
				assistant(
					[
						{ type: "text", text: "working" },
						{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } },
					],
					"tool_use",
				),
				overflow,
				assistant([{ type: "text", text: "summary of the child work" }]),
				assistant([{ type: "text", text: "recovered" }]),
			],
			sink,
		);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "",
			tools: [echo],
			prompt: "go",
			settings: tiny,
			thinking: "high",
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.text).toBe("recovered");
		// turn → overflow → summarizer → retry: whichever launch or seam
		// produced the request, it carries the resolved level.
		expect(sink).toHaveLength(4);
		expect(sink.map((r) => r.thinking)).toEqual(["high", "high", "high", "high"]);
	});
});
