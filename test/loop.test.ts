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
			const message = scripts[Math.min(call, scripts.length - 1)]!;
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
		// cost attribution: assistant messages carry the producing model id
		expect((history[1] as { model?: string }).model).toBe("mock");
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

describe("M17 follow-up continuation (same run)", () => {
	it("a non-empty follow-up poll continues the SAME run: one result, aggregated usage, follow-up in history", async () => {
		const provider = scriptedProvider([
			assistant([{ type: "text", text: "first answer" }]),
			assistant([{ type: "text", text: "follow-up answer" }]),
		]);
		const history: AgentMessage[] = [];
		let polls = 0;
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [],
			history,
			userMessage: "go",
			getFollowUpMessages: () => {
				polls++;
				// first would-stop boundary delivers one queued entry; the second finds the pool empty
				return polls === 1 ? [{ role: "user", content: "now this" }] : [];
			},
		});
		expect(result.stopReason).toBe("completed");
		expect(result.turns).toBe(2); // both assistant turns in ONE run
		expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 }); // aggregated across the continuation
		expect(history).toHaveLength(4); // go → answer → follow-up → answer
		expect(history[0]).toMatchObject({ role: "user", content: "go" });
		expect(history[1]).toMatchObject({ role: "assistant" });
		expect(history[2]).toMatchObject({ role: "user", content: "now this" }); // injected before the second call
		expect(history[3]).toMatchObject({ role: "assistant" });
	});

	it("empty follow-up poll is the real stop: completed at the boundary", async () => {
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])]);
		let polls = 0;
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [],
			history: [],
			userMessage: "go",
			getFollowUpMessages: () => {
				polls++;
				return [];
			},
		});
		expect(result.stopReason).toBe("completed");
		expect(result.turns).toBe(1);
		expect(polls).toBe(1);
	});

	it("steering queued at the would-stop boundary is consumed BEFORE any follow-up (pi order)", async () => {
		let calls = 0;
		let steeringQueue: AgentMessage[] = [];
		const followUps: AgentMessage[] = [{ role: "user", content: "F" }];
		const provider: LLMProvider = {
			name: "mock",
			async *stream() {
				calls++;
				if (calls === 1) {
					// queue the steer DURING the first response's stream: every earlier
					// top-of-loop poll read empty — only the would-stop boundary poll
					// can see it (pi agent-loop.ts :257 before :261)
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					steeringQueue = [{ role: "user", content: "S" }];
					yield { type: "message_end", message: assistant([{ type: "text", text: "turn one" }]) };
				} else if (calls === 2) {
					yield { type: "message_end", message: assistant([{ type: "text", text: "turn two" }]) };
				} else {
					yield { type: "message_end", message: assistant([{ type: "text", text: "turn three" }]) };
				}
			},
		};
		const history: AgentMessage[] = [];
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [],
			history,
			userMessage: "go",
			getSteeringMessages: () => {
				const drained = steeringQueue;
				steeringQueue = [];
				return drained;
			},
			getFollowUpMessages: () => followUps.splice(0),
		});
		// order: go → response 1 → boundary takes S (steer priority, extra turn)
		// → response 2 → boundary: steering empty → followUp F → response 3 → stop
		const users = history.filter((m) => m.role === "user").map((m) => (m as { content: unknown }).content);
		expect(users).toEqual(["go", "S", "F"]);
		expect(result.turns).toBe(3); // ONE run across both continuations
	});

	it("abort during a follow-up turn returns aborted; unconsumed follow-ups were never polled away", async () => {
		const controller = new AbortController();
		let calls = 0;
		const provider: LLMProvider = {
			name: "mock",
			async *stream() {
				calls++;
				if (calls === 1) yield { type: "message_end", message: assistant([{ type: "text", text: "one" }]) };
				// second call (the follow-up turn): abort mid-stream
				controller.abort();
				yield { type: "text_delta", text: "par" };
				throw new Error("unreachable — abortSafe providers end the stream");
			},
		};
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [],
			history: [],
			userMessage: "go",
			signal: controller.signal,
			getFollowUpMessages: () => (calls === 1 ? [{ role: "user", content: "F" }] : []),
		});
		expect(result.stopReason).toBe("aborted");
	});
});
