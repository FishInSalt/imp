/**
 * #guardian-auto-mode (design D11/D18): the provenance-verified user-input
 * log — the only context a classifier seam may treat as evidence of what the
 * human actually asked for.
 *
 * Entries are appended **only** at the human submission boundary (the repl
 * machine's `handleLine`, pre-dispatch) and cleared whenever the
 * conversation's identity or history position changes (`/new`, a successful
 * `/resume`, a position-moving `/tree`//`/fork`). Model-authored text — branch
 * and compaction summaries, child task prompts, command/skill expansions —
 * never enters this log, regardless of the role it is stored under.
 *
 * The newest `USER_INPUT_LOG_ENTRIES` submissions are kept, each elided at
 * `USER_INPUT_LOG_ENTRY_CHARS` chars with a marker (design §14.4, folded):
 * the log bounds what one submission can contribute to the context block;
 * the classify seam reads a frozen copy (see call-context.ts), never this
 * live array.
 */

/** How many raw submissions ride the classify context block (design D11). */
export const USER_INPUT_LOG_ENTRIES = 3;

/** Per-entry char cap (design §14.4): longer submissions are elided with an
 *  explicit marker so one paste cannot dominate (or overflow) the context
 *  block. */
export const USER_INPUT_LOG_ENTRY_CHARS = 2000;

/** The elision suffix — part of the entry text, so the classifier sees it. */
const ELISION = "…(elided)";

export class UserInputLog {
	private entries: string[] = [];

	/** True when at least one verified submission exists (D17's event fact). */
	get verified(): boolean {
		return this.entries.length > 0;
	}

	/** Record one raw submission (elided at the entry cap); blanks never enter. */
	record(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		const entry =
			trimmed.length > USER_INPUT_LOG_ENTRY_CHARS
				? `${trimmed.slice(0, USER_INPUT_LOG_ENTRY_CHARS)}${ELISION}`
				: trimmed;
		this.entries.push(entry);
		if (this.entries.length > USER_INPUT_LOG_ENTRIES) {
			this.entries.splice(0, this.entries.length - USER_INPUT_LOG_ENTRIES);
		}
	}

	/** Invalidate every entry (identity/history change, D18). */
	clear(): void {
		this.entries.length = 0;
	}

	/** A defensive copy — callers (and the seam) can never mutate the log. */
	snapshot(): readonly string[] {
		return [...this.entries];
	}
}
