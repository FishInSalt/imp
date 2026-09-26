import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AgentMessage, type AssistantBlock, emptyUsage } from "../src/core/messages.js";
import { clearApiKey, saveApiKey } from "../src/provider/auth-store.js";
import { CATALOG_FAMILIES, loadCatalogCache, resetCatalogForTest } from "../src/provider/catalog.js";
import {
	createDeepSeekProvider,
	DEEPSEEK_DEFAULT_BASE_URL,
	DEEPSEEK_SEED_MODELS,
	deepseekApiKey,
} from "../src/provider/deepseek.js";
import { discoverModels, familyConfigured } from "../src/provider/discover.js";
import { contextWindowInfoFor, costFor } from "../src/provider/models.js";
import { createProviderFor, parseModelRef, resolveModel } from "../src/provider/resolve.js";
import { thinkingMetaFor } from "../src/provider/thinking.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";
import { modelSupportsVision } from "../src/provider/vision.js";
import { buildModelList, loginTargetFor } from "../src/repl/commands.js";

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
			// DeepSeek live shape (2026-09-26): usage is PRESENT but null on
			// interim chunks — a null-blind consumer crashes here
			res.write(sse({ choices: [{ delta: { reasoning_content: "pondering" } }], usage: null }));
			res.write(sse({ choices: [{ delta: { content: "ok" } }] }));
			res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
			res.write(
				sse({
					choices: [],
					usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 30 } },
				}),
			);
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

const envBackup: Array<[string, string | undefined]> = [];
const savedCatalogPath = process.env.IMP_CATALOG_PATH;
function setEnv(name: string, value: string | undefined): void {
	envBackup.push([name, process.env[name]]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
afterEach(() => {
	for (const [name, value] of envBackup.splice(0)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (savedCatalogPath === undefined) delete process.env.IMP_CATALOG_PATH;
	else process.env.IMP_CATALOG_PATH = savedCatalogPath;
	resetCatalogForTest(); // the disk overlay must not leak into the next test
});

/** Disk-inject a catalog overlay for one family (the model-catalog.test.ts
 *  pattern — there is no direct overlay API by design). */
function overlayCatalog(models: Record<string, object>): void {
	if (process.env.IMP_CATALOG_PATH === undefined) {
		// lazily point at a temp file (path recorded in envBackup for restore)
		process.env.IMP_CATALOG_PATH = path.join(tmpdir(), `imp-ds-catalog-${Date.now()}.json`);
		envBackup.push(["IMP_CATALOG_PATH", undefined]);
	}
	writeFileSync(
		process.env.IMP_CATALOG_PATH as string,
		JSON.stringify({ version: 1, providers: { deepseek: { models, checkedAt: Date.now() } } }),
		"utf-8",
	);
	loadCatalogCache();
}

function REQ(model: string, thinking?: LLMRequest["thinking"], messages?: AgentMessage[]): LLMRequest {
	return {
		system: "sys",
		messages: messages ?? [{ role: "user", content: "hi" }],
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

function assistantWithThinking(): AgentMessage {
	const blocks: AssistantBlock[] = [
		{ type: "thinking", thinking: "step one" },
		{ type: "text", text: "answer body" },
		{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
	];
	return { role: "assistant", blocks, usage: emptyUsage(), stopReason: "tool_use" };
}

describe("deepseek provider (#deepseek-provider)", () => {
	it("1. routing: deepseek/<id> resolves to the family; a bare deepseek-* id stays anthropic", () => {
		expect(parseModelRef("deepseek/deepseek-v4-pro")).toEqual({
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
		});
		const resolved = resolveModel("deepseek/deepseek-v4-pro");
		expect(resolved.provider.name).toBe("deepseek");
		expect(resolved.modelId).toBe("deepseek-v4-pro");
		// non-goal pin: NO bare-id routing (the glm- special case is zai-only)
		expect(parseModelRef("deepseek-chat")).toEqual({ provider: "anthropic", modelId: "deepseek-chat" });
	});

	it("2. key resolution: stored > DEEPSEEK_API_KEY; no-key names the deepseek env var, never OPENAI_API_KEY", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-ds-"));
		const authPath = path.join(dir, "auth.json");
		setEnv("IMP_AUTH_PATH", authPath);
		setEnv("DEEPSEEK_API_KEY", "sk-env-ds");
		setEnv("OPENAI_API_KEY", "sk-env-openai");
		expect(deepseekApiKey()).toBe("sk-env-ds");
		saveApiKey("deepseek", "sk-stored-ds", authPath);
		expect(deepseekApiKey()).toBe("sk-stored-ds"); // stored wins
		expect(familyConfigured("deepseek")).toBe(true);
		// the no-key error names the family's own var — the OPENAI_API_KEY
		// fallback must never lend its key to api.deepseek.com (design §2.5).
		// Point the endpoint at the local server so a resolution bug would
		// surface as a WIRE call with the wrong key, not a real-network 401.
		setEnv("DEEPSEEK_BASE_URL", baseUrl);
		setEnv("DEEPSEEK_API_KEY", undefined);
		clearApiKey("deepseek", authPath);
		const provider = createProviderFor("deepseek");
		await expect(collect(provider.stream(REQ("deepseek-v4-pro")))).rejects.toThrow(/DEEPSEEK_API_KEY/);
	});

	it("3a. wire: bearer, /chat/completions, NO tool_stream, max_tokens field, no store", async () => {
		setEnv("DEEPSEEK_BASE_URL", baseUrl);
		setEnv("DEEPSEEK_API_KEY", "sk-ds");
		const provider = createDeepSeekProvider();
		await collect(provider.stream(REQ("deepseek-v4-pro", "high")));
		expect(urlPath).toBe("/chat/completions");
		expect(auth).toBe("Bearer sk-ds");
		const body = captured.at(-1);
		if (!body) throw new Error("no request captured");
		expect(body.tool_stream).toBeUndefined(); // parity #10: zai-only dialect
		expect(body.max_tokens).toBe(1024); // parity #3
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.store).toBeUndefined(); // parity #4
		expect(body.thinking).toEqual({ type: "enabled" }); // no clear_thinking
		expect(body.reasoning_effort).toBe("high"); // map: high→"high"
		const messages = body.messages as Array<{ role: string }>;
		expect(messages[0]?.role).toBe("system"); // never developer
	});

	it("3b. thinking shapes: off→disabled; unavailable low clamps up; summarizer-style raw off is defended (P1-1)", async () => {
		setEnv("DEEPSEEK_BASE_URL", baseUrl);
		setEnv("DEEPSEEK_API_KEY", "sk-ds");
		const provider = createDeepSeekProvider();
		// v4-pro floor: minimal/low/medium null → ["off","high","max"]
		await collect(provider.stream(REQ("deepseek-v4-pro", "off")));
		expect(captured.at(-1)?.thinking).toEqual({ type: "disabled" });
		expect(captured.at(-1)?.reasoning_effort).toBeUndefined();
		// unavailable "low" clamps UP to high (never silently disables)
		await collect(provider.stream(REQ("deepseek-v4-pro", "low")));
		expect(captured.at(-1)?.thinking).toEqual({ type: "enabled" });
		expect(captured.at(-1)?.reasoning_effort).toBe("high");
		// P1-1: "off" arrives RAW (compaction/branch-summary pass this.level
		// as-is) — must take the disabled branch, not enabled
		await collect(provider.stream(REQ("deepseek-v4-pro", "off" as LLMRequest["thinking"])));
		expect(captured.at(-1)?.thinking).toEqual({ type: "disabled" });
	});

	it("3b-negative. levelMap off:null + undefined level → neither thinking nor reasoning_effort (pi else-if fall-through)", async () => {
		setEnv("DEEPSEEK_BASE_URL", baseUrl);
		setEnv("DEEPSEEK_API_KEY", "sk-ds");
		overlayCatalog({
			"ds-noknob": { id: "ds-noknob", reasoning: true, thinkingLevelMap: { off: null }, compat: {} },
		});
		const provider = createDeepSeekProvider();
		await collect(provider.stream(REQ("ds-noknob"))); // no thinking level
		const body = captured.at(-1);
		expect(body?.thinking).toBeUndefined();
		expect(body?.reasoning_effort).toBeUndefined();
	});

	it('3c. replay: thinking blocks ride assistant frames as reasoning_content; plain frames get "" (parity #7/#8)', async () => {
		setEnv("DEEPSEEK_BASE_URL", baseUrl);
		setEnv("DEEPSEEK_API_KEY", "sk-ds");
		const provider = createDeepSeekProvider();
		await collect(
			provider.stream(
				REQ("deepseek-v4-pro", "high", [
					{ role: "user", content: "first" },
					assistantWithThinking(),
					{
						role: "toolResult",
						results: [{ toolCallId: "tc1", toolName: "read", content: "tool output", isError: false }],
					},
					{ role: "user", content: "continue" },
				]),
			),
		);
		const body = captured.at(-1);
		const messages = body?.messages as Array<{ role: string; reasoning_content?: string }>;
		const replayed = messages.find((m) => m.role === "assistant");
		expect(replayed?.reasoning_content).toBe("step one"); // joined thinking
		// a second request with a plain assistant frame → "" (never undefined)
		await collect(
			provider.stream(
				REQ("deepseek-v4-pro", "high", [
					{ role: "user", content: "first" },
					{
						role: "assistant",
						blocks: [{ type: "text", text: "plain" }],
						usage: emptyUsage(),
						stopReason: "end_turn",
					},
					{ role: "user", content: "continue" },
				]),
			),
		);
		const lastMessages = captured.at(-1)?.messages as Array<{ role: string; reasoning_content?: string }>;
		const plain = lastMessages.find((m) => m.role === "assistant");
		expect(plain?.reasoning_content).toBe("");
		// other families: the field never appears — a REAL cross-family pin
		// (the zai request carries the same thinking-block history; its
		// assistant frame must lack reasoning_content entirely)
		const { createZaiProvider } = await import("../src/provider/zai.js");
		setEnv("ZAI_BASE_URL", baseUrl);
		setEnv("ZAI_API_KEY", "sk-zai");
		await collect(
			createZaiProvider().stream(
				REQ("glm-5.3", "low", [
					{ role: "user", content: "first" },
					assistantWithThinking(),
					{
						role: "toolResult",
						results: [{ toolCallId: "tc1", toolName: "read", content: "out", isError: false }],
					},
					{ role: "user", content: "continue" },
				]),
			),
		);
		const zaiMessages = captured.at(-1)?.messages as Array<{
			role: string;
			reasoning_content?: string;
		}>;
		const zaiAssistant = zaiMessages.find((m) => m.role === "assistant");
		expect(zaiAssistant).toBeDefined();
		expect(zaiAssistant?.reasoning_content).toBeUndefined(); // replay is deepseek-only
	});

	it("3d. reasoning deltas stream as thinking events; null interim usage doesn't crash; cache math holds (parity #9 + live shape)", async () => {
		setEnv("DEEPSEEK_BASE_URL", baseUrl);
		setEnv("DEEPSEEK_API_KEY", "sk-ds");
		const events = await collect(createDeepSeekProvider().stream(REQ("deepseek-v4-pro")));
		expect(events.some((e) => e.type === "thinking_delta" && e.text === "pondering")).toBe(true);
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		// the null interim chunk was skipped; the final usage applied with
		// the cache-hit subtraction (anthropic inputTokens convention)
		const end = events.at(-1);
		expect(end?.type).toBe("message_end");
		if (end?.type !== "message_end") return;
		expect(end.message.usage.inputTokens).toBe(70); // 100 - 30 cached
		expect(end.message.usage.cacheReadTokens).toBe(30);
		expect(end.message.usage.outputTokens).toBe(7);
	});

	it("4. thinking ladders: v4-pro [off,high,max]; flash floor [off,low,high,max]; catalog compat absent ≠ false (parity #6)", () => {
		const meta = thinkingMetaFor("deepseek", "deepseek-v4-pro");
		expect(meta?.style).toBe("deepseek");
		expect(meta?.levelMap).toMatchObject({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			max: "max",
		});
		const flash = thinkingMetaFor("deepseek", "deepseek-flash");
		expect(flash?.levelMap).toMatchObject({ low: "low", minimal: null, medium: null });
		// pi's detected default for deepseek is TRUE (zai's is false) — an
		// entry without supportsReasoningEffort still gets the knob
		overlayCatalog({ "ds-silent": { id: "ds-silent", reasoning: true, compat: {} } });
		expect(thinkingMetaFor("deepseek", "ds-silent")?.supportsEffort).toBe(true);
	});

	it("5. discovery: unreachable default endpoint → seeds; redirected DEEPSEEK_BASE_URL → null (#gateway-truth)", async () => {
		setEnv("DEEPSEEK_API_KEY", "sk-test");
		delete process.env.DEEPSEEK_BASE_URL;
		// default endpoint unreachable in tests (no network): seeds are the floor
		const ids = await discoverModels("deepseek");
		expect(ids).toEqual([...DEEPSEEK_SEED_MODELS]);
		setEnv("DEEPSEEK_BASE_URL", "http://127.0.0.1:1"); // redirected + unreachable
		expect(await discoverModels("deepseek")).toBeNull(); // no invented ids
		// configured follows the key
		setEnv("DEEPSEEK_API_KEY", undefined);
		expect(familyConfigured("deepseek")).toBe(false);
	});

	it("6. catalog: CATALOG_FAMILIES includes deepseek; an overlay entry feeds the window source", () => {
		expect(CATALOG_FAMILIES).toContain("deepseek");
		overlayCatalog({ "deepseek-v4-pro": { id: "deepseek-v4-pro", contextWindow: 123456 } });
		expect(contextWindowInfoFor("deepseek/deepseek-v4-pro")).toMatchObject({
			contextWindow: 123456,
			source: "catalog",
		});
	});

	it("7. static floor (offline): windows and costs from the pi.dev 2026-09 snapshot", () => {
		expect(contextWindowInfoFor("deepseek/deepseek-v4-pro")).toMatchObject({
			contextWindow: 1_000_000,
			source: "static",
		});
		expect(costFor("deepseek/deepseek-flash")).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.006,
			cacheWrite: 0,
		});
		expect(costFor("deepseek/deepseek-v4-pro")).toEqual({
			input: 1.32,
			output: 3.96,
			cacheRead: 0.044,
			cacheWrite: 0,
		});
	});

	it("8. vision: flash true, v4-pro false (pi.dev input lists)", () => {
		expect(modelSupportsVision("deepseek", "deepseek-flash")).toBe(true);
		expect(modelSupportsVision("deepseek", "deepseek-v4-pro")).toBe(false);
	});

	it("9. session store accepts the family; the reference keeps its prefix", async () => {
		const { SessionStore } = await import("../src/core/session/store.js");
		const dir = await mkdtemp(path.join(tmpdir(), "imp-ds-sess-"));
		const store = SessionStore.create(path.join(dir, "s.json"), dir);
		store.setModel({ provider: "deepseek", modelId: "deepseek-v4-pro" });
		expect(store.getModel()).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
	});

	it("10. /login: deepseek target resolves; unknown-provider message lists it", () => {
		const target = loginTargetFor("deepseek");
		expect(target?.family).toBe("deepseek");
		expect(target?.envVar).toBe("DEEPSEEK_API_KEY");
		expect(target?.method).toBe("api_key");
		expect(target?.switchHint).toBe("deepseek/deepseek-v4-pro");
		// case-insensitive display name too
		expect(loginTargetFor("DeepSeek")?.family).toBe("deepseek");
	});

	it("11. buildModelList: discovered ids carry the deepseek/ prefix; unreachable → fallback rows", async () => {
		const { rows } = await buildModelList("deepseek/deepseek-v4-pro", {
			configured: (f) => f === "deepseek",
			discover: async (f) => (f === "deepseek" ? ["deepseek-flash", "deepseek-v4-pro"] : null),
		});
		expect(rows.map((r) => r.label)).toEqual(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
		const { rows: failed } = await buildModelList("deepseek/deepseek-v4-pro", {
			configured: (f) => f === "deepseek",
			discover: async () => null,
		});
		expect(failed.map((r) => r.label)).toEqual(["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"]);
	});

	it("DEEPSEEK_DEFAULT_BASE_URL and seeds mirror pi.dev's live catalog", () => {
		expect(DEEPSEEK_DEFAULT_BASE_URL).toBe("https://api.deepseek.com");
		expect(DEEPSEEK_SEED_MODELS).toContain("deepseek-v4-pro");
		expect(DEEPSEEK_SEED_MODELS).toContain("deepseek-flash");
	});
});
