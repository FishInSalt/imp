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
	| "auto"; // deepseek-reasoner: reasons by default, no request knob

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

/** The glm-5.2 zai map (pi zai.json): low/medium/high all map to "high"
 *  effort; max is native; minimal is unavailable. Carried forward to the
 *  5.3 series (pi's catalog has no 5.3 entry yet — ledgered extrapolation). */
const GLM_ZAI_EFFORT_MAP: ThinkingLevelMap = {
	minimal: null,
	low: "high",
	medium: "high",
	high: "high",
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
	// Claude ≤4.5 + unknown claude ids: the budget path (pi's default)
	{ provider: "anthropic", prefix: "claude-", meta: { style: "anthropic-budget", maxOutputTokens: 64_000 } },
	// ---- openai chat completions ----
	{
		provider: "openai",
		prefix: "glm-5.3",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_ZAI_EFFORT_MAP },
	},
	{ provider: "openai", prefix: "glm-5.2-highspeed", meta: { style: "glm-openai" } },
	{
		provider: "openai",
		prefix: "glm-5.2",
		meta: { style: "glm-openai", supportsEffort: true, levelMap: GLM_ZAI_EFFORT_MAP },
	},
	{ provider: "openai", prefix: "glm-", meta: { style: "glm-openai" } }, // 4.x / 5-turbo: binary (pi zai.json)
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

/** The thinking metadata driving a model, or null when the model has no
 *  knob (pi's model.reasoning === false → only "off" is available). */
export function thinkingMetaFor(provider: string, modelId: string): ModelThinkingMeta | null {
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
