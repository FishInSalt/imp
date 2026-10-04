import { dim } from "../../format.js";
import { type Component, truncateToWidth, visibleWidth } from "../../tui.js";
import { sanitizeDisplay } from "../tool-presentation.js";

/** #ask-timeout-countdown (design §12 r6/D9): the one flatten shared by the
 *  component (single-line layout) and by the shell's display condition — a
 *  title that flattens to "" must not mount the component (it would render an
 *  orphan `(9:59)` row next to nothing). Sanitize, collapse whitespace runs,
 *  trim. */
export function flattenTitle(text: string): string {
	const flat = sanitizeDisplay(text).replaceAll(/\s+/gu, " ").trim();
	// Zero-width residue (ZWSP, combining marks, BOM…) ≡ empty: it is invisible
	// on screen, so a mounted component would render an orphan `(9:59)` row.
	return visibleWidth(flat) === 0 ? "" : flat;
}

/**
 * #ask-timeout-countdown (design §12 r6): a single-line picker title with the
 * bare countdown in parentheses right next to it — e.g.
 * `allow this bash command? (9:59)`. Replaces the plain `Text(options.title)`
 * child only while a deadline is armed; every other picker keeps the wrapping
 * Text byte for byte.
 *
 * Contract (design D10 r6):
 *  - visible arithmetic only (`visibleWidth`/`truncateToWidth`) — never
 *    `.length` or budget padding (`truncateToWidth` undershoots its budget on
 *    wide glyphs);
 *  - NOT right-aligned and NOT padded to `width`: the line is exactly as wide
 *    as its content (the fits branch returns `visibleWidth(left) + 1 + paren`
 *    columns, whatever the container width);
 *  - the parenthesized countdown is dim (forced, TTY-independent —
 *    SectionRule's convention); the title keeps its original weight;
 *  - the title flattens through `flattenTitle` (a stray `\n` is zero-width
 *    for the TUI's overflow guard but would corrupt the row structure —
 *    `Text` used to absorb this by wrapping, a single-line component must
 *    flatten itself);
 *  - the line never exceeds `width` (the TUI throws on overwide rows):
 *    `budget = width − parenWidth − 1` ≥ 1 truncates the title, `== 0` drops
 *    it (a lone leading space is not worth a row), `< 0` clips the
 *    parenthesized countdown alone (clip first, style after — width math runs
 *    on visible glyphs only).
 */
export class TitleCountdown implements Component {
	private readonly left: string;
	/** Bare countdown text (e.g. `9:59`) — the parens are composed in render. */
	private right: string;

	constructor(left: string, right: string) {
		this.left = flattenTitle(left);
		this.right = right;
	}

	/** Caches nothing (SectionRule's convention) — nothing to invalidate. */
	invalidate(): void {}

	/** The countdown's live update path (the shell's 1s tick) — bare text. */
	setRight(text: string): void {
		this.right = text;
	}

	render(width: number): string[] {
		const paren = `(${this.right})`;
		const parenWidth = visibleWidth(paren);
		if (width <= parenWidth) {
			// No room for "…title + space" either: clip the countdown alone.
			return [dim(truncateToWidth(paren, Math.max(0, width), "…"), true)];
		}
		const styled = dim(paren, true);
		const budget = width - parenWidth - 1;
		if (budget === 0) return [styled];
		const left = visibleWidth(this.left) <= budget ? this.left : truncateToWidth(this.left, budget, "…");
		return [`${left} ${styled}`];
	}
}
