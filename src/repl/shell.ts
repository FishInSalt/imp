import { applyWarnSpans, dim } from "../format.js";
import { SPINNER_FRAMES } from "../render.js";
import {
	type AutocompleteSlashCommand,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type EditorOptions,
	type EditorTheme,
	isKeyRelease,
	isYes,
	matchesKey,
	ProcessTerminal,
	SelectList,
	Spacer,
	type Terminal,
	Text,
	TUI,
	truncateToWidth,
} from "../tui.js";
import { type ClipboardImage, readClipboardImage, writeClipboardImageToTmp } from "./clipboard-image.js";
import { Fold } from "./components/fold.js";
import { SectionRule } from "./components/section-rule.js";
import { activityCount, activityText, renderCommandHeader, ToolActivity } from "./components/tool-block.js";
import { TreeSelectorBox, TreeSelectorComponent } from "./components/tree-selector.js";
import { appendInputHistory, loadInputHistory } from "./history.js";
import type {
	ActivitySnapshot,
	LineInput,
	LineInputEvents,
	QueueEntryView,
	SelectOptions,
	TreeSelectRequest,
} from "./line-input.js";
import { LoginDialog, type LoginDialogOptions } from "./login-dialog.js";
import type { ToolColor } from "./tool-colors.js";
import { sanitizeDisplay } from "./tool-presentation.js";
import type { TranscriptSink } from "./transcript.js";

/** Autocomplete wiring for the editor (M10): slash commands at line start
 *  and @ file completion anywhere, both through pi-tui's combined provider.
 *  fdPath null (fd not found) keeps slash completion and drops only the @
 *  fuzzy search. */
export interface AutocompleteOptions {
	/** Commands in pi-tui's autocomplete shape (name/description/argumentHint). */
	commands: readonly AutocompleteSlashCommand[];
	/** Directory @ completions and plain path prefixes resolve against. */
	basePath: string;
	/** fd binary path (PATH-resolvable name is fine), or null to disable. */
	fdPath: string | null;
}

export interface TuiShellOptions extends LineInputEvents {
	/** alt+up / esc+p: pull all queued input back into the editor for
	 *  editing (pi's "dequeue"). */
	onDequeue(): void;
	/** shift+tab: cycle the thinking level (#thinking-levels, pi's default
	 *  binding). Wired to the /think cycle body in repl.ts. */
	onCycleThinking(): void;
	/** ctrl+t — pi's app.thinking.toggle: hide/show reasoning traces. */
	onToggleThinking(): void;
	/** ctrl+l — pi's app.model.select: open the /model picker. */
	onModelSelect(): void;
	/** Shared with the Renderer's write sink — the transcript IS the output. */
	transcript: TranscriptSink;
	/** Injected in tests; default binds the real process terminal. */
	terminal?: Terminal;
	editorOptions?: EditorOptions;
	/** Editor autocomplete (M10); absent leaves the editor provider-less. */
	autocomplete?: AutocompleteOptions;
	/** Cross-session input history file (M11 #4). Absent (tests, hermetic
	 *  runs) disables persistence entirely — in-memory recall still works. */
	historyPath?: string;
	/** #tool-name-colors: the composed name-color resolver (extensions, then
	 *  defaults), set once by repl.ts at construction; used for the confirm
	 *  preview's call-header idiom. Absent keeps the legacy bytes. */
	toolColorResolver?: (name: string) => ToolColor | undefined;
	/** M13 batch 2: Ctrl+V image paste. Reads the system clipboard, writes
	 *  a tmp file, inserts the path at the cursor. Injected in tests. */
	pasteImage?: () => Promise<ClipboardImage | null>;
	/** Text fallback when the clipboard has no image (Ctrl+V). Injected in
	 *  tests — the default really runs pbpaste/xclip (review P1-2). */
	pasteText?: () => Promise<string | null>;
}

/** Identity functions throughout — the pre-M9 plain aesthetic. */
export function tuiEditorTheme(): EditorTheme {
	return {
		borderColor: (s) => s,
		selectList: {
			selectedPrefix: (s) => s,
			selectedText: (s) => s,
			description: (s) => s,
			scrollInfo: (s) => s,
			noMatch: (s) => s,
		},
	};
}

/**
 * The pi-tui REPL shell (M9). Layout follows pi's interactive mode:
 *
 *   TUI
 *   ├─ transcript (TranscriptSink — the Renderer's output, hosted;
 *   │              tool-result folds render INLINE here, directly under
 *   │              their ● line — pi parity, no separate fold region)
 *   ├─ activity   (live tool/subagent rows while a turn runs; zero rows idle)
 *   ├─ ask line   ([y/N] question while one is pending; an item selector
 *   │              while one is open; hidden otherwise)
 *   ├─ queue rows (dim per-entry previews under a "N queued" head, plus
 *   │              the dequeue hint; hidden at 0)
 *   ├─ hint row   (dim placeholder while idle with an empty editor and no
 *   │              pending ask: the "/ @ ! newline" cheat sheet; zero
 *   │              rows otherwise)
 *   ├─ editor     (a bordered box — it alone marks "type here", CC-style;
 *   │              focused except while a selector is open; its autocomplete
 *   │              panel — slash commands, @ files — renders in place)
 *   ├─ footer     (dim status line: model · session · cumulative tokens;
 *                 pushed by the machine, pi places it below the editor too)
 *   └─ extension  (extension-owned status line, host-styled; zero rows
 *                 while no extension has set one — task-timer design §4.3)
 *
 * Semantics are the readline shell's, byte-for-byte where bytes are visible:
 * the ask FIFO (lines answer pending questions first; Ctrl+C declines;
 * EOF declines all) and interrupt routing. The readline-era "> "/"+ " marker
 * row is gone (dogfood 2026-09-09): the editor's box marks the input, the
 * activity region marks a running turn, and the hint row's idle-only rule
 * already encodes the same bit. Known
 * deviations (parity ledger, to revisit as M9 polishes):
 *  - Ctrl+D with text in the editor goes to the editor (readline would
 *    delete-forward); Ctrl+D on an empty editor stays EOF — with or
 *    without a pending ask (a typed draft always wins over drain+EOF).
 *  - Ctrl+C always interrupts (the editor's selection-copy binding is
 *    unreachable while an ask is pending; plain interrupt otherwise).
 *    Kitty key-RELEASE events are filtered first — one press is one
 *    interrupt (M9 review P0: press+release double-fired).
 *  - Submissions are trim()-ed by the editor (readline delivered raw).
 *  - Folds (addFold) are a TUI-only affordance with no readline
 *    counterpart: the collapsed "▸ title" lines render INLINE in the
 *    transcript stream, anchored directly below the completed line they
 *    follow — a tool result lands under its `● … ✓` line and later text
 *    streams below the fold (pi parity 2026-09-10; v1 parked all folds
 *    in a region below the stream, drifting them away from their calls
 *    and accumulating across turns). The producer is the machine's
 *    tool_end tap: every successful edit result ("<summary>:\n<diff>")
 *    becomes one fold, so Ctrl+O is live in real sessions; Ctrl+O
 *    expands all if any are collapsed, otherwise collapses all; with no fold present
 *    the key falls through to the editor, which has no Ctrl+O binding
 *    (a no-op).
 *  - Multi-line editor submits arrive as ONE line event with embedded
 *    newlines (readline split them into separate events); a multi-line
 *    answer to an [y/N] ask is judged on the whole text, so "y\nfootnote"
 *    declines and loses the footnote.
 *  - While an item selector is open (select — /model with no args): the
 *    list takes focus, so keystrokes steer the selection instead of the
 *    editor; Ctrl+C cancels it (the readline-era interrupt NEVER fires —
 *    the selector outranks both interrupt and a pending ask), and Ctrl+D
 *    is swallowed (no EOF, no delete-forward) until it resolves. A second
 *    select() while one is open declines to null (the first stays live);
 *    a question queued by ask() while a picker owns the keys is held and
 *    rendered by the picker's finish(); SIGINT tears the picker down
 *    before interrupting. The readline shell has no selector — its /model
 *    keeps printing text.
 *  - Esc while a turn (or a ! passthrough) runs mirrors Ctrl+C exactly
 *    (M10). It falls through unconsumed, so with the editor's autocomplete
 *    panel ALSO open one Esc does both — closes the panel and interrupts:
 *    pi-tui exposes no panel-visibility state to split the two consumers
 *    (known edge, stated in HELP_KEYS). While a picker is open Esc stays
 *    the picker's cancel, never an interrupt.
 *  - The editor's autocomplete panel (slash commands at line start, @
 *    files anywhere) is pi-tui's built-in and a TUI-only affordance (M10):
 *    ↑/↓ move, Tab/Enter complete, Esc closes. Enter on a slash completion
 *    completes AND submits in one press (pi-tui falls through for "/"
 *    prefixes); on @ completions Enter only completes. The @ list inserts
 *    path text — it does NOT read files into the turn. The readline shell
 *    has no panel.
 */

/** The hint row's text (M10): input affordances, dim — input aid only,
 *  @ inserts path text, it never reads files into the turn. */
const PLACEHOLDER_HINT = dim(
	"(/ for commands · @ files · ! bash · shift+enter newline · alt+enter follow-up)",
	true,
);
/** The same row while a turn runs: the esc affordance belongs on screen the
 *  whole run (dogfood 2026-09-09 #8) — a stuck bash is exactly when users
 *  reach for it, and "typing queues" advertises steering. */
const INTERRUPT_HINT = dim("(esc to interrupt · typed lines queue · alt+enter follow-up)", true);

/** #ask-timeout: setTimeout's platform ceiling (2^31 - 1 ms ≈ 24.85 days).
 *  Node fires delays above it after ~1 ms (TimeoutOverflowWarning) — a
 *  caller's "very long" deadline would otherwise refuse every ask
 *  instantly, so deadlines clamp here instead of overflowing. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** #ask-timeout-countdown (design §12 D9): the ONE validated + clamped
 *  deadline source — row visibility, initial text, countdown anchor and the
 *  timeout timer all read this, so what is displayed can never diverge from
 *  what is timed. Invalid values (non-finite / ≤ 0 / non-number) mean "no
 *  deadline". */
export function effectiveTimeoutMs(value: number | undefined): number | null {
	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TIMER_MS) : null;
}

/** #ask-timeout-countdown (design §12 D11): `times out in …` duration text
 *  for a REMAINING duration in milliseconds. The floor is 1 s (`0:01`): the
 *  formatter structurally never emits `0:00`, independent of timer callback
 *  ordering (D13). Minutes use floor/remainder — `0:60` is impossible. */
export function countdownText(remainingMs: number): string {
	if (!Number.isFinite(remainingMs)) return "0:01"; // defensive; the single source never passes non-finite input
	const s = Math.max(1, Math.ceil(remainingMs / 1000));
	if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
	return `${Math.floor(s / 86400)}d ${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")}h`;
}

/** #confirm-prompt (Phase 1 D2): the picker's key affordance, drawn inside the
 *  picker box because the editor hint row is blanked while a selector owns
 *  focus. The digit range is computed from the item count (D3 caps it at 9);
 *  a single-item picker has no digit segment — there is nothing to quick-pick. */
function pickerAffordance(count: number): string {
	const range = Math.min(count, 9);
	return `(↑/↓ move · enter select · esc cancel${range > 1 ? ` · 1-${range} quick pick` : ""})`;
}

/** #task-inline-live-rows (B1): element-wise row comparison, so an unchanged
 *  live row never invalidates a fold's render cache. */
function rowsEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((row, index) => row === b[index]);
}

export class TuiShell implements LineInput {
	private readonly options: TuiShellOptions;
	/** One theme for every pi-tui component (editor AND select lists). */
	private readonly theme: EditorTheme = tuiEditorTheme();
	private tui: TUI | null = null;
	private terminal: Terminal | null = null;
	/** The exact closure bound to the shared sink's onUpdate (ownership
	 *  check in stopTerminal) and the whenSettled handshake (review P0). */
	private boundOnUpdate: (() => void) | null = null;
	private settlePromise: Promise<void> | null = null;
	private settleResolve: (() => void) | null = null;
	private editor: Editor | null = null;
	private askContainer = new Container();
	/** Fold children live INLINE in the transcript (pi parity); this
	 *  list mirrors them for Ctrl+O's expand-all. Newest last. */
	private readonly folds: Fold[] = [];
	/** The ask line's Text child, tracked so a selector sharing the ask
	 *  region can never remove (or be removed by) the question line. */
	private askLine: Text | null = null;
	/** The queue visual line, below the ask region (empty = zero rows). */
	private queueLine: Text | null = null;
	/** Activity region (M10 B): live tool/subagent rows between the
	 *  transcript and the ask line. Owns the spinner animation so elapsed
	 *  seconds tick without machine pushes. */
	private readonly activityContainer = new Container();
	private activity: ActivitySnapshot = { phase: "idle", tools: [], agents: [] };
	private activityTimer: ReturnType<typeof setInterval> | null = null;
	private activityFrame = 0;
	/** Cache only active rows, never historical payloads. */
	private activityRows = new Map<string, ToolActivity>();
	private taskOrdinals = new Map<string, { ordinal: number; sources: Map<string, number> }>();
	/** #task-inline-live-rows (B1) / #tool-inline-live-rows: current live rows
	 *  per call key (tool_call id, or a task parent key). Read by the resolver
	 *  at fold-creation time, and diffed against the next pass so identical
	 *  rows never invalidate the fold cache. */
	private callLiveRows = new Map<string, readonly string[]>();
	/** #call-closing-status (D3, Amendment 1): the running timer text per
	 *  call (`Ns`, a bare ticking count), rendered in the call fold's closing
	 *  slot. */
	private callSuffixes = new Map<string, string>();
	/** Ownership guard for the shared sink's resolver (mirrors boundOnUpdate). */
	private boundLiveRowsResolver: ((key: string) => readonly string[] | null) | null = null;
	/** #call-closing-status (D3): ownership guard for the suffix resolver. */
	private boundSuffixResolver: ((key: string) => string | null) | null = null;
	/** Buffered setQueue text — pushes may arrive before start() and must not
	 *  be dropped (same contract as the footer). */
	private queueText = "";
	/** The open selector, if any — finished on pick, cancel, or close. */
	private selector: {
		teardown: () => void;
		filterKey?: (data: string) => boolean;
		numberKey?: (data: string) => boolean;
	} | null = null;
	/** Pickers queued behind an open one (M10): opened when it finishes. */
	private pendingSelects: Array<() => void> = [];
	private footer: Text | null = null;
	/** The dim hint row above the editor (M10). */
	private placeholder: Text | null = null;
	private noticeRow: Text | null = null;
	private noticeText = "";
	private noticeTimer: ReturnType<typeof setTimeout> | null = null;
	/** Marker-side mirror of the machine's active flag (setActive). */
	private active = false;
	/** Editor text mirror (onChange keeps it current) — placeholder input. */
	private editorText = "";
	/** Buffered setFooter text — pushes may arrive before start() (the
	 *  machine's constructor runs first) and must not be dropped (M9-2
	 *  review P1: the startup footer was silently blank). */
	private footerText = "";
	/** Buffered setExtensionStatus text (sanitized on write, truncated +
	 *  dimmed at each application point — the footerText pattern, raw in the
	 *  buffer). Empty renders zero rows. */
	private extensionFooterText = "";
	private extensionFooter: Text | null = null;
	/** Buffered OSC title — the machine's first setTitle may arrive before
	 *  start() (its constructor-time footer push); start() paints it. */
	private titleText = "";
	private history: string[] = [];
	private closed = false;
	/** Terminal restore ran (close's deferred stop or the process-exit hook). */
	private stopped = false;
	private detachInput: (() => void) | null = null;
	private onProcessSigint: (() => void) | null = null;
	private onStdinEnd: (() => void) | null = null;
	/** Same FIFO contract as ReplInput.pendingAsks. A queued entry is either
	 *  a yes/no confirm (api.confirm) or a text question (/login's api-key
	 *  prompt — pi's LoginDialog input; typed text renders unmasked, exactly
	 *  like pi's own dialog, and never reaches input history). */
	private pendingAsks: Array<
		| { kind: "yesno"; question: string; resolve: (approved: boolean) => void }
		| { kind: "text"; question: string; resolve: (answer: string | null) => void }
	> = [];

	constructor(options: TuiShellOptions) {
		this.options = options;
	}

	start(): void {
		if (this.tui !== null || this.closed) return;
		const terminal = this.options.terminal ?? new ProcessTerminal();
		this.terminal = terminal;
		const tui = new TUI(terminal, true); // hardware cursor: IME candidate positioning
		this.tui = tui;
		this.boundOnUpdate = () => tui.requestRender();
		this.options.transcript.onUpdate = this.boundOnUpdate;
		// #task-inline-live-rows (B1) / #tool-inline-live-rows: set BEFORE any
		// fold is created, so a call fold created after the shell published its
		// rows still pulls them.
		this.boundLiveRowsResolver = (key) => this.callLiveRows.get(key) ?? null;
		this.options.transcript.callLiveRowsResolver = this.boundLiveRowsResolver;
		// #call-closing-status (D3): same late-fold pull for the running timer.
		this.boundSuffixResolver = (key) => this.callSuffixes.get(key) ?? null;
		this.options.transcript.callSuffixResolver = this.boundSuffixResolver;

		const placeholder = new Text("", 0, 0); // empty Text renders zero rows
		this.placeholder = placeholder;
		const noticeRow = new Text("", 0, 0);
		this.noticeRow = noticeRow;
		const editorBox = new Container();
		const editor = new Editor(tui, this.theme, this.options.editorOptions);
		this.editor = editor;
		editor.onSubmit = (text) => this.submit(text);
		if (this.options.autocomplete !== undefined) {
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					[...this.options.autocomplete.commands],
					this.options.autocomplete.basePath,
					this.options.autocomplete.fdPath,
				),
			);
		}
		// Mirror the editor text for the hint row. Chain any onChange wired
		// above (none today — defensive) so nothing else's hook is dropped.
		const previousOnChange = editor.onChange;
		editor.onChange = (text) => {
			previousOnChange?.(text);
			this.editorText = text;
			this.updatePlaceholder();
		};
		editorBox.addChild(editor);

		// Cross-session recall (M11 #4): seed the editor's history from the
		// file's tail, oldest first (addToHistory appends). A broken store
		// degrades to session-only recall inside loadInputHistory.
		if (this.options.historyPath !== undefined) {
			for (const line of loadInputHistory(this.options.historyPath)) {
				this.editor?.addToHistory(line); // append order: oldest → newest
				this.history.unshift(line); // shell contract: newest first (review P2 — the dedupe reads [0])
			}
		}

		tui.addChild(this.options.transcript);
		tui.addChild(this.activityContainer); // live tool/subagent rows (M10 B)
		tui.addChild(this.askContainer);
		const queueLine = new Text(this.queueText, 0, 0);
		this.queueLine = queueLine;
		tui.addChild(queueLine); // queue visual sits between the ask line and the hint row
		tui.addChild(placeholder); // base hints stay independent of temporary feedback
		tui.addChild(noticeRow);
		tui.addChild(editorBox);
		const footer = new Text(this.footerText === "" ? "" : dim(this.footerText, true), 0, 0);
		this.footer = footer;
		tui.addChild(footer); // status line below the editor (pi's placement)
		const extensionFooter = new Text(this.extensionStatusRendered(), 0, 0);
		this.extensionFooter = extensionFooter;
		tui.addChild(extensionFooter); // extension-owned status below the footer
		tui.setFocus(editor);
		tui.start();
		if (this.titleText !== "") terminal.write(`\x1b]2;${this.titleText}\x07`);

		// Pre-focus routing (runs before the editor sees the key): the
		// machine's interrupt/EOF semantics own Ctrl+C / Ctrl+D outright,
		// except Ctrl+D with text, which stays an editing key.
		this.detachInput = tui.addInputListener((data) => {
			// Kitty protocol reports key RELEASES as their own sequences; a
			// release must not count as a second press (M9 review P0).
			if (isKeyRelease(data)) return undefined;
			// An open selector outranks the machine's key semantics: Ctrl+C
			// flows on to the focused list (its cancel binding — never the
			// interrupt), and Ctrl+D is swallowed (no EOF mid-selection).
			if (this.selector !== null) {
				if (matchesKey(data, "ctrl+c")) return undefined;
				if (matchesKey(data, "ctrl+d")) return { consume: true };
				// A filterable picker eats printable input as its query (M11 #9)
				// before the list or the editor could see it.
				if (this.selector.filterKey?.(data) === true) return { consume: true };
				// #confirm-prompt (Phase 1 D3): digits quick-pick on non-filterable
				// pickers — checked after filterKey, which owns printables there.
				if (this.selector.numberKey?.(data) === true) return { consume: true };
			}
			// Ctrl+V (M13 batch 2, pi's app.clipboard.pasteImage): read the system
			// clipboard — an image becomes a tmp-file path at the cursor; text
			// pastes as text. An open selector keeps its keys; bracketed paste
			// (terminal Cmd+V) never reaches here.
			if (this.selector === null && matchesKey(data, "ctrl+v")) {
				void this.handlePasteImage();
				return { consume: true };
			}
			if (this.selector === null && matchesKey(data, "alt+enter")) {
				// Alt+enter routes the editor text as a follow-up (pi parity): it
				// waits for the running turn to settle instead of steering into
				// it. Idle (or with a pending ask) it is just a submit — the mode
				// only matters behind a live run. An open picker keeps its keys.
				// Review P1: expansion + trim mirror the Enter pipeline
				// (submitValue) — a large paste must submit its BODY, not the
				// "[paste #N]" marker, and the text must be trimmed like Enter's.
				const text = editor.getExpandedText().trim();
				if (this.pendingAsks.length > 0 || text !== "") {
					editor.setText(""); // Enter submits clear the editor for us; alt+enter must do it itself
					this.submit(text, "followUp");
				}
				return { consume: true };
			}
			// alt+up — and esc+p, which works on terminals without the Kitty
			// protocol (pi-tui maps both) — pulls queued input back for editing.
			if (this.selector === null && matchesKey(data, "alt+up")) {
				this.options.onDequeue();
				return { consume: true };
			}
			// shift+tab cycles the thinking level (pi's default binding; the
			// editor has no shift+tab binding of its own). A model without a
			// knob reports it as a note instead of silently doing nothing.
			if (this.selector === null && matchesKey(data, "ctrl+t")) {
				this.options.onToggleThinking();
				return { consume: true };
			}
			if (this.selector === null && matchesKey(data, "shift+tab")) {
				this.options.onCycleThinking();
				return { consume: true };
			}
			// Ctrl+L — pi's app.model.select: open the model picker (the same
			// command the line "/model" runs). Allowed mid-run like the typed
			// command. Held back while a question is pending: typed input would
			// answer that question, so the key must not bypass the ask FIFO;
			// with a picker already open the guard above keeps its keys.
			if (this.selector === null && this.pendingAsks.length === 0 && matchesKey(data, "ctrl+l")) {
				this.options.onModelSelect();
				return { consume: true };
			}
			// Esc while active mirrors Ctrl+C (M10) — same settle-or-interrupt
			// path — UNLESS the editor's autocomplete panel is VISIBLE: then the
			// first Esc only closes the panel (debt clearance — pi-tui grew
			// isShowingAutocomplete()). Caveat (review): during the ~20ms
			// autocomplete debounce the panel is not yet visible, so Esc
			// interrupts — and the late panel may then pop over the aborted
			// turn (closeable with another Esc; upstream cancel API pending).
			// While
			// a selector is open Esc stays the selector's cancel — never an
			// interrupt.
			if (
				(this.active || this.pendingAsks.length > 0) &&
				this.selector === null &&
				matchesKey(data, "escape") &&
				editor?.isShowingAutocomplete() !== true
			) {
				// #login-repl: Esc also cancels an IDLE question (the secret
				// prompt) — pi's dialogs cancel on Esc; before, only an active
				// run routed Esc here and an idle prompt sat un-cancellable.
				if (this.pendingAsks.length > 0) this.settleAsk(null);
				else this.options.onInterrupt();
				return undefined;
			}
			if (matchesKey(data, "ctrl+c")) {
				if (this.pendingAsks.length > 0) this.settleAsk(null);
				else this.options.onInterrupt();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+d")) {
				// A typed draft always wins: Ctrl+D stays an editing key while
				// there is text, even with a pending ask (readline parity).
				if (editor.getText() !== "") return undefined;
				if (this.pendingAsks.length > 0) this.drainAsks();
				this.options.onEof();
				return { consume: true };
			}
			// Fold affordance (TUI-only; see the parity ledger).
			if (matchesKey(data, "alt+o") && this.selector === null && this.pendingAsks.length === 0) {
				// Structured calls swap to their readable/raw arguments; nothing
				// structured on screen leaves the key unbound (editor fallback).
				if (!this.options.transcript.toggleRawToolArguments()) return undefined;
				tui.requestRender();
				return { consume: true };
			}
			// Ctrl+O: expand/collapse ALL folds — v1 toggled only the newest, which
			// left mid-turn results permanently unexpandable (declared debt,
			// cleared): any-collapsed → expand all; all-expanded → collapse all.
			// With none present the key passes through to the editor — which has
			// no Ctrl+O binding, so effectively a no-op.
			if (matchesKey(data, "ctrl+o")) {
				const folds = [...this.folds, ...this.options.transcript.toolFolds];
				if (folds.length === 0) return undefined;
				const expand = folds.some((f) => !f.isExpanded());
				for (const fold of folds) fold.setExpanded(expand);
				this.tui?.requestRender();
				return { consume: true };
			}
			return undefined;
		});

		// `kill -INT` and a closing stdin: same drains as the readline shell.
		this.onProcessSigint = () => {
			this.selector?.teardown(); // a live picker dies with the interrupt, not after
			this.drainAsks();
			this.options.onInterrupt();
		};
		process.on("SIGINT", this.onProcessSigint);
		this.onStdinEnd = () => {
			// Mirror SIGINT (M10 semantic review P2): a dead pty must not leave a
			// confirm picker hanging — the gate would never settle, the process
			// would never exit.
			this.selector?.teardown();
			this.drainAsks();
			this.options.onEof();
		};
		process.stdin.on("end", this.onStdinEnd);
		// Force-exit (process.exit) never runs close(): restore the terminal
		// from the exit hook instead of leaving raw mode + hidden cursor on
		// the user's shell (M9 review P2). Registered for the process
		// lifetime; stopTerminal() is idempotent.
		process.on("exit", () => this.stopTerminal());
		this.updatePlaceholder(); // idle + empty editor: the hint row starts visible
	}

	private submit(text: string, mode: "steer" | "followUp" = "steer"): void {
		if (this.closed) return; // a submit racing shutdown must not start a turn
		if (this.pendingAsks.length > 0) {
			this.settleAsk(text === "" ? null : text);
			return;
		}
		if (text !== "") {
			// Feed the editor's own history — up-arrow recall reads it (M9
			// review P1: recall was dead while getHistory() reported data).
			this.editor?.addToHistory(text);
			// Mirror readline/editor semantics for the interface view: skip
			// consecutive duplicates, cap at 100.
			if (this.history[0] !== text) {
				this.history.unshift(text);
				// New head = a fresh line worth persisting (M11 #4). The
				// file's own dedupe rule mirrors this one.
				if (this.options.historyPath !== undefined) appendInputHistory(this.options.historyPath, text);
			}
			if (this.history.length > 100) this.history.length = 100;
		}
		this.options.onLine(text, mode);
	}

	setActive(active: boolean): void {
		this.active = active;
		this.updatePlaceholder();
		this.tui?.requestRender();
	}

	refresh(): void {
		this.tui?.requestRender();
	}

	/** Bottom status line. Empty text renders ZERO rows (pi-tui Text) — the
	 *  layout grows by the padded rows once text arrives; callers always
	 *  send non-empty (model is always present). */
	setFooter(text: string): void {
		// The TUI owns a real terminal, so ANSI is unconditional; dim keeps
		// the status visually quiet under the editor.
		this.footerText = text; // buffered: start() seeds from this
		this.footer?.setText(text === "" ? "" : dim(text, true));
		this.tui?.requestRender();
	}

	/** Extension-owned status line (LineInput.setExtensionStatus): untrusted
	 *  input — sanitize control sequences, collapse to one row, truncate to
	 *  the terminal width (pi-tui's renderer throws on a rendered line wider
	 *  than the terminal), host-dimmed (task-timer design §4.3). */
	setExtensionStatus(text: string): void {
		if (this.closed) return; // a leaked extension timer must not touch a torn-down shell
		// sanitizeDisplay preserves "\n" (already-spaced \t and literal \r
		// aside); the status is one line, so newlines fold to spaces here.
		this.extensionFooterText = sanitizeDisplay(text).replace(/\n+/g, " ");
		this.extensionFooter?.setText(this.extensionStatusRendered());
		this.tui?.requestRender();
	}

	/** Raw buffered text → one terminal-safe row. dim() is applied HERE, at
	 *  the application point (start() seed and push) — the buffer stays raw,
	 *  the footerText pattern. Truncation is push-time only: a resize-narrow
	 *  re-wraps (or throws on unbreakable text) until the next push — the
	 *  existing footer shares that exposure (accepted, design §4.3). */
	private extensionStatusRendered(): string {
		if (this.extensionFooterText === "") return "";
		const columns = this.tui?.terminal.columns ?? 80;
		const clipped = truncateToWidth(this.extensionFooterText, Math.max(1, columns - 1), dim("…", true));
		return dim(clipped, true);
	}

	/** Queue visual line (LineInput.setQueue): one dim row per queued entry
	 *  under a "N queued" head, plus the dequeue hint — pi's per-message
	 *  preview. Empty entries render ZERO rows (pi-tui Text) — the region
	 *  collapses away entirely. */
	setQueue(entries: readonly QueueEntryView[]): void {
		const rows = entries.map((entry) => dim(`  ${entry.label}: ${entry.preview}`, true));
		this.queueText =
			entries.length === 0
				? ""
				: [
						dim(`${entries.length} queued`, true),
						...rows,
						dim("  ↳ alt+up / esc+p to edit all queued", true),
					].join("\n");
		this.queueLine?.setText(this.queueText);
		this.tui?.requestRender();
	}

	/** Editor draft access (LineInput.getText/setText): the queue restore
	 *  reads the draft so it is preserved, and lands the joined queued input
	 *  above it. Expansion (review P1) — a large pasted draft must restore as
	 *  its content, never as the "[paste #N]" marker setText would then
	 *  destroy. No editor (pre-start) degrades to the mirror string. */
	getText(): string {
		return this.editor?.getExpandedText() ?? this.editorText;
	}

	setText(text: string): void {
		this.editor?.setText(text);
		this.editorText = text; // mirror (onChange covers the live editor; this pins the no-editor case)
		this.tui?.requestRender();
	}

	/** Terminal window title (OSC 2), straight to the terminal — never
	 *  through the TUI's frame pipeline, so it cannot disturb the
	 *  differential render. Buffered until start() paints it. */
	setTitle(title: string): void {
		this.titleText = title;
		this.terminal?.write(`\x1b]2;${title}\x07`);
	}

	/** Activity region (M10 B): rebuild rows from the snapshot; the ticker
	 *  (120ms, only while live) advances the spinner frame and re-renders so
	 *  elapsed seconds tick without machine pushes. */
	setActivity(snapshot: ActivitySnapshot): void {
		this.activity = snapshot;
		this.renderActivity();
		if (snapshot.phase === "idle") {
			if (this.activityTimer !== null) {
				clearInterval(this.activityTimer);
				this.activityTimer = null;
			}
			return;
		}
		if (this.activityTimer === null) {
			this.activityTimer = setInterval(() => {
				this.activityFrame = (this.activityFrame + 1) % SPINNER_FRAMES.length;
				this.renderActivity();
			}, 120);
			this.activityTimer.unref?.();
		}
	}

	/** Route every selector transition (set and clear) through here: it repaints
	 *  the activity region, because D10's tool-row suppression is PULLED —
	 *  requestRender() does not rebuild the activity container. */
	private setSelector(
		next: {
			teardown: () => void;
			filterKey?: (data: string) => boolean;
			numberKey?: (data: string) => boolean;
		} | null,
	): void {
		this.selector = next;
		this.renderActivity();
	}

	/** Rebuild the activity rows (dim; the ✓/⎿ completion lives in the
	 *  transcript — this region is pending state only). */
	private renderActivity(): void {
		this.activityContainer.clear();
		if (this.activity.phase === "idle") {
			this.activityRows.clear();
			this.taskOrdinals.clear();
			for (const key of this.callLiveRows.keys()) this.options.transcript.setCallLiveRows(key, null);
			this.callLiveRows.clear();
			for (const key of this.callSuffixes.keys()) this.options.transcript.setCallSuffix(key, null);
			this.callSuffixes.clear();
			this.tui?.requestRender();
			return;
		}
		const now = Date.now();
		const frame = SPINNER_FRAMES[this.activityFrame] ?? "⠋";
		// #call-closing-status Amendment 1 (A1.1): the running slot text is the
		// bare `Ns` — no `└─ running` chrome; `0s` while the first second is
		// unfinished; the count is floored and capped at `9999+` by activityCount.
		const runningText = (startedAtMs: number): string =>
			`${activityCount(Math.max(0, Math.floor((now - startedAtMs) / 1000)))}s`;
		// The live status row. Label "working…" (pi's WorkingStatusIndicator
		// wording): the model is active — streaming, thinking, or between
		// tools — not literally only thinking. The phase value itself keeps
		// the "thinking" name (snapshot contract; rename would churn tests).
		if (this.activity.phase === "thinking") {
			this.activityContainer.addChild(new Text(dim(`${frame} working…`, true), 0, 0));
		}
		if (this.activity.phase === "compacting") {
			// #compaction-ux F2: same Loader semantics as thinking — the state
			// machine owns the row's lifetime (idle push clears it). The label
			// follows the guarded command (review P2: /login has its own).
			const label = this.activity.compactingLabel ?? "compacting context…";
			this.activityContainer.addChild(new Text(dim(`${frame} ${label}`, true), 0, 0));
		}
		const active = new Map<string, ToolActivity>();
		// #tool-inline-live-rows: one map for every call's live rows; tool keys
		// are tool_call ids, agent keys are task call ids or sourceId UUIDs (the
		// key spaces are disjoint per message — design §5.2).
		const nextLiveRows = new Map<string, readonly string[]>();
		// #call-closing-status (D3): a running call (tool or task) carries its
		// timer in the fold's closing slot (where the completion suffix will
		// land), not as a live row.
		const nextSuffixes = new Map<string, string>();
		// #call-closing-status A1.2: the task call's timer base — the call's own
		// start, inherited by source rows (repl.ts), so it never resets when the
		// provisional parent row is replaced.
		const taskStarts = new Map<string, number>();
		// #confirm-prompt (Phase 3 D10) + #tool-inline-live-rows: while a picker
		// is open no tool row is painted anywhere. tool_start precedes the gate,
		// so a `running` claim would be false. Task rows and the task suffix
		// (genuine progress) stay, exactly as D10 established.
		if (this.selector === null) {
			for (const tool of this.activity.tools) nextSuffixes.set(tool.id, runningText(tool.startedAtMs));
		}
		// #task-inline-live-rows (B1): one fold per task call, but several observer
		// sources may share a parent — aggregate their row groups so the fold keeps
		// every source (the old region rendered one row group per source).
		for (const agent of this.activity.agents) {
			const parentKey = agent.taskToolId || agent.sourceId || "";
			if (agent.taskToolId !== "") {
				const previous = taskStarts.get(parentKey);
				if (previous === undefined || agent.startedAtMs < previous)
					taskStarts.set(parentKey, agent.startedAtMs);
			}
			let identity = this.taskOrdinals.get(parentKey);
			if (!identity) {
				identity = { ordinal: this.taskOrdinals.size + 1, sources: new Map() };
				this.taskOrdinals.set(parentKey, identity);
			}
			if (agent.sourceId && !identity.sources.has(agent.sourceId))
				identity.sources.set(agent.sourceId, identity.sources.size + 1);
			const source = agent.sourceId ? identity.sources.get(agent.sourceId) : undefined;
			const discriminator = `#${identity.ordinal}${source ? `.${source}` : ""}`;
			const taskRows = [
				`└─ pending ${discriminator} ${activityText(agent.agent)}`,
				activityText(agent.task),
				...(agent.toolCount > 0 || agent.lastTool !== null
					? [
							`${activityCount(agent.toolCount)} tool starts${agent.lastTool === null ? "" : ` · last: ${activityText(agent.lastTool)}`}`,
						]
					: []),
			];
			if (agent.taskToolId !== "") {
				// The overview renders in the task's own transcript fold, not this region.
				const existing = nextLiveRows.get(parentKey);
				nextLiveRows.set(parentKey, existing === undefined ? taskRows : [...existing, ...taskRows]);
			} else {
				// Defensive: a source row with no parent fold keeps the region row.
				const id = `agent:${agent.sourceId ?? agent.taskToolId}:${agent.startedAtMs}`;
				const row = this.activityRows.get(id) ?? new ToolActivity("", "");
				row.setTaskRows(taskRows);
				active.set(id, row);
				this.activityContainer.addChild(row);
			}
		}
		// #call-closing-status A1.2: the task timer rides the same closing slot
		// (exempt from D10 like the task rows). Pushed only for parent folds
		// (`taskToolId !== ""`); the defensive sourceId-only region path has no
		// fold, where a suffix push would be a silent no-op.
		for (const [key, startedAtMs] of taskStarts) nextSuffixes.set(key, runningText(startedAtMs));
		// Push only what changed; clear the keys that left the snapshot.
		for (const [key, rows] of nextLiveRows) {
			const previous = this.callLiveRows.get(key);
			if (previous === undefined || !rowsEqual(previous, rows))
				this.options.transcript.setCallLiveRows(key, rows);
		}
		for (const key of this.callLiveRows.keys())
			if (!nextLiveRows.has(key)) this.options.transcript.setCallLiveRows(key, null);
		this.callLiveRows = nextLiveRows;
		for (const [key, text] of nextSuffixes) {
			if (this.callSuffixes.get(key) !== text) this.options.transcript.setCallSuffix(key, text);
		}
		for (const key of this.callSuffixes.keys())
			if (!nextSuffixes.has(key)) this.options.transcript.setCallSuffix(key, null);
		this.callSuffixes = nextSuffixes;

		this.activityRows = active;
		this.tui?.requestRender();
	}

	/** Test seam: force one full repaint — differential renders may leave
	 *  unchanged lines out of the write log assertions depend on. */
	forceRender(): void {
		this.tui?.requestRender(true);
	}

	clearPending(): boolean {
		const editor = this.editor;
		if (editor === null) return false;
		const had = editor.getText() !== "";
		editor.setText("");
		this.tui?.requestRender();
		return had;
	}

	ask(question: string): Promise<boolean> {
		if (this.tui === null || this.closed) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const wasFirst = this.pendingAsks.length === 0;
			this.pendingAsks.push({ kind: "yesno", question, resolve });
			this.updatePlaceholder(); // a pending ask hides the hint row
			// While a picker owns the keys the question would be unanswerable;
			// hold it — the picker's finish() renders the queue head (M9-2 P2).
			if (wasFirst && this.selector === null) this.showAsk(question);
		});
	}

	secret(question: string): Promise<string | null> {
		if (this.tui === null || this.closed) return Promise.resolve(null);
		return new Promise<string | null>((resolve) => {
			const wasFirst = this.pendingAsks.length === 0;
			this.pendingAsks.push({ kind: "text", question, resolve });
			this.updatePlaceholder(); // review P3: a pending question hides the
			// hint row, same as ask() — command typing is now answer typing
			if (wasFirst && this.selector === null) this.showAsk(question);
		});
	}

	/** Ctrl+V handler (M13 batch 2): image → tmp path at the cursor, text →
	 *  plain insert. Errors are silent (no clipboard permission, headless
	 *  session) — pi parity. */
	private async handlePasteImage(): Promise<void> {
		if (this.editor === null) return;
		try {
			const reader = this.options.pasteImage ?? readClipboardImage;
			const image = await reader();
			if (image) {
				this.editor.insertTextAtCursor(writeClipboardImageToTmp(image));
				this.tui?.requestRender();
				return;
			}
			const text = await (this.options.pasteText ?? readClipboardTextViaPbcopy)();
			if (text) {
				this.editor.insertTextAtCursor(text);
				this.tui?.requestRender();
			}
		} catch {
			// silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	/**
	 * Append a collapsed fold INLINE, directly below the transcript's
	 * current end — at tool_end that is the `● … ✓` line (the renderer
	 * consumes the event before this tap), so the result sits under its
	 * call and later text streams below it (pi parity).
	 */
	addFold(title: string, lines: string[], decorate = true, error = false): void {
		const fold = new Fold(title, lines, decorate, error);
		this.folds.push(fold);
		this.options.transcript.appendChild(fold);
		this.tui?.requestRender();
	}

	getHistory(): readonly string[] {
		return this.history;
	}

	/** Wipe the conversation view: transcript lines AND their inline
	 *  folds (debt clearance — /new used to leave the old session's screen
	 *  behind and the fold list grew without bound). Input history stays:
	 *  it is the user's own recall, not this conversation. */
	clearConversation(): void {
		this.options.transcript.clear(); // children are anchored to it — gone too
		this.folds.length = 0;
		this.tui?.requestRender();
	}

	select(options: SelectOptions): Promise<number | null | "timeout"> {
		const tui = this.tui;
		if (tui === null || this.closed || options.items.length === 0) return Promise.resolve(null); // unstarted/closed, or nothing to pick
		if (this.selector !== null) {
			// Queued, not declined (M10 semantic review P2): an extension
			// confirm arriving while e.g. the /model picker is open still gets
			// asked — a silent decline would veto the tool without the user
			// ever seeing the question.
			// #ask-timeout: the queued closure re-enters select() on promotion,
			// so the deadline (if any) starts from the second opening, after
			// the current picker settles — never from queue-entry time.
			return new Promise<number | null | "timeout">((resolve) => {
				this.pendingSelects.push(() => resolve(this.select(options)));
			});
		}
		// #ask-timeout-countdown (design §12 D9): validated + clamped once;
		// the countdown row, its initial text, the monotonic anchor and the
		// timeout timer all read this single value.
		const armedTimeoutMs = effectiveTimeoutMs(options.timeoutMs);
		// SelectList carries string values; the row's index is the identity
		// the caller picked — the ORIGINAL index, so filtering (which hides
		// rows) can never rewire what Enter resolves to.
		// #confirm-prompt (Phase 1 D4): non-filterable pickers number their rows —
		// the affordance line below advertises digits, so the rows must show them.
		// Presentation only: `value` still carries the original index.
		const numbered = options.filterable !== true;
		const items = options.items.map((item, index) => ({
			value: String(index),
			label: numbered ? `${index + 1}. ${item.label}` : item.label,
			description: item.description,
		}));
		let list = new SelectList(items, Math.min(items.length, 8), this.theme.selectList);
		const box = new Container();
		// #confirm-prompt (Phase 3 D11): one blank row between the transcript and
		// the picker — a Spacer (an empty Text renders zero rows). Leading, so the
		// list stays the LAST child (Phase 1 D5).
		box.addChild(new Spacer(1));
		// #confirm-prompt (Phase 4 D14): the rule opens the box, between the blank
		// row and the title. The label is the host-held attribution (D13 removed
		// the title tag; the name now rides here). Unconditional: every picker box
		// gets the rule, unattributed → plain dashes.
		box.addChild(new SectionRule(options.attribution));
		if (options.title !== undefined && options.title !== "") {
			// #confirm-prompt (Phase 4 D13): the title is the extension's words
			// alone — the ` · <attribution>` tag is gone, bytes exactly as before
			// Phase 3 D9.
			box.addChild(new Text(options.title, 0, 0));
		}
		// The confirm detail rides in the picker (not just transcript notes):
		// Text wraps + preserves newlines, so the gated command and its reason
		// stay in view while the list waits for the answer. Warn spans overlay
		// the alert highlight on the named ranges (host owns color).
		if (options.detail !== undefined && options.detail !== "") {
			const spans = options.warnSpans ?? [];
			// #confirm-prompt (Phase 3 D12): what you decide renders at normal
			// weight — no outer dim. The warn spans therefore close with a plain
			// reset (restoreDim=false); the dim end would reintroduce faint.
			box.addChild(new Text(applyWarnSpans(options.detail, spans, true, false), 0, 0));
		}
		// #confirm-prompt (Phase 2 D7): the extension's command preview renders in
		// the transcript's call-header idiom, above the items. Malformed previews
		// render nothing (the helper returns "").
		const previewHeader = renderCommandHeader(options.preview, this.options.toolColorResolver);
		if (previewHeader !== "") box.addChild(new Text(previewHeader, 0, 0));
		// #ask-timeout-countdown (design §12 D10): the countdown row sits after
		// the preview and BEFORE the query row / blank spacer / list — the list
		// must stay the last child for filterable pickers (applyFilter
		// remove+appends it). The initial text is set at construction: an empty
		// Text renders zero rows, and waiting for the first tick would pop the
		// row in a second late (D12).
		const countdownRow =
			armedTimeoutMs === null
				? null
				: new Text(dim(`times out in ${countdownText(armedTimeoutMs)}`, true), 0, 0);
		if (countdownRow !== null) box.addChild(countdownRow);
		/** The live filter query (M11 #9): null while not filterable. */
		let query: string | null = options.filterable === true ? "" : null;
		const queryRow = new Text("", 0, 0);
		if (query !== null) box.addChild(queryRow);
		// #confirm-prompt (Phase 1 D5): a blank row above the items and the key
		// affordance below them — non-filterable pickers only, so the list stays
		// the LAST child for filterable ones (applyFilter rebuilds the list by
		// remove+append, and Container appends; an affordance after the list would
		// end up above a refiltered list). Spacer, not an empty Text: an empty
		// Text renders zero rows (see the placeholder note at the top of this file).
		if (numbered) box.addChild(new Spacer(1));
		box.addChild(list);
		if (numbered) box.addChild(new Text(dim(pickerAffordance(items.length), true), 0, 0));
		return new Promise<number | null | "timeout">((resolve) => {
			let settled = false; // pick, cancel, timeout and close all funnel here — once
			let timer: ReturnType<typeof setTimeout> | null = null;
			let countdownTimer: ReturnType<typeof setInterval> | null = null;
			const finish = (index: number | null | "timeout"): void => {
				if (settled) return;
				settled = true;
				if (timer !== null) {
					clearTimeout(timer); // manual answer/cancel and close all disarm the deadline
					timer = null;
				}
				if (countdownTimer !== null) {
					clearInterval(countdownTimer); // every settle path stops the ticks too
					countdownTimer = null;
				}
				this.setSelector(null);
				this.updatePlaceholder(); // the hint may come back with the picker gone
				this.askContainer.removeChild(box);
				tui.setFocus(this.editor); // the editor owns keys again
				tui.requestRender();
				// A question queued while the picker owned the keys renders now
				// (M9-2 review P2: it was visible-but-unanswerable under the list).
				if (this.askLine === null) {
					const next = this.pendingAsks[0];
					if (next !== undefined) this.showAsk(next.question);
				}
				resolve(index);
				// The next queued picker (if any) opens now — its own promise chain
				// takes over; close() drains the rest as null.
				const queued = this.pendingSelects.shift();
				if (queued !== undefined) queued();
			};
			const applyFilter = (): void => {
				if (query === null) return;
				const q = query.toLowerCase();
				const visible =
					q === ""
						? items
						: items.filter(
								(item) =>
									item.label.toLowerCase().includes(q) || (item.description ?? "").toLowerCase().includes(q),
							);
				const next = new SelectList(visible, Math.min(visible.length, 8), this.theme.selectList);
				next.onSelect = (item) => finish(Number(item.value));
				next.onCancel = () => finish(null);
				box.removeChild(list);
				list = next;
				box.addChild(next);
				queryRow.setText(query === "" ? dim("filter:", true) : dim(`filter: ${query}`, true));
				tui.setFocus(next); // the fresh list owns the keys
				tui.requestRender();
			};
			/** Consume printable/backspace keys as filter input (called from the
			 *  shell's pre-focus listener). Returns true when consumed. */
			const filterKey = (data: string): boolean => {
				if (query === null) return false;
				if (data === "\x7f" || data === "\b") {
					if (query === "") return true; // nothing to erase — swallow anyway
					query = query.slice(0, -1);
					applyFilter();
					return true;
				}
				// Bracketed paste arrives as one ESC-wrapped chunk (review P2) —
				// unwrap and take the first line; a multi-line paste is not a query.
				// biome-ignore lint/suspicious/noControlCharactersInRegex: bracketed-paste markers ARE ESC-wrapped by the terminal
				const paste = /^\x1b\[200~([^\x1b]*)\x1b\[201~$/.exec(data);
				if (paste !== null) {
					const firstLine = (paste[1] ?? "").split("\n")[0] ?? "";
					if (firstLine === "") return true; // swallowed, nothing usable
					query += firstLine;
					applyFilter();
					return true;
				}
				// A plain text chunk: no escape prefix, no control bytes. Covers
				// ASCII and committed IME/CJK input (multi-byte).
				if (data !== "" && !data.startsWith("\x1b") && ![...data].some((ch) => ch < " ")) {
					query += data;
					applyFilter();
					return true;
				}
				return false;
			};
			/** #confirm-prompt (Phase 1 D3): digits 1..9 pick by item index — only
			 *  on non-filterable pickers, where a digit is not a query character.
			 *  The index is static, so the binding stays valid when the list scrolls;
			 *  a digit above the item count is ignored. */
			const numberKey = (data: string): boolean => {
				if (query !== null) return false;
				if (data.length !== 1 || data < "1" || data > "9") return false;
				const index = Number(data) - 1;
				if (index >= items.length) return false;
				finish(index);
				return true;
			};
			this.setSelector({
				teardown: () => finish(null),
				filterKey, // the pre-focus listener consults this while open
				numberKey, // #confirm-prompt: digits quick-pick (non-filterable only)
			});
			this.updatePlaceholder(); // keys belong to the picker — hide the hint
			list.onSelect = (item) => finish(Number(item.value));
			list.onCancel = () => finish(null);
			this.askContainer.addChild(box);
			tui.setFocus(list);
			tui.requestRender();
			// #ask-timeout: the deadline starts here — the picker is on screen.
			// The deadline expires through the same finish funnel (like a
			// cancel: teardown, focus restore, promotion of the next queued
			// pick), resolving "timeout"; an answer arriving after the timer
			// is inert (settled guard). unref: an armed deadline must not keep
			// the process alive by itself.
			// #ask-timeout-countdown (design §12 D12): the deadline timer is
			// created BEFORE the countdown interval (pinned order); the
			// formatter floor keeps `0:00` unreachable even if a tick were to
			// win a same-tick race anyway.
			if (armedTimeoutMs !== null) {
				timer = setTimeout(() => finish("timeout"), armedTimeoutMs);
				timer.unref?.();
			}
			if (armedTimeoutMs !== null && countdownRow !== null) {
				// Monotonic anchor: a wall-clock step must never desync the text
				// from the relative timeout timer (D11). Skip unchanged text —
				// ≥1 h formats change once a minute (D12).
				const deadline = performance.now() + armedTimeoutMs;
				let lastText = countdownText(armedTimeoutMs);
				countdownTimer = setInterval(() => {
					const text = countdownText(deadline - performance.now());
					if (text === lastText) return;
					lastText = text;
					countdownRow.setText(dim(`times out in ${text}`, true));
					tui.requestRender();
				}, 1000);
				countdownTimer.unref?.();
			}
		});
	}

	/** #login-dialog: the exclusive login dialog — select()'s full
	 *  lifecycle contract (design §2.2), driven by the command's flow.
	 *  "unavailable" only when the shell is in shutdown; a queued entry
	 *  drained by close()'s drain re-invokes and resolves unavailable —
	 *  the command treats that as a silent no-op, never a fallback
	 *  trigger (design rev3 P2-5). */
	openLoginDialog(options: LoginDialogOptions): Promise<"done" | "cancelled" | "unavailable"> {
		const tui = this.tui;
		if (tui === null || this.closed) return Promise.resolve("unavailable");
		if (this.selector !== null) {
			// Same FIFO semantic as select()/treeSelect (design rev3 P1 #4):
			// queue behind the live selector; never clobber.
			return new Promise((resolve) => {
				this.pendingSelects.push(() => resolve(this.openLoginDialog(options)));
			});
		}
		const dialog = new LoginDialog(tui, options.title);
		// #confirm-prompt (Phase 3 D11): one blank row between the transcript and
		// the dialog — a Spacer (never an empty Text, which renders zero rows).
		// Focus stays on the dialog component (setFocus(dialog) below).
		const dialogBox = new Container();
		dialogBox.addChild(new Spacer(1));
		dialogBox.addChild(dialog);
		return new Promise((resolve, reject) => {
			let settled = false; // five racing finish sources (design rev3 P1-2)
			const finish = (): void => {
				if (settled) return;
				settled = true;
				// Finish-as-cancel (design §2.2, review P0): the flow must settle
				// on EVERY teardown path — SIGINT/stdin-end/close arrive while
				// run() is pending; without cancelling, dialogOpen stays true and
				// the machine refuses everything (15-min poll) or bricks (a
				// pending prompt can never settle once the Input lost focus).
				// Idempotent with the Esc/Ctrl+C path (the settled guard runs
				// first; cancel() is itself a no-op after the first call).
				dialog.teardownNow();
				this.setSelector(null);
				this.updatePlaceholder();
				this.askContainer.removeChild(dialogBox);
				// Null-guard: teardown may fire after close() began detaching
				// (design rev3 P2-4).
				if (this.editor !== null) tui.setFocus(this.editor);
				tui.requestRender();
				if (this.askLine === null) {
					const next = this.pendingAsks[0];
					if (next !== undefined) this.showAsk(next.question);
				}
				const queued = this.pendingSelects.shift();
				if (queued !== undefined) queued();
			};
			this.setSelector({ teardown: () => finish() });
			this.updatePlaceholder();
			this.askContainer.addChild(dialogBox);
			tui.setFocus(dialog);
			tui.requestRender();
			// The wrapper owns teardown on ALL settle paths (design rev3
			// P1-10): success, error, and dialog-initiated cancel. The dialog's
			// cancel aborts the flow's controller; run()'s rejection funnels
			// here; finish is idempotent for the race between them.
			void options.run(dialog).then(
				() => {
					finish();
					resolve("done");
				},
				(err: unknown) => {
					finish();
					const message = err instanceof Error ? err.message : String(err);
					if (message === "Login cancelled") {
						resolve("cancelled"); // silent — pi parity
						return;
					}
					// Other errors propagate to the command body, which
					// renders them with the teaching prefix (§2.2.2).
					reject(err);
				},
			);
		});
	}

	/** #tree: session-tree navigator — select()'s full lifecycle contract
	 *  (queued behind an open picker via pendingSelects, registered as the
	 *  live selector so SIGINT/close tears it down, placeholder hidden while
	 *  the tree owns the keys). Resolves the chosen entry id, or null. */
	treeSelect(options: TreeSelectRequest): Promise<string | null> {
		const tui = this.tui;
		if (tui === null || this.closed) return Promise.resolve(null);
		if (this.selector !== null) {
			// Same FIFO semantic as select() (M10): a tree arriving while e.g.
			// /model is open still opens after it — never silently declined.
			return new Promise<string | null>((resolve) => {
				this.pendingSelects.push(() => resolve(this.treeSelect(options)));
			});
		}
		return new Promise<string | null>((resolve) => {
			let settled = false; // enter, cancel and close all funnel here — once
			const finish = (entryId: string | null): void => {
				if (settled) return;
				settled = true;
				this.setSelector(null);
				this.updatePlaceholder();
				this.askContainer.removeChild(boxWrapper);
				tui.setFocus(this.editor);
				tui.requestRender();
				if (this.askLine === null) {
					const next = this.pendingAsks[0];
					if (next !== undefined) this.showAsk(next.question);
				}
				resolve(entryId);
				const queued = this.pendingSelects.shift();
				if (queued !== undefined) queued();
			};
			const box = new TreeSelectorBox(
				new TreeSelectorComponent(
					options.roots,
					options.leafId,
					Math.max(4, Math.min(16, tui.terminal.rows - 6)),
					(entryId) => finish(entryId),
					() => finish(null),
					{
						initialFilterMode: options.initialFilterMode,
						initialSelectedId: options.initialSelectedId,
						onLabelChange: options.onLabelChange,
						onCopy: options.onCopy,
					},
				),
				options.title ??
					"Navigate the session tree (enter=go · tab=filter · f=fold · L=label · ←→/pgup/pgdn=page · alt+←→=branch · ctrl+x=copy · type to search)",
			);
			// #confirm-prompt (Phase 3 D11): one blank row between the transcript and
			// the tree box — a Spacer (never an empty Text).
			// #confirm-prompt (Phase 4 D14): an unlabeled rule between the blank row
			// and the box (TreeSelectRequest carries no attribution).
			const boxWrapper = new Container();
			boxWrapper.addChild(new Spacer(1));
			boxWrapper.addChild(new SectionRule());
			boxWrapper.addChild(box);
			this.setSelector({ teardown: () => finish(null) });
			this.updatePlaceholder();
			this.askContainer.addChild(boxWrapper);
			tui.setFocus(box);
			tui.requestRender();
		});
	}

	showNotice(text: string): void {
		if (this.closed) return;
		if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
		this.noticeText = text;
		const timer = setTimeout(() => {
			if (this.closed || this.noticeTimer !== timer) return;
			this.noticeTimer = null;
			this.noticeText = "";
			this.updatePlaceholder();
		}, 2000);
		this.noticeTimer = timer;
		this.updatePlaceholder();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
		this.noticeTimer = null;
		this.noticeText = "";
		this.noticeRow?.setText("");
		this.setActivity({ phase: "idle", tools: [], agents: [] }); // stop the ticker
		this.detachInput?.();
		this.detachInput = null;
		if (this.onProcessSigint !== null) process.off("SIGINT", this.onProcessSigint);
		this.onProcessSigint = null;
		if (this.onStdinEnd !== null) process.stdin.off("end", this.onStdinEnd);
		this.onStdinEnd = null;
		this.selector?.teardown(); // an open picker dies with the shell, not the promise
		// Queued pickers resolve null through their own re-entry (select() sees
		// closed); drain them so nothing hangs past the terminal stop.
		while (this.pendingSelects.length > 0) {
			const queued = this.pendingSelects.shift();
			queued?.();
		}
		this.drainAsks();
		const tui = this.tui;
		if (tui !== null) {
			// Graceful-exit notes ("session … saved") feed the sink on this very
			// tick; the pending render lands nextTick/setTimeout(≤16ms). Stopping
			// now would kill the final frame (M9 review P1) — 40ms clears
			// pi-tui's MIN_RENDER_INTERVAL_MS = 16.
			tui.requestRender();
			setTimeout(() => this.stopTerminal(), 40);
		} else {
			this.stopTerminal(); // never started: nothing to delay for
		}
	}

	/** Restore the terminal exactly once; idempotent. */
	private stopTerminal(): void {
		if (this.stopped) return;
		this.stopped = true;
		// Ownership guard (review P0 hardening): only unbind OUR callback —
		// a successor shell may have re-bound the shared sink already (the
		// one-shot trust-ask shell hands the same TranscriptSink to the real
		// REPL shell).
		if (this.options.transcript.onUpdate === this.boundOnUpdate) {
			this.options.transcript.onUpdate = null;
		}
		if (this.options.transcript.callLiveRowsResolver === this.boundLiveRowsResolver) {
			this.options.transcript.callLiveRowsResolver = null;
		}
		if (this.options.transcript.callSuffixResolver === this.boundSuffixResolver) {
			this.options.transcript.callSuffixResolver = null;
		}
		this.terminal?.write("\x1b]2;\x07"); // hand the window its own title back
		this.terminal = null;
		this.tui?.stop();
		this.tui = null;
		this.settleResolve?.();
		this.settleResolve = null;
	}

	/** Resolves once close() has fully settled — the 40ms terminal stop
	 *  has RUN, not merely been scheduled (review P0: the one-shot
	 *  trust-ask shell returns before the delayed stop, which then pauses
	 *  stdin and unbinds the shared sink UNDER the freshly started real
	 *  shell — an intermittent dead-input REPL). Await this before any
	 *  successor shell binds the same terminal. Already-settled (or
	 *  never-started) shells resolve immediately. */
	whenSettled(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.settlePromise === null) {
			this.settlePromise = new Promise<void>((resolve) => {
				this.settleResolve = resolve;
			});
		}
		return this.settlePromise;
	}

	/** Dim hint row (M10): visible only while idle, the editor empty, and no
	 *  ask pending — every driver flips it through this one gate. */
	private updatePlaceholder(): void {
		if (this.placeholder === null) return;
		// An open selector hides the hint too: keys go to the picker while it
		// owns focus, so "you can type" would be a lie (M10 review P2#5).
		const blocked = this.pendingAsks.length > 0 || this.selector !== null;
		// While a turn runs the row carries the interrupt affordance instead
		// of hiding (M11 #8) — blocked (ask/selector) still clears it.
		const text = blocked ? "" : this.active ? INTERRUPT_HINT : this.editorText === "" ? PLACEHOLDER_HINT : "";
		this.placeholder.setText(text);
		this.noticeRow?.setText(
			this.selector === null && this.noticeText !== "" ? dim(this.noticeText, true) : "",
		);
		this.tui?.requestRender();
	}

	/** Resolve the oldest question, then show the next (if queued). */
	private settleAsk(value: string | null): void {
		const oldest = this.pendingAsks.shift();
		if (oldest === undefined) return;
		if (oldest.kind === "yesno") oldest.resolve(value !== null && isYes(value));
		else oldest.resolve(value !== null && value.trim() !== "" ? value : null); // blank = cancel (pi stores no empty key)
		const next = this.pendingAsks[0];
		if (next !== undefined) {
			this.showAsk(next.question);
		} else {
			this.removeAskLine();
			this.updatePlaceholder(); // no ask left — the hint row may return
			this.tui?.requestRender();
		}
	}

	/** Decline every pending question without rendering (abort paths). */
	private drainAsks(): void {
		while (this.pendingAsks.length > 0) {
			const oldest = this.pendingAsks.shift();
			if (oldest === undefined) continue;
			if (oldest.kind === "yesno") oldest.resolve(false);
			else oldest.resolve(null);
		}
		this.removeAskLine();
		this.updatePlaceholder();
		this.tui?.requestRender();
	}

	private showAsk(question: string): void {
		this.removeAskLine();
		const line = new Text(question, 0, 0);
		this.askLine = line;
		this.askContainer.addChild(line);
		this.tui?.requestRender();
	}

	private removeAskLine(): void {
		if (this.askLine === null) return;
		this.askContainer.removeChild(this.askLine);
		this.askLine = null;
	}
}

/** Best-effort plain-text clipboard read for the Ctrl+V text fallback
 *  (M13 batch 2). Undefined/null → nothing inserted. */
async function readClipboardTextViaPbcopy(): Promise<string | null> {
	const { runClipboardCommand } = await import("./clipboard-command.js");
	const platform = process.platform;
	const cmd =
		platform === "darwin"
			? { bin: "pbpaste", args: [] as const }
			: platform === "linux"
				? { bin: "xclip", args: ["-selection", "clipboard", "-o"] as const }
				: { bin: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard"] as const };
	const out = await runClipboardCommand(cmd.bin, cmd.args, { timeoutMs: 2000, maxBufferBytes: 1024 * 1024 });
	if (out === undefined || out.length === 0) return null;
	return out.toString("utf-8");
}
