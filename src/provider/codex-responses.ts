import type { AgentMessage, AssistantBlock, StopReason, Usage } from "../core/messages.js";
import { getCodexAccessToken } from "./codex-auth.js";
import { abortSafe, parseSse, postJsonWithRetry, safeParseJson } from "./shared.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "./types.js";

/**
 * OpenAI Responses wire protocol as spoken by the Codex backend
 * (chatgpt.com/backend-api/codex/responses) — the ChatGPT-subscription
 * credential path. Auth comes from the device-code OAuth store
 * (~/.imp/auth.json, `imp login`); the chatgpt-account-id header is derived
 * from the access token's JWT claim.
 *
 * Wire shape differs from both prior protocols in the ways that matter:
 *   - the system prompt rides as the top-level `instructions` field
 *   - messages are `input` ITEMS: user text as input_text parts, a tool call
 *     as a standalone {type:"function_call"} item, results as
 *     {type:"function_call_output"} items
 *   - tools are flat {type:"function", name, parameters} (no nested function
 *     wrapper, unlike Chat Completions)
 *   - streams use `event:` lines: response.output_item.added creates a slot
 *     per output_index, deltas flow per slot, response.completed terminates
 *   - usage.input_tokens INCLUDES cached tokens — subtract for the
 *     anthropic-compatible inputTokens semantics
 *
 * Reasoning output (response.reasoning_* events) is ignored, matching the
 * v0.1 thinking-block policy of the other adapters.
 */

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

export interface CodexResponsesProviderOptions {
	baseUrl?: string;
	/** Injectable for tests; default: the OAuth credential store. */
	auth?: () => Promise<{ accessToken: string; accountId: string }>;
}

interface InputItem {
	type?: string;
	role?: string;
	content?: unknown;
	call_id?: string;
	name?: string;
	arguments?: string;
	output?: string;
	[key: string]: unknown;
}

function toInputItems(systemIgnored: string, messages: AgentMessage[]): InputItem[] {
	// system rides as `instructions` — the caller sets it; this parameter is
	// kept for signature symmetry with the other adapters' translators.
	void systemIgnored;
	const items: InputItem[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user":
				items.push({ role: "user", content: [{ type: "input_text", text: msg.content }] });
				break;
			case "assistant": {
				const text = msg.blocks
					.filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join("\n");
				if (text !== "") items.push({ role: "assistant", content: [{ type: "output_text", text }] });
				for (const block of msg.blocks) {
					if (block.type !== "toolCall") continue;
					items.push({
						type: "function_call",
						call_id: block.id,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
				break;
			}
			case "toolResult":
				for (const r of msg.results) {
					items.push({ type: "function_call_output", call_id: r.toolCallId, output: r.content });
				}
				break;
			default: {
				const exhaustive: never = msg;
				throw new Error(`unreachable message role: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return items;
}

interface ResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

function usageFromResponse(raw: ResponsesUsage | undefined): Usage {
	const input = raw?.input_tokens ?? 0;
	const cached = raw?.input_tokens_details?.cached_tokens ?? 0;
	return {
		// api semantics: input_tokens includes cache reads — subtract to match
		// the anthropic inputTokens convention the ctx% math assumes
		inputTokens: Math.max(0, input - cached),
		outputTokens: raw?.output_tokens ?? 0,
		cacheReadTokens: cached > 0 ? cached : undefined,
	};
}

export function createCodexResponsesProvider(options: CodexResponsesProviderOptions = {}): LLMProvider {
	const baseUrl = (options.baseUrl ?? process.env.OPENAI_CODEX_BASE_URL ?? DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const auth = options.auth ?? (() => getCodexAccessToken());

	return {
		name: "openai-codex",
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			if (request.signal?.aborted) return; // before auth: the refresh POST is not abortable (review F5)
			const credential = await auth();
			if (request.signal?.aborted) return;

			const body: Record<string, unknown> = {
				model: request.model,
				store: false,
				stream: true,
				instructions: request.system,
				input: toInputItems(request.system, request.messages),
				parallel_tool_calls: true,
				// NOTE: no max_output_tokens — the ChatGPT backend REJECTS it
				// ("Unsupported parameter", live 400 on the first real turn). The
				// reference implementation sends none either; output limits are
				// plan/policy-managed server-side. request.maxTokens is simply
				// not applicable to this family.
			};
			if (request.tools.length > 0) {
				body.tools = request.tools.map((t) => ({
					type: "function",
					name: t.name,
					description: t.description,
					parameters: t.parameters,
					strict: false,
				}));
				body.tool_choice = "auto";
			}

			const response = await postJsonWithRetry(
				`${baseUrl}/codex/responses`,
				{
					"content-type": "application/json",
					accept: "text/event-stream",
					authorization: `Bearer ${credential.accessToken}`,
					"chatgpt-account-id": credential.accountId,
					originator: "imp",
					"OpenAI-Beta": "responses=experimental",
				},
				JSON.stringify(body),
				request.signal,
				"Codex",
			);
			if (response === null) return; // aborted mid-connect
			if (!response.ok || !response.body) {
				const text = await response.text().catch(() => "");
				const hint =
					response.status === 401
						? " — run: imp login"
						: response.status === 404
							? " — check the model id (a Codex/ChatGPT model name, e.g. openai-codex/gpt-5.5)"
							: "";
				throw new Error(`OpenAI Codex API error ${response.status}${hint}: ${text.slice(0, 500)}`);
			}

			// Assembly state, keyed by the wire's output_index.
			const blocks: AssistantBlock[] = [];
			const slotByIndex = new Map<number, Extract<AssistantBlock, { type: "toolCall" } | { type: "text" }>>();
			const toolRawByIndex = new Map<number, string>();
			let usage: Usage = { inputTokens: 0, outputTokens: 0 };
			let stopReason: StopReason = null;
			let sawCompleted = false;

			for await (const sse of abortSafe(parseSse(response.body), request.signal)) {
				if (request.signal?.aborted) return;
				const data = sse.data as Record<string, unknown>;
				const outputIndex = data.output_index as number | undefined;

				switch (sse.event) {
					case "response.output_item.added": {
						const item = (data.item ?? {}) as Record<string, unknown>;
						if (item.type === "message") {
							const ours: Extract<AssistantBlock, { type: "text" }> = { type: "text", text: "" };
							slotByIndex.set(outputIndex ?? -1, ours);
							blocks.push(ours);
						} else if (item.type === "function_call") {
							const ours: Extract<AssistantBlock, { type: "toolCall" }> = {
								type: "toolCall",
								id: String(item.call_id ?? item.id ?? `call_${outputIndex}`),
								name: String(item.name ?? ""),
								arguments: {},
							};
							slotByIndex.set(outputIndex ?? -1, ours);
							blocks.push(ours);
							toolRawByIndex.set(outputIndex ?? -1, "");
							yield { type: "tool_call_start", id: ours.id, name: ours.name };
						}
						// reasoning items: intentionally ignored (v0.1 policy)
						break;
					}
					case "response.output_text.delta": {
						const slot = slotByIndex.get(outputIndex ?? -1);
						if (slot?.type === "text") {
							const delta = String(data.delta ?? "");
							slot.text += delta;
							yield { type: "text_delta", text: delta };
						}
						break;
					}
					case "response.function_call_arguments.delta": {
						const slot = slotByIndex.get(outputIndex ?? -1);
						if (slot?.type === "toolCall") {
							const delta = String(data.delta ?? "");
							if (delta !== "") {
								toolRawByIndex.set(outputIndex ?? -1, (toolRawByIndex.get(outputIndex ?? -1) ?? "") + delta);
								yield { type: "tool_call_delta", id: slot.id, jsonDelta: delta };
							}
						}
						break;
					}
					case "response.completed":
					case "response.incomplete": {
						sawCompleted = true;
						const responseObj = (data.response ?? {}) as Record<string, unknown>;
						usage = usageFromResponse(responseObj.usage as ResponsesUsage | undefined);
						const status = String(responseObj.status ?? "completed");
						if (sse.event === "response.incomplete" || status === "incomplete") {
							stopReason = "max_tokens";
						} else {
							stopReason = "end_turn";
						}
						break;
					}
					case "response.failed": {
						const responseObj = (data.response ?? {}) as Record<string, unknown>;
						const error = (responseObj.error ?? data.error ?? {}) as Record<string, unknown>;
						throw new Error(
							`Codex response failed: ${String(error.message ?? JSON.stringify(data).slice(0, 300))}`,
						);
					}
					case "error": {
						throw new Error(
							`Codex stream error: ${String(data.message ?? JSON.stringify(data).slice(0, 300))}`,
						);
					}
					default:
						// output_item.done / reasoning deltas / unknown: nothing to do
						break;
				}
			}

			for (const [index, raw] of toolRawByIndex) {
				const ours = slotByIndex.get(index);
				if (ours?.type === "toolCall") {
					ours.arguments = raw.trim() === "" ? {} : safeParseJson(raw);
				}
			}

			if (request.signal?.aborted) return;
			// A stream without a terminal event was truncated — fail loudly
			// rather than persisting a partial turn as complete.
			if (!sawCompleted) {
				throw new Error("Codex stream ended without response.completed — response may be truncated");
			}
			if (stopReason === null && blocks.some((b) => b.type === "toolCall")) stopReason = "tool_use";
			if (stopReason === "end_turn" && blocks.some((b) => b.type === "toolCall")) stopReason = "tool_use";
			if (blocks.length === 0) blocks.push({ type: "text", text: "(empty)" });
			yield { type: "message_end", message: { role: "assistant", blocks, usage, stopReason } };
		},
	};
}
