/**
 * The Moonshot / Kimi provider families (#moonshotai-provider): Moonshot's
 * official OpenAI-compatible endpoints — pi's own connection paths
 * (packages/ai/src/providers/moonshotai.ts and moonshotai-cn.ts):
 *
 *   moonshotai     https://api.moonshot.ai/v1  (open platform, overseas)
 *   moonshotai-cn  https://api.moonshot.cn/v1  (open platform, China)
 *   auth           MOONSHOT_API_KEY (bearer; a stored /login key wins —
 *                  pi's envApiKeyAuth order; both families share the env var,
 *                  the stored keys are per family)
 *
 * The wire itself is imp's openai-completions provider — this module only
 * fixes the defaults (endpoints, family key resolution) and the provider
 * NAMES, which the thinking catalog keys off (per-model compat decides the
 * style: "deepseek" thinking {type} for k2.x, "openai" reasoning_effort for
 * k3 — see thinking.ts's moonshot case).
 */
import { resolveApiKey } from "./auth-store.js";
import { createOpenAICompletionsProvider } from "./openai-completions.js";
import type { LLMProvider } from "./types.js";

export const MOONSHOT_DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

/** pi.dev live catalog (2026-09-26, catalog order) — the offline floor /
 *  discovery seeds. */
export const MOONSHOT_SEED_MODELS = [
	"kimi-k2.6",
	"kimi-k2.7-code",
	"kimi-k2.7-code-highspeed",
	"kimi-k3",
] as const;

export function createMoonshotProvider(): LLMProvider {
	// MOONSHOT_BASE_URL overrides (#gateway-truth; DEEPSEEK_BASE_URL precedent)
	return createOpenAICompletionsProvider({
		baseUrl: process.env.MOONSHOT_BASE_URL ?? MOONSHOT_DEFAULT_BASE_URL,
		// deepseek §2.5 shape: auth only — never the OPENAI_API_KEY fallback
		auth: { family: "moonshotai", envVar: "MOONSHOT_API_KEY" },
		name: "moonshotai",
	});
}

export function createMoonshotCnProvider(): LLMProvider {
	return createOpenAICompletionsProvider({
		baseUrl: process.env.MOONSHOT_CN_BASE_URL ?? MOONSHOT_CN_DEFAULT_BASE_URL,
		auth: { family: "moonshotai-cn", envVar: "MOONSHOT_API_KEY" },
		name: "moonshotai-cn",
	});
}

/** The bearer key — a stored /login credential wins over MOONSHOT_API_KEY
 *  (pi's envApiKeyAuth order), null when neither is present. The single
 *  resolution used by the provider, discovery, familyConfigured, and the
 *  runner teaching gates. */
export function moonshotApiKey(): string | null {
	return resolveApiKey("moonshotai", "MOONSHOT_API_KEY")?.key ?? null;
}

export function moonshotCnApiKey(): string | null {
	return resolveApiKey("moonshotai-cn", "MOONSHOT_API_KEY")?.key ?? null;
}
