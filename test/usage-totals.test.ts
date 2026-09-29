import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import { SessionStore } from "../src/core/session/store.js";
import type { SessionEntry } from "../src/core/session/store.js";
import {
	buildTaskRecord,
	type TaskRecord,
	type TaskRecordInput,
	type TaskRecordUsage,
} from "../src/core/task-record.js";
import { priceUsageTotals, usageTotalsTracker } from "../src/core/usage-totals.js";
import { usageMoneySegment } from "../src/format.js";

/**
 * SA-05: the durable parent-plus-child work-usage aggregate.
 * See docs/sa-05-usage-totals-design.md.
 */

const TS = "2026-09-27T00:00:00.000Z";
let nextRecord = 1;

function userEntry(id: string, parentId: string | null, text = "u"): SessionEntry {
	return { type: "message", id, parentId, timestamp: TS, message: { role: "user", content: text } };
}

function assistantEntry(
	id: string,
	parentId: string | null,
	inputTokens: number,
	outputTokens: number,
	extra: Partial<AssistantMessage> = {},
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: {
			role: "assistant",
			blocks: [{ type: "text", text: "a" }],
			usage: { inputTokens, outputTokens },
			stopReason: "end_turn",
			...extra,
		},
	};
}

function taskRecord(usage?: TaskRecordUsage, overrides: Partial<TaskRecordInput> = {}): TaskRecord {
	return buildTaskRecord({
		attemptId: `att-${nextRecord++}`,
		sourceId: "src",
		launched: true,
		cwd: "/tmp",
		status: "completed",
		turns: 2,
		textPresent: true,
		...(usage !== undefined && { usage }),
		binding: { providerName: "zai", wireModelId: "glm-5.3", reference: "zai/glm-5.3" },
		...overrides,
	});
}

function taskResultEntry(id: string, parentId: string | null, record: TaskRecord): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: {
			role: "toolResult",
			results: [
				{ toolCallId: `t-${id}`, toolName: "task", content: "done", isError: false, taskRecord: record },
			],
		},
	};
}

function compactionEntry(
	id: string,
	parentId: string | null,
	usage?: { inputTokens: number; outputTokens: number },
	model?: string,
	usageMissing?: boolean,
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: TS,
		summary: "s",
		retainedTail: [],
		tokensBefore: 500,
		...(usage !== undefined && { usage }),
		...(model !== undefined && { model }),
		...(usageMissing === true && { usageMissing: true as const }),
	};
}

function toolResultEntry(
	id: string,
	parentId: string | null,
	toolName: string,
	isError = false,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: { role: "toolResult", results: [{ toolCallId: `c-${id}`, toolName, content: "", isError }] },
	};
}

describe("SA-05 usage totals", () => {
	it("sums parent, child and summarizer usage exactly once (R3 anchor)", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null),
			assistantEntry("a1", "u1", 100, 10, { modelReference: "test-parent" }),
			taskResultEntry("t1", "a1", taskRecord({ inputTokens: 50, outputTokens: 7 })),
			compactionEntry("c1", "t1", { inputTokens: 20, outputTokens: 5 }, "test-sum"),
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.parent).toEqual({
			inputTokens: 100,
			outputTokens: 10,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			calls: 1,
		});
		expect(view.child).toEqual({
			inputTokens: 50,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			calls: 1,
		});
		expect(view.summarizer).toEqual({
			inputTokens: 20,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			calls: 1,
		});
		expect(view.total.inputTokens).toBe(170);
		expect(view.total.outputTokens).toBe(22);
		expect(view.incomplete).toEqual({ parent: false, child: false, summarizer: false });
	});

	it("counts entries on abandoned branches and stays idempotent under repeated views", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null),
			assistantEntry("a1", "u1", 10, 1, { modelReference: "test-parent" }),
			// abandoned branch: a sibling assistant carried different leaf history
			assistantEntry("a2", "u1", 20, 2, { modelReference: "test-parent" }),
			compactionEntry("c1", "a1"),
		];
		const tracker = usageTotalsTracker(entries);
		const first = tracker.view();
		const second = tracker.view();
		expect(first.parent.inputTokens).toBe(30); // 10 + 20 — branch switching must not forget
		expect(second).toEqual(first);
	});

	it("prices per producer reference; unknown references are unpriced, never fallback-priced", () => {
		const entries: SessionEntry[] = [
			assistantEntry("a1", null, 1_000_000, 0, { modelReference: "known/model-a" }),
			assistantEntry("a2", "a1", 1_000_000, 0), // legacy: no declared identity
			taskResultEntry("t1", "a2", taskRecord({ inputTokens: 500_000, outputTokens: 0 })),
		];
		const priced = priceUsageTotals(usageTotalsTracker(entries).view(), (reference) =>
			reference === "known/model-a"
				? { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }
				: reference === "zai/glm-5.3"
					? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
					: undefined,
		);
		expect(priced.usd).toBeCloseTo(2 + 0.5, 10); // 1M @ $2 + 0.5M @ $1
		expect(priced.unpriced.inputTokens).toBe(1_000_000); // the legacy message only
		expect(priced.byModel.find((m) => m.reference === null)?.priced).toBe(false);
	});
	it("rebuild == incremental: a fresh tracker over the grown entries agrees", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null),
			assistantEntry("a1", "u1", 10, 1, { modelReference: "test-parent" }),
		];
		const tracker = usageTotalsTracker(entries);
		expect(tracker.view().parent.calls).toBe(1);
		entries.push(assistantEntry("a2", "a1", 7, 3, { modelReference: "test-parent" }));
		const incremented = tracker.view();
		const rebuilt = usageTotalsTracker(entries).view();
		expect(incremented).toEqual(rebuilt);
		expect(incremented.parent.calls).toBe(2);
		expect(incremented.parent.inputTokens).toBe(17);
	});

	it("dedupes task records by attemptId (hand-copied entries count once)", () => {
		const record = taskRecord({ inputTokens: 5, outputTokens: 1 });
		const entries: SessionEntry[] = [
			taskResultEntry("t1", null, record),
			taskResultEntry("t2", "t1", record), // same attemptId — defensive dedupe
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.child.calls).toBe(1);
		expect(view.child.inputTokens).toBe(5);
	});

	it("rule 2b: a task result without a parsable record marks the child bucket incomplete", () => {
		const entries: SessionEntry[] = [
			toolResultEntry("r1", null, "task", true), // synthetic force-quit closer: no record
			toolResultEntry("r2", "r1", "bash"), // non-task results are not a signal
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.child.calls).toBe(0);
		expect(view.incomplete).toEqual({ parent: false, child: true, summarizer: false });
	});

	it("SA-08/F5: a record-carried incomplete flag marks the child bucket without losing its totals", () => {
		const entries: SessionEntry[] = [
			taskResultEntry("t1", null, taskRecord({ inputTokens: 9, outputTokens: 4, incomplete: true })),
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.child.inputTokens).toBe(9);
		expect(view.child.outputTokens).toBe(4);
		expect(view.incomplete.child).toBe(true);
	});

	it("taxonomy: absent usage on a launched record is unknown; unlaunched records are silent", () => {
		const entries: SessionEntry[] = [
			taskResultEntry("t1", null, taskRecord(undefined)), // launched, no usage report
			taskResultEntry("t2", "t1", taskRecord(undefined, { launched: false, status: "rejected" })),
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.child.calls).toBe(0);
		expect(view.incomplete.child).toBe(true); // the launched one; the rejected one contributes nothing
	});

	it("assistant usageMissing keeps the numbers and flags the parent bucket", () => {
		const entries: SessionEntry[] = [assistantEntry("a1", null, 0, 0, { usageMissing: true })];
		const view = usageTotalsTracker(entries).view();
		expect(view.parent.calls).toBe(1);
		expect(view.incomplete.parent).toBe(true);
		expect(view.incomplete.child).toBe(false);
	});

	it("summary entries: usageMissing flags; a legacy entry counts once and stays unflagged (L1)", () => {
		const entries: SessionEntry[] = [
			compactionEntry("c1", null, { inputTokens: 8, outputTokens: 2 }, "test-sum"), // reported
			compactionEntry("c2", "c1", { inputTokens: 3, outputTokens: 1 }, "test-sum", true), // flagged
			compactionEntry("c3", "c2", undefined, undefined), // legacy: no usage field at all
			compactionEntry("c4", "c3", { inputTokens: 4, outputTokens: 1 }), // legacy with numbers, no model
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.summarizer).toEqual({
			inputTokens: 15,
			outputTokens: 4,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			calls: 3,
		});
		expect(view.incomplete.summarizer).toBe(true);
	});

	it("prices each producer independently: an unknown child reference stays unpriced beside a priced parent", () => {
		const entries: SessionEntry[] = [
			assistantEntry("a1", null, 1_000_000, 0, { modelReference: "known/model-a" }),
			taskResultEntry(
				"t1",
				"a1",
				taskRecord(
					{ inputTokens: 2_000_000, outputTokens: 0 },
					{ binding: { providerName: "anthropic", wireModelId: "m", reference: "unknown/model-b" } },
				),
			),
		];
		const priced = priceUsageTotals(usageTotalsTracker(entries).view(), (reference) =>
			reference === "known/model-a" ? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } : undefined,
		);
		expect(priced.usd).toBeCloseTo(1, 10);
		expect(priced.unpriced.inputTokens).toBe(2_000_000);
		expect(priced.byModel.find((m) => m.reference === "unknown/model-b")?.priced).toBe(false);
	});

	it("SA-08/F3-b: a tampered record identity survives neither reopen nor pricing", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-f3b-"));
		const filePath = path.join(base, "parent.jsonl");
		const store = SessionStore.create(filePath, base, "parent-f3b");
		store.appendMessage({
			role: "toolResult",
			results: [
				{
					toolCallId: "call-1",
					toolName: "task",
					content: "done",
					isError: false,
					taskRecord: taskRecord(
						{ inputTokens: 9, outputTokens: 4 },
						{
							binding: { providerName: "openai", wireModelId: "actual", reference: "anthropic/different" },
						},
					),
				} as never,
			],
		});
		const reopened = SessionStore.open(filePath);
		const view = usageTotalsTracker(reopened.getEntries()).view();
		expect(view.incomplete.child).toBe(true);
		expect(view.child.calls).toBe(0);
		expect(view.child.inputTokens).toBe(0);
		const priced = priceUsageTotals(view, (reference) =>
			reference === "anthropic/different" ? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } : undefined,
		);
		expect(priced.usd ?? 0).toBe(0);
		expect(priced.byModel.some((m) => m.reference === "anthropic/different")).toBe(false);
	});

	it("tags subscription-backed priced usage (the (sub) semantics)", () => {
		const entries: SessionEntry[] = [assistantEntry("a1", null, 100, 0, { modelReference: "zai/glm-5.3" })];
		const priced = priceUsageTotals(usageTotalsTracker(entries).view(), () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			subscription: true,
		}));
		expect(priced.subscription).toBe(true);
		expect(priced.unpriced.inputTokens).toBe(0);
	});

	it("rule 2b is exactly-once by toolCallId: a record-less repeat adds no new signal", () => {
		const record = taskRecord({ inputTokens: 50, outputTokens: 7 });
		const repeated: SessionEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: TS,
			message: {
				role: "toolResult",
				results: [
					{ toolCallId: "c9", toolName: "task", content: "", isError: false, taskRecord: record },
					{ toolCallId: "c9", toolName: "task", content: "", isError: true }, // echo without the record
				],
			},
		};
		expect(usageTotalsTracker([repeated]).view().incomplete.child).toBe(false);
		// a genuinely NEW record-less task result still flags
		expect(
			usageTotalsTracker([repeated, toolResultEntry("r2", "m1", "task", true)]).view().incomplete.child,
		).toBe(true);
	});

	it("a shrinking entry array rebuilds instead of serving stale totals", () => {
		const entries: SessionEntry[] = [
			assistantEntry("a1", null, 10, 1, { modelReference: "test-parent" }),
			assistantEntry("a2", "a1", 20, 2, { modelReference: "test-parent" }),
		];
		const tracker = usageTotalsTracker(entries);
		expect(tracker.view().parent.calls).toBe(2);
		entries.pop(); // a mutation outside the store (pathological)
		entries.push(taskResultEntry("t1", "a1", taskRecord({ inputTokens: 5, outputTokens: 1 })));
		const view = tracker.view();
		const rebuilt = usageTotalsTracker(entries).view();
		expect(view).toEqual(rebuilt);
		expect(view.parent.calls).toBe(1);
		expect(view.child.calls).toBe(1);
	});

	it("a record without a binding reference stays unpriced even when the parent model is priced (no fallback)", () => {
		const entries: SessionEntry[] = [
			assistantEntry("a1", null, 1_000_000, 0, { modelReference: "known/model-a" }),
			taskResultEntry(
				"t1",
				"a1",
				taskRecord({ inputTokens: 700_000, outputTokens: 0 }, { binding: undefined }),
			),
		];
		const priced = priceUsageTotals(usageTotalsTracker(entries).view(), (reference) =>
			reference === "known/model-a" ? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } : undefined,
		);
		expect(priced.usd).toBeCloseTo(1, 10); // parent only — the child is NOT repriced at the parent's rates
		expect(priced.unpriced.inputTokens).toBe(700_000);
	});

	it("a child that compacted contributes its task+summarizer totals exactly once (acceptance case)", () => {
		// TaskRecord.usage is the attempt-ledger total: task 150/12 + summarizer 10/5.
		const entries: SessionEntry[] = [
			taskResultEntry("t1", null, taskRecord({ inputTokens: 160, outputTokens: 17 })),
			// and a main-session compaction is a separate summarizer fact
			compactionEntry("c1", "t1", { inputTokens: 4, outputTokens: 2 }, "test-sum"),
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.child).toEqual({
			inputTokens: 160,
			outputTokens: 17,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			calls: 1,
		});
		expect(view.summarizer.inputTokens).toBe(4); // never double-counted through the child
		expect(view.total.inputTokens).toBe(164);
	});

	it("money-segment matrix (design §4.5)", () => {
		const seg = (a: Partial<Parameters<typeof usageMoneySegment>[0]>) =>
			usageMoneySegment({ usd: 0, subscription: false, unpricedTokens: 0, incomplete: false, ...a });
		expect(seg({})).toBeNull();
		expect(seg({ usd: 0.1234 })).toBe("$0.123");
		expect(seg({ usd: 0.1234, unpricedTokens: 5 })).toBe("~$0.123");
		expect(seg({ usd: 0.1234, incomplete: true })).toBe("$0.123!");
		expect(seg({ usd: 0.1234, unpricedTokens: 5, incomplete: true })).toBe("~$0.123!");
		expect(seg({ subscription: true })).toBe("$0.000 (sub)");
		expect(seg({ unpricedTokens: 5 })).toBe("$?");
		expect(seg({ unpricedTokens: 5, incomplete: true })).toBe("$?!");
		expect(seg({ incomplete: true })).toBe("$?!");
	});
});
