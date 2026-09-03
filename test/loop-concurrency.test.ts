import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentEvent } from "../src/core/loop.js";
import { runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import { assistant, gate, type Gate, scriptedProvider, user } from "./helpers/fakes.js";
import { waitUntil } from "./helpers/fakes.js";

/** Signal-observing gated tool — the loop awaits execute() unconditionally, so
 *  concurrency/abort tests need tools that honor the signal (as bash does). */
function holdTool(name: string, g: Gate, onRun?: () => void): Tool {
	return {
		name,
		description: "holds until the gate opens or the signal aborts",
		parameters: Type.Object({ message: Type.String() }),
		concurrencySafe: true,
		async execute(args, signal) {
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

function serialTool(name: string, log: string[]): Tool {
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
		names.map((n, i) => ({ type: "toolCall" as const, id: `c${i + 1}`, name: n, arguments: { message: "go" } })),
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
		expect(toolResults && toolResults.role === "toolResult" ? toolResults.results.map((r) => r.toolName) : []).toEqual([
			"slow",
			"fast",
		]);
		expect(result.stopReason).toBe("completed");
	});

	it("chunk cap 5: the 6th call starts only after a slot frees", async () => {
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
		await waitUntil(() => events.filter((e) => e.type === "tool_start").length === 5);
		await new Promise((r) => setTimeout(r, 20));
		expect(events.filter((e) => e.type === "tool_start")).toHaveLength(5); // 6th queued
		// Wave semantics (design §6): chunks are fixed waves of 5, not a rolling
		// slot pool — freeing ONE call does not start the 6th.
		gates[0]?.resolve();
		await new Promise((r) => setTimeout(r, 30));
		expect(events.filter((e) => e.type === "tool_start")).toHaveLength(5);
		for (const g of gates.slice(1)) g.resolve();
		await waitUntil(() => events.filter((e) => e.type === "tool_start").length === 6);
		for (const g of gates.slice(1)) g.resolve();
		await pending;
		const order = events.filter((e) => e.type === "tool_end").map((e) => (e as { result: { toolName: string } }).result.toolName);
		expect(order).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
	});

	it("gates evaluate serially in call order before any execution", async () => {
		const trace: string[] = [];
		const ga = gate();
		const gb = gate();
		const tools = [holdTool("a", ga, () => trace.push("a:run")), holdTool("b", gb, () => trace.push("b:run"))];
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
						events.push("serial:start");
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
		expect(ends.map((e) => (e as { result: { toolName: string } }).result.toolName)).toEqual(["slow80", "quick"]);
	});
});
