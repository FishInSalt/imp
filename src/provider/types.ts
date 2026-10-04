import type { AgentMessage, AssistantMessage } from "../core/messages.js";
import type { Tool } from "../core/tools/types.js";

/**
 * Provider-agnostic streaming events. The loop and UI consume these;
 * each provider implementation is responsible for translating its native
 * stream into this shape exactly once, at the boundary.
 */
export type LLMEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_delta"; id: string; jsonDelta: string }
	/** Reasoning trace delta (Anthropic thinking blocks, GLM/DeepSeek
	 *  reasoning_content). Displayed dim; never part of the answer text. */
	| { type: "thinking_delta"; text: string }
	/** Fully assembled assistant message. Always the last event of a turn. */
	| { type: "message_end"; message: AssistantMessage };

export interface LLMRequest {
	system: string;
	messages: AgentMessage[];
	tools: Tool[];
	model: string;
	maxTokens: number;
	/** Thinking level (pi parity). "off"/undefined = no thinking knob sent;
	 *  providers map the level to their native parameter (see thinking.ts). */
	thinking?: import("./thinking.js").ThinkingLevel;
	signal?: AbortSignal;
}

export interface LLMProvider {
	readonly name: string;
	stream(request: LLMRequest): AsyncIterable<LLMEvent>;
}
