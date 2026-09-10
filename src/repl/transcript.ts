import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../tui.js";

/** SGR: 256-color background for user-input blocks (pi parity: dark
 *  #343541 ≈ palette 237). Hardcoded palette over truecolor for terminal
 *  compatibility; a theme system would own this. */
const USER_BLOCK_BG = "\x1b[48;5;237m";
const RESET = "\x1b[0m";
/** How each transcript line renders. "user" lines render as a pi-style
 *  full-width background block row; the block's pad rows are stored as
 *  empty "user" lines (kind survives resize via the wrap cache rebuild). */
type LineKind = "plain" | "user";

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
	/** Parallel to lines — the render style of each completed line. */
	private kinds: LineKind[] = [];
	private current = "";
	private carry = "";
	/** Completed lines wrapped at wrappedWidth — appended incrementally,
	 *  rebuilt once on resize. The tail (current) rewraps per frame. */
	private wrapped: string[] = [];
	/** Running wrapped-row totals: cumulative[i] = rows emitted by
	 *  lines[0..i]. Anchors the inline children across rewraps. */
	private cumulative: number[] = [];
	private wrappedWidth = -1;
	/** Inline child components (folds), anchored to a completed-line
	 *  count. pi parity (2026-09-10): a tool result renders inside the
	 *  stream, directly under its `● … ✓` line — no fold region below the
	 *  transcript. Anchors are append-only in practice (a fold lands at
	 *  tool_end, after the tool line completes and before the next text
	 *  delta); the anchor arithmetic still holds for any past position.
	 *  The in-flight tail (current) always renders after every child. */
	private children: Array<{ at: number; component: Component }> = [];
	/** Fires whenever lines change — the shell binds tui.requestRender. */
	onUpdate: (() => void) | null = null;

	/** Reset to an empty screen (/new, /resume replay). The next feed or
	 *  render starts from line zero — a cleared sink is indistinguishable
	 *  from a fresh one (debt clearance: /new used to leave stale lines).
	 *  Inline children go with the text: /new wipes folds too. */
	clear(): void {
		this.lines = [];
		this.kinds = [];
		this.carry = "";
		this.wrapped = [];
		this.cumulative = [];
		this.wrappedWidth = -1;
		this.children = [];
		this.onUpdate?.();
	}

	/** Anchor a component in the stream below the completed lines (pi
	 *  parity: tool-result folds render inline, under their tool line). */
	appendChild(component: Component): void {
		this.children.push({ at: this.lines.length, component });
		this.onUpdate?.();
	}

	/** A user input as a pi-style full-width background block (no "> "
	 *  prefix — pi renders the message body plain in a padded bg box).
	 *  One call = one block: top/bottom pad rows (pi Box paddingY=1, same
	 *  bg) sandwich every physical line of text, so multi-line input reads
	 *  as ONE block. Any open streaming line settles first (the renderer
	 *  guarantees one, this is belt-and-suspenders). */
	feedUser(text: string): void {
		if (this.current !== "") this.feed("\n");
		this.pushLine("", "user"); // top pad
		for (const line of text.split("\n")) this.pushLine(line, "user");
		this.pushLine("", "user"); // bottom pad
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
			this.wrapped = [];
			this.cumulative = [];
			for (let i = 0; i < this.lines.length; i++) {
				const line = this.lines[i] ?? "";
				const rows = this.kinds[i] === "user" ? this.wrapUserLine(line, w) : this.wrapLine(line, w);
				for (const row of rows) this.wrapped.push(row);
				this.cumulative.push(this.wrapped.length);
			}
		}
		let out = this.wrapped;
		if (this.children.length > 0) {
			// Splice the children in at their anchors. Row-by-row appends, not
			// call-spreads: render() runs every frame, and spreading a whole
			// marathon-session transcript (>100k rows) can hit V8's
			// spread-argument ceiling (review P2).
			out = [];
			let emitted = 0;
			const pushRows = (rows: readonly string[]): void => {
				for (const row of rows) out.push(row);
			};
			for (const child of this.children) {
				const upto = child.at === 0 ? 0 : (this.cumulative[child.at - 1] ?? 0);
				pushRows(this.wrapped.slice(emitted, upto));
				pushRows(child.component.render(w));
				emitted = Math.max(emitted, upto);
			}
			pushRows(this.wrapped.slice(emitted));
		}
		if (this.current === "") return out;
		return [...out, ...this.wrapLine(this.current, w)];
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
		this.pushLine(line, "plain");
	}

	private pushLine(line: string, kind: LineKind): void {
		this.lines.push(line);
		this.kinds.push(kind);
		if (this.wrappedWidth > 0) {
			const rows =
				kind === "user" ? this.wrapUserLine(line, this.wrappedWidth) : this.wrapLine(line, this.wrappedWidth);
			for (const row of rows) this.wrapped.push(row);
			this.cumulative.push(this.wrapped.length);
		}
	}

	/** A user-block row: content wraps at width-2 (pi Box paddingX=1 each
	 *  side), then each row gains its left pad, right-fills to the FULL
	 *  width, and takes the block background — the fill is render-width
	 *  derived, so a resize re-derives it (kinds survive in the rebuild). */
	private wrapUserLine(line: string, width: number): string[] {
		const inner = Math.max(1, width - 2);
		return this.wrapLine(line, inner).map((row) => this.fillUserRow(` ${row}`, width));
	}

	private fillUserRow(content: string, width: number): string {
		let body = content;
		if (visibleWidth(body) > width) body = truncateToWidth(body, width); // pathological last resort
		const pad = " ".repeat(Math.max(0, width - visibleWidth(body)));
		return `${USER_BLOCK_BG}${body}${pad}${RESET}`;
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
