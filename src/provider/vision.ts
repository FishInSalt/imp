/**
 * Vision capability rules (M13 §5). imp has no model catalog, so — like
 * thinking.ts's MODEL_RULES — capability is a prefix table. pi's equivalent
 * is the generated catalog's `input: ("text"|"image")[]`.
 *
 * Default is false (fail-safe): an image sent to a non-vision endpoint
 * 400s the WHOLE request, so an unknown model must degrade, not gamble.
 *
 * z.ai entries verified against official docs (2026-09-20): coding-plan
 * models are GLM-5.3 (text-only flagship) and GLM-5.3-Flash/FlashX
 * (natively multimodal); legacy ids auto-route (glm-5.2/5.1→5.3,
 * glm-4.7→5.3-Flash); GLM-5V-Turbo/GLM-4.6V are separate VLM lines.
 */

import { catalogEntryFor } from "./catalog.js";

export interface VisionRule {
	provider: string;
	/** Model id prefix, compared case-sensitively like thinking.ts. */
	prefix: string;
	vision: boolean;
}

const VISION_RULES: ReadonlyArray<VisionRule> = [
	// deepseek official: V4.1 Flash takes images (pi.dev 2026-09-25; the
	// rest of the line is text-only — no rule → false)
	{ provider: "deepseek", prefix: "deepseek-flash", vision: true },
	// moonshotai / moonshotai-cn official: the current catalog's kimi line
	// (k2.6 / k2.7-code / k3) is uniformly multimodal (pi.dev 2026-09-26);
	// older text-only ids carry no rule → false (the fail-safe default).
	{ provider: "moonshotai", prefix: "kimi-k3", vision: true },
	{ provider: "moonshotai", prefix: "kimi-k2.6", vision: true },
	{ provider: "moonshotai", prefix: "kimi-k2.7-code", vision: true },
	{ provider: "moonshotai-cn", prefix: "kimi-k3", vision: true },
	{ provider: "moonshotai-cn", prefix: "kimi-k2.6", vision: true },
	{ provider: "moonshotai-cn", prefix: "kimi-k2.7-code", vision: true },
	// zai: exact vision-capable families first (5.3-flash covers -flashx),
	// then the blanket text-only rule for the rest of the glm line.
	{ provider: "zai", prefix: "glm-5.3-flash", vision: true },
	{ provider: "zai", prefix: "glm-5v", vision: true },
	{ provider: "zai", prefix: "glm-4.6v", vision: true },
	{ provider: "zai", prefix: "glm-", vision: false },
	// Anthropic: current claude line is uniformly multimodal.
	{ provider: "anthropic", prefix: "claude-", vision: true },
	// OpenAI chat-completions line.
	{ provider: "openai", prefix: "gpt-4o", vision: true },
	{ provider: "openai", prefix: "gpt-4.1", vision: true },
	{ provider: "openai", prefix: "gpt-4.5", vision: true },
	{ provider: "openai", prefix: "gpt-5", vision: true },
	{ provider: "openai", prefix: "o3", vision: true },
	{ provider: "openai", prefix: "o4", vision: true },
	// Codex (responses API) rides gpt-5-codex — vision-capable per OpenAI
	// docs. Keyed "openai-codex" to match resolve.ts's ProviderName: the
	// read tool's getter passes the RUNNER's providerName, and a mismatch
	// here meant the non-vision note lied on codex models (review P1).
	{ provider: "openai-codex", prefix: "gpt-5-codex", vision: true },
	{ provider: "openai-codex", prefix: "gpt-5", vision: true },
];

/** Does this (provider, model) accept image input? Unknown → false.
 *  M14 (#model-catalog): an exact pi.dev catalog hit wins — its `input`
 *  array IS pi's capability statement; the prefix table is the frozen
 *  offline floor (and the anthropic-compat gateway's only source). */
export function modelSupportsVision(provider: string, model: string): boolean {
	const entry = catalogEntryFor(provider, model);
	if (entry?.input !== undefined) return entry.input.includes("image");
	for (const rule of VISION_RULES) {
		if (rule.provider === provider && model.startsWith(rule.prefix)) return rule.vision;
	}
	return false;
}
