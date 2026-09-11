import { loadCodexCredential } from "./codex-auth.js";
import type { ProviderName } from "./resolve.js";
import { ZAI_DEFAULT_BASE_URL, ZAI_SEED_MODELS } from "./zai.js";

/**
 * Model-list discovery (#model-discovery): ask each configured endpoint what
 * it actually serves. The /model picker shows the union — "what you can use
 * right now" — instead of a hardcoded table that both missed models (z.ai
 * serves ten GLMs; the static list had three) and invented availability
 * (claude ids on an endpoint whose own /v1/models never lists them).
 *
 * Truth sources per family:
 *   anthropic     GET {ANTHROPIC_BASE_URL|api.anthropic.com}/v1/models — the
 *                 Anthropic-compatible standard (verified live against z.ai)
 *   openai        GET {OPENAI_BASE_URL|api.openai.com}/v1}/models — the
 *                 OpenAI-compatible standard
 *   openai-codex  no public listing on the ChatGPT backend — static catalog
 *
 * Results are cached 5 minutes per (family, baseUrl); requests time out at
 * 2.5s and resolve null (caller falls back to static seeds + a note).
 */

const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;

interface CacheEntry {
	ids: string[];
	at: number;
}

const cache = new Map<string, CacheEntry>();

/** Runtime window enrichment (#context-window-adapt): listings that carry
 *  contextWindow metadata (pi.dev's catalogs do; the first-party
 *  /v1/models endpoints do not) feed this map, which outranks the static
 *  table — a newly shipped model gets its REAL window before any registry
 *  update, so compaction neither fires absurdly early nor too late. */
const discoveredWindows = new Map<string, number>();

export function registerDiscoveredContextWindows(windows: Record<string, number>): void {
	for (const [id, ctx] of Object.entries(windows)) {
		if (Number.isFinite(ctx) && ctx > 0) discoveredWindows.set(id, ctx);
	}
}

export function resetDiscoveredWindowsForTest(): void {
	discoveredWindows.clear();
}

export function discoveredWindowFor(modelId: string): number | undefined {
	return discoveredWindows.get(modelId);
}

/** Injectable clock for tests. */
let now: () => number = Date.now;

export function setDiscoveryClockForTest(fn: () => number): void {
	now = fn;
}

export function resetDiscoveryCacheForTest(): void {
	cache.clear();
}

function anthropicBaseUrl(): string {
	return (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
}

function openaiBaseUrl(): string {
	return (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

/** Which credential, if any, is present for each family. */
export function familyConfigured(family: ProviderName): boolean {
	switch (family) {
		case "anthropic":
			return process.env.ANTHROPIC_AUTH_TOKEN !== undefined || process.env.ANTHROPIC_API_KEY !== undefined;
		case "openai":
			return process.env.OPENAI_API_KEY !== undefined;
		case "openai-codex":
			return loadCodexCredential() !== null;
		case "zai":
			return process.env.ZAI_API_KEY !== undefined;
		default: {
			const exhaustive: never = family;
			throw new Error(`unreachable family: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/**
 * The ids an endpoint serves (wire ids, endpoint order), or null when the
 * family is unconfigured or its listing is unreachable.
 *
 * openai-codex: the ChatGPT backend's /codex/models is version-gated to a
 * 3-entry recommended subset (probed live: client_version ≥0.124 required;
 * entries carry minimal_client_version) — NOT the full set. The complete,
 * current catalog comes from pi's public central service
 * (pi.dev/api/models/providers/openai-codex — the same source the reference
 * project fetches; it served gpt-6-astra the day it shipped). Static seeds
 * remain the offline fallback.
 */
export async function discoverModels(family: ProviderName): Promise<string[] | null> {
	if (!familyConfigured(family)) return null;
	if (family === "openai-codex") return discoverCodexModels();
	// zai: the coding endpoint serves an OpenAI-style /models; the pi.dev
	// live catalog is the offline seed when it 404s or the family is
	// configured but unreachable.
	if (family === "zai") {
		const ids = await fetchJson(
			`${process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE_URL}/models`,
			{ accept: "application/json", authorization: `Bearer ${String(process.env.ZAI_API_KEY)}` },
			"zai",
		).catch(() => null);
		return ids ?? ([...ZAI_SEED_MODELS] as string[]);
	}

	const baseUrl = family === "anthropic" ? anthropicBaseUrl() : openaiBaseUrl();
	const cacheKey = `${family}|${baseUrl}`;
	const hit = cache.get(cacheKey);
	if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.ids;

	let url: string;
	const headers: Record<string, string> = { accept: "application/json" };
	if (family === "anthropic") {
		url = `${baseUrl}/v1/models?limit=1000`;
		const token = process.env.ANTHROPIC_AUTH_TOKEN;
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		else headers["x-api-key"] = String(process.env.ANTHROPIC_API_KEY);
		headers["anthropic-version"] = "2023-06-01";
	} else {
		url = `${baseUrl}/models`;
		headers.authorization = `Bearer ${String(process.env.OPENAI_API_KEY)}`;
	}

	return fetchJson(url, headers, cacheKey);
}

/** Fetch a models listing; accepts both {data:[...]} (OpenAI/Anthropic
 *  convention) and {models:[{slug|id}]} (the codex backend's shape). */
async function fetchJson(
	url: string,
	headers: Record<string, string>,
	cacheKey?: string,
): Promise<string[] | null> {
	// One quiet retry on throttling: a single 429 must not collapse the
	// picker into its fallback seeds (observed live against z.ai).
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
		const result = await fetchOnce(url, headers, cacheKey);
		if (result !== "retry") return result;
	}
	return null;
}

type FetchOnce = string[] | null | "retry";

async function fetchOnce(
	url: string,
	headers: Record<string, string>,
	cacheKey?: string,
): Promise<FetchOnce> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (response.status === 429 || response.status >= 500) {
			await response.text().catch(() => ""); // drain before retrying
			return "retry";
		}
		if (!response.ok) return null;
		const json = (await response.json()) as unknown;
		const asRecord = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
		// Three listing shapes in the wild: a bare array, {data:[...]} /
		// {models:[...]}, and pi.dev's record keyed by model id (parseCatalog's
		// Object.values branch in the reference project).
		const candidate = Array.isArray(json)
			? json
			: Array.isArray(asRecord.data)
				? asRecord.data
				: Array.isArray(asRecord.models)
					? asRecord.models
					: Object.values(asRecord).length > 0 &&
							Object.values(asRecord).every((v) => typeof v === "object" && v !== null && "id" in v)
						? Object.values(asRecord)
						: null;
		const list: Array<{ id?: unknown; slug?: unknown; contextWindow?: unknown }> | null =
			candidate !== null ? (candidate as Array<{ id?: unknown; slug?: unknown }>) : null;
		if (list === null) return null;
		const entries = list.filter((m): m is { id?: unknown; slug?: unknown; contextWindow?: unknown } => {
			const id = m?.id ?? m?.slug;
			return typeof id === "string" && id !== "";
		});
		const ids = entries.map((m) => (m.id ?? m.slug) as string);
		// enrich the runtime window map when the listing carries metadata
		const windows: Record<string, number> = {};
		for (const m of entries) {
			if (typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
				windows[(m.id ?? m.slug) as string] = m.contextWindow;
			}
		}
		if (Object.keys(windows).length > 0) registerDiscoveredContextWindows(windows);
		if (ids.length === 0) return null;
		if (cacheKey !== undefined) cache.set(cacheKey, { ids, at: now() });
		return ids;
	} catch {
		return null; // offline / timeout / bad shape — caller falls back
	} finally {
		clearTimeout(timer);
	}
}

/** Codex listing: pi's public catalog service (unauthenticated, fast).
 *  IMP_CATALOG_BASE_URL redirects it (tests / mirrors). */
async function discoverCodexModels(): Promise<string[] | null> {
	if (!familyConfigured("openai-codex")) return null;
	const base = (process.env.IMP_CATALOG_BASE_URL ?? "https://pi.dev").replace(/\/+$/, "");
	return fetchJson(`${base}/api/models/providers/openai-codex`, { accept: "application/json" });
}
