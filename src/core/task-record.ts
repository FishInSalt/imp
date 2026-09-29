import { type ChildModelBinding, isModelBinding } from "./child-model.js";
import type { SessionEntry } from "./session/store.js";

/**
 * SA-03 design (docs/sa-03-task-record-design.md): the runtime-produced
 * account of ONE task-tool call — identity, launch facts, terminal outcome,
 * transcript/worktree references and the usage slot.
 *
 * Transport (owner-approved): the record is an optional field on the task
 * tool's result (`ToolExecuteResult.taskRecord` → `ToolResult.taskRecord`) and
 * is therefore PERSISTED with the message in the parent session JSONL. It is
 * program-visible and never model-visible: provider converters construct wire
 * objects field-by-field and must never read this field. `display` is the
 * opposite lifecycle (event-only, stripped before history).
 *
 * Read path: `collectTaskRecords` over RAW session entries
 * (`getEntries()`/`getBranch()`), never `buildContext()` — the session file is
 * append-only, so a compacted-away message entry still exists even when the
 * rebuilt context no longer contains it. Compaction `retainedTail` copies hold
 * `AgentMessage[]`, not entries, and are deliberately not scanned; dedupe by
 * `attemptId` is a defensive measure (hand-copied files, future readers).
 */

export const TASK_RECORD_VERSION = 1;

export type TaskRecordStatus =
	| "completed" // the child loop ended normally — NOT verified task success
	| "max_iterations" // hit CHILD_MAX_TURNS; text (if any) is a wrap-up answer
	| "aborted" // parent signal (Ctrl+C)
	| "timeout" // the child's own clock fired
	| "crash" // provider/protocol error; partial text may exist
	| "rejected"; // pre-launch rejection — nothing ran

/** Whether a transcript really exists — the facts only; resumability is a
 *  later, validated decision (SA-06), never inferred from this field.
 *  `write-failed`: a write was observed to fail and nothing persisted.
 *  `no-content`: nothing was persisted, and no write was observed to fail
 *  (e.g. an attempt that produced no writes at all). */
export type TaskRecordTranscript =
	| { present: true; path: string; writeFailed?: true }
	| { present: false; why: "disabled" | "no-parent-session" | "write-failed" | "no-content" };

/** SA-01's layered honesty in structured form: never claims a cleanup that did
 *  not happen. */
export interface TaskRecordWorktree {
	path: string;
	branch: string;
	disposition: "removed" | "kept-work" | "kept-unknown" | "removal-failed";
	/** Bounded summary of the assessment/errors. */
	detail?: string;
}

export interface TaskRecordUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** SA-04 reserves this flag for "a usage report is known to be missing".
	 *  SA-03 records runtime values and never sets it. */
	incomplete?: true;
}

/** The terminal facts, always supplied explicitly by the return path. */
export interface TaskRecordTerminal {
	status: TaskRecordStatus;
	/** Bounded human-readable crash/rejection summary (no machine taxonomy). */
	reason?: string;
	turns: number;
	textPresent: boolean;
	usage?: TaskRecordUsage;
}

export interface TaskRecordInput extends TaskRecordTerminal {
	/** Parent tool-call id — absent only for direct (non-loop) callers. */
	taskToolCallId?: string;
	/** Fresh UUID per execute — the record's unique key. */
	attemptId: string;
	/** Invocation observer identity (same value on relayed events). */
	sourceId: string;
	/** Parent session header id, when a parent store exists. */
	parentSessionId?: string;
	/** Logical child id = child session UUID (launched + session created). */
	childId?: string;
	/** false = rejected before the child loop ran. */
	launched: boolean;
	agent?: string;
	binding?: ChildModelBinding;
	/** Execution cwd — the worktree path when isolation was active. */
	cwd: string;
	/** Final child tool names. */
	tools?: string[];
	/** Resolved wall-clock budget; absent = no clock. */
	timeoutMs?: number;
	transcript?: TaskRecordTranscript;
	worktree?: TaskRecordWorktree;
}

export interface TaskRecord extends TaskRecordInput {
	version: 1;
	timestamp: string;
}

/** reason / worktree.detail bound: code points, CJK-safe. */
const MAX_DETAIL_CHARS = 300;

function bound(text: string, max = MAX_DETAIL_CHARS): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** Assemble a record from explicit inputs — stamps version + timestamp and
 *  bounds the free-text fields. No prose input exists by construction: every
 *  field comes from a runtime object. Optional fields are omitted (not set to
 *  undefined) when absent. */
export function buildTaskRecord(input: TaskRecordInput): TaskRecord {
	const record: TaskRecord = {
		version: TASK_RECORD_VERSION,
		timestamp: new Date().toISOString(),
		attemptId: input.attemptId,
		sourceId: input.sourceId,
		launched: input.launched,
		cwd: input.cwd,
		status: input.status,
		turns: input.turns,
		textPresent: input.textPresent,
	};
	if (input.taskToolCallId !== undefined) record.taskToolCallId = input.taskToolCallId;
	if (input.parentSessionId !== undefined) record.parentSessionId = input.parentSessionId;
	if (input.childId !== undefined) record.childId = input.childId;
	if (input.agent !== undefined) record.agent = input.agent;
	if (input.binding !== undefined) record.binding = { ...input.binding };
	if (input.tools !== undefined) record.tools = [...input.tools];
	if (input.timeoutMs !== undefined) record.timeoutMs = input.timeoutMs;
	if (input.reason !== undefined) record.reason = bound(input.reason);
	if (input.transcript !== undefined) record.transcript = { ...input.transcript };
	if (input.worktree !== undefined) {
		record.worktree =
			input.worktree.detail === undefined
				? { ...input.worktree }
				: { ...input.worktree, detail: bound(input.worktree.detail) };
	}
	if (input.usage !== undefined) record.usage = { ...input.usage };
	return record;
}

/** Collect the task records carried by session entries, oldest first.
 *  Dedupes by `attemptId` (defensive). A record failing any structural check
 *  is SKIPPED — unknown stays unknown; nothing is invented or repaired. */
export function collectTaskRecords(entries: readonly SessionEntry[]): TaskRecord[] {
	const seen = new Set<string>();
	const out: TaskRecord[] = [];
	for (const entry of entries) {
		for (const record of taskRecordsInEntry(entry)) {
			if (seen.has(record.attemptId)) continue;
			seen.add(record.attemptId);
			out.push(record);
		}
	}
	return out;
}

/** The validated records carried by ONE entry, in result order — no dedupe
 *  (the cross-entry `seen` set stays with the caller: `collectTaskRecords`
 *  globally, the SA-05 tracker incrementally). Behavior of
 *  `collectTaskRecords` is unchanged by the extraction. */
export function taskRecordsInEntry(entry: SessionEntry): TaskRecord[] {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const out: TaskRecord[] = [];
	for (const result of entry.message.results) {
		const record = parseTaskRecord((result as { taskRecord?: unknown }).taskRecord);
		if (record !== null) out.push(record);
	}
	return out;
}

const STATUSES: readonly string[] = [
	"completed",
	"max_iterations",
	"aborted",
	"timeout",
	"crash",
	"rejected",
];

function isString(v: unknown): v is string {
	return typeof v === "string";
}

function isOptionalString(v: unknown): boolean {
	return v === undefined || typeof v === "string";
}

function isOptionalFiniteNumber(v: unknown): boolean {
	return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

function isOptionalStringArray(v: unknown): boolean {
	return v === undefined || (Array.isArray(v) && v.every((item) => typeof item === "string"));
}

function isBinding(v: unknown): boolean {
	// SA-08 reopened F-3: same derivation rule as launch records — the three
	// fields drive different subsystems (wire request, pricing metadata,
	// endpoint gate), so a disagreeing triple is never usable for attribution.
	if (v === undefined) return true; // binding is optional on a task record
	return isModelBinding(v);
}

function isTranscript(v: unknown): boolean {
	if (v === undefined) return true;
	if (typeof v !== "object" || v === null) return false;
	const t = v as Record<string, unknown>;
	if (t.present === true) return isString(t.path) && (t.writeFailed === undefined || t.writeFailed === true);
	if (t.present === false)
		return (
			t.why === "disabled" ||
			t.why === "no-parent-session" ||
			t.why === "write-failed" ||
			t.why === "no-content"
		);
	return false;
}

function isWorktree(v: unknown): boolean {
	if (v === undefined) return true;
	if (typeof v !== "object" || v === null) return false;
	const w = v as Record<string, unknown>;
	return (
		isString(w.path) &&
		isString(w.branch) &&
		(w.disposition === "removed" ||
			w.disposition === "kept-work" ||
			w.disposition === "kept-unknown" ||
			w.disposition === "removal-failed") &&
		isOptionalString(w.detail)
	);
}

function isUsage(v: unknown): boolean {
	if (v === undefined) return true;
	if (typeof v !== "object" || v === null) return false;
	const u = v as Record<string, unknown>;
	if (typeof u.inputTokens !== "number" || !Number.isFinite(u.inputTokens)) return false;
	if (typeof u.outputTokens !== "number" || !Number.isFinite(u.outputTokens)) return false;
	if (!isOptionalFiniteNumber(u.cacheReadTokens) || !isOptionalFiniteNumber(u.cacheWriteTokens)) return false;
	return u.incomplete === undefined || u.incomplete === true;
}

export function parseTaskRecord(value: unknown): TaskRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	if (r.version !== TASK_RECORD_VERSION) return null; // greater versions: skipped
	if (!isString(r.attemptId) || r.attemptId === "") return null;
	if (!isString(r.sourceId) || !isString(r.timestamp) || !isString(r.cwd)) return null;
	if (typeof r.launched !== "boolean" || typeof r.textPresent !== "boolean") return null;
	if (typeof r.turns !== "number" || !Number.isFinite(r.turns)) return null;
	if (typeof r.status !== "string" || !STATUSES.includes(r.status)) return null;
	if (
		!isOptionalString(r.taskToolCallId) ||
		!isOptionalString(r.parentSessionId) ||
		!isOptionalString(r.childId) ||
		!isOptionalString(r.agent) ||
		!isOptionalFiniteNumber(r.timeoutMs) ||
		!isOptionalString(r.reason)
	) {
		return null;
	}
	if (!isBinding(r.binding) || !isOptionalStringArray(r.tools)) return null;
	if (!isTranscript(r.transcript) || !isWorktree(r.worktree) || !isUsage(r.usage)) return null;
	return r as unknown as TaskRecord;
}
