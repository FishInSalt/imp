import { Value } from "typebox/value";
import type { LLMEvent, LLMProvider } from "../provider/types.js";
import {
	type AgentMessage,
	type AssistantMessage,
	addUsage,
	emptyUsage,
	type ToolResult,
	type Usage,
} from "./messages.js";
import type { Tool } from "./tools/types.js";

export type AgentEvent =
	| LLMEvent
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { type: "tool_end"; result: ToolResult };

export interface RunAgentLoopOptions {
	provider: LLMProvider;
	model: string;
	system: string;
	tools: Tool[];
	/** Conversation history. Appended in place with new messages from this run. */
	history: AgentMessage[];
	/** New user prompt. Omit to continue from existing history. */
	userMessage?: string;
	maxTokens?: number;
	/** Safety valve against runaway tool loops. Default 40. */
	maxIterations?: number;
	onEvent?: (event: AgentEvent) => void;
	signal?: AbortSignal;
}

export interface RunAgentLoopResult {
	stopReason: "completed" | "max_iterations" | "aborted";
	/** Assistant turns produced in this run. */
	turns: number;
	/** Aggregated token usage across all LLM calls in this run. */
	usage: Usage;
}

/**
 * The agent loop:
 *
 *   user message -> LLM (stream) -> assistant message
 *     -> if it contains tool calls: execute each, append tool results, call LLM again
 *     -> otherwise: done
 *
 * Everything the model does wrong (unknown tool, bad arguments, thrown errors)
 * is fed back to it as an error tool result instead of crashing the process.
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
	const {
		provider,
		model,
		system,
		tools,
		history,
		userMessage,
		maxTokens = 8192,
		maxIterations = 40,
		onEvent,
		signal,
	} = options;

	if (userMessage !== undefined && userMessage !== "") {
		history.push({ role: "user", content: userMessage });
	}

	const usage = emptyUsage();
	const toolMap = new Map(tools.map((t) => [t.name, t] as const));
	let turns = 0;

	while (true) {
		if (signal?.aborted) return { stopReason: "aborted", turns, usage };

		const assistant = await streamAssistant({
			provider,
			request: { system, messages: history, tools, model, maxTokens, signal },
			onEvent,
			usage,
		});
		if (assistant === null) return { stopReason: "aborted", turns, usage };

		history.push(assistant);
		turns++;

		const toolCalls = assistant.blocks.filter(
			(b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall",
		);

		if (toolCalls.length === 0) {
			return { stopReason: "completed", turns, usage };
		}

		if (turns >= maxIterations) {
			return { stopReason: "max_iterations", turns, usage };
		}

		const results: ToolResult[] = [];
		for (const call of toolCalls) {
			if (signal?.aborted) break;
			onEvent?.({ type: "tool_start", toolCallId: call.id, name: call.name, args: call.arguments });
			const result = await executeToolCall(call.id, call.name, call.arguments, toolMap, signal);
			results.push(result);
			onEvent?.({ type: "tool_end", result });
		}

		if (results.length === 0) {
			// Aborted before any tool produced a result.
			return { stopReason: "aborted", turns, usage };
		}
		history.push({ role: "toolResult", results });
	}
}

async function streamAssistant(args: {
	provider: LLMProvider;
	request: Parameters<LLMProvider["stream"]>[0];
	onEvent?: (event: AgentEvent) => void;
	usage: Usage;
}): Promise<AssistantMessage | null> {
	const { provider, request, onEvent, usage } = args;
	for await (const event of provider.stream(request)) {
		if (request.signal?.aborted) return null;
		onEvent?.(event);
		if (event.type === "message_end") {
			addUsage(usage, event.message.usage);
			return event.message;
		}
	}
	// Stream ended without a message_end event — treat as abort/protocol error.
	throw new Error("Provider stream ended without a message_end event");
}

async function executeToolCall(
	id: string,
	name: string,
	args: unknown,
	toolMap: Map<string, Tool>,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const tool = toolMap.get(name);
	if (!tool) {
		return {
			toolCallId: id,
			toolName: name,
			content: `Error: unknown tool "${name}". Available tools: ${[...toolMap.keys()].join(", ")}.`,
			isError: true,
		};
	}

	const record = args as Record<string, unknown>;
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		return {
			toolCallId: id,
			toolName: name,
			content: `Error: tool arguments must be a JSON object, got: ${JSON.stringify(args)?.slice(0, 200)}`,
			isError: true,
		};
	}

	if (!Value.Check(tool.parameters, record)) {
		const issues = [...Value.Errors(tool.parameters, record)]
			.slice(0, 5)
			.map((e) => `${(e as { instancePath?: string }).instancePath || "(root)"}: ${e.message}`)
			.join("; ");
		return {
			toolCallId: id,
			toolName: name,
			content: `Error: invalid arguments for ${name} — ${issues}. Fix the arguments and retry.`,
			isError: true,
		};
	}

	try {
		const result = await tool.execute(record, signal ?? new AbortController().signal);
		return {
			toolCallId: id,
			toolName: name,
			content: result.output,
			isError: result.isError ?? false,
		};
	} catch (err) {
		return {
			toolCallId: id,
			toolName: name,
			content: `Error: tool ${name} threw: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}
