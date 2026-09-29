import { formatTokens } from "../format.js";
import { modelMaxTokensFor } from "../provider/catalog.js";
import { compactionSettingsFor } from "../provider/compaction-settings.js";
import type { LLMProvider } from "../provider/types.js";
import {
	type CompactHistoryResult,
	type CompactionSettings,
	type CompactResult,
	compactHistory,
	compactSession,
	estimateContextTokens,
	isContextOverflowError,
	overflowGuidance,
	shouldCompact,
} from "./compaction.js";
import { createLoopHealth, type HealthSignal, healthEnabled } from "./health.js";
import { type RunAgentLoopOptions, type RunAgentLoopResult, runAgentLoop } from "./loop.js";
import type { AgentMessage, Usage } from "./messages.js";
import { type SessionStore, summaryToMessage } from "./session/store.js";
import type { Tool } from "./tools/types.js";
import { attemptUsageSnapshot, createAttemptUsage } from "./usage-ledger.js";

/**
 * Subagent engine (M5 design §4): a child agent loop with fresh context,
 * nested in-process. The task tool (tools/task.ts) owns session persistence
 * and the §3 result contract; this module only runs the child and classify
 * its outcome.
 */

/** Appended to the parent's system prompt. Reusing the parent's assembled
 * prompt keeps AGENTS.md/extension awareness in children; the suffix states
 * the one-shot contract — and that the child does NOT have the task tool,
 * even though the parent's §Tools list (which it inherits) advertises it. */
export const CHILD_SUFFIX = `

# Subagent mode
You are a one-shot subagent: your final message is returned verbatim to the
calling agent. Finish the task and answer — do not ask questions. You do not
have the task tool; complete the job yourself.`;

export interface SubagentOptions {
	provider: LLMProvider;
	model: string;
	/** Canonical `provider/modelId` metadata reference — every metadata lookup
	 *  (compaction settings, summarizer output cap) uses it; does not change
	 *  wire routing (SA-02). The task tool always passes it; absent → the wire
	 *  model is used as the reference (older callers unchanged). */
	modelReference?: string;
	/** The parent's assembled system prompt (AGENTS.md + extension contexts ride along). */
	system: string;
	/** The parent's tool pool — the caller filters out the task tool itself. */
	tools: Tool[];
	/** Self-contained task; becomes the child's first (and only) user message. */
	prompt: string;
	/** Agent profile body (M5c): appended AFTER CHILD_SUFFIX — append-only mode. */
	extraSystem?: string;
	signal?: AbortSignal;
	/** Wall-clock budget (#subagent-softlanding rev 4). undefined = unlimited
	 *  (the REPL default — see defaultChildTimeoutMs). The caller resolves
	 *  args.timeoutMs > agent frontmatter > mode default; injectable for tests. */
	timeoutMs?: number;
	/** M15: the parent's resolved auto-compaction decision (env > project
	 *  settings > global settings > on). The child honors the parent's
	 *  environment exactly; undefined falls back to the env-only gate. */
	autoCompact?: boolean;
	/** Fires for every child message (the task tool persists its transcript). */
	onMessage?: (message: AgentMessage) => void;
	/** The child's session store (the task tool's children/ file). When set,
	 *  between-turn auto-compaction appends a compaction entry to it and splices
	 *  the live history from buildContext — mirroring runner.compactAndSplice.
	 *  The caller owns persistence wiring: onMessage must append to this store
	 *  (the task tool does), or the splice would rebuild from a stale file. */
	session?: SessionStore;
	/** Compaction settings (model-aware by default; explicit settings win).
	 *  Gates the between-turn
	 *  auto-compaction hook only — never the child's own LLM calls. */
	settings?: CompactionSettings;
	/** SA-07: resumed children seed the live context with their effective
	 *  history (summary + retained tail). The new instruction is pushed once
	 *  by the loop as usual and persisted via onMessage. */
	initialHistory?: AgentMessage[];
	/** SA-07: estimate floor for the seeded history (the store's
	 *  compactionBoundary) — mirrors the post-splice floor child compaction
	 *  sets. Pair with initialHistory. */
	initialFloor?: number;
	/** The parent's permission gate, forwarded to the child loop (M6a): a
	 * blocked call returns an isError tool result to the child, same semantics
	 * as the main loop. Concurrent children may interleave gate invocations —
	 * handlers must stay stateless per call. */
	onToolCall?: RunAgentLoopOptions["onToolCall"];
	/** Observes the child's tool events (M6a audit): tool_start/tool_end fire
	 * here exactly as in the main loop; the caller decides what reaches
	 * extensions (rendering stays excluded by the M5 decision). */
	onEvent?: RunAgentLoopOptions["onEvent"];
}

export type SubagentStatus =
	| "completed" // final assistant message carried text or not — text tells
	| "max_iterations" // legacy: hit an explicit turn cap; #loop-health removed the child wall
	| "aborted" // parent signal aborted (user Ctrl+C)
	| "timeout" // the child's own clock fired; parent signal still live
	| "crash"; // provider/protocol error; partial recovery applies

/** SA-04: the attempt's usage split — engine-level facts for tests and
 *  SA-05. Never persisted as such: the SA-03 record carries the totals +
 *  `incomplete` (shape frozen). */
export interface SubagentUsageDetail {
	/** Reports of task-assistant responses (the child loop). */
	task: Usage;
	/** Reports of summarizer calls (history compaction). */
	summarizer: Usage;
	/** Summarizer provider streams started (reported or not). */
	summarizerCalls: number;
	/** A started stream produced no captured usage report. */
	incomplete: boolean;
}

export interface SubagentOutcome {
	status: SubagentStatus;
	/** Last assistant text (backward scan); undefined when the child said nothing. */
	text: string | undefined;
	/** Crash reason (status === "crash" only). */
	reason?: string;
	turns: number;
	/** Attempt totals: task + summarizer reports received (SA-04). */
	usage: Usage;
	/** SA-04 split (see SubagentUsageDetail). */
	usageDetail: SubagentUsageDetail;
	/** #loop-health: detection facts for this attempt (possibly empty). */
	health: readonly HealthSignal[];
}

/**
 * The child's last assistant text: scan messages backward, and within a
 * message take its first non-empty text block (pi's getFinalOutput shape).
 * A text-less final message falls back to earlier assistant messages.
 */
export function finalAssistantText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		for (const block of message.blocks) {
			if (block.type === "text" && block.text.trim() !== "") return block.text;
		}
	}
	return undefined;
}

/** SA-02 D4: the model-metadata decisions for one child run — both the
 *  compaction settings and the summarizer output-token cap key off the SAME
 *  canonical reference, so a bare wire id can never select another family
 *  (the pre-SA-02 `modelMaxTokensFor(options.model)` defect). Exported for
 *  direct unit testing of acceptance item 6. */
export function childModelMetadata(options: Pick<SubagentOptions, "model" | "modelReference" | "settings">): {
	reference: string;
	settings: CompactionSettings;
	modelMaxTokens: number | undefined;
} {
	const reference = options.modelReference ?? options.model;
	return {
		reference,
		settings: options.settings ?? compactionSettingsFor(reference),
		modelMaxTokens: modelMaxTokensFor(reference),
	};
}

export async function runSubagent(options: SubagentOptions): Promise<SubagentOutcome> {
	// #subagent-softlanding rev 4: no implicit clock. `undefined` (the REPL
	// default) means unlimited — see defaultChildTimeoutMs. The caller resolves
	// the precedence chain (args.timeoutMs > agent frontmatter > mode default);
	// this module only honors the resolved value.
	const timeoutMs = options.timeoutMs;
	// SA-07: a resumed child starts from its effective history (the caller
	// passes exactly what the store's buildContext rebuilt); a fresh child
	// starts empty and the loop pushes its single instruction below.
	const history: AgentMessage[] = options.initialHistory ? [...options.initialHistory] : [];
	// SA-07 (acceptance round 2, finding 3): result extraction is scoped to
	// THIS attempt. Seeded messages are tracked by identity so a session
	// splice (compaction rebuilds the array from buildContext) can neither
	// leak the previous attempt's answer as "partial text" nor hide the
	// current attempt's messages.
	const seeded =
		options.initialHistory === undefined ? undefined : new Set<AgentMessage>(options.initialHistory);
	// SA-04 (design §3.3): one exactly-once attempt ledger. Created here, fed by
	// the two provider-stream seams (task loop + summarizer), snapshotted into
	// the outcome. Replaces the history-recomputation compensation — a replayed
	// history (SA-06/07) can never leak into this attempt's delta.
	const ledger = createAttemptUsage();
	// #loop-health (design §4.1): one observation-only monitor per attempt,
	// created BEFORE the compaction closure below so its `note()` can fire
	// early; the overflow retry shares it; disposed in the outer finally.
	const health = healthEnabled()
		? createLoopHealth({ emit: (signal) => options.onEvent?.({ type: "health", signal }) })
		: undefined;
	// SA-02 D4: settings AND the summarizer output cap come from the SAME
	// canonical reference — one lookup helper, consumed below.
	const { settings, modelMaxTokens } = childModelMetadata(options);
	// SA-05 round 2 (§11.2 R1): the child's persisted pricing identity — the
	// caller's DECLARED reference (task.ts always supplies the binding's
	// qualified form). Absent → no stamp: the bare wire id is never persisted
	// as if it were a priced identity (delta review F2).
	const childReference = options.modelReference;

	// Between-turn auto-compaction, mirroring the main loop's onBeforeTurn hook
	// (runner.runTurnInner): estimate -> shouldCompact -> compact -> splice.
	// IMP_AUTOCOMPACT=0 disables it exactly like the main loop. Compaction does
	// NOT reset the loop's turn counter — it buys context room, not extra
	// turns. (Overflow recovery below is the deliberate exception: it is a
	// SECOND runAgentLoop call, so its loop counter starts fresh — #loop-health
	// removed the child turn wall, so neither counter is bounded; the monitor's
	// counts span both launches.)
	const autoCompact = options.autoCompact ?? process.env.IMP_AUTOCOMPACT !== "0";
	// Summarizer-failure backstop: after 3 consecutive failures compaction is
	// disabled for the rest of the run (one stderr note) — a persistent auth
	// failure must not buy 40 silent paid retry calls.
	let consecutiveFailures = 0;
	// #compaction-ux F1: the child's local estimate floor — set when the
	// child history is spliced by compaction, so the next boundary's
	// shouldCompact check reads the new shape, not a stale pre-compaction
	// anchor (main-loop estimateFloor parity; the child has no store). SA-07:
	// a seeded (compacted) history starts at its own boundary.
	let childFloor = options.initialFloor ?? 0;
	let compactionDisabled = false;
	const onBeforeTurn: RunAgentLoopOptions["onBeforeTurn"] | undefined = autoCompact
		? async (history) => {
				if (compactionDisabled) return;
				const est = estimateContextTokens(history, childFloor);
				if (!shouldCompact(est.tokens, settings)) return;
				await compactChildHistory(history);
			}
		: undefined;

	/** Compact the child's history in place (details inline per branch). A
	 *  summarizer LLM call failing must not kill the child: the main loop's turn
	 *  throws there but its host (the REPL) catches it and the next turn retries
	 *  — a child has no outer host, so the equivalent contract (run survives,
	 *  un-compacted history, retry at the next turn boundary if still over
	 *  threshold) is provided by catching here.
	 *
	 *  Returns {compacted, error?}: the overflow-recovery seam (below) needs
	 *  both signals — "did not move, do not retry" and the failure cause for
	 *  the guidance text. The onBeforeTurn caller ignores the result. */
	async function compactChildHistory(
		history: AgentMessage[],
	): Promise<{ compacted: boolean; error?: string }> {
		try {
			// The child's signal IS forwarded (unlike the runner's /compact, which
			// deliberately waits): children may carry a caller-set wall clock,
			// and persistence only happens after a fully streamed summary — an
			// aborted stream throws here, is caught below, and nothing is persisted.
			let compacted: CompactHistoryResult | CompactResult | null;
			if (options.session) {
				// Session path = runner.compactAndSplice verbatim: the compaction
				// entry lands in the store, then the live history is rebuilt from
				// buildContext ([framed summary, ...retainedTail]).
				compacted = await compactSession({
					session: options.session,
					provider: options.provider,
					model: options.model,
					...(childReference !== undefined && { modelReference: childReference }),
					signal: child.signal,
					settings,
					modelMaxTokens, // #derived-budget (SA-02 D4: canonical reference)
					usageLedger: ledger, // SA-04: every summarizer stream lands here
				});
				if (compacted) {
					history.splice(0, history.length, ...options.session.buildContext().messages);
					childFloor = options.session.buildContext().compactionBoundary;
				}
			} else {
				// No session (sessions disabled): pure computation + in-place splice.
				// The framed summary keeps the replayed context identical to what a
				// session store would rebuild (summaryToMessage, SUMMARY_MARK framed).
				compacted = await compactHistory({
					messages: history,
					provider: options.provider,
					model: options.model,
					signal: child.signal,
					settings,
					modelMaxTokens, // #derived-budget (SA-02 D4: canonical reference)
					usageLedger: ledger, // SA-04: every summarizer stream lands here
				});
				if (compacted) {
					history.splice(0, history.length, summaryToMessage(compacted.summary), ...compacted.retainedTail);
					childFloor = 1 + compacted.retainedTail.length; // same shape as the store's boundary
				}
			}
			if (compacted) {
				consecutiveFailures = 0;
				// SA-04: no splice compensation needed — the ledger counted each
				// report at production; the entry's `usage` stays checkpoint data.
				return { compacted: true };
			}
			return { compacted: false }; // keepRecent swallowed everything (cut <= 0)
		} catch (err) {
			// Keep the un-compacted history and continue; the next turn boundary
			// retries if the estimate is still over the threshold (#loop-health:
			// no turn bound remains — three consecutive failures disable it for
			// the run, and the fact is reported through the health monitor).
			// Abort-during-summarizer also lands here (the signal is forwarded) —
			// the recovery seam re-checks child.signal.aborted, onBeforeTurn
			// simply retries next boundary.
			consecutiveFailures += 1;
			if (consecutiveFailures >= 3) {
				compactionDisabled = true;
				health?.note("compaction-failures", 3, "3 consecutive summarizer failures");
				process.stderr.write(
					"imp: child compaction failed 3 times in a row — giving up for this task; the run continues un-compacted\n",
				);
			}
			return { compacted: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	// Composite abort: parent signal OR the child's own clock. A manual relay
	// (not AbortSignal.any) keeps engines ">=20" exactly true — any() needs
	// 20.3. Timeout is detectable afterwards: the clock fired, the parent
	// signal did not. #subagent-softlanding rev 4: the clock exists ONLY when
	// timeoutMs is set (REPL default = no clock; every timedOut classification
	// below reads `clock?.aborted ?? false`, so 'timeout' is unreachable on the
	// default path — a clock-less abort is always the parent signal/Ctrl+C).
	const clock = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
	const child = new AbortController();
	const relay = () => child.abort();
	// An ALREADY-aborted signal never fires "abort" again — attach the
	// listener only when live, else relay immediately (a parent signal aborted
	// during worktree setup used to deadlock the child forever).
	if (options.signal?.aborted) child.abort();
	else options.signal?.addEventListener("abort", relay);
	if (clock?.aborted) child.abort();
	else clock?.addEventListener("abort", relay);

	/** The child's one launch seam: userMessage is undefined on the overflow
	 *  retry — the failed attempt already left the prompt in history (the loop
	 *  only appends non-empty prompts, loop.ts:112), a re-pass would duplicate
	 *  it. Same shape as the main loop's retry (runner.ts:772). */
	const launchLoop = (userMessage: string | undefined): Promise<RunAgentLoopResult> =>
		runAgentLoop({
			provider: options.provider,
			model: options.model,
			...(childReference !== undefined && { modelReference: childReference }),
			system:
				options.system +
				CHILD_SUFFIX +
				(options.extraSystem ? `\n\n# Agent profile\n\n${options.extraSystem}` : ""),
			tools: options.tools,
			history,
			userMessage,
			// #loop-health: children are uncapped (owner decision A). Explicit
			// Infinity is load-bearing — the loop's default floor is 100.
			maxIterations: Number.POSITIVE_INFINITY,
			onMessage: options.onMessage,
			onToolCall: options.onToolCall,
			// #loop-health: the monitor observes the same stream the caller
			// relays; both overflow launches share it.
			onEvent: (event) => {
				health?.observe(event);
				options.onEvent?.(event);
			},
			onBeforeTurn,
			signal: child.signal,
			usageLedger: ledger, // SA-04: every task report lands here
		});

	/** SA-04 (design §3.3): every path settles from the attempt ledger — reports
	 *  are counted at production, so splices, aborts and crashes are facts, not
	 *  recomputations. `turns` stays the task-turn count (reports observed). */
	const settled = (status: SubagentStatus, reason?: string): SubagentOutcome => {
		const snapshot = attemptUsageSnapshot(ledger);
		// Attempt-scoped text: never fall back into restored history. A resumed
		// attempt with no text of its own settles with text === undefined.
		const attemptMessages =
			seeded === undefined ? history : history.filter((message) => !seeded.has(message));
		return {
			status,
			...(reason !== undefined ? { reason } : {}),
			text: finalAssistantText(attemptMessages),
			turns: snapshot.taskReports,
			usage: snapshot.totals,
			usageDetail: {
				task: snapshot.task,
				summarizer: snapshot.summarizer,
				summarizerCalls: snapshot.summarizerCalls,
				incomplete: snapshot.incomplete,
			},
			health: health?.signals() ?? [],
		};
	};

	try {
		const result = await launchLoop(options.prompt);
		if (result.stopReason === "aborted") {
			const timedOut = clock !== undefined && !(options.signal?.aborted ?? false) && clock.aborted;
			return settled(timedOut ? "timeout" : "aborted");
		}
		return settled(result.stopReason);
	} catch (err) {
		const crashWith = (reason: string): SubagentOutcome => settled("crash", reason);
		const rawMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

		// #overflow-recovery (child): a live context-overflow error gets ONE
		// compact-and-retry — the main loop's runTurnOrRecoverFromOverflow
		// mirrored onto the child, minus its session-only compactAndSplice
		// (compactChildHistory works in both modes). Single attempt, like pi's
		// _overflowRecoveryAttempted and the main loop.
		if (!isContextOverflowError(err)) {
			// Provider/protocol error: partial recovery — whatever the child already
			// said survives (§3); the task tool decides error vs partial-result.
			return crashWith(rawMessage(err));
		}
		const guidanceTokens = () => estimateContextTokens(history).tokens;
		if (compactionDisabled) {
			return crashWith(
				overflowGuidance(guidanceTokens(), settings, "compaction disabled after repeated failures"),
			);
		}
		const { compacted, error } = await compactChildHistory(history);
		if (!compacted) {
			// Review P1-1: an abort/timeout during the compact window is swallowed
			// by compactChildHistory's internal catch (it only returns false) —
			// re-detect it here so the clock is not misreported as a crash.
			if (child.signal.aborted) {
				const timedOut = clock !== undefined && !(options.signal?.aborted ?? false) && clock.aborted;
				return settled(timedOut ? "timeout" : "aborted");
			}
			return crashWith(overflowGuidance(guidanceTokens(), settings, error ?? "nothing safe to compact"));
		}
		try {
			const result = await launchLoop(undefined);
			if (result.stopReason === "aborted") {
				const timedOut = clock !== undefined && !(options.signal?.aborted ?? false) && clock.aborted;
				return settled(timedOut ? "timeout" : "aborted");
			}
			// SA-04: both rounds' reports were counted at production.
			return settled(result.stopReason);
		} catch (retryErr) {
			// Review P1-2: a NON-overflow retry failure (401/500/network) keeps its
			// raw message — never mislabeled as overflow (runner.ts:775 parity).
			if (!isContextOverflowError(retryErr)) return crashWith(rawMessage(retryErr));
			return crashWith(
				overflowGuidance(guidanceTokens(), settings, "still over the window after one compaction"),
			);
		}
	} finally {
		options.signal?.removeEventListener("abort", relay);
		clock?.removeEventListener("abort", relay);
		health?.dispose();
	}
}

/** Budget trailer for task results (design §3): `(child: 7 turns, 12k in / 1.4k out / 9.8k cache)`.
 *  An absent/zero cache read omits the segment — never "/ 0 cache". */
export function childUsageTrailer(turns: number, usage: Usage): string {
	const cache = usage.cacheReadTokens ?? 0;
	const cacheSegment = cache > 0 ? ` / ${formatTokens(cache)} cache` : "";
	return `(child: ${turns} turns, ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out${cacheSegment})`;
}
