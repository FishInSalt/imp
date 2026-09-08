import { type Component, truncateToWidth } from "../../tui.js";

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
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
 *
 * The body renders through decorateDiffLines (prefix colors + a new-file
 * line-number gutter) — a presentation concern of the fold alone. The raw
 * diff text the machine feeds in is never rewritten: it flows verbatim
 * into the model context and the print-mode stream.
 */
export class Fold implements Component {
	private readonly title: string;
	/** Body pre-decorated once at construction; render stays cheap. */
	private readonly body: string[];
	private expanded = false;

	constructor(title: string, lines: string[] = []) {
		this.title = title;
		this.body = decorateDiffLines(lines);
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
			for (const line of this.body) rendered.push(truncateToWidth(line, w));
		}
		return rendered;
	}

	invalidate(): void {
		// No cached rendering state — render() recomputes from title/lines.
	}
}

/** The edit tool's hunk header: "@@ line K @@", K = the hunk's first
 *  new-file line number. Any other "@@" line (unified-diff style, prose)
 *  is still a header — colored, but never numbered. */
const HUNK_HEADER = /^@@ line (\d+) @@$/;

/**
 * Decorate one diff body for display: "+ " adds green, "- " removes red,
 * "@@" headers cyan, everything else (context) dim. While a parseable
 * hunk header has opened counting, added and context lines carry a dim,
 * right-aligned new-file line number ("NNN│ ") — removed lines are not in
 * the new file, so they get no number and never increment. Tolerant: with
 * no parseable header there is no gutter, only the colors. Pure — the
 * input text itself is never modified.
 */
export function decorateDiffLines(lines: string[]): string[] {
	type Kind = "header" | "add" | "remove" | "context";
	const plan: Array<{ line: string; kind: Kind; number: number | null }> = [];
	let next: number | null = null; // next new-file line number; null = numbering off
	for (const line of lines) {
		if (line.startsWith("@@")) {
			const match = HUNK_HEADER.exec(line);
			next = match === null ? null : Number(match[1] ?? 0);
			plan.push({ line, kind: "header", number: null });
		} else if (line.startsWith("+ ")) {
			plan.push({ line, kind: "add", number: next });
			if (next !== null) next += 1;
		} else if (line.startsWith("- ")) {
			plan.push({ line, kind: "remove", number: null });
		} else {
			plan.push({ line, kind: "context", number: next });
			if (next !== null) next += 1;
		}
	}
	const width = plan.reduce((max, p) => Math.max(max, p.number === null ? 0 : String(p.number).length), 1);
	return plan.map((p) => {
		const color = p.kind === "add" ? GREEN : p.kind === "remove" ? RED : p.kind === "header" ? CYAN : DIM;
		const gutter = p.number === null ? "" : `${DIM}${String(p.number).padStart(width)}│ ${RESET}`;
		return `${gutter}${color}${p.line}${RESET}`;
	});
}

/**
 * Fold data from a diff: count the +/− content lines into the title —
 * "edit src/foo.ts (+12/-3)" — and keep the diff itself verbatim as the
 * body. The +++/--- file headers never count as changes; they stay visible
 * in the body. Coloring and the line-number gutter happen in the Fold's
 * render layer (decorateDiffLines), never here — this stays plain data (no
 * pi-tui types) so the presentation-agnostic machine can consume it; the
 * shell folds it into a Fold via addFold.
 */
export function buildFoldFromDiff(title: string, diff: string): { title: string; lines: string[] } {
	const lines = diff.split("\n");
	if (lines.at(-1) === "") lines.pop(); // a trailing newline, not a blank line
	let added = 0;
	let deleted = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deleted += 1;
	}
	return { title: `${title} (+${added}/-${deleted})`, lines };
}
