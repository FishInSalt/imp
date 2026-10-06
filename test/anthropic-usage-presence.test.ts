import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/provider/anthropic.js";
import type { LLMEvent } from "../src/provider/types.js";

/**
 * SA-04 round 2 (acceptance P1): the anthropic adapter must carry "no usage
 * data was received" structurally instead of emitting initialization zeros
 * as if they were an explicit report. See docs/design/sa-04-attempt-usage-design.md
 * §10.
 */

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("anthropic usage presence", () => {
	let server: Server;
	let respond: () => string = () => "";
	beforeAll(async () => {
		server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(respond());
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));
	const provider = () =>
		createAnthropicProvider({
			baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
			apiKey: "k",
		});

	const skeletonTail = () =>
		sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
		sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }) +
		sse("content_block_stop", { index: 0 });

	async function finish(events: AsyncIterable<LLMEvent>) {
		let msg: Extract<LLMEvent, { type: "message_end" }>["message"] | undefined;
		for await (const e of events) if (e.type === "message_end") msg = e.message;
		if (msg === undefined) throw new Error("no message_end");
		return msg;
	}

	function stream() {
		return provider().stream({
			system: "s",
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hi" }],
			tools: [],
			maxTokens: 100,
		});
	}

	it("no usage counters anywhere → usageMissing, zeros preserved as known values", async () => {
		respond = () =>
			sse("message_start", { message: {} }) +
			skeletonTail() +
			sse("message_delta", { delta: { stop_reason: "end_turn" } }) +
			sse("message_stop", {});
		const msg = await finish(stream());
		expect(msg.blocks).toEqual([{ type: "text", text: "hi" }]);
		expect(msg.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(msg.usageMissing).toBe(true);
	});

	it("a numeric counter — even an explicit zero — is a report, no flag", async () => {
		respond = () =>
			sse("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }) +
			skeletonTail() +
			sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }) +
			sse("message_stop", {});
		const msg = await finish(stream());
		expect(msg.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: undefined,
			cacheWriteTokens: undefined,
		});
		expect(msg.usageMissing).toBeUndefined();
	});
});
