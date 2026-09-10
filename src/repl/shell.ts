import { dim } from "../format.js";
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
	type Terminal,
	Text,
	TUI,
} from "../tui.js";
import { Fold } from "./components/fold.js";
import { appendInputHistory, loadInputHistory } from "./history.js";
import type {
	ActivitySnapshot,
	LineInput,
	LineInputEvents,
	QueueEntryView,
	SelectOptions,
} from "./line-input.js";
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
 *   ├─ transcript (TranscriptSink — the Renderer's output, hosted)
 *   ├─ folds      (addFold's collapsed "▸ title" lines; Ctrl+O expands)
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
 *   └─ footer     (dim status line: model · session · cumulative tokens;
 *                 pushed by the machine, pi places it below the editor too)
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
 *    counterpart: collapsed "▸ title" lines render between the
 *    transcript and the ask line — the text stream first, folds after,
 *    in insertion order (v1; folds never interleave with streamed
 *    text). The producer is the machine's tool_end tap: every successful
 *    edit result ("<summary>:\n<diff>") becomes one fold, so Ctrl+O is
 *    live in real sessions; Ctrl+O toggles the most recently added fold
 *    only; with no fold present the key falls through to the editor,
 *    which has no Ctrl+O binding (a no-op).
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
	/** Hosts the Fold children — sits between transcript and ask line. */
	private readonly foldContainer = new Container();
	/** Newest last; Ctrl+O toggles the last one only. */
	private readonly folds: Fold[] = [];
	/** The ask line's Text child, tracked so a selector sharing the ask
	 *  region can never remove (or be removed by) the question line. */
	private askLine: Text | null = null;
	/** The queue visual line, below the ask region (empty = zero rows). */
	private queueLine: Text | null = null;
	/** Activity region (M10 B): live tool/subagent rows between the folds
	 *  and the ask line. Owns the spinner animation so elapsed seconds tick
	 *  without machine pushes. */
	private readonly activityContainer = new Container();
	private activity: ActivitySnapshot = { phase: "idle", tools: [], agents: [] };
	private activityTimer: ReturnType<typeof setInterval> | null = null;
	private activityFrame = 0;
	/** Buffered setQueue text — pushes may arrive before start() and must not
	 *  be dropped (same contract as the footer). */
	private queueText = "";
	/** The open selector, if any — finished on pick, cancel, or close. */
	private selector: { teardown: () => void; filterKey?: (data: string) => boolean } | null = null;
	/** Pickers queued behind an open one (M10): opened when it finishes. */
	private pendingSelects: Array<() => void> = [];
	private footer: Text | null = null;
	/** The dim hint row above the editor (M10). */
	private placeholder: Text | null = null;
	/** Marker-side mirror of the machine's active flag (setActive). */
	private active = false;
	/** Editor text mirror (onChange keeps it current) — placeholder input. */
	private editorText = "";
	/** Buffered setFooter text — pushes may arrive before start() (the
	 *  machine's constructor runs first) and must not be dropped (M9-2
	 *  review P1: the startup footer was silently blank). */
	private footerText = "";
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
	/** Same FIFO contract as ReplInput.pendingAsks. */
	private pendingAsks: Array<{ question: string; resolve: (approved: boolean) => void }> = [];

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

		const placeholder = new Text("", 0, 0); // empty Text renders zero rows
		this.placeholder = placeholder;
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
		tui.addChild(this.foldContainer);
		tui.addChild(this.activityContainer); // live tool/subagent rows (M10 B)
		tui.addChild(this.askContainer);
		const queueLine = new Text(this.queueText, 0, 0);
		this.queueLine = queueLine;
		tui.addChild(queueLine); // queue visual sits between the ask line and the hint row
		tui.addChild(placeholder); // hint row: after the queue line, right above the editor
		tui.addChild(editorBox);
		const footer = new Text(this.footerText === "" ? "" : dim(this.footerText, true), 0, 0);
		this.footer = footer;
		tui.addChild(footer); // status line below the editor (pi's placement)
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
				this.active &&
				this.selector === null &&
				matchesKey(data, "escape") &&
				editor?.isShowingAutocomplete() !== true
			) {
				if (this.pendingAsks.length > 0) this.settleAsk(false);
				else this.options.onInterrupt();
				return undefined;
			}
			if (matchesKey(data, "ctrl+c")) {
				if (this.pendingAsks.length > 0) this.settleAsk(false);
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
			// Fold affordance (TUI-only; see the parity ledger): expand/collapse
			// ALL folds — v1 toggled only the newest, which left mid-turn
			// results permanently unexpandable (declared debt, cleared):
			// any-collapsed → expand all; all-expanded → collapse all. With
			// none present the key passes through to the editor — which has
			// no Ctrl+O binding, so effectively a no-op.
			if (matchesKey(data, "ctrl+o")) {
				if (this.folds.length === 0) return undefined;
				const expand = this.folds.some((f) => !f.isExpanded());
				for (const fold of this.folds) fold.setExpanded(expand);
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
			this.settleAsk(isYes(text));
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

	/** Rebuild the activity rows (dim; the ✓/⎿ completion lives in the
	 *  transcript — this region is pending state only). */
	private renderActivity(): void {
		this.activityContainer.clear();
		if (this.activity.phase === "idle") {
			this.tui?.requestRender();
			return;
		}
		const now = Date.now();
		const frame = SPINNER_FRAMES[this.activityFrame] ?? "⠋";
		const elapsed = (startedAtMs: number): string => {
			const seconds = Math.max(0, Math.floor((now - startedAtMs) / 1000));
			return seconds === 0 ? "" : ` ${seconds}s`;
		};
		if (this.activity.phase === "thinking") {
			this.activityContainer.addChild(new Text(dim(`${frame} thinking…`, true), 0, 0));
		}
		for (const tool of this.activity.tools) {
			const label = tool.label === "" ? "" : ` ${tool.label}`;
			this.activityContainer.addChild(
				new Text(dim(`${frame} ${tool.name}${label}${elapsed(tool.startedAtMs)}`, true), 0, 0),
			);
		}
		for (const agent of this.activity.agents) {
			const parts = [agent.agent, agent.task].filter((part) => part !== "");
			const tools = agent.toolCount > 0 ? `${agent.toolCount} tools` : null;
			const last = agent.lastTool !== null ? `last: ${agent.lastTool}` : null;
			const tail = [tools, last].filter((part) => part !== null).join(" · ");
			const row = tail === "" ? parts.join(" · ") : `${parts.join(" · ")} · ${tail}`;
			this.activityContainer.addChild(new Text(dim(`└─ ${row}${elapsed(agent.startedAtMs)}`, true), 0, 0));
		}
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
			this.pendingAsks.push({ question, resolve });
			this.updatePlaceholder(); // a pending ask hides the hint row
			// While a picker owns the keys the question would be unanswerable;
			// hold it — the picker's finish() renders the queue head (M9-2 P2).
			if (wasFirst && this.selector === null) this.showAsk(question);
		});
	}

	/**
	 * Append a collapsed fold below the transcript text (v1 ordering: the
	 * stream renders first, folds after — see the parity ledger).
	 */
	addFold(title: string, lines: string[], decorate = true, error = false): void {
		const fold = new Fold(title, lines, decorate, error);
		this.folds.push(fold);
		this.foldContainer.addChild(fold);
		this.tui?.requestRender();
	}

	getHistory(): readonly string[] {
		return this.history;
	}

	/** Wipe the conversation view: transcript lines AND folds (debt
	 *  clearance — /new used to leave the old session's screen behind and
	 *  the fold container grew without bound). Input history stays: it is
	 *  the user's own recall, not this conversation. */
	clearConversation(): void {
		this.options.transcript.clear();
		this.folds.length = 0;
		this.foldContainer.clear();
		this.tui?.requestRender();
	}

	select(options: SelectOptions): Promise<number | null> {
		const tui = this.tui;
		if (tui === null || this.closed || options.items.length === 0) return Promise.resolve(null); // unstarted/closed, or nothing to pick
		if (this.selector !== null) {
			// Queued, not declined (M10 semantic review P2): a guardian confirm
			// arriving while e.g. the /model picker is open still gets asked —
			// a silent decline would veto the tool without the user ever seeing
			// the question.
			return new Promise<number | null>((resolve) => {
				this.pendingSelects.push(() => resolve(this.select(options)));
			});
		}
		// SelectList carries string values; the row's index is the identity
		// the caller picked — the ORIGINAL index, so filtering (which hides
		// rows) can never rewire what Enter resolves to.
		const items = options.items.map((item, index) => ({
			value: String(index),
			label: item.label,
			description: item.description,
		}));
		let list = new SelectList(items, Math.min(items.length, 8), this.theme.selectList);
		const box = new Container();
		if (options.title !== undefined && options.title !== "") box.addChild(new Text(options.title, 0, 0));
		/** The live filter query (M11 #9): null while not filterable. */
		let query: string | null = options.filterable === true ? "" : null;
		const queryRow = new Text("", 0, 0);
		if (query !== null) box.addChild(queryRow);
		box.addChild(list);
		return new Promise<number | null>((resolve) => {
			let settled = false; // pick, cancel and close all funnel here — once
			const finish = (index: number | null): void => {
				if (settled) return;
				settled = true;
				this.selector = null;
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
			this.selector = {
				teardown: () => finish(null),
				filterKey, // the pre-focus listener consults this while open
			};
			this.updatePlaceholder(); // keys belong to the picker — hide the hint
			list.onSelect = (item) => finish(Number(item.value));
			list.onCancel = () => finish(null);
			this.askContainer.addChild(box);
			tui.setFocus(list);
			tui.requestRender();
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
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
		this.tui?.requestRender();
	}

	/** Resolve the oldest question, then show the next (if queued). */
	private settleAsk(approved: boolean): void {
		const oldest = this.pendingAsks.shift();
		if (oldest === undefined) return;
		oldest.resolve(approved);
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
			oldest?.resolve(false);
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
