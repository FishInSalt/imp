import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AgentMessage, type AssistantBlock, emptyUsage } from "../src/core/messages.js";
import { clearApiKey, saveApiKey } from "../src/provider/auth-store.js";
import { CATALOG_FAMILIES, loadCatalogCache, resetCatalogForTest } from "../src/provider/catalog.js";
import { discoverModels, familyConfigured, resetDiscoveryCacheForTest } from "../src/provider/discover.js";
import { contextWindowInfoFor, costFor } from "../src/provider/models.js";
import {
	createMoonshotCnProvider,
	createMoonshotProvider,
	MOONSHOT_CN_DEFAULT_BASE_URL,
	MOONSHOT_DEFAULT_BASE_URL,
	MOONSHOT_SEED_MODELS,
	moonshotApiKey,
	moonshotCnApiKey,
} from "../src/provider/moonshotai.js";
import { createProviderFor, parseModelRef, resolveModel } from "../src/provider/resolve.js";
import { clampThinkingLevel, supportedThinkingLevels, thinkingMetaFor } from "../src/provider/thinking.js";
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
/** Per-test scripted responses; cleared in afterEach. */
let nextFrames: string[] | null = null;
let nextStatus: number | null = null;
let nextModels: string[] | null = null;

/** Moonshot/Kimi live shapes (2026-09-26): interim usage:null; the final
 *  usage chunk carries the cache-read count at the TOP level (cached_tokens),
 *  and reasoning_content deltas precede content. */
function kimiFrames(): string[] {
	return [
		sse({ choices: [{ delta: { role: "assistant" } }] }),
		sse({ choices: [{ delta: { reasoning_content: "pondering" } }], usage: null }),
		sse({ choices: [{ delta: { content: "ok" } }] }),
		sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
		sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, cached_tokens: 30 } }),
		"data: [DONE]\n\n",
	];
}

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/models" && nextModels !== null) {
			auth = req.headers.authorization;
			urlPath = req.url ?? "";
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: nextModels.map((id) => ({ id })) }));
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			auth = req.headers.authorization;
			urlPath = req.url ?? "";
			captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
			if (nextStatus !== null) {
				const status = nextStatus;
				nextStatus = null;
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "bad key" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const frame of nextFrames ?? kimiFrames()) res.write(frame);
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
	resetDiscoveryCacheForTest();
	nextFrames = null;
	nextStatus = null;
	nextModels = null;
	captured.length = 0;
});

/** Disk-inject a catalog overlay for one family (the model-catalog.test.ts
 *  pattern — there is no direct overlay API by design). */
function overlayCatalog(family: string, models: Record<string, object>): void {
	if (process.env.IMP_CATALOG_PATH === undefined) {
		process.env.IMP_CATALOG_PATH = path.join(tmpdir(), `imp-ms-catalog-${Date.now()}.json`);
		envBackup.push(["IMP_CATALOG_PATH", undefined]);
	}
	writeFileSync(
		process.env.IMP_CATALOG_PATH as string,
		JSON.stringify({ version: 1, providers: { [family]: { models, checkedAt: Date.now() } } }),
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

/** A tool-call-only assistant frame (content:null + tool_calls, no thinking)
 *  — the exact frame shape k3's fill rule bites on continuations. */
function assistantToolOnly(): AgentMessage {
	return {
		role: "assistant",
		blocks: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
		usage: emptyUsage(),
		stopReason: "tool_use",
	};
}

function assistantPlain(): AgentMessage {
	return {
		role: "assistant",
		blocks: [{ type: "text", text: "plain" }],
		usage: emptyUsage(),
		stopReason: "end_turn",
	};
}

function toolResult(): AgentMessage {
	return {
		role: "toolResult",
		results: [{ toolCallId: "tc1", toolName: "read", content: "out", isError: false }],
	};
}

describe("moonshotai provider (#moonshotai-provider)", () => {
	it("1. routing: moonshotai/ and moonshotai-cn/ resolve; a bare kimi-* id stays anthropic (non-goal pin)", () => {
		expect(parseModelRef("moonshotai/kimi-k3")).toEqual({ provider: "moonshotai", modelId: "kimi-k3" });
		expect(parseModelRef("moonshotai-cn/kimi-k2.6")).toEqual({
			provider: "moonshotai-cn",
			modelId: "kimi-k2.6",
		});
		const resolved = resolveModel("moonshotai-cn/kimi-k3");
		expect(resolved.provider.name).toBe("moonshotai-cn");
		expect(resolved.modelId).toBe("kimi-k3");
		expect(createProviderFor("moonshotai").name).toBe("moonshotai");
		// non-goal pin: NO bare-id routing (the glm- special case is zai-only)
		expect(parseModelRef("kimi-k3")).toEqual({ provider: "anthropic", modelId: "kimi-k3" });
	});

	it("2. key resolution: stored > env, per-family isolation, one env configures both; no-key names MOONSHOT_API_KEY only", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-ms-"));
		const authPath = path.join(dir, "auth.json");
		setEnv("IMP_AUTH_PATH", authPath);
		setEnv("MOONSHOT_API_KEY", "sk-env-moonshot");
		setEnv("OPENAI_API_KEY", "sk-env-openai");
		expect(moonshotApiKey()).toBe("sk-env-moonshot");
		expect(moonshotCnApiKey()).toBe("sk-env-moonshot"); // one env var, both families
		expect(familyConfigured("moonshotai")).toBe(true);
		expect(familyConfigured("moonshotai-cn")).toBe(true);
		// stored keys are per family: logging into -cn must not shadow the .ai env
		saveApiKey("moonshotai-cn", "sk-stored-cn", authPath);
		expect(moonshotCnApiKey()).toBe("sk-stored-cn"); // stored wins
		expect(moonshotApiKey()).toBe("sk-env-moonshot"); // other family untouched
		// familyConfigured must key off the PER-FAMILY resolution (the review
		// round's mutation gap: the cn case using moonshotApiKey() slipped
		// through every other test)
		setEnv("MOONSHOT_API_KEY", undefined);
		clearApiKey("moonshotai-cn", authPath);
		saveApiKey("moonshotai", "sk-only-ai", authPath);
		expect(familyConfigured("moonshotai")).toBe(true);
		expect(familyConfigured("moonshotai-cn")).toBe(false);
		clearApiKey("moonshotai", authPath);
		saveApiKey("moonshotai-cn", "sk-only-cn", authPath);
		expect(familyConfigured("moonshotai")).toBe(false);
		expect(familyConfigured("moonshotai-cn")).toBe(true);
		// the no-key error names the family's own var — the OPENAI_API_KEY
		// fallback must never lend its key to api.moonshot.* (design §2.2)
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", undefined);
		clearApiKey("moonshotai-cn", authPath);
		const provider = createProviderFor("moonshotai");
		let message = "";
		try {
			await collect(provider.stream(REQ("kimi-k3")));
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).toContain("MOONSHOT_API_KEY");
		expect(message).not.toContain("OPENAI_API_KEY");
	});

	it("3a. wire: k2.6 high → thinking enabled (no reasoning_effort), max_tokens field, no store, Bearer", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		await collect(createMoonshotProvider().stream(REQ("kimi-k2.6", "high")));
		expect(urlPath).toBe("/chat/completions");
		expect(auth).toBe("Bearer sk-ms");
		const body = captured.at(-1);
		if (!body) throw new Error("no request captured");
		expect(body.max_tokens).toBe(1024); // parity #4
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.store).toBeUndefined(); // parity #3
		expect(body.thinking).toEqual({ type: "enabled" });
		expect(body.reasoning_effort).toBeUndefined(); // parity #5: effort default false
		const messages = body.messages as Array<{ role: string }>;
		expect(messages[0]?.role).toBe("system"); // never developer
	});

	it("3b. k2.6 explicit off (raw and undefined) → thinking disabled", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		const provider = createMoonshotProvider();
		await collect(provider.stream(REQ("kimi-k2.6", "off")));
		expect(captured.at(-1)?.thinking).toEqual({ type: "disabled" });
		expect(captured.at(-1)?.reasoning_effort).toBeUndefined();
		// main-path off arrives as undefined (runner :1042) — same result
		await collect(provider.stream(REQ("kimi-k2.6")));
		expect(captured.at(-1)?.thinking).toEqual({ type: "disabled" });
	});

	it("3c. k2.7-code: selected level → thinking enabled; off clamps UP (never disabled); undefined → nothing", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		const provider = createMoonshotProvider();
		await collect(provider.stream(REQ("kimi-k2.7-code", "high")));
		expect(captured.at(-1)?.thinking).toEqual({ type: "enabled" });
		expect(captured.at(-1)?.reasoning_effort).toBeUndefined();
		// off:null — "off" clamps to minimal (never a disabled attempt, the
		// docs forbid it and imp never silently disables)
		await collect(provider.stream(REQ("kimi-k2.7-code", "off")));
		expect(captured.at(-1)?.thinking).toEqual({ type: "enabled" });
		// negative space: no level at all → neither field (pi else-if fall-through)
		await collect(provider.stream(REQ("kimi-k2.7-code")));
		expect(captured.at(-1)?.thinking).toBeUndefined();
		expect(captured.at(-1)?.reasoning_effort).toBeUndefined();
	});

	it("3d. k3: reasoning_effort ladder, NEVER a thinking key; off clamps to low; undefined → nothing", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		const provider = createMoonshotProvider();
		for (const level of ["low", "high", "max"] as const) {
			await collect(provider.stream(REQ("kimi-k3", level)));
			expect(captured.at(-1)?.reasoning_effort).toBe(level);
			expect(captured.at(-1)?.thinking).toBeUndefined(); // the docs forbid it on k3
		}
		await collect(provider.stream(REQ("kimi-k3", "off")));
		expect(captured.at(-1)?.reasoning_effort).toBe("low"); // clamp off → low
		expect(captured.at(-1)?.thinking).toBeUndefined();
		await collect(provider.stream(REQ("kimi-k3")));
		expect(captured.at(-1)?.reasoning_effort).toBeUndefined();
		expect(captured.at(-1)?.thinking).toBeUndefined();
	});

	it('3e. replay: k3 fills bare frames (incl. tool-call-only) with ""; k2.6 leaves them keyless; text replays for both', async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		const provider = createMoonshotProvider();
		const thinkingHistory = (): AgentMessage[] => [
			{ role: "user", content: "first" },
			assistantWithThinking(),
			toolResult(),
			{ role: "user", content: "continue" },
		];
		const plainHistory = (): AgentMessage[] => [
			{ role: "user", content: "first" },
			assistantPlain(),
			{ role: "user", content: "continue" },
		];
		const toolOnlyHistory = (): AgentMessage[] => [
			{ role: "user", content: "first" },
			assistantToolOnly(),
			toolResult(),
			{ role: "user", content: "continue" },
		];
		const assistantOf = (body: Record<string, unknown> | undefined) => {
			const messages = body?.messages as
				| Array<{ role: string; content?: string | null; reasoning_content?: string }>
				| undefined;
			return messages?.find((m) => m.role === "assistant");
		};
		// k3: non-empty thinking text replays
		await collect(provider.stream(REQ("kimi-k3", "high", thinkingHistory())));
		expect(assistantOf(captured.at(-1))?.reasoning_content).toBe("step one");
		// k3: bare plain frame → "" (the compat fill)
		await collect(provider.stream(REQ("kimi-k3", "high", plainHistory())));
		expect(assistantOf(captured.at(-1))?.reasoning_content).toBe("");
		// k3: tool-call-only frame (content:null + tool_calls) → "" too
		await collect(provider.stream(REQ("kimi-k3", "high", toolOnlyHistory())));
		const k3ToolOnly = assistantOf(captured.at(-1));
		expect(k3ToolOnly?.content).toBe(null);
		expect(k3ToolOnly?.reasoning_content).toBe("");
		// k2.6: text replays, but bare frames carry NO key (fill only for k3)
		await collect(provider.stream(REQ("kimi-k2.6", "high", thinkingHistory())));
		expect(assistantOf(captured.at(-1))?.reasoning_content).toBe("step one");
		await collect(provider.stream(REQ("kimi-k2.6", "high", plainHistory())));
		expect(assistantOf(captured.at(-1))?.reasoning_content).toBeUndefined();
		await collect(provider.stream(REQ("kimi-k2.6", "high", toolOnlyHistory())));
		expect(assistantOf(captured.at(-1))?.reasoning_content).toBeUndefined();
		// cross-switch: the gate keys off the CURRENT request model (pi :1697-1698)
		await collect(provider.stream(REQ("kimi-k3", "high", plainHistory())));
		expect(assistantOf(captured.at(-1))?.reasoning_content).toBe("");
	});

	it("3f. usage: top-level cached_tokens counted (Kimi shape); choice.usage fallback; null interim guard", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		const provider = createMoonshotProvider();
		const events = await collect(provider.stream(REQ("kimi-k2.6", "high")));
		// reasoning deltas stream as thinking events (existing path)
		expect(events.some((e) => e.type === "thinking_delta" && e.text === "pondering")).toBe(true);
		const end = events.at(-1);
		expect(end?.type).toBe("message_end");
		if (end?.type !== "message_end") return;
		expect(end.message.usage.inputTokens).toBe(70); // 100 − 30 (top-level cached)
		expect(end.message.usage.cacheReadTokens).toBe(30);
		expect(end.message.usage.outputTokens).toBe(7);
		// Moonshot's other documented placement: usage rides the CHOICE
		nextFrames = [
			sse({ choices: [{ delta: { content: "ok" } }] }),
			sse({
				choices: [
					{
						delta: {},
						finish_reason: "stop",
						usage: { prompt_tokens: 50, completion_tokens: 5, cached_tokens: 10 },
					},
				],
			}),
			"data: [DONE]\n\n",
		];
		const events2 = await collect(provider.stream(REQ("kimi-k2.6", "high")));
		const end2 = events2.at(-1);
		expect(end2?.type).toBe("message_end");
		if (end2?.type !== "message_end") return;
		expect(end2.message.usage.inputTokens).toBe(40);
		expect(end2.message.usage.cacheReadTokens).toBe(10);
		expect(end2.message.usage.outputTokens).toBe(5);
	});

	it("3h. 401 hint names the family's own env var (family-aware, deepseek included)", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-bad");
		nextStatus = 401;
		let message = "";
		try {
			await collect(createMoonshotProvider().stream(REQ("kimi-k3", "high")));
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).toContain("check MOONSHOT_API_KEY");
		expect(message).not.toContain("check OPENAI_API_KEY");
		// the same hint serves deepseek now that it passes `auth` (review P2-1)
		setEnv("DEEPSEEK_BASE_URL", baseUrl);
		setEnv("DEEPSEEK_API_KEY", "sk-bad");
		nextStatus = 401;
		let dsMessage = "";
		try {
			await collect(createProviderFor("deepseek").stream(REQ("deepseek-v4-pro", "high")));
		} catch (e) {
			dsMessage = e instanceof Error ? e.message : String(e);
		}
		expect(dsMessage).toContain("check DEEPSEEK_API_KEY");
		expect(dsMessage).not.toContain("check OPENAI_API_KEY");
	});

	it("4. thinking ladders + default chain (clamp medium); floor rules for both families", () => {
		const k26 = thinkingMetaFor("moonshotai", "kimi-k2.6");
		expect(k26?.style).toBe("deepseek");
		expect(supportedThinkingLevels(k26)).toEqual(["off", "high"]);
		expect(clampThinkingLevel(k26, "medium")).toBe("high"); // startup chain runner :387-390
		const k27 = thinkingMetaFor("moonshotai", "kimi-k2.7-code");
		expect(k27?.style).toBe("deepseek");
		expect(k27?.supportsEffort).toBe(false);
		expect(supportedThinkingLevels(k27)).toEqual(["minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(k27, "off")).toBe("minimal"); // never disabled
		expect(thinkingMetaFor("moonshotai", "kimi-k2.7-code-highspeed")?.levelMap?.off).toBeNull();
		const k3 = thinkingMetaFor("moonshotai", "kimi-k3");
		expect(k3?.style).toBe("openai-effort");
		expect(k3?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(supportedThinkingLevels(k3)).toEqual(["low", "high", "max"]);
		expect(clampThinkingLevel(k3, "medium")).toBe("high");
		// the cn family shares the floor rules (same prefixes)
		expect(thinkingMetaFor("moonshotai-cn", "kimi-k3")?.style).toBe("openai-effort");
		expect(thinkingMetaFor("moonshotai-cn", "kimi-k2.7-code")?.levelMap?.off).toBeNull();
	});

	it("4b. catalog drives the style: an overlay with thinkingFormat openai flips k2.6 to effort + fill", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		overlayCatalog("moonshotai", {
			"kimi-k2.6": {
				id: "kimi-k2.6",
				reasoning: true,
				compat: {
					thinkingFormat: "openai",
					supportsReasoningEffort: true,
					requiresReasoningContentOnAssistantMessages: true,
				},
			},
		});
		await collect(
			createMoonshotProvider().stream(
				REQ("kimi-k2.6", "high", [
					{ role: "user", content: "first" },
					assistantPlain(),
					{ role: "user", content: "continue" },
				]),
			),
		);
		const body = captured.at(-1);
		expect(body?.reasoning_effort).toBe("high"); // openai-effort style
		expect(body?.thinking).toBeUndefined();
		const messages = body?.messages as Array<{ role: string; reasoning_content?: string }> | undefined;
		const assistant = messages?.find((m) => m.role === "assistant");
		expect(assistant?.reasoning_content).toBe(""); // the overlay's compat flag
	});

	it("4c. supportsEffort anchor: deepseek-compat without the flag → false (=== true; opposite of deepseek's !== false)", () => {
		overlayCatalog("moonshotai", {
			"kimi-silent": { id: "kimi-silent", reasoning: true, compat: { thinkingFormat: "deepseek" } },
		});
		expect(thinkingMetaFor("moonshotai", "kimi-silent")?.supportsEffort).toBe(false);
	});

	it("4d. a compat-less catalog entry follows pi's detected default (openai-effort) — pinned decision", async () => {
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		setEnv("MOONSHOT_API_KEY", "sk-ms");
		overlayCatalog("moonshotai", {
			"kimi-k2.6": { id: "kimi-k2.6", reasoning: true, compat: {} },
		});
		expect(thinkingMetaFor("moonshotai", "kimi-k2.6")?.style).toBe("openai-effort");
		await collect(createMoonshotProvider().stream(REQ("kimi-k2.6", "high")));
		expect(captured.at(-1)?.reasoning_effort).toBe("high");
		expect(captured.at(-1)?.thinking).toBeUndefined();
	});

	it("5. discovery: unreachable/401 default → seeds; redirect + unreachable → null; success parses the OpenAI shape", async () => {
		setEnv("MOONSHOT_API_KEY", "sk-test");
		delete process.env.MOONSHOT_BASE_URL;
		delete process.env.MOONSHOT_CN_BASE_URL;
		// default endpoints reject the bogus key (or are unreachable) — seeds are the floor
		expect(await discoverModels("moonshotai")).toEqual([...MOONSHOT_SEED_MODELS]);
		// P2-7: the shared env var marks BOTH configured; a key that belongs
		// to the other platform 401s into the seeds — never an error
		expect(await discoverModels("moonshotai-cn")).toEqual([...MOONSHOT_SEED_MODELS]);
		setEnv("MOONSHOT_BASE_URL", "http://127.0.0.1:1"); // redirected + unreachable
		expect(await discoverModels("moonshotai")).toBeNull(); // no invented ids
		// success path against the local server
		resetDiscoveryCacheForTest();
		setEnv("MOONSHOT_BASE_URL", baseUrl);
		nextModels = ["kimi-k3", "kimi-k2.6"];
		expect(await discoverModels("moonshotai")).toEqual(["kimi-k3", "kimi-k2.6"]);
		expect(auth).toBe("Bearer sk-test");
		// configured follows the shared key, both directions
		setEnv("MOONSHOT_API_KEY", undefined);
		expect(familyConfigured("moonshotai")).toBe(false);
		expect(familyConfigured("moonshotai-cn")).toBe(false);
	});

	it("6. catalog: CATALOG_FAMILIES grew by exactly the two families; an overlay entry feeds the window source", () => {
		expect([...CATALOG_FAMILIES]).toEqual(expect.arrayContaining(["moonshotai", "moonshotai-cn"]));
		expect(CATALOG_FAMILIES).toHaveLength(7);
		overlayCatalog("moonshotai", { "kimi-k3": { id: "kimi-k3", contextWindow: 999_000 } });
		expect(contextWindowInfoFor("moonshotai/kimi-k3")).toMatchObject({
			contextWindow: 999_000,
			source: "catalog",
		});
	});

	it("7. static floor (offline): windows and costs from the pi.dev 2026-09-26 snapshot", () => {
		expect(contextWindowInfoFor("moonshotai/kimi-k3")).toMatchObject({
			contextWindow: 1_048_576,
			source: "static",
		});
		expect(contextWindowInfoFor("moonshotai-cn/kimi-k2.6")).toMatchObject({
			contextWindow: 262_144,
			source: "static",
		});
		expect(costFor("moonshotai/kimi-k2.6")).toEqual({
			input: 0.95,
			output: 4,
			cacheRead: 0.16,
			cacheWrite: 0,
		});
		expect(costFor("moonshotai-cn/kimi-k3")).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
	});

	it("8. vision floor: the current kimi line is multimodal on both families; legacy ids stay false", () => {
		for (const family of ["moonshotai", "moonshotai-cn"]) {
			expect(modelSupportsVision(family, "kimi-k3")).toBe(true);
			expect(modelSupportsVision(family, "kimi-k2.6")).toBe(true);
			expect(modelSupportsVision(family, "kimi-k2.7-code-highspeed")).toBe(true);
			expect(modelSupportsVision(family, "kimi-k2-0711-preview")).toBe(false);
		}
	});

	it("9. session store accepts both families (whitelist + persistence)", async () => {
		const { SessionStore } = await import("../src/core/session/store.js");
		const dir = await mkdtemp(path.join(tmpdir(), "imp-ms-sess-"));
		const store = SessionStore.create(path.join(dir, "s.json"), dir);
		store.setModel({ provider: "moonshotai-cn", modelId: "kimi-k3" });
		expect(store.getModel()).toEqual({ provider: "moonshotai-cn", modelId: "kimi-k3" });
	});

	it("10. /login: both families resolve, shared env var, family switch hints", () => {
		const ai = loginTargetFor("moonshotai");
		expect(ai?.name).toBe("Moonshot AI");
		expect(ai?.envVar).toBe("MOONSHOT_API_KEY");
		expect(ai?.method).toBe("api_key");
		expect(ai?.switchHint).toBe("moonshotai/kimi-k3");
		const cn = loginTargetFor("Moonshot AI CN"); // case-insensitive display name
		expect(cn?.family).toBe("moonshotai-cn");
		expect(cn?.envVar).toBe("MOONSHOT_API_KEY");
		expect(cn?.switchHint).toBe("moonshotai-cn/kimi-k3");
		expect(loginTargetFor("moonshotai-cn")?.family).toBe("moonshotai-cn");
	});

	it("11. buildModelList: moonshot rows carry the family prefix + label; unreachable → fallback rows", async () => {
		const { rows } = await buildModelList("moonshotai/kimi-k3", {
			configured: (f) => f === "moonshotai",
			discover: async (f) => (f === "moonshotai" ? ["kimi-k3", "kimi-k2.6"] : null),
		});
		expect(rows.map((r) => r.label)).toEqual(["moonshotai/kimi-k3", "moonshotai/kimi-k2.6"]);
		expect(rows[1]?.description).toBe("Moonshot AI");
		const { rows: failed } = await buildModelList("moonshotai-cn/kimi-k3", {
			configured: (f) => f === "moonshotai-cn",
			discover: async () => null,
		});
		expect(failed.map((r) => r.label)).toEqual(["moonshotai-cn/kimi-k3", "moonshotai-cn/kimi-k2.6"]);
		expect(failed[1]?.description).toBe("Moonshot AI CN");
	});

	it("12. constants mirror the official platform table", () => {
		expect(MOONSHOT_DEFAULT_BASE_URL).toBe("https://api.moonshot.ai/v1");
		expect(MOONSHOT_CN_DEFAULT_BASE_URL).toBe("https://api.moonshot.cn/v1");
		expect(MOONSHOT_SEED_MODELS).toContain("kimi-k3");
		expect(MOONSHOT_SEED_MODELS).toContain("kimi-k2.7-code");
		expect(createMoonshotCnProvider().name).toBe("moonshotai-cn");
	});
});
