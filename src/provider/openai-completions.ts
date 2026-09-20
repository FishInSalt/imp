import type { AgentMessage, AssistantBlock, ContentBlock, StopReason, Usage } from "../core/messages.js";
import { resolveApiKey } from "./auth-store.js";
import {
	abortSafe,
	downgradeUnsupportedImages,
	parseSse,
	postJsonWithRetry,
	safeParseJson,
} from "./shared.js";
import { clampThinkingLevel, effortFor, thinkingMetaFor } from "./thinking.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "./types.js";
import { modelSupportsVision } from "./vision.js";

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
	/** The provider name the thinking catalog keys off ("openai" default;
	 *  the zai family passes "zai"). */
	name?: string;
	/** pi compat.zaiToolStream: request Z.ai's streaming tool dialect
	 *  (body tool_stream: true whenever tools ride the request). */
	zaiToolStream?: boolean;
}

interface WireToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

type WireUserPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type WireMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | WireUserPart[] }
	| { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

/** User content: string stays the string (pre-M13 bytes); a block array
 *  becomes text/image_url parts (OpenAI user-content form). */
function toUserParts(content: string | ContentBlock[]): string | WireUserPart[] {
	if (typeof content === "string") return content;
	const parts: WireUserPart[] = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text") {
			hasText = true;
			parts.push({ type: "text", text: block.text });
		} else {
			parts.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
		}
	}
	if (!hasText) parts.unshift({ type: "text", text: "(see attached image)" });
	return parts;
}

function toWireMessages(system: string, messages: AgentMessage[]): WireMessage[] {
	const wire: WireMessage[] = [{ role: "system", content: system }];
	for (const msg of messages) {
		switch (msg.role) {
			case "user":
				wire.push({ role: "user", content: toUserParts(msg.content) });
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
			case "toolResult": {
				// pi parity (openai-completions.ts 1377–1430): chat-completions
				// tool messages cannot carry images — text goes in the tool
				// message, images are hoisted into ONE following user message.
				const hoisted: WireUserPart[] = [];
				for (const r of msg.results) {
					let text = "";
					let hasImages = false;
					if (typeof r.content === "string") {
						text = r.content;
					} else {
						const texts: string[] = [];
						for (const block of r.content) {
							if (block.type === "text") texts.push(block.text);
							else {
								hasImages = true;
								hoisted.push({
									type: "image_url",
									image_url: { url: `data:${block.mimeType};base64,${block.data}` },
								});
							}
						}
						text = texts.join("\n");
					}
					wire.push({
						role: "tool",
						tool_call_id: r.toolCallId,
						content: text !== "" ? text : hasImages ? "(see attached image)" : "(no tool output)",
					});
				}
				if (hoisted.length > 0) wire.push({ role: "user", content: hoisted });
				break;
			}
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
	return /^(o\d|gpt-[56])/.test(model) ? "max_completion_tokens" : "max_tokens";
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
	/** GLM / DeepSeek reasoning trace arrives as reasoning_content deltas
	 *  (#thinking-levels) — display-only, never replayed in requests (the
	 *  vendors' guidance: discard it from context). */
	reasoning_content?: string | null;
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
	// options.apiKey (the zai provider passes its own resolved key) first;
	// otherwise a stored /login credential wins over OPENAI_API_KEY (pi's
	// envApiKeyAuth order).
	const apiKey = options.apiKey ?? resolveApiKey("openai", "OPENAI_API_KEY")?.key;
	const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

	return {
		name: options.name ?? "openai",
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			if (!apiKey) {
				throw new Error(
					"No API key found. Set one of:\n" +
						"  export OPENAI_API_KEY=sk-...                    (OpenAI platform)\n" +
						"  export OPENAI_BASE_URL=https://api.z.ai/api/paas/v4  (Z.ai OpenAI-mode, key in OPENAI_API_KEY)",
				);
			}

			// M13 §6: strip image blocks before serialization when the model
			// lacks vision (fail-safe default in vision.ts).
			const messages = downgradeUnsupportedImages(
				request.messages,
				modelSupportsVision(options.name ?? "openai", request.model),
			);
			const body: Record<string, unknown> = {
				model: request.model,
				stream: true,
				stream_options: { include_usage: true },
				messages: toWireMessages(request.system, messages),
				[maxTokensField(request.model)]: request.maxTokens,
			};
			if (request.tools.length > 0) {
				if (options.zaiToolStream === true) body.tool_stream = true; // pi compat.zaiToolStream
				body.tools = request.tools.map((t) => ({
					type: "function",
					function: { name: t.name, description: t.description, parameters: t.parameters },
				}));
				body.tool_choice = "auto";
			}
			// Thinking (#thinking-levels, pi parity):
			//  - zai GLM (thinkingFormat:"zai"): the native thinking object,
			//    explicitly enabled OR disabled (pi openai-completions.js:561
			//    — GLM defaults to thinking on, omission is not "off");
			//    glm >=5.2 additionally takes a mapped reasoning_effort;
			//  - OpenAI: reasoning_effort from the model's level map, and on
			//    "off" the map's own off value when it names one (gpt-5.1+
			//    map off→"none"; older models accept omission — pi :638);
			//  - deepseek-reasoner: reasons by default, no request knob.
			const meta = thinkingMetaFor(options.name ?? "openai", request.model);
			const level = request.thinking !== undefined ? clampThinkingLevel(meta, request.thinking) : undefined;
			if (meta?.style === "glm-openai") {
				body.thinking =
					level !== undefined && level !== "off"
						? { type: "enabled", clear_thinking: false }
						: { type: "disabled" };
				if (level !== undefined && level !== "off" && meta.supportsEffort === true) {
					body.reasoning_effort = effortFor(meta, level);
				}
			} else if (meta?.style === "openai-effort") {
				if (level !== undefined && level !== "off") {
					body.reasoning_effort = effortFor(meta, level);
				} else {
					// "off" AND undefined (the runner maps off→undefined — pi
					// :638): the map's own off value when it names one
					// (gpt-5.1+ → "none"); older models accept omission.
					const off = meta.levelMap?.off;
					if (typeof off === "string") body.reasoning_effort = off;
				}
			}

			const response = await postJsonWithRetry(
				`${baseUrl}/chat/completions`,
				{
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				JSON.stringify(body),
				request.signal,
				"OpenAI",
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
			let thinkingBlock: Extract<AssistantBlock, { type: "thinking" }> | null = null;
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

				const reasoning = choice?.delta?.reasoning_content;
				if (typeof reasoning === "string" && reasoning !== "") {
					if (thinkingBlock === null) {
						thinkingBlock = { type: "thinking", thinking: "" };
						blocks.push(thinkingBlock);
					}
					thinkingBlock.thinking += reasoning;
					yield { type: "thinking_delta", text: reasoning };
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
					// prompt_tokens INCLUDES cache hits (both spellings report the
					// hit count as a subset) — subtract to match the anthropic
					// inputTokens convention the ctx%/compaction math assumes (review F1).
					const cached =
						chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0;
					usage.inputTokens = Math.max(usage.inputTokens, (chunk.usage.prompt_tokens ?? 0) - cached);
					usage.outputTokens = Math.max(usage.outputTokens, chunk.usage.completion_tokens ?? 0);
					if (cached > 0) usage.cacheReadTokens = Math.max(usage.cacheReadTokens ?? 0, cached);
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
