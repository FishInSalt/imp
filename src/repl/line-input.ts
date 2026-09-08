/** One picker row: a label (shown) plus an optional dimmed description. */
export interface SelectItemOption {
	label: string;
	description?: string;
}

/** Options for LineInput.select — an interactive item picker. */
export interface SelectOptions {
	/** Line rendered above the items (e.g. "pick a model"). */
	title?: string;
	items: SelectItemOption[];
	/** Type-to-filter while the picker is open (M11 #9): printable input
	 *  builds a case-insensitive substring query over the labels; arrows and
	 *  Enter keep working against the filtered rows. Pickers that pass a
	 *  handful of items (e.g. /model) leave it off. */
	filterable?: boolean;
}

/**
 * The input-side contract the REPL state machine (repl.ts) consumes.
 *
 * Two implementations, selected in runRepl:
 *  - ReplInput (input.ts) — the readline shell, the pre-M9 interactive
 *    path and the `IMP_REPL=legacy` escape hatch;
 *  - TuiShell (shell.ts) — the pi-tui shell (M9).
 *
 * The machine is presentation-agnostic: it routes by state and never
 * touches a terminal library, so both shells implement exactly this.
 */
export interface LineInput {
	/** Arm the input source and show the idle prompt. */
	start(): void;
	/** Flags a run/compaction in flight. The TUI hint row swaps to the
	 *  interrupt affordance while active; the readline shell ignores it. */
	setActive(active: boolean): void;
	/** Redraw the prompt line (after status notes, queue changes). */
	refresh(): void;
	/** Wipes typed-but-unsubmitted text. Returns true when text was discarded. */
	clearPending(): boolean;
	/** One-line [y/N] question (api.confirm's tty side). FIFO when concurrent;
	 *  empty/EOF/anything but y/yes resolves false. */
	ask(question: string): Promise<boolean>;
	/** History so far (newest first). Interactive only. */
	getHistory(): readonly string[];
	/** TUI shell only: persistent bottom status line (model · session ·
	 *  cumulative tokens). The legacy shell has no such line and ignores it. */
	setFooter?(text: string): void;
	/** Append a collapsed fold (expandable body) below the transcript — a
	 *  TUI-shell-only affordance; the readline shell has no folds. */
	addFold?(title: string, lines: string[], decorate?: boolean): void;
	/** Item picker (M9 phase 2, TUI only — the readline shell has none, so
	 *  callers must fall back to a text flow when absent). Enter confirms,
	 *  Esc/Ctrl+C cancel; resolves to the chosen index or null. */
	select?(options: SelectOptions): Promise<number | null>;
	/** Queue visual (M10, TUI only): one dim "N queued · next: <preview>" line
	 *  below the ask region while lines wait behind the running turn. A count
	 *  of 0 (or a null preview) removes the line entirely — the readline shell
	 *  has no such line and keeps its "▪ queued:" notes instead. */
	setQueue?(count: number, preview: string | null): void;
	/** Terminal window title (TUI only — OSC 2, written outside the frame
	 *  pipeline). The readline shell has no title and ignores it. */
	setTitle?(title: string): void;
	/** TUI only: live turn activity (M10 B). The machine pushes a fresh
	 *  snapshot on every event; idle clears the region. The shell owns the
	 *  spinner animation and elapsed-time rendering. */
	setActivity?(snapshot: ActivitySnapshot): void;
	/** Release the terminal (or readline interface). */
	close(): void;
}

/** One pending top-level tool call in the TUI activity region. */
export interface ActivityToolLine {
	/** tool_call id — tool_end removes the row (the ⎿ summary lands in the transcript). */
	id: string;
	name: string;
	/** Pre-summarized args label (summarizeArgs at event time). */
	label: string;
	startedAtMs: number;
}

/** One running subagent in the TUI activity region (the task tool's child). */
export interface ActivityAgentLine {
	/** Agent name — two parallel tasks on the same agent merge into one row (v1). */
	agent: string;
	task: string;
	/** The task tool_call id that spawned it — its tool_end removes the row. */
	taskToolId: string;
	cwd: string | null;
	/** Latest child tool_start, pre-summarized ("read src/foo.ts"). */
	lastTool: string | null;
	toolCount: number;
	startedAtMs: number;
}

/** Snapshot of live turn activity (M10 B: the activity region replaces the
 *  byte-stream spinner in TUI mode — print/legacy keep the Renderer's own
 *  spinner). Elapsed times are computed shell-side from the clock captured
 *  per entry, so the shell can animate without machine pushes. */
export interface ActivitySnapshot {
	phase: "idle" | "thinking" | "working";
	tools: ActivityToolLine[];
	agents: ActivityAgentLine[];
}

/** Event surface both shells wire into the machine. */
export interface LineInputEvents {
	onLine(line: string): void;
	onInterrupt(): void;
	onEof(): void;
}
