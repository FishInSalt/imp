# Model-aware automatic compaction threshold

## Goal

Trigger automatic compaction earlier for large known model windows without changing manual compaction, summary output budgets, or overflow recovery.

## Policy

For a known effective context window W and the existing 16,384-token reserve:

- W > 16,384: threshold = min(floor(0.85 * W), W - 16,384).
- W <= 16,384: threshold = max(1, floor(0.85 * W)); this avoids nonpositive thresholds, but does not guarantee summarization can fit tiny windows.
- Unknown model with no override: retain the 131,072-token fallback window and 114,688-token threshold.
- Trigger only when estimated context tokens are strictly greater than the threshold.
- A valid IMP_CONTEXT_WINDOW override counts as known, even for an unknown model.

## Implementation

Add a provenance-aware context-window resolver in provider/models.ts, preserving current precedence: environment, catalog, discovery, static table, fallback. Retain contextWindowFor as a number-returning wrapper. Do not infer provenance from the numeric window.

Add optional triggerTokens to CompactionSettings. shouldCompact uses it when present, otherwise preserves the existing contextWindow - reserveTokens behavior for explicitly injected settings. reserveTokens remains unchanged; summary output budget calculations must not depend on the ratio.

Add a shared model-aware compaction-settings factory (in a separate provider module importing models and compaction, avoiding a core compaction -> provider cycle). Use it at Runner construction and model switch, and for default subagent settings using the child's actual model. Explicitly injected subagent settings stay authoritative. Preserve existing per-run model/provider/settings snapshots; refreshing catalog metadata during a run is out of scope.

Carry a separate provider-qualified modelReference into subagent settings resolution; keep the wire model argument unchanged. TaskToolOptions gains an optional getModelReference getter, supplied by Runner using its actual provider and model. Inherited children use that reference. Bare agent model overrides retain the current provider prefix. Explicit overrides with the same provider use their reference; explicit cross-provider overrides retain legacy fallback settings, since task does not currently route providers for profiles. Do not pretend such overrides are routed correctly. Standalone runSubagent callers may provide modelReference, otherwise their model argument remains the lookup reference. Tests must cover a shared model ID across two providers and bare profile overrides.

Manual /compact, branch summaries, compaction timing, token estimation, recent-tail retention, and overflow retry behavior remain unchanged. No user configuration or session migration is needed.

## Verification

- Resolver tests cover precedence and known 131,072 versus unknown fallback, including environment overrides.
- Threshold boundary tests cover large windows, reserve-dominated windows, tiny windows, unknown models, and strict comparison.
- Verify ratio thresholds do not change summary output budgets.
- Verify Runner initialization/model switching and default child settings, preserving explicit child settings.
- Run typecheck, lint, build, and all tests, without live model APIs or real user session edits.
- Independent adversarial design review before implementation and independent code review afterward.
