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

/** imp's built-in tool names (M18: moved here from extensions/registry so the
 *  MCP bridge shares the exact same hand list — the M16 P1 lesson was this
 *  list drifting between checkers, letting an extension register `ls` over
 *  the builtin. Order preserved from the registry original — error strings
 *  join this list and their goldens pin it.) */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"task",
];

/** Tool and command names (extensions AND MCP-bridged tools) must match
 *  this (design §9; M18: single home — registry and the MCP bridge share it). */
export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
