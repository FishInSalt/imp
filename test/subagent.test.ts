import { Type } from "typebox";
import { describe, expect, it } from "vitest";
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
		const messages = [
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
		const provider = {
			name: "dead",
			async *stream(): AsyncGenerator<never> {
				throw new Error("connection refused");
			},
		};
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
			"(child: 7 turns, 12.3k in / 1.4k out / 9.8k cache)",
		);
		expect(childUsageTrailer(1, { inputTokens: 10, outputTokens: 5 })).toBe(
			"(child: 1 turns, 10 in / 5 out)",
		);
		expect(childUsageTrailer(1, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 })).toBe(
			"(child: 1 turns, 10 in / 5 out)",
		);
	});
});
