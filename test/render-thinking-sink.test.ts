import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { SessionStore } from "../src/core/session/store.js";
import { Renderer } from "../src/render.js";
import { replaySession } from "../src/repl/replay.js";
import type { ThinkingSink } from "../src/thinking-sink.js";

function fixture(hidden = false) {
	const events: string[] = [];
	const sink: ThinkingSink = {
		setHidden: (value) => events.push(`hidden:${value}`),
		begin: () => {
			events.push("begin");
			return {
				append: (text) => events.push(`append:${text}`),
				end: () => events.push("end"),
			};
		},
	};
	const renderer = new Renderer({
		write: (text) => events.push(`write:${text}`),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
		markdown: true,
		thinkingSink: sink,
		hideThinking: hidden,
		statusSink: (text) => events.push(`status:${text}`),
		userSink: (text) => events.push(`user:${text}`),
	});
	return { events, sink, renderer };
}

const delta = (renderer: Renderer, text = "partial") => renderer.event({ type: "thinking_delta", text });

describe("semantic thinking renderer", () => {
	it("retains hidden raw deltas and toggles without splitting or emitting bytes", () => {
		const { renderer, events } = fixture(true);
		delta(renderer, " \nfirst\n\n");
		renderer.hideThinking = false;
		delta(renderer, "tail ");
		renderer.hideThinking = true;
		renderer.endRun();
		renderer.endRun();
		expect(events).toEqual([
			"hidden:true",
			"begin",
			"append: \nfirst\n\n",
			"hidden:false",
			"append:tail ",
			"hidden:true",
			"end",
		]);
	});

	it("settles preceding answer once and keeps subsequent markdown buffered across toggles", () => {
		const { renderer, events } = fixture();
		renderer.raw("answer tail");
		delta(renderer, "reason");
		delta(renderer, "ing");
		expect(events).toEqual([
			"hidden:false",
			"write:answer tail",
			"write:\n",
			"begin",
			"append:reason",
			"append:ing",
		]);
		renderer.raw("next **answer**");
		const before = events.slice();
		renderer.hideThinking = true;
		renderer.hideThinking = false;
		expect(events).toEqual([...before, "hidden:true", "hidden:false"]);
		renderer.endRun();
		expect(events.slice(-2)).toEqual(["write:next **answer**", "write:\n"]);
	});

	it.each(["note", "status", "user", "error", "writeLine", "raw"] as const)(
		"closes before %s, then starts a new section",
		(method) => {
			const { renderer, events } = fixture();
			delta(renderer);
			renderer[method]("notice");
			delta(renderer, "later");
			renderer.endRun();
			expect(events.indexOf("end")).toBe(3);
			expect(events.filter((event) => event === "begin")).toHaveLength(2);
			expect(events.filter((event) => event === "end")).toHaveLength(2);
			expect(events.findIndex((event) => event.includes("notice"))).toBeGreaterThan(3);
		},
	);

	it("closes before tool completion, external fold insertion, and an error exactly once", () => {
		const { renderer, events } = fixture();
		delta(renderer);
		renderer.event({
			type: "tool_end",
			result: { toolCallId: "t", toolName: "read", content: "ok", isError: false },
		});
		events.push("fold");
		delta(renderer, "later");
		renderer.error("failed");
		renderer.endRun();
		expect(events[3]).toBe("end");
		expect(events.indexOf("fold")).toBeLessThan(events.lastIndexOf("begin"));
		expect(events.slice(-2)).toEqual(["end", "write:failed\n"]);
	});

	it("closes message_end before warnings and keeps subsequent sections distinct", () => {
		const { renderer, events } = fixture();
		delta(renderer);
		renderer.event({
			type: "message_end",
			message: {
				role: "assistant",
				blocks: [],
				usage: { inputTokens: 0, outputTokens: 0 },
				stopReason: "end_turn",
			},
		});
		renderer.status("warning");
		delta(renderer, "next");
		renderer.event({ type: "tool_start", toolCallId: "t", name: "read", args: {} });
		renderer.endRun();
		expect(events).toEqual([
			"hidden:false",
			"begin",
			"append:partial",
			"end",
			"status:warning",
			"begin",
			"append:next",
			"end",
		]);
	});

	it("settled thinking retains whitespace and assistant boundaries do not start spinners", () => {
		const { renderer, events } = fixture();
		renderer.raw("before");
		renderer.thinking(" \nraw \n");
		renderer.completeAssistantMessage();
		renderer.user("after");
		expect(events).toEqual([
			"hidden:false",
			"write:before",
			"write:\n",
			"begin",
			"append: \nraw \n",
			"end",
			"user:after",
		]);
	});

	it("preserves byte-only thinking output", () => {
		let output = "";
		const renderer = new Renderer({
			write: (text) => {
				output += text;
			},
			ansi: false,
			liveTools: false,
			toolStyle: "two-line",
		});
		delta(renderer, " first\n\nsecond ");
		renderer.event({ type: "text_delta", text: "answer" });
		renderer.endRun(true);
		expect(output).toBe("first\n\nsecond\n\nanswer\n");
	});

	it("replays original thinking and distinct assistant sections before the user block", () => {
		const { sink, events } = fixture();
		const assistant = (blocks: Extract<AgentMessage, { role: "assistant" }>["blocks"]): AgentMessage => ({
			role: "assistant",
			blocks,
			usage: { inputTokens: 1, outputTokens: 1 },
			stopReason: "end_turn",
		});
		const messages: AgentMessage[] = [
			assistant([
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: " first " },
			]),
			assistant([{ type: "thinking", thinking: "\nsecond\n" }]),
			{ role: "user", content: "next" },
		];
		replaySession(
			{
				write: (text) => events.push(`write:${text}`),
				ansi: false,
				markdown: true,
				thinkingSink: sink,
				userSink: (text) => events.push(`user:${text}`),
			},
			{ buildContext: () => ({ messages }) } as unknown as SessionStore,
		);
		expect(events.slice(2, -1)).toEqual([
			"write:answer\n\n",
			"begin",
			"append: first ",
			"end",
			"begin",
			"append:\nsecond\n",
			"end",
			"user:next",
		]);
	});
});
