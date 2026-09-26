/**
 * Model catalog service (M14): pi.dev is the single source of truth for
 * model metadata — context windows, cost rates, thinking ladders, vision
 * capability, family model lists. Static tables (models.ts, thinking.ts
 * MODEL_RULES, vision.ts, FAMILY_FALLBACKS) are FROZEN: first-run bootstrap
 * and offline floor, no longer hand-maintained.
 *
 * Wire: GET {IMP_CATALOG_BASE_URL|https://pi.dev}/api/models/providers/<family>
 * — public, unauthenticated; entries carry id/name/api/baseUrl/reasoning/
 * input/cost/contextWindow/maxTokens/thinkingLevelMap/compat (verified live
 * 2026-09-20; the endpoint pi's remote-catalog-provider.ts consumes).
 *
 * Refresh model (pi semantics, user-approved): NO periodic polling — a
 * 4-hour staleness window throttles network use. Triggers: startup check +
 * /model open. Disk cache (~/.imp/models-catalog.json) is the fallback when
 * pi.dev is unreachable; ETag revalidation keeps 304s bodyless.
 *
 * Divergences recorded in docs/m14-model-catalog-design.md §4: no
 * localGeneratedAt guard (static tables frozen → remote always wins),
 * single-flight instead of pi's per-runtime coordinator, module overlay +
 * atomic write instead of pi's publish/store transaction.
 */

// NOTE (review P2-6): catalog.ts ↔ resolve.ts form a static import cycle
// through the providers (they import thinking.ts/vision.ts, which import
// catalog.ts). Verified init-safe — every module here executes only
// declarations at top level; keep it that way.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderName } from "./resolve.js";
import { parseModelRef } from "./resolve.js";
import { thinkingMetaFor } from "./thinking.js";

export const CATALOG_FAMILIES: readonly ProviderName[] = [
	"anthropic",
	"openai",
	"openai-codex",
	"zai",
	"deepseek",
	"moonshotai",
	"moonshotai-cn",
];

/** pi's REMOTE_CATALOG_REFRESH_INTERVAL_MS — how long a check stays fresh. */
export const CATALOG_FRESH_WINDOW_MS = 4 * 60 * 60 * 1000;
/** pi's REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS. */
const ATTEMPT_TIMEOUT_MS = 4_000;

export interface CatalogCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** One pi.dev catalog entry (subset imp consumes; unknown fields ignored). */
export interface CatalogEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: CatalogCost;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: {
		forceAdaptiveThinking?: boolean;
		supportsReasoningEffort?: boolean;
		/** pi compat.thinkingFormat — Moonshot's per-model thinking wire
		 *  ("deepseek" thinking {type} for k2.x, "openai" effort for k3). */
		thinkingFormat?: string;
		/** pi compat (Moonshot k3): assistant frames must carry
		 *  reasoning_content even when they have no thinking blocks. */
		requiresReasoningContentOnAssistantMessages?: boolean;
	};
}

/** Disk-cache state per family (pi's ModelsStoreEntry shape). */
interface ProviderCache {
	models: Record<string, CatalogEntry>;
	checkedAt: number;
	lastModified?: number;
	etag?: string;
}

interface CatalogFile {
	version: 1;
	providers: Partial<Record<ProviderName, ProviderCache>>;
}

export interface CatalogRefreshSummary {
	fetched: ProviderName[];
	skippedFresh: ProviderName[];
	noCatalog: ProviderName[];
	failed: ProviderName[];
}

// ---------------------------------------------------------------------------
// Module state + test seams (discover.ts precedent)
// ---------------------------------------------------------------------------

const overlay = new Map<ProviderName, Record<string, CatalogEntry>>();
const store = new Map<ProviderName, ProviderCache>();

let now: () => number = Date.now;

export function setCatalogClockForTest(fn: () => number): void {
	now = fn;
}

/** Fetcher seam: (url, headers) => Response-like. */
export type CatalogFetcher = (
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
) => Promise<{
	status: number;
	ok: boolean;
	headers: { get(name: string): string | null };
	json: () => Promise<unknown>;
}>;

let fetcher: CatalogFetcher = (url, headers, signal) => fetch(url, { headers, signal });

export function setCatalogFetcherForTest(fn: CatalogFetcher): void {
	fetcher = fn;
}

export function resetCatalogForTest(): void {
	overlay.clear();
	store.clear();
	inFlight = null;
}

export function catalogPath(): string {
	return process.env.IMP_CATALOG_PATH ?? join(homedir(), ".imp", "models-catalog.json");
}

function catalogBase(): string {
	return (process.env.IMP_CATALOG_BASE_URL ?? "https://pi.dev").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Load + consult
// ---------------------------------------------------------------------------

/** Synchronously load the disk cache into the overlay. Absent or corrupt
 *  file → no-op (the static floor shows through). */
export function loadCatalogCache(path = catalogPath()): boolean {
	try {
		if (!existsSync(path)) return false;
		const file = JSON.parse(readFileSync(path, "utf-8")) as CatalogFile;
		if (file.version !== 1 || typeof file.providers !== "object" || file.providers === null) {
			return false;
		}
		for (const family of CATALOG_FAMILIES) {
			const entry = file.providers[family];
			if (entry === undefined || typeof entry !== "object" || entry.models === undefined) continue;
			if (typeof entry.checkedAt !== "number") continue;
			// The LOAD path sanitizes exactly like the fetch path (review
			// P2-1): a hand-edited or corrupt-but-parseable cache must not put
			// a string contextWindow into contextWindowFor.
			const models: Record<string, CatalogEntry> = {};
			for (const raw of Object.values(entry.models)) {
				if (typeof raw !== "object" || raw === null) continue;
				const candidate = raw as Partial<CatalogEntry> & { id?: unknown };
				if (typeof candidate.id !== "string" || candidate.id === "") continue;
				models[candidate.id] = sanitizeEntry(candidate as CatalogEntry);
			}
			store.set(family, { ...entry, models });
			overlay.set(family, models);
		}
		return true;
	} catch {
		return false; // corrupt/unreadable — pi.dev refresh will replace it
	}
}

/** Consult point: the catalog entry for an exact (family, id), or null. */
export function catalogEntryFor(provider: string, modelId: string): CatalogEntry | null {
	const family = provider as ProviderName;
	const models = overlay.get(family);
	const entry = models?.[modelId];
	return entry ?? null;
}

/** Consult point: the entry for a model REFERENCE ("zai/glm-5.3", bare
 *  "glm-5.3" routes via parseModelRef exactly like the wire path). */
export function catalogEntryForReference(reference: string): CatalogEntry | null {
	const ref = parseModelRef(reference);
	return catalogEntryFor(ref.provider, ref.modelId);
}

/** The model's output-token cap for budget math (#derived-budget), or
 *  undefined when neither source knows. Sources, in order: the pi.dev
 *  catalog's maxTokens; the thinking table's maxOutputTokens (pi's
 *  model.maxTokens mirror). Callers treat undefined as "no model-side
 *  bound" — never as zero. */
export function modelMaxTokensFor(reference: string): number | undefined {
	const entry = catalogEntryForReference(reference);
	if (entry?.maxTokens !== undefined && Number.isFinite(entry.maxTokens) && entry.maxTokens > 0) {
		return entry.maxTokens;
	}
	const ref = parseModelRef(reference);
	const meta = thinkingMetaFor(ref.provider, ref.modelId);
	if (meta?.maxOutputTokens !== undefined && meta.maxOutputTokens > 0) return meta.maxOutputTokens;
	return undefined;
}

/** Family ids from the overlay (endpoint order preserved), or null when the
 *  catalog has nothing for the family. */
export function catalogModelIds(provider: string): string[] | null {
	const models = overlay.get(provider as ProviderName);
	if (models === undefined) return null;
	const ids = Object.keys(models);
	return ids.length > 0 ? ids : null;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

let inFlight: Promise<CatalogRefreshSummary> | null = null;

/** Refresh stale families from pi.dev. Concurrent callers join the single
 *  in-flight pass (pi's refresh coordinator reduced to its useful core).
 *  Never throws — failures land in the summary; the cache always survives. */
export function refreshCatalog(options?: {
	families?: readonly ProviderName[];
	force?: boolean;
	signal?: AbortSignal;
}): Promise<CatalogRefreshSummary> {
	// Single-flight joins even forced callers: two simultaneous /model opens
	// share one network pass; force only defeats the 4h freshness skip.
	if (inFlight !== null) return inFlight;
	const promise = runRefresh(options).finally(() => {
		if (inFlight === promise) inFlight = null;
	});
	inFlight = promise;
	return promise;
}

async function runRefresh(options?: {
	families?: readonly ProviderName[];
	force?: boolean;
	signal?: AbortSignal;
}): Promise<CatalogRefreshSummary> {
	const families = options?.families ?? CATALOG_FAMILIES;
	const force = options?.force === true;
	const signal = options?.signal;
	const summary: CatalogRefreshSummary = { fetched: [], skippedFresh: [], noCatalog: [], failed: [] };

	for (const family of families) {
		if (signal?.aborted) break;
		const cached = store.get(family);
		const fresh = !force && cached !== undefined && now() - cached.checkedAt < CATALOG_FRESH_WINDOW_MS;
		if (fresh) {
			summary.skippedFresh.push(family);
			continue;
		}
		try {
			await refreshFamily(family, signal, summary);
		} catch {
			// Our OWN shutdown abort must not bump the window — the fetch never
			// got a chance to answer, so the next run should retry (pi skips
			// persisting on an aborted signal too).
			if (signal?.aborted) {
				summary.failed.push(family);
				continue;
			}
			// Network/timeout — keep the cached body; bump the window so a dead
			// endpoint is not hammered on every /model open (pi parity).
			if (cached !== undefined) {
				persistFamily(family, { ...cached, checkedAt: now() });
			}
			summary.failed.push(family);
		}
	}
	return summary;
}

async function refreshFamily(
	family: ProviderName,
	signal: AbortSignal | undefined,
	summary: CatalogRefreshSummary,
): Promise<void> {
	const controller = new AbortController();
	const onOuterAbort = () => controller.abort();
	signal?.addEventListener("abort", onOuterAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
	// A pending timer alone must never hold the process open (review P1-1).
	timer.unref();
	try {
		const cached = store.get(family);
		// Revalidate ONLY when a cached body backs the validator — a 304 must
		// never empty the overlay (pi parity).
		const validator = cached !== undefined && Object.keys(cached.models).length > 0 ? cached.etag : undefined;
		const url = `${catalogBase()}/api/models/providers/${encodeURIComponent(family)}`;
		// One quiet retry on throttling/transient 5xx (discover.ts precedent,
		// adapted from pi's fetchWithRetry — review P2-2): a single 503 must
		// not freeze a family for the whole 4h window.
		let response: Awaited<ReturnType<CatalogFetcher>>;
		for (let attempt = 0; ; attempt++) {
			response = await fetcher(
				url,
				{
					accept: "application/json",
					...(validator !== undefined ? { "if-none-match": validator } : {}),
				},
				controller.signal,
			);
			const retriable = response.status === 429 || response.status >= 500;
			if (!retriable || attempt >= 1) break;
			await new Promise((r) => setTimeout(r, 400));
		}
		if (signal?.aborted) return;
		const checkedAt = now();

		if (response.status === 304 && cached !== undefined) {
			// Unchanged: the overlay already holds the body; move the window only.
			persistFamily(family, { ...cached, checkedAt });
			summary.skippedFresh.push(family);
			return;
		}
		if (response.status === 404 || response.status === 501) {
			// This family has no catalog — record it so the window still applies.
			persistFamily(family, { models: {}, checkedAt, lastModified: 0, etag: undefined });
			summary.noCatalog.push(family);
			return;
		}
		if (!response.ok) {
			// Transient failure: cached body (and its validator) stay valid.
			persistFamily(family, cached ?? { models: {}, checkedAt });
			summary.failed.push(family);
			return;
		}

		const models = parseCatalog(family, await response.json());
		const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
		persistFamily(family, {
			models,
			checkedAt,
			lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
			etag: response.headers.get("etag") ?? undefined,
		});
		summary.fetched.push(family);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onOuterAbort);
	}
}

/** pi's parseCatalog: accepts a bare array, {models:[...]}, or the
 *  record-keyed-by-id shape pi.dev actually serves. Invalid entries are
 *  dropped, not fatal. */
function parseCatalog(family: ProviderName, value: unknown): Record<string, CatalogEntry> {
	let entries: unknown[];
	if (Array.isArray(value)) {
		entries = value;
	} else if (
		typeof value === "object" &&
		value !== null &&
		"models" in value &&
		Array.isArray((value as { models: unknown }).models)
	) {
		entries = (value as { models: unknown[] }).models;
	} else if (typeof value === "object" && value !== null) {
		entries = Object.values(value);
	} else {
		throw new Error(`invalid model catalog for ${family}`);
	}

	const models: Record<string, CatalogEntry> = {};
	for (const raw of entries) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as Partial<CatalogEntry> & { id?: unknown };
		if (typeof entry.id !== "string" || entry.id === "") continue;
		models[entry.id] = sanitizeEntry(entry as CatalogEntry);
	}
	return models;
}

/** Keep only fields imp consumes, defensively typed. */
function sanitizeEntry(entry: CatalogEntry): CatalogEntry {
	const clean: CatalogEntry = { id: entry.id };
	if (typeof entry.name === "string") clean.name = entry.name;
	if (typeof entry.reasoning === "boolean") clean.reasoning = entry.reasoning;
	if (Array.isArray(entry.input)) {
		const input = entry.input.filter((m): m is string => typeof m === "string");
		if (input.length > 0) clean.input = input;
	}
	if (
		typeof entry.contextWindow === "number" &&
		Number.isFinite(entry.contextWindow) &&
		entry.contextWindow > 0
	) {
		clean.contextWindow = entry.contextWindow;
	}
	if (typeof entry.maxTokens === "number" && Number.isFinite(entry.maxTokens) && entry.maxTokens > 0) {
		clean.maxTokens = entry.maxTokens;
	}
	if (
		typeof entry.cost === "object" &&
		entry.cost !== null &&
		[entry.cost.input, entry.cost.output, entry.cost.cacheRead, entry.cost.cacheWrite].every(
			(v) => typeof v === "number",
		)
	) {
		clean.cost = {
			input: entry.cost.input,
			output: entry.cost.output,
			cacheRead: entry.cost.cacheRead,
			cacheWrite: entry.cost.cacheWrite,
		};
	}
	if (typeof entry.thinkingLevelMap === "object" && entry.thinkingLevelMap !== null) {
		const map: Record<string, string | null> = {};
		for (const [level, wire] of Object.entries(entry.thinkingLevelMap)) {
			if (typeof wire === "string" || wire === null) map[level] = wire;
		}
		if (Object.keys(map).length > 0) clean.thinkingLevelMap = map;
	}
	if (typeof entry.compat === "object" && entry.compat !== null) {
		const compat: CatalogEntry["compat"] = {};
		if (typeof entry.compat.forceAdaptiveThinking === "boolean") {
			compat.forceAdaptiveThinking = entry.compat.forceAdaptiveThinking;
		}
		if (typeof entry.compat.supportsReasoningEffort === "boolean") {
			compat.supportsReasoningEffort = entry.compat.supportsReasoningEffort;
		}
		if (typeof entry.compat.thinkingFormat === "string") {
			compat.thinkingFormat = entry.compat.thinkingFormat;
		}
		if (typeof entry.compat.requiresReasoningContentOnAssistantMessages === "boolean") {
			compat.requiresReasoningContentOnAssistantMessages =
				entry.compat.requiresReasoningContentOnAssistantMessages;
		}
		if (Object.keys(compat).length > 0) clean.compat = compat;
	}
	return clean;
}

/** Update the overlay + store and write the file atomically. */
function persistFamily(family: ProviderName, cache: ProviderCache): void {
	store.set(family, cache);
	overlay.set(family, cache.models);

	const path = catalogPath();
	const file: CatalogFile = { version: 1, providers: {} };
	for (const f of CATALOG_FAMILIES) {
		const entry = store.get(f);
		if (entry !== undefined) file.providers[f] = entry;
	}
	try {
		// Every other store in the codebase creates its directory on write
		// (settings.ts, auth-store.ts) — a clean machine with --no-session
		// would otherwise never persist the cache (review P2-5).
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8" });
		renameSync(tmp, path);
	} catch {
		// Unwritable cache dir: the overlay still works for this process.
	}
}
