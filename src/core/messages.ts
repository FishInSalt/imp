/**
 * Ink's internal message model.
 *
 * Design rule (inherited from pi): internal messages ≠ LLM wire format.
 * Internal messages carry metadata and stay provider-agnostic; conversion to a
 * provider's wire format happens exactly once, at the provider boundary.
 */

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	/** Cache hit tokens, when the provider reports them. */
	cacheReadTokens?: number;
	/** Cache miss/write tokens, when the provider reports them. */
	cacheWriteTokens?: number;
}

/** A content block. Text blocks are the common case (a plain string is
 *  used whenever no image is present — pi's shape); image blocks carry
 *  base64 data and ride tool results (M13; user arrays are allowed by the
 *  type for future input paths). */
export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type TextBlock = Extract<ContentBlock, { type: "text" }>;
export type ImageBlock = Extract<ContentBlock, { type: "image" }>;

/** The display/model text of a possibly-blocked content: text blocks joined
 *  by newlines, images contributing nothing. Single source for every
 *  consumer that used to read `.content` as a string (replay, render,
 *  subagent context, compaction summarizer). */
export function contentText(content: string | ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

export interface UserMessage {
	role: "user";
	content: string | ContentBlock[];
}

export type AssistantBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	/** The model's reasoning trace (#thinking-levels). Stored with its
	 *  provider signature when the protocol produces one (Anthropic: the
	 *  thinking blocks MUST be passed back on tool-result continuations —
	 *  anthropic.ts replays them; OpenAI-style reasoning_content is
	 *  display-only and never replayed). Rendered dim in both shells. */
	| { type: "thinking"; thinking: string; signature?: string };

/** Why the model stopped: "end_turn", "tool_use", "max_tokens", "stop_sequence", or null if unknown. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;

export interface AssistantMessage {
	role: "assistant";
	blocks: AssistantBlock[];
	usage: Usage;
	stopReason: StopReason;
	/** Model that produced this message (stamped by the loop). Cost
	 *  attribution reads it so a session that switched models prices each
	 *  response at its own rates; entries from older imp versions lack it. */
	model?: string;
	/** SA-05: the FULLY QUALIFIED producer reference (`provider/modelId`) —
	 *  the pricing identity. Stamped by the loop when the caller supplies
	 *  one; distinct from `model` (the wire id, kept for debugging/compat).
	 *  Pre-fix entries lack it and are unpriced, never inferred. */
	modelReference?: string;
	/** SA-04: true when the adapter observed NO mapped usage counter on the
	 *  wire for this response (absent/null/empty/null-valued containers). The
	 *  numbers beside it are then initialization zeros, not a report — the
	 *  attempt ledger must flag incompleteness instead of asserting zero use.
	 *  Never inferred from the counters themselves; set structurally by the
	 *  adapter, absent for explicit reports (including explicit zeros). */
	usageMissing?: true;
}

import type { TaskRecord } from "./task-record.js";

export interface ToolResult {
	toolCallId: string;
	toolName: string;
	content: string | ContentBlock[];
	isError: boolean;
	/** Render-only override (prompt-audit P1). Present ONLY on tool_end
	 *  events — the loop strips it before the result enters history, so it
	 *  never reaches the model, the session file, or resume replay. */
	display?: string;
	/** #tool-settle: how long this call's tool actually executed, measured by the
	 *  loop at the moment the call settled. Render-only, with the same lifecycle
	 *  as `display`: carried on `tool_settled` and `tool_end` events, stripped
	 *  before the result enters history. Absent for calls that never ran
	 *  (schema refusals, gate blocks) and for results rebuilt outside the loop. */
	durationMs?: number;
	/** SA-03 task metadata: program-visible and PERSISTED with the message —
	 *  the opposite lifecycle of `display`. NEVER model-visible: provider
	 *  converters construct wire objects field-by-field and must never read
	 *  this field. Absent for non-task tools. */
	taskRecord?: TaskRecord;
}

export interface ToolResultMessage {
	role: "toolResult";
	results: ToolResult[];
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export function emptyUsage(): Usage {
	return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(target: Usage, source: Usage): void {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (source.cacheReadTokens ?? 0);
	target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (source.cacheWriteTokens ?? 0);
}
