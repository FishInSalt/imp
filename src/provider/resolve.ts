import { createAnthropicProvider } from "./anthropic.js";
import { createCodexResponsesProvider } from "./codex-responses.js";
import { createOpenAICompletionsProvider } from "./openai-completions.js";
import type { LLMProvider } from "./types.js";
import { createZaiProvider } from "./zai.js";

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
 * session persistence). #glm-retire: bare glm-* ids route to zai
 * UNCONDITIONALLY (pi has no glm special-casing — zai is the one
 * official GLM path); a missing credential teaches at runner level, it
 * no longer silently falls back to anthropic-compat. parseModelRef is
 * pure string routing again.
 */

export type ProviderName = "anthropic" | "openai" | "openai-codex" | "zai";

export interface ModelRef {
	provider: ProviderName;
	/** The id the wire protocol expects (prefix stripped). */
	modelId: string;
}

export function parseModelRef(reference: string): ModelRef {
	// Trim + case-insensitive prefix matching (review P2-6): "OpenAI/gpt-5.2"
	// or " openai/gpt-5.2" used to fall through to a bare anthropic id and
	// surface as a delayed 404 on the next turn — near-miss prefixes of KNOWN
	// families are typos, not exotic ids.
	const trimmed = reference.trim();
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		// pi parity: GLM's ONE official path is the zai provider (coding
		// endpoint, openai-completions). A bare glm-* id routes there
		// UNCONDITIONALLY (#glm-retire: the credential-less fallback to
		// anthropic-compat is gone — /login zai replaced it; the runner
		// teaches when the credential is missing). Explicit prefixes
		// (zai/glm-…, anthropic/glm-…, openai/glm-…) always win.
		if (trimmed.toLowerCase().startsWith("glm-")) {
			return { provider: "zai", modelId: trimmed };
		}
		return { provider: "anthropic", modelId: trimmed };
	}
	const provider = trimmed.slice(0, slash).toLowerCase();
	const modelId = trimmed.slice(slash + 1);
	if (modelId === "") return { provider: "anthropic", modelId: trimmed };
	if (provider === "anthropic") return { provider: "anthropic", modelId };
	if (provider === "openai") return { provider: "openai", modelId };
	if (provider === "openai-codex") return { provider: "openai-codex", modelId };
	if (provider === "zai") return { provider: "zai", modelId };
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
		case "zai":
			return createZaiProvider();
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
