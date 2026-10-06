import type { ModelCost } from "../provider/models.js";
import type { SessionEntry } from "./session/store.js";
import { parseTaskRecord } from "./task-record.js";

/**
 * SA-05 (docs/design/sa-05-usage-totals-design.md): the durable work-cost aggregate.
 *
 * A *derived view* over the session's append-only entries — not a ledger of
 * its own. Whole-session scope (every entry, all branches: switching branches
 * must not forget already incurred calls); context metrics stay active-branch
 * and are structurally separate (this module never feeds
 * estimateContextTokens, shouldCompact, or stats()).
 *
 * Exactly-once by construction: `view()` folds entries with a cursor, so a
 * rebuild (fresh tracker over the same entries) and an incremental update
 * (same tracker, appended entries) are the same computation; repeated views
 * without new entries return the cached snapshot. Child usage comes from the
 * managed task records only — child transcripts are never read, so the record
 * and the transcript cannot be double counted.
 *
 * Pricing is injected (`priceUsageTotals`): per-producer reference, current
 * catalog rates; a reference without a rate is *unpriced*, never repriced at
 * another model's rates. Legacy entries (pre-SA-05 stamps) count as reported
 * and are never retroactively flagged (design L1).
 */

export interface UsageBucket {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Contributing calls: assistant messages / task records / summary
	 *  entries (one per persisted summary; retry hops are summed into it). */
	calls: number;
}

export interface ModelUsage {
	/** DECLARED producer identity (`message.modelReference` /
	 *  `record.binding.reference` / summary `entry.modelReference`); null =
	 *  legacy entry without a declared identity — unpriced, never inferred. */
	reference: string | null;
	bucket: UsageBucket;
}

export interface UsageTotals {
	/** Assistant message entries (all branches). */
	parent: UsageBucket;
	/** Task records (all attempts, deduped by attemptId). The child's own
	 *  summarizer usage is inside TaskRecord.usage — counted exactly once. */
	child: UsageBucket;
	/** Main-session compaction + branchSummary entries only; child-session
	 *  compaction entries live in the child file and are unreachable here. */
	summarizer: UsageBucket;
	total: UsageBucket;
	byModel: ModelUsage[];
	incomplete: { parent: boolean; child: boolean; summarizer: boolean };
}

/** Injected rate lookup (bound to `costFor` at display sites; fake tables in
 *  tests). undefined = unknown rate. */
export type RateLookup = (reference: string) => ModelCost | undefined;

export interface PricedModelUsage extends ModelUsage {
	priced: boolean;
	subscription: boolean;
}

export interface PricedUsageTotals {
	/** Known-rate money only ($ per current catalog rates — an estimate, not
	 *  an invoice; see design D4). */
	usd: number;
	/** Any priced usage belongs to a subscription-backed model. */
	subscription: boolean;
	/** Counted usage without a resolvable rate. */
	unpriced: UsageBucket;
	byModel: PricedModelUsage[];
}

export interface UsageTotalsTracker {
	/** Syncs newly appended entries (cursor) and returns the current view.
	 *  Idempotent: repeated calls without new entries return the same value. */
	view(): UsageTotals;
}

function emptyBucket(): UsageBucket {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };
}

function copyBucket(bucket: UsageBucket): UsageBucket {
	return { ...bucket };
}

function addBucket(target: UsageBucket, source: UsageBucket): void {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.calls += source.calls;
}

function addUsage(
	bucket: UsageBucket,
	usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): void {
	bucket.inputTokens += usage.inputTokens;
	bucket.outputTokens += usage.outputTokens;
	bucket.cacheReadTokens += usage.cacheReadTokens ?? 0;
	bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
	bucket.calls += 1;
}

interface MutableState {
	parent: UsageBucket;
	child: UsageBucket;
	summarizer: UsageBucket;
	byModel: Map<string | null, UsageBucket>;
	incomplete: { parent: boolean; child: boolean; summarizer: boolean };
}

function addToModel(
	state: MutableState,
	reference: string | null,
	usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): void {
	let bucket = state.byModel.get(reference);
	if (bucket === undefined) {
		bucket = emptyBucket();
		state.byModel.set(reference, bucket);
	}
	addUsage(bucket, usage);
}

/** One entry → its contribution. See design §4.1 (evidence model). */
function applyEntry(
	state: MutableState,
	seenAttempts: Set<string>,
	seenTaskCalls: Set<string>,
	entry: SessionEntry,
): void {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant") {
			addUsage(state.parent, message.usage);
			if (message.usageMissing === true) state.incomplete.parent = true;
			// SA-05 §11.7: the DECLARED identity field is the only pricing
			// source — the wire `model` is never consulted (a legacy wire id
			// can itself contain '/', so the field, not the string shape,
			// distinguishes an identity). Absent → unpriced.
			addToModel(state, message.modelReference ?? null, message.usage);
		} else if (message.role === "toolResult") {
			for (const result of message.results) {
				const record = parseTaskRecord(result.taskRecord);
				if (record === null) {
					// Rule 2b: a task tool result without a parsable record is a
					// visible incompleteness signal (covers SA-03 no-record paths
					// and the synthetic force-quit closers). Exactly-once by
					// toolCallId: a record-less REPEAT of an already seen call
					// (duplicated/hand-copied entries) adds no new signal — only
					// the first sighting of a call without a record does.
					if (result.toolName === "task" && !seenTaskCalls.has(result.toolCallId)) {
						state.incomplete.child = true;
						seenTaskCalls.add(result.toolCallId);
					}
					continue;
				}
				if (seenAttempts.has(record.attemptId)) continue; // defensive dedupe
				seenAttempts.add(record.attemptId);
				seenTaskCalls.add(result.toolCallId);
				if (record.launched !== true) continue; // no call ran: nothing, not incomplete
				if (record.usage === undefined) {
					state.incomplete.child = true; // launched without a report: unknown work
					continue;
				}
				addUsage(state.child, record.usage);
				if (record.usage.incomplete === true) state.incomplete.child = true;
				addToModel(state, record.binding?.reference ?? null, record.usage);
			}
		}
		return;
	}
	if (entry.type === "compaction" || entry.type === "branchSummary") {
		if (entry.usage === undefined) return; // legacy entry without a report field (L1)
		addUsage(state.summarizer, entry.usage);
		if (entry.usageMissing === true) state.incomplete.summarizer = true;
		// SA-05 §11.7: entries price by their DECLARED identity field only
		// (`model` holds the wire id for debugging; pre-fix entries — either
		// cohort — have no modelReference and price as unknown).
		addToModel(state, entry.modelReference ?? null, entry.usage);
	}
}

function snapshot(state: MutableState): UsageTotals {
	const parent = copyBucket(state.parent);
	const child = copyBucket(state.child);
	const summarizer = copyBucket(state.summarizer);
	const total = emptyBucket();
	addBucket(total, parent);
	addBucket(total, child);
	addBucket(total, summarizer);
	const byModel: ModelUsage[] = [];
	for (const [reference, bucket] of state.byModel) {
		byModel.push({ reference, bucket: copyBucket(bucket) });
	}
	return {
		parent,
		child,
		summarizer,
		total,
		byModel,
		incomplete: { ...state.incomplete },
	};
}

/**
 * Build a tracker over the store's live entry array (`session.getEntries()` —
 * in-memory, append-only). One tracker per session store instance; a fresh
 * tracker over the same entries rebuilds an identical view.
 */
export function usageTotalsTracker(entries: readonly SessionEntry[]): UsageTotalsTracker {
	const state: MutableState = {
		parent: emptyBucket(),
		child: emptyBucket(),
		summarizer: emptyBucket(),
		byModel: new Map(),
		incomplete: { parent: false, child: false, summarizer: false },
	};
	const seenAttempts = new Set<string>();
	const seenTaskCalls = new Set<string>();
	let cursor = 0;
	let lastApplied: SessionEntry | undefined;
	let cached: UsageTotals | null = null;
	const reset = (): void => {
		state.parent = emptyBucket();
		state.child = emptyBucket();
		state.summarizer = emptyBucket();
		state.byModel = new Map();
		state.incomplete = { parent: false, child: false, summarizer: false };
		seenAttempts.clear();
		seenTaskCalls.clear();
		cursor = 0;
		lastApplied = undefined;
		cached = null;
	};
	return {
		view(): UsageTotals {
			// Append-only is the contract; a truncated or mutated array (a change
			// outside the store) rebuilds from scratch instead of serving stale
			// totals. Identity, not length: pop-then-push must not fool it.
			if (cursor > 0 && entries[cursor - 1] !== lastApplied) reset();
			if (cached !== null && cursor >= entries.length) return cached;
			for (; cursor < entries.length; cursor++) {
				const entry = entries[cursor];
				if (entry === undefined) continue;
				applyEntry(state, seenAttempts, seenTaskCalls, entry);
				lastApplied = entry;
			}
			cached = snapshot(state);
			return cached;
		},
	};
}

/** Pure price application: per-reference rates in, priced totals out. */
export function priceUsageTotals(totals: UsageTotals, rateFor: RateLookup): PricedUsageTotals {
	let usd = 0;
	let subscription = false;
	const unpriced = emptyBucket();
	const byModel: PricedModelUsage[] = [];
	for (const model of totals.byModel) {
		const rates = model.reference === null ? undefined : rateFor(model.reference);
		if (rates === undefined) {
			addBucket(unpriced, model.bucket);
			byModel.push({ ...model, priced: false, subscription: false });
			continue;
		}
		const sub = rates.subscription === true;
		if (sub) subscription = true;
		usd +=
			(model.bucket.inputTokens * rates.input +
				model.bucket.outputTokens * rates.output +
				model.bucket.cacheReadTokens * rates.cacheRead +
				model.bucket.cacheWriteTokens * rates.cacheWrite) /
			1_000_000;
		byModel.push({ ...model, priced: true, subscription: sub });
	}
	return { usd, subscription, unpriced, byModel };
}
