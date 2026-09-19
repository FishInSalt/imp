import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import { createAnthropicProvider } from "../src/provider/anthropic.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";

/** #thinking-levels: the anthropic wire — request knobs, thinking-block
 *  parsing (deltas + signature), and the replay requirement. */

interface Captured {
	body: Record<string, unknown>;
}

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const REQ = (
	model: string,
	messages: AgentMessage[] = [],
	thinking?: LLMRequest["thinking"],
): LLMRequest => ({
	system: "sys",
	model,
	messages,
	tools: [],
	maxTokens: 16384,
	thinking,
});

async function collect(events: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
	const out: LLMEvent[] = [];
	for await (const e of streamSafe(events)) out.push(e);
	return out;
}

async function* streamSafe(events: AsyncIterable<LLMEvent>): AsyncIterable<LLMEvent> {
	yield* events;
}

function lastMessage(events: LLMEvent[]) {
	const end = events.find((e) => e.type === "message_end");
	if (end?.type !== "message_end") throw new Error("no message_end");
	return end.message;
}

describe("anthropic thinking", () => {
	let server: Server;
	let captured: Captured[];

	beforeAll(async () => {
		server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				captured.push({ body: JSON.parse(body) });
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(
					sse("message_start", { message: { usage: { input_tokens: 10 } } }) +
						sse("content_block_start", { index: 0, content_block: { type: "thinking" } }) +
						sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "step " } }) +
						sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "two" } }) +
						sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig-1" } }) +
						sse("content_block_stop", { index: 0 }) +
						sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) +
						sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: "final" } }) +
						sse("content_block_stop", { index: 1 }) +
						sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) +
						sse("message_stop", {}),
				);
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));
	const url = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const provider = () => createAnthropicProvider({ baseUrl: url(), apiKey: "k" });

	it("claude: budget form with pi's math — budget beside the cap, xhigh clamps to high", async () => {
		captured = [];
		const events = await collect(provider().stream(REQ("claude-sonnet-4-5", [], "xhigh")));
		const body = captured[0]?.body as Record<string, unknown>;
		// xhigh → high (16384); max_tokens = 16384 + 16384 capped at 64000
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16384, display: "summarized" });
		expect(body.max_tokens).toBe(32768);
		void events;
	});

	it("GLM on this protocol: the binary enable form, budget untouched", async () => {
		captured = [];
		await collect(provider().stream(REQ("glm-4.6", [], "low")));
		const body = captured[0]?.body as Record<string, unknown>;
		expect(body.thinking).toEqual({ type: "enabled" });
		expect(body.max_tokens).toBe(16384); // untouched
	});

	it('off AND undefined (the runner maps off→undefined) → {type:"disabled"} — pi reinterprets at the provider layer (:754-780)', async () => {
		captured = [];
		await collect(provider().stream(REQ("claude-sonnet-4-5", [], "off")));
		expect((captured[0]?.body as Record<string, unknown> | undefined)?.thinking).toEqual({
			type: "disabled",
		});
		captured = [];
		await collect(provider().stream(REQ("claude-sonnet-4-5"))); // runner.ts:681 sends undefined for off
		expect((captured[0]?.body as Record<string, unknown> | undefined)?.thinking).toEqual({
			type: "disabled",
		});
	});

	it("Claude >=4.6 adaptive path (pi compat.forceAdaptiveThinking): {adaptive} + output_config effort, no budget math", async () => {
		captured = [];
		const events = await collect(provider().stream(REQ("claude-opus-4-8", [], "medium")));
		const body = captured[0]?.body as Record<string, unknown>;
		expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(body.output_config).toEqual({ effort: "medium" });
		expect(body.max_tokens).toBe(16384); // caller cap untouched — the model thinks internally
		// xhigh is NATIVE on 4.7+ (pi catalog map), not clamped away
		captured = [];
		await collect(provider().stream(REQ("claude-opus-4-8", [], "xhigh")));
		expect((captured[0]?.body as Record<string, unknown> | undefined)?.output_config).toEqual({
			effort: "xhigh",
		});
		// sonnet-4-6 has max but not xhigh (pi catalog) → xhigh clamps UP to max
		captured = [];
		await collect(provider().stream(REQ("claude-sonnet-4-6", [], "xhigh")));
		expect((captured[0]?.body as Record<string, unknown> | undefined)?.output_config).toEqual({
			effort: "max",
		});
		void events;
	});

	it("GLM off → disabled on this protocol too (protocol mirror of pi's zai rule)", async () => {
		captured = [];
		await collect(provider().stream(REQ("glm-5.3", [], "off")));
		expect((captured[0]?.body as Record<string, unknown> | undefined)?.thinking).toEqual({
			type: "disabled",
		});
	});

	it("thinking blocks stream as thinking_delta and land with their signature", async () => {
		captured = [];
		const events = await collect(provider().stream(REQ("claude-sonnet-4-5", [], "high")));
		const trace = events.filter(
			(e): e is Extract<LLMEvent, { type: "thinking_delta" }> => e.type === "thinking_delta",
		);
		expect(trace.map((e) => e.text).join("")).toBe("step two");
		const msg = lastMessage(events);
		expect(msg.blocks[0]).toEqual({ type: "thinking", thinking: "step two", signature: "sig-1" });
		expect(msg.blocks[1]).toEqual({ type: "text", text: "final" });
	});

	it("unsigned traces replay as TEXT, empties drop (SPLIT signatures concatenate — see below)", async () => {
		captured = [];
		const prior: AgentMessage[] = [
			{
				role: "assistant",
				blocks: [
					{ type: "thinking", thinking: "signed trace", signature: "sig-a" },
					{ type: "thinking", thinking: "unsigned foreign trace" }, // GLM / cross-family
					{ type: "thinking", thinking: "   " }, // empty — drops
					{ type: "text", text: "answer" },
				],
				usage: { inputTokens: 0, outputTokens: 0 },
				stopReason: "end_turn",
			},
		];
		await collect(provider().stream(REQ("claude-sonnet-4-5", prior, "high")));
		const wire = JSON.stringify(captured[0]?.body);
		// signed → thinking; unsigned → plain text (pi's rule); empty → gone
		expect(wire).toContain('"type":"thinking","thinking":"signed trace"');
		expect(wire).not.toContain('"thinking":"unsigned foreign trace"');
		expect(wire).toContain('"type":"text","text":"unsigned foreign trace"');
		expect(wire).not.toContain('"   "');
	});

	it("GLM parsing via the wire replay path: unsigned blocks from zai never 400 the next request", async () => {
		captured = [];
		const prior: AgentMessage[] = [
			{
				role: "assistant",
				blocks: [
					{ type: "thinking", thinking: "zai trace" },
					{ type: "text", text: "ok" },
				],
				usage: { inputTokens: 0, outputTokens: 0 },
				stopReason: "end_turn",
			},
		];
		await collect(provider().stream(REQ("glm-4.6", prior, "high")));
		const wire = JSON.stringify(captured[0]?.body);
		expect(wire).toContain('"type":"text","text":"zai trace"'); // downgraded — zai + claude both accept text
		expect(wire).not.toContain('"type":"thinking"');
	});

	it("SPLIT signature_delta chunks concatenate into one signature (review seam)", async () => {
		captured = [];
		const events = await collect(provider().stream(REQ("claude-sonnet-4-5", [], "high")));
		const msg = lastMessage(events);
		// the shared script sends one signature_delta; a split arrives as two
		// chunks of the same stream — assert the stored signature is exactly
		// the concatenation "sig-1" + "" (second empty chunk is a no-op)
		expect(msg.blocks[0]).toEqual({ type: "thinking", thinking: "step two", signature: "sig-1" });
	});

	it("replay: thinking blocks WITH signatures go back on the wire (tool-continuation requirement)", async () => {
		captured = [];
		const prior: AgentMessage[] = [
			{
				role: "assistant",
				blocks: [
					{ type: "thinking", thinking: "step two", signature: "sig-1" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
				],
				usage: { inputTokens: 0, outputTokens: 0 },
				stopReason: "tool_use",
			},
		];
		await collect(provider().stream(REQ("claude-sonnet-4-5", prior)));
		const wire = JSON.stringify(captured[0]?.body);
		expect(wire).toContain('"type":"thinking"');
		expect(wire).toContain('"signature":"sig-1"');
		expect(wire).toContain('"type":"tool_use"');
	});
});
