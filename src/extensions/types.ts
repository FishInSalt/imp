/**
 * The extension contract (M4 design §5/§6): an extension is a plain ESM
 * module (`.mjs`, or `.js` under a module-typed package) whose default export
 * is a factory receiving one thin api object.
 *
 * Layering: this file describes the entire surface; the one edge that touches
 * core runs extensions → core only — `ToolCallDecision` is declared in
 * core/loop.ts (next to the option that consumes it) and re-exported here for
 * extension authors. `src/core/` imports nothing from `src/extensions/`.
 */
import type { ToolCallDecision } from "../core/loop.js";
import type { AssistantMessage, Usage } from "../core/messages.js";
import type { Tool } from "../core/tools/types.js";
import type { SlashCommand } from "../repl/commands.js";
import type { ToolColor } from "../repl/tool-colors.js";

export type {
	Tool,
	ToolArgumentPresentationField,
	ToolCallPresentationContext,
	ToolPresentationHooks,
	ToolPresentationValue,
	ToolResultPresentationContext,
	ToolSemanticPresentation,
	ToolSourcePresentation,
} from "../core/tools/types.js";
export type { ToolCallDecision };

/** Where an extension was discovered (M4 design §3.1). */
export type ExtensionOrigin = "cli" | "project" | "global";

/** SA-06: identity of one loaded extension module — entry file canonical path
 *  plus content hash; consumed by the child launch record via the runner. */
export interface ExtensionModuleIdentity {
	name: string;
	origin: ExtensionOrigin;
	path: string;
	sha256: string;
}

/** SA-06: a registered extension context section, identified by its content
 *  hash (registration order is part of the identity). */
export interface ExtensionContextIdentity {
	id: string;
	sha256: string;
}

/** #confirm-prompt (Phase 2 D7): an extension-supplied command preview. Only
 *  "command" exists; unknown kinds, non-string fields, and empty values render
 *  nothing. Offsets are plain — the host owns color. */
export interface CommandPreview {
	kind: "command";
	/** Tool name for the header, e.g. "bash". */
	tool: string;
	/** The command text itself. */
	text: string;
	/** [start, end) offsets into `text` to alert-highlight. */
	warnSpans?: Array<[number, number]>;
}

/** Options bag for api.confirm — additive, all-optional (M10). */
export interface ConfirmOptions {
	/** Host-side session memory: a key the user previously approved via
	 *  "don't ask again this session" short-circuits to approval without
	 *  prompting again. Extensions pick the key's granularity (e.g. the
	 *  matched rule, the target directory). */
	sessionKey?: string;
	/** Character ranges ([start, end), 0-based) within `detail` to render
	 * as an alert highlight. Extensions declare plain offsets — never ANSI —
	 * and only color-capable hosts (the TUI confirm picker) apply them;
	 * every other surface shows the detail verbatim. Out-of-range clips,
	 * overlaps merge. */
	warnSpans?: Array<[number, number]>;
	/** What "don't ask again this session" will remember, in the extension's own
	 *  words (e.g. "this command pattern", "this directory"). The host renders
	 *  it inside the remember option's label; absent → the stock wording.
	 *  The remember option itself appears only when `sessionKey` is present —
	 *  without a key there is no memory to offer (fresh fallbacks render
	 *  plain Yes/No). */
	rememberLabel?: string;
	/** The request being decided, rendered in the transcript's call-header idiom
	 *  instead of prose. The host sanitizes both fields, styles `warnSpans` with
	 *  its own alert color, and shows the command exactly once on every surface:
	 *  in the picker where one exists, as one plain note (newlines preserved)
	 *  otherwise. */
	preview?: CommandPreview;
	/** Deadline in milliseconds for hearing an answer (#ask-timeout). The
	 *  host starts the clock when the question becomes actually visible — a
	 *  queued question (blocked behind another picker) does not count down —
	 *  and resolves it as "timeout" when the deadline passes unanswered.
	 *  Positive finite numbers only; anything else is ignored, and values
	 *  beyond the platform timer ceiling wait the ceiling — a huge deadline
	 *  clamps, it never overflows into an instant fire. Capability-gated like
	 *  every interactive affordance: hosts without a picker (print mode, the
	 *  legacy readline shell) ignore the deadline entirely. */
	timeoutMs?: number;
}

/**
 * The extension api: three read-only facts, five registration methods, one
 * subscriber, one status setter, one ask-the-human method — eleven members.
 * Anything an extension cannot do with this, it cannot do.
 */
export interface ExtensionApi {
	/** Absolute working directory Ink was started in. */
	readonly cwd: string;
	/** Ink version string (format.ts VERSION). */
	readonly version: string;
	/** Where this extension was discovered: explicit flag, project dir, or global dir. */
	readonly origin: ExtensionOrigin;

	/** Register a tool the model can call. Reuses core Tool verbatim (M4a). */
	registerTool(tool: Tool): void;
	/** Register a REPL slash command. Reuses SlashCommand verbatim (M4b dispatch). */
	registerCommand(command: SlashCommand): void;
	/** Append a titled section to the system prompt, after AGENTS.md context (M4c). */
	registerContext(id: string, text: string): void;
	/** Register tool-name colors for the TUI call header (#tool-name-colors).
	 *  `names` is one tool name, several, or the literal `"*"` (fallback for
	 *  every tool without an exact registration); `color` is one of the 16
	 *  standard-16 tokens, `"none"` (leave the name bold-only, overriding
	 *  another registration for the same name), or an absolute token —
	 *  `ansi256:N` (0-255, fixed 256-palette index) or `#rrggbb` (truecolor;
	 *  hex stored lowercased). Named tokens stay theme-relative; absolute
	 *  tokens deliberately do not follow the terminal theme. Load-gated like
	 *  the other registrations —
	 *  valid only while the factory runs — validated, never throws; exact
	 *  names beat `"*"` at render lookup; duplicate keys keep the first
	 *  registration within the tier (reported) — cross-tier duplicates are
	 *  legal, see `suggestToolColor`. Styling a name that never loads is
	 *  inert. */
	registerToolColor(names: string | readonly string[], color: ToolColor): void;

	/** Suggest a default tool-name color for tools this extension owns
	 *  (#tool-name-colors A3). Same signature, validation and never-throw
	 *  contract as `registerToolColor`, one tier weaker. Any user
	 *  registration (exact or `"*"`) beats any suggestion — resolution is
	 *  user exact > user `"*"` > suggested exact > suggested `"*"`. Use it
	 *  in tool-providing extensions: the tool's author owns its default
	 *  look, the user's theme still has the final say. Cross-tier is not a
	 *  conflict (the same key may be registered and suggested); suggestions
	 *  conflict only within their tier (first wins, reported). */
	suggestToolColor(names: string | readonly string[], color: ToolColor): void;

	/** Subscribe to a loop/turn event. "tool_call" handlers may block (M4c). */
	on(event: "tool_call", handler: ToolCallHandler): void;
	on(event: "tool_end", handler: (event: ToolEndEvent) => void): void;
	on(event: "message_end", handler: (event: MessageEndEvent) => void): void;
	on(event: "run_start", handler: (event: RunStartEvent) => void): void;
	on(event: "run_end", handler: (event: RunEndEvent) => void): void;

	/** Set this extension's status text for the TUI footer; undefined clears.
	 *  Runtime method (like confirm): valid from event handlers, timers, and
	 *  command callbacks — unlike the register/on methods above it is NOT
	 *  gated to load time. The host owns styling; control sequences in text
	 *  are stripped. No-op when nothing renders statuses (print mode, legacy
	 *  shell). Keys are namespaced per extension (origin:name), so extensions
	 *  with a distinct name+origin cannot clobber each other. */
	setStatus(key: string, text: string | undefined): void;

	/** Ask the human a yes/no question (the interactive host renders a [y/N]
	 *  prompt on the tty). Resolves exactly true only on explicit approval;
	 *  false covers declines, empty/EOF answers, and hosts without an
	 *  interactive prompt (print mode, plain tests). "timeout" is a third
	 *  outcome: options.timeoutMs expired with the question visible and
	 *  unanswered — a NON-approval, and truthy, so a gate must compare with
	 *  `=== true`, never a truthy check. It never rejects; without a
	 *  timeoutMs the wait for an answer is unbounded, and hosts that cannot
	 *  time out (no picker) ignore it — the deadline is a caller-set bound on
	 *  picker hosts, not a universal guarantee. A sessionKey in options lets
	 *  the host remember a "don't ask again this session" choice for that key
	 *  (M10); hosts without that affordance just ignore it. */
	confirm(message: string, detail?: string, options?: ConfirmOptions): Promise<boolean | "timeout">;
}

/**
 * Default export of an extension module: called exactly once, awaited,
 * before the runner starts. Sync or async; the return value is ignored.
 */
export type ExtensionFactory = (api: ExtensionApi) => unknown;

export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	name: string;
	/** Schema-validated arguments (the same object execute() will receive). */
	args: Record<string, unknown>;

	/** True when the call comes from a subagent (task tool child), not the
	 * main loop (M6a) — gates can apply stricter rules to children. */
	subagent?: boolean;
	/** The named agent profile the child is running under, if any (M5c). */
	agent?: string;
	/** Working directory of the loop about to execute the call: the runner's
	 *  cwd, or the child's own path when worktree isolation is active (M6b) —
	 *  gates resolve relative targets against THIS, not the parent project. */
	cwd?: string;
}

// The union with void is the design §6.1 contract, verbatim: a handler may
// return a decision, nothing (void), or undefined — sync or async.
export type ToolCallHandler = (
	event: ToolCallEvent,
	// biome-ignore lint/suspicious/noConfusingVoidType: design §6.1 verbatim
) => ToolCallDecision | void | undefined | Promise<ToolCallDecision | void | undefined>;

export interface ToolEndEvent {
	type: "tool_end";
	toolCallId: string;
	name: string;
	output: string;
	isError: boolean;
	/** True when the call came from a subagent (task tool child), not the
	 * main loop (M6a) — observers can audit children separately. */
	subagent?: boolean;
	/** The named agent profile the child is running under, if any (M5c). */
	agent?: string;
	/** Working directory of the loop that executed the call — same value the
	 *  matching tool_call event carried (symmetry field for audit trails). */
	cwd?: string;
}

export interface MessageEndEvent {
	type: "message_end";
	/** The assistant message just appended to history (blocks + usage included). */
	message: AssistantMessage;
}

/** `run_start` fires once when a top-level run begins. Handlers run
 *  synchronously on the run's critical path and must return promptly. Its pair
 *  is `run_end`, which does NOT fire if the run crashes (provider throw) —
 *  consumers must tolerate an unpaired `run_start` (e.g. reset state on the
 *  next one). Subagent runs emit neither event (task-timer design §4.1). */
export interface RunStartEvent {
	type: "run_start";
}

export interface RunEndEvent {
	type: "run_end";
	stopReason: "completed" | "max_iterations" | "aborted";
	turns: number;
	usage: Usage;
}

/** The normative event set (design §17 risk 7) — additions require a named consumer (M5+). */
export type ExtensionEventName = "tool_call" | "tool_end" | "message_end" | "run_start" | "run_end";

/** All handler shapes, keyed by event name. */
export interface ExtensionEventHandlerMap {
	tool_call: ToolCallHandler;
	tool_end: (event: ToolEndEvent) => void;
	message_end: (event: MessageEndEvent) => void;
	run_start: (event: RunStartEvent) => void;
	run_end: (event: RunEndEvent) => void;
}

/** A slash command contributed by an extension, tagged with its source name. */
export interface RegisteredExtensionCommand {
	command: SlashCommand;
	/** The contributing extension's name (banner /help label, conflict diagnostics). */
	source: string;
}

/** A static system-prompt section contributed by registerContext (M4c injection). */
export interface ContextSection {
	id: string;
	text: string;
}

/** Per-extension startup banner summary (design §7.3), in load order. */
export interface ExtensionSummary {
	name: string;
	origin: ExtensionOrigin;
	toolCount: number;
	commandCount: number;
	contextCount: number;
	/** Total on() subscriptions (any event). */
	hookCount: number;
	/** #tool-name-colors: total user-tier tool-name color registrations
	 *  (names, not calls — the `*` slot counts as one name). */
	colorCount: number;
	/** #tool-name-colors A3: total author-tier suggestions (same counting). */
	suggestedColorCount: number;
	/** SA-06: canonical entry-module path + content hash, when capturable
	 *  (absent = the file could not be hashed — omitted, never guessed). */
	sourcePath?: string;
	sha256?: string;
}

/** A load failure, already reported on screen via onDiagnostic (design §7.3). */
export interface ExtensionFailure {
	/** The candidate file path that failed (absolute). */
	path: string;
	/** firstLine(err, 160) — the diagnostic body shown to the user. */
	error: string;
	/** Full error (stack included) for the run log's run_error entry. */
	detail: string;
}
