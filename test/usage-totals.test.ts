import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import type { SessionEntry } from "../src/core/session/store.js";
import { buildTaskRecord, type TaskRecord } from "../src/core/task-record.js";
import { priceUsageTotals, usageTotalsTracker } from "../src/core/usage-totals.js";

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

function taskRecord(usage?: { inputTokens: number; outputTokens: number }): TaskRecord {
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
			results: [{ toolCallId: `t-${id}`, toolName: "task", content: "done", isError: false, taskRecord: record }],
		},
	};
}

function compactionEntry(
	id: string,
	parentId: string | null,
	usage?: { inputTokens: number; outputTokens: number },
	model?: string,
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
	};
}

describe("SA-05 usage totals", () => {
	it("sums parent, child and summarizer usage exactly once (R3 anchor)", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null),
			assistantEntry("a1", "u1", 100, 10, { model: "test-parent" }),
			taskResultEntry("t1", "a1", taskRecord({ inputTokens: 50, outputTokens: 7 })),
			compactionEntry("c1", "t1", { inputTokens: 20, outputTokens: 5 }, "test-sum"),
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.parent).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
		expect(view.child).toEqual({ inputTokens: 50, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
		expect(view.summarizer).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
		expect(view.total.inputTokens).toBe(170);
		expect(view.total.outputTokens).toBe(22);
		expect(view.incomplete).toEqual({ parent: false, child: false, summarizer: false });
	});

	it("counts entries on abandoned branches and stays idempotent under repeated views", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null),
			assistantEntry("a1", "u1", 10, 1, { model: "test-parent" }),
			// abandoned branch: a sibling assistant carried different leaf history
			assistantEntry("a2", "u1", 20, 2, { model: "test-parent" }),
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
			assistantEntry("a1", null, 1_000_000, 0, { model: "known/model-a" }),
			assistantEntry("a2", "a1", 1_000_000, 0), // legacy: no model stamp
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
});
