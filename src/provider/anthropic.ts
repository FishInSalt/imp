import type { AgentMessage, AssistantBlock, AssistantMessage, StopReason, Usage } from "../core/messages.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export interface AnthropicProviderOptions {
	apiKey?: string;
	baseUrl?: string;
}

interface WireContent {
	type: string;
	[key: string]: unknown;
}

interface WireMessage {
	role: "user" | "assistant";
	content: string | WireContent[];
}

function toWireMessages(messages: AgentMessage[]): WireMessage[] {
	return messages.map((msg): WireMessage => {
		switch (msg.role) {
			case "user":
				return { role: "user", content: msg.content };
			case "assistant": {
				const content: WireContent[] = [];
				for (const block of msg.blocks) {
					if (block.type === "text") {
						if (block.text !== "") content.push({ type: "text", text: block.text });
					} else {
						content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
					}
				}
				if (content.length === 0) content.push({ type: "text", text: "(empty)" });
				return { role: "assistant", content };
			}
			case "toolResult":
				return {
					role: "user",
					content: msg.results.map((r) => ({
						type: "tool_result",
						tool_use_id: r.toolCallId,
						content: r.content,
						is_error: r.isError,
					})),
				};
		}
	});
}

interface SseEvent {
	event: string;
	data: unknown;
}

/** Parse an SSE byte stream into events. Frames are separated by a blank line. */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.indexOf("\n\n")) !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const parsed = parseFrame(frame);
				if (parsed) yield parsed;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseFrame(frame: string): SseEvent | undefined {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) {
			event = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart());
		}
	}
	if (dataLines.length === 0) return undefined;
	try {
		return { event, data: JSON.parse(dataLines.join("\n")) };
	} catch {
		return undefined;
	}
}

function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return { _parseError: "tool arguments were not valid JSON", raw: raw.slice(0, 500) };
	}
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): LLMProvider {
	const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

	return {
		name: "anthropic",
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			if (!apiKey) {
				throw new Error("ANTHROPIC_API_KEY is not set. Export it first:\n  export ANTHROPIC_API_KEY=sk-ant-...");
			}

			const body = {
				model: request.model,
				max_tokens: request.maxTokens,
				system: request.system,
				stream: true,
				messages: toWireMessages(request.messages),
				tools: request.tools.map((t) => ({
					name: t.name,
					description: t.description,
					input_schema: t.parameters,
				})),
			};

			let response: Response;
			try {
				response = await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": apiKey,
						"anthropic-version": API_VERSION,
					},
					body: JSON.stringify(body),
					signal: request.signal,
				});
			} catch (err) {
				if (request.signal?.aborted) return;
				throw new Error(`Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			if (!response.ok || !response.body) {
				const text = await response.text().catch(() => "");
				const hint =
					response.status === 401
						? " — check your ANTHROPIC_API_KEY"
						: response.status === 404
							? " — check the model id"
							: "";
				throw new Error(`Anthropic API error ${response.status}${hint}: ${text.slice(0, 500)}`);
			}

			// Assembly state. Wire content-block index -> our block + raw JSON accumulator.
			const blocks: AssistantBlock[] = [];
			const blockByIndex = new Map<number, AssistantBlock>();
			const toolRawByIndex = new Map<number, string>();
			const usage: Usage = { inputTokens: 0, outputTokens: 0 };
			let stopReason: StopReason = null;

			for await (const sse of parseSse(response.body)) {
				if (request.signal?.aborted) return;
				const data = sse.data as Record<string, unknown>;

				switch (sse.event) {
					case "message_start": {
						const message = (data.message ?? {}) as Record<string, unknown>;
						const u = (message.usage ?? {}) as Record<string, number>;
						usage.inputTokens = u.input_tokens ?? 0;
						usage.cacheReadTokens = u.cache_read_input_tokens;
						usage.cacheWriteTokens = u.cache_creation_input_tokens;
						break;
					}
					case "content_block_start": {
						const index = data.index as number;
						const block = (data.content_block ?? {}) as Record<string, unknown>;
						if (block.type === "text") {
							const ours: AssistantBlock = { type: "text", text: "" };
							blockByIndex.set(index, ours);
							blocks.push(ours);
						} else if (block.type === "tool_use") {
							const ours: AssistantBlock = {
								type: "toolCall",
								id: String(block.id),
								name: String(block.name),
								arguments: {},
							};
							blockByIndex.set(index, ours);
							blocks.push(ours);
							toolRawByIndex.set(index, "");
							yield { type: "tool_call_start", id: ours.id, name: ours.name };
						}
						// thinking blocks: intentionally ignored in v0.1
						break;
					}
					case "content_block_delta": {
						const index = data.index as number;
						const delta = (data.delta ?? {}) as Record<string, unknown>;
						const ours = blockByIndex.get(index);
						if (delta.type === "text_delta" && ours?.type === "text") {
							const text = String(delta.text ?? "");
							ours.text += text;
							yield { type: "text_delta", text };
						} else if (delta.type === "input_json_delta" && ours?.type === "toolCall") {
							const chunk = String(delta.partial_json ?? "");
							toolRawByIndex.set(index, (toolRawByIndex.get(index) ?? "") + chunk);
							yield { type: "tool_call_delta", id: ours.id, jsonDelta: chunk };
						}
						break;
					}
					case "content_block_stop": {
						const index = data.index as number;
						const raw = toolRawByIndex.get(index);
						if (raw !== undefined) {
							toolRawByIndex.delete(index);
							const ours = blockByIndex.get(index);
							if (ours?.type === "toolCall") {
								ours.arguments = raw.trim() === "" ? {} : safeParseJson(raw);
							}
						}
						break;
					}
					case "message_delta": {
						const delta = (data.delta ?? {}) as Record<string, unknown>;
						const u = (data.usage ?? {}) as Record<string, number>;
						if (typeof delta.stop_reason === "string") {
							stopReason = delta.stop_reason as StopReason;
						}
						usage.outputTokens = u.output_tokens ?? usage.outputTokens;
						break;
					}
					case "error": {
						const error = (data.error ?? {}) as Record<string, unknown>;
						throw new Error(`Anthropic stream error: ${String(error.message ?? JSON.stringify(data))}`);
					}
					default:
						// ping / message_stop / unknown: nothing to do
						break;
				}
			}

			// Stream ended mid-block: salvage whatever raw JSON we accumulated.
			for (const [index, raw] of toolRawByIndex) {
				const ours = blockByIndex.get(index);
				if (ours?.type === "toolCall") {
					ours.arguments = raw.trim() === "" ? {} : safeParseJson(raw);
				}
			}

			if (request.signal?.aborted) return;
			yield {
				type: "message_end",
				message: { role: "assistant", blocks, usage, stopReason },
			};
		},
	};
}
