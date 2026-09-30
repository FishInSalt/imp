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
 * The newest `USER_INPUT_LOG_ENTRIES` submissions are kept; the classify seam
 * reads a frozen copy (see call-context.ts), never this live array.
 */

/** How many raw submissions ride the classify context block (design D11). */
export const USER_INPUT_LOG_ENTRIES = 3;

export class UserInputLog {
	private entries: string[] = [];

	/** True when at least one verified submission exists (D17's event fact). */
	get verified(): boolean {
		return this.entries.length > 0;
	}

	/** Record one raw submission; blanks never enter. */
	record(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		this.entries.push(trimmed);
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
