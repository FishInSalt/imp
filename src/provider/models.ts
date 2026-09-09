/**
 * Static model registry (#multi-provider batch 2): the per-model context
 * window, sourced from pi's auto-generated provider catalogs (which track the
 * live APIs) rather than guesswork. imp default-model users get correct
 * auto-compaction thresholds for the first time; unknown models fall back to
 * the historical 128K default — conservative in the safe direction (compaction
 * fires earlier than strictly necessary, never later).
 *
 * IMP_CONTEXT_WINDOW still wins over everything, as before.
 */

import { discoveredWindowFor } from "./discover.js";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	// Anthropic (pi anthropic.json catalog)
	"claude-sonnet-4-5": 1_000_000,
	"claude-sonnet-4-6": 1_000_000,
	"claude-sonnet-5": 1_000_000,
	"claude-haiku-4-5": 200_000,
	"claude-opus-4-5": 200_000,
	"claude-opus-4-6": 1_000_000,
	"claude-opus-4-8": 1_000_000,
	// Z.ai GLM via the Anthropic-compat endpoint (pi zai.json; the 4.x series
	// is documented at 200K)
	"glm-4.5": 200_000,
	"glm-4.6": 200_000,
	"glm-4.7": 204_800,
	"glm-5-turbo": 200_000,
	// z.ai current GLM-5.x line (pi.dev zai catalog, 2026-09)
	"glm-5.2": 1_000_000,
	"glm-5.2-highspeed": 1_000_000,
	"glm-5.3": 1_000_000,
	"glm-5.3-flash": 1_000_000,
	"glm-5.3-highspeed": 1_000_000,
	// OpenAI Codex — ChatGPT subscription models (pi openai-codex.json)
	"gpt-6-astra": 272_000, // pi.dev catalog 2026-09
	"gpt-5.3-codex-spark": 128_000,
	"gpt-5.4": 272_000,
	"gpt-5.4-mini": 272_000,
	"gpt-5.5": 272_000,
	"gpt-5.6-luna": 272_000,
	"gpt-5.6-sol": 272_000,
	"gpt-5.6-terra": 272_000,
};

export const DEFAULT_CONTEXT_WINDOW = 131_072;

// circular-safe: discover.js owns the runtime map; import lazily via type-only + accessor

let envWarned = false;

function envInt(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (Number.isFinite(n) && n > 0) return n;
	// Invalid values warn once and are IGNORED (fall through to the registry) —
	// aligned with constants.ts's old contract rather than silently diverging
	// between the footer and the compaction gate (review P2-8).
	if (!envWarned) {
		envWarned = true;
		process.stderr.write(`imp: ignoring invalid ${name}=${JSON.stringify(raw)} (not a positive number)\n`);
	}
	return undefined;
}

/**
 * The effective context window for a model reference (canonical or bare).
 * Priority: IMP_CONTEXT_WINDOW > registry lookup (prefix stripped) > default.
 */
export function contextWindowFor(reference: string): number {
	const env = envInt("IMP_CONTEXT_WINDOW");
	if (env !== undefined) return env;
	const slash = reference.indexOf("/");
	const modelId = slash === -1 ? reference : reference.slice(slash + 1);
	// env > runtime-enriched (discovery metadata) > static table > default
	return discoveredWindowFor(modelId) ?? MODEL_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
}
