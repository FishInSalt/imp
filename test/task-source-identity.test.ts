import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type AgentEvent, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage } from "../src/core/messages.js";
import { createTaskTool } from "../src/core/tools/task.js";
import type { Tool } from "../src/core/tools/types.js";
import type { AgentEventInfo } from "../src/runner.js";
import { assistant, gate, scriptedProvider, waitUntil } from "./helpers/fakes.js";

const done = assistant([{ type: "text", text: "done" }]);

describe("ephemeral task source identity", () => {
	it.each([false, true])(
		"passes actual call ids through the serial/parallel boundary (parallel=%s)",
		async (concurrencySafe) => {
			const ids: (string | undefined)[] = [];
			const tool: Tool = {
				name: "probe",
				description: "probe",
				parameters: Type.Object({}),
				concurrencySafe,
				async execute(_args, _signal, context) {
					ids.push(context?.toolCallId);
					return { output: "ok" };
				},
			};
			await runAgentLoop({
				provider: scriptedProvider([
					assistant(
						["one", "two"].map((id) => ({ type: "toolCall", id, name: "probe", arguments: {} })),
						"tool_use",
					),
					done,
				]),
				model: "m",
				system: "",
				tools: [tool],
				history: [],
				userMessage: "go",
			});
			expect(ids).toEqual(["one", "two"]);
		},
	);

	it("keeps identical child call ids and labels distinct when tasks complete in reverse order", async () => {
		const holds = [gate(), gate()];
		const started: number[] = [];
		const completed: number[] = [];
		let next = 0;
		const observations: { event: AgentEvent; info: AgentEventInfo }[] = [];
		const task = createTaskTool({
			getProvider: () => {
				const index = next++;
				return scriptedProvider([
					assistant(
						[{ type: "toolCall", id: "same-child-id", name: "hold", arguments: { index } }],
						"tool_use",
					),
					done,
				]);
			},
			getModel: () => "m",
			getSystem: () => "",
			getSession: () => null,
			childSessions: false,
			cwd: process.cwd(),
			getTools: () => [
				{
					name: "hold",
					description: "hold",
					parameters: Type.Object({ index: Type.Number() }),
					async execute(args) {
						const index = args.index as number;
						started.push(index);
						await holds[index]?.promise;
						completed.push(index);
						return { output: "held" };
					},
				},
			],
			onEvent: (event, info) => observations.push({ event, info }),
		});
		const history: AgentMessage[] = [];
		const running = runAgentLoop({
			provider: scriptedProvider([
				assistant(
					["parent-a", "parent-b"].map((id) => ({
						type: "toolCall",
						id,
						name: "task",
						arguments: { prompt: "same prompt" },
					})),
					"tool_use",
				),
				done,
			]),
			model: "m",
			system: "",
			tools: [task],
			history,
			userMessage: "go",
		});
		await waitUntil(() => started.length === 2);
		holds[1]?.resolve();
		await waitUntil(() => completed.length === 1);
		holds[0]?.resolve();
		await running;
		expect(completed).toEqual([1, 0]);
		const starts = observations.filter(({ event }) => event.type === "tool_start");
		expect(starts).toHaveLength(2);
		expect(starts.map(({ info }) => info.taskToolCallId)).toEqual(["parent-a", "parent-b"]);
		expect(new Set(starts.map(({ info }) => info.sourceId)).size).toBe(2);
		for (const { info } of starts) {
			expect(info.sourceId).toEqual(expect.any(String));
			const sourceEvents = observations.filter((entry) => entry.info.sourceId === info.sourceId);
			expect(sourceEvents.some(({ event }) => event.type === "tool_end")).toBe(true);
			for (const entry of sourceEvents) expect(entry.info).toEqual(info);
		}
		expect(JSON.stringify(history)).not.toContain("sourceId");
		expect(JSON.stringify(history)).not.toContain("taskToolCallId");
	});

	it("direct execution has a source identity without inventing a parent association", async () => {
		const infos: AgentEventInfo[] = [];
		const task = createTaskTool({
			getProvider: () => scriptedProvider([done]),
			getModel: () => "m",
			getSystem: () => "",
			getTools: () => [],
			getSession: () => null,
			childSessions: false,
			onEvent: (_event, info) => infos.push(info),
		});
		await task.execute({ prompt: "go" }, new AbortController().signal);
		expect(infos.length).toBeGreaterThan(0);
		expect(new Set(infos.map((info) => info.sourceId)).size).toBe(1);
		for (const info of infos) {
			expect(info.sourceId).toEqual(expect.any(String));
			expect(info).not.toHaveProperty("taskToolCallId");
		}
	});
});
