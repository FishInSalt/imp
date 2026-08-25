import type { RunLogger } from "../core/logger.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "./types.js";

/**
 * Wrap a provider so every request and final message lands in the run log.
 * Pure decorator — the loop and CLI never know it exists.
 */
export function withLogging(provider: LLMProvider, logger: RunLogger): LLMProvider {
	return {
		name: provider.name,
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			logger.log("llm_request", {
				model: request.model,
				messageCount: request.messages.length,
				tools: request.tools.map((t) => t.name),
			});
			for await (const event of provider.stream(request)) {
				if (event.type === "message_end") {
					logger.log("message_end", {
						model: request.model,
						stopReason: event.message.stopReason,
						usage: event.message.usage,
						blocks: event.message.blocks.map((b) =>
							b.type === "text"
								? { type: "text", length: b.text.length }
								: { type: "toolCall", name: b.name, arguments: b.arguments },
						),
					});
				}
				yield event;
			}
		},
	};
}
