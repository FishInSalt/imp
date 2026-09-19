import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverModels, familyConfigured } from "../src/provider/discover.js";
import { parseModelRef, resolveModel } from "../src/provider/resolve.js";
import { type ThinkingLevel, thinkingMetaFor } from "../src/provider/thinking.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";
import { createZaiProvider, ZAI_DEFAULT_BASE_URL, ZAI_SEED_MODELS } from "../src/provider/zai.js";

async function collect(events: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
	const out: LLMEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}
function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

let baseUrl = "";
let server: import("node:http").Server | null = null;
let auth: string | undefined;
let urlPath = "";
const captured: Array<Record<string, unknown>> = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			auth = req.headers.authorization;
			urlPath = req.url ?? "";
			captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(sse({ choices: [{ delta: { role: "assistant" } }] }));
			res.write(sse({ choices: [{ delta: { content: "ok" } }] }));
			res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server?.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function REQ(model: string, thinking?: ThinkingLevel): LLMRequest {
	return {
		system: "sys",
		messages: [{ role: "user", content: "hi" }],
		tools: [
			{
				name: "read",
				description: "d",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ output: "" }),
			},
		],
		model,
		maxTokens: 1024,
		thinking,
	};
}

describe("zai provider (pi's GLM connection path)", () => {
	it("parseModelRef routes zai/<id>; resolveModel builds the zai family", () => {
		expect(parseModelRef("zai/glm-5.3")).toEqual({ provider: "zai", modelId: "glm-5.3" });
		const resolved = resolveModel("zai/glm-5.3");
		expect(resolved.provider.name).toBe("zai");
		expect(resolved.modelId).toBe("glm-5.3");
	});

	it("familyConfigured follows ZAI_API_KEY; the GLM thinking ladder applies under the zai name", () => {
		const prev = process.env.ZAI_API_KEY;
		try {
			delete process.env.ZAI_API_KEY;
			expect(familyConfigured("zai")).toBe(false);
			process.env.ZAI_API_KEY = "sk-test";
			expect(familyConfigured("zai")).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prev;
		}
		// pi.dev live glm-5.3 ladder: low/high/max, off IMPOSSIBLE
		expect(thinkingMetaFor("zai", "glm-5.3")?.style).toBe("glm-openai");
	});

	it("wire: ZAI bearer, tool_stream, zai thinking object, max_tokens field", async () => {
		process.env.ZAI_BASE_URL = baseUrl;
		process.env.ZAI_API_KEY = "sk-zai";
		try {
			const provider = createZaiProvider();
			await collect(provider.stream(REQ("glm-5.3", "low")));
			expect(urlPath).toBe("/chat/completions");
			expect(auth).toBe("Bearer sk-zai");
			const body = captured[0];
			if (!body) throw new Error("no request captured");
			expect(body.tool_stream).toBe(true); // pi compat.zaiToolStream
			expect(body.max_tokens).toBe(1024); // zai takes max_tokens, not max_completion_tokens
			expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(body.reasoning_effort).toBe("low"); // native low on 5.3 (pi.dev map)
			// off is UNAVAILABLE on glm-5.3 — clamps up to low, never disables
			await collect(provider.stream(REQ("glm-5.3", "off")));
			expect(captured.at(-1)?.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(captured.at(-1)?.reasoning_effort).toBe("low");
		} finally {
			delete process.env.ZAI_BASE_URL;
			delete process.env.ZAI_API_KEY;
		}
	});

	it("discovery: unreachable /models falls back to the pi.dev seeds; a configured family resolves them", async () => {
		const prevKey = process.env.ZAI_API_KEY;
		const prevUrl = process.env.ZAI_BASE_URL;
		try {
			process.env.ZAI_API_KEY = "sk-test";
			process.env.ZAI_BASE_URL = "http://127.0.0.1:1"; // nothing listens — immediate refusal
			const ids = await discoverModels("zai");
			expect(ids).toEqual([...ZAI_SEED_MODELS]);
		} finally {
			if (prevKey === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prevKey;
			if (prevUrl === undefined) delete process.env.ZAI_BASE_URL;
			else process.env.ZAI_BASE_URL = prevUrl;
		}
	});

	it("ZAI_DEFAULT_BASE_URL is pi's coding endpoint; seeds mirror pi.dev's live catalog", () => {
		expect(ZAI_DEFAULT_BASE_URL).toBe("https://api.z.ai/api/coding/paas/v4");
		expect(ZAI_SEED_MODELS).toContain("glm-5.3");
		expect(ZAI_SEED_MODELS).toContain("glm-5.2-highspeed");
	});
});
