import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";

function assistant(
	blocks: AssistantMessage["blocks"],
	stopReason: AssistantMessage["stopReason"] = "end_turn",
): AssistantMessage {
	return { role: "assistant", blocks, usage: { inputTokens: 10, outputTokens: 5 }, stopReason };
}

const echoTool: Tool = {
	name: "echo_tool",
	description: "echoes",
	parameters: Type.Object({ message: Type.String() }),
	async execute(args) {
		return { output: `echo: ${String(args.message)}` };
	},
};

describe("onToolCall gate (M4c, design §8.3)", () => {
	const scripted = (steps: AssistantMessage[]): { provider: LLMProvider; requests: LLMRequest[] } => {
		const requests: LLMRequest[] = [];
		let call = 0;
		return {
			requests,
			provider: {
				name: "mock",
				async *stream(request) {
					requests.push({ ...request, messages: [...request.messages] });
					const message = steps[Math.min(call, steps.length - 1)] as AssistantMessage;
					call++;
					yield { type: "message_end", message };
				},
			},
		};
	};

	const toolCallMsg = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
		assistant([{ type: "toolCall", id, name, arguments: args }], "tool_use");

	const toolResultsOf = (history: AgentMessage[]) => {
		for (let i = history.length - 1; i >= 0; i--) {
			const message = history[i];
			if (message?.role === "toolResult") return message.results;
		}
		throw new Error("no toolResult message in history");
	};

	it("case 6: the gate fires after validation and before execute — unknown tools and schema failures never reach it", async () => {
		const { provider } = scripted([
			toolCallMsg("u1", "nope_tool", { message: "x" }),
			assistant(
				[
					{ type: "toolCall", id: "b1", name: "echo_tool", arguments: { wrong: true } },
					{ type: "toolCall", id: "g1", name: "echo_tool", arguments: { message: "ok" } },
				],
				"tool_use",
			),
			assistant([{ type: "text", text: "done" }]),
		]);
		const order: string[] = [];
		let executed = 0;
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [
				{
					...echoTool,
					async execute(args) {
						executed++;
						return { output: `echo: ${String(args.message)}` };
					},
				},
			],
			history,
			userMessage: "go",
			onEvent: (event) => {
				if (event.type === "tool_start" || event.type === "tool_end") order.push(event.type);
			},
			onToolCall: (gate) => order.push(`gate:${gate.toolCallId}:${JSON.stringify(gate.args)}`),
		});
		// the gate sees exactly the one call that passed validation — schema-validated
		// args (the object execute() would receive), gated after its tool_start and
		// before its tool_end; the unknown tool and the bad-args call are already
		// error results by then and never reach extensions (design §6.1)
		expect(order).toEqual([
			"tool_start",
			"tool_end", // u1: unknown tool → error result
			"tool_start",
			"tool_end", // b1: schema failure → error result
			"tool_start",
			'gate:g1:{"message":"ok"}',
			"tool_end", // g1: gated, allowed, executed
		]);
		expect(executed).toBe(1);
	});

	it("case 6: void and {block:false} allow; {block:true} without a reason uses the designed fallback", async () => {
		const { provider } = scripted([
			assistant(
				[
					{ type: "toolCall", id: "v1", name: "echo_tool", arguments: { message: "void" } },
					{ type: "toolCall", id: "f1", name: "echo_tool", arguments: { message: "false" } },
					{ type: "toolCall", id: "s1", name: "echo_tool", arguments: { message: "silent" } },
				],
				"tool_use",
			),
			assistant([{ type: "text", text: "done" }]),
		]);
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [echoTool],
			history,
			userMessage: "go",
			onToolCall: (gate) => {
				if (gate.args.message === "void") return; // observe only
				if (gate.args.message === "false") return { block: false };
				return { block: true }; // no reason given
			},
		});
		const byId = new Map(toolResultsOf(history).map((r) => [r.toolCallId, r]));
		expect(byId.get("v1")?.content).toBe("echo: void");
		expect(byId.get("f1")?.content).toBe("echo: false");
		expect(byId.get("s1")?.content).toBe('Tool "echo_tool" blocked by an extension: no reason given');
		expect(byId.get("s1")?.isError).toBe(true);
	});

	it("case 7: a block becomes an isError result with the exact string; the model sees the refusal and the run continues", async () => {
		const { provider, requests } = scripted([
			toolCallMsg("t1", "echo_tool", { message: "x" }),
			assistant([{ type: "text", text: "adapted" }]),
		]);
		let executed = false;
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [
				{
					...echoTool,
					async execute() {
						executed = true;
						return { output: "ran" };
					},
				},
			],
			history,
			userMessage: "go",
			onToolCall: () => ({ block: true, reason: "too destructive — list the files and ask first" }),
		});
		expect(result).toEqual({
			stopReason: "completed",
			turns: 2,
			// addUsage materializes both cache counters at 0 — part of the payload
			usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
		});
		expect(executed).toBe(false);
		const refused = toolResultsOf(history)[0];
		expect(refused).toEqual({
			toolCallId: "t1",
			toolName: "echo_tool",
			content: 'Tool "echo_tool" blocked by an extension: too destructive — list the files and ask first',
			isError: true,
		});
		// the refusal was fed back to the model in the follow-up request (it adapted)
		const followUp = requests[1]?.messages.find((m) => m.role === "toolResult");
		expect(followUp?.results[0]?.content).toBe(
			'Tool "echo_tool" blocked by an extension: too destructive — list the files and ask first',
		);
	});

	it("case 6: first observer wins through the registry seam the runner wires — an earlier block short-circuits later handlers", async () => {
		const registry = new ExtensionRegistry();
		const seen: string[] = [];
		registry.beginExtension("gate", "cli");
		registry.subscribe("tool_call", () => ({ block: true, reason: "first says no" }));
		registry.subscribe("tool_call", () => {
			seen.push("second-ran");
		});
		registry.commitExtension();
		const { provider } = scripted([
			toolCallMsg("t1", "echo_tool", { message: "x" }),
			assistant([{ type: "text", text: "done" }]),
		]);
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [echoTool],
			history,
			userMessage: "go",
			onToolCall: (call) => registry.emitToolCall(call),
		});
		expect(seen).toEqual([]);
		expect(toolResultsOf(history)[0]?.content).toBe(
			'Tool "echo_tool" blocked by an extension: first says no',
		);
	});

	it("case 8 (E9): through the registry seam, a throwing tool_call handler fails safe — blocked with the handler-error reason", async () => {
		const registry = new ExtensionRegistry();
		registry.beginExtension("broken_gate", "cli");
		registry.subscribe("tool_call", () => {
			throw new Error("gate broke");
		});
		registry.commitExtension();
		const { provider } = scripted([
			toolCallMsg("t1", "echo_tool", { message: "x" }),
			assistant([{ type: "text", text: "done" }]),
		]);
		let executed = false;
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [
				{
					...echoTool,
					async execute() {
						executed = true;
						return { output: "ran" };
					},
				},
			],
			history,
			userMessage: "go",
			onToolCall: (call) => registry.emitToolCall(call),
		});
		expect(executed).toBe(false);
		expect(toolResultsOf(history)[0]?.content).toBe(
			'Tool "echo_tool" blocked by an extension: handler error — gate broke',
		);
		expect(toolResultsOf(history)[0]?.isError).toBe(true);
	});
});

describe("loop hooks (M2)", () => {
	it("injects steering messages before the next assistant turn", async () => {
		const requests: LLMRequest[] = [];
		let call = 0;
		const provider: LLMProvider = {
			name: "mock",
			async *stream(request) {
				requests.push({ ...request, messages: [...request.messages] });
				const scripts = [
					assistant(
						[{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: "first" } }],
						"tool_use",
					),
					// after steering injection the model sees the queue, then finishes
					assistant([{ type: "text", text: "acknowledged steering" }]),
				];
				const message = scripts[Math.min(call, scripts.length - 1)] as AssistantMessage;
				call++;
				yield { type: "message_end", message };
			},
		};

		// the queue fills up while the tool runs (like a user typing mid-run);
		// the first poll (at run start) returns empty, the second returns the message
		const steeringQueue: AgentMessage[] = [];
		let toolRan = false;
		const lateEchoTool: Tool = {
			...echoTool,
			async execute(args) {
				toolRan = true;
				steeringQueue.push({ role: "user", content: "wait — use a different approach" });
				return { output: `echo: ${String(args.message)}` };
			},
		};
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [lateEchoTool],
			history,
			userMessage: "do the thing",
			getSteeringMessages: () => steeringQueue.splice(0),
		});
		expect(toolRan).toBe(true);

		// turn 2 request must contain the steering user message right after the tool result
		const second = requests[1];
		expect(second).toBeDefined();
		const roles = second?.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user"]);
		// history (and thus the persisted session) contains the steering message too
		expect(history.some((m) => m.role === "user" && m.content === "wait — use a different approach")).toBe(
			true,
		);
	});

	it("onMessage fires for every message entering history", async () => {
		let call = 0;
		const provider: LLMProvider = {
			name: "mock",
			async *stream() {
				const scripts = [
					assistant(
						[{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: "x" } }],
						"tool_use",
					),
					assistant([{ type: "text", text: "done" }]),
				];
				const message = scripts[Math.min(call, scripts.length - 1)] as AssistantMessage;
				call++;
				yield { type: "message_end", message };
			},
		};
		const seen: AgentMessage[] = [];
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [echoTool],
			history,
			userMessage: "go",
			onMessage: (m) => seen.push(m),
		});
		expect(seen.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("max_iterations closes dangling tool_use ids so the session stays resumable", async () => {
		const provider: LLMProvider = {
			name: "mock",
			async *stream() {
				const message = assistant(
					[
						{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: "x" } },
						{ type: "toolCall", id: "t2", name: "echo_tool", arguments: { message: "y" } },
					],
					"tool_use",
				);
				yield { type: "message_end", message };
			},
		};
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [echoTool],
			history,
			userMessage: "go",
			maxIterations: 1,
		});
		expect(result.stopReason).toBe("max_iterations");
		// history must end with a toolResult covering BOTH ids — otherwise resume 400s
		const last = history[history.length - 1];
		if (last?.role !== "toolResult") throw new Error("expected toolResult tail");
		expect(last.results.map((r) => r.toolCallId).sort()).toEqual(["t1", "t2"]);
		expect(last.results.every((r) => r.isError)).toBe(true);
	});

	it("abort mid-batch synthesizes results for tools that never ran", async () => {
		const controller = new AbortController();
		const twoCallProvider: LLMProvider = {
			name: "mock",
			async *stream() {
				const message = assistant(
					[
						{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: "first" } },
						{ type: "toolCall", id: "t2", name: "echo_tool", arguments: { message: "second" } },
					],
					"tool_use",
				);
				yield { type: "message_end", message };
			},
		};
		const abortingTool: Tool = {
			...echoTool,
			async execute(args) {
				// first tool completes, then the user interrupts before tool 2 runs
				controller.abort();
				return { output: `echo: ${String(args.message)}` };
			},
		};
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider: twoCallProvider,
			model: "m",
			system: "s",
			tools: [abortingTool],
			history,
			userMessage: "go",
			signal: controller.signal,
		});
		expect(result.stopReason).toBe("aborted");
		const last = history[history.length - 1];
		if (last?.role !== "toolResult") throw new Error("expected toolResult tail");
		const byId = new Map(last.results.map((r) => [r.toolCallId, r]));
		expect(byId.get("t1")?.content).toBe("echo: first"); // real result kept
		expect(byId.get("t2")?.isError).toBe(true); // synthesized for the unrun tool
		expect(byId.get("t2")?.content).toContain("interrupted");
	});

	it("onBeforeTurn may rewrite history (compaction shim)", async () => {
		const provider: LLMProvider = {
			name: "mock",
			async *stream(request) {
				// the rewrite happens before the first stream: history must already be compacted
				const first = request.messages[0];
				if (!(first?.role === "user" && first.content.includes("[Conversation summary"))) {
					throw new Error("expected compacted history in first turn");
				}
				const message = assistant([{ type: "text", text: "ok" }]);
				yield { type: "message_end", message };
			},
		};
		const history: AgentMessage[] = [
			{ role: "user", content: "old stuff that will be summarized away" },
			{
				role: "assistant",
				blocks: [{ type: "text", text: "old reply" }],
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "end_turn",
			},
		];
		await runAgentLoop({
			provider,
			model: "m",
			system: "s",
			tools: [],
			history,
			userMessage: "continue",
			maxIterations: 3,
			onBeforeTurn: (h) => {
				if (h.length > 2) {
					h.splice(
						0,
						h.length,
						{ role: "user", content: "[Conversation summary]\nsummarized" },
						h[h.length - 1] as AgentMessage,
					);
				}
			},
		});
	});
});
