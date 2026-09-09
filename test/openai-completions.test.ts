import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import { createOpenAICompletionsProvider } from "../src/provider/openai-completions.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";

/**
 * Wire-level tests for the OpenAI Chat Completions adapter (#multi-provider
 * batch 0). Mirrors the anthropic-abort.test.ts approach: a local HTTP server
 * replaying scripted SSE chunks, the real provider consuming them.
 */

interface CapturedRequest {
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

const REQ = (model: string, messages: AgentMessage[], tools: Tool[] = []): LLMRequest => ({
	system: "sys-prompt",
	model,
	messages,
	tools,
	maxTokens: 1024,
});

async function collect(events: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
	const out: LLMEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

function lastMessage(events: LLMEvent[]) {
	const end = events.find((e) => e.type === "message_end");
	if (end?.type !== "message_end") throw new Error("no message_end");
	return end.message;
}

describe("openai-completions provider", () => {
	let server: Server;
	let baseUrl = "";
	const captured: CapturedRequest[] = [];
	/** Script for the NEXT request; each test sets what it needs. */
	let script: { status: number; chunks: string[]; hold?: boolean } = { status: 200, chunks: [] };

	beforeAll(async () => {
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				captured.push({
					body: JSON.parse(raw) as Record<string, unknown>,
					headers: Object.fromEntries(
						Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
					),
				});
				res.writeHead(script.status, { "content-type": "text/event-stream" });
				for (const c of script.chunks) res.write(c);
				if (script.hold) {
					req.on("close", () => res.destroy());
					return; // stream stays open — the abort scenario
				}
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function provider() {
		return createOpenAICompletionsProvider({ baseUrl, apiKey: "test-key" });
	}

	it("streams a text turn: deltas, usage mapping, end_turn", async () => {
		script = {
			status: 200,
			chunks: [
				sse({ choices: [{ delta: { role: "assistant" } }] }),
				sse({ choices: [{ delta: { content: "hel" } }] }),
				sse({ choices: [{ delta: { content: "lo" } }] }),
				sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
				sse({
					choices: [],
					usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } },
				}),
				"data: [DONE]\n\n",
			],
		};
		const events = await collect(provider().stream(REQ("gpt-5.2", [{ role: "user", content: "hi" }])));
		const text = events.filter(
			(e): e is Extract<LLMEvent, { type: "text_delta" }> => e.type === "text_delta",
		);
		expect(text.map((e) => e.text).join("")).toBe("hello");
		const msg = lastMessage(events);
		expect(msg.blocks).toEqual([{ type: "text", text: "hello" }]);
		// prompt_tokens(100) includes the 40 cache hits → inputTokens excludes them (review F1)
		expect(msg.usage).toEqual({ inputTokens: 60, outputTokens: 7, cacheReadTokens: 40 });
		expect(msg.stopReason).toBe("end_turn");
	});

	it("streams tool calls by index with fragmented arguments; finish tool_calls → tool_use", async () => {
		script = {
			status: 200,
			chunks: [
				sse({
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, id: "call_a", function: { name: "bash", arguments: '{"comm' } }],
							},
						},
					],
				}),
				sse({ choices: [{ delta: { content: "running" } }] }),
				sse({
					choices: [
						{
							delta: {
								tool_calls: [{ index: 1, id: "call_b", function: { name: "read", arguments: '{"path"' } }],
							},
						},
					],
				}),
				sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
				sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':"/x"}' } }] } }] }),
				sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
				sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } }),
				"data: [DONE]\n\n",
			],
		};
		const events = await collect(provider().stream(REQ("glm-4.6", [{ role: "user", content: "go" }])));
		const starts = events.filter(
			(e): e is Extract<LLMEvent, { type: "tool_call_start" }> => e.type === "tool_call_start",
		);
		expect(starts.map((e) => `${e.id}:${e.name}`)).toEqual(["call_a:bash", "call_b:read"]);
		const deltas = events.filter(
			(e): e is Extract<LLMEvent, { type: "tool_call_delta" }> => e.type === "tool_call_delta",
		);
		expect(deltas).toHaveLength(4); // fragments preserved, keyed by the right id
		expect(deltas.map((e) => e.id)).toEqual(["call_a", "call_b", "call_a", "call_b"]); // arrival order
		const msg = lastMessage(events);
		// blocks preserve arrival order (same convention as the anthropic adapter)
		expect(msg.blocks).toEqual([
			{ type: "toolCall", id: "call_a", name: "bash", arguments: { command: "ls" } },
			{ type: "text", text: "running" },
			{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "/x" } },
		]);
		expect(msg.stopReason).toBe("tool_use");
	});

	it("maps OpenRouter's prompt_cache_hit_tokens spelling", async () => {
		script = {
			status: 200,
			chunks: [
				sse({ choices: [{ delta: { content: "x" } }] }),
				sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
				sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 8 } }),
			],
		};
		const events = await collect(provider().stream(REQ("openai/gpt-5.2", [{ role: "user", content: "hi" }])));
		expect(lastMessage(events).usage.cacheReadTokens).toBe(8);
	});

	it("request body: system message first, assistant tool_calls echoed, tool role messages, nested tools, maxTokensField", async () => {
		script = {
			status: 200,
			chunks: [
				sse({ choices: [{ delta: { content: "ok" } }] }),
				sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
			],
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "list files" },
			{
				role: "assistant",
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "tool_use",
				blocks: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
			},
			{
				role: "toolResult",
				results: [{ toolCallId: "call_1", toolName: "bash", content: "a\nb", isError: false }],
			},
		];
		const bashTool: Tool = {
			name: "bash",
			description: "run",
			parameters: { type: "object", properties: { command: { type: "string" } } } as never,
			execute: async () => ({ output: "", isError: false }),
		};
		await collect(provider().stream(REQ("glm-4.6", messages, [bashTool])));
		const body = captured.at(-1)?.body as Record<string, unknown>;
		const wire = body.messages as Array<Record<string, unknown>>;
		expect(wire[0]).toEqual({ role: "system", content: "sys-prompt" });
		expect(wire[1]).toEqual({ role: "user", content: "list files" });
		expect(wire[2]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
			],
		});
		expect(wire[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "a\nb" });
		expect(body.max_tokens).toBe(1024); // glm → classic field
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.stream_options).toEqual({ include_usage: true });
		const tools = body.tools as Array<Record<string, unknown>>;
		expect(tools[0]).toEqual({
			type: "function",
			function: {
				name: "bash",
				description: "run",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
		});
		expect(body.tool_choice).toBe("auto");

		// gpt-5* flips to the modern field
		await collect(provider().stream(REQ("gpt-5.2", [{ role: "user", content: "hi" }])));
		const body2 = captured.at(-1)?.body as Record<string, unknown>;
		expect(body2.max_completion_tokens).toBe(1024);
		expect(body2.max_tokens).toBeUndefined();
		expect(captured.at(-1)?.headers.authorization).toBe("Bearer test-key");
	});

	it("abort mid-stream: no throw, no message_end (parity with anthropic abortSafe)", async () => {
		script = { status: 200, chunks: [sse({ choices: [{ delta: { content: "partial" } }] })], hold: true };
		const controller = new AbortController();
		const events: LLMEvent[] = [];
		await (async () => {
			for await (const event of provider().stream({
				...REQ("glm-4.6", [{ role: "user", content: "hi" }]),
				signal: controller.signal,
			})) {
				events.push(event);
				if (event.type === "text_delta") controller.abort();
			}
		})();
		expect(events.some((e) => e.type === "message_end")).toBe(false);
	});

	it("truncated stream (no finish_reason) fails loudly", async () => {
		script = { status: 200, chunks: [sse({ choices: [{ delta: { content: "cut" } }] })] }; // ends abruptly
		await expect(
			collect(provider().stream(REQ("glm-4.6", [{ role: "user", content: "hi" }]))),
		).rejects.toThrow("ended without finish_reason");
	});

	it("retries a 429 once and succeeds; 401 carries the key hint", async () => {
		let calls = 0;
		// one-shot wrapper: first request 429, then the scripted 200
		const original = script;
		script = { status: 429, chunks: [] };
		const patchedProvider = createOpenAICompletionsProvider({ baseUrl, apiKey: "test-key" });
		// swap the script asynchronously after the first call lands
		server.once("request", () => {
			calls++;
			// the 429 already used this handler's write; arm the success script
			original.status = 200;
			original.chunks = [
				sse({ choices: [{ delta: { content: "recovered" } }] }),
				sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
			];
			script = original;
		});
		const events = await collect(patchedProvider.stream(REQ("glm-4.6", [{ role: "user", content: "hi" }])));
		expect(lastMessage(events).blocks[0]).toEqual({ type: "text", text: "recovered" });
		expect(captured.length).toBeGreaterThanOrEqual(2);

		script = { status: 401, chunks: [] };
		await expect(
			collect(provider().stream(REQ("glm-4.6", [{ role: "user", content: "hi" }]))),
		).rejects.toThrow(/401.*OPENAI_API_KEY/);
	});

	it("a turn with no content and no tool calls synthesizes an (empty) text block", async () => {
		script = {
			status: 200,
			chunks: [sse({ choices: [{ delta: {} }] }), sse({ choices: [{ delta: {}, finish_reason: "stop" }] })],
		};
		const events = await collect(provider().stream(REQ("glm-4.6", [{ role: "user", content: "hi" }])));
		expect(lastMessage(events).blocks).toEqual([{ type: "text", text: "(empty)" }]);
	});

	it("finish_reason 'length' maps to max_tokens", async () => {
		script = {
			status: 200,
			chunks: [
				sse({ choices: [{ delta: { content: "long" } }] }),
				sse({ choices: [{ delta: {}, finish_reason: "length" }] }),
			],
		};
		const events = await collect(provider().stream(REQ("glm-4.6", [{ role: "user", content: "hi" }])));
		expect(lastMessage(events).stopReason).toBe("max_tokens");
	});
});

describe("parseModelRef routing", () => {
	// imported here to keep the top of the file focused on the wire tests
	it("bare ids default to anthropic; canonical prefixes route; unknown prefixes fall back", async () => {
		const { parseModelRef } = await import("../src/provider/resolve.js");
		expect(parseModelRef("glm-4.6")).toEqual({ provider: "anthropic", modelId: "glm-4.6" });
		expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		expect(parseModelRef("openai/gpt-5.2")).toEqual({ provider: "openai", modelId: "gpt-5.2" });
		expect(parseModelRef("openrouter/org/model")).toEqual({
			provider: "anthropic",
			modelId: "openrouter/org/model",
		});
		expect(parseModelRef("openai/")).toEqual({ provider: "anthropic", modelId: "openai/" });
		// review P2-6: near-miss prefixes are typos, not exotic ids
		expect(parseModelRef("OpenAI/gpt-5.2")).toEqual({ provider: "openai", modelId: "gpt-5.2" });
		expect(parseModelRef(" openai/gpt-5.2 ")).toEqual({ provider: "openai", modelId: "gpt-5.2" });
		expect(parseModelRef("OpenAI-Codex/gpt-5.4")).toEqual({ provider: "openai-codex", modelId: "gpt-5.4" });
	});
});
