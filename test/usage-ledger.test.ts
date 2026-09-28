import { describe, expect, it } from "vitest";
import {
	attemptUsageSnapshot,
	createAttemptUsage,
	recordMissingUsageReport,
	recordSummarizerCall,
	recordUsageReport,
} from "../src/core/usage-ledger.js";

describe("SA-04 attempt ledger", () => {
	it("starts empty: zero totals, no reports, not incomplete", () => {
		const ledger = createAttemptUsage();
		expect(ledger.totals).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(ledger.taskReports).toBe(0);
		expect(ledger.summarizerCalls).toBe(0);
		expect(ledger.incomplete).toBe(false);
	});

	it("keeps totals == task + summarizer componentwise across interleavings", () => {
		const ledger = createAttemptUsage();
		recordUsageReport(ledger, "task", {
			inputTokens: 10,
			outputTokens: 2,
			cacheReadTokens: 7,
			cacheWriteTokens: 3,
		});
		recordUsageReport(ledger, "summarizer", { inputTokens: 4, outputTokens: 1 });
		recordSummarizerCall(ledger);
		recordUsageReport(ledger, "task", { inputTokens: 6, outputTokens: 5, cacheWriteTokens: 2 });
		expect(ledger.totals).toEqual({
			inputTokens: 20,
			outputTokens: 8,
			cacheReadTokens: 7,
			cacheWriteTokens: 5,
		});
		expect(ledger.taskReports).toBe(2);
		expect(ledger.summarizerCalls).toBe(1);
		expect(ledger.totals.inputTokens).toBe(ledger.task.inputTokens + ledger.summarizer.inputTokens);
		expect(ledger.totals.outputTokens).toBe(ledger.task.outputTokens + ledger.summarizer.outputTokens);
		expect(ledger.totals.cacheReadTokens).toBe(
			(ledger.task.cacheReadTokens ?? 0) + (ledger.summarizer.cacheReadTokens ?? 0),
		);
		expect(ledger.totals.cacheWriteTokens).toBe(
			(ledger.task.cacheWriteTokens ?? 0) + (ledger.summarizer.cacheWriteTokens ?? 0),
		);
	});

	it("counts started calls and missing reports even when nothing is reported", () => {
		const ledger = createAttemptUsage();
		recordSummarizerCall(ledger);
		recordSummarizerCall(ledger);
		recordMissingUsageReport(ledger);
		expect(ledger.summarizerCalls).toBe(2);
		expect(ledger.incomplete).toBe(true);
		expect(ledger.totals).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(ledger.taskReports).toBe(0);
	});

	it("snapshots are copies: recording after a snapshot never mutates it", () => {
		const ledger = createAttemptUsage();
		recordUsageReport(ledger, "task", { inputTokens: 1, outputTokens: 1 });
		const snap = attemptUsageSnapshot(ledger);
		recordUsageReport(ledger, "task", { inputTokens: 100, outputTokens: 100 });
		recordSummaryAndMissing();
		function recordSummaryAndMissing(): void {
			recordUsageReport(ledger, "summarizer", { inputTokens: 5, outputTokens: 5 });
			recordMissingUsageReport(ledger);
		}
		expect(snap.totals).toEqual({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
		expect(snap.taskReports).toBe(1);
		expect(snap.incomplete).toBe(false);
		expect(ledger.totals.inputTokens).toBe(106);
	});

	it("every recording function is a no-op with an undefined ledger", () => {
		expect(() => {
			recordUsageReport(undefined, "task", { inputTokens: 1, outputTokens: 1 });
			recordSummarizerCall(undefined);
			recordMissingUsageReport(undefined);
		}).not.toThrow();
	});
});
