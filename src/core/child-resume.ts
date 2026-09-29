/**
 * SA-07 resume helpers (design: docs/sa-07-child-resume-design.md).
 *
 * Pure/semi-pure pieces of the resume pipeline: argument validation, the
 * current-environment assembly for SA-06's validator, the provider-identity
 * gate, the lifetime usage line, and the continuation-boundary transcript
 * repair + effective-history build. Orchestration (lease, run, record)
 * stays in task.ts.
 */
import { formatTokens } from "../format.js";
import type { ChildLaunchRecord, CurrentChildEnvironment, LaunchEnvironmentFacts } from "./child-launch.js";
import type { AgentMessage } from "./messages.js";
import type { SessionStore } from "./session/store.js";
import type { TaskRecord, TaskRecordUsage } from "./task-record.js";

/** Printed after every resume refusal. */
export const RESUME_REFUSAL_TAIL =
	"Start a new task instead (an independent review still requires a new fresh-context child).";

export type ResumeArgCheck = { ok: true; childId: string } | { ok: false; message: string };

/** §3.2 argument matrix — runs before any side effect. */
export function checkResumeArgs(args: {
	resume: unknown;
	agent: unknown;
	worktree: unknown;
	prompt: unknown;
	childSessions: boolean;
	hasParentSession: boolean;
}): ResumeArgCheck {
	if (typeof args.resume !== "string" || args.resume.trim() === "") {
		return { ok: false, message: "resume must be a child session id (from a previous task result)" };
	}
	const childId = args.resume.trim();
	if (args.agent !== undefined) {
		return {
			ok: false,
			message:
				"agent is immutable on resume — the child continues as its recorded role; drop the agent argument",
		};
	}
	if (args.worktree !== undefined) {
		return {
			ok: false,
			message:
				"worktree is immutable on resume — the continuation runs in the child's recorded cwd/worktree; drop the worktree argument",
		};
	}
	if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
		return { ok: false, message: "a resume needs a non-empty prompt (the child's next instruction)" };
	}
	if (!args.childSessions) {
		return {
			ok: false,
			message: "child sessions are disabled (IMP_CHILD_SESSIONS=0) — resume needs a persisted transcript",
		};
	}
	if (!args.hasParentSession) {
		return {
			ok: false,
			message: "resume requires an active parent session to resolve children against",
		};
	}
	return { ok: true, childId };
}

/** §5.2 provider-identity gate: model choice is frozen history, but the LIVE
 *  provider instance (the wire endpoint) must be the same one. */
export function providerMismatch(recorded: string, live: string): string | undefined {
	if (recorded === live) return undefined;
	return `the child ran on ${recorded}; the current provider is ${live} — resuming would send this transcript to a different endpoint. Switch back or start a fresh task.`;
}

/** §5 environment assembly for SA-06's validateChildContinuation. */
export function assembleCurrentChildEnvironment(sources: {
	launch: ChildLaunchRecord;
	launchEnvironment: LaunchEnvironmentFacts;
	cwd: string;
	agentResolver: (name: string) => { system: string } | undefined;
	childTools: ReadonlyArray<{ name: string; mcpServer?: string }>;
}): CurrentChildEnvironment {
	return {
		impVersion: sources.launchEnvironment.impVersion,
		systemText: sources.launchEnvironment.systemText,
		cwd: sources.cwd,
		agentResolver: sources.agentResolver,
		contextFiles: sources.launchEnvironment.contextFiles,
		promptFiles: sources.launchEnvironment.promptFiles,
		extensionContexts: sources.launchEnvironment.extensionContexts,
		extensions: sources.launchEnvironment.extensions,
		childTools: sources.childTools,
		binding: sources.launch.model,
	};
}

/** §9.2: lifetime usage summed from the parent-side records (never the
 *  transcript) plus this attempt. `≥` marks incompleteness: a summed record
 *  reports `incomplete`, a launched record has NO usage field at all, or
 *  this attempt is incomplete. */
export function lifetimeUsageLine(
	records: readonly TaskRecord[],
	current: TaskRecordUsage | undefined,
): string {
	const settled = records.filter((record) => record.launched);
	const attempts = settled.length + 1; // + this attempt
	let incomplete = current?.incomplete === true || current === undefined;
	const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
	if (current !== undefined) {
		sum.inputTokens += current.inputTokens;
		sum.outputTokens += current.outputTokens;
		sum.cacheReadTokens += current.cacheReadTokens ?? 0;
	}
	for (const record of settled) {
		const usage = record.usage;
		if (usage === undefined) {
			incomplete = true;
			continue;
		}
		sum.inputTokens += usage.inputTokens;
		sum.outputTokens += usage.outputTokens;
		sum.cacheReadTokens += usage.cacheReadTokens ?? 0;
		if (usage.incomplete === true) incomplete = true;
	}
	const cacheSegment = sum.cacheReadTokens > 0 ? ` / ${formatTokens(sum.cacheReadTokens)} cache` : "";
	return `(child lifetime: ${attempts} attempt${attempts === 1 ? "" : "s"}, ${
		incomplete ? "≥ " : ""
	}${formatTokens(sum.inputTokens)} in / ${formatTokens(sum.outputTokens)} out${cacheSegment})`;
}

/** §6.3 synthetic-result text. Never claims completion; isError is true. */
export const REPAIR_RESULT_MARKER =
	"[imp] this tool call was interrupted before a result was recorded — the outcome is unknown; it may have partially executed. Re-inspect or re-run it before relying on its effects.";

export type ContinuationHistory =
	| { ok: true; messages: AgentMessage[]; compactionBoundary: number; repairs: string[] }
	| { ok: false; problem: string };

interface ToolPairScan {
	missing: Array<{ id: string; name: string }>;
	repairable: boolean;
	problem?: string;
}

function scanToolPairs(messages: readonly AgentMessage[]): ToolPairScan {
	// SA-08 round 3 (F-5): validate the pairing in message ORDER with three
	// distinct structures (design §9). A duplicate call id, a result with no
	// PRECEDING call, and a repeated result cannot be paired unambiguously —
	// they refuse; only the confirmed crash tail is repairable.
	const seenCallIds = new Set<string>();
	const matchedIds = new Set<string>();
	const pending = new Map<string, { id: string; name: string }>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.blocks) {
				if (block.type !== "toolCall") continue;
				if (seenCallIds.has(block.id)) {
					return {
						missing: [],
						repairable: false,
						problem: `tool call ${block.id} is declared more than once — the transcript cannot be paired unambiguously (start a new task instead)`,
					};
				}
				seenCallIds.add(block.id);
				pending.set(block.id, { id: block.id, name: block.name });
			}
		} else if (message.role === "toolResult") {
			for (const result of message.results) {
				const id = result.toolCallId;
				if (!seenCallIds.has(id)) {
					return {
						missing: [],
						repairable: false,
						problem: `a tool result for ${id} has no preceding tool call — the transcript is not continuable (start a new task instead)`,
					};
				}
				if (matchedIds.has(id)) {
					return {
						missing: [],
						repairable: false,
						problem: `the tool result for ${id} is recorded more than once — the transcript is not continuable (start a new task instead)`,
					};
				}
				matchedIds.add(id);
				pending.delete(id);
			}
		}
	}
	const missing = [...pending.values()];
	if (missing.length === 0) return { missing, repairable: true };

	// The only repairable shape: the crash tail — every missing id belongs to
	// the LAST assistant message, and every message after it is a toolResult
	// message (a partial results message may follow A). Anything else means
	// real damage beyond a crash tail.
	let lastAssistantIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			lastAssistantIndex = i;
			break;
		}
	}
	const lastAssistant = lastAssistantIndex === -1 ? undefined : messages[lastAssistantIndex];
	const lastIds = new Set<string>();
	if (lastAssistant?.role === "assistant") {
		for (const block of lastAssistant.blocks) {
			if (block.type === "toolCall") lastIds.add(block.id);
		}
	}
	const allFromLast = missing.every(({ id }) => lastIds.has(id));
	const laterAllResults = messages.slice(lastAssistantIndex + 1).every((m) => m.role === "toolResult");
	if (lastAssistant === undefined || !allFromLast || !laterAllResults) {
		return {
			missing,
			repairable: false,
			problem: `the transcript is inconsistent beyond a crash tail (tool call ${missing[0]?.id ?? "?"} has no recorded result and is not part of the last assistant turn) — start a new task instead`,
		};
	}
	return { missing, repairable: true };
}

/**
 * §6: continuation-boundary repair + effective-history build, in the pinned
 * order — 6.1 read-only pairing scan (refusals here mutate nothing),
 * 6.2 make the file append-safe (torn final line), 6.3 close the crash-tail
 * orphan with explicit unknown-outcome results, then buildContext.
 */
export function buildContinuationHistory(store: SessionStore): ContinuationHistory {
	const first = store.buildContext();
	const scan = scanToolPairs(first.messages);
	if (!scan.repairable) {
		return { ok: false, problem: scan.problem ?? "the transcript is not continuable" };
	}
	const repairs: string[] = [];
	// Truncation is irreversible by design — it only ever removes bytes no
	// reader can interpret as a record (termination keeps a complete one).
	const torn = store.repairTornFinalLine();
	if (torn !== undefined) {
		repairs.push(
			torn.action === "truncated"
				? `dropped a ${torn.bytes}-byte torn tail`
				: "terminated an unterminated final record",
		);
	}
	if (scan.missing.length > 0) {
		store.appendMessage({
			role: "toolResult",
			results: scan.missing.map(({ id, name }) => ({
				toolCallId: id,
				toolName: name,
				content: REPAIR_RESULT_MARKER,
				isError: true,
			})),
		});
		repairs.push(
			`${scan.missing.length} interrupted tool call(s) closed with an explicit unknown-outcome result`,
		);
		const rebuilt = store.buildContext();
		return {
			ok: true,
			messages: rebuilt.messages,
			compactionBoundary: rebuilt.compactionBoundary,
			repairs,
		};
	}
	return { ok: true, messages: first.messages, compactionBoundary: first.compactionBoundary, repairs };
}
