import type { Component } from "../tui.js";

/**
 * Translates the Renderer's byte stream into transcript lines for the TUI.
 *
 * The Renderer (src/render.ts) is presentation-code shared with print mode,
 * whose byte contract is frozen. This sink implements exactly the subset of
 * terminal behavior that contract uses in interactive mode:
 *
 *   - "\n"            completes a line
 *   - "\r\x1b[2K"     erases the current (unterminated) line — the spinner
 *                     and pending-tool rewrite prefix; the bytes that follow
 *                     replace it
 *   - anything else   appends to the current line (streaming deltas)
 *
 * No other cursor sequences appear in the contract (verified against
 * render.ts, M9). Implemented as a pi-tui Component: the TUI renders the
 * bottom slice of whatever we return, so long transcripts flow into the
 * terminal's native scrollback (same model as pi's chat container).
 */
export class TranscriptSink implements Component {
	private lines: string[] = [];
	private current = "";
	private carry = "";
	/** Fires whenever lines change — the shell binds tui.requestRender. */
	onUpdate: (() => void) | null = null;

	/** The Renderer's write sink. Chunk-boundary safe via `carry`. */
	feed = (chunk: string): void => {
		let buffer = this.carry + chunk;
		this.carry = "";
		let changed = false;
		while (buffer.length > 0) {
			if (this.startsWithLineReset(buffer)) {
				// Whole marker present: replace the current line wholesale.
				this.current = "";
				buffer = buffer.slice(LINE_RESET.length);
				changed = true;
				continue;
			}
			if (this.couldBePartialLineReset(buffer)) {
				// A "\r\x1b[2K" may be split across chunks — wait for more.
				this.carry = buffer;
				break;
			}
			const newline = buffer.indexOf("\n");
			if (newline === -1) {
				this.current += buffer;
				buffer = "";
				changed = true;
				break;
			}
			this.lines.push(this.current + buffer.slice(0, newline));
			this.current = "";
			buffer = buffer.slice(newline + 1);
			changed = true;
		}
		if (changed) this.onUpdate?.();
	};

	render(_width: number): string[] {
		return this.current === "" ? this.lines : [...this.lines, this.current];
	}

	invalidate(): void {
		// No cached rendering state; the line list is the state.
	}

	/** Completed lines only — test/assertion surface. */
	completedLines(): readonly string[] {
		return this.lines;
	}

	private startsWithLineReset(buffer: string): boolean {
		return buffer.startsWith(LINE_RESET);
	}

	/** True when `buffer` is a strict prefix of the reset marker. */
	private couldBePartialLineReset(buffer: string): boolean {
		return buffer !== "" && LINE_RESET.startsWith(buffer);
	}
}

const LINE_RESET = "\r\x1b[2K";
