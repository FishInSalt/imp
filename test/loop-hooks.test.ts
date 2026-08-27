import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
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
