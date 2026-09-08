import { type Component, truncateToWidth } from "../../tui.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * A collapsed diff fold (M9 phase 2): one "▸ title" line when collapsed,
 * "▾ title" plus the content lines when expanded. The title is the
 * caller's text — diff builders fold the (+added/-deleted) tallies into
 * it (buildFoldFromDiff).
 *
 * Width contract: pi-tui's renderer THROWS on any line wider than the
 * terminal (see TranscriptSink) — every line this component emits, header
 * included, is truncated ANSI-aware to render(width)'s budget. The arrow
 * is dimmed unconditionally: a TUI terminal always interprets ANSI, so
 * format.ts's isTTY gate (which tests process.stdout, the wrong stream
 * here) does not apply.
 */
export class Fold implements Component {
	private readonly title: string;
	private readonly lines: string[];
	private expanded = false;

	constructor(title: string, lines: string[] = []) {
		this.title = title;
		this.lines = lines;
	}

	/** Flip collapsed ⇄ expanded; the shell repaints. */
	toggle(): void {
		this.expanded = !this.expanded;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const arrow = this.expanded ? "▾" : "▸";
		const rendered = [truncateToWidth(`${DIM}${arrow}${RESET} ${this.title}`, w)];
		if (this.expanded) {
			for (const line of this.lines) rendered.push(truncateToWidth(line, w));
		}
		return rendered;
	}

	invalidate(): void {
		// No cached rendering state — render() recomputes from title/lines.
	}
}

/**
 * Build a fold from a unified diff: count the +/− content lines into the
 * title — "edit src/foo.ts (+12/-3)" — and keep the diff itself verbatim
 * as the body. The +++/--- file headers never count as changes; they stay
 * visible in the body. v1 adds no syntax coloring — lines land as-is.
 */
export function buildFoldFromDiff(title: string, diff: string): Fold {
	const lines = diff.split("\n");
	if (lines.at(-1) === "") lines.pop(); // a trailing newline, not a blank line
	let added = 0;
	let deleted = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deleted += 1;
	}
	return new Fold(`${title} (+${added}/-${deleted})`, lines);
}
