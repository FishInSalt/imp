import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import { createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import type { LLMRequest } from "../src/provider/types.js";

/**
 * Wire-level tests for the Codex Responses adapter (#multi-provider batch 2)
 * — the ChatGPT-subscription credential path. Scripted SSE with `event:`
 * lines against a local server; auth is injected so no credential store is
 * touched.
 */

interface CapturedRequest {
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

function sse(event: string, obj: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

const REQ = (model: string, messages: AgentMessage[]): LLMRequest => ({
	system: "sys-instructions",
	model,
	messages,
	tools: [],
	maxTokens: 1024,
});

async function collect(
	stream: AsyncIterable<unknown>,
): Promise<Array<{ type: string } & Record<string, unknown>>> {
	const out: Array<{ type: string } & Record<string, unknown>> = [];
	for await (const e of stream) out.push(e as { type: string } & Record<string, unknown>);
	return out;
}

function lastMessage(events: Array<{ type: string } & Record<string, unknown>>) {
	const end = events.find((e) => e.type === "message_end");
	if (end === undefined) throw new Error("no message_end");
	return end.message as {
		blocks: Array<Record<string, unknown>>;
		usage: Record<string, unknown>;
		stopReason: string | null;
	};
}

describe("codex-responses provider", () => {
	let server: Server;
	let baseUrl = "";
	const captured: CapturedRequest[] = [];
	let script: { status: number; chunks: string[]; hold?: boolean } = { status: 200, chunks: [] };

	beforeAll(async () => {
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				captured.push({
					body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
					headers: Object.fromEntries(
						Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
					),
				});
				res.writeHead(script.status, { "content-type": "text/event-stream" });
				for (const c of script.chunks) res.write(c);
				if (script.hold) {
					req.on("close", () => res.destroy());
					return;
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
		return createCodexResponsesProvider({
			baseUrl,
			auth: async () => ({ accessToken: "fake-access", accountId: "acct-9" }),
		});
	}

	it("streams a text turn: instructions field, input_text items, usage subtracts cached, end_turn", async () => {
		script = {
			status: 200,
			chunks: [
				sse("response.created", { response: { id: "resp_1" } }),
				sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1" } }),
				sse("response.output_text.delta", { output_index: 0, delta: "hel" }),
				sse("response.output_text.delta", { output_index: 0, delta: "lo" }),
				sse("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1" } }),
				sse("response.completed", {
					response: {
						status: "completed",
						usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 30 } },
					},
				}),
			],
		};
		const events = await collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }])));
		const text = events
			.filter((e) => e.type === "text_delta")
			.map((e) => e.text as string)
			.join("");
		expect(text).toBe("hello");
		const msg = lastMessage(events);
		expect(msg.blocks).toEqual([{ type: "text", text: "hello" }]);
		expect(msg.usage).toEqual({ inputTokens: 70, outputTokens: 5, cacheReadTokens: 30 });
		expect(msg.stopReason).toBe("end_turn");

		const body = captured.at(-1)?.body as Record<string, unknown>;
		expect(body.instructions).toBe("sys-instructions");
		expect(body.store).toBe(false);
		// the ChatGPT backend rejects max_output_tokens with a 400 — the wire
		// must not carry it (regression pin: live "Unsupported parameter" 400)
		expect("max_output_tokens" in body).toBe(false);
		expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
		const headers = captured.at(-1)?.headers ?? {};
		expect(headers.authorization).toBe("Bearer fake-access");
		expect(headers["chatgpt-account-id"]).toBe("acct-9");
		expect(headers.originator).toBe("imp");
		expect(headers["openai-beta"]).toBe("responses=experimental");
	});

	it("function_call items: flat tools, call_id keying, fragmented args, stopReason tool_use", async () => {
		script = {
			status: 200,
			chunks: [
				sse("response.output_item.added", {
					output_index: 0,
					item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "bash" },
				}),
				sse("response.function_call_arguments.delta", { output_index: 0, delta: '{"comm' }),
				sse("response.function_call_arguments.delta", { output_index: 0, delta: 'and":"ls"}' }),
				sse("response.output_item.done", {
					output_index: 0,
					item: { type: "function_call", call_id: "call_a" },
				}),
				sse("response.completed", {
					response: { status: "completed", usage: { input_tokens: 10, output_tokens: 9 } },
				}),
			],
		};
		const req = REQ("gpt-5.5", [{ role: "user", content: "run ls" }]);
		req.tools = [
			{
				name: "bash",
				description: "run",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				execute: async () => ({ output: "", isError: false }),
			},
		];
		const events = await collect(provider().stream(req));
		const starts = events.filter((e) => e.type === "tool_call_start");
		expect(starts.map((e) => `${e.id}:${e.name}`)).toEqual(["call_a:bash"]);
		const deltas = events
			.filter((e) => e.type === "tool_call_delta")
			.map((e) => e.jsonDelta as string)
			.join("");
		expect(deltas).toBe('{"command":"ls"}');
		const msg = lastMessage(events);
		expect(msg.blocks).toEqual([
			{ type: "toolCall", id: "call_a", name: "bash", arguments: { command: "ls" } },
		]);
		expect(msg.stopReason).toBe("tool_use");

		const body = captured.at(-1)?.body as Record<string, unknown>;
		const tools = body.tools as Array<Record<string, unknown>>;
		expect(tools[0]).toEqual({
			type: "function",
			name: "bash",
			description: "run",
			parameters: { type: "object", properties: { command: { type: "string" } } },
			strict: false,
		});
		expect(body.tool_choice).toBe("auto");
	});

	it("history replay: assistant text + function_call items and function_call_output items", async () => {
		script = {
			status: 200,
			chunks: [
				sse("response.output_item.added", { output_index: 0, item: { type: "message" } }),
				sse("response.output_text.delta", { output_index: 0, delta: "ok" }),
				sse("response.completed", {
					response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
				}),
			],
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "list" },
			{
				role: "assistant",
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "tool_use",
				blocks: [
					{ type: "text", text: "checking" },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				],
			},
			{
				role: "toolResult",
				results: [{ toolCallId: "call_1", toolName: "bash", content: "a b", isError: false }],
			},
		];
		await collect(provider().stream(REQ("gpt-5.5", messages)));
		const body = captured.at(-1)?.body as Record<string, unknown>;
		expect(body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "list" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "checking" }] },
			{ type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
			{ type: "function_call_output", call_id: "call_1", output: "a b" },
		]);
	});

	it("response.incomplete maps to max_tokens; missing terminal event fails loudly", async () => {
		script = {
			status: 200,
			chunks: [
				sse("response.output_item.added", { output_index: 0, item: { type: "message" } }),
				sse("response.output_text.delta", { output_index: 0, delta: "cut" }),
				sse("response.incomplete", {
					response: { status: "incomplete", usage: { input_tokens: 1, output_tokens: 1 } },
				}),
			],
		};
		const events = await collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }])));
		expect(lastMessage(events).stopReason).toBe("max_tokens");

		script = { status: 200, chunks: [sse("response.output_text.delta", { output_index: 0, delta: "x" })] }; // no terminal
		await expect(
			collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }]))),
		).rejects.toThrow("without response.completed");
	});

	it("response.failed and error events throw with the server's message", async () => {
		script = {
			status: 200,
			chunks: [sse("response.failed", { response: { error: { message: "usage limit reached" } } })],
		};
		await expect(
			collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }]))),
		).rejects.toThrow("usage limit reached");
		script = { status: 200, chunks: [sse("error", { message: "bad request shape" })] };
		await expect(
			collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }]))),
		).rejects.toThrow("bad request shape");
	});

	it("401 teaches imp login", async () => {
		script = { status: 401, chunks: [] };
		await expect(
			collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }]))),
		).rejects.toThrow(/imp login/);
	});

	it("abort mid-stream: no throw, no message_end", async () => {
		script = {
			status: 200,
			chunks: [
				sse("response.output_item.added", { output_index: 0, item: { type: "message" } }),
				sse("response.output_text.delta", { output_index: 0, delta: "partial" }),
			],
			hold: true,
		};
		const controller = new AbortController();
		const events: Array<{ type: string }> = [];
		await (async () => {
			for await (const e of provider().stream({
				...REQ("gpt-5.5", [{ role: "user", content: "hi" }]),
				signal: controller.signal,
			})) {
				events.push(e as { type: string });
				if (e.type === "text_delta") controller.abort();
			}
		})();
		expect(events.some((e) => e.type === "message_end")).toBe(false);
	});

	it("an empty turn synthesizes an (empty) text block", async () => {
		script = {
			status: 200,
			chunks: [
				sse("response.completed", {
					response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
				}),
			],
		};
		const events = await collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }])));
		expect(lastMessage(events).blocks).toEqual([{ type: "text", text: "(empty)" }]);
	});

	describe("codex responses thinking", () => {
		it("a level rides the body as reasoning {effort}; off sends none", async () => {
			script = {
				status: 200,
				chunks: [
					sse("response.created", { response: { id: "resp_1" } }),
					sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1" } }),
					sse("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1" } }),
					sse("response.completed", {
						response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
					}),
				],
			};
			await collect(
				provider().stream({ ...REQ("gpt-5.5", [{ role: "user", content: "hi" }]), thinking: "low" }),
			);
			expect(captured.at(-1)?.body.reasoning).toEqual({ effort: "low", summary: "auto" });
			await collect(provider().stream(REQ("gpt-5.5", [{ role: "user", content: "hi" }])));
			expect(captured.at(-1)?.body.reasoning).toBeUndefined();
		});

		it('off → reasoning {effort:"none"} — the backend defaults to medium, omission is NOT off (pi :240)', async () => {
			script = {
				status: 200,
				chunks: [
					sse("response.completed", {
						response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
					}),
				],
			};
			await collect(
				provider().stream({ ...REQ("gpt-5.5", [{ role: "user", content: "hi" }]), thinking: "off" }),
			);
			expect(captured.at(-1)?.body.reasoning).toEqual({ effort: "none" });
		});

		it("pi.dev maps: gpt-5.5 minimal→low + xhigh native; gpt-6-astra off unavailable (clamps up), minimal→low, max native", async () => {
			script = {
				status: 200,
				chunks: [
					sse("response.completed", {
						response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
					}),
				],
			};
			await collect(
				provider().stream({ ...REQ("gpt-5.5", [{ role: "user", content: "hi" }]), thinking: "minimal" }),
			);
			expect(captured.at(-1)?.body.reasoning).toEqual({ effort: "low", summary: "auto" });
			await collect(
				provider().stream({ ...REQ("gpt-6-astra", [{ role: "user", content: "hi" }]), thinking: "off" }),
			);
			// off:null in pi.dev's map — clampThinkingLevel moves it UP to minimal, which maps to "low"
			expect(captured.at(-1)?.body.reasoning).toEqual({ effort: "low", summary: "auto" });
			await collect(
				provider().stream({ ...REQ("gpt-6-astra", [{ role: "user", content: "hi" }]), thinking: "max" }),
			);
			expect(captured.at(-1)?.body.reasoning).toEqual({ effort: "max", summary: "auto" });
		});
	});
});

describe("contextWindowFor registry", () => {
	it("table lookups strip the prefix; env wins; unknown falls back", async () => {
		const { contextWindowFor, DEFAULT_CONTEXT_WINDOW } = await import("../src/provider/models.js");
		expect(contextWindowFor("gpt-5.5")).toBe(272_000);
		expect(contextWindowFor("openai-codex/gpt-5.5")).toBe(272_000);
		expect(contextWindowFor("glm-4.6")).toBe(200_000);
		expect(contextWindowFor("claude-sonnet-4-5")).toBe(1_000_000);
		expect(contextWindowFor("mystery-model")).toBe(DEFAULT_CONTEXT_WINDOW);
		// z.ai current line (static sync from the pi.dev zai catalog)
		expect(contextWindowFor("glm-5.3")).toBe(1_000_000);
		expect(contextWindowFor("glm-5.3-flash")).toBe(1_000_000);
		// runtime enrichment OVERRANKS the static table: discovery metadata for a
		// brand-new id (not in any table) becomes effective immediately
		const { registerDiscoveredContextWindows, resetDiscoveredWindowsForTest } = await import(
			"../src/provider/discover.js"
		);
		resetDiscoveredWindowsForTest();
		registerDiscoveredContextWindows({ "gpt-7-nova": 400_000, "glm-4.6": 123_456 });
		expect(contextWindowFor("gpt-7-nova")).toBe(400_000);
		expect(contextWindowFor("glm-4.6")).toBe(123_456); // discovery wins over the table
		expect(contextWindowFor("openai-codex/gpt-7-nova")).toBe(400_000); // prefix-stripped
		resetDiscoveredWindowsForTest();
		expect(contextWindowFor("glm-4.6")).toBe(200_000); // back to the table
		const prev = process.env.IMP_CONTEXT_WINDOW;
		process.env.IMP_CONTEXT_WINDOW = "999";
		expect(contextWindowFor("gpt-5.5")).toBe(999);
		if (prev === undefined) delete process.env.IMP_CONTEXT_WINDOW;
		else process.env.IMP_CONTEXT_WINDOW = prev;
	});
});

// ── #thinking-levels: the reasoning object ──────────────────────────────
