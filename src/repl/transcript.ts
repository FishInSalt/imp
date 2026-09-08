import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../tui.js";

const LINE_RESET = "\r\x1b[2K";

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
 *                     replace it. Recognized ANYWHERE in the stream, not
 *                     just at chunk heads: the contract is the terminal's,
 *                     and terminals are position-independent (M9 review P1).
 *   - anything else   appends to the current line (streaming deltas)
 *
 * Model text is forwarded verbatim: if the model itself emits cursor bytes
 * (lone "\r", "\b"), they land inside a line as zero-width content — the
 * sink does not interpret them (documented exemption; the Renderer authors
 * every cursor byte it can, but raw() forwards arbitrary text).
 *
 * Width contract (M9 review P0): pi-tui's differential renderer THROWS on a
 * component line wider than the terminal. The readline era relied on the
 * terminal's native wrapping; render(width) restores that by wrapping every
 * line (ANSI-aware, column/CJK-safe via wrapTextWithAnsi) and truncating a
 * lone wider-than-screen grapheme as a last resort.
 */
export class TranscriptSink implements Component {
	private lines: string[] = [];
	private current = "";
	private carry = "";
	/** Completed lines wrapped at wrappedWidth — appended incrementally,
	 *  rebuilt once on resize. The tail (current) rewraps per frame. */
	private wrapped: string[] = [];
	private wrappedWidth = -1;
	/** Fires whenever lines change — the shell binds tui.requestRender. */
	onUpdate: (() => void) | null = null;

	/** Reset to an empty screen (/new, /resume replay). The next feed or
	 *  render starts from line zero — a cleared sink is indistinguishable
	 *  from a fresh one (debt clearance: /new used to leave stale lines). */
	clear(): void {
		this.lines = [];
		this.current = "";
		this.carry = "";
		this.wrapped = [];
		this.wrappedWidth = -1;
		this.onUpdate?.();
	}

	/** The Renderer's write sink. Chunk-boundary safe in BOTH directions:
	 *  split arbitrarily AND merged into single feeds (a partial marker is
	 *  held back until the stream resolves it). */
	feed = (chunk: string): void => {
		let buffer = this.carry + chunk;
		this.carry = "";
		let changed = false;
		while (buffer.length > 0) {
			if (buffer.startsWith(LINE_RESET)) {
				this.current = "";
				buffer = buffer.slice(LINE_RESET.length);
				changed = true;
				continue;
			}
			// A strict prefix of the marker: wait for more bytes.
			if (LINE_RESET.startsWith(buffer)) {
				this.carry = buffer;
				break;
			}
			const newline = buffer.indexOf("\n");
			// A reset marker mid-buffer: content before it joins the current
			// line, then the loop head consumes the marker.
			const reset = buffer.indexOf(LINE_RESET);
			if (reset !== -1 && (newline === -1 || reset < newline)) {
				const head = buffer.slice(0, reset);
				if (head !== "") this.current += head;
				buffer = buffer.slice(reset);
				changed = true;
				continue;
			}
			if (newline === -1) {
				// A trailing "\r" may be the first byte of a split marker —
				// hold it back rather than commit it as content.
				if (buffer.endsWith("\r")) {
					this.current += buffer.slice(0, -1);
					this.carry = "\r";
				} else {
					this.current += buffer;
				}
				changed = true;
				break;
			}
			this.completeLine(this.current + buffer.slice(0, newline));
			this.current = "";
			buffer = buffer.slice(newline + 1);
			changed = true;
		}
		if (changed) this.onUpdate?.();
	};

	render(width: number): string[] {
		const w = Math.max(1, width);
		if (w !== this.wrappedWidth) {
			this.wrappedWidth = w;
			this.wrapped = this.lines.flatMap((line) => this.wrapLine(line, w));
		}
		if (this.current === "") return this.wrapped;
		return [...this.wrapped, ...this.wrapLine(this.current, w)];
	}

	invalidate(): void {
		// No cached rendering state beyond the width cache, which render()
		// itself keeps coherent; the line list is the state.
	}

	/** Completed lines only, verbatim (no wrapping) — test/assertion surface. */
	completedLines(): readonly string[] {
		return this.lines;
	}

	private completeLine(line: string): void {
		this.lines.push(line);
		if (this.wrappedWidth > 0) this.wrapped.push(...this.wrapLine(line, this.wrappedWidth));
	}

	private wrapLine(line: string, width: number): string[] {
		if (line === "") return [""];
		const wrapped = wrapTextWithAnsi(line, width);
		// A zero-width-laden line can wrap to nothing; the terminal contract
		// keeps a line. A single grapheme wider than the screen truncates.
		if (wrapped.length === 0) return [truncateToWidth(line, width)];
		return wrapped.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
	}
}
