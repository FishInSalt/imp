import type { Readable } from "node:stream";
import { estimateContextTokens } from "../core/compaction.js";
import type { AgentEvent, RunAgentLoopResult } from "../core/loop.js";
import type { AgentMessage, AssistantMessage, Usage } from "../core/messages.js";
import type { SessionStore } from "../core/session/store.js";
import { saveSettings } from "../core/settings.js";
import { detectBinary } from "../core/tools/bin-detect.js";
import type { ToolExecuteResult } from "../core/tools/types.js";
import { NO_CONFIRM_LINE } from "../extensions/registry.js";
import type { ConfirmOptions, RegisteredExtensionCommand } from "../extensions/types.js";
import { dim, formatTokens, shorten, summarizeArgs, summarizeResult, VERSION } from "../format.js";
import { costFor } from "../provider/models.js";
import { supportedThinkingLevels, thinkingMetaFor } from "../provider/thinking.js";
import type { Renderer } from "../render.js";
import type { AgentEventInfo, Runner } from "../runner.js";
import { type AutocompleteSlashCommand, resolveShell, type Terminal } from "../tui.js";
import { COMMANDS, type CommandContext, dispatchCommand, loginNeedsGuard, parseCommand } from "./commands.js";
import { buildFoldFromDiff } from "./components/fold.js";
import type { ReplOutput } from "./input.js";
import { ReplInput } from "./input.js";
import type {
	ActivityAgentLine,
	ActivitySnapshot,
	ActivityToolLine,
	LineInput,
	QueueEntryView,
	SelectItemOption,
	SelectOptions,
	SubmitMode,
} from "./line-input.js";
import { replaySession } from "./replay.js";
import { type AutocompleteOptions, TuiShell } from "./shell.js";
import type { TranscriptSink } from "./transcript.js";

/** Interactive presentation shell. "legacy" is the pre-M9 readline path. */
export type ReplShell = "tui" | "legacy";

export interface ReplOptions {
	runner: Runner;
	/** Extension slash commands, already registered as data (M4b design §8.2):
	 *  cli.ts passes loadExtensions' runtime.commands here. */
	commands?: readonly RegisteredExtensionCommand[];
	input?: Readable; // default process.stdin
	output?: ReplOutput; // default process.stdout
	interactive?: boolean; // default: stdin && stdout TTY
	exit?: (code: number) => never; // default process.exit; injected in tests
	/** Presentation shell for interactive mode. Default: resolveShell()
	 *  (IMP_REPL=legacy escape hatch); non-interactive is always "legacy". */
	shell?: ReplShell;
	/** Required with shell "tui": the sink the Renderer feeds (cli.ts owns it
	 *  because the Renderer is constructed before runRepl). */
	transcript?: TranscriptSink;
	/** Test seam: inject a fake Terminal for the TUI shell. */
	terminal?: Terminal;
	/** Cross-session input history file for the TUI shell (M11 #4); cli.ts
	 *  resolves the real ~/.imp path, hermetic runs omit it. */
	inputHistoryPath?: string;
	/** Interactive confirm host for extension gates (api.confirm): created by
	 *  cli.ts before extension loading (which precedes this call) and bound
	 *  here to the live input — the [y/N] prompt asks on this REPL's tty. */
	confirm?: TtyConfirm;
	/** Release cli.ts's deferred startup notes (extension/context/trust
	 *  lines): called right after the welcome panel or banner prints, so the
	 *  greeting owns the top of the screen and the environment noise follows
	 *  it instead of burying it. Absent in tests and print mode — notes then
	 *  print live, as before. */
	releaseStartupNotes?: () => void;
}

type ReplState = "idle" | "running" | "compacting" | "exited";

/** Defensive cap on a non-edit fold body (tools truncate their own output
 *  already — this only bounds pathological results). */
const FOLD_LINE_CAP = 2000; // ≥ every tool's own cap (bash 500, read 2000)

/** Claude Code-style welcome panel for fresh TUI sessions: branding, a
 *  quick-reference of the commands people actually reach for, and the
 *  session's identity. Resumed sessions keep the compact banner — the
 *  panel is the "new conversation" moment, not a constant. */
/** Pixel-block "imp" — glyphs verbatim from the ANSI Shadow FIGlet font
 *  (xero/figlet-fonts "ANSI Shadow.flf", full-width layout; extraction
 *  validated char-for-char against the canonical "hello" render). This
 *  font's lowercase i has NO tittle and no trailing gap (unlike l), and p's
 *  bowl closes one row above the bare descender stem. ██ cells read as
 *  solid pixels; the gradient paints per column. */
const IMP_LOGO = [
	"██╗███╗   ███╗██████╗",
	"██║████╗ ████║██╔══██╗",
	"██║██╔████╔██║██████╔╝",
	"██║██║╚██╔╝██║██╔═══╝",
	"██║██║ ╚═╝ ██║██║",
	"╚═╝╚═╝     ╚═╝╚═╝",
];

/** Gemini-style horizontal gradient stops: blue → purple → pink. */
const GRADIENT_STOPS: [number, number, number][] = [
	[66, 133, 244],
	[156, 107, 255],
	[255, 110, 199],
];

/** Colorize one line's glyphs column-by-column (spaces stay plain); truecolor
 *  ANSI per character. `ansi=false` returns the line untouched. */
function gradientLine(line: string, ansi: boolean): string {
	if (!ansi) return line;
	const width = line.length;
	const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
	return line
		.split("")
		.map((ch, x) => {
			if (ch === " ") return ch;
			const t = width <= 1 ? 0 : x / (width - 1);
			const stops: [[number, number, number], [number, number, number]] =
				t < 0.5
					? [GRADIENT_STOPS[0] ?? [0, 0, 0], GRADIENT_STOPS[1] ?? [0, 0, 0]]
					: [GRADIENT_STOPS[1] ?? [0, 0, 0], GRADIENT_STOPS[2] ?? [0, 0, 0]];
			const [c0, c1] = stops;
			const lt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
			const [r, g, b] = [lerp(c0[0], c1[0], lt), lerp(c0[1], c1[1], lt), lerp(c0[2], c1[2], lt)];
			return `\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
		})
		.join("");
}

/** Gemini-CLI-style welcome: gradient pixel logo, numbered getting-started
 *  tips, dim identity line. No box — the logo is the greeting. */
export function welcomeLines(sessionId: string, modelReference: string, ansi: boolean): string[] {
	return [
		...IMP_LOGO.map((line) => gradientLine(line, ansi)),
		"",
		"Tips for getting started:",
		"1. Ask questions, edit files, or run commands.",
		"2. Be specific for the best results.",
		"3. /help for more information.",
		"",
		`imp ${VERSION} · session ${sessionId} · ${modelReference}`,
	];
}

/** "! cmd" lines: the shell executes them itself (M10). Blank after the
 *  "!" is a usage hint, not a command. */
function isBangLine(line: string): boolean {
	return line[0] === "!" && line.slice(1).trim() !== "";
}

/** imp's COMMANDS + extension commands → pi-tui's autocomplete shape; the
 *  panel's description line is "usage — summary" (pi-tui composes them). */
function autocompleteCommands(
	extraCommands: readonly RegisteredExtensionCommand[],
): AutocompleteSlashCommand[] {
	return [
		...COMMANDS.map((command) => ({
			name: command.name,
			description: command.summary,
			...(command.usage !== undefined && { argumentHint: command.usage }),
		})),
		...extraCommands.map((entry) => ({
			name: entry.command.name,
			description: entry.command.summary,
			...(entry.command.usage !== undefined && { argumentHint: entry.command.usage }),
		})),
	];
}
/** TUI queue-line preview (LineInput.setQueue): the first line of the
 *  entry, capped at ~40 columns. */
function queuePreviewText(text: string): string {
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

/** One entry of the input queue. Plain typed lines carry their routing
 *  mode: "steer" (Enter) injects into the running turn at the next model
 *  call; "followUp" (alt+enter) holds for after the run settles. Bang
 *  lines and md prompts never steer — they are flush-only by design (the
 *  prompt is model input verbatim, never re-interpreted). */
type QueueEntry = { text: string; mode: SubmitMode } | { prompt: string; display?: string };

function entryText(entry: QueueEntry): string {
	return "prompt" in entry ? entry.prompt : entry.text;
}

/** Echo override for queued prompts (M12 §11.3): skills queue the expanded
 *  block but preview their summary line; typed lines have none. */
function entryDisplay(entry: QueueEntry): string | undefined {
	return "prompt" in entry ? entry.display : undefined;
}

/** Routing label for the TUI queue preview rows. */
function entryLabel(entry: QueueEntry): string {
	if ("prompt" in entry) return "prompt";
	return isBangLine(entry.text) ? "bash" : entry.mode === "followUp" ? "follow-up" : "steer";
}

/** The three-option confirm picker (M10): approve, approve for the session, decline. */
const CONFIRM_ITEMS: SelectItemOption[] = [
	{ label: "Yes" },
	{ label: "Yes, don't ask again this session" },
	{ label: "No" },
];

/**
 * The interactive side of api.confirm: one host created before extension
 * loading (cli.ts loads extensions before the REPL exists), bound to the
 * live input once runRepl starts. Unbound (scripted mode, tests): the
 * same never-hangs contract as the registry fallback — false + one stderr
 * teaching line.
 *
 * With a picker bound (TuiShell), questions render as the three-option
 * selector and a "Yes, don't ask again this session" pick records the
 * sessionKey in a per-process allowlist — later confirms on that key
 * short-circuit to approval without prompting. Without a picker (readline
 * shell, print mode) the flow is the original [y/N] ask, byte-for-byte.
 */
export class TtyConfirm {
	private ask: ((question: string) => Promise<boolean>) | null = null;
	private select: ((options: SelectOptions) => Promise<number | null>) | null = null;
	/** sessionKeys the user approved with "don't ask again this session". */
	private readonly sessionAllowed = new Set<string>();
	private readonly renderer: Renderer;

	constructor(renderer: Renderer) {
		this.renderer = renderer;
	}

	/** The confirm handler — pass to loadExtensions when interactive. */
	readonly handler = async (message: string, detail?: string, options?: ConfirmOptions): Promise<boolean> => {
		const sessionKey = options?.sessionKey;
		if (sessionKey !== undefined && this.sessionAllowed.has(sessionKey)) {
			this.renderer.note(`▪ confirm: ${message} — allowed for this session`);
			return true;
		}
		this.renderer.note(`▪ confirm: ${message}`);
		if (detail !== undefined && detail !== "") this.renderer.note(`  ${detail}`);
		const select = this.select;
		if (select !== null) {
			const choice = await select({ title: message, items: CONFIRM_ITEMS });
			if (choice === null) return false; // cancelled picker declines, like Ctrl+C at the ask
			if (choice === 1 && sessionKey !== undefined) this.sessionAllowed.add(sessionKey);
			return choice !== 2;
		}
		const ask = this.ask;
		if (ask === null) {
			process.stderr.write(NO_CONFIRM_LINE);
			return false;
		}
		return ask("proceed? [y/N] ");
	};

	/** runRepl binds the live tty once its input exists. */
	bind(ask: (question: string) => Promise<boolean>): void {
		this.ask = ask;
	}

	/** runRepl binds the picker when the input shell implements select. */
	bindSelect(select: (options: SelectOptions) => Promise<number | null>): void {
		this.select = select;
	}
}

interface ReplMachineOptions {
	runner: Runner;
	/** Extension commands (M4b): forwarded to dispatchCommand at the single dispatch site. */
	commands: readonly RegisteredExtensionCommand[];
	renderer: Renderer;
	input: LineInput;
	interactive: boolean;
	/** Replay a session on screen (shared by the startup banner and /resume). */
	replay: (session: SessionStore) => number;
	exit: (code: number) => never;
	finish: (code: number) => void;
}

/**
 * The REPL state machine (idle / running / compacting / exited).
 *
 * One persistent line handler routes by state; runs are fire-and-forget
 * promises whose settle path returns to idle, flushes leftover steering, or
 * exits when EOF/an exit request is pending. Double Ctrl+C force-exits
 * through `exit()` — never awaiting a possibly-hung tool.
 */
class ReplMachine {
	private state: ReplState = "idle";
	/** Queued input (see QueueEntry): typed lines with their routing mode
	 *  (steer / follow-up) and markdown-command prompts, which are model
	 *  input verbatim and never re-interpreted (M11 #6 review P1 — a body
	 *  starting with "!" must not run as a shell command). */
	private queue: QueueEntry[] = [];
	private controller: AbortController | null = null;
	/** #login-repl batch B: the guarded /login OAuth controller — Ctrl+C
	 *  aborts it instead of counting toward a force quit. */
	private longOpAbort: AbortController | null = null;
	private interruptCount = 0;
	private pendingExitCode: number | null = null;
	private eofPending = false;
	/** Latch for the context-low note: fires once per crossing of 80%;
	 *  dropping back below (compaction, /new) re-arms it. */
	private lowContextNoted = false;
	/** Live turn activity for the TUI region (M10 B): pending top-level tools
	 *  and running subagents. Keyed by tool_call id / agent name; pushed as a
	 *  snapshot after every mutation (see pushActivity). */
	private activityTools = new Map<string, ActivityToolLine>();
	private activityAgents = new Map<string, ActivityAgentLine>();
	private receivedLine = false;
	private readonly runner: Runner;
	private readonly commands: readonly RegisteredExtensionCommand[];
	private readonly renderer: Renderer;
	private readonly input: LineInput;
	private readonly interactive: boolean;
	private readonly replay: (session: SessionStore) => number;
	private readonly exit: (code: number) => never;
	private readonly finish: (code: number) => void;

	constructor(options: ReplMachineOptions) {
		this.runner = options.runner;
		this.commands = options.commands;
		this.renderer = options.renderer;
		this.input = options.input;
		this.interactive = options.interactive;
		this.replay = options.replay;
		this.exit = options.exit;
		this.finish = options.finish;
		this.refreshFooter(); // eager warmup already knows model + session
	}

	handleLine(line: string, mode: SubmitMode = "steer"): void {
		if (this.state === "exited") return;
		this.receivedLine = true;
		this.interruptCount = 0; // an accepted line resets the double-Ctrl+C counter
		if (line.trim() === "") {
			this.input.refresh();
			return;
		}
		// "! cmd" passthrough (M10): the shell runs it directly — never model
		// input, never a session entry. Checked before parseCommand so "/" and
		// "!" stay unambiguous; while a phase is active the existing queue
		// semantics hold it (the post-run flush executes it as a bang).
		if (line[0] === "!") {
			const bangCommand = line.slice(1).trim();
			if (bangCommand === "") {
				this.renderer.note("▪ ! runs a shell command directly — e.g. ! ls -la");
				this.input.refresh();
				return;
			}
			if (this.state === "idle") {
				void this.runBangCommand(bangCommand);
				return;
			}
			// active/compacting: fall through — the shared queue path below holds it
		}
		const command = parseCommand(line);
		if (command) {
			void this.runCommand(line, command.name);
			return;
		}
		if (this.state === "idle") {
			void this.submitTurn(line);
			return;
		}
		this.queue.push({ text: line, mode });
		// The TUI's queue row (setQueue) shows the line with its position — the
		// note would repeat it (dogfood 2026-09-09). Legacy keeps the note.
		if (this.interactive && this.input.setQueue === undefined) {
			this.renderer.note(`▪ queued: ${shorten(line)}`);
		}
		this.syncQueue();
		this.input.refresh();
	}

	/** Submit a prompt as if typed, without command/bang re-routing (M11 #6):
	 *  idle starts a turn, otherwise it queues behind the running one —
	 *  exactly the typed-line semantics minus interpretation. `display`
	 *  (M12 §11.3) overrides only the transcript echo; the session record
	 *  keeps the full text. */
	enqueuePrompt(text: string, display?: string): void {
		if (this.state === "exited") return;
		const trimmed = text.trim();
		if (trimmed === "") return;
		if (this.state === "idle") {
			void this.submitTurn(trimmed, display);
			return;
		}
		this.queue.push({ prompt: trimmed, display });
		if (this.interactive && this.input.setQueue === undefined) {
			this.renderer.note(`▪ queued: ${shorten(display ?? trimmed)}`);
		}
		this.syncQueue();
		this.input.refresh();
	}

	handleInterrupt(): void {
		if (this.state === "exited") return;
		switch (this.state) {
			case "idle": {
				// typed-but-unsubmitted text is discarded, not counted as a quit gesture
				if (this.input.clearPending()) return;
				this.interruptCount++;
				if (this.interruptCount === 1) {
					this.renderer.note("(press Ctrl+C again to quit — /exit or Ctrl+D also work)");
				} else {
					this.gracefulExit(130);
				}
				return;
			}
			case "running": {
				this.interruptCount++;
				if (this.interruptCount === 1) {
					this.controller?.abort();
					this.renderer.note("(interrupt — press Ctrl+C again to force quit)");
				} else {
					this.forceExit(130);
				}
				return;
			}
			case "compacting": {
				// #login-repl batch B: a guarded login aborts ITS controller on
				// the first Ctrl+C (pi's dialog cancels the same way); a real
				// compaction keeps the old hint behavior.
				if (this.longOpAbort !== null) {
					this.longOpAbort.abort();
					this.interruptCount = 0;
					return;
				}
				this.interruptCount++;
				if (this.interruptCount === 1) {
					this.renderer.note("(compacting — press Ctrl+C again to force quit)");
				} else {
					this.forceExit(130);
				}
				return;
			}
		}
	}

	handleEof(): void {
		if (this.state === "exited") return;
		if (!this.receivedLine && !this.interactive) {
			// zero-line piped stdin ("forgot -p"): cli prints HELP for exit code 1.
			// On a real TTY, Ctrl+D with nothing typed is just a graceful exit.
			this.state = "exited";
			this.finish(1);
			return;
		}
		if (this.state === "idle") {
			this.gracefulExit(0);
			return;
		}
		this.eofPending = true; // exit after the active run/compaction settles
	}

	private async runCommand(line: string, name: string): Promise<void> {
		// Scripted mode defers session/banners to the first accepted line; a
		// failed warmup (bad -r id) must surface as a clean error, never an
		// unhandled rejection — so it runs inside the guarded region.
		try {
			this.runner.warmup();
		} catch (err) {
			this.reportError(err);
			return;
		}
		// Manual /compact AND /tree run in their own state so Ctrl+C gets the
		// right hint, /new //resume can refuse while in flight, and — critical
		// for /tree — the 5-20s summarizer await cannot be crossed by a new
		// turn or a session swap (review P1-1: an unguarded window once let a
		// typed line open a turn on stale history, and /new mid-await left
		// runner.session and runner.history pointing at different sessions).
		const stateful =
			((name === "compact" || name === "tree") && this.state === "idle" && this.runner.session !== null) ||
			// #login-repl batch B: the codex OAuth poll runs up to 15 minutes —
			// it needs the guarded state (Ctrl+C cancels, typed lines queue,
			// /new refuses) exactly like a compaction
			(name === "login" && this.state === "idle" && loginNeedsGuard(line));
		if (stateful) {
			this.state = "compacting";
			this.input.setActive(true);
		}
		try {
			// authorizedCompact: this dispatch IS the authorized compact — the
			// state was pre-set to "compacting" for Ctrl+C hints and /new refusal,
			// which must not make dispatchCommand's isActive() guard reject it.
			// Any OTHER line arriving while compacting still sees isActive() true.
			// Extension commands ride the same path with identical semantics (M4b).
			await dispatchCommand(line, this.commandContext(stateful), this.commands);
		} catch (err) {
			this.reportError(err);
		} finally {
			// Review P1 (batch B): clear ONLY from the dispatch that armed it.
			// A command typed mid-login (runCommand is unstateful for it) must
			// not null the controller — that disarmed Ctrl+C and left a double
			// press force-quitting over a live OAuth poll.
			if (stateful) this.longOpAbort = null;
			if (stateful && this.state === "compacting") {
				this.interruptCount = 0;
				await this.flushQueue(); // queued lines drain as after a run (§5.2)
			}
			this.refreshFooter(); // /model, /new, /resume all change footer inputs
		}
	}

	private async submitTurn(line: string, display?: string): Promise<void> {
		if (this.state === "exited") return;
		this.state = "running";
		this.input.setActive(true);
		// The TUI editor clears the line on submit — echo it into the
		// transcript so the conversation reads as a conversation (dogfood
		// report 2026-09-09: answers appeared with no question above them).
		// Print keeps the terminal's own readline echo; bytes unchanged.
		// `display` (M12 §11.3): skill commands echo their one-line summary —
		// the full expanded block still goes to the model AND the session.
		if (this.input.setFooter !== undefined) this.renderer.user(display ?? line);
		this.renderer.think(); // live spinner until the first event arrives (print/legacy)
		this.pushActivity(); // TUI activity region: thinking phase from the start
		const controller = new AbortController();
		this.controller = controller;
		try {
			this.runner.warmup(); // deferred init for scripted mode; guarded like the rest
			const result = await this.runner.runTurn({
				userMessage: line,
				signal: controller.signal,
				onEvent: (event: AgentEvent, info?: AgentEventInfo) => {
					// Top-level events feed the Renderer; subagent-sourced ones
					// (info set) go to the activity region only — M5's
					// zero-rendering-visibility rule, enforced at this tap.
					if (info === undefined) {
						this.renderer.event(event);
						this.showResultFold(event); // TUI: every top-level result folds (M11); child edits could later
					}
					this.trackActivity(event, info);
				},
				getSteeringMessages: () => this.steeringMessages(),
			});
			await this.settleSuccess(result);
		} catch (err) {
			this.settleFailure(err);
		}
	}

	/** Fold a finished top-level tool result (TUI only — the legacy shell has
	 *  no addFold and keeps its `⎿` line). Successful results of EVERY tool
	 *  fold (M11: `⎿ stdout: (+22 lines)` told the reader nothing and hid the
	 *  content with no way in — dogfood 2026-09-09); edits keep their
	 *  decorated diff fold, everything else previews via summarizeResult and
	 *  carries the full content. Errors fold with a red arrow (debt
	 *  clearance); the `● ✗` line above keeps the failure salient.
	 *  Child-sourced results never reach this tap. */
	private showResultFold(event: AgentEvent): void {
		if (event.type !== "tool_end") return;
		if (this.input.addFold === undefined) return;
		const result = event.result;
		if (!result.isError && result.toolName === "edit") {
			const content = result.content;
			const split = content.indexOf(":\n");
			if (split !== -1) {
				// the built-in contract: "<summary>:\n<diff>" gets the decorated
				// diff fold. Anything else (an extension tool also named "edit")
				// falls through to the generic fold — the ⎿ is suppressed under
				// foldedResults, so returning would lose the preview entirely
				// (review: edit-contract edge).
				const { title, lines } = buildFoldFromDiff(content.slice(0, split), content.slice(split + 2));
				this.input.addFold(title, lines);
				return;
			}
		}
		const rawLines = result.content.split("\n");
		// A trailing newline is a terminator, not a (blank) line — count it out
		// (review P2: 400 physical lines + "\n" lied about one more).
		if (rawLines[rawLines.length - 1] === "") rawLines.pop();
		// The tools truncate their own output (bash caps 500 lines, read 2000),
		// so the fold body is already bounded; the defensive cap only stops a
		// pathological result from swelling the fold container.
		const capped = rawLines.slice(0, FOLD_LINE_CAP);
		if (rawLines.length > FOLD_LINE_CAP) {
			capped.push(dim(`… (${rawLines.length - FOLD_LINE_CAP} more lines — full output in the session)`));
		}
		this.input.addFold(
			summarizeResult(result.toolName, result.content),
			capped,
			false,
			result.isError === true,
		);
	}

	private steeringMessages(): AgentMessage[] {
		// "! cmd" entries are shell directives, never model content: hold them
		// in place (the post-run flush executes them) and steer the next plain
		// line — with no bang lines queued this is exactly the old head-pop.
		// Only steer-mode TYPED lines steer (follow-up lines, md prompts, and
		// bang entries all hold for the flush — that is the whole point of
		// alt+enter routing).
		const index = this.queue.findIndex(
			(entry) => "text" in entry && entry.mode === "steer" && !isBangLine(entry.text),
		);
		if (index === -1) return [];
		const picked = this.queue.splice(index, 1)[0];
		if (picked === undefined || !("text" in picked)) return []; // unreachable; type guard
		const next = picked.text;
		this.renderer.note(`▪ steering: ${shorten(next)}`);
		this.syncQueue();
		return [{ role: "user", content: next }];
	}

	/** Bottom status line for the TUI shell (the legacy shell ignores it):
	 *  model · session id8 · cumulative tokens · context fill. Pushed at
	 *  every point any input changes — construction, command dispatch
	 *  (/model, /new, /resume), and both run settle paths (session totals
	 *  move) — and the terminal title rides along (TUI shells only). */
	private runnerThinkingStyle(): ReturnType<typeof thinkingMetaFor> {
		const reference = this.runner.modelReference();
		const slash = reference.indexOf("/");
		return thinkingMetaFor(
			slash === -1 ? "anthropic" : reference.slice(0, slash),
			slash === -1 ? reference : reference.slice(slash + 1),
		);
	}

	/** ctrl+t (pi's app.thinking.toggle): flip trace visibility, persist it
	 *  (pi's setHideThinkingBlock), and REBUILD the transcript from history —
	 *  pi rebuilds its chat container; imp clears the sink and replays. Only
	 *  when idle: a mid-run rebuild would truncate the streaming line. */
	toggleThinkingVisibility(): void {
		this.renderer.hideThinking = !this.renderer.hideThinking;
		saveSettings({ hideThinkingBlock: this.renderer.hideThinking });
		// pi's exact showStatus line (interactive-mode.ts:3833) — also the
		// only feedback a mid-run toggle gets (no rebuild while streaming)
		this.renderer.status(`Thinking blocks: ${this.renderer.hideThinking ? "hidden" : "visible"}`);
		if (this.state !== "idle") return; // this run's remaining sections follow the flag
		// pi rebuilds its chat container from session messages; imp clears
		// the sink and re-renders history through the same replay path as
		// /resume (the replay picks the live hideThinking flag up). Without
		// a session store there is nothing durable to rebuild from — the
		// flag applies to everything rendered after this point.
		const session = this.runner.session;
		if (session === null) return;
		this.input.clearConversation?.(); // same wipe as /resume — replay never clears
		this.replay(session);
	}

	/** shift+tab / bare /think: cycle the level (pi's cycleThinkingLevel —
	 *  the runner clamps; the footer repaints its level segment). Public
	 *  within the module: the TuiShell wiring closes over the machine. */
	cycleThinking(): void {
		if (!this.runner.supportsThinking()) {
			this.renderer.status("Current model does not support thinking"); // pi's exact line
			return;
		}
		const style = this.runnerThinkingStyle();
		if (style === null) return;
		const levels = supportedThinkingLevels(style);
		const next = levels[(levels.indexOf(this.runner.thinkingLevel) + 1) % levels.length] ?? "off";
		const effective = this.runner.setThinkingLevel(next);
		this.renderer.status(`Thinking level: ${effective}`); // pi's showStatus form
		this.refreshFooter();
	}

	private refreshFooter(): void {
		// modelReference() is the CONNECTION TELL (#zai-default): zai/glm-5.3
		// vs a bare glm-5.3 distinguishes the coding endpoint from compat.
		const parts: string[] = [this.runner.modelReference()];
		// pi parity (#thinking-levels): the level segment sits beside the
		// model whenever the model HAS a knob — "off" included, so the
		// control is discoverable from the footer alone.
		if (this.runner.supportsThinking()) parts.push(`think:${this.runner.thinkingLevel}`);
		const session = this.runner.session;
		if (session !== null) parts.push(session.header.id.slice(0, 8));

		// Session-wide usage segments (pi footer semantics), all from the live
		// history: cumulative ↑/↓, cache read R / write W, the LATEST cache hit
		// rate CH (= cacheRead / full prompt of the last response that reported
		// cache data), and $ cost priced per message at its producer model's
		// rates — messages from before the model field existed (or models not
		// in the cost table) fall back to the current model's rates, so a
		// mid-session /model switch prices each turn correctly.
		const assistants = this.runner.history.filter((m): m is AssistantMessage => m.role === "assistant");
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let lastCacheUsage: Usage | undefined;
		let cost = 0;
		let subscription = costFor(this.runner.model)?.subscription ?? false;
		for (const m of assistants) {
			inputTokens += m.usage.inputTokens;
			outputTokens += m.usage.outputTokens;
			cacheRead += m.usage.cacheReadTokens ?? 0;
			cacheWrite += m.usage.cacheWriteTokens ?? 0;
			if (m.usage.cacheReadTokens !== undefined) lastCacheUsage = m.usage;
			const rates = costFor(m.model ?? this.runner.model);
			if (rates) {
				cost +=
					(m.usage.inputTokens * rates.input +
						m.usage.outputTokens * rates.output +
						(m.usage.cacheReadTokens ?? 0) * rates.cacheRead +
						(m.usage.cacheWriteTokens ?? 0) * rates.cacheWrite) /
					1_000_000;
				if (rates.subscription) subscription = true;
			}
		}
		if (inputTokens > 0 || outputTokens > 0 || cacheRead > 0 || cacheWrite > 0) {
			const usageParts = [`↑${formatTokens(inputTokens)}`, `↓${formatTokens(outputTokens)}`];
			if (cacheRead > 0) usageParts.push(`R${formatTokens(cacheRead)}`);
			if (cacheWrite > 0) usageParts.push(`W${formatTokens(cacheWrite)}`);
			if (lastCacheUsage) {
				// pi's CH: hit share of the FULL prompt (input + cache read + write)
				const denom =
					lastCacheUsage.inputTokens +
					(lastCacheUsage.cacheReadTokens ?? 0) +
					(lastCacheUsage.cacheWriteTokens ?? 0);
				if (denom > 0) {
					usageParts.push(`CH${(((lastCacheUsage.cacheReadTokens ?? 0) / denom) * 100).toFixed(1)}%`);
				}
			}
			parts.push(usageParts.join(" "));
		}
		// Subscription-backed models still show $0.000 (sub) — the traffic is
		// covered by the plan, the number is what it would cost at API rates.
		if (cost > 0 || subscription) {
			parts.push(`$${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
		}

		// Context fill from the same live history the loop and auto-compaction
		// use (estimateContextTokens anchors on the last measured usage). The
		// estimate is O(messages) local work — fine at this low-frequency push
		// point, but never call it from a streaming-delta path. pi's format:
		// one decimal, the window size, and the auto-compaction tag.
		const contextPercent =
			(estimateContextTokens(this.runner.history).tokens / this.runner.contextWindow) * 100;
		const contextSegment = `${contextPercent.toFixed(1)}%/${formatTokens(this.runner.contextWindow)}${
			this.runner.autoCompactEnabled ? " (auto)" : ""
		}`;
		parts.push(contextSegment);
		if (contextPercent >= 80) {
			parts.push("low — /compact");
			// The warning note rides the footer's shell gate: legacy/pipe sessions
			// never saw context warnings before M10 and their byte contract stays
			// that way (M10 review P2#1).
			if (!this.lowContextNoted && this.input.setFooter !== undefined) {
				this.lowContextNoted = true;
				this.renderer.note(
					`▪ context ${contextPercent.toFixed(1)}% used — /compact to summarize older turns`,
				);
			}
		} else {
			this.lowContextNoted = false;
		}
		this.input.setFooter?.(parts.join(" · "));
		this.input.setTitle?.(`imp — ${this.runner.model}`);
	}

	private async settleSuccess(result: RunAgentLoopResult): Promise<void> {
		this.controller = null;
		this.interruptCount = 0;
		if (this.state === "exited") return;
		this.renderer.endRun();
		// Stats placement (pi parity, 2026-09-10): the TUI transcript carries
		// NO stats lines — per-run AND cumulative usage live in the footer.
		// Print mode keeps both lines; bytes frozen.
		this.runner.printRunStats(result, { statsLine: this.input.setFooter === undefined });
		if (this.input.setFooter === undefined) this.runner.printSessionStats();
		this.refreshFooter(); // cumulative tokens moved
		if (result.stopReason === "aborted") {
			// the user pressed Ctrl+C to take control — queued lines are not run;
			// they go back to the editor (pi: user input is never lost)
			this.restoreQueueToEditor();
			this.returnToIdle();
			return;
		}
		await this.flushQueue();
	}

	private settleFailure(err: unknown): void {
		this.controller = null;
		this.interruptCount = 0;
		if (this.state === "exited") return;
		this.renderer.endRun();
		this.refreshFooter(); // partial usage may have landed before the failure
		// Defensive: an AbortError racing the settle path is a user interrupt,
		// not a provider failure (the provider should already have ended the
		// stream cleanly — see abortSafe in anthropic.ts).
		if (err instanceof Error && err.name === "AbortError") {
			this.renderer.note("(aborted)");
			this.restoreQueueToEditor();
			this.returnToIdle();
			return;
		}
		this.reportError(err);
		// Mid-run failures keep every completed tool result in the session — the
		// next message resumes from the break. Users assume the whole turn was
		// lost otherwise (dogfood report 2026-09-01: 6 tool results survived,
		// the user just wasn't told they could type 继续).
		this.renderer.note(
			'completed work from this turn is saved in the session — send another message (e.g. "继续") to resume from the break',
		);
		// A failure ends the run without completing it — same rule as an
		// abort: the queue is handed back (editor in the TUI, echoed notes in
		// legacy), never silently dropped. A held-across-runs queue would need
		// agent-level queues (pi's model); the next run's initial steering
		// poll would otherwise silently absorb the held lines mid-prompt.
		this.restoreQueueToEditor();
		this.returnToIdle();
	}

	private async flushQueue(): Promise<void> {
		if (this.pendingExitCode !== null) {
			// An exit is pending — nothing will run, but the queued texts are
			// still handed back (echoed: the editor closes with the shell)
			// instead of vanishing with the process (review P2).
			this.restoreQueueToEditor();
			this.returnToIdle();
			return;
		}
		const [next, ...rest] = this.queue;
		if (next === undefined) {
			this.returnToIdle();
			return;
		}
		this.queue = rest;
		// TUI: the echoed user block (Renderer.user → the sink's bg block)
		// says this already; the note would double it (dogfood 2026-09-09).
		// Legacy keeps the note.
		if (this.input.setQueue === undefined) {
			this.renderer.note(`▪ continuing with queued: ${shorten(entryText(next))}`);
		}
		this.syncQueue();
		// A queued "! cmd" keeps its bang semantics on the flush — it runs in
		// the shell, it does not open a model turn. A { prompt } entry is md
		// content: straight to a turn, no re-interpretation (review P1).
		if (!("prompt" in next) && isBangLine(next.text)) {
			await this.runBangCommand(next.text.slice(1).trim());
			return;
		}
		await this.submitTurn(entryText(next), entryDisplay(next));
	}

	/** "! cmd" (M10): run a shell command directly through the bash tool — no
	 * model turn, nothing enters the session (warmup stays deferred: a
	 * shell-only scripted pipe keeps zero side effects). Owns the running
	 * state while it executes so the marker shows "+ " and Ctrl+C/Esc reuse
	 * the interrupt path (controller.abort); queued lines flush after, like
	 * a turn. */
	private async runBangCommand(command: string): Promise<void> {
		if (this.state === "exited") return;
		const bash = this.runner.getTool("bash");
		if (bash === undefined) {
			this.renderer.error("imp: ! needs the bash tool, which this session's tool set does not include");
			return;
		}
		this.state = "running";
		this.input.setActive(true);
		this.renderer.note(`! ${shorten(command)}`);
		const controller = new AbortController();
		this.controller = controller;
		try {
			const result = await bash.execute({ command }, controller.signal);
			this.renderBangResult(result);
		} catch (err) {
			this.reportError(err);
		} finally {
			this.controller = null;
			this.interruptCount = 0;
			if (controller.signal.aborted) {
				// Mirror the turn semantics: Ctrl+C takes control — queued lines
				// are not run, they go back to the editor (M10 review P2#2).
				this.restoreQueueToEditor();
				this.returnToIdle();
			} else {
				await this.flushQueue(); // drains any queue, then back to idle
			}
		}
	}

	/** Bang output block: the tool's own truncation stands (bash.ts); the
	 *  exit status comes from the STRUCTURED field — the trailing
	 *  "Exit code: N" section is stripped only when it matches the real
	 *  code, so the code is stated exactly once and a command's own output
	 *  can no longer forge the annotation (debt clearance). */
	private renderBangResult(result: ToolExecuteResult): void {
		let body = result.output;
		if (result.exitCode !== undefined && result.exitCode !== 0) {
			const real = new RegExp(`(?:\n\n|^)Exit code: ${result.exitCode}$`).exec(result.output);
			if (real !== null) {
				body = result.output.slice(0, real.index).trimEnd();
				// Note ONLY alongside an actual peel: a truncated output keeps
				// the section mid-body ("[output truncated: …]" follows it), so
				// the text already states the code once — a note here would
				// state it twice (review P2).
				this.renderer.note(`(exit ${result.exitCode})`);
			}
		}
		if (body !== "") this.renderer.writeLine(body);
	}

	/** Activity region (M10 B). tool_start adds a pending row; tool_end removes
	 *  it (the ✓/⎿ completion lines stay in the transcript — the Renderer is
	 *  unchanged); the task tool maps to a subagent row that child events
	 *  (info.agent) keep updating until the task ends. Two parallel tasks on
	 *  the same agent share one row (v1 — the common case is one per agent). */
	private trackActivity(event: AgentEvent, info?: AgentEventInfo): void {
		if (event.type === "tool_start") {
			if (info !== undefined) {
				// Child-sourced (info present — even without an agent name): update
				// the agent row; never a top-level tool row.
				const agent = info.agent ?? "task";
				const row = this.activityAgents.get(agent);
				if (row !== undefined) {
					row.lastTool = `${event.name} ${summarizeArgs(event.name, event.args)}`.trimEnd();
					row.toolCount += 1;
				}
			} else if (event.name === "task") {
				const args = (event.args ?? {}) as { agent?: string; prompt?: string };
				const agent = args.agent ?? "task";
				this.activityAgents.set(agent, {
					agent,
					// the prompt IS the label (summarizeArgs has no task entry —
					// raw JSON as a row label would be noise, not signal)
					task: typeof args.prompt === "string" ? shorten(args.prompt) : summarizeArgs("task", event.args),
					taskToolId: event.toolCallId,
					cwd: null,
					lastTool: null,
					toolCount: 0,
					startedAtMs: Date.now(),
				});
			} else {
				this.activityTools.set(event.toolCallId, {
					id: event.toolCallId,
					name: event.name,
					label: summarizeArgs(event.name, event.args),
					startedAtMs: Date.now(),
				});
			}
			this.pushActivity();
			return;
		}
		if (event.type === "tool_end") {
			if (info !== undefined) return; // child ends bump nothing (v1)
			if (event.result.toolName === "task") {
				// Only the rows this task call created leave; a concurrent second
				// task's row survives (keyed by taskToolId, not agent name).
				for (const [key, row] of this.activityAgents) {
					if (row.taskToolId === event.result.toolCallId) this.activityAgents.delete(key);
				}
			} else {
				this.activityTools.delete(event.result.toolCallId);
			}
			this.pushActivity();
		}
	}

	/** Push the current activity snapshot to the TUI shell (no-op elsewhere). */
	private pushActivity(): void {
		if (this.input.setActivity === undefined) return;
		const working = this.activityTools.size > 0 || this.activityAgents.size > 0;
		const snapshot: ActivitySnapshot = {
			phase: this.state === "idle" ? "idle" : working ? "working" : "thinking",
			tools: [...this.activityTools.values()],
			agents: [...this.activityAgents.values()],
		};
		this.input.setActivity(snapshot);
	}

	/** Clear live rows (turn end, interrupt, exit) and park the region at idle. */
	private clearActivity(): void {
		this.activityTools.clear();
		this.activityAgents.clear();
		// Phase is parked at idle explicitly: callers run this at the END of a
		// turn, when this.state may not have flipped back yet — pushActivity()
		// would then report "thinking" and the row (and its ticker) would live on.
		if (this.input.setActivity === undefined) return;
		this.input.setActivity({ phase: "idle", tools: [], agents: [] });
	}

	private returnToIdle(): void {
		this.clearActivity();
		if (this.state === "exited") return;
		if (this.pendingExitCode !== null) {
			const code = this.pendingExitCode;
			this.pendingExitCode = null;
			this.gracefulExit(code);
			return;
		}
		if (this.eofPending) {
			this.gracefulExit(0);
			return;
		}
		this.state = "idle";
		this.input.setActive(false); // TUI: the hint row returns to its idle text
	}

	/** Push the queue visual (TUI shells): one row per queued entry with
	 *  its routing label, under a "N queued" head — cleared when empty.
	 *  Called at every queue mutation — push, steering consumption, leftover
	 *  flush, dequeue, and abort-restore. */
	private syncQueue(): void {
		const views: QueueEntryView[] = this.queue.map((entry) => ({
			label: entryLabel(entry),
			preview: queuePreviewText(entryDisplay(entry) ?? entryText(entry)),
		}));
		this.input.setQueue?.(views);
	}

	/** Pull every queued entry back out as editable text (alt+up / esc+p,
	 *  and the abort paths): TUI shells get the joined text dropped into the
	 *  editor above any in-progress draft; the legacy shell has no editor,
	 *  so the texts echo as notes — either way nothing is silently lost
	 *  (pi's rule: user input is never discarded without being handed
	 *  back). */
	private restoreQueueToEditor(): void {
		const texts = this.queue.map(entryText);
		this.queue = [];
		this.syncQueue();
		if (texts.length === 0) return;
		// Exiting (pending exit or EOF): the editor closes with the shell, so
		// the texts echo as notes — otherwise the TUI restore would land in a
		// box that vanishes a tick later (review P2).
		const exiting = this.pendingExitCode !== null || this.eofPending;
		if (this.input.setText !== undefined && !exiting) {
			const draft = this.input.getText?.() ?? "";
			const combined = [texts.join("\n\n"), draft].filter((t) => t.trim() !== "").join("\n\n");
			this.input.setText(combined);
			this.renderer.note(`▪ restored ${texts.length} queued message(s) to the editor`);
			// Declared semantics: resubmitting the restored blob re-interprets
			// it as ONE submission — a blob starting with "!" runs as a single
			// (possibly multi-line) shell command, and a restored {prompt} body
			// loses its never-re-interpret protection (that holds pre-restore).
			// The texts are visible in the editor before submit; the user decides.
		} else {
			this.renderer.note(`▪ ${texts.length} queued message(s) not run:`);
			for (const text of texts) this.renderer.note(`▪ ${text}`);
		}
		this.input.refresh();
	}

	/** alt+up / esc+p (TUI): queued input is not a one-way door — pull it all
	 *  back into the editor and keep editing. The run, if any, is untouched. */
	handleDequeue(): void {
		if (this.state === "exited") return;
		if (this.queue.length === 0) {
			this.renderer.note("▪ no queued messages to restore");
			return;
		}
		this.restoreQueueToEditor();
	}

	private requestExit(code: number): void {
		if (this.state === "idle") {
			this.gracefulExit(code);
			return;
		}
		this.pendingExitCode = code; // exits when the active phase settles
		this.controller?.abort();
	}

	private gracefulExit(code: number): void {
		if (this.state === "exited") return;
		this.state = "exited";
		const session = this.runner.session;
		if (session) {
			const id8 = session.header.id.slice(0, 8);
			this.renderer.note(`▪ session ${id8} saved — resume with: imp -r ${id8}`);
		} else {
			this.renderer.note("▪ bye");
		}
		this.finish(code);
	}

	private forceExit(code: number): void {
		if (this.state === "exited") return;
		this.state = "exited";
		// Close dangling tool_use in the session so a force-quit run stays
		// resumable (single Ctrl+C is handled by the loop; this is the 130 path).
		this.runner.persistMissingToolResults("(force quit before this tool ran)");
		try {
			this.exit(code); // process.exit in production
		} catch {
			// injected test exit threw its sentinel — resolve the loop below
		}
		this.finish(code);
	}

	private reportError(err: unknown): void {
		this.renderer.error(`imp: ${err instanceof Error ? err.message : String(err)}`);
	}

	private commandContext(authorizedStateful = false): CommandContext {
		const ctx: CommandContext = {
			runner: this.runner,
			renderer: this.renderer,
			isActive: () => !authorizedStateful && (this.state === "running" || this.state === "compacting"),
			replay: this.replay,
			requestExit: (code: number) => this.requestExit(code),
			// Md quick commands (M11 #6) land here: a prompt, not a rerouted
			// line — body text starting with "/" or "!" must stay model content.
			submitPrompt: (text: string, opts?: { display?: string }) => this.enqueuePrompt(text, opts?.display),
			clearView: this.input.clearConversation?.bind(this.input), // TUI: /new wipes the screen
			refreshFooter: () => this.refreshFooter(), // /think repaints the level segment
			abortActive: () => {
				if (this.controller !== null) {
					this.controller.abort();
					return true;
				}
				return false;
			},
			// the guarded /login registers its OAuth controller here so the
			// compacting-state Ctrl+C path can abort it. A SUPERSEDED flow
			// (a second /login typed while one polls) cancels first — the old
			// poll's catch sees "Login cancelled" and stays silent.
			onLongOpAbort: (controller) => {
				if (controller !== null && this.longOpAbort !== null && this.longOpAbort !== controller) {
					this.longOpAbort.abort();
				}
				this.longOpAbort = controller;
			},
		};
		// The item picker exists only on shells that implement it (TuiShell —
		// M9 phase 2); binding it to the input keeps the method's `this`.
		// Commands without it keep their text fallbacks.
		const select = this.input.select?.bind(this.input);
		if (select !== undefined) ctx.select = select;
		const secret = this.input.secret?.bind(this.input);
		if (secret !== undefined) ctx.secret = secret;
		return ctx;
	}
}

/**
 * Runs the interactive REPL. Resolves with the exit code on graceful exits
 * (0/130, zero-line stdin ⇒ 1); force exits go through the injected `exit`
 * (default process.exit) and resolve the same code without awaiting the run.
 */
export async function runRepl(options: ReplOptions): Promise<number> {
	const stdin = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const interactive =
		options.interactive ?? ((stdin as { isTTY?: boolean }).isTTY === true && output.isTTY === true);
	const runner = options.runner;
	const release = options.releaseStartupNotes;
	const renderer = runner.renderer; // one renderer, one newline state, shared with the runner
	const shell: ReplShell = options.shell ?? resolveShell();
	const useTui = interactive && shell === "tui";
	const transcript = options.transcript;
	if (useTui && transcript === undefined) {
		// The Renderer is built before runRepl (cli.ts) and must already feed
		// this exact sink — arriving without one is a wiring bug, not a mode.
		throw new Error(
			'runRepl: shell "tui" requires the transcript the Renderer feeds (ReplOptions.transcript)',
		);
	}
	// Narrowed once for every later use (guards don't carry into closures).
	const tuiSink: TranscriptSink | null = useTui && transcript !== undefined ? transcript : null;
	// Autocomplete config for the TUI shell (M10): imp's commands + extension
	// commands, the process cwd for @ paths, and fd — probed once (cached per
	// process); a PATH-resolvable name is all the provider's spawn needs.
	// Without fd only the @ fuzzy search is dropped; slash completion stays.
	let autocomplete: AutocompleteOptions | undefined;
	if (tuiSink !== null) {
		const fdPath = (await detectBinary("fd")) ? "fd" : null;
		autocomplete = {
			commands: autocompleteCommands(options.commands ?? []),
			basePath: process.cwd(),
			fdPath,
		};
	}
	// /resume clears the view first (see the command) — replay itself never
	// clears, because the startup banner is already on screen when it runs.
	const replay = (session: SessionStore): number =>
		replaySession(
			{
				write: tuiSink ? tuiSink.feed : (text) => output.write(text),
				ansi: tuiSink !== null || output.isTTY === true,
				markdown: true,
				userSink: tuiSink ? (text) => tuiSink.feedUser(text) : undefined,
				statusSink: tuiSink ? (text) => tuiSink.feedStatus(text) : undefined,
				hideThinking: renderer.hideThinking,
			},
			session,
		);

	let resolveDone!: (code: number) => void;
	const done = new Promise<number>((resolve) => {
		resolveDone = resolve;
	});
	let doneResolved = false;
	const finish = (code: number): void => {
		if (doneResolved) return;
		doneResolved = true;
		input.close();
		resolveDone(code);
	};

	let machine: ReplMachine;
	const input: LineInput =
		tuiSink !== null
			? new TuiShell({
					onLine: (line, mode) => machine.handleLine(line, mode),
					onInterrupt: () => machine.handleInterrupt(),
					onEof: () => machine.handleEof(),
					onDequeue: () => machine.handleDequeue(),
					onCycleThinking: () => machine.cycleThinking(),
					onToggleThinking: () => machine.toggleThinkingVisibility(),
					transcript: tuiSink,
					terminal: options.terminal,
					autocomplete,
					historyPath: options.inputHistoryPath,
				})
			: new ReplInput({
					input: stdin,
					output,
					interactive,
					onLine: (line) => machine.handleLine(line), // Enter only — steer is the legacy default
					onInterrupt: () => machine.handleInterrupt(),
					onEof: () => machine.handleEof(),
				});
	machine = new ReplMachine({
		runner,
		commands: options.commands ?? [],
		renderer,
		input,
		interactive,
		exit: options.exit ?? ((code: number) => process.exit(code)),
		finish,
		replay,
	});
	// api.confirm's tty side: route questions to this REPL's single readline
	// interface (a second interface would race it for stdin bytes). With a
	// picker-capable shell the host also gets select — the three-option
	// confirm (M10) reuses the same binding path as ctx.select.
	options.confirm?.bind((question: string) => input.ask(question));
	const confirmSelect = input.select?.bind(input);
	if (confirmSelect !== undefined) options.confirm?.bindSelect(confirmSelect);

	input.start();
	if (interactive) {
		const session = runner.session;
		const fresh = session !== null && session.stats().messageCount === 0;
		if (fresh) {
			// fresh conversation → the welcome panel (whole box dim, like
			// Claude Code); session identity rides inside it
			// logo gradient + tips as-is; the identity line rides dim
			const welcome = welcomeLines(
				session.header.id.slice(0, 8),
				runner.modelReference(),
				renderer.ansiEnabled,
			);
			for (const line of welcome.slice(0, -1)) renderer.writeLine(line);
			const identity = welcome[welcome.length - 1];
			if (identity !== undefined) renderer.writeLine(renderer.dim(identity));
		} else {
			renderer.writeLine(`imp ${VERSION} — /help for commands · Ctrl+D exits`);
		}
		// the greeting (or the resumed banner) owns the top of the screen;
		// deferred environment notes (extensions, context, trust) follow it
		release?.();
		if (!fresh && session) {
			renderer.note(`▪ session ${session.header.id.slice(0, 8)} · model ${runner.model}`);
			// Replay the resumed history so the user sees what the model sees
			// (the crash-recovery loop's missing half).
			const replayed = replay(session);
			if (replayed > 0) renderer.note(`▪ replayed ${replayed} messages — context restored`);
		}
		input.refresh(); // banner block ends with a fresh idle prompt
	}
	return done;
}
