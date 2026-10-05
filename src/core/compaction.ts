import { formatTokens } from "../format.js";
import {
	clampThinkingLevel,
	THINKING_LEVELS,
	type ThinkingLevel,
	thinkingMetaFor,
} from "../provider/thinking.js";
import type { LLMProvider } from "../provider/types.js";
import {
	type AgentMessage,
	type AssistantMessage,
	addUsage,
	type ContentBlock,
	contentText,
	emptyUsage,
	type Usage,
} from "./messages.js";
import { type SessionStore, SUMMARY_MARK } from "./session/store.js";
import type { AttemptUsage } from "./usage-ledger.js";
import { recordMissingUsageReport, recordSummarizerCall, recordUsageReport } from "./usage-ledger.js";

/**
 * Context compaction: when the conversation nears the model's context window,
 * older messages are summarized by the LLM itself into a checkpoint summary;
 * recent messages stay verbatim. The session file keeps everything — compaction
 * only changes what is replayed into context (see SessionStore.buildContext).
 */

export interface CompactionSettings {
	/** Summary budget reserve; also used by the legacy trigger. Default 32768
	 *  (#compaction-thinking-retry — 0.8 share = 26214). */
	reserveTokens: number;
	/** Explicit automatic-compaction threshold; absent uses window - reserve. */
	triggerTokens?: number;
	/** Approximate tokens of recent messages kept verbatim. Default 20000. */
	keepRecentTokens: number;
	/** Model context window. Default from INK_CONTEXT_WINDOW or 131072. */
	contextWindow: number;
}

/** Parse a positive int env var; fall back (with a warning) instead of going NaN.
 *  Exported for #loop-health threshold parsing (same semantics, one helper). */
export function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		process.stderr.write(`ink: ignoring invalid ${name}=${JSON.stringify(raw)}, using ${fallback}\n`);
		return fallback;
	}
	return n;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	// #compaction-thinking-retry: 32768 (was 16384). The summarizer rides the
	// session's thinking level and thinking shares the output budget — three
	// live failures (glm-5.3/kimi-k3/deepseek-flash) had reasoning consume the
	// whole cap. 0.8 × reserve = 26214 covers the worst observed combination
	// (~13k thinking + ~6k text). Trigger impact: 1M windows unchanged (850k);
	// 131k-200k windows compact 1.6-14% earlier. See
	// docs/compaction-thinking-retry-design.md.
	reserveTokens: 32768,
	keepRecentTokens: envInt("INK_KEEP_RECENT", 20000),
	contextWindow: envInt("INK_CONTEXT_WINDOW", 131072),
};

/** The summarizer's output budget (#derived-budget, pi parity):
 *  min(0.8 × reserveTokens, model maxTokens ?? Infinity).
 *
 *  - The 0.8 × reserve share (≈26214 at defaults) is the ALWAYS-present,
 *  settings-scaled bound — it carries all the safety roles the old hard
 *  2048/8192 constants played (runaway protection, cost ceiling).
 *  - The model side caps at the model's own output limit when known
 *  (catalog maxTokens, else the thinking table's maxOutputTokens); when
 *  neither source has data the model side is UNbounded — the reserve share
 *  is the only budget, exactly pi's `model.maxTokens > 0 ? … : Infinity`.
 *  No magic fallback number: a wrong constant is how the live glm-5.3
 *  failure happened (2048 < thinking + full summary → max_tokens → the P2
 *  gate rejected a half checkpoint → /compact failed).
 *  - Branch summaries use half the budget (shorter segments). */
export function summarizerMaxTokens(reserveTokens: number, modelMaxTokens?: number): number {
	const reserveShare = Math.floor(0.8 * reserveTokens);
	return modelMaxTokens !== undefined && modelMaxTokens > 0
		? Math.min(reserveShare, modelMaxTokens)
		: reserveShare;
}

// ============================================================================
// Token estimation (pi's insight: the last assistant call's usage IS the
// measured context size; only trailing messages need char-based estimation)
// ============================================================================

function assistantUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	const usage = (message as AssistantMessage).usage;
	const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0);
	if (total > 0) return usage;
	return undefined;
}

/** pi parity (compaction.ts:242 ESTIMATED_IMAGE_CHARS): a base64 image
 *  block costs roughly 4800 chars in the request — never its data length. */
const ESTIMATED_IMAGE_CHARS = 4800;

function estimateContentChars(content: string | ContentBlock[]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

export function estimateTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case "user":
			chars = estimateContentChars(message.content);
			break;
		case "assistant":
			for (const block of message.blocks) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "toolCall")
					chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
				else chars += block.thinking.length; // thinking counts toward the estimate too
			}
			break;
		case "toolResult":
			for (const result of message.results) chars += estimateContentChars(result.content);
			break;
	}
	// chars/4 heuristic; conservative (overestimates).
	return Math.ceil(chars / 4);
}

export interface ContextEstimate {
	/** Best estimate of current context size in tokens. */
	tokens: number;
	/** True when the estimate is anchored to a real usage report. */
	measured: boolean;
}

/**
 * Estimate context size from messages. Anchors on the last assistant
 * message's usage — that call's input+output IS the measured context size —
 * and only estimates the messages after it (chars/4).
 *
 * minAnchorIndex (#compaction-ux F1): assistants BEFORE this index never
 * anchor. Right after a compaction the retained tail still carries
 * pre-compaction usage (it measured a context that no longer exists), so the
 * estimate would read ~window-sized for one turn — stale footer AND a false
 * auto-compact trigger. Callers that own a spliced/rebuilt history pass the
 * compaction boundary (see SessionStore.buildContext); with no anchor above
 * the boundary the estimate degrades to a pure char estimate of the new
 * shape (measured: false), which is far closer to truth than the stale
 * anchor. The first post-compaction assistant restores a real anchor.
 */
export function estimateContextTokens(messages: AgentMessage[], minAnchorIndex = 0): ContextEstimate {
	// Find the last assistant message with real usage.
	let usageIndex = -1;
	let usageTokens = 0;
	for (let i = messages.length - 1; i >= minAnchorIndex; i--) {
		const usage = assistantUsage(messages[i] as AgentMessage);
		if (usage) {
			usageIndex = i;
			usageTokens =
				usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			break;
		}
	}
	let trailing = 0;
	for (let i = usageIndex + 1; i < messages.length; i++) {
		trailing += estimateTokens(messages[i] as AgentMessage);
	}
	if (usageIndex === -1) {
		return { tokens: trailing, measured: false };
	}
	return { tokens: usageTokens + trailing, measured: true };
}

export function shouldCompact(contextTokens: number, settings: CompactionSettings): boolean {
	return contextTokens > (settings.triggerTokens ?? settings.contextWindow - settings.reserveTokens);
}

/**
 * Does a provider error say "the request exceeded the model's context
 * window"? Providers phrase it differently (anthropic: "prompt is too
 * long"; openai: "maximum context length" / context_length_exceeded; the
 * codex backend and gateways have their own spellings) — match them all.
 * Drives the one-shot compact-and-retry recovery (#overflow-grace).
 */
const CONTEXT_OVERFLOW_RE =
	/prompt is too long|context[_ ]length|maximum context|context (window|length) exceed|too many (input )?tokens|input tokens? (exceed|too (large|long))|exceeds (the )?(maximum )?context/i;

export function isContextOverflowError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return CONTEXT_OVERFLOW_RE.test(err.message);
}

/** The teaching message when recovery is impossible: what happened, and the
 *  two ways out (pi's guidance, adapted to Ink's commands). */
export function overflowGuidance(contextTokens: number, settings: CompactionSettings, cause: string): string {
	return (
		`context ~${formatTokens(contextTokens)} exceeds the current model's window ` +
		`(${formatTokens(settings.contextWindow)}); compaction failed: ${cause} — ` +
		"the summarization request itself may be larger than this model accepts. " +
		"Switch to a larger-context model (e.g. /model glm-5.3) and run /compact there, or start /new."
	);
}

// ============================================================================
// Cut point: walk back keeping ~keepRecentTokens, then snap forward to the
// next turn boundary (a user message) so the retained tail is well-formed
// (a toolResult without its assistant message is not a valid start).
// ============================================================================

export function findCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
	let kept = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		kept += estimateTokens(messages[i] as AgentMessage);
		if (kept >= keepRecentTokens) {
			// Threshold met inside message i: retain from the START of the unit
			// containing i. Valid tail heads are user and assistant messages — an
			// assistant carries its own toolCalls, so [assistant, toolResult, …] is a
			// valid sequence. Tool-heavy runs (one user message, many tool turns)
			// have no interior user boundary, so assistant heads are required.
			for (let j = i; j >= 0; j--) {
				const role = (messages[j] as AgentMessage).role;
				if (role === "user" || role === "assistant") return j;
			}
			return 0;
		}
	}
	return 0; // everything fits in the keep window — nothing to summarize
}

// ============================================================================
// Transcript serialization for the summarizer LLM
// ============================================================================

const MAX_TOOL_RESULT_CHARS = 800;
const MAX_USER_CHARS = 4000;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function serializeForSummary(messages: AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				lines.push(`[user]\n${truncate(contentText(message.content), MAX_USER_CHARS)}`);
				break;
			case "assistant":
				for (const block of message.blocks) {
					if (block.type === "text" && block.text !== "") {
						lines.push(`[assistant]\n${truncate(block.text, MAX_USER_CHARS)}`);
					} else if (block.type === "toolCall") {
						lines.push(
							`[assistant calls ${block.name}]\n${truncate(JSON.stringify(block.arguments ?? {}), 400)}`,
						);
					}
				}
				break;
			case "toolResult":
				for (const result of message.results) {
					lines.push(
						`[tool result ${result.toolName}${result.isError ? " (error)" : ""}]\n${truncate(contentText(result.content), MAX_TOOL_RESULT_CHARS)}`,
					);
				}
				break;
		}
	}
	return lines.join("\n\n");
}

// ============================================================================
// Summarization prompts (structure borrowed from pi — it reads back well)
// ============================================================================

const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. Read the conversation between a user and an AI coding agent, " +
	"then produce a structured summary in the exact format specified by the user prompt. " +
	"Do NOT continue the conversation. Do NOT answer any questions in it. ONLY output the summary.";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another AI agent will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by the user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, code references, or facts needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// ============================================================================
// Branch summaries (#10 /tree) — the abandoned branch's memory, carried into
// the new branch's context. Same streaming pattern as compactHistory.
// ============================================================================

const BRANCH_SUMMARY_PROMPT = `The messages above are one branch of a conversation that the user has now LEFT for a different direction. Summarize what that branch tried and learned, so the agent continuing on the new branch keeps the memory.

Use this EXACT format:

## What was tried
- [The approach(es) taken on this branch]

## Outcome & learnings
- [What worked, what failed, key facts discovered]

## Worth carrying over
- [Anything the new direction should account for — or "(none)"]

Keep it under ~200 words. Preserve exact file paths, function names, and error messages.`;

// ============================================================================
// Summarizer seam (#compaction-thinking-retry)
// ============================================================================

interface SummarizerRun {
	summary: string;
	finalText: string | undefined;
	usage: Usage;
	/** SA-05: true when at least one started stream never delivered a report
	 *  (mirrors the ledger's recordMissingUsageReport sites). */
	usageMissing: boolean;
	stopReason: string | null | undefined;
}

/** One summarizer stream — shared by history compaction and branch summaries
 *  (they differ only in prompt, cap and result handling). */
async function runSummarizer(args: {
	provider: LLMProvider;
	model: string;
	system: string;
	userContent: string;
	maxTokens: number;
	thinking?: ThinkingLevel;
	signal?: AbortSignal;
	/** SA-04: records every summarizer stream at the seam — reported usage,
	 *  started calls, and started streams that never reported. */
	usageLedger?: AttemptUsage;
}): Promise<SummarizerRun> {
	const usage = emptyUsage();
	let summary = "";
	let finalText: string | undefined;
	let stopReason: string | null | undefined;
	let usageMissing = false;
	recordSummarizerCall(args.usageLedger);
	let reported = false;
	try {
		for await (const event of args.provider.stream({
			system: args.system,
			messages: [{ role: "user", content: args.userContent }],
			tools: [],
			model: args.model,
			maxTokens: args.maxTokens,
			signal: args.signal,
			thinking: args.thinking !== undefined && args.thinking !== "off" ? args.thinking : undefined,
		})) {
			if (event.type === "text_delta") summary += event.text;
			if (event.type === "message_end") {
				reported = true;
				addUsage(usage, event.message.usage);
				recordUsageReport(args.usageLedger, "summarizer", event.message.usage);
				// SA-04 round 2: message said it never saw usage data.
				if (event.message.usageMissing === true) {
					usageMissing = true;
					recordMissingUsageReport(args.usageLedger);
				}
				stopReason = event.message.stopReason;
				finalText = event.message.blocks
					.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join("");
			}
		}
	} finally {
		// SA-04: an aborted/thrown stream still counts as a started call whose
		// report never arrived — disclosed, never guessed.
		if (!reported) {
			usageMissing = true;
			recordMissingUsageReport(args.usageLedger);
		}
	}
	return { summary, finalText, usage, stopReason, usageMissing };
}

/** Rank a level for the "did the retry actually lower anything" test; an
 *  undefined thinking request (session off / no knob) ranks as off. */
function levelRank(level: ThinkingLevel | undefined): number {
	return THINKING_LEVELS.indexOf(level ?? "off");
}

/**
 * #compaction-thinking-retry: retry a token-capped summarizer run ONCE at the
 * lowest thinking level the model supports. Thinking and the summary text share
 * the output budget; at high/max levels reasoning alone consumed the entire cap
 * in all three live failures (glm-5.3/kimi-k3/deepseek-flash — zero or
 * truncated text). The cap and the transcript are unchanged — only the level
 * drops. prompt-audit P2 still holds: a capped summary is a half checkpoint and
 * must never be persisted; retrying is how we avoid reaching that state.
 *
 * Abort wins (D1/review): an aborted run never starts another provider call,
 * and an abort racing the retry keeps its own message.
 */
async function summarizeWithRetry(args: {
	provider: LLMProvider;
	model: string;
	system: string;
	userContent: string;
	maxTokens: number;
	thinking?: ThinkingLevel;
	signal?: AbortSignal;
	tokenCapMessage: string;
	abortedMessage: string;
	/** SA-04: threaded to both hops — per-stream recording makes the ledger
	 *  immune to retry/rejection throws; the merged return value stays for the
	 *  compaction entry (never both summed). */
	usageLedger?: AttemptUsage;
}): Promise<SummarizerRun> {
	const first = await runSummarizer(args);
	// Abort gate is UNCONDITIONAL (pre-refactor parity): abortSafe streams end
	// cleanly WITHOUT a message_end, so stopReason stays undefined — a partial
	// summary must be rejected, never returned as complete (P1 regression from
	// hoisting this check into the max_tokens branch only).
	if (args.signal?.aborted) throw new Error(args.abortedMessage);
	if (first.stopReason !== "max_tokens") return first;
	// "off" is not always available (levelMap.off === null — forced-reasoning
	// models); clampThinkingLevel picks the lowest supported level. For
	// meta-less models it returns "off", which the request maps to "no thinking
	// field" (intervention-free — the model's default applies; documented).
	const lowered = clampThinkingLevel(thinkingMetaFor(args.provider.name, args.model), "off");
	if (levelRank(lowered) >= levelRank(args.thinking)) {
		throw new Error(`${args.tokenCapMessage} (thinking=${args.thinking ?? "off"}; no lower level available)`);
	}
	const retry = await runSummarizer({ ...args, thinking: lowered });
	addUsage(retry.usage, first.usage); // honest accounting across both hops
	retry.usageMissing = retry.usageMissing || first.usageMissing; // SA-05: OR of the hops
	// Abort wins over the cap on the retry hop too (design §3).
	if (args.signal?.aborted) throw new Error(args.abortedMessage);
	if (retry.stopReason === "max_tokens") {
		throw new Error(
			`${args.tokenCapMessage} (attempt 1: thinking=${args.thinking ?? "off"}, cap=${args.maxTokens}; retry: thinking=${lowered} — both capped)`,
		);
	}
	return retry;
}

export async function summarizeBranchSegment(args: {
	messages: AgentMessage[];
	provider: LLMProvider;
	model: string;
	signal?: AbortSignal;
	/** #derived-budget: model-side cap source — the runner resolves the
	 *  model reference's maxTokens (catalog, else the thinking table) and
	 *  passes it down; undefined leaves the reserve share as the only bound. */
	modelMaxTokens?: number;
	/** #thinking-levels: pi's summarizer rides the session's thinking level
	 *  (compaction.ts:549 — options.reasoning = level when the model has a
	 *  knob and the level is not "off"). */
	thinking?: ThinkingLevel;
	/** #tree: the user's "Summarize with custom prompt" instructions,
	 *  appended after the fixed prompt (pi's customInstructions). */
	customInstructions?: string;
}): Promise<{ summary: string; usage: Usage; usageMissing: boolean }> {
	const transcript = serializeForSummary(args.messages);
	const suffix =
		args.customInstructions !== undefined && args.customInstructions.trim() !== ""
			? `\n\nFollow these user instructions too:\n${args.customInstructions.trim()}`
			: "";
	const run = await summarizeWithRetry({
		provider: args.provider,
		model: args.model,
		system: SUMMARIZATION_SYSTEM_PROMPT,
		userContent: `${transcript}\n\n---\n\n${BRANCH_SUMMARY_PROMPT}${suffix}`,
		// Half the derived budget: branch segments are shorter than full
		// sessions (#derived-budget).
		maxTokens: Math.floor(
			summarizerMaxTokens(DEFAULT_COMPACTION_SETTINGS.reserveTokens, args.modelMaxTokens) / 2,
		),
		thinking: args.thinking,
		signal: args.signal,
		tokenCapMessage: "branch summary: hit the token cap — incomplete, rejected",
		abortedMessage: "branch summary: summarizer aborted — incomplete, rejected",
	});
	if (run.summary.trim() === "") throw new Error("branch summary: summarizer returned nothing");
	return { summary: run.summary.trim(), usage: run.usage, usageMissing: run.usageMissing };
}

// ============================================================================
// Compaction runner
// ============================================================================

export interface CompactResult {
	summary: string;
	retainedCount: number;
	/** Estimated context right before compaction. */
	tokensBefore: number;
	/** Estimated context right after (summary + retained tail, char-based). */
	tokensAfter: number;
	usage: Usage;
	/** SA-05: a summarizer stream ran without delivering a usage report. */
	usageMissing: boolean;
}

/** Result of the pure compaction computation (no session involvement). */
export interface CompactHistoryResult {
	summary: string;
	/** Messages kept verbatim after compaction — a self-contained checkpoint. */
	retainedTail: AgentMessage[];
	/** Estimated context right before compaction. */
	tokensBefore: number;
	/** Estimated context right after (summary + retained tail, char-based). */
	tokensAfter: number;
	usage: Usage;
	/** SA-05: a summarizer stream ran without delivering a usage report. */
	usageMissing: boolean;
}

/**
 * The pure half of compaction — no session, no persistence:
 *  1. split messages into summarize-part / retained tail at a turn boundary
 *  2. ask the LLM for a structured summary of the summarize-part
 * Callers decide what happens with the result (compactSession appends it to a
 * session store; the subagent engine splices it into an in-memory history).
 * Returns null when there is nothing worth compacting.
 */
export async function compactHistory(args: {
	messages: AgentMessage[];
	provider: LLMProvider;
	model: string;
	signal?: AbortSignal;
	settings?: CompactionSettings;
	/** #derived-budget: the model-side cap source (see
	 *  summarizeBranchSegment). undefined → reserve share only. */
	modelMaxTokens?: number;
	/** #thinking-levels: pi's summarizer rides the session's level. */
	thinking?: ThinkingLevel;
	/** SA-04: attempt ledger (see runSummarizer). */
	usageLedger?: AttemptUsage;
}): Promise<CompactHistoryResult | null> {
	const settings = args.settings ?? DEFAULT_COMPACTION_SETTINGS;
	const tokensBefore = estimateContextTokens(args.messages).tokens;

	const cut = findCutIndex(args.messages, settings.keepRecentTokens);
	if (cut <= 0) return null; // nothing older than the retained tail to summarize

	// prompt-audit P3: when the head is a previous compaction's framed summary,
	// UPDATE it with only the new messages instead of re-summarizing the old
	// summary as if it were conversation (each generation drifts). Content may
	// be ContentBlock[] (M13) — type-check before the marker test.
	const head = args.messages[0];
	let previousSummary: string | undefined;
	let summarizeFrom = 0;
	if (
		head !== undefined &&
		head.role === "user" &&
		typeof head.content === "string" &&
		head.content.startsWith(SUMMARY_MARK)
	) {
		const markerEnd = head.content.indexOf("]\n\n");
		if (markerEnd !== -1) {
			previousSummary = head.content.slice(markerEnd + 3);
			summarizeFrom = 1;
		}
	}
	const toSummarize = args.messages.slice(summarizeFrom, cut);
	// Empty-transcript guard (design review P3-1): cut === 1 means only the old
	// summary predates the boundary — an UPDATE over nothing is exactly the
	// drift this mode exists to stop. Skip; the next boundary retries.
	if (toSummarize.length === 0) return null;
	const retainedTail = args.messages.slice(cut);

	const transcript = serializeForSummary(toSummarize);
	const userContent =
		previousSummary === undefined
			? `${transcript}\n\n---\n\n${SUMMARIZATION_PROMPT}`
			: `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${transcript}\n\n---\n\n${UPDATE_SUMMARIZATION_PROMPT}`;
	const run = await summarizeWithRetry({
		provider: args.provider,
		model: args.model,
		system: SUMMARIZATION_SYSTEM_PROMPT,
		userContent,
		maxTokens: summarizerMaxTokens(settings.reserveTokens, args.modelMaxTokens),
		thinking: args.thinking,
		signal: args.signal,
		usageLedger: args.usageLedger,
		tokenCapMessage: "compaction: summary hit the token cap — incomplete, rejected",
		abortedMessage: "compaction: summarizer aborted — incomplete, rejected",
	});
	let summary = run.summary;
	if (summary.trim() === "" && run.finalText !== undefined) summary = run.finalText;
	if (summary.trim() === "") throw new Error("compaction: summarizer returned an empty summary");

	const summaryMessage: AgentMessage = {
		role: "user",
		content: `${summary}`,
	};
	const tokensAfter =
		estimateTokens(summaryMessage) + retainedTail.reduce((sum, m) => sum + estimateTokens(m), 0);
	return {
		summary,
		retainedTail,
		tokensBefore,
		tokensAfter,
		usage: run.usage,
		usageMissing: run.usageMissing,
	};
}

/**
 * Compact a session in place — thin wrapper over compactHistory:
 *  1. build context messages (already honoring previous compactions)
 *  2. compute the summary + retained tail (pure)
 *  3. append a compaction entry; the store's next buildContext() returns
 *     [summary, ...retainedTail]
 * Returns null when there is nothing worth compacting.
 */
export async function compactSession(args: {
	session: SessionStore;
	provider: LLMProvider;
	model: string;
	signal?: AbortSignal;
	settings?: CompactionSettings;
	/** #derived-budget: passed through to compactHistory (see there). */
	modelMaxTokens?: number;
	/** #thinking-levels: pi's summarizer rides the session's level. */
	thinking?: ThinkingLevel;
	/** SA-04: attempt ledger (see runSummarizer). */
	usageLedger?: AttemptUsage;
	/** SA-05 round 2 (§11.2 R1): the FULLY QUALIFIED producer reference for
	 *  the entry stamp — `model` stays the wire id (it feeds the provider
	 *  call); absent → no stamp → the entry prices as unknown. */
	modelReference?: string;
}): Promise<CompactResult | null> {
	const { messages } = args.session.buildContext();
	const result = await compactHistory({
		messages,
		provider: args.provider,
		model: args.model,
		signal: args.signal,
		settings: args.settings,
		modelMaxTokens: args.modelMaxTokens,
		thinking: args.thinking,
		usageLedger: args.usageLedger,
	});
	if (result === null) return null;

	// SA-05 §11.7 stamps: the wire id under `model`, the DECLARED pricing
	// identity under `modelReference` + the missing-report flag; absent
	// reference → the identity field is omitted (the entry prices as unknown).
	const stamps: { model?: string; modelReference?: string; usageMissing?: true } = {};
	stamps.model = args.model;
	if (args.modelReference !== undefined) stamps.modelReference = args.modelReference;
	if (result.usageMissing) stamps.usageMissing = true;
	args.session.appendCompaction(
		result.summary,
		result.retainedTail,
		result.tokensBefore,
		result.usage,
		stamps,
	);
	return {
		summary: result.summary,
		retainedCount: result.retainedTail.length,
		tokensBefore: result.tokensBefore,
		tokensAfter: result.tokensAfter,
		usage: result.usage,
		usageMissing: result.usageMissing,
	};
}
