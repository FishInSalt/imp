import { createAnthropicProvider } from "./anthropic.js";
import { createCodexResponsesProvider } from "./codex-responses.js";
import { createOpenAICompletionsProvider } from "./openai-completions.js";
import type { LLMProvider } from "./types.js";

/**
 * Model reference parsing + provider routing (#multi-provider).
 *
 * A model reference is either a bare id ( routed to the default provider,
 * anthropic — this keeps every existing config, session file, and env var
 * byte-identical) or a canonical `provider/model` id:
 *
 *   openai/gpt-5.2            → OpenAI Chat Completions (OPENAI_API_KEY)
 *   openai/deepseek-chat      → any OpenAI-compatible endpoint via OPENAI_BASE_URL
 *   anthropic/glm-4.6         → explicit anthropic-messages routing (equivalent to glm-4.6)
 *   openai-codex/gpt-5.5      → Responses protocol on the ChatGPT-subscription
 *                               credential (imp login; see codex-auth.ts)
 *
 * This is the seed of the full registry (contextWindow per model, picker,
 * session persistence) — deliberately a pure function with no state.
 */

export type ProviderName = "anthropic" | "openai" | "openai-codex";

export interface ModelRef {
	provider: ProviderName;
	/** The id the wire protocol expects (prefix stripped). */
	modelId: string;
}

export function parseModelRef(reference: string): ModelRef {
	const slash = reference.indexOf("/");
	if (slash === -1) return { provider: "anthropic", modelId: reference };
	const provider = reference.slice(0, slash);
	const modelId = reference.slice(slash + 1);
	if (modelId === "") return { provider: "anthropic", modelId: reference };
	if (provider === "anthropic") return { provider: "anthropic", modelId };
	if (provider === "openai") return { provider: "openai", modelId };
	if (provider === "openai-codex") return { provider: "openai-codex", modelId };
	// Unknown prefix (e.g. a model id that legitimately contains a slash,
	// like some OpenRouter or Bedrock ids): treat the whole string as a bare
	// anthropic id — same behavior as before this module existed.
	return { provider: "anthropic", modelId: reference };
}

export function createProviderFor(provider: ProviderName): LLMProvider {
	switch (provider) {
		case "anthropic":
			return createAnthropicProvider();
		case "openai":
			return createOpenAICompletionsProvider();
		case "openai-codex":
			return createCodexResponsesProvider();
		default: {
			const exhaustive: never = provider;
			throw new Error(`unreachable provider: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** Resolve a model reference into (provider, wire model id). */
export function resolveModel(reference: string): { provider: LLMProvider; modelId: string } {
	const ref = parseModelRef(reference);
	return { provider: createProviderFor(ref.provider), modelId: ref.modelId };
}
