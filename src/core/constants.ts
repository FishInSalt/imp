/**
 * Shared cross-module limits. One home so their couplings stay visible.
 */

/** Tail cap for oversized tool results (bash output, task results). */
export const MAX_BYTES = 50 * 1024; // 50KB

/** #output-truncation D3: per-turn output budget used when the model catalog
 *  has no value for the model (offline first-run, unknown models). The CLI
 *  fills its --max-tokens default with this; the runner falls back to the
 *  option value when catalog resolution comes up empty. */
export const DEFAULT_MAX_TOKENS = 16384;

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

/** Max concurrent executions within one concurrency-safe run (M5b; renamed
 *  #sliding-window — it caps every concurrency-safe call, not just `task`).
 *  The cap queues work — it never drops calls — so it trades turn latency
 *  against endpoint pressure. Enforced by the sliding window: any moment
 *  runs at most this many calls; a released slot immediately admits the
 *  next queued call in call order. */
export const MAX_CONCURRENT_SAFE_CALLS = 5;

/** #abort-grace: after the user aborts (Ctrl+C), a tool call that ignores
 *  its AbortSignal gets this long to settle on its own; at the deadline the
 *  host synthesizes an isError result and finishes the run (rescuing the
 *  waiter, not the culprit — the hung promise stays in the background).
 *  Not a hard timeout: the window exists ONLY after the signal aborted, so
 *  legitimate long-running work (a 20-minute build) is never interrupted
 *  until the user asks. Constant, no env knob (same policy as the cap). */
export const ABORT_GRACE_MS = 10_000;

/** Ink's built-in tool names (M18: moved here from extensions/registry so the
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
