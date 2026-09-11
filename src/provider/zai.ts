/**
 * The zai provider family (#thinking-levels batch 3): Z.ai's GLM coding
 * endpoint on the OpenAI Chat Completions protocol — pi's own connection
 * path (packages/ai/src/providers/zai.ts):
 *
 *   baseUrl  https://api.z.ai/api/coding/paas/v4   (coding-plan endpoint)
 *   auth     ZAI_API_KEY (bearer)
 *   compat   thinkingFormat "zai" (the native thinking object), zaiToolStream
 *            (tool_stream: true when tools are present), max_tokens field,
 *            no store, no developer role.
 *
 * The wire itself is imp's openai-completions provider — this module only
 * fixes the defaults (endpoint, key, zai compat flags) and the provider
 * NAME, which the thinking model catalog keys off (glm-* rules).
 */
import { createOpenAICompletionsProvider } from "./openai-completions.js";
import type { LLMProvider } from "./types.js";

export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/** pi.dev live catalog (2026-09) — the ids Z.ai's coding endpoint serves. */
export const ZAI_SEED_MODELS = [
	"glm-4.7",
	"glm-5-turbo",
	"glm-5.2",
	"glm-5.2-highspeed",
	"glm-5.3",
	"glm-5.3-flash",
	"glm-5.3-highspeed",
] as const;

export function createZaiProvider(): LLMProvider {
	// ZAI_BASE_URL overrides (the CN mirror: https://open.bigmodel.cn/api/coding/paas/v4)
	return createOpenAICompletionsProvider({
		baseUrl: process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE_URL,
		apiKey: process.env.ZAI_API_KEY,
		// provider name drives the thinking catalog's zai rules
		name: "zai",
		// pi compat.zaiToolStream: request Z.ai's streaming tool dialect
		zaiToolStream: true,
	});
}

/** The bearer key for discovery requests (null when unconfigured). */
export function zaiApiKey(): string | null {
	return process.env.ZAI_API_KEY ?? null;
}
