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
	/** Append a collapsed fold (expandable body) below the transcript — a
	 *  TUI-shell-only affordance; the readline shell has no folds. */
	addFold?(title: string, lines: string[]): void;
	/** Release the terminal (or readline interface). */
	close(): void;
}

/** Event surface both shells wire into the machine. */
export interface LineInputEvents {
	onLine(line: string): void;
	onInterrupt(): void;
	onEof(): void;
}
