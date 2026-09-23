import { formatTokens } from "../format.js";
import { modelMaxTokensFor } from "../provider/catalog.js";
import type { LLMProvider } from "../provider/types.js";
import {
	type CompactHistoryResult,
	type CompactionSettings,
	type CompactResult,
	compactHistory,
	compactSession,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	isContextOverflowError,
	overflowGuidance,
	shouldCompact,
} from "./compaction.js";
import { CHILD_MAX_TURNS, CHILD_TIMEOUT_MS } from "./constants.js";
import { type RunAgentLoopOptions, type RunAgentLoopResult, runAgentLoop } from "./loop.js";
import { type AgentMessage, addUsage, type Usage } from "./messages.js";
import { type SessionStore, summaryToMessage } from "./session/store.js";
import type { Tool } from "./tools/types.js";

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
	/** The parent's assembled system prompt (AGENTS.md + extension contexts ride along). */
	system: string;
	/** The parent's tool pool — the caller filters out the task tool itself. */
	tools: Tool[];
	/** Self-contained task; becomes the child's first (and only) user message. */
	prompt: string;
	/** Agent profile body (M5c): appended AFTER CHILD_SUFFIX — append-only mode. */
	extraSystem?: string;
	signal?: AbortSignal;
	/** Wall-clock budget. Default CHILD_TIMEOUT_MS; injectable for tests. */
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
	/** Compaction settings (runner pattern: DEFAULT_COMPACTION_SETTINGS by
	 *  default, injectable for hermetic tests). Gates the between-turn
	 *  auto-compaction hook only — never the child's own LLM calls. */
	settings?: CompactionSettings;
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
	| "max_iterations" // hit CHILD_MAX_TURNS; text is the best-effort answer
	| "aborted" // parent signal aborted (user Ctrl+C)
	| "timeout" // the child's own clock fired; parent signal still live
	| "crash"; // provider/protocol error; partial recovery applies

export interface SubagentOutcome {
	status: SubagentStatus;
	/** Last assistant text (backward scan); undefined when the child said nothing. */
	text: string | undefined;
	/** Crash reason (status === "crash" only). */
	reason?: string;
	turns: number;
	usage: Usage;
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

/** Componentwise before−after usage delta (clamped at 0) — the cost carried
 *  away by a history splice. Valid because the retained tail is a subset of
 *  the pre-splice messages with identical usage entries. */
function usageDelta(before: Usage, after: Usage): Usage {
	const clamp = (n: number) => Math.max(0, n);
	return {
		inputTokens: clamp(before.inputTokens - after.inputTokens),
		outputTokens: clamp(before.outputTokens - after.outputTokens),
		cacheReadTokens: clamp((before.cacheReadTokens ?? 0) - (after.cacheReadTokens ?? 0)),
		cacheWriteTokens: clamp((before.cacheWriteTokens ?? 0) - (after.cacheWriteTokens ?? 0)),
	};
}

/** usage + carried-away stats as a fresh object (addUsage mutates its target). */
function addUsageIntoNew(base: Usage, extra: Usage): Usage {
	const sum: Usage = {
		...base,
		cacheReadTokens: base.cacheReadTokens ?? 0,
		cacheWriteTokens: base.cacheWriteTokens ?? 0,
	};
	addUsage(sum, extra);
	return sum;
}

function historyStats(messages: AgentMessage[]): { turns: number; usage: Usage } {
	// Recomputable from history — the loop's counters are unreachable when it
	// throws mid-run (crash path), so derive from what actually happened.
	const usage: Usage = { inputTokens: 0, outputTokens: 0 };
	let turns = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		turns++;
		usage.inputTokens += message.usage.inputTokens;
		usage.outputTokens += message.usage.outputTokens;
		usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (message.usage.cacheReadTokens ?? 0);
		usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (message.usage.cacheWriteTokens ?? 0);
	}
	return { turns, usage };
}

export async function runSubagent(options: SubagentOptions): Promise<SubagentOutcome> {
	const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
	const history: AgentMessage[] = [];
	const settings = options.settings ?? DEFAULT_COMPACTION_SETTINGS;

	// Between-turn auto-compaction, mirroring the main loop's onBeforeTurn hook
	// (runner.runTurnInner): estimate -> shouldCompact -> compact -> splice.
	// IMP_AUTOCOMPACT=0 disables it exactly like the main loop. NOTE: compaction
	// does NOT reset the turn budget — CHILD_MAX_TURNS still bounds the child.
	// The loop's turn counter is untouched by the history splice: compaction
	// buys context room, not extra turns. (Overflow recovery below is the
	// deliberate exception: it is a SECOND runAgentLoop call, so its loop
	// counter starts fresh — worst case 2x CHILD_MAX_TURNS, main-loop parity.)
	const autoCompact = options.autoCompact ?? process.env.IMP_AUTOCOMPACT !== "0";
	// Summarizer-failure backstop: after 3 consecutive failures compaction is
	// disabled for the rest of the run (one stderr note) — a persistent auth
	// failure must not buy 40 silent paid retry calls.
	let consecutiveFailures = 0;
	let compactionDisabled = false;
	// #compaction-ux F1: the child's local estimate floor — set when the
	// child history is spliced by compaction, so the next boundary's
	// shouldCompact check reads the new shape, not a stale pre-compaction
	// anchor (main-loop estimateFloor parity; the child has no store).
	let childFloor = 0;
	// Stats carried away by compaction splices: on crash the trailer reports
	// historyStats(history), which only sees the post-splice history — the
	// summarized-away turns/usage are added back through this accumulator so
	// cost accounting stays truthful.
	let summarizedTurns = 0;
	let summarizedAny = false;
	const summarizedUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
			// deliberately waits): children have a wall clock the main loop lacks,
			// and persistence only happens after a fully streamed summary — an
			// aborted stream throws here, is caught below, and nothing is persisted.
			const beforeStats = historyStats(history);
			let compacted: CompactHistoryResult | CompactResult | null;
			if (options.session) {
				// Session path = runner.compactAndSplice verbatim: the compaction
				// entry lands in the store, then the live history is rebuilt from
				// buildContext ([framed summary, ...retainedTail]).
				compacted = await compactSession({
					session: options.session,
					provider: options.provider,
					model: options.model,
					signal: child.signal,
					settings,
					modelMaxTokens: modelMaxTokensFor(options.model), // #derived-budget
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
					modelMaxTokens: modelMaxTokensFor(options.model), // #derived-budget
				});
				if (compacted) {
					history.splice(0, history.length, summaryToMessage(compacted.summary), ...compacted.retainedTail);
					childFloor = 1 + compacted.retainedTail.length; // same shape as the store's boundary
				}
			}
			if (compacted) {
				consecutiveFailures = 0;
				// Carry the summarized-away assistant stats into the crash-path
				// accumulator: removed = before-splice − after-splice (the retained
				// tail survives with identical usage, so the componentwise delta is
				// exact), plus the summarizer's own call cost.
				const afterStats = historyStats(history);
				addUsage(summarizedUsage, usageDelta(beforeStats.usage, afterStats.usage));
				addUsage(summarizedUsage, compacted.usage);
				summarizedTurns += beforeStats.turns - afterStats.turns;
				summarizedAny = true;
				return { compacted: true };
			}
			return { compacted: false }; // keepRecent swallowed everything (cut <= 0)
		} catch (err) {
			// Keep the un-compacted history and continue; the next turn boundary
			// retries if the estimate is still over the threshold (bounded by
			// CHILD_MAX_TURNS). The child has no status channel to report to.
			// Abort-during-summarizer also lands here (the signal is forwarded) —
			// the recovery seam re-checks child.signal.aborted, onBeforeTurn
			// simply retries next boundary.
			consecutiveFailures += 1;
			if (consecutiveFailures >= 3) {
				compactionDisabled = true;
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
	// signal did not.
	const clock = AbortSignal.timeout(timeoutMs);
	const child = new AbortController();
	const relay = () => child.abort();
	// An ALREADY-aborted signal never fires "abort" again — attach the
	// listener only when live, else relay immediately (a parent signal aborted
	// during worktree setup used to deadlock the child forever).
	if (options.signal?.aborted) child.abort();
	else options.signal?.addEventListener("abort", relay);
	if (clock.aborted) child.abort();
	else clock.addEventListener("abort", relay);

	/** The child's one launch seam: userMessage is undefined on the overflow
	 *  retry — the failed attempt already left the prompt in history (the loop
	 *  only appends non-empty prompts, loop.ts:112), a re-pass would duplicate
	 *  it. Same shape as the main loop's retry (runner.ts:772). */
	const launchLoop = (userMessage: string | undefined): Promise<RunAgentLoopResult> =>
		runAgentLoop({
			provider: options.provider,
			model: options.model,
			system:
				options.system +
				CHILD_SUFFIX +
				(options.extraSystem ? `\n\n# Agent profile\n\n${options.extraSystem}` : ""),
			tools: options.tools,
			history,
			userMessage,
			maxIterations: CHILD_MAX_TURNS,
			onMessage: options.onMessage,
			onToolCall: options.onToolCall,
			onEvent: options.onEvent,
			onBeforeTurn,
			signal: child.signal,
		});

	/** Accounting from history + the summarized accumulator — shared by the
	 *  crash path and the recovered path (both rounds' real cost lives in
	 *  history; a second runAgentLoop's own counters only cover the retry). */
	const statsFromHistory = () => {
		const { turns, usage } = historyStats(history);
		return {
			turns: turns + summarizedTurns,
			usage: summarizedAny ? addUsageIntoNew(usage, summarizedUsage) : usage,
		};
	};

	try {
		const result = await launchLoop(options.prompt);
		if (result.stopReason === "aborted") {
			const timedOut = !(options.signal?.aborted ?? false) && clock.aborted;
			return {
				status: timedOut ? "timeout" : "aborted",
				text: finalAssistantText(history),
				turns: result.turns,
				usage: result.usage,
			};
		}
		return {
			status: result.stopReason,
			text: finalAssistantText(history),
			turns: result.turns,
			usage: result.usage,
		};
	} catch (err) {
		const crashWith = (reason: string): SubagentOutcome => ({
			status: "crash",
			reason,
			text: finalAssistantText(history),
			...statsFromHistory(),
		});
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
				const timedOut = !(options.signal?.aborted ?? false) && clock.aborted;
				return {
					status: timedOut ? "timeout" : "aborted",
					text: finalAssistantText(history),
					...statsFromHistory(),
				};
			}
			return crashWith(overflowGuidance(guidanceTokens(), settings, error ?? "nothing safe to compact"));
		}
		try {
			const result = await launchLoop(undefined);
			if (result.stopReason === "aborted") {
				const timedOut = !(options.signal?.aborted ?? false) && clock.aborted;
				return {
					status: timedOut ? "timeout" : "aborted",
					text: finalAssistantText(history),
					...statsFromHistory(),
				};
			}
			// D3: retry-success accounting from history (both rounds' cost).
			return {
				status: result.stopReason,
				text: finalAssistantText(history),
				...statsFromHistory(),
			};
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
		clock.removeEventListener("abort", relay);
	}
}

/** Budget trailer for task results (design §3): `(child: 7 turns, 12k in / 1.4k out / 9.8k cache)`.
 *  An absent/zero cache read omits the segment — never "/ 0 cache". */
export function childUsageTrailer(turns: number, usage: Usage): string {
	const cache = usage.cacheReadTokens ?? 0;
	const cacheSegment = cache > 0 ? ` / ${formatTokens(cache)} cache` : "";
	return `(child: ${turns} turns, ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out${cacheSegment})`;
}
