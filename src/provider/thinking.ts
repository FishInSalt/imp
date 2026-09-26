/**
 * Thinking levels (#thinking-levels) — pi parity.
 *
 * pi's model of the world:
 *  - a 7-level ladder (off/minimal/low/medium/high/xhigh/max);
 *  - per-model metadata (pi's generated catalog: packages/ai/src/providers/
 *    data/*.json, and pi.dev/api/models for openai-codex): `reasoning`
 *    (has a knob at all), `thinkingLevelMap` (level → wire value, where
 *    null = the model cannot do that level), and `compat` flags
 *    (forceAdaptiveThinking for Claude ≥4.6, supportsReasoningEffort for
 *    zai GLM ≥5.2);
 *  - getSupportedThinkingLevels/clampThinkingLevel driven by that map;
 *  - protocol mappings in each provider (budget / adaptive+effort /
 *    reasoning_effort / zai thinking object).
 *
 * imp mirrors this with a static per-model table below. Family defaults
 * cover unknown/dynamically discovered ids conservatively (effort styles:
 * off..high; binary styles: off/high).
 */

import { catalogEntryFor } from "./catalog.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The protocol family a model's thinking knob drives. */
export type ThinkingStyle =
	| "anthropic-budget" // Claude ≤4.5: budget_tokens beside max_tokens
	| "anthropic-adaptive" // Claude ≥4.6: {type:"adaptive"} + output_config.effort
	| "glm-anthropic" // Z.ai GLM on the anthropic-compat protocol: binary enable
	| "openai-effort" // OpenAI Chat Completions: reasoning_effort
	| "glm-openai" // Z.ai GLM on openai-compat: native thinking object
	| "codex-effort" // ChatGPT backend Responses: reasoning.effort
	| "deepseek" // DeepSeek official: thinking {type} + reasoning_effort
	| "auto"; // deepseek-reasoner via openai-compat: reasons by default, no request knob

/** pi's thinkingLevelMap: level → the wire value; null = the level is
 *  UNAVAILABLE on this model; absent = available under its own name.
 *  (xhigh/max additionally require an explicit entry to exist.) */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelThinkingMeta {
	style: ThinkingStyle;
	levelMap?: ThinkingLevelMap;
	/** pi compat.forceAdaptiveThinking — Claude ≥4.6 adaptive thinking. */
	adaptive?: boolean;
	/** pi compat.supportsReasoningEffort — zai GLM ≥5.2. */
	supportsEffort?: boolean;
	/** pi model.maxTokens — the cap for the budget math and output clamp. */
	maxOutputTokens?: number;
}

/** The zai GLM 5.2 map (pi.dev live, 2026-09): minimal/low/medium all
 *  unavailable; high is the single effort; max native; off maps to the
 *  explicit "none" effort. */
const GLM_52_MAP: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
};

/** The zai GLM 5.3 map (pi.dev live, 2026-09): thinking CANNOT be disabled
 *  (off:null) and minimal/medium are unavailable — the ladder is
 *  low / high / max. */
const GLM_53_MAP: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
};

/** Longest matching prefix wins within a provider (dynamic discovery may
 *  surface ids the static seeds never listed). */
const MODEL_RULES: ReadonlyArray<{ provider: string; prefix: string; meta: ModelThinkingMeta }> = [
	// ---- anthropic protocol ----
	{ provider: "anthropic", prefix: "glm-", meta: { style: "glm-anthropic" } },
	// Claude ≥4.6 (pi: forceAdaptiveThinking + xhigh/max maps, 128k output)
	{
		provider: "anthropic",
		prefix: "claude-opus-4-6",
		meta: { style: "anthropic-adaptive", adaptive: true, levelMap: { max: "max" }, maxOutputTokens: 128_000 },
	},
	{
		provider: "anthropic",
		prefix: "claude-opus-4-7",
		meta: {
			style: "anthropic-adaptive",
			adaptive: true,
			levelMap: { xhigh: "xhigh", max: "max" },
			maxOutputTokens: 128_000,
		},
	},
	{
		provider: "anthropic",
		prefix: "claude-opus-4-8",
		meta: {
			style: "anthropic-adaptive",
			adaptive: true,
			levelMap: { xhigh: "xhigh", max: "max" },
			maxOutputTokens: 128_000,
		},
	},
	{
		provider: "anthropic",
		prefix: "claude-opus-5",
		meta: {
			style: "anthropic-adaptive",
			adaptive: true,
			levelMap: { xhigh: "xhigh", max: "max" },
			maxOutputTokens: 128_000,
		},
	},
	{
		provider: "anthropic",
		prefix: "claude-sonnet-4-6",
		meta: { style: "anthropic-adaptive", adaptive: true, levelMap: { max: "max" }, maxOutputTokens: 128_000 },
	},
	{
		provider: "anthropic",
		prefix: "claude-sonnet-5",
		meta: {
			style: "anthropic-adaptive",
			adaptive: true,
			levelMap: { xhigh: "xhigh", max: "max" },
			maxOutputTokens: 128_000,
		},
	},
	{
		provider: "anthropic",
		prefix: "claude-fable-5",
		meta: {
			style: "anthropic-adaptive",
			adaptive: true,
			levelMap: { off: null, xhigh: "xhigh", max: "max" }, // pi: thinking always on for fable-5
			maxOutputTokens: 128_000,
		},
	},
	// opus-4-1: budget path with pi's own 32k output cap (the 64k default would 400)
	{
		provider: "anthropic",
		prefix: "claude-opus-4-1",
		meta: { style: "anthropic-budget", maxOutputTokens: 32_000 },
	},
	// Claude ≤4.5 + unknown claude ids: the budget path (pi's default)
	{ provider: "anthropic", prefix: "claude-", meta: { style: "anthropic-budget", maxOutputTokens: 64_000 } },
	// ---- openai chat completions ----
	{
		provider: "openai",
		prefix: "glm-5.3",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_53_MAP },
	},
	{
		provider: "openai",
		prefix: "glm-5.2-highspeed",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_52_MAP },
	},
	{
		provider: "openai",
		prefix: "glm-5.2",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_52_MAP },
	},
	{ provider: "openai", prefix: "glm-", meta: { style: "glm-openai" } }, // 4.x / 5-turbo: binary (pi.dev live)
	// #deepseek-provider offline floor (pi.dev live catalog 2026-09-25;
	// v4-pro also carries supportsMidConvoSystemMessages — deliberately not
	// adopted, imp consumes that flag nowhere)
	{
		provider: "deepseek",
		prefix: "deepseek-flash",
		meta: {
			style: "deepseek",
			levelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
		},
	},
	{
		provider: "deepseek",
		prefix: "deepseek-",
		meta: {
			style: "deepseek",
			levelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
		},
	},
	{ provider: "openai", prefix: "deepseek-r", meta: { style: "auto" } },
	// gpt-6 (pi.dev live catalog): off UNAVAILABLE, minimal→low, xhigh/max native
	{
		provider: "openai",
		prefix: "gpt-6",
		meta: {
			style: "openai-effort",
			levelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		},
	},
	// pro variants (pi openai.json): off AND the lower efforts unavailable —
	// sparse ladders (high-only for 5-pro, medium+ for 5.2/5.4/5.5-pro)
	{
		provider: "openai",
		prefix: "gpt-5-pro",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
		},
	},
	{
		provider: "openai",
		prefix: "gpt-5.2-pro",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh" },
		},
	},
	{
		provider: "openai",
		prefix: "gpt-5.4-pro",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh" },
		},
	},
	{
		provider: "openai",
		prefix: "gpt-5.5-pro",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh" },
		},
	},
	{
		provider: "openai",
		prefix: "gpt-5.6",
		meta: {
			style: "openai-effort",
			levelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		},
	},
	// 5.4/5.4-mini/5.5 (pi openai.json): off→"none", minimal out, xhigh native
	{
		provider: "openai",
		prefix: "gpt-5.4",
		meta: {
			style: "openai-effort",
			levelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		},
	},
	{
		provider: "openai",
		prefix: "gpt-5.5",
		meta: {
			style: "openai-effort",
			levelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		},
	},
	{
		provider: "openai",
		prefix: "gpt-5.2",
		meta: {
			style: "openai-effort",
			levelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		},
	},
	{
		provider: "openai",
		prefix: "gpt-5.1",
		meta: {
			style: "openai-effort",
			levelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high" },
		},
	},
	// gpt-5 / 5-mini / 5-nano (pi openai.json): off unavailable, minimal native
	{
		provider: "openai",
		prefix: "gpt-5",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" },
		},
	},
	// o1/o1-pro (pi openai.json): off AND minimal unavailable — low start
	{
		provider: "openai",
		prefix: "o1",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
		},
	},
	// o3/o4 (pi openai.json): off unavailable, minimal unavailable
	{
		provider: "openai",
		prefix: "o3",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
		},
	},
	{
		provider: "openai",
		prefix: "o4",
		meta: {
			style: "openai-effort",
			levelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
		},
	},
	// unknown openai ids (dynamic discovery): conservative off..high
	{ provider: "openai", prefix: "gpt-", meta: { style: "openai-effort" } },
	{ provider: "openai", prefix: "o", meta: { style: "openai-effort" } },
	// ---- zai (Z.ai coding endpoint, openai-completions wire) ----
	// Same GLM ladders as the openai family: pi's zai provider IS the
	// openai-completions api with the zai compat flags.
	{
		provider: "zai",
		prefix: "glm-5.3",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_53_MAP },
	},
	{
		provider: "zai",
		prefix: "glm-5.2-highspeed",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_52_MAP },
	},
	{
		provider: "zai",
		prefix: "glm-5.2",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_52_MAP },
	},
	{ provider: "zai", prefix: "glm-", meta: { style: "glm-openai" } },
	// ---- chatgpt backend responses ----
	{
		provider: "openai-codex",
		prefix: "gpt-6",
		meta: {
			style: "codex-effort",
			levelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		},
	},
	{
		provider: "openai-codex",
		prefix: "gpt-5.6",
		meta: { style: "codex-effort", levelMap: { minimal: "low", xhigh: "xhigh", max: "max" } },
	},
	// pi.dev's pattern for 5.3-spark/5.4/5.5 (+ unknown codex ids)
	{
		provider: "openai-codex",
		prefix: "gpt-",
		meta: { style: "codex-effort", levelMap: { minimal: "low", xhigh: "xhigh" } },
	},
];

/** M14 (#model-catalog): the pi.dev catalog entry for this exact id, mapped
 *  onto ModelThinkingMeta — single source of truth, wins over MODEL_RULES.
 *  null return = "catalog silent, use the prefix rules". */
function catalogThinkingMeta(provider: string, modelId: string): ModelThinkingMeta | null | undefined {
	const entry = catalogEntryFor(provider, modelId);
	if (entry === null) return undefined;
	if (entry.reasoning === false) return null; // no knob (pi semantics)
	let style: ThinkingStyle;
	switch (provider) {
		case "anthropic":
			style = entry.compat?.forceAdaptiveThinking === true ? "anthropic-adaptive" : "anthropic-budget";
			return {
				style,
				adaptive: entry.compat?.forceAdaptiveThinking === true,
				levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap),
				maxOutputTokens: entry.maxTokens,
			};
		case "zai":
			return {
				style: "glm-openai",
				supportsEffort: entry.compat?.supportsReasoningEffort === true,
				levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap),
				maxOutputTokens: entry.maxTokens,
			};
		case "deepseek":
			// parity #6: pi's DETECTED default is true (deepseek is not in the
			// supportsReasoningEffort exclusion list, :1636) and the model compat
			// `??` falls back to it (:1697-1699) — so absent ≠ false. (zai above
			// is the opposite: detected false, absent ≠ true.)
			return {
				style: "deepseek",
				supportsEffort: entry.compat?.supportsReasoningEffort !== false,
				levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap),
				maxOutputTokens: entry.maxTokens,
			};
		case "openai":
			return {
				style: "openai-effort",
				levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap),
				maxOutputTokens: entry.maxTokens,
			};
		case "openai-codex":
			return {
				style: "codex-effort",
				levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap),
				maxOutputTokens: entry.maxTokens,
			};
		default:
			return undefined;
	}
}

/** Keep only the seven ladder levels with string|null values. */
function sanitizeCatalogLevelMap(
	map: Record<string, string | null> | undefined,
): ThinkingLevelMap | undefined {
	if (map === undefined) return undefined;
	const clean: ThinkingLevelMap = {};
	let any = false;
	for (const level of THINKING_LEVELS) {
		const wire = map[level];
		if (typeof wire === "string" || wire === null) {
			clean[level] = wire;
			any = true;
		}
	}
	return any ? clean : undefined;
}

/** The thinking metadata driving a model, or null when the model has no
 *  knob (pi's model.reasoning === false → only "off" is available).
 *  M14: an exact catalog hit outranks the prefix rules; MODEL_RULES is the
 *  frozen offline floor. */
export function thinkingMetaFor(provider: string, modelId: string): ModelThinkingMeta | null {
	const fromCatalog = catalogThinkingMeta(provider, modelId);
	if (fromCatalog !== undefined) return fromCatalog;
	let best: { prefix: string; meta: ModelThinkingMeta } | null = null;
	for (const rule of MODEL_RULES) {
		if (rule.provider !== provider) continue;
		if (!modelId.startsWith(rule.prefix)) continue;
		if (best === null || rule.prefix.length > best.prefix.length) best = rule;
	}
	return best?.meta ?? null;
}

/** Back-compat shim for call sites that only need the family style. */
export function thinkingStyleFor(provider: string, modelId: string): ThinkingStyle | null {
	return thinkingMetaFor(provider, modelId)?.style ?? null;
}

/** pi's getSupportedThinkingLevels (models.ts:663): map-driven. Without a
 *  map, the family default applies (effort/budget styles off..high, binary
 *  styles off/high — xhigh/max need explicit map entries everywhere). */
export function supportedThinkingLevels(meta: ModelThinkingMeta | null): readonly ThinkingLevel[] {
	if (meta === null) return ["off"];
	if (meta.levelMap === undefined) {
		if (meta.style === "anthropic-budget" || meta.style === "anthropic-adaptive")
			return ["off", "minimal", "low", "medium", "high"];
		if (meta.style === "openai-effort" || meta.style === "codex-effort")
			return ["off", "minimal", "low", "medium", "high"];
		return ["off", "high"]; // glm-anthropic / glm-openai / auto: on/off in practice
	}
	return THINKING_LEVELS.filter((level) => {
		const mapped = meta.levelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** pi's clampThinkingLevel semantics (models.ts:679): unavailable target →
 *  nearest available level, searching upward first, then downward. */
export function clampThinkingLevel(meta: ModelThinkingMeta | null, level: ThinkingLevel): ThinkingLevel {
	const available = supportedThinkingLevels(meta);
	if (available.includes(level)) return level;
	const wanted = THINKING_LEVELS.indexOf(level);
	if (wanted === -1) return available[0] ?? "off";
	for (let i = wanted; i < THINKING_LEVELS.length; i++) {
		const candidate = THINKING_LEVELS[i];
		if (candidate !== undefined && available.includes(candidate)) return candidate;
	}
	for (let i = wanted - 1; i >= 0; i--) {
		const candidate = THINKING_LEVELS[i];
		if (candidate !== undefined && available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

/** pi's budget ladder (adjustMaxTokensForThinking defaults), for the
 *  anthropic-budget style. Returns the thinking budget for a level. */
export function anthropicThinkingBudget(level: ThinkingLevel): number {
	switch (level) {
		case "minimal":
			return 1024;
		case "low":
			return 2048;
		case "medium":
			return 8192;
		default:
			return 16384; // high (xhigh/max clamp to high upstream)
	}
}

/** pi: `model.thinkingLevelMap?.[effort] ?? effort` — the wire effort for a
 *  level ≠ "off" (map lookups like codex minimal→"low"). */
export function effortFor(meta: ModelThinkingMeta | null, level: ThinkingLevel): string {
	const mapped = meta?.levelMap?.[level];
	return typeof mapped === "string" ? mapped : level;
}

/** pi's mapThinkingLevelToEffort (anthropic-messages.js:598) for the
 *  adaptive path: mapped value when the model names one, else
 *  minimal/low→"low", medium→"medium", everything else→"high". */
export function adaptiveEffortFor(meta: ModelThinkingMeta | null, level: ThinkingLevel): string {
	const mapped = meta?.levelMap?.[level];
	if (typeof mapped === "string") return mapped;
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		default:
			return "high";
	}
}
