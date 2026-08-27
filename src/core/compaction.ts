import type { LLMProvider } from "../provider/types.js";
import type { AgentMessage, AssistantMessage, Usage } from "./messages.js";
import { addUsage, emptyUsage } from "./messages.js";
import type { SessionStore } from "./session/store.js";

/**
 * Context compaction: when the conversation nears the model's context window,
 * older messages are summarized by the LLM itself into a checkpoint summary;
 * recent messages stay verbatim. The session file keeps everything — compaction
 * only changes what is replayed into context (see SessionStore.buildContext).
 */

export interface CompactionSettings {
	/** Trigger when estimated context tokens exceed window - reserve. Default 16384. */
	reserveTokens: number;
	/** Approximate tokens of recent messages kept verbatim. Default 20000. */
	keepRecentTokens: number;
	/** Model context window. Default from IMP_CONTEXT_WINDOW or 131072. */
	contextWindow: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	contextWindow: Number(process.env.IMP_CONTEXT_WINDOW ?? 131072),
};

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

export function estimateTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case "user":
			chars = message.content.length;
			break;
		case "assistant":
			for (const block of message.blocks) {
				if (block.type === "text") chars += block.text.length;
				else chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
			}
			break;
		case "toolResult":
			for (const result of message.results) chars += result.content.length;
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

export function estimateContextTokens(messages: AgentMessage[]): ContextEstimate {
	// Find the last assistant message with real usage.
	let usageIndex = -1;
	let usageTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
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
	return contextTokens > settings.contextWindow - settings.reserveTokens;
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
			// Threshold met inside message i: retain from the START of the turn
			// containing i (the nearest user message at or before it). Retaining a
			// few extra messages is safe; a toolResult can never lead the tail.
			for (let j = i; j >= 0; j--) {
				if ((messages[j] as AgentMessage).role === "user") return j;
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
				lines.push(`[user]\n${truncate(message.content, MAX_USER_CHARS)}`);
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
						`[tool result ${result.toolName}${result.isError ? " (error)" : ""}]\n${truncate(result.content, MAX_TOOL_RESULT_CHARS)}`,
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

// ============================================================================
// Compaction runner
// ============================================================================

export interface CompactResult {
	summary: string;
	retainedCount: number;
	tokensBefore: number;
	usage: Usage;
}

/**
 * Compact a session in place:
 *  1. build context messages (already honoring previous compactions)
 *  2. split into summarize-part / retained tail at a turn boundary
 *  3. ask the LLM for a structured summary of the summarize-part
 *  4. append a compaction entry; the store's next buildContext() returns
 *     [summary, ...retainedTail]
 * Returns null when there is nothing worth compacting.
 */
export async function compactSession(args: {
	session: SessionStore;
	provider: LLMProvider;
	model: string;
	signal?: AbortSignal;
	settings?: CompactionSettings;
}): Promise<CompactResult | null> {
	const settings = args.settings ?? DEFAULT_COMPACTION_SETTINGS;
	const { messages } = args.session.buildContext();
	const tokensBefore = estimateContextTokens(messages).tokens;

	const cut = findCutIndex(messages, settings.keepRecentTokens);
	if (cut <= 0) return null; // nothing older than the retained tail to summarize
	const toSummarize = messages.slice(0, cut);
	const retainedTail = messages.slice(cut);

	const transcript = serializeForSummary(toSummarize);
	const usage = emptyUsage();
	let summary = "";
	let finalText: string | undefined;
	for await (const event of args.provider.stream({
		system: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: `${transcript}\n\n---\n\n${SUMMARIZATION_PROMPT}` }],
		tools: [],
		model: args.model,
		maxTokens: 2048,
		signal: args.signal,
	})) {
		if (event.type === "text_delta") summary += event.text;
		if (event.type === "message_end") {
			addUsage(usage, event.message.usage);
			finalText = event.message.blocks
				.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
				.map((b) => b.text)
				.join("");
		}
	}
	if (summary.trim() === "" && finalText !== undefined) summary = finalText;
	if (summary.trim() === "") throw new Error("compaction: summarizer returned an empty summary");

	args.session.appendCompaction(summary, retainedTail, tokensBefore, usage);
	return { summary, retainedCount: retainedTail.length, tokensBefore, usage };
}
