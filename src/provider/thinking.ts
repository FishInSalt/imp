/**
 * Thinking levels (#thinking-levels, pi parity 2026-09-10).
 *
 * pi's model: one 7-level ladder (agent/types.ts ThinkingLevel) that every
 * provider maps to its native knob — anthropic budget_tokens/adaptive
 * effort, OpenAI reasoning_effort, codex reasoning.effort, GLM's
 * thinking:{type:enabled}. imp keeps the same ladder and the same
 * clamp-to-nearest semantics, with a static per-family style table standing
 * in for pi's per-model thinkingLevelMap catalogs.
 */

/** pi's ladder, in order. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** How a model's thinking knob is driven, per protocol family. */
export type ThinkingStyle =
	/** Claude Messages API: budget_tokens (pi's non-adaptive path; the
	 *  budgets are pi's adjustMaxTokensForThinking defaults). */
	| "anthropic-budget"
	/** Z.ai GLM on the Anthropic-compat endpoint: thinking {type:enabled}.
	 *  The knob is binary in practice — every non-off level maps to
	 *  enabled (ledgered deviation from the 7-level ladder). */
	| "glm-anthropic"
	/** OpenAI Chat Completions: reasoning_effort (gpt-5*, o-series). */
	| "openai-effort"
	/** Z.ai GLM on the OpenAI-compatible endpoint: thinking {type:enabled}
	 *  body param (their native form; reasoning_effort is not accepted). */
	| "glm-openai"
	/** OpenAI Responses protocol (codex): reasoning {effort}. */
	| "codex-effort"
	/** DeepSeek-reasoner style: the model reasons by default, no request
	 *  parameter — reasoning_content arrives unrequested. Levels beyond
	 *  off are cosmetic placeholders (clamped display only). */
	| "auto";

/** Static family table. Bare ids route to anthropic (resolve.ts); the
 *  provider argument disambiguates openai/ vs openai-codex/ vs anthropic/.
 *  Prefix matches run longest-first; null = no thinking control. */
const STYLE_RULES: ReadonlyArray<{ provider: string; prefix: string; style: ThinkingStyle }> = [
	// anthropic protocol: GLM via Z.ai's compat endpoint, everything else Claude
	{ provider: "anthropic", prefix: "glm-", style: "glm-anthropic" },
	{ provider: "anthropic", prefix: "claude-", style: "anthropic-budget" },
	// OpenAI Chat Completions (incl. OPENAI_BASE_URL vendors)
	{ provider: "openai", prefix: "glm-", style: "glm-openai" },
	{ provider: "openai", prefix: "deepseek-r", style: "auto" },
	{ provider: "openai", prefix: "gpt-", style: "openai-effort" },
	{ provider: "openai", prefix: "o", style: "openai-effort" },
	// ChatGPT-subscription Responses protocol
	{ provider: "openai-codex", prefix: "gpt-", style: "codex-effort" },
	{ provider: "openai-codex", prefix: "o", style: "codex-effort" },
];

/** The thinking style driving a model, or null when the model has no knob
 *  (pi's model.reasoning === false → only "off" is available). */
export function thinkingStyleFor(provider: string, modelId: string): ThinkingStyle | null {
	let best: { prefix: string; style: ThinkingStyle } | null = null;
	for (const rule of STYLE_RULES) {
		if (rule.provider !== provider) continue;
		if (!modelId.startsWith(rule.prefix)) continue;
		if (best === null || rule.prefix.length > best.prefix.length) best = rule;
	}
	return best?.style ?? null;
}

/** Levels the ladder offers for a style. The budget/effort protocols cap at
 *  "high" — xhigh/max are newer than every knob imp drives (pi exposes them
 *  only via per-model maps imp does not carry). GLM and auto are binary. */
export function supportedThinkingLevels(style: ThinkingStyle): readonly ThinkingLevel[] {
	if (style === "anthropic-budget" || style === "openai-effort" || style === "codex-effort") {
		return ["off", "minimal", "low", "medium", "high"];
	}
	return ["off", "high"]; // glm-anthropic / glm-openai / auto: on/off in practice
}

/** pi's clampThinkingLevel semantics: unavailable target → nearest
 *  available level, searching upward first, then downward. */
export function clampThinkingLevel(style: ThinkingStyle | null, level: ThinkingLevel): ThinkingLevel {
	if (style === null) return "off";
	const available = supportedThinkingLevels(style);
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

/** The reasoning_effort value for the effort styles (level ≠ "off"). */
export function effortFor(level: ThinkingLevel): string {
	return level === "xhigh" || level === "max" ? "high" : level;
}
