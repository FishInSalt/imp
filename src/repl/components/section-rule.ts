import { dim, yellow } from "../../format.js";
import { type Component, truncateToWidth, visibleWidth } from "../../tui.js";
import { sanitizeDisplay } from "../tool-presentation.js";

/** #confirm-prompt (Phase 4 D14, A2.1/A2.2): dashes before the label — the
 *  owner nudged the name right twice; this constant is the single knob. */
const LEAD_DASHES = 4;

/**
 * #confirm-prompt (Phase 4 D14, A2.1/A2.2/A2.3): a full-width horizontal rule
 * that can carry a host-held label — the section boundary between the
 * transcript and a picker box. The label renders in the host's accent
 * (`yellow`), the dashes stay dim.
 *
 * Same rendering shape as the login dialog's private `DialogBorder`
 * (`login-dialog.ts` "pi's DynamicBorder"), but kept separate: that one is the
 * dialog's own frame, not a section boundary (design §16.2 D14 / O8). The
 * label is the host-derived attribution, never extension-authored, so an
 * extension cannot write a different name into the divider.
 *
 * Render contract (design D14, re-anchored by A2.1/A2.2):
 *  - absent/empty label, or `avail = width - LEAD_DASHES - 2 < 2` → plain dim
 *    dashes (below the threshold a clipped label would read as damage);
 *  - otherwise the label is sanitized, clipped to `avail`, and the row is
 *    `dim("─"×LEAD_DASHES) + " " + label + " " + dim(remaining dashes)` — the
 *    label sits left where the eye lands first, and `visibleWidth(row) === width`
 *    always (`right === 0` ends the row after the label's trailing space).
 */
export class SectionRule implements Component {
	private readonly label: string;

	constructor(label?: string) {
		this.label = label ?? "";
	}

	/** Caches nothing (like DialogBorder) — nothing to invalidate. */
	invalidate(): void {}

	render(width: number): string[] {
		const avail = width - LEAD_DASHES - 2;
		const sanitized = sanitizeDisplay(this.label);
		if (sanitized === "" || avail < 2) {
			return [dim("─".repeat(Math.max(0, width)), true)];
		}
		const label = truncateToWidth(sanitized, avail);
		const right = avail - visibleWidth(label);
		// A2.1/A2.2: left-anchored, LEAD_DASHES in. `right === 0` is legal: the row
		// ends after the label's trailing space. A2.3: the name carries the host's
		// one accent (yellow) — dim dashes, accented label, dim remainder.
		return [
			`${dim("─".repeat(LEAD_DASHES), true)} ${yellow(label, true)} ${
				right > 0 ? dim("─".repeat(right), true) : ""
			}`,
		];
	}
}
