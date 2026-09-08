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
	/** Prompt becomes "+ " while a run/compaction is active, "> " when idle. */
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
	addFold?(title: string, lines: string[]): void;
	/** Item picker (M9 phase 2, TUI only — the readline shell has none, so
	 *  callers must fall back to a text flow when absent). Enter confirms,
	 *  Esc/Ctrl+C cancel; resolves to the chosen index or null. */
	select?(options: SelectOptions): Promise<number | null>;
	/** Terminal window title (TUI only — OSC 2, written outside the frame
	 *  pipeline). The readline shell has no title and ignores it. */
	setTitle?(title: string): void;
	/** Release the terminal (or readline interface). */
	close(): void;
}

/** Event surface both shells wire into the machine. */
export interface LineInputEvents {
	onLine(line: string): void;
	onInterrupt(): void;
	onEof(): void;
}
