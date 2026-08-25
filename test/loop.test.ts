import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/core/loop.js";
import { runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import type { LLMProvider } from "../src/provider/types.js";

function assistant(
	blocks: AssistantMessage["blocks"],
	stopReason: AssistantMessage["stopReason"] = "end_turn",
): AssistantMessage {
	return { role: "assistant", blocks, usage: { inputTokens: 10, outputTokens: 5 }, stopReason };
}

/** Replays scripted assistant messages in order; repeats the last one if the loop calls again. */
function scriptedProvider(scripts: AssistantMessage[]): LLMProvider {
	let call = 0;
	return {
		name: "mock",
		async *stream() {
			const message = scripts[Math.min(call, scripts.length - 1)];
			call++;
			for (const block of message.blocks) {
				if (block.type === "text") yield { type: "text_delta", text: block.text };
				if (block.type === "toolCall") yield { type: "tool_call_start", id: block.id, name: block.name };
			}
			yield { type: "message_end", message };
		},
	};
}

function echoTool(seen: unknown[] = []): Tool {
	return {
		name: "echo_tool",
		description: "echoes the message back",
		parameters: Type.Object({ message: Type.String() }),
		async execute(args) {
			seen.push(args);
			return { output: `echo: ${String(args.message)}` };
		},
	};
}

describe("agent loop", () => {
	it("runs a tool call then completes", async () => {
		const seen: unknown[] = [];
		const provider = scriptedProvider([
			assistant(
				[{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: "hi from imp" } }],
				"tool_use",
			),
			assistant([{ type: "text", text: "all done" }]),
		]);
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [echoTool(seen)],
			history,
			userMessage: "run it",
		});

		expect(result.stopReason).toBe("completed");
		expect(result.turns).toBe(2);
		expect(seen).toEqual([{ message: "hi from imp" }]);
		// user -> assistant(toolCall) -> toolResult -> assistant(text)
		expect(history).toHaveLength(4);
		expect(history[0]).toMatchObject({ role: "user", content: "run it" });
		expect(history[1]).toMatchObject({ role: "assistant" });
		expect(history[2]).toMatchObject({ role: "toolResult" });
		const toolResult = history[2] as Extract<AgentMessage, { role: "toolResult" }>;
		expect(toolResult.results[0]).toMatchObject({ isError: false, content: "echo: hi from imp" });
		expect(history[3]).toMatchObject({ role: "assistant" });
		// usage aggregated across both calls
		expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
	});

	it("feeds unknown-tool errors back to the model instead of crashing", async () => {
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "t1", name: "nonexistent", arguments: {} }], "tool_use"),
			assistant([{ type: "text", text: "ok I won't use that tool" }]),
		]);
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [echoTool()],
			history,
			userMessage: "go",
		});

		expect(result.stopReason).toBe("completed");
		const toolResult = history[2] as Extract<AgentMessage, { role: "toolResult" }>;
		expect(toolResult.results[0]?.isError).toBe(true);
		expect(toolResult.results[0]?.content).toContain("unknown tool");
	});

	it("rejects arguments that fail schema validation", async () => {
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: 123 } }], "tool_use"),
			assistant([{ type: "text", text: "fixed" }]),
		]);
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [echoTool()],
			history,
			userMessage: "go",
		});
		const toolResult = history[2] as Extract<AgentMessage, { role: "toolResult" }>;
		expect(toolResult.results[0]?.isError).toBe(true);
		expect(toolResult.results[0]?.content).toContain("invalid arguments");
	});

	it("converts thrown tool errors into error results", async () => {
		const boom: Tool = {
			name: "boom",
			description: "always throws",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("kaboom");
			},
		};
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "t1", name: "boom", arguments: {} }], "tool_use"),
			assistant([{ type: "text", text: "recovered" }]),
		]);
		const history: AgentMessage[] = [];
		await runAgentLoop({ provider, model: "mock", system: "", tools: [boom], history, userMessage: "go" });
		const toolResult = history[2] as Extract<AgentMessage, { role: "toolResult" }>;
		expect(toolResult.results[0]?.isError).toBe(true);
		expect(toolResult.results[0]?.content).toContain("kaboom");
	});

	it("stops at max iterations", async () => {
		const provider = scriptedProvider([
			assistant(
				[{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: "again" } }],
				"tool_use",
			),
		]);
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [echoTool()],
			history,
			userMessage: "loop forever",
			maxIterations: 1,
		});
		expect(result.stopReason).toBe("max_iterations");
		expect(result.turns).toBe(1);
	});

	it("returns immediately when already aborted", async () => {
		const provider = scriptedProvider([assistant([{ type: "text", text: "never" }])]);
		const controller = new AbortController();
		controller.abort();
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [],
			history,
			userMessage: "go",
			signal: controller.signal,
		});
		expect(result.stopReason).toBe("aborted");
		// the user message is recorded, but no LLM call is made
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ role: "user" });
	});

	it("emits tool_start/tool_end events", async () => {
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "t1", name: "echo_tool", arguments: { message: "x" } }], "tool_use"),
			assistant([{ type: "text", text: "done" }]),
		]);
		const events: AgentEvent[] = [];
		await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [echoTool()],
			history: [],
			userMessage: "go",
			onEvent: (e) => events.push(e),
		});
		const types = events.map((e) => e.type);
		expect(types).toContain("tool_start");
		expect(types).toContain("tool_end");
		expect(types).toContain("text_delta");
		expect(types).toContain("message_end");
	});
});
