/**
 * Shared cross-module limits. One home so their couplings stay visible:
 * docs/m5-subagents-design.md §4 — the child clock must be re-derived when
 * the child turn budget changes (~45s/turn average with slow tools).
 */

/** Tail cap for oversized tool results (bash output, task results). */
export const MAX_BYTES = 50 * 1024; // 50KB

/** Subagent turn budget (M5). Parent parity — the valve guards runaway spin,
 * not honest work. Children auto-compact between turns like the main loop
 * (M7), so the practical ceiling is this turn cap, not context space. */
export const CHILD_MAX_TURNS = 40;

/** Subagent wall clock (M5). Scales with CHILD_MAX_TURNS: 40 turns at
 * ~45s/turn average (slow tools) needs ~30 minutes. */
export const CHILD_TIMEOUT_MS = 30 * 60 * 1000;

/** Max concurrent executions per chunk of concurrency-safe calls (M5b).
 *  The cap queues work into waves — it never drops calls — so it trades
 *  turn latency against endpoint pressure and worst-case deterministic
 *  tool_end wait (a fast call reports behind at most cap-1 slow siblings). */
export const MAX_CONCURRENT_TASKS = 5;

/** Footer/status context window: IMP_CONTEXT_WINDOW when it parses to a
 *  positive finite number, otherwise the same 131072 default the compaction
 *  settings use. Read per call so env changes take effect immediately. */
export function contextWindowTokens(): number {
	const raw = process.env.IMP_CONTEXT_WINDOW;
	if (raw === undefined || raw === "") return 131072;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 131072;
}
