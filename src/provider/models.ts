/**
 * Static model registry (#multi-provider batch 2): the per-model context
 * window, sourced from pi's auto-generated provider catalogs (which track the
 * live APIs) rather than guesswork. imp default-model users get correct
 * auto-compaction thresholds for the first time; unknown models fall back to
 * the historical 128K default — conservative in the safe direction (compaction
 * fires earlier than strictly necessary, never later).
 *
 * M14 (#model-catalog): these tables are FROZEN — bootstrap + offline floor.
 * The pi.dev catalog overlay (catalog.ts) outranks them for every id it
 * knows; hand-maintenance stopped with this comment.
 *
 * IMP_CONTEXT_WINDOW still wins over everything, as before.
 */

import { catalogEntryForReference } from "./catalog.js";
import { discoveredWindowFor } from "./discover.js";
import { parseModelRef } from "./resolve.js";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	// Anthropic (pi anthropic.json catalog)
	"claude-sonnet-4-5": 1_000_000,
	"claude-sonnet-4-6": 1_000_000,
	"claude-sonnet-5": 1_000_000,
	"claude-haiku-4-5": 200_000,
	"claude-opus-4-5": 200_000,
	"claude-opus-4-6": 1_000_000,
	"claude-opus-4-8": 1_000_000,
	// Z.ai GLM via the Anthropic-compat endpoint (pi zai.json; the 4.x series
	// is documented at 200K)
	"glm-4.5": 200_000,
	"glm-4.6": 200_000,
	"glm-4.7": 204_800,
	"glm-5-turbo": 200_000,
	// z.ai current GLM-5.x line (pi.dev zai catalog, 2026-09)
	"glm-5.2": 1_000_000,
	"glm-5.2-highspeed": 1_000_000,
	"glm-5.3": 1_000_000,
	"glm-5.3-flash": 1_000_000,
	"glm-5.3-highspeed": 1_000_000,
	// DeepSeek official (pi.dev deepseek catalog, 2026-09-25)
	"deepseek-flash": 1_000_000,
	"deepseek-v4-pro": 1_000_000,
	// Moonshot / Kimi official (pi.dev moonshotai catalog, 2026-09-26)
	"kimi-k2.6": 262_144,
	"kimi-k2.7-code": 262_144,
	"kimi-k2.7-code-highspeed": 262_144,
	"kimi-k3": 1_048_576,
	// OpenAI Codex — ChatGPT subscription models (pi openai-codex.json)
	"gpt-6-astra": 272_000, // pi.dev catalog 2026-09
	"gpt-5.3-codex-spark": 128_000,
	"gpt-5.4": 272_000,
	"gpt-5.4-mini": 272_000,
	"gpt-5.5": 272_000,
	"gpt-5.6-luna": 272_000,
	"gpt-5.6-sol": 272_000,
	"gpt-5.6-terra": 272_000,
};

export const DEFAULT_CONTEXT_WINDOW = 131_072;

/** Per-million-token USD rates for the footer's cost segment (pi's
 *  ModelCostRates). Sourced from the same pi provider catalogs as the context
 *  windows above; `subscription: true` marks plans that bill the subscription
 *  rather than the token meter (z.ai Coding Plan, ChatGPT-backed codex) —
 *  their rates are what the traffic WOULD cost at API pricing, shown with a
 *  "(sub)" tag like pi. Request-wide tiered pricing (>272k input) is not
 *  modeled; long sessions on tiered models slightly undercount. */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	subscription?: boolean;
}

const MODEL_COSTS: Record<string, ModelCost> = {
	// Anthropic API (pi anthropic.json)
	"claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	// Z.ai GLM — Coding Plan: token meter is $0, tag as subscription (pi zai.json)
	"glm-4.5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-4.6": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-4.7": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-5-turbo": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-5.2": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-5.2-highspeed": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-5.3": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-5.3-flash": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"glm-5.3-highspeed": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	// DeepSeek official API (pi.dev deepseek catalog, 2026-09-25)
	"deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	"deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
	// Moonshot / Kimi official API (pi.dev moonshotai catalog, 2026-09-26;
	// USD display convention — the CN platform bills CNY, recorded divergence)
	"kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	"kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-k2.7-code-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
	// OpenAI Codex — ChatGPT subscription; rates mirror the API list (pi openai-codex.json)
	"gpt-6-astra": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subscription: true },
	"gpt-5.3-codex-spark": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0, subscription: true },
	"gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0, subscription: true },
	"gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0, subscription: true },
	"gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, subscription: true },
	"gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25, subscription: true },
	"gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, subscription: true },
	"gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125, subscription: true },
};

// circular-safe: discover.js owns the runtime map; import lazily via type-only + accessor

let envWarned = false;

function envInt(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (Number.isFinite(n) && n > 0) return n;
	// Invalid values warn once and are IGNORED (fall through to the registry) —
	// aligned with constants.ts's old contract rather than silently diverging
	// between the footer and the compaction gate (review P2-8).
	if (!envWarned) {
		envWarned = true;
		process.stderr.write(`imp: ignoring invalid ${name}=${JSON.stringify(raw)} (not a positive number)\n`);
	}
	return undefined;
}

/** Families whose traffic rides a subscription plan rather than the token
 *  meter (the catalog carries rates but not billing mode — imp's reality:
 *  zai = GLM Coding Plan, openai-codex = ChatGPT credential; anthropic and
 *  openai are metered API). Static tables encode the same per-model. */
const SUBSCRIPTION_FAMILIES = new Set(["zai", "openai-codex"]);

/** Cost rates for a model reference (canonical or bare); undefined = unknown,
 *  0-cost-models included so subscriptions can be tagged.
 *  M14: the pi.dev catalog wins; the static table is the floor. */
export function costFor(reference: string): ModelCost | undefined {
	const entry = catalogEntryForReference(reference);
	if (entry?.cost !== undefined) {
		const cost: ModelCost = { ...entry.cost };
		if (SUBSCRIPTION_FAMILIES.has(parseModelRef(reference).provider)) cost.subscription = true;
		return cost;
	}
	const slash = reference.indexOf("/");
	const modelId = slash === -1 ? reference : reference.slice(slash + 1);
	return MODEL_COSTS[modelId];
}

export interface ContextWindowInfo {
	contextWindow: number;
	source: "env" | "catalog" | "discovery" | "static" | "fallback";
}

/** Effective context window and provenance for a canonical or bare reference.
 * Priority: environment > catalog > discovery > static table > fallback. */
export function contextWindowInfoFor(reference: string): ContextWindowInfo {
	const env = envInt("IMP_CONTEXT_WINDOW");
	if (env !== undefined) return { contextWindow: env, source: "env" };
	const slash = reference.indexOf("/");
	const modelId = slash === -1 ? reference : reference.slice(slash + 1);
	// env > catalog (pi.dev, M14 single truth) > runtime-enriched (discovery
	// metadata) > static table > default
	const entry = catalogEntryForReference(reference);
	if (entry?.contextWindow !== undefined) return { contextWindow: entry.contextWindow, source: "catalog" };
	const discovered = discoveredWindowFor(modelId);
	if (discovered !== undefined) return { contextWindow: discovered, source: "discovery" };
	const fixed = MODEL_CONTEXT_WINDOWS[modelId];
	if (fixed !== undefined) return { contextWindow: fixed, source: "static" };
	return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "fallback" };
}

/** Number-only compatibility wrapper for context-window consumers. */
export function contextWindowFor(reference: string): number {
	return contextWindowInfoFor(reference).contextWindow;
}
