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
	/** Fires for every message that enters history (user, steering, assistant, tool results). */
	onMessage?: (message: AgentMessage) => void;
	/** Called between turns; may replace history contents in place (e.g. compaction). */
	onBeforeTurn?: (history: AgentMessage[]) => void | Promise<void>;
	/** Polls for steering messages: queued user input injected at turn boundaries. */
	getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
	/**
	 * Permission/observation gate: called after argument validation, before
	 * tool execution (M4c design §8.3). Return { block: true, reason } to
	 * veto — the model receives an isError tool result carrying the reason.
	 */
	onToolCall?: (
		call: { toolCallId: string; name: string; args: Record<string, unknown> },
		// biome-ignore lint/suspicious/noConfusingVoidType: a gate may return a decision, nothing (void), or undefined — sync or async (design §8.3)
	) => ToolCallDecision | void | undefined | Promise<ToolCallDecision | void | undefined>;
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
 * Returned (sync or async) by an onToolCall gate / "tool_call" extension
 * handler. Declared here in core — next to the option that will consume it —
 * so src/extensions/ can import it type-only and core keeps zero extension
 * knowledge (M4 design §6.1/§8.3).
 */
export interface ToolCallDecision {
	/** Block execution. true is the only meaningful value; omit/void = allow. */
	block: boolean;
	/** Fed back to the model as the (isError) tool result — make it teaching-style. */
	reason?: string;
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
		onMessage,
		onBeforeTurn,
		getSteeringMessages,
		onToolCall,
		onEvent,
		signal,
	} = options;

	if (userMessage !== undefined && userMessage !== "") {
		const user: AgentMessage = { role: "user", content: userMessage };
		history.push(user);
		onMessage?.(user);
	}

	const usage = emptyUsage();
	const toolMap = new Map(tools.map((t) => [t.name, t] as const));
	let turns = 0;

	while (true) {
		if (signal?.aborted) return { stopReason: "aborted", turns, usage };

		// Steering: messages queued while the model was working enter before the
		// next assistant response, so the model sees them without a new user turn.
		const steering = (await getSteeringMessages?.()) ?? [];
		for (const message of steering) {
			history.push(message);
			onMessage?.(message);
		}

		// Compaction hook: may rewrite history in place (older messages -> summary).
		await onBeforeTurn?.(history);

		const assistant = await streamAssistant({
			provider,
			request: { system, messages: history, tools, model, maxTokens, signal },
			onEvent,
			usage,
		});
		if (assistant === null) return { stopReason: "aborted", turns, usage };

		history.push(assistant);
		turns++;
		onMessage?.(assistant);

		const toolCalls = assistant.blocks.filter(
			(b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall",
		);

		if (toolCalls.length === 0) {
			return { stopReason: "completed", turns, usage };
		}

		if (turns >= maxIterations) {
			// Never executed: close the dangling tool_use ids so the session can be
			// resumed — an unanswered tool_call makes the next API request a 400.
			const results: ToolResult[] = [];
			fillMissingToolResults(toolCalls, results, "(not executed: reached max turns)");
			if (results.length > 0) {
				const toolResults: AgentMessage = { role: "toolResult", results };
				history.push(toolResults);
				onMessage?.(toolResults);
			}
			return { stopReason: "max_iterations", turns, usage };
		}

		const results: ToolResult[] = [];
		for (const call of toolCalls) {
			if (signal?.aborted) break;
			onEvent?.({ type: "tool_start", toolCallId: call.id, name: call.name, args: call.arguments });
			const result = await executeToolCall(call.id, call.name, call.arguments, toolMap, signal, onToolCall);
			results.push(result);
			onEvent?.({ type: "tool_end", result });
		}

		// Abort can stop mid-batch: synthesize results for tools that never ran,
		// so history (and the persisted session) always has complete tool_use →
		// tool_result pairs. Without this, a killed run becomes unresumable.
		fillMissingToolResults(toolCalls, results, "(interrupted before this tool ran)");

		if (results.length === 0) {
			// Aborted before any tool produced a result (unreachable with toolCalls > 0; guard kept).
			return { stopReason: "aborted", turns, usage };
		}
		const toolResults: AgentMessage = { role: "toolResult", results };
		history.push(toolResults);
		onMessage?.(toolResults);
	}
}

/**
 * Fill `results` with synthesized error results for tool calls that never
 * executed (abort mid-batch, max turns). Pure mutation — callers own the push.
 */
function fillMissingToolResults(
	toolCalls: Array<{ type: "toolCall"; id: string; name: string }>,
	results: ToolResult[],
	reason: string,
): void {
	const answered = new Set(results.map((r) => r.toolCallId));
	for (const call of toolCalls) {
		if (answered.has(call.id)) continue;
		results.push({ toolCallId: call.id, toolName: call.name, content: reason, isError: true });
	}
}

/**
 * Scan a persisted message list for tool_use blocks with no matching
 * toolResult and return ONE toolResult message that closes them all.
 * Used when the process is about to die (force quit) so the session stays
 * resumable — an unanswered tool_call makes the next API request a 400.
 */
export function synthesizeMissingToolResults(messages: AgentMessage[], reason: string): AgentMessage[] {
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			for (const result of message.results) answered.add(result.toolCallId);
		}
	}
	const dangling: Array<{ id: string; name: string }> = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.blocks) {
			if (block.type === "toolCall" && !answered.has(block.id)) {
				dangling.push({ id: block.id, name: block.name });
			}
		}
	}
	if (dangling.length === 0) return [];
	const results = dangling.map((call) => ({
		toolCallId: call.id,
		toolName: call.name,
		content: reason,
		isError: true,
	}));
	return [{ role: "toolResult", results }];
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
	// Stream ended without a message_end event: an abort ends the generator
	// early (abortSafe) — report that as a clean abort, not a protocol error.
	if (request.signal?.aborted) return null;
	throw new Error("Provider stream ended without a message_end event");
}

async function executeToolCall(
	id: string,
	name: string,
	args: unknown,
	toolMap: Map<string, Tool>,
	signal: AbortSignal | undefined,
	onToolCall: RunAgentLoopOptions["onToolCall"],
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

	// The gate (M4c design §8.3): post-validation, pre-execute, so handlers see
	// exactly what the tool will see. A block is a normal error result — it flows
	// through results.push → onMessage → session persistence, so the refusal is
	// resumable history and the run continues.
	const decision = await onToolCall?.({ toolCallId: id, name, args: record });
	if (decision?.block) {
		return {
			toolCallId: id,
			toolName: name,
			content: `Tool "${name}" blocked by an extension: ${decision.reason ?? "no reason given"}`,
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
