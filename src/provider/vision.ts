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

export interface VisionRule {
	provider: string;
	/** Model id prefix, compared case-sensitively like thinking.ts. */
	prefix: string;
	vision: boolean;
}

const VISION_RULES: ReadonlyArray<VisionRule> = [
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
	// Codex (responses API) rides gpt-5-codex — vision-capable per OpenAI docs.
	{ provider: "codex", prefix: "gpt-5-codex", vision: true },
	{ provider: "codex", prefix: "gpt-5", vision: true },
];

/** Does this (provider, model) accept image input? Unknown → false. */
export function modelSupportsVision(provider: string, model: string): boolean {
	for (const rule of VISION_RULES) {
		if (rule.provider === provider && model.startsWith(rule.prefix)) return rule.vision;
	}
	return false;
}
