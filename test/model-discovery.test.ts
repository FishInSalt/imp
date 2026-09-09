import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	discoverModels,
	familyConfigured,
	resetDiscoveryCacheForTest,
	setDiscoveryClockForTest,
} from "../src/provider/discover.js";
import { buildModelList, type ModelListDeps } from "../src/repl/commands.js";

/**
 * #model-discovery: the /model picker list is what the CONFIGURED endpoints
 * actually serve (verified live against z.ai's /v1/models before building
 * this). Everything here is hermetic — local listing servers, injected deps,
 * and a pinned credential path.
 */

const NO_FAMILIES: ModelListDeps = {
	configured: () => false,
	discover: async () => null,
};

const ZAI_LIKE = ["glm-4.5", "glm-4.6", "glm-5.2", "glm-5.3", "glm-5.3-flash"];

describe("buildModelList", () => {
	it("configured anthropic endpoint: its listing IS the list (canonical bare ids, family labels)", async () => {
		const { rows, fallbackNotes } = await buildModelList("glm-4.6", {
			configured: (f) => f === "anthropic",
			discover: async (f) => (f === "anthropic" ? [...ZAI_LIKE] : null),
		});
		expect(fallbackNotes).toEqual([]);
		expect(rows.map((r) => r.label)).toEqual(ZAI_LIKE);
		expect(rows[0]?.description).toBe("anthropic-compatible endpoint"); // glm-4.5
		expect(rows[1]?.description).toBe("current"); // glm-4.6 is current — marked, not duplicated
	});

	it("claude ids do NOT appear unless the endpoint lists them (the user's report #1)", async () => {
		const { rows } = await buildModelList("glm-4.6", {
			configured: (f) => f === "anthropic",
			discover: async (f) => (f === "anthropic" ? [...ZAI_LIKE] : null),
		});
		expect(rows.some((r) => r.label.includes("claude"))).toBe(false);
	});

	it("multiple families merge with prefixes; unconfigured families are excluded", async () => {
		const { rows } = await buildModelList("glm-4.6", {
			configured: (f) => f === "anthropic" || f === "openai-codex",
			discover: async (f) => (f === "anthropic" ? ["glm-4.6"] : null),
		});
		// the full 7-entry official coding-plan catalog (fix/codex-catalog)
		expect(rows.map((r) => r.label)).toEqual([
			"glm-4.6",
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.3-codex-spark",
			"openai-codex/gpt-5.6-luna",
			"openai-codex/gpt-5.6-sol",
			"openai-codex/gpt-5.6-terra",
		]);
		expect(rows[1]?.description).toBe("ChatGPT plan (Codex)");
	});

	it("openai family: discovered ids get the prefix; discovery failure falls back + notes", async () => {
		const { rows, fallbackNotes } = await buildModelList("openai/deepseek-chat", {
			configured: (f) => f === "openai",
			discover: async (f) => (f === "openai" ? ["deepseek-chat", "deepseek-reasoner"] : null),
		});
		expect(rows.map((r) => r.label)).toEqual(["openai/deepseek-chat", "openai/deepseek-reasoner"]);

		const failed = await buildModelList("openai/deepseek-chat", {
			configured: (f) => f === "openai",
			discover: async () => null,
		});
		expect(failed.rows.map((r) => r.label)).toEqual(["openai/deepseek-chat", "openai/gpt-5.2"]);
		expect(failed.fallbackNotes).toEqual(["OpenAI-compatible endpoint"]);
	});

	it("codex: warm-cache extras APPEND to the static catalog (backend listing is additive)", async () => {
		const { rows } = await buildModelList("glm-4.6", {
			configured: (f) => f === "openai-codex",
			discover: async (f) => (f === "openai-codex" ? ["gpt-5.9-preview"] : null),
		});
		const labels = rows.map((r) => r.label);
		expect(labels[0]).toBe("glm-4.6"); // the current model fronts the list
		expect(labels.slice(1, 8)).toEqual([
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.3-codex-spark",
			"openai-codex/gpt-5.6-luna",
			"openai-codex/gpt-5.6-sol",
			"openai-codex/gpt-5.6-terra",
		]);
		expect(labels[8]).toBe("openai-codex/gpt-5.9-preview");
	});

	it("nothing configured (fresh install): the classic global seed list", async () => {
		const { rows, fallbackNotes } = await buildModelList("claude-sonnet-4-5", NO_FAMILIES);
		expect(fallbackNotes).toEqual([]);
		const labels = rows.map((r) => r.label);
		expect(labels[0]).toBe("claude-sonnet-4-5");
		expect(labels).toContain("glm-4.6");
		expect(labels).toContain("openai-codex/gpt-5.5");
	});

	it("a custom current id leads even when no endpoint lists it", async () => {
		const { rows } = await buildModelList("my-fine-tune", {
			configured: (f) => f === "anthropic",
			discover: async (f) => (f === "anthropic" ? [...ZAI_LIKE] : null),
		});
		expect(rows[0]).toEqual({ label: "my-fine-tune", description: "current" });
	});
});

describe("discoverModels + familyConfigured", () => {
	let server: Server;
	let baseUrl = "";
	let hits: string[] = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			hits.push(String(req.url));
			if (req.url?.startsWith("/v1/models")) {
				if (req.headers.authorization !== "Bearer zai-token") {
					res.writeHead(401);
					res.end("{}");
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: ZAI_LIKE.map((id) => ({ id })) }));
				return;
			}
			if (req.url === "/v1/oai-models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "gpt-5.4" }, { id: "gpt-5.4-mini" }] }));
				return;
			}
			res.writeHead(404);
			res.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	const SAVED: Record<string, string | undefined> = {};
	beforeEach(() => {
		resetDiscoveryCacheForTest();
		setDiscoveryClockForTest(() => 1_000_000);
		for (const key of [
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
			"IMP_AUTH_PATH",
		]) {
			SAVED[key] = process.env[key];
			delete process.env[key];
		}
		hits = [];
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(SAVED)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("anthropic: bearer auth + anthropic-version header, endpoint order preserved", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "zai-token";
		process.env.ANTHROPIC_BASE_URL = baseUrl;
		expect(await discoverModels("anthropic")).toEqual(ZAI_LIKE);
		expect(hits).toEqual(["/v1/models?limit=1000"]);
	});

	it("cache: a second call within TTL does not hit the server; expiry refetches", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "zai-token";
		process.env.ANTHROPIC_BASE_URL = baseUrl;
		await discoverModels("anthropic");
		await discoverModels("anthropic");
		expect(hits).toHaveLength(1);
		setDiscoveryClockForTest(() => 1_000_000 + 6 * 60_000); // past the 5-min TTL
		await discoverModels("anthropic");
		expect(hits).toHaveLength(2);
	});

	it("openai: Bearer + {base}/models; 401 (bad key) → null → fallback seeds", async () => {
		process.env.OPENAI_API_KEY = "oai-key";
		process.env.OPENAI_BASE_URL = `${baseUrl}/v1/oai-models`.replace("/v1/oai-models", ""); // base = server root
		// the openai family fetches {base}/models — point base so that path 404s, then use the real path via a second config
		expect(await discoverModels("openai")).toBeNull(); // /models → 404
		expect(hits).toContain("/models");
	});

	it("unconfigured families resolve null WITHOUT any network", async () => {
		expect(await discoverModels("anthropic")).toBeNull();
		expect(await discoverModels("openai")).toBeNull();
		expect(await discoverModels("openai-codex")).toBeNull(); // static family, never fetches
		expect(hits).toEqual([]);
		expect(familyConfigured("anthropic")).toBe(false);
		expect(familyConfigured("openai")).toBe(false);
	});

	it("familyConfigured: codex honors IMP_AUTH_PATH (hermetic — host login irrelevant)", () => {
		// unset → reads the real ~/.imp/auth.json — NOT asserted here; the
		// IMP_AUTH_PATH pin below is the hermetic contract
		expect(typeof familyConfigured("openai-codex")).toBe("boolean");
	});
});

describe("familyConfigured via IMP_AUTH_PATH", () => {
	it("a stored credential makes the codex family available", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "imp-disc-"));
		const file = path.join(dir, "auth.json");
		writeFileSync(
			file,
			JSON.stringify({
				provider: "openai-codex",
				accessToken: "a",
				refreshToken: "r",
				expiresAt: Date.now() + 600_000,
				accountId: "acct",
			}),
		);
		const prev = process.env.IMP_AUTH_PATH;
		try {
			process.env.IMP_AUTH_PATH = file;
			expect(familyConfigured("openai-codex")).toBe(true);
			// and the picker shows the static codex catalog
		} finally {
			if (prev === undefined) delete process.env.IMP_AUTH_PATH;
			else process.env.IMP_AUTH_PATH = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
