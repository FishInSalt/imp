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
const REQUEST_TIMEOUT_MS = 2_500;

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
 * family is unconfigured or its listing is unreachable. Codex is always null
 * — it has no listing endpoint and uses a static catalog.
 */
export async function discoverModels(family: ProviderName): Promise<string[] | null> {
	if (!familyConfigured(family)) return null;
	if (family === "openai-codex") return null;

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

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) return null;
		const json = (await response.json()) as { data?: Array<{ id?: unknown }> };
		if (!Array.isArray(json.data)) return null;
		const ids = json.data.map((m) => (typeof m?.id === "string" ? m.id : "")).filter((id) => id !== "");
		if (ids.length === 0) return null;
		cache.set(cacheKey, { ids, at: now() });
		return ids;
	} catch {
		return null; // offline / timeout / bad shape — caller falls back
	} finally {
		clearTimeout(timer);
	}
}
