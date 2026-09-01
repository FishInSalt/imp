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

export type { ToolCallDecision };

/** Where an extension was discovered (M4 design §3.1). */
export type ExtensionOrigin = "cli" | "project" | "global";

/**
 * The entire M4 api: three read-only facts, three registration methods, one
 * subscriber — seven members. Anything an extension cannot do with this, it
 * cannot do in M4.
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
	on(event: "run_end", handler: (event: RunEndEvent) => void): void;
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
}

export interface MessageEndEvent {
	type: "message_end";
	/** The assistant message just appended to history (blocks + usage included). */
	message: AssistantMessage;
}

export interface RunEndEvent {
	type: "run_end";
	stopReason: "completed" | "max_iterations" | "aborted";
	turns: number;
	usage: Usage;
}

/** The normative event set (design §16 risk 7) — additions require a named consumer (M5+). */
export type ExtensionEventName = "tool_call" | "tool_end" | "message_end" | "run_end";

/** All handler shapes, keyed by event name. */
export interface ExtensionEventHandlerMap {
	tool_call: ToolCallHandler;
	tool_end: (event: ToolEndEvent) => void;
	message_end: (event: MessageEndEvent) => void;
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
