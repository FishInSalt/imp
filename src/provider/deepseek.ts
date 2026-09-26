/**
 * The deepseek provider family (#deepseek-provider): DeepSeek's official
 * endpoint on the OpenAI Chat Completions protocol — pi's own connection
 * path (packages/ai/src/providers/deepseek.ts):
 *
 *   baseUrl  https://api.deepseek.com   (no /v1 suffix — the docs' base)
 *   auth     DEEPSEEK_API_KEY (bearer; a stored /login key wins, pi's
 *            envApiKeyAuth order)
 *   compat   thinkingFormat "deepseek" (thinking {type} + reasoning_effort),
 *            max_tokens field, no store, no developer role, and assistant
 *            messages replay reasoning_content (V4 interleaved thinking
 *            requires it on tool-call continuations — pi
 *            openai-completions.ts:1357-1361).
 *
 * The wire itself is imp's openai-completions provider — this module fixes
 * the defaults (endpoint, family key resolution) and the provider NAME,
 * which the thinking catalog keys off (deepseek-* rules).
 */
import { resolveApiKey } from "./auth-store.js";
import { createOpenAICompletionsProvider } from "./openai-completions.js";
import type { LLMProvider } from "./types.js";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/** pi.dev live catalog (2026-09-25) — the offline floor / discovery seeds. */
export const DEEPSEEK_SEED_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;

export function createDeepSeekProvider(): LLMProvider {
	// DEEPSEEK_BASE_URL overrides (ZAI_BASE_URL precedent; #gateway-truth
	// discovery keys off its presence)
	return createOpenAICompletionsProvider({
		baseUrl: process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
		// P2-6: auth only — never the OPENAI_API_KEY fallback (design §2.5;
		// zai's fallback is the recorded D2 legacy, deepseek does not inherit it)
		auth: { family: "deepseek", envVar: "DEEPSEEK_API_KEY" },
		name: "deepseek",
	});
}

/** The bearer key — a stored /login credential wins over DEEPSEEK_API_KEY
 *  (pi's envApiKeyAuth order), null when neither is present. The single
 *  resolution used by the provider, discovery, and familyConfigured. */
export function deepseekApiKey(): string | null {
	return resolveApiKey("deepseek", "DEEPSEEK_API_KEY")?.key ?? null;
}
