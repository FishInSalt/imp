import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/provider/anthropic.js";
import type { LLMEvent } from "../src/provider/types.js";

/**
 * Regression M1 (review of m3-repl): aborting mid-SSE-read made undici reject
 * the body reader, the DOMException escaped the provider, and the agent loop
 * reported a user interrupt as a provider failure. abortSafe() must turn that
 * rejection into a clean generator end — no throw, no message_end event.
 */
describe("anthropic provider abort mid-stream", () => {
	let server: Server;
	let baseUrl = "";

	beforeAll(async () => {
		server = createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
			res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n');
			res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
			// then the stream just holds — the client aborts while we hang
			req.on("close", () => res.destroy());
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("stream() ends cleanly (no throw, no message_end) when aborted mid-read", async () => {
		const provider = createAnthropicProvider({ baseUrl, apiKey: "test-key" });
		const controller = new AbortController();
		const events: LLMEvent[] = [];
		// Consume the real provider against the hanging SSE server; abort as
		// soon as the first delta arrives — the exact interrupt scenario.
		await (async () => {
			for await (const event of provider.stream({
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				maxTokens: 64,
				signal: controller.signal,
			})) {
				events.push(event);
				if (event.type === "text_delta") controller.abort();
			}
		})();
		expect(controller.signal.aborted).toBe(true);
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		expect(events.some((e) => e.type === "message_end")).toBe(false);
	});

	it("negative: a mid-stream failure WITHOUT abort must still throw (never swallowed as a clean end)", async () => {
		// The discrimination property of abortSafe: only signal.aborted converts
		// a read failure into a clean end. A `catch { return; }` regression here
		// would keep every other test green — this is the pin.
		const truncating = createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
			res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
			// connection cut mid-response, no message_stop — the proxy/LB case
			setTimeout(() => res.destroy(), 20);
			req.on("close", () => res.destroy());
		});
		await new Promise<void>((resolve) => truncating.listen(0, "127.0.0.1", resolve));
		const address = truncating.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const provider = createAnthropicProvider({
			baseUrl: `http://127.0.0.1:${address.port}`,
			apiKey: "test-key",
		});
		await expect(
			(async () => {
				for await (const _event of provider.stream({
					model: "test-model",
					messages: [{ role: "user", content: "hi" }],
					tools: [],
					maxTokens: 64,
				})) {
					// drain
				}
			})(),
		).rejects.toThrow(/without message_stop|fetch|terminated|ECONN|aborted/i);
		await new Promise<void>((resolve) => truncating.close(() => resolve()));
	});
});
