import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "../core/compaction.js";
import { contextWindowInfoFor } from "./models.js";

/** Resolve automatic-compaction policy without changing the summary reserve.
 * Unknown windows retain the legacy threshold; known windows compact at 85%
 * or with the full reserve remaining, whichever is earlier. Tiny windows use
 * a positive ratio threshold because the full reserve cannot fit. */
export function compactionSettingsFor(reference: string): CompactionSettings {
	const { contextWindow, source } = contextWindowInfoFor(reference);
	const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	const ratioThreshold = Math.floor(0.85 * contextWindow);
	const triggerTokens =
		source === "fallback"
			? contextWindow - reserveTokens
			: contextWindow > reserveTokens
				? Math.min(ratioThreshold, contextWindow - reserveTokens)
				: Math.max(1, ratioThreshold);
	return { ...DEFAULT_COMPACTION_SETTINGS, contextWindow, triggerTokens };
}
