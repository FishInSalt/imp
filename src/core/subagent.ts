import type { LLMProvider } from "../provider/types.js";
import { formatTokens } from "../format.js";
import { CHILD_MAX_TURNS, CHILD_TIMEOUT_MS } from "./constants.js";
import { runAgentLoop, type RunAgentLoopOptions, type RunAgentLoopResult } from "./loop.js";
import type { AgentMessage, Usage } from "./messages.js";
import type { Tool } from "./tools/types.js";

/**
 * Subagent engine (M5 design §4): a child agent loop with fresh context,
 * nested in-process. The task tool (tools/task.ts) owns session persistence
 * and the §3 result contract; this module only runs the child and classify
 * its outcome.
 */

/** Appended to the parent's system prompt. Reusing the parent's assembled
 * prompt keeps AGENTS.md/extension awareness in children; the suffix states
 * the one-shot contract — and that the child does NOT have the task tool,
 * even though the parent's §Tools list (which it inherits) advertises it. */
export const CHILD_SUFFIX = `

# Subagent mode
You are a one-shot subagent: your final message is returned verbatim to the
calling agent. Finish the task and answer — do not ask questions. You do not
have the task tool; complete the job yourself.`;

export interface SubagentOptions {
	provider: LLMProvider;
	model: string;
	/** The parent's assembled system prompt (AGENTS.md + extension contexts ride along). */
	system: string;
	/** The parent's tool pool — the caller filters out the task tool itself. */
	tools: Tool[];
	/** Self-contained task; becomes the child's first (and only) user message. */
	prompt: string;
	/** Agent profile body (M5c): appended AFTER CHILD_SUFFIX — append-only mode. */
	extraSystem?: string;
	signal?: AbortSignal;
	/** Wall-clock budget. Default CHILD_TIMEOUT_MS; injectable for tests. */
	timeoutMs?: number;
	/** Fires for every child message (the task tool persists its transcript). */
	onMessage?: (message: AgentMessage) => void;
	/** The parent's permission gate, forwarded to the child loop (M6a): a
	 * blocked call returns an isError tool result to the child, same semantics
	 * as the main loop. Concurrent children may interleave gate invocations —
	 * handlers must stay stateless per call. */
	onToolCall?: RunAgentLoopOptions["onToolCall"];
}

export type SubagentStatus =
	| "completed" // final assistant message carried text or not — text tells
	| "max_iterations" // hit CHILD_MAX_TURNS; text is the best-effort answer
	| "aborted" // parent signal aborted (user Ctrl+C)
	| "timeout" // the child's own clock fired; parent signal still live
	| "crash"; // provider/protocol error; partial recovery applies

export interface SubagentOutcome {
	status: SubagentStatus;
	/** Last assistant text (backward scan); undefined when the child said nothing. */
	text: string | undefined;
	/** Crash reason (status === "crash" only). */
	reason?: string;
	turns: number;
	usage: Usage;
}

/**
 * The child's last assistant text: scan messages backward, and within a
 * message take its first non-empty text block (pi's getFinalOutput shape).
 * A text-less final message falls back to earlier assistant messages.
 */
export function finalAssistantText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		for (const block of message.blocks) {
			if (block.type === "text" && block.text.trim() !== "") return block.text;
		}
	}
	return undefined;
}

function historyStats(messages: AgentMessage[]): { turns: number; usage: Usage } {
	// Recomputable from history — the loop's counters are unreachable when it
	// throws mid-run (crash path), so derive from what actually happened.
	const usage: Usage = { inputTokens: 0, outputTokens: 0 };
	let turns = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		turns++;
		usage.inputTokens += message.usage.inputTokens;
		usage.outputTokens += message.usage.outputTokens;
		usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (message.usage.cacheReadTokens ?? 0);
		usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (message.usage.cacheWriteTokens ?? 0);
	}
	return { turns, usage };
}

export async function runSubagent(options: SubagentOptions): Promise<SubagentOutcome> {
	const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
	const history: AgentMessage[] = [];

	// Composite abort: parent signal OR the child's own clock. A manual relay
	// (not AbortSignal.any) keeps engines ">=20" exactly true — any() needs
	// 20.3. Timeout is detectable afterwards: the clock fired, the parent
	// signal did not.
	const clock = AbortSignal.timeout(timeoutMs);
	const child = new AbortController();
	const relay = () => child.abort();
	options.signal?.addEventListener("abort", relay);
	clock.addEventListener("abort", relay);

	try {
		const result: RunAgentLoopResult = await runAgentLoop({
			provider: options.provider,
			model: options.model,
			system:
				options.system + CHILD_SUFFIX + (options.extraSystem ? `\n\n# Agent profile\n\n${options.extraSystem}` : ""),
			tools: options.tools,
			history,
			userMessage: options.prompt,
			maxIterations: CHILD_MAX_TURNS,
			onMessage: options.onMessage,
			onToolCall: options.onToolCall,
			signal: child.signal,
		});
		if (result.stopReason === "aborted") {
			const timedOut = !(options.signal?.aborted ?? false) && clock.aborted;
			return {
				status: timedOut ? "timeout" : "aborted",
				text: finalAssistantText(history),
				turns: result.turns,
				usage: result.usage,
			};
		}
		return {
			status: result.stopReason,
			text: finalAssistantText(history),
			turns: result.turns,
			usage: result.usage,
		};
	} catch (err) {
		// Provider/protocol error: partial recovery — whatever the child already
		// said survives (§3); the task tool decides error vs partial-result.
		const { turns, usage } = historyStats(history);
		return {
			status: "crash",
			reason: err instanceof Error ? err.message : String(err),
			text: finalAssistantText(history),
			turns,
			usage,
		};
	} finally {
		options.signal?.removeEventListener("abort", relay);
		clock.removeEventListener("abort", relay);
	}
}

/** Budget trailer for task results (design §3): `(child: 7 turns, 12.3k in / 1.4k out / 9.8k cache)`.
 *  An absent/zero cache read omits the segment — never "/ 0 cache". */
export function childUsageTrailer(turns: number, usage: Usage): string {
	const cache = usage.cacheReadTokens ?? 0;
	const cacheSegment = cache > 0 ? ` / ${formatTokens(cache)} cache` : "";
	return `(child: ${turns} turns, ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out${cacheSegment})`;
}
