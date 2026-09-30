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
	 *  without a key there is no memory to offer (#guardian-auto-mode D13's
	 *  fresh fallbacks render plain Yes/No). */
	rememberLabel?: string;
	/** The request being decided, rendered in the transcript's call-header idiom
	 *  instead of prose. The host sanitizes both fields, styles `warnSpans` with
	 *  its own alert color, and shows the command exactly once on every surface:
	 *  in the picker where one exists, as one plain note (newlines preserved)
	 *  otherwise. */
	preview?: CommandPreview;
}

/** `api.classify` (#guardian-auto-mode D6): the extension supplies the
 *  question, the host supplies everything else — model resolution and auth,
 *  the trusted-context block (host-extracted, D11), the output contract, the
 *  timeout, the audit record, and whether the seam exists on this surface at
 *  all (D8). */
/** One classifier question. Requests whose combined `system` + `prompt`
 *  exceed the host's input cap (design §14.4) are treated as unavailable
 *  (fail-to-ask) — the extension may pre-flight against the documented cap. */
export interface ClassifyRequest {
	/** The extension's policy framing (the system message). */
	system: string;
	/** What to judge (one user message): the candidate action and its context. */
	prompt: string;
	/** Optional provider/model reference; absent → the session model. */
	model?: string;
}

export interface ClassifyResult {
	/** Phase A verdicts only (D7): the model cannot write the block path. */
	verdict: "allow" | "ask";
	/** One line, sanitized and capped by the host. */
	reason: string;
	/** The reference actually used (may differ from the request's). */
	model: string;
}

/** Host-side implementation injected by the surface — the same pattern as the
 *  confirm handler. A surface without it serves no classify calls. */
export type ClassifyHandler = (
	request: ClassifyRequest,
	source: string | undefined,
) => Promise<ClassifyResult | undefined>;

/**
 * The extension api: three read-only facts, three registration methods, one
 * subscriber, one status setter, one ask-the-human method, one ask-the-model
 * method — ten members. Anything an extension cannot do with this, it cannot
 * do.
 */
export interface ExtensionApi {
	/** Absolute working directory imp was started in. */
	readonly cwd: string;
	/** imp version string (format.ts VERSION). */
	readonly version: string;
	/** Where this extension was discovered: explicit flag, project dir, or global dir. */
	readonly origin: ExtensionOrigin;

	/** Register a tool the model can call. Reuses core Tool verbatim (M4a). */
	registerTool(tool: Tool): void;
	/** Register a REPL slash command. Reuses SlashCommand verbatim (M4b dispatch). */
	registerCommand(command: SlashCommand): void;
	/** Append a titled section to the system prompt, after AGENTS.md context (M4c). */
	registerContext(id: string, text: string): void;

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
	 *  prompt on the tty). Resolves true only on explicit approval; false
	 *  covers declines, empty/EOF answers, and hosts without an interactive
	 *  prompt (print mode, plain tests) — it never rejects and never hangs,
	 *  so a gate can always treat false as "not allowed". A sessionKey in
	 *  options lets the host remember a "don't ask again this session" choice
	 *  for that key (M10); hosts without that affordance just ignore it. */
	confirm(message: string, detail?: string, options?: ConfirmOptions): Promise<boolean>;

	/** Ask a model a yes/no question about a call (#guardian-auto-mode),
	 *  through a host-resolved one-shot request (no tools, no streaming).
	 *
	 *  The host supplies the model (or resolves `request.model`), the
	 *  provenance-verified user context, the output contract and the audit
	 *  record; the extension supplies only the question. Resolves `undefined`
	 *  whenever the seam is unavailable — no interactive host, no verified
	 *  call association, an unresolvable model that cannot fall back, an
	 *  over-cap request, a timeout, a provider error, or an answer that does
	 *  not match the contract. **It never throws and never hangs; a gate must
	 *  treat `undefined` as “unavailable” and ask the human.** Two verdicts
	 *  exist in Phase A: `allow` and `ask` — the model cannot block.*/
	classify(request: ClassifyRequest): Promise<ClassifyResult | undefined>;
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
	/** #guardian-auto-mode (D17): the host's provenance fact for a call — true
	 *  when the host verified a non-empty human-submission log for the emitting
	 *  run. Absent or false means “no verified context”: a gate must check
	 *  `=== true`, never the negation, before treating a call as
	 *  auto-approvable. */
	verifiedUserContext?: boolean;

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
