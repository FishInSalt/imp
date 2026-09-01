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
			res.write(
				'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
			);
			res.write(
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
			);
			res.write(
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
			);
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
			res.write(
				'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
			);
			res.write(
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
			);
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

	it("retries a connection-level failure and succeeds on the second attempt", async () => {
		// Dogfood fix 2026-09-01: Z.ai dropped the 7th request of a news-search
		// turn ("fetch failed", zero bytes yielded) and killed the whole turn.
		// Connection-level failures are idempotent to retry.
		let hits = 0;
		const flaky = createServer((req, res) => {
			hits += 1;
			if (hits === 1) {
				res.destroy(); // connection cut before any response bytes
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
			res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n');
			res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}\n\n');
			res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n');
			res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
			res.end();
			req.on("close", () => res.destroy());
		});
		await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
		const address = flaky.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const provider = createAnthropicProvider({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "k" });
		const events: LLMEvent[] = [];
		for await (const event of provider.stream({
			model: "m",
			messages: [{ role: "user", content: "hi" }],
			tools: [],
			maxTokens: 64,
		})) {
			events.push(event);
		}
		expect(hits).toBe(2); // first dropped, retry landed
		expect(events.some((e) => e.type === "text_delta" && e.text === "recovered")).toBe(true);
		expect(events.at(-1)?.type).toBe("message_end");
		await new Promise<void>((resolve) => flaky.close(() => resolve()));
	});

	it("retries a retryable status (503) once, then succeeds; a 400 is never retried", async () => {
		let hits = 0;
		let mode: "503" | "ok" | "400" = "503";
		const srv = createServer((req, res) => {
			hits += 1;
			if (mode === "503") {
				mode = "ok";
				res.writeHead(503, { "content-type": "text/plain" });
				res.end("overloaded");
				return;
			}
			if (mode === "400") {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end("bad request");
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n');
			res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
			res.end();
			req.on("close", () => res.destroy());
		});
		await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
		const address = srv.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const provider = createAnthropicProvider({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "k" });
		const drain = async () => {
			const events: LLMEvent[] = [];
			for await (const event of provider.stream({
				model: "m",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				maxTokens: 64,
			})) {
				events.push(event);
			}
			return events;
		};
		const recovered = await drain();
		expect(hits).toBe(2); // 503 → retry → ok
		expect(recovered.at(-1)?.type).toBe("message_end");
		mode = "400";
		hits = 0;
		await expect(drain()).rejects.toThrow(/Anthropic API error 400/);
		expect(hits).toBe(1); // 4xx never retried
		await new Promise<void>((resolve) => srv.close(() => resolve()));
	});
});
