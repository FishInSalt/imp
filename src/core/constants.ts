/**
 * Shared cross-module limits. One home so their couplings stay visible.
 */

/** Tail cap for oversized tool results (bash output, task results). */
export const MAX_BYTES = 50 * 1024; // 50KB

/** Subagent turn wall (#subagent-softlanding rev 4, demoted from budget to
 *  backup: guards degenerate loops only — budget decisions belong to the
 *  parent agent, and zero prompts are injected into the child). Children
 *  auto-compact between turns like the main loop (M7), so the practical
 *  ceiling for honest work is the parent's judgment, not this wall. */
export const CHILD_MAX_TURNS = 60;

/** Default child wall clock (#subagent-softlanding rev 4). REPL (TTY): no
 *  clock — the user's Ctrl+C is the backstop. Print/headless runs: a
 *  generous 60-minute hang guard (the turn wall does not tick while a
 *  single tool call hangs; pi-subagents keeps a default clock for
 *  unsupervised children for exactly this reason). Call-level timeoutMs /
 *  agent frontmatter always win over this default. Returns `undefined`
 *  under TTY — `undefined` IS the "unlimited" sentinel through the whole
 *  timeout seam (never Infinity: AbortSignal.timeout(Infinity) throws). */
export function defaultChildTimeoutMs(): number | undefined {
	return process.stdout.isTTY ? undefined : 60 * 60 * 1000;
}

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
