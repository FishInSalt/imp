import type { AgentMessage, AssistantBlock, StopReason, Usage } from "../core/messages.js";
import { abortSafe, parseSse, postJsonWithRetry, safeParseJson } from "./shared.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "./types.js";

/**
 * OpenAI Chat Completions wire protocol — the de-facto industry standard:
 * one adapter serves OpenAI itself plus every compatible endpoint (DeepSeek,
 * Kimi/Moonshot, MiniMax, xAI, OpenRouter, gateways, and Z.ai's OpenAI-mode
 * endpoint). Auth: OPENAI_API_KEY (+ optional OPENAI_BASE_URL).
 *
 * Wire deltas differ from anthropic-messages in the ways that matter:
 *   - system prompt rides as messages[0] (role "system")
 *   - tool calls stream as delta.tool_calls[] keyed by `index`; id and
 *     function.name arrive (whole) in the first chunk for that index,
 *     function.arguments arrives in fragments
 *   - tool results are standalone role:"tool" messages with tool_call_id
 *   - usage only arrives in a final choices-empty chunk when
 *     stream_options:{include_usage:true} is sent
 *   - the stream terminates with `data: [DONE]` (non-JSON; parseSse skips it)
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAICompletionsProviderOptions {
	apiKey?: string;
	baseUrl?: string;
}

interface WireToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

type WireMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

function toWireMessages(system: string, messages: AgentMessage[]): WireMessage[] {
	const wire: WireMessage[] = [{ role: "system", content: system }];
	for (const msg of messages) {
		switch (msg.role) {
			case "user":
				wire.push({ role: "user", content: msg.content });
				break;
			case "assistant": {
				const text = msg.blocks
					.filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join("\n");
				const toolCalls = msg.blocks
					.filter((b): b is Extract<AssistantBlock, { type: "toolCall" }> => b.type === "toolCall")
					.map(
						(b): WireToolCall => ({
							id: b.id,
							type: "function",
							function: { name: b.name, arguments: JSON.stringify(b.arguments) },
						}),
					);
				// Some providers reject a null content WITH tool_calls and others
				// reject missing content WITHOUT — null is the documented shape.
				wire.push({
					role: "assistant",
					content: text === "" && toolCalls.length > 0 ? null : text,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				});
				break;
			}
			case "toolResult":
				for (const r of msg.results) {
					wire.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
				}
				break;
			default: {
				const exhaustive: never = msg;
				throw new Error(`unreachable message role: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return wire;
}

/** Newer OpenAI model families (gpt-5*, o-series reasoning) only accept
 *  max_completion_tokens; everything else in the wild takes max_tokens.
 *  Sending the wrong one is a hard 400 on api.openai.com. */
function maxTokensField(model: string): "max_tokens" | "max_completion_tokens" {
	return /^(o\d|gpt-5)/.test(model) ? "max_completion_tokens" : "max_tokens";
}

function mapFinishReason(reason: string | undefined | null): StopReason {
	switch (reason) {
		case "tool_calls":
			return "tool_use";
		case "length":
			return "max_tokens";
		case "stop":
			return "end_turn";
		default:
			return null;
	}
}

interface StreamDelta {
	content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

interface StreamChunk {
	choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
		/** OpenRouter's spelling of the same cache-read counter. */
		prompt_cache_hit_tokens?: number;
	};
}

export function createOpenAICompletionsProvider(options: OpenAICompletionsProviderOptions = {}): LLMProvider {
	const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
	const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

	return {
		name: "openai",
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			if (!apiKey) {
				throw new Error(
					"No API key found. Set one of:\n" +
						"  export OPENAI_API_KEY=sk-...                    (OpenAI platform)\n" +
						"  export OPENAI_BASE_URL=https://api.z.ai/api/paas/v4  (Z.ai OpenAI-mode, key in OPENAI_API_KEY)",
				);
			}

			const body: Record<string, unknown> = {
				model: request.model,
				stream: true,
				stream_options: { include_usage: true },
				messages: toWireMessages(request.system, request.messages),
				[maxTokensField(request.model)]: request.maxTokens,
			};
			if (request.tools.length > 0) {
				body.tools = request.tools.map((t) => ({
					type: "function",
					function: { name: t.name, description: t.description, parameters: t.parameters },
				}));
				body.tool_choice = "auto";
			}

			const response = await postJsonWithRetry(
				`${baseUrl}/chat/completions`,
				{
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				JSON.stringify(body),
				request.signal,
			);
			if (response === null) return; // aborted mid-connect
			if (!response.ok || !response.body) {
				const text = await response.text().catch(() => "");
				const hint =
					response.status === 401
						? " — check OPENAI_API_KEY"
						: response.status === 404
							? " — check the model id and OPENAI_BASE_URL"
							: "";
				throw new Error(`OpenAI API error ${response.status}${hint}: ${text.slice(0, 500)}`);
			}

			// Assembly state. tool_calls index -> our block + raw JSON accumulator.
			const blocks: AssistantBlock[] = [];
			let textBlock: Extract<AssistantBlock, { type: "text" }> | null = null;
			const toolByIndex = new Map<number, Extract<AssistantBlock, { type: "toolCall" }>>();
			const toolRawByIndex = new Map<number, string>();
			const usage: Usage = { inputTokens: 0, outputTokens: 0 };
			let stopReason: StopReason = null;
			let sawFinish = false;

			for await (const sse of abortSafe(parseSse(response.body), request.signal)) {
				if (request.signal?.aborted) return;
				const chunk = sse.data as StreamChunk;
				const choice = chunk.choices?.[0];

				const content = choice?.delta?.content;
				if (typeof content === "string" && content !== "") {
					if (textBlock === null) {
						textBlock = { type: "text", text: "" };
						blocks.push(textBlock);
					}
					textBlock.text += content;
					yield { type: "text_delta", text: content };
				}

				for (const tc of choice?.delta?.tool_calls ?? []) {
					let block = toolByIndex.get(tc.index);
					const name = tc.function?.name;
					if (block === undefined) {
						block = {
							type: "toolCall",
							id: String(tc.id ?? `call_${tc.index}`),
							name: String(name ?? ""),
							arguments: {},
						};
						toolByIndex.set(tc.index, block);
						blocks.push(block);
						toolRawByIndex.set(tc.index, "");
						yield { type: "tool_call_start", id: block.id, name: block.name };
					} else if (name !== undefined && block.name === "") {
						block.name = String(name); // name can lag id by a chunk on some gateways
					}
					const fragment = tc.function?.arguments ?? "";
					if (fragment !== "") {
						toolRawByIndex.set(tc.index, (toolRawByIndex.get(tc.index) ?? "") + fragment);
						yield { type: "tool_call_delta", id: block.id, jsonDelta: fragment };
					}
				}

				if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
					sawFinish = true;
					stopReason = mapFinishReason(choice.finish_reason);
				}

				if (chunk.usage !== undefined) {
					// api.openai.com counts cache reads inside prompt_tokens;
					// OpenRouter reports the hit count under its own field.
					usage.inputTokens = Math.max(usage.inputTokens, chunk.usage.prompt_tokens ?? 0);
					usage.outputTokens = Math.max(usage.outputTokens, chunk.usage.completion_tokens ?? 0);
					const cached =
						chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens;
					if (cached !== undefined) usage.cacheReadTokens = Math.max(usage.cacheReadTokens ?? 0, cached);
				}
			}

			// Stream ended mid-block: salvage whatever raw JSON we accumulated.
			for (const [index, raw] of toolRawByIndex) {
				const ours = toolByIndex.get(index);
				if (ours !== undefined) {
					ours.arguments = raw.trim() === "" ? {} : (safeParseJson(raw) as Record<string, unknown>);
				}
			}

			if (request.signal?.aborted) return;
			// A stream that ends without finish_reason was truncated (proxy/LB
			// cut the connection). Synthesizing a message_end would persist a
			// partial assistant message as a completed turn — fail loudly instead.
			if (!sawFinish) {
				throw new Error("OpenAI stream ended without finish_reason — response may be truncated");
			}
			// Fallback inference when the endpoint omits finish_reason but tool
			// calls clearly ended the turn.
			if (stopReason === null && blocks.some((b) => b.type === "toolCall")) stopReason = "tool_use";
			if (blocks.length === 0) blocks.push({ type: "text", text: "(empty)" });
			yield {
				type: "message_end",
				message: { role: "assistant", blocks, usage, stopReason },
			};
		},
	};
}
