/**
 * Shared cross-module limits. One home so their couplings stay visible:
 * docs/m5-subagents-design.md §4 — the child clock must be re-derived when
 * the child turn budget changes (~45s/turn average with slow tools).
 */

/** Tail cap for oversized tool results (bash output, task results). */
export const MAX_BYTES = 50 * 1024; // 50KB

/** Subagent turn budget (M5). Parent parity — the valve guards runaway spin,
 * not honest work; the true ceiling for heavy jobs is child context
 * exhaustion (no child compaction in M5), which degrades through the task
 * tool's crash path. */
export const CHILD_MAX_TURNS = 40;

/** Subagent wall clock (M5). Scales with CHILD_MAX_TURNS: 40 turns at
 * ~45s/turn average (slow tools) needs ~30 minutes. */
export const CHILD_TIMEOUT_MS = 30 * 60 * 1000;

/** Max concurrent executions per chunk of concurrency-safe calls (M5b).
 *  The cap queues work into waves — it never drops calls — so it trades
 *  turn latency against endpoint pressure and worst-case deterministic
 *  tool_end wait (a fast call reports behind at most cap-1 slow siblings). */
export const MAX_CONCURRENT_TASKS = 5;
