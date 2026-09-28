/**
 * SA-04 (docs/sa-04-attempt-usage-design.md): one exactly-once usage ledger
 * per child execution attempt. Reports are written at the two provider-stream
 * seams (the task loop and the summarizer) the moment a `message_end` arrives
 * — immune to later history splices, rejected summaries, retries and terminal
 * outcome — and a started stream that produces no captured report sets
 * `incomplete`.
 *
 * Facts only: the ledger never guesses a token count, never asserts that
 * unreported work was free, and carries no provider/model dupes — attribution
 * flows through the surrounding contract (ChildModelBinding → TaskRecord).
 */
import { addUsage, emptyUsage, type Usage } from "./messages.js";

export type UsageReportKind = "task" | "summarizer";

export interface AttemptUsage {
	/** Reports attributed to task-assistant responses. */
	task: Usage;
	/** Reports attributed to summarizer calls (history compaction). */
	summarizer: Usage;
	/** task + summarizer, maintained incrementally (snapshot invariant). */
	totals: Usage;
	/** Task-assistant reports observed — equals task turns produced. */
	taskReports: number;
	/** Summarizer provider streams started (reported or not). */
	summarizerCalls: number;
	/** At least one started stream produced no captured usage report. */
	incomplete: boolean;
}

export interface AttemptUsageSnapshot {
	totals: Usage;
	task: Usage;
	summarizer: Usage;
	taskReports: number;
	summarizerCalls: number;
	incomplete: boolean;
}

export function createAttemptUsage(): AttemptUsage {
	return {
		task: emptyUsage(),
		summarizer: emptyUsage(),
		totals: emptyUsage(),
		taskReports: 0,
		summarizerCalls: 0,
		incomplete: false,
	};
}

/** One provider usage report observed for the attempt (a `message_end`). */
export function recordUsageReport(
	ledger: AttemptUsage | undefined,
	kind: UsageReportKind,
	usage: Usage,
): void {
	if (ledger === undefined) return;
	addUsage(kind === "task" ? ledger.task : ledger.summarizer, usage);
	addUsage(ledger.totals, usage);
	if (kind === "task") ledger.taskReports += 1;
}

/** A summarizer provider stream was started — counted even when it never
 *  reports usage (the retry/rejection paths would otherwise vanish). */
export function recordSummarizerCall(ledger: AttemptUsage | undefined): void {
	if (ledger === undefined) return;
	ledger.summarizerCalls += 1;
}

/** A started stream ended without a captured usage report (missing, or
 *  discarded by the abort-wins rule — the flag never claims which). */
export function recordMissingUsageReport(ledger: AttemptUsage | undefined): void {
	if (ledger === undefined) return;
	ledger.incomplete = true;
}

/** Deep copy — the outcome must not expose the live, still-mutable ledger. */
export function attemptUsageSnapshot(ledger: AttemptUsage): AttemptUsageSnapshot {
	return {
		totals: { ...ledger.totals },
		task: { ...ledger.task },
		summarizer: { ...ledger.summarizer },
		taskReports: ledger.taskReports,
		summarizerCalls: ledger.summarizerCalls,
		incomplete: ledger.incomplete,
	};
}
