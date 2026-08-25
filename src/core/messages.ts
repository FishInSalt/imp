/**
 * Imp's internal message model.
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

export interface UserMessage {
	role: "user";
	content: string;
}

export type AssistantBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown };

/** Why the model stopped: "end_turn", "tool_use", "max_tokens", "stop_sequence", or null if unknown. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;

export interface AssistantMessage {
	role: "assistant";
	blocks: AssistantBlock[];
	usage: Usage;
	stopReason: StopReason;
}

export interface ToolResult {
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
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
