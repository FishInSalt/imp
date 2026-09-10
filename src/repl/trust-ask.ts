import { describeTrustResources } from "../core/trust.js";
import type { Terminal } from "../tui.js";
import { TuiShell } from "./shell.js";
import type { TranscriptSink } from "./transcript.js";

/** The TUI trust ask's verdict (debt clearance: this used to be a readline
 *  [y/N] even on the TUI shell, because extension loading ran before the
 *  shell existed — a one-shot ask shell closes that window).
 *
 *  - "yes": record trust permanently
 *  - "no": record "do not trust" permanently
 *  - "session": load project resources NOW, record nothing (ask again next
 *    open)
 *  - null (Esc/Ctrl+C at the picker): deny for this session only, record
 *    nothing — the dropped-terminal rule (M8 review)
 */
export type TrustAskAnswer = "yes" | "no" | "session";

const TRUST_ITEMS: readonly { label: string }[] = [
	{ label: "Yes — trust and remember" },
	{ label: "No — do not trust (remembered)" },
	{ label: "Yes, this session only" },
];

/** Item index → verdict (kept beside the labels it derives from). */
const ANSWERS: readonly TrustAskAnswer[] = ["yes", "no", "session"];

/** One-shot TUI shell that asks the M8 project-trust question with a picker.
 *
 *  The shell exists only for the ask: start → select → close, then the real
 *  REPL starts its own shell over the SAME TranscriptSink — notes written
 *  after the answer (the "recorded" lines) land in the real session's
 *  transcript, and nothing from the ask outlives it (the picker title lives
 *  in the ask area, not the transcript).
 *
 *  `terminal` is injected by tests; production binds the real one. */
export async function askTrustViaTui(options: {
	transcript: TranscriptSink;
	cwd: string;
	resources: readonly string[];
	terminal?: Terminal;
}): Promise<TrustAskAnswer | null> {
	const shell = new TuiShell({
		transcript: options.transcript,
		terminal: options.terminal,
		onDequeue: () => {},
		// Unreachable in practice: the picker holds focus for the whole ask
		// (Esc/Ctrl+C cancel it). Wired as no-ops so the shell contract holds.
		onLine: () => {},
		onInterrupt: () => {},
		onEof: () => {},
	});
	shell.start();
	const described = describeTrustResources(options.cwd, options.resources);
	const title = `Trust ${options.cwd}? It wants to load: ${described}`;
	const pick = await shell.select({ title, items: [...TRUST_ITEMS] });
	shell.close();
	// The delayed terminal stop (40ms) must RUN before the real shell binds
	// stdin — otherwise it pauses the stream under the successor (review P0).
	await shell.whenSettled();
	return pick === null ? null : (ANSWERS[pick] ?? null);
}
