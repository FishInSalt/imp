import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentEvent } from "../src/core/loop.js";
import { runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage } from "../src/core/messages.js";
import { runSubagent } from "../src/core/subagent.js";
import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createReadTool } from "../src/core/tools/read.js";
import type { Tool } from "../src/core/tools/types.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { LLMRequest } from "../src/provider/types.js";
import { assistant, type Gate, gate, scriptedProvider, waitUntil } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

/** Signal-observing gated tool — the loop awaits execute() unconditionally, so
 *  concurrency/abort tests need tools that honor the signal (as bash does). */
function holdTool(name: string, g: Gate, onRun?: () => void): Tool {
	return {
		name,
		description: "holds until the gate opens or the signal aborts",
		parameters: Type.Object({ message: Type.String() }),
		concurrencySafe: true,
		async execute(_args, signal) {
			onRun?.();
			await Promise.race([
				g.promise,
				new Promise<void>((resolve) => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				}),
			]);
			return { output: `${name} done` };
		},
	};
}

function delayTool(name: string, ms: number): Tool {
	return {
		name,
		description: "settles after a delay",
		parameters: Type.Object({ message: Type.String() }),
		concurrencySafe: true,
		async execute(args) {
			await new Promise((r) => setTimeout(r, ms));
			return { output: `${name}: ${String(args.message)}` };
		},
	};
}

function _serialTool(name: string, log: string[]): Tool {
	return {
		name,
		description: "serial by default",
		parameters: Type.Object({ message: Type.String() }),
		async execute(args) {
			log.push(`${name}:start`);
			return { output: `${name}: ${String(args.message)}` };
		},
	};
}

function calls(names: string[]) {
	return assistant(
		names.map((n, i) => ({
			type: "toolCall" as const,
			id: `c${i + 1}`,
			name: n,
			arguments: { message: "go" },
		})),
		"tool_use",
	);
}

const finalText = assistant([{ type: "text", text: "done" }]);

describe("tool concurrency (M5b design §6)", () => {
	it("default tools stay strictly serial: t1 ends before t2 starts", async () => {
		const events: string[] = [];
		const track = (name: string): Tool => ({
			name,
			description: "serial",
			parameters: Type.Object({ message: Type.String() }),
			async execute(args) {
				events.push(`${name}:start`);
				await new Promise((r) => setTimeout(r, 5));
				events.push(`${name}:end`);
				return { output: `${name} ${String(args.message)}` };
			},
		});
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider: scriptedProvider([calls(["s1", "s2"]), finalText]),
			model: "m",
			system: "",
			tools: [track("s1"), track("s2")],
			history,
			userMessage: "go",
		});
		expect(events).toEqual(["s1:start", "s1:end", "s2:start", "s2:end"]);
	});

	it("consecutive safe calls overlap: both start before either ends; ends emit in call order", async () => {
		const ga = gate();
		const gb = gate();
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(["slow", "fast"]), finalText]),
			model: "m",
			system: "",
			tools: [holdTool("slow", ga), holdTool("fast", gb)],
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		await waitUntil(() => events.filter((e) => e.type === "tool_start").length === 2);
		expect(events.filter((e) => e.type === "tool_end")).toHaveLength(0); // overlapped, none finished
		gb.resolve(); // fast finishes FIRST …
		await new Promise((r) => setTimeout(r, 20));
		expect(events.filter((e) => e.type === "tool_end")).toHaveLength(0); // … but cannot emit ahead of slow
		ga.resolve();
		const result = await pending;
		const ends = events.filter((e) => e.type === "tool_end");
		expect((ends[0] as { result: { toolName: string } }).result.toolName).toBe("slow"); // call order
		expect((ends[1] as { result: { toolName: string } }).result.toolName).toBe("fast");
		// Result array in the toolResult message also follows call order.
		const toolResults = history.find((m) => m.role === "toolResult");
		expect(
			toolResults && toolResults.role === "toolResult" ? toolResults.results.map((r) => r.toolName) : [],
		).toEqual(["slow", "fast"]);
		expect(result.stopReason).toBe("completed");
	});

	it("sliding window: every tool_start pre-issued; the 6th runs only when a slot frees, then immediately", async () => {
		const gates = Array.from({ length: 6 }, () => gate());
		const events: AgentEvent[] = [];
		const tools = gates.map((g, i) => holdTool(`t${i + 1}`, g));
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(tools.map((t) => t.name)), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		// #sliding-window phase 1 pre-issues tool_start for the WHOLE run — the
		// queued 6th call is visible from the start (wave semantics retired).
		await waitUntil(() => events.filter((e) => e.type === "tool_start").length === 6);
		await new Promise((r) => setTimeout(r, 20));
		expect(events.filter((e) => e.type === "tool_running")).toHaveLength(5); // cap 5
		expect(events.some((e) => e.type === "tool_running" && e.toolCallId === "c6")).toBe(false);
		// Window semantics: freeing ONE slot immediately admits the queued head
		// in call order (the 6th), with tool_running fired before its execution.
		gates[0]?.resolve();
		await waitUntil(() => events.some((e) => e.type === "tool_running" && e.toolCallId === "c6"));
		await new Promise((r) => setTimeout(r, 30));
		expect(events.filter((e) => e.type === "tool_running")).toHaveLength(6);
		for (const g of gates.slice(1)) g.resolve();
		await pending;
		const order = events
			.filter((e) => e.type === "tool_end")
			.map((e) => (e as { result: { toolName: string } }).result.toolName);
		expect(order).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
	});

	it("gates evaluate serially in call order before any execution", async () => {
		const trace: string[] = [];
		const ga = gate();
		const gb = gate();
		const tools = [
			holdTool("a", ga, () => trace.push("a:run")),
			holdTool("b", gb, () => trace.push("b:run")),
		];
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(["a", "b"]), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			onToolCall: async (call) => {
				trace.push(`${call.name}:gate-in`);
				await new Promise((r) => setTimeout(r, 10)); // gates that take time
				trace.push(`${call.name}:gate-out`);
			},
		});
		await waitUntil(() => trace.includes("b:run"));
		expect(trace.slice(0, 4)).toEqual(["a:gate-in", "a:gate-out", "b:gate-in", "b:gate-out"]);
		// Both gates fully evaluated before either tool ran.
		expect(trace.indexOf("a:run")).toBeGreaterThan(trace.indexOf("b:gate-out"));
		ga.resolve();
		gb.resolve();
		await pending;
		expect(trace.slice(4)).toEqual(["a:run", "b:run"]);
	});

	it("a blocked middle call: others run, blocked result stays in call order", async () => {
		const g1 = gate();
		const g3 = gate();
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(["a", "b", "c"]), finalText]),
			model: "m",
			system: "",
			tools: [holdTool("a", g1), holdTool("b", gate()), holdTool("c", g3)],
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
			onToolCall: (call) => (call.name === "b" ? { block: true, reason: "not allowed" } : undefined),
		});
		await waitUntil(() => events.filter((e) => e.type === "tool_start").length === 3);
		g1.resolve();
		g3.resolve();
		await pending;
		const toolResults = history.find((m) => m.role === "toolResult");
		const results = toolResults && toolResults.role === "toolResult" ? toolResults.results : [];
		expect(results.map((r) => r.toolName)).toEqual(["a", "b", "c"]);
		expect(results[1]?.isError).toBe(true);
		expect(results[1]?.content).toContain("blocked by an extension: not allowed");
		expect(results[0]?.isError).toBe(false);
	});

	it("#confirm-prompt (Phase 3 D9): the CHUNK path names the blocking extension", async () => {
		// The concurrent (executeChunk) block string is a different literal from
		// the serial executeToolCall one; only this test drives it through a
		// registry-backed gate (an extension tool is concurrencySafe).
		const registry = new ExtensionRegistry({ report: () => {} });
		registry.beginExtension("guardian", "project");
		registry.subscribe("tool_call", () => ({ block: true, reason: "rm -rf refused" }));
		registry.commitExtension();
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider: scriptedProvider([calls(["safe"]), finalText]),
			model: "m",
			system: "",
			tools: [holdTool("safe", gate())],
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
			onToolCall: (call) => registry.emitToolCall({ type: "tool_call", ...call }),
		});
		const toolResults = history.find((m) => m.role === "toolResult");
		const results = toolResults && toolResults.role === "toolResult" ? toolResults.results : [];
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.content).toBe('Tool "safe" blocked by extension guardian: rm -rf refused');
	});

	it("#confirm-prompt (Phase 3 D9): an empty decision source falls back to `an extension`", async () => {
		// blockSource's empty guard: a raw gate that sets source: "" (or a host
		// bug) must not render `blocked by extension :` — the anonymous wording
		// is the fallback. Drives the CHUNK path (concurrencySafe tool).
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider: scriptedProvider([calls(["safe"]), finalText]),
			model: "m",
			system: "",
			tools: [holdTool("safe", gate())],
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
			onToolCall: () => ({ block: true, reason: "x", source: "" }),
		});
		const toolResults = history.find((m) => m.role === "toolResult");
		const results = toolResults && toolResults.role === "toolResult" ? toolResults.results : [];
		expect(results[0]?.content).toBe('Tool "safe" blocked by an extension: x');
	});

	it("abort mid-chunk: every started call still emits its computed tool_end", async () => {
		const controller = new AbortController();
		const gates = [gate(), gate(), gate()];
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		const tools = gates.map((g, i) => holdTool(`t${i + 1}`, g));
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(tools.map((t) => t.name)), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
			signal: controller.signal,
		});
		await waitUntil(() => events.filter((e) => e.type === "tool_start").length === 3);
		controller.abort(); // tools observe the signal and settle with real outputs
		const result = await pending;
		expect(result.stopReason).toBe("aborted");
		const ends = events.filter((e) => e.type === "tool_end");
		expect(ends).toHaveLength(3); // the flush: nothing computed was dropped
		const toolResults = history.find((m) => m.role === "toolResult");
		const results = toolResults && toolResults.role === "toolResult" ? toolResults.results : [];
		expect(results.map((r) => r.content)).toEqual(["t1 done", "t2 done", "t3 done"]);
	});

	it("mixed batches: a serial tool never overlaps the safe call before it", async () => {
		const events: AgentEvent[] = [];
		const g = gate();
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(["safe", "serial"]), finalText]),
			model: "m",
			system: "",
			tools: [
				holdTool("safe", g),
				{
					name: "serial",
					description: "serial by default",
					parameters: Type.Object({ message: Type.String() }),
					async execute() {
						return { output: "serial" };
					},
				},
			],
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		// safe (run of 1) must complete before serial starts — release promptly.
		await waitUntil(() => events.some((e) => e.type === "tool_start" && e.name === "safe"));
		g.resolve();
		await waitUntil(() => events.some((e) => e.type === "tool_start" && e.name === "serial"));
		const safeEnd = events.findIndex((e) => e.type === "tool_end");
		const serialStart = events.findIndex((e) => e.type === "tool_start" && e.name === "serial");
		expect(safeEnd).toBeGreaterThanOrEqual(0);
		expect(serialStart).toBeGreaterThan(safeEnd);
		await pending;
	});

	it("out-of-order natural completion: tool_end still call-ordered", async () => {
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider: scriptedProvider([calls(["slow80", "quick"]), finalText]),
			model: "m",
			system: "",
			tools: [delayTool("slow80", 80), delayTool("quick", 1)],
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		const ends = events.filter((e) => e.type === "tool_end");
		expect(ends.map((e) => (e as { result: { toolName: string } }).result.toolName)).toEqual([
			"slow80",
			"quick",
		]);
	});
});

describe("#tool-settle: per-call timing", () => {
	/** Gated concurrency-safe tool; `held.count` lets the test wait for both
	 *  executions to be in flight before releasing them one at a time. */
	function heldTool(state: { count: number }, gates: Record<string, Gate>): Tool {
		return {
			name: "held",
			description: "gated",
			parameters: Type.Object({ message: Type.String() }),
			concurrencySafe: true,
			async execute(args) {
				state.count++;
				await gates[String(args.message)]?.promise;
				return { output: `${String(args.message)} done` };
			},
		};
	}

	const twoCalls = assistant(
		["a", "b"].map((id) => ({
			type: "toolCall" as const,
			id,
			name: "held",
			arguments: { message: id },
		})),
		"tool_use",
	);

	it("measures each concurrent call at its own settle, not the chunk's wall time", async () => {
		const a = gate();
		const b = gate();
		const state = { count: 0 };
		// a starts at 1000, b starts at 1000, a settles at 3000, b at 9000 — a
		// chunk-wide window would report 8000 for both.
		const ticks = [1000, 1000, 3000, 9000];
		let tick = 0;
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		const run = runAgentLoop({
			provider: scriptedProvider([twoCalls, finalText]),
			model: "m",
			system: "",
			tools: [heldTool(state, { a, b })],
			history,
			clock: () => ticks[tick++] ?? 0,
			onEvent: (event) => events.push(event),
		});
		await waitUntil(() => state.count === 2);
		a.resolve();
		await waitUntil(() => events.some((e) => e.type === "tool_settled" && e.result.toolCallId === "a"));
		b.resolve();
		await run;

		const settled = events.flatMap((e) => (e.type === "tool_settled" ? [e.result] : []));
		expect(settled.map((r) => [r.toolCallId, r.durationMs])).toEqual([
			["a", 2000],
			["b", 8000],
		]);
		// The authoritative tool_end still fires in call order, after the chunk.
		const ends = events.flatMap((e) => (e.type === "tool_end" ? [e.result] : []));
		expect(ends.map((r) => [r.toolCallId, r.durationMs])).toEqual([
			["a", 2000],
			["b", 8000],
		]);
		// ...and the measurement never enters history.
		const persisted = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
		expect(persisted.map((r) => r.toolCallId)).toEqual(["a", "b"]);
		expect(persisted.some((r) => "durationMs" in r)).toBe(false);
	});

	it("a serial call emits no settle event and carries no measurement", async () => {
		const serial: Tool = {
			name: "held",
			description: "serial",
			parameters: Type.Object({ message: Type.String() }),
			async execute(args) {
				return { output: `${String(args.message)} done` };
			},
		};
		const events: AgentEvent[] = [];
		await runAgentLoop({
			provider: scriptedProvider([twoCalls, finalText]),
			model: "m",
			system: "",
			tools: [serial],
			history: [],
			clock: () => 1,
			onEvent: (event) => events.push(event),
		});
		expect(events.some((e) => e.type === "tool_settled")).toBe(false);
		const ends = events.flatMap((e) => (e.type === "tool_end" ? [e.result] : []));
		expect(ends.map((r) => r.toolCallId)).toEqual(["a", "b"]);
		expect(ends.every((r) => r.durationMs === undefined)).toBe(true);
	});
});

describe("#tool-settle: calls that never ran", () => {
	it("a schema-refused call in a chunk emits no settle event but still gets its tool_end", async () => {
		const tool: Tool = {
			name: "held",
			description: "requires a message",
			parameters: Type.Object({ message: Type.String() }),
			concurrencySafe: true,
			async execute(args) {
				return { output: `${String(args.message)} done` };
			},
		};
		const mixed = assistant(
			[
				{ type: "toolCall" as const, id: "bad", name: "held", arguments: {} },
				{ type: "toolCall" as const, id: "good", name: "held", arguments: { message: "ok" } },
			],
			"tool_use",
		);
		const events: AgentEvent[] = [];
		await runAgentLoop({
			provider: scriptedProvider([mixed, finalText]),
			model: "m",
			system: "",
			tools: [tool],
			history: [],
			clock: () => 7000,
			onEvent: (event) => events.push(event),
		});
		expect(events.flatMap((e) => (e.type === "tool_settled" ? [e.result.toolCallId] : []))).toEqual(["good"]);
		const ends = events.flatMap((e) => (e.type === "tool_end" ? [e.result] : []));
		expect(ends.map((r) => r.toolCallId)).toEqual(["bad", "good"]);
		expect(ends[0]?.durationMs).toBeUndefined();
		expect(ends[0]?.isError).toBe(true);
	});
});

describe("#sliding-window", () => {
	it("convoy relief: [60, 10x6] finishes near the straggler, not wave-delayed (test 1)", async () => {
		// Injected fake clock: the loop's clock() is only consulted around
		// plan.run, so durationMs reflects each call's own runtime. Total wall
		// time is asserted via the 6th call's tool_running arriving BEFORE the
		// 1st call's tool_end — impossible under waves (wave 2 waits for the
		// straggler), required under the window (a slot frees at t=10).
		const gates = Array.from({ length: 7 }, () => gate());
		const events: AgentEvent[] = [];
		const tools = gates.map((g, i) => holdTool(`t${i + 1}`, g));
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(tools.map((t) => t.name)), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		await waitUntil(() => events.filter((e) => e.type === "tool_start").length === 7);
		await waitUntil(() => events.filter((e) => e.type === "tool_running").length === 5);
		// t2..t5 finish (slots free); the 6th and 7th claims must start while
		// t1 (the straggler) is still running.
		for (const g of gates.slice(1, 5)) g.resolve();
		await waitUntil(() => events.filter((e) => e.type === "tool_running").length === 7);
		const stragglerEnd = events.findIndex((e) => e.type === "tool_end" && e.result.toolName === "t1");
		const sixthRun = events.findIndex((e) => e.type === "tool_running" && e.toolCallId === "c6");
		expect(stragglerEnd).toBe(-1); // t1 not finished yet
		expect(sixthRun).toBeGreaterThan(-1);
		gates[0]?.resolve();
		for (const g of gates.slice(5)) g.resolve();
		await pending;
		const order = events
			.filter((e) => e.type === "tool_end")
			.map((e) => (e as { result: { toolName: string } }).result.toolName);
		expect(order).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
	});

	it("prefix flush: completion [b,a,c] emits tool_end [a,b,c]; b's end waits for a (test 3)", async () => {
		const ga = gate();
		const gb = gate();
		const gc = gate();
		const events: AgentEvent[] = [];
		const tools = [holdTool("a", ga), holdTool("b", gb), holdTool("c", gc)];
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(["a", "b", "c"]), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		await waitUntil(() => events.filter((e) => e.type === "tool_running").length === 3);
		gb.resolve(); // b settles first: settle event yes, tool_end NO (cursor blocked at a)
		await new Promise((r) => setTimeout(r, 30));
		expect(events.some((e) => e.type === "tool_settled" && e.result.toolName === "b")).toBe(true);
		expect(events.some((e) => e.type === "tool_end" && e.result.toolName === "b")).toBe(false);
		ga.resolve(); // a settles: prefix [a,b] flushes in call order
		await waitUntil(() => events.some((e) => e.type === "tool_end" && e.result.toolName === "b"));
		const endsAfterA = events
			.filter((e) => e.type === "tool_end")
			.map((e) => (e as { result: { toolName: string } }).result.toolName);
		expect(endsAfterA).toEqual(["a", "b"]);
		gc.resolve();
		await pending;
		const order = events
			.filter((e) => e.type === "tool_end")
			.map((e) => (e as { result: { toolName: string } }).result.toolName);
		expect(order).toEqual(["a", "b", "c"]);
	});

	it("MINOR-2 pin: tool_running fires BEFORE the claimed call's execution starts (test 4b)", async () => {
		// Stamp-ordering is load-bearing (design §3.1): the display rewrites the
		// row's startedAtMs from tool_running, and child source rows inherit it —
		// a tool_running emitted after plan.run would stamp queue-wait into every
		// downstream timer. Pin the loop's emission order against the execution
		// start itself (holdTool's onRun), not just against tool_end.
		const trace: string[] = [];
		const gates = Array.from({ length: 6 }, () => gate());
		const events: AgentEvent[] = [];
		const tools = gates.map((g, i) => holdTool(`t${i + 1}`, g, () => trace.push(`run:t${i + 1}`)));
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(tools.map((t) => t.name)), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			onEvent: (e) => {
				events.push(e);
				if (e.type === "tool_running") trace.push(`running:${e.toolCallId}`);
			},
		});
		await waitUntil(() => trace.filter((t) => t.startsWith("run:")).length === 5);
		// The queued 6th: admit it and assert the SAME ordering on the
		// post-queue admission (the case where a late stamp would smuggle in
		// the queue wait — a wave-style or misplaced-emit implementation stamps
		// at claim time BEFORE the previous settle, not at execution start).
		gates[0]?.resolve();
		await waitUntil(() => trace.includes("run:t6"));
		const firstSixthRun = trace.indexOf("run:t6");
		const sixthRunning = trace.indexOf("running:c6");
		expect(sixthRunning).toBeGreaterThanOrEqual(0);
		expect(sixthRunning).toBeLessThan(firstSixthRun); // running BEFORE its execution
		for (const g of gates.slice(1)) g.resolve();
		await pending;
		// Every claim observed the same order.
		for (let i = 1; i <= 6; i++) {
			const runAt = trace.indexOf(`run:t${i}`);
			const runningAt = trace.indexOf(`running:c${i}`);
			expect(runningAt).toBeGreaterThanOrEqual(0);
			expect(runningAt).toBeLessThan(runAt);
		}
	});

	it("event order: all tool_starts precede any tool_running; tool_running precedes its tool_end (test 4)", async () => {
		const events: AgentEvent[] = [];
		const tools = Array.from({ length: 7 }, (_, i) => delayTool(`d${i + 1}`, 5 + i));
		await runAgentLoop({
			provider: scriptedProvider([calls(tools.map((t) => t.name)), finalText]),
			model: "m",
			system: "",
			tools,
			history: [],
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		const firstRunning = events.findIndex((e) => e.type === "tool_running");
		const lastStart = events.map((e) => e.type).lastIndexOf("tool_start");
		expect(firstRunning).toBeGreaterThan(lastStart);
		for (const id of ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]) {
			const runIdx = events.findIndex((e) => e.type === "tool_running" && e.toolCallId === id);
			const endIdx = events.findIndex((e) => e.type === "tool_end" && e.result.toolCallId === id);
			expect(runIdx).toBeGreaterThan(-1);
			expect(endIdx).toBeGreaterThan(runIdx);
		}
	});

	it("queued time excluded from durationMs (test 6)", async () => {
		// 6 calls; the 6th queues behind 5 gated siblings. Injected clock only
		// ticks while plan.run is awaited (before/after), so the 6th's
		// durationMs measures its own 5-tick run — not the queue wait.
		const gates = Array.from({ length: 5 }, () => gate());
		const events: AgentEvent[] = [];
		const held = gates.map((g, i) => holdTool(`h${i + 1}`, g));
		const delayed = delayTool("d6", 0);
		const tools = [...held, delayed];
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(tools.map((t) => t.name)), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		await waitUntil(() => events.filter((e) => e.type === "tool_running").length === 5);
		await new Promise((r) => setTimeout(r, 50)); // the 6th queues through this window
		for (const g of gates) g.resolve();
		await pending;
		const settled = events.find((e) => e.type === "tool_settled" && e.result.toolCallId === "c6");
		expect(settled).toBeDefined();
		expect((settled as { result: { durationMs?: number } }).result.durationMs).toBeLessThan(50); // ~0: queue wait excluded
	});

	it("abort mid-window: claimed calls settle+flush; queued calls get synthesized results only (test 5)", async () => {
		const gates = Array.from({ length: 7 }, () => gate());
		const events: AgentEvent[] = [];
		const tools = gates.map((g, i) => holdTool(`t${i + 1}`, g));
		const controller = new AbortController();
		const history: AgentMessage[] = [];
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(tools.map((t) => t.name)), finalText]),
			model: "m",
			system: "",
			tools,
			history,
			userMessage: "go",
			signal: controller.signal,
			onEvent: (e) => events.push(e),
		});
		await waitUntil(() => events.filter((e) => e.type === "tool_running").length === 5);
		controller.abort(); // holdTools honor the signal and settle
		await pending;
		// All 7 tool_starts pre-issued; 5 tool_runnings; the queued 6th/7th
		// never ran and emit no tool_settled. tool_end events: the claimed five
		// only — synthesized results enter history but never fire events (the
		// existing synthesis contract).
		expect(events.filter((e) => e.type === "tool_start")).toHaveLength(7);
		expect(events.filter((e) => e.type === "tool_running")).toHaveLength(5);
		expect(events.filter((e) => e.type === "tool_settled")).toHaveLength(5);
		const ends = events.flatMap((e) => (e.type === "tool_end" ? [e.result] : []));
		expect(ends.map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
		// History carries ALL SEVEN results — claimed five computed, queued two
		// synthesized — keeping the session resumable (tool_use→tool_result pairs).
		const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
		expect(historyResults.map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
		const interrupted = historyResults.filter((r) => r.content === "(interrupted before this tool ran)");
		expect(interrupted.map((r) => r.toolCallId)).toEqual(["c6", "c7"]);
		// Claimed-but-aborted calls keep their computed results (holdTool returns output).
		for (const id of ["c1", "c2", "c3", "c4", "c5"])
			expect(historyResults.find((r) => r.toolCallId === id)?.isError).toBe(false);
	});
});

describe("#abort-grace: bounded wait for signal-ignoring tools", () => {
	/** A tool that never settles and never observes its signal — the culprit. */
	function hangTool(name: string): Tool {
		return {
			name,
			description: "hangs forever, ignores the signal",
			parameters: Type.Object({ message: Type.String() }),
			concurrencySafe: true,
			async execute() {
				await new Promise<void>(() => {});
				return { output: "never" };
			},
		};
	}

	it("abandons a hung safe call at the deadline; the run finishes with a complete history (test 1)", async () => {
		vi.useFakeTimers();
		try {
			const tool = hangTool("stuck");
			const events: AgentEvent[] = [];
			const controller = new AbortController();
			const history: AgentMessage[] = [];
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(["stuck"]), finalText]),
				model: "m",
				system: "",
				tools: [tool],
				history,
				userMessage: "go",
				signal: controller.signal,
				onEvent: (e) => events.push(e),
			});
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			// Before the deadline: nothing settles — the run is stuck (the red
			// baseline this batch exists to fix: without grace, pending never
			// resolves at all).
			await vi.advanceTimersByTimeAsync(9_000);
			const settledSoFar = events.filter((e) => e.type === "tool_settled");
			expect(settledSoFar).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(1_500);
			const result = await pending;
			expect(result.stopReason).toBe("aborted");
			const settled = events.flatMap((e) => (e.type === "tool_settled" ? [e.result] : []));
			expect(settled).toHaveLength(1);
			expect(settled[0]?.isError).toBe(true);
			expect(settled[0]?.content).toContain("did not respond to the interrupt");
			// History complete: the tool_use → tool_result pair closes.
			const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
			expect(historyResults.map((r) => r.toolCallId)).toEqual(["c1"]);
			expect(historyResults[0]?.isError).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("late real settle does not overwrite the synthesized result; the loser is observed (test 2)", async () => {
		vi.useFakeTimers();
		try {
			const lateErrors: unknown[] = [];
			const lateLog: string[] = [];
			const unhandled = (err: unknown): void => {
				lateErrors.push(err);
			};
			const writeStream = process.stderr.write.bind(process.stderr);
			vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
				if (typeof chunk === "string" && chunk.includes("settled late")) lateLog.push(chunk);
				return writeStream(chunk as string);
			});
			process.on("unhandledRejection", unhandled);
			onTestFinished(() => {
				process.off("unhandledRejection", unhandled);
				vi.restoreAllMocks();
			});
			let releaseTool: (() => void) | undefined;
			const tool: Tool = {
				name: "late",
				description: "settles after the grace deadline",
				parameters: Type.Object({ message: Type.String() }),
				concurrencySafe: true,
				async execute() {
					await new Promise<void>((resolve) => {
						releaseTool = resolve;
					});
					return { output: "late real result" };
				},
			};
			const events: AgentEvent[] = [];
			const controller = new AbortController();
			const history: AgentMessage[] = [];
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(["late"]), finalText]),
				model: "m",
				system: "",
				tools: [tool],
				history,
				userMessage: "go",
				signal: controller.signal,
				onEvent: (e) => events.push(e),
			});
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			await vi.advanceTimersByTimeAsync(10_500);
			await pending;
			// The real execution settles AFTER the deadline — dropped, logged.
			releaseTool?.();
			await vi.advanceTimersByTimeAsync(50);
			const ends = events.flatMap((e) => (e.type === "tool_end" ? [e.result] : []));
			expect(ends).toHaveLength(1);
			expect(ends[0]?.content).toContain("did not respond");
			const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
			expect(historyResults[0]?.content).toContain("did not respond");
			expect(lateErrors).toEqual([]);
			// The loser's late real settle is logged and dropped (design §6.2).
			expect(lateLog.some((l) => l.includes("settled late, result dropped"))).toBe(true);
			process.off("unhandledRejection", unhandled);
		} finally {
			vi.useRealTimers();
		}
	});

	it("serial path: a hung serial tool is abandoned the same way (test 3)", async () => {
		vi.useFakeTimers();
		try {
			const tool: Tool = {
				name: "serialstuck",
				description: "serial tool that hangs",
				parameters: Type.Object({ message: Type.String() }),
				async execute() {
					await new Promise<void>(() => {});
					return { output: "never" };
				},
			};
			const controller = new AbortController();
			const history: AgentMessage[] = [];
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(["serialstuck"]), finalText]),
				model: "m",
				system: "",
				tools: [tool],
				history,
				userMessage: "go",
				signal: controller.signal,
			});
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			await vi.advanceTimersByTimeAsync(10_500);
			const result = await pending;
			expect(result.stopReason).toBe("aborted");
			const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
			expect(historyResults[0]?.isError).toBe(true);
			expect(historyResults[0]?.content).toContain("did not respond to the interrupt");
		} finally {
			vi.useRealTimers();
		}
	});

	it("normal run: a legitimate slow tool is NEVER interrupted — no timer arms before an abort (test 4)", async () => {
		vi.useFakeTimers();
		try {
			// A tool slower than the grace window, with NO abort: it must run
			// to completion. A mis-armed grace timer (the mutation this pins —
			// arming on registration instead of on abort) synthesizes an
			// isError result at the 10s checkpoint and the history goes wrong.
			const events: AgentEvent[] = [];
			const history: AgentMessage[] = [];
			let releaseSlow: (() => void) | undefined;
			const tool: Tool = {
				name: "slow",
				description: "legitimate 30s work, no abort ever fires",
				parameters: Type.Object({ message: Type.String() }),
				concurrencySafe: true,
				async execute() {
					await new Promise<void>((resolve) => {
						releaseSlow = resolve;
					});
					return { output: "slow but fine" };
				},
			};
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(["slow"]), finalText]),
				model: "m",
				system: "",
				tools: [tool],
				history,
				userMessage: "go",
				onEvent: (e) => events.push(e),
			});
			await vi.advanceTimersByTimeAsync(0);
			// Checkpoint past ABORT_GRACE_MS with no abort: nothing abandoned.
			await vi.advanceTimersByTimeAsync(15_000);
			expect(events.filter((e) => e.type === "tool_settled")).toHaveLength(0);
			releaseSlow?.();
			const result = await pending;
			expect(result.stopReason).toBe("completed");
			const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
			expect(historyResults[0]?.isError).toBe(false);
			expect(historyResults[0]?.content).toBe("slow but fine");
		} finally {
			vi.useRealTimers();
		}
	});

	it("abort landing inside a serial gate await still bounds a post-gate hung tool (MAJOR-1 regression)", async () => {
		vi.useFakeTimers();
		try {
			// The window: the previous serial call settled (registry empty),
			// this call's gate is awaiting, the abort fires HERE — the
			// {once:true} listener is consumed while entries is empty. The
			// post-gate hung tool must still be abandoned at the deadline
			// (signal.aborted latch at registration arms it).
			const hangGate = gate();
			const events: AgentEvent[] = [];
			const controller = new AbortController();
			const history: AgentMessage[] = [];
			const quick: Tool = {
				name: "quick",
				description: "settles instantly",
				parameters: Type.Object({ message: Type.String() }),
				async execute() {
					return { output: "q" };
				},
			};
			const stuck: Tool = {
				name: "postgate",
				description: "hangs after a gate that spans the abort",
				parameters: Type.Object({ message: Type.String() }),
				async execute() {
					await new Promise<void>(() => {});
					return { output: "never" };
				},
			};
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(["quick", "postgate"]), finalText]),
				model: "m",
				system: "",
				tools: [quick, stuck],
				history,
				userMessage: "go",
				signal: controller.signal,
				onEvent: (e) => events.push(e),
				onToolCall: (call) => {
					if (call.name === "postgate") return hangGate.promise.then(() => undefined);
					return undefined;
				},
			});
			await vi.advanceTimersByTimeAsync(0); // quick settles; postgate awaits its gate
			controller.abort(); // fires inside the gate await (registry empty)
			hangGate.resolve();
			await vi.advanceTimersByTimeAsync(10_500); // grace deadline passes
			const result = await pending;
			expect(result.stopReason).toBe("aborted");
			const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
			expect(historyResults.map((r) => r.toolName)).toEqual(["quick", "postgate"]);
			expect(historyResults[1]?.isError).toBe(true);
			expect(historyResults[1]?.content).toContain("did not respond to the interrupt");
		} finally {
			vi.useRealTimers();
		}
	});

	it("gate hang is out of grace scope: a gate await that never resolves suspends the run even after abort (§2.5 pin)", async () => {
		vi.useFakeTimers();
		try {
			// A tool_call handler that NEVER resolves: the gate await — not the
			// execution — is what hangs. Grace deliberately does not cover this
			// (design §2.5); the exit is the user's second Ctrl+C. This PINS
			// current behavior (run stays suspended, tool never executes) so a
			// future scope change is a conscious act, not a silent drift.
			const registry = new ExtensionRegistry({ report: () => {} });
			registry.beginExtension("guardian", "project");
			// subscribe() takes handler: unknown — a never-settling promise is
			// the gate hang under test, no cast needed.
			registry.subscribe("tool_call", () => new Promise(() => {}));
			registry.commitExtension();
			const ran: string[] = [];
			const tool: Tool = {
				name: "gated",
				description: "its gate never resolves",
				parameters: Type.Object({}),
				concurrencySafe: true,
				async execute() {
					ran.push("gated");
					return { output: "unreachable" };
				},
			};
			const controller = new AbortController();
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(["gated"]), finalText]),
				model: "m",
				system: "",
				tools: [tool],
				history: [],
				userMessage: "go",
				signal: controller.signal,
				onToolCall: (call) => registry.emitToolCall({ type: "tool_call", ...call }),
			});
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			// Far past any grace window: the gate await still holds — grace
			// never fires for it, the run never settles.
			await vi.advanceTimersByTimeAsync(60_000);
			const settled = await Promise.race([pending.then(() => true), Promise.resolve(false)]);
			expect(settled).toBe(false); // still suspended — the pinned boundary
			expect(ran).toEqual([]); // the tool never executed
		} finally {
			vi.useRealTimers();
		}
	});

	it("mixed batch: responsive siblings settle normally, only the hung one is abandoned (test 5)", async () => {
		vi.useFakeTimers();
		try {
			const events: AgentEvent[] = [];
			const controller = new AbortController();
			const history: AgentMessage[] = [];
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(["ok1", "stuck", "ok2"]), finalText]),
				model: "m",
				system: "",
				tools: [delayTool("ok1", 5), hangTool("stuck"), delayTool("ok2", 5)],
				history,
				userMessage: "go",
				signal: controller.signal,
				onEvent: (e) => events.push(e),
			});
			await vi.advanceTimersByTimeAsync(20); // both ok tools settle naturally
			controller.abort();
			await vi.advanceTimersByTimeAsync(10_500);
			const result = await pending;
			expect(result.stopReason).toBe("aborted");
			const settled = events.flatMap((e) => (e.type === "tool_settled" ? [e.result] : []));
			expect(
				settled
					.filter((r) => r.isError !== true)
					.map((r) => r.toolName)
					.sort(),
			).toEqual(["ok1", "ok2"]);
			const abandoned = settled.filter((r) => r.isError === true);
			expect(abandoned.map((r) => r.toolName)).toEqual(["stuck"]);
			const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
			expect(historyResults.map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("#readonly-parallel: real read-only tools in the window", () => {
	it("roster: read/grep/find/ls carry concurrencySafe (design §4.1)", () => {
		const dir = mkTempDir("ink-roster-");
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const probe: [string, Tool][] = [
			["read", createReadTool({ cwd: dir })],
			["grep", createGrepTool({ cwd: dir })],
			["find", createFindTool({ cwd: dir })],
			["ls", createLsTool({ cwd: dir })],
		];
		for (const [name, tool] of probe) expect(tool.concurrencySafe, name).toBe(true);
	});

	it("real tools overlap: a FIFO-gated read and a plain read run concurrently (design §4.2/§4.8)", async () => {
		const dir = mkTempDir("ink-parallel-");
		// fifo-gated read: readFile blocks on a FIFO until the test writes —
		// deterministic concurrency observation, no wall-clock sampling.
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const fifo = path.join(dir, "gate.fifo");
		execFileSync("mkfifo", [fifo]);
		const plain = path.join(dir, "plain.txt");
		writeFileSync(plain, "plain content\n");
		const read = createReadTool({ cwd: dir });
		const events: AgentEvent[] = [];
		const history: AgentMessage[] = [];
		const readCalls = assistant(
			[
				{ type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "gate.fifo" } },
				{ type: "toolCall" as const, id: "c2", name: "read", arguments: { path: "plain.txt" } },
			],
			"tool_use",
		);
		const pending = runAgentLoop({
			provider: scriptedProvider([readCalls, finalText]),
			model: "m",
			system: "",
			tools: [read],
			history,
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		// Wait until both calls are IN FLIGHT: tool_running × 2, no tool_end.
		// The first read is blocked on the FIFO (its result cannot exist),
		// so the only way the second can be running is true concurrency.
		await waitUntil(() => events.filter((e) => e.type === "tool_running").length === 2);
		expect(events.filter((e) => e.type === "tool_end")).toHaveLength(0);
		// unblock: write the FIFO content and close.
		writeFileSync(fifo, "fifo content\n");
		const result = await pending;
		expect(result.stopReason).toBe("completed");
		const ends = events.filter((e) => e.type === "tool_end");
		expect(ends).toHaveLength(2);
		// Call order preserved (c1 then c2) AND both results are the real
		// tool outputs (not synthesized) — content order is the witness.
		const results = history.find((m) => m.role === "toolResult");
		expect(results && results.role === "toolResult" ? results.results.map((r) => r.content) : []).toEqual([
			"fifo content",
			"plain content",
		]);
	});

	it("abort mid-read-batch: claimed reads settle with REAL results (pool-queued stragglers may ride the grace window — the designed bounded exit); queued ones synthesize (design §4.3)", async () => {
		const dir = mkTempDir("ink-abort-");
		// 5 gated reads (FIFOs held open by spawned holders) + 2 plain files:
		// the five claimed slots stay pending, c6/c7 remain queued.
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const fifos: string[] = [];
		for (let i = 1; i <= 5; i++) {
			const fifo = path.join(dir, `gate${i}.fifo`);
			execFileSync("mkfifo", [fifo]);
			fifos.push(fifo);
		}
		for (let i = 6; i <= 7; i++) writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}\n`);
		// `exec sleep` replaces the shell so killing the holder really closes
		// the write end (a child sleep would inherit and keep it open).
		// Holders live OUTSIDE the libuv threadpool on purpose: 5 reader opens
		// + 5 in-process writer opens would exceed the 4-thread pool.
		const holders = fifos.map((f) =>
			spawn("sh", ["-c", `exec 9>"${f}"; exec sleep 300`], { stdio: "ignore" }),
		);
		// Belt-and-suspenders cleanup: an assertion failure before the kill
		// below must not leak sleepers for 300s (review m-2).
		onTestFinished(() => {
			for (const holder of holders) holder.kill("SIGKILL");
		});
		const read = createReadTool({ cwd: dir });
		const events: AgentEvent[] = [];
		const controller = new AbortController();
		const history: AgentMessage[] = [];
		const readCalls = assistant(
			Array.from({ length: 7 }, (_, i) => ({
				type: "toolCall" as const,
				id: `c${i + 1}`,
				name: "read",
				arguments: { path: i < 5 ? `gate${i + 1}.fifo` : `f${i + 1}.txt` },
			})),
			"tool_use",
		);
		const pending = runAgentLoop({
			provider: scriptedProvider([readCalls, finalText]),
			model: "m",
			system: "",
			tools: [read],
			history,
			userMessage: "go",
			signal: controller.signal,
			onEvent: (e) => events.push(e),
		});
		// 5 admitted (c1-c5 blocked reading their FIFOs), 2 queued.
		await waitUntil(() => events.filter((e) => e.type === "tool_running").length === 5);
		controller.abort();
		// Close the gates so blocked pool reads see EOF. Observed semantics
		// (darwin, node 25, probed): abort does NOT interrupt an in-flight
		// threadpool read — it completes at EOF; a read whose pool op had not
		// STARTED rejects with AbortError; and with 5 FIFO reads on a 4-thread
		// pool the stragglers may not start before the 10s grace deadline —
		// from the loop's view they are signal-ignoring, and grace synthesis
		// is the DESIGNED bounded outcome for exactly that. The contract this
		// pins: every claimed call gets a result (real OR grace-synthesized,
		// never "(interrupted…)"), the never-started queued calls get exactly
		// the interrupted marker, and the run resolves.
		for (const holder of holders) holder.kill("SIGKILL");
		await pending;
		const historyResults = history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
		expect(historyResults).toHaveLength(7); // resumable: all pairs closed
		const interrupted = historyResults.filter((r) => r.content === "(interrupted before this tool ran)");
		expect(interrupted.map((r) => r.toolCallId)).toEqual(["c6", "c7"]); // queued: never started
		for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
			const result = historyResults.find((r) => r.toolCallId === id);
			expect(result, id).toBeDefined(); // claimed ⇒ present
			expect(result?.content, id).not.toBe("(interrupted before this tool ran)"); // it ran
		}
	});
});

describe("#readonly-parallel: child-session parity (design §3 checkpoint)", () => {
	it("the child loop runs safe calls concurrently — the roster flag travels with the tool pool", async () => {
		const dir = mkTempDir("ink-child-");
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const fifo = path.join(dir, "gate.fifo");
		execFileSync("mkfifo", [fifo]);
		// Holder outside the libuv pool (see the abort test's note).
		const holder = spawn("sh", ["-c", `exec 9>"${fifo}"; exec sleep 60`], { stdio: "ignore" });
		onTestFinished(() => {
			holder.kill("SIGKILL");
		});
		try {
			const read = createReadTool({ cwd: dir });
			// A sibling safe tool that records WHEN it ran. k1 (index 0) is a
			// read with no data until the holder dies; under SERIAL execution
			// (call order) the probe would never run before k1 settles. The
			// probe executing before the gate closes IS the concurrency proof.
			let probeRanAt: number | undefined;
			const probe: Tool = {
				name: "probe",
				description: "records execution timing",
				parameters: Type.Object({ message: Type.String() }),
				concurrencySafe: true,
				async execute(args) {
					probeRanAt = Date.now();
					return { output: `probe:${String(args.message)}` };
				},
			};
			const childTurn = assistant(
				[
					{ type: "toolCall" as const, id: "k1", name: "read", arguments: { path: "gate.fifo" } },
					{ type: "toolCall" as const, id: "k2", name: "probe", arguments: { message: "go" } },
				],
				"tool_use",
			);
			const requests: LLMRequest[] = [];
			const provider = scriptedProvider([childTurn, finalText], requests);
			const pending = runSubagent({
				provider,
				model: "m",
				system: "CHILD",
				tools: [read, probe],
				prompt: "run them",
			});
			// k1 blocks (no data): turn 1 cannot finish while it is pending.
			// Give the child loop a moment to admit both calls, then mark the
			// gate state before closing it.
			await new Promise((r) => setTimeout(r, 300));
			const closedAt = Date.now();
			holder.kill("SIGKILL");
			const outcome = await pending;
			expect(outcome.status).toBe("completed");
			// PARITY: the probe executed while the gated read was still pending
			// (k1 could not have settled — its data did not exist until closedAt).
			expect(probeRanAt).toBeDefined();
			expect(probeRanAt! < closedAt).toBe(true);
			// And the real read produced its real (empty) EOF output.
			const second = requests[1]?.messages ?? [];
			const results = second.flatMap((m) => (m.role === "toolResult" ? (m.results ?? []) : []));
			expect(results.map((r) => r.content)).toEqual(["", "probe:go"]);
		} finally {
			holder.kill("SIGKILL");
		}
	});
});
