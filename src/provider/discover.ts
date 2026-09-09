import { loadCodexCredential } from "./codex-auth.js";
import type { ProviderName } from "./resolve.js";

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
 * openai-codex: the ChatGPT backend HAS /codex/models (requires
 * client_version; probed live 2026-09 — exists but returns an empty list
 * for coding-plan accounts, which is why pi keeps an explicit catalog). We
 * call it anyway as an ADDITIVE source: whatever it ever starts serving
 * appears in the picker on top of the static catalog.
 */
export async function discoverModels(family: ProviderName): Promise<string[] | null> {
	if (!familyConfigured(family)) return null;
	if (family === "openai-codex") return discoverCodexModels();

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
		const json = (await response.json()) as {
			data?: Array<{ id?: unknown; slug?: unknown }>;
			models?: Array<{ id?: unknown; slug?: unknown }>;
		};
		const list: Array<{ id?: unknown; slug?: unknown }> | null = Array.isArray(json.data)
			? json.data
			: Array.isArray(json.models)
				? json.models
				: null;
		if (list === null) return null;
		const ids = list
			.map((m) => {
				const id = m?.id ?? m?.slug;
				return typeof id === "string" ? id : "";
			})
			.filter((id) => id !== "");
		if (ids.length === 0) return null;
		if (cacheKey !== undefined) cache.set(cacheKey, { ids, at: now() });
		return ids;
	} catch {
		return null; // offline / timeout / bad shape — caller falls back
	} finally {
		clearTimeout(timer);
	}
}

/** Codex listing — uses the stored credential as-is: the picker must not
 *  trigger a token refresh as a side effect. */
async function discoverCodexModels(): Promise<string[] | null> {
	const credential = loadCodexCredential();
	if (credential === null) return null;
	const base = (process.env.OPENAI_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	return fetchJson(`${base}/codex/models?client_version=imp-0.1.0`, {
		authorization: `Bearer ${credential.accessToken}`,
		"chatgpt-account-id": credential.accountId,
		originator: "imp",
		accept: "application/json",
	});
}

/** Warm cache read — the picker's codex strategy: never block on the
 *  network (the ChatGPT backend can hang for seconds); show the static
 *  catalog now and let warmCodexCache() fill the cache for the NEXT open. */
export function peekCachedModels(family: ProviderName): string[] | null {
	if (family !== "openai-codex") return null;
	const base = (process.env.OPENAI_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	const hit = cache.get(`openai-codex|${base}`);
	return hit !== undefined && now() - hit.at < CACHE_TTL_MS ? hit.ids : null;
}

/** Fire-and-forget cache warm-up; never throws. */
export function warmCodexCache(): void {
	void discoverCodexModels().catch(() => undefined);
}
