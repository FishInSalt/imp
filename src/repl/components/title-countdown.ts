import { dim } from "../../format.js";
import { type Component, truncateToWidth, visibleWidth } from "../../tui.js";
import { sanitizeDisplay } from "../tool-presentation.js";

/**
 * #ask-timeout-countdown (design §12 r5.2): a single-line picker title with a
 * right-aligned bare countdown — e.g. `allow this bash command?      10:00`.
 * Replaces the plain `Text(options.title)` child only while a deadline is
 * armed; every other picker keeps the wrapping Text byte for byte.
 *
 * Contract (design D10):
 *  - visible arithmetic only: the gap is `width − visibleWidth(left) −
 *    visibleWidth(right)` — never `.length`/budget padding (`truncateToWidth`
 *    undershoots its budget on wide glyphs);
 *  - the right side is dim (forced, TTY-independent — SectionRule's
 *    convention); the left keeps its original weight;
 *  - the title flattens to one line (sanitized, whitespace runs collapsed):
 *    a stray `\n` is zero-width for the TUI's overflow guard but would
 *    corrupt the row structure — `Text` used to absorb this by wrapping, a
 *    single-line component must flatten itself;
 *  - the line never exceeds `width` (the TUI throws on overwide rows);
 *    in the normal branch it is exactly `width`;
 *  - degenerate widths (`width < rightWidth + 1`) drop the title and clip the
 *    countdown alone.
 */
export class TitleCountdown implements Component {
	private readonly left: string;
	private right: string;

	constructor(left: string, right: string) {
		this.left = sanitizeDisplay(left).replaceAll(/\s+/gu, " ").trim();
		this.right = right;
	}

	/** Caches nothing (SectionRule's convention) — nothing to invalidate. */
	invalidate(): void {}

	/** The countdown's live update path (the shell's 1s tick). */
	setRight(text: string): void {
		this.right = text;
	}

	render(width: number): string[] {
		// Raw right text is plain ASCII (the countdown formatter): clip first,
		// then style — all width math runs on visible glyphs only.
		const rawRight =
			width >= visibleWidth(this.right) ? this.right : truncateToWidth(this.right, Math.max(0, width), "…");
		const right = dim(rawRight, true);
		const rightWidth = visibleWidth(right);
		if (width < rightWidth + 1) {
			return [right]; // no room for a gap: the clipped countdown alone
		}
		const leftBudget = width - rightWidth - 1;
		const left =
			visibleWidth(this.left) <= leftBudget ? this.left : truncateToWidth(this.left, leftBudget, "…");
		const gap = width - visibleWidth(left) - rightWidth;
		return [`${left}${" ".repeat(Math.max(0, gap))}${right}`];
	}
}
