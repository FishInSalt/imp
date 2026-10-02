/**
 * #guardian-auto-mode (design D11/D18; §16/D32/D33): the HUMAN RECORD stores —
 * the host's record of human-sourced facts, and the only evidence the
 * classify seam may treat as authoritative:
 *
 * (a) `UserInputLog` — raw human submissions (D11), captured ONLY at the
 *     submission boundary; model-authored text never enters it, regardless
 *     of its stored role.
 * (b) `GateDecisionLog` — gate-confirmation outcomes (D33), recorded by the
 *     confirm host while a tool dispatch is active.
 *
 * Entries are stored raw — no storage-side trim (the large typed submissions
 * already live in `history`; line-bounded inputs are trivial); elision and
 * every rendered cap apply at render time (§16.3). Invalidation: D18 — both
 * lists clear on identity/history changes (the runner owns the call sites).
 */

/** Rendered-record caps (design §16.2, owner-approved 2026-10-02): the
 *  per-entry render cap (level 0), the shrink levels run down to 1000, and
 *  the total bound / floor of the assembled request budget (D39). */
export const HUMAN_RECORD_MAX_EVENTS = 40;
export const HUMAN_RECORD_ENTRY_CHARS = 4000;
export const HUMAN_RECORD_MAX_CHARS = 32768;
export const HUMAN_RECORD_MIN_CHARS = 8192;

/** One raw human submission with its host timestamp (the rendered relative
 *  time is derived from the injected clock, never stored formatted). */
export interface HumanRecordEntry {
	readonly text: string;
	readonly at: number;
}

/** One gate-decision outcome (D33): what the human allowed or denied, on the
 *  exact call the identity names. `callIdentity` is display/equality text
 *  (`<tool> @ <JSON cwd> <JSON call text>`), computed by the host at the
 *  freeze site — never extension-authored. */
export interface GateDecisionEvent {
	readonly at: number;
	readonly tool: string;
	readonly callIdentity: string;
	readonly outcome: "approved" | "denied";
	/** The "Yes, remember for this session" pick — recorded once, at the pick
	 *  (replays of the session rule are not re-recorded; D33). */
	readonly remember?: boolean;
}

/** What the confirm host reports; the log stamps the time. */
export interface GateDecisionInput {
	readonly tool: string;
	readonly callIdentity: string;
	readonly outcome: "approved" | "denied";
	readonly remember?: boolean;
}

export class UserInputLog {
	private entries: HumanRecordEntry[] = [];

	/** True when at least one verified submission exists (D17's event fact). */
	get verified(): boolean {
		return this.entries.length > 0;
	}

	/** Record one raw submission (blanks never enter). */
	record(text: string, at: number = Date.now()): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		this.entries.push(Object.freeze({ text: trimmed, at }));
	}

	/** Invalidate every entry (identity/history change, D18). */
	clear(): void {
		this.entries.length = 0;
	}

	/** A defensive copy — callers (and the seam) can never mutate the log. */
	snapshot(): readonly HumanRecordEntry[] {
		return [...this.entries];
	}
}

export class GateDecisionLog {
	private events: GateDecisionEvent[] = [];

	record(input: GateDecisionInput, at: number = Date.now()): void {
		this.events.push(Object.freeze({ at, ...input }));
	}

	/** Same lifecycle as the submission log (D18): a position or identity
	 *  change invalidates prior decisions too. */
	clear(): void {
		this.events.length = 0;
	}

	snapshot(): readonly GateDecisionEvent[] {
		return [...this.events];
	}
}
