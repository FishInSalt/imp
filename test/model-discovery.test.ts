import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	discoverModels,
	familyConfigured,
	MODELS_PAGE_CAP,
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
	it("#glm-retire: a compat endpoint's glm ids are filtered from the anthropic listing (zai is the one GLM path); claude ids pass", async () => {
		const { rows, fallbackNotes } = await buildModelList("glm-4.6", {
			configured: (f) => f === "anthropic",
			discover: async (f) => (f === "anthropic" ? [...ZAI_LIKE, "claude-sonnet-4-5"] : null),
		});
		expect(fallbackNotes).toEqual([]);
		// glm rows dropped (they duplicate the zai family); claude passes;
		// the bare current glm id still LEADS — pickable even when unlisted
		expect(rows.map((r) => r.label)).toEqual(["glm-4.6", "claude-sonnet-4-5"]);
		expect(rows[0]?.description).toBe("current"); // glm-4.6 is marked, not duplicated
		expect(rows[1]?.description).toBe("anthropic-compatible endpoint"); // claude-sonnet-4-5
	});

	it("claude ids do NOT appear unless the endpoint lists them (the user's report #1)", async () => {
		const { rows } = await buildModelList("glm-4.6", {
			configured: (f) => f === "anthropic",
			discover: async (f) => (f === "anthropic" ? [...ZAI_LIKE] : null), // no claude served
		});
		expect(rows.some((r) => r.label.includes("claude"))).toBe(false);
	});

	it("multiple families merge with prefixes; unconfigured families are excluded", async () => {
		const { rows } = await buildModelList("glm-4.6", {
			configured: (f) => f === "anthropic" || f === "openai-codex",
			discover: async (f) => (f === "anthropic" ? ["glm-4.6"] : null),
		});
		// static seeds = the offline floor (pi.dev catalog synced, incl. gpt-6-astra)
		expect(rows.map((r) => r.label)).toEqual([
			"glm-4.6",
			"openai-codex/gpt-6-astra",
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
		const { rows } = await buildModelList("openai/deepseek-chat", {
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

	it("codex: pi.dev catalog is primary (gpt-6-astra arrives with it); failure falls back to static seeds + note", async () => {
		const fresh = await buildModelList("glm-4.6", {
			configured: (f) => f === "openai-codex",
			// the pi.dev shape: a bare array (or {models:[...]}) — served gpt-6-astra on day one
			discover: async (f) => (f === "openai-codex" ? ["gpt-6-astra", "gpt-5.5", "gpt-5.4"] : null),
		});
		expect(fresh.rows.map((r) => r.label)).toEqual([
			"glm-4.6",
			"openai-codex/gpt-6-astra",
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5.4",
		]);
		expect(fresh.fallbackNotes).toEqual([]);
		const failed = await buildModelList("glm-4.6", {
			configured: (f) => f === "openai-codex",
			discover: async () => null,
		});
		expect(failed.rows.map((r) => r.label).slice(0, 3)).toEqual([
			"glm-4.6",
			"openai-codex/gpt-6-astra",
			"openai-codex/gpt-5.5",
		]);
		expect(failed.fallbackNotes).toEqual(["model catalog (pi.dev)"]);
	});

	it("nothing configured (fresh install): the classic global seed list", async () => {
		const { rows, fallbackNotes } = await buildModelList("claude-sonnet-4-5", NO_FAMILIES);
		expect(fallbackNotes).toEqual([]);
		const labels = rows.map((r) => r.label);
		expect(labels[0]).toBe("claude-sonnet-4-5");
		expect(labels).toContain("zai/glm-5.3"); // GLM is zai-canonical now
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
			"IMP_CATALOG_BASE_URL",
		]) {
			SAVED[key] = process.env[key];
			delete process.env[key];
		}
		// deleting IMP_AUTH_PATH would EXPOSE the host's real login — pin "none"
		process.env.IMP_AUTH_PATH = "/nonexistent-imp-auth.json";
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

	it("codex: pi.dev catalog (bare-array shape) via IMP_CATALOG_BASE_URL; gated on login", async () => {
		// credential present (pinned path) + local catalog server
		const dir = mkdtempSync(path.join(tmpdir(), "imp-disc-"));
		const credFile = path.join(dir, "auth.json");
		writeFileSync(
			credFile,
			JSON.stringify({
				provider: "openai-codex",
				accessToken: "a",
				refreshToken: "r",
				expiresAt: Date.now() + 600_000,
				accountId: "acct",
			}),
		);
		let hit = false;
		const cat = createServer((_req, res) => {
			hit = true;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ "gpt-6-astra": { id: "gpt-6-astra" }, gpt55: { id: "gpt-5.5" } })); // pi.dev's record-keyed shape
		});
		await new Promise<void>((r) => cat.listen(0, "127.0.0.1", r));
		const { port } = cat.address() as { port: number };
		const savedAuth = process.env.IMP_AUTH_PATH;
		const savedCat = process.env.IMP_CATALOG_BASE_URL;
		process.env.IMP_AUTH_PATH = credFile;
		process.env.IMP_CATALOG_BASE_URL = `http://127.0.0.1:${port}`;
		try {
			resetDiscoveryCacheForTest();
			expect(await discoverModels("openai-codex")).toEqual(["gpt-6-astra", "gpt-5.5"]);
			expect(hit).toBe(true);
			// without the login, no fetch happens even with the catalog configured
			process.env.IMP_AUTH_PATH = "/nonexistent";
			resetDiscoveryCacheForTest();
			hit = false;
			expect(await discoverModels("openai-codex")).toBeNull();
			expect(hit).toBe(false);
		} finally {
			cat.close();
			if (savedAuth === undefined) delete process.env.IMP_AUTH_PATH;
			else process.env.IMP_AUTH_PATH = savedAuth;
			if (savedCat === undefined) delete process.env.IMP_CATALOG_BASE_URL;
			else process.env.IMP_CATALOG_BASE_URL = savedCat;
			rmSync(dir, { recursive: true, force: true });
		}
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

describe("costFor (footer cost table)", () => {
	it("resolves canonical and bare references; flags subscriptions; unknown → undefined", async () => {
		const { costFor } = await import("../src/provider/models.js");
		const gpt = costFor("openai-codex/gpt-5.5");
		expect(gpt).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, subscription: true });
		expect(costFor("gpt-5.5")).toBe(gpt);
		const glm = costFor("glm-5.3");
		expect(glm?.subscription).toBe(true);
		expect(glm?.input).toBe(0);
		expect(costFor("claude-sonnet-4-5")?.subscription).toBeUndefined();
		expect(costFor("totally-unknown")).toBeUndefined();
	});
});

describe("formatTokens (pi footer algorithm)", () => {
	it("keeps one decimal below 10k/10M, rounds above", async () => {
		const { formatTokens } = await import("../src/format.js");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(9800)).toBe("9.8k");
		expect(formatTokens(12_300)).toBe("12k");
		expect(formatTokens(200_100)).toBe("200k");
		expect(formatTokens(1_050_000)).toBe("1.1M");
		expect(formatTokens(15_000_000)).toBe("15M");
	});
});

describe("discoverModels pagination (anthropic family, docs/overflow-pagination-design.md §4)", () => {
	/** Scripted paging server: one mutable "mode" the handler dispatches on.
	 *  Pages: page1 (no after_id) = m1..m3, page2 (after_id=m3) = m4..m5. */
	let server: Server;
	let baseUrl = "";
	let hits: string[] = [];
	let mode: "single-camel" | "page-camel" | "page-snake" | "ignore-cursor" | "always-new" | "page2-500" =
		"single-camel";
	const PAGE1 = ["m1", "m2", "m3"];
	const PAGE2 = ["m4", "m5"];

	beforeAll(async () => {
		server = createServer((req, res) => {
			hits.push(String(req.url));
			const url = new URL(String(req.url), "http://x");
			res.writeHead(200, { "content-type": "application/json" });
			if (mode === "single-camel") {
				// Today's live z.ai compat-endpoint shape (2026-02-07 probe).
				res.end(
					JSON.stringify({ data: PAGE1.map((id) => ({ id })), firstId: "m1", hasMore: false, lastId: "m3" }),
				);
				return;
			}
			if (mode === "page-camel" || mode === "page-snake") {
				const camel = mode === "page-camel";
				if (url.searchParams.get("after_id") === null) {
					res.end(
						JSON.stringify(
							camel
								? { data: PAGE1.map((id) => ({ id })), firstId: "m1", hasMore: true, lastId: "m3" }
								: { data: PAGE1.map((id) => ({ id })), first_id: "m1", has_more: true, last_id: "m3" },
						),
					);
				} else {
					res.end(
						JSON.stringify(
							camel
								? { data: PAGE2.map((id) => ({ id })), firstId: "m4", hasMore: false, lastId: "m5" }
								: { data: PAGE2.map((id) => ({ id })), first_id: "m4", has_more: false, last_id: "m5" },
						),
					);
				}
				return;
			}
			if (mode === "page2-500") {
				if (url.searchParams.get("after_id") === null) {
					res.end(JSON.stringify({ data: PAGE1.map((id) => ({ id })), hasMore: true, lastId: "m3" }));
				} else {
					res.writeHead(500);
					res.end("{}");
				}
				return;
			}
			if (mode === "ignore-cursor") {
				// Server that reports more pages but returns the SAME page whatever
				// after_id says (z.ai ignores cursor params today).
				res.end(JSON.stringify({ data: PAGE1.map((id) => ({ id })), hasMore: true, lastId: "m3" }));
				return;
			}
			// always-new: every request serves one fresh id and keeps lying about
			// more pages — the page cap is the only stop.
			const n = hits.length;
			res.end(JSON.stringify({ data: [{ id: `fresh-${n}` }], hasMore: true, lastId: `fresh-${n}` }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	beforeEach(() => {
		resetDiscoveryCacheForTest();
		setDiscoveryClockForTest(() => 1_000_000);
		process.env.ANTHROPIC_AUTH_TOKEN = "zai-token";
		process.env.ANTHROPIC_BASE_URL = baseUrl;
		process.env.IMP_AUTH_PATH = "/nonexistent-imp-auth.json";
		hits = [];
		mode = "single-camel";
	});
	afterEach(() => {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_BASE_URL;
	});

	it("today's z.ai shape (camelCase, hasMore:false) is one page — shape pin", async () => {
		const ids = await discoverModels("anthropic");
		expect(ids).toEqual(PAGE1);
		expect(hits).toEqual(["/v1/models?limit=1000"]); // never a second request
	});

	it("hasMore:true follows after_id and merges pages (camelCase)", async () => {
		mode = "page-camel";
		const ids = await discoverModels("anthropic");
		expect(ids).toEqual([...PAGE1, ...PAGE2]);
		expect(hits).toEqual(["/v1/models?limit=1000", "/v1/models?limit=1000&after_id=m3"]);
	});

	it("snake_case (real Anthropic API) pages too", async () => {
		mode = "page-snake";
		const ids = await discoverModels("anthropic");
		expect(ids).toEqual([...PAGE1, ...PAGE2]);
		expect(hits).toEqual(["/v1/models?limit=1000", "/v1/models?limit=1000&after_id=m3"]);
	});

	it("a server that ignores after_id (same page again) stops on the dedupe, no duplicates", async () => {
		mode = "ignore-cursor";
		const ids = await discoverModels("anthropic");
		expect(ids).toEqual(PAGE1);
		expect(hits).toHaveLength(2); // tried page 2, got nothing new, stopped
	});

	it("an always-lying cursor stops at the page cap", async () => {
		mode = "always-new";
		const ids = await discoverModels("anthropic");
		expect(hits).toHaveLength(MODELS_PAGE_CAP);
		expect(ids).toHaveLength(MODELS_PAGE_CAP);
	});

	it("a completed walk writes the MERGED list once — no refetch inside the TTL (review P2-2 pin)", async () => {
		mode = "page-camel";
		const first = await discoverModels("anthropic");
		expect(first).toEqual([...PAGE1, ...PAGE2]);
		expect(hits).toHaveLength(2);
		const second = await discoverModels("anthropic"); // served from the cache
		expect(second).toEqual([...PAGE1, ...PAGE2]);
		expect(hits).toHaveLength(2); // zero new requests
	});

	it("a mid-walk failure returns null and caches NOTHING — the next call refetches (review P2-2 pin)", async () => {
		mode = "page2-500";
		const first = await discoverModels("anthropic");
		expect(first).toBeNull(); // page 2 exhausted its retry → whole walk fails
		const afterFirst = hits.length; // page1 + two 500 attempts
		const second = await discoverModels("anthropic"); // nothing was cached
		expect(second).toBeNull();
		expect(hits.length).toBe(afterFirst * 2); // full refetch, not a poisoned partial
	});

	it("the zai coding endpoint ({object, data}, no pagination fields) stays a single request", async () => {
		// Separate tiny server on the zai path: /models (no /v1 prefix).
		let zaiHits = 0;
		const zaiServer = createServer((req, res) => {
			zaiHits += 1;
			if (req.url === "/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: PAGE1.map((id) => ({ id })) }));
				return;
			}
			res.writeHead(404);
			res.end("{}");
		});
		await new Promise<void>((resolve) => zaiServer.listen(0, "127.0.0.1", resolve));
		const addr = zaiServer.address();
		if (addr === null || typeof addr === "string") throw new Error("no address");
		try {
			process.env.ZAI_BASE_URL = `http://127.0.0.1:${addr.port}`;
			process.env.ZAI_API_KEY = "zai-key";
			const ids = await discoverModels("zai");
			expect(ids).toEqual(PAGE1);
			expect(zaiHits).toBe(1); // single page, no cursor chasing
		} finally {
			await new Promise<void>((resolve) => zaiServer.close(() => resolve()));
			delete process.env.ZAI_BASE_URL;
			delete process.env.ZAI_API_KEY;
		}
	});
});
