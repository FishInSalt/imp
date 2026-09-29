import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { SessionEntry } from "../src/core/session/store.js";
import {
	buildTaskRecord,
	collectTaskRecords,
	parseTaskRecord,
	TASK_RECORD_VERSION,
	type TaskRecordInput,
} from "../src/core/task-record.js";

function input(overrides: Partial<TaskRecordInput> = {}): TaskRecordInput {
	return {
		attemptId: "attempt-1",
		sourceId: "source-1",
		launched: true,
		cwd: "/work",
		status: "completed",
		turns: 2,
		textPresent: true,
		...overrides,
	};
}

function taskResultMessage(record: unknown): AgentMessage {
	return {
		role: "toolResult",
		results: [
			{
				toolCallId: "call-1",
				toolName: "task",
				content: "done",
				isError: false,
				taskRecord: record,
			} as never,
		],
	};
}

function messageEntry(record: unknown, id = "e1", parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-27T00:00:00.000Z",
		message: taskResultMessage(record),
	};
}

function compactionEntry(retainedTail: AgentMessage[]): SessionEntry {
	return {
		type: "compaction",
		id: "comp-1",
		parentId: null,
		timestamp: "2026-09-27T00:00:01.000Z",
		summary: "summary",
		retainedTail,
		tokensBefore: 10,
	};
}

describe("buildTaskRecord (SA-03)", () => {
	it("stamps the version and timestamp; omits absent optional fields", () => {
		const record = buildTaskRecord(input());
		expect(record.version).toBe(TASK_RECORD_VERSION);
		expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
		// T24: the exact field set — every field maps an input; no prose, no extras.
		expect(Object.keys(record).sort()).toEqual([
			"attemptId",
			"cwd",
			"launched",
			"sourceId",
			"status",
			"textPresent",
			"timestamp",
			"turns",
			"version",
		]);
	});

	it("copies structured inputs (no aliasing)", () => {
		const binding = { providerName: "anthropic" as const, wireModelId: "m", reference: "anthropic/m" };
		const tools = ["read", "grep"];
		const worktree = { path: "/wt", branch: "b", disposition: "kept-work" as const, detail: "d" };
		const usage = { inputTokens: 1, outputTokens: 2 };
		const record = buildTaskRecord(input({ binding, tools, worktree, usage }));
		tools.push("bash");
		binding.reference = "changed";
		worktree.detail = "changed";
		usage.inputTokens = 99;
		expect(record.tools).toEqual(["read", "grep"]);
		expect(record.binding?.reference).toBe("anthropic/m");
		expect(record.worktree?.detail).toBe("d");
		expect(record.usage?.inputTokens).toBe(1);
	});

	it("SA-08/F3-a: a binding whose reference does not derive from provider/wire id is refused", () => {
		const record = buildTaskRecord(
			input({
				binding: { providerName: "openai", wireModelId: "actual", reference: "anthropic/different" },
				usage: { inputTokens: 9, outputTokens: 4 },
			}),
		);
		expect(parseTaskRecord(JSON.parse(JSON.stringify(record)))).toBeNull();
	});

	it("bounds reason and worktree.detail at 300 code points (CJK/surrogate safe)", () => {
		const han = "汉".repeat(400);
		const emoji = "😀".repeat(400);
		expect(buildTaskRecord(input({ reason: han })).reason).toBe(`${"汉".repeat(300)}…`);
		expect(buildTaskRecord(input({ reason: emoji })).reason).toBe(`${"😀".repeat(300)}…`);
		expect(
			buildTaskRecord(
				input({ worktree: { path: "/wt", branch: "b", disposition: "kept-unknown", detail: han } }),
			).worktree?.detail,
		).toBe(`${"汉".repeat(300)}…`);
		expect(buildTaskRecord(input({ reason: "boom" })).reason).toBe("boom");
	});

	it("rejection shape: launched false, rejected, zero turns, no child references", () => {
		const record = buildTaskRecord(
			input({ launched: false, status: "rejected", reason: "unknown agent", turns: 0, textPresent: false }),
		);
		expect(record.launched).toBe(false);
		expect(record.status).toBe("rejected");
		expect(record.childId).toBeUndefined();
		expect(record.transcript).toBeUndefined();
		expect(record.usage).toBeUndefined();
	});
});

describe("collectTaskRecords (SA-03)", () => {
	it("returns records oldest-first and ignores results without a record", () => {
		const a = buildTaskRecord(input({ attemptId: "a" }));
		const b = buildTaskRecord(input({ attemptId: "b" }));
		const plain: AgentMessage = {
			role: "toolResult",
			results: [{ toolCallId: "c9", toolName: "bash", content: "ok", isError: false }],
		};
		const plainEntry: SessionEntry = {
			type: "message",
			id: "e9",
			parentId: null,
			timestamp: "2026-09-27T00:00:02.000Z",
			message: plain,
		};
		const userEntry: SessionEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-09-27T00:00:03.000Z",
			message: { role: "user", content: "hi" },
		};
		expect(
			collectTaskRecords([messageEntry(a, "e1"), plainEntry, userEntry, messageEntry(b, "e2")]).map(
				(r) => r.attemptId,
			),
		).toEqual(["a", "b"]);
	});

	it("dedupes by attemptId (hand-copied entries)", () => {
		const record = buildTaskRecord(input());
		const entries = [messageEntry(record, "e1"), messageEntry({ ...record }, "e2", "e1")];
		expect(collectTaskRecords(entries)).toHaveLength(1);
	});

	it("does not scan compaction retainedTail copies", () => {
		const record = buildTaskRecord(input());
		// A retained copy alone is invisible — message entries are the source.
		expect(collectTaskRecords([compactionEntry([taskResultMessage(record)])])).toHaveLength(0);
		// The original entry plus a retained copy still yields exactly one.
		expect(
			collectTaskRecords([messageEntry(record), compactionEntry([taskResultMessage(record)])]),
		).toHaveLength(1);
	});

	it("skips malformed and unknown-version records — unknown stays unknown", () => {
		const good = buildTaskRecord(input({ attemptId: "good" }));
		const bad: unknown[] = [
			null,
			"record",
			{ ...good, version: 2 },
			{ ...good, attemptId: "" },
			{ ...good, status: "maybe" },
			{ ...good, turns: "2" },
			{ ...good, cwd: 7 },
			{ ...good, launched: "yes" },
			{ ...good, transcript: { present: true } },
			{ ...good, worktree: { path: "/wt", branch: "b", disposition: "gone" } },
			{ ...good, usage: { inputTokens: "1", outputTokens: 2 } },
			{ ...good, binding: { providerName: 1 } },
			{ ...good, tools: [1, 2] },
		];
		expect(collectTaskRecords(bad.map((r, i) => messageEntry(r, `x${i}`)))).toHaveLength(0);
		expect(
			collectTaskRecords([messageEntry(good), ...bad.map((r, i) => messageEntry(r, `y${i}`))]),
		).toHaveLength(1);
	});

	it("accepts the no-content transcript variant (an unpersisted store without an observed failure)", () => {
		const record = buildTaskRecord(input({ transcript: { present: false, why: "no-content" } }));
		expect(collectTaskRecords([messageEntry(record)])).toHaveLength(1);
	});

	it("ignores child text that looks like a record (content is never a source)", () => {
		const spoof: AgentMessage = {
			role: "toolResult",
			results: [
				{
					toolCallId: "c1",
					toolName: "task",
					content: JSON.stringify({ taskRecord: { attemptId: "evil" } }),
					isError: false,
				},
			],
		};
		const entry: SessionEntry = {
			type: "message",
			id: "s1",
			parentId: null,
			timestamp: "2026-09-27T00:00:04.000Z",
			message: spoof,
		};
		expect(collectTaskRecords([entry])).toHaveLength(0);
	});
});
