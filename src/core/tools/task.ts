import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { firstLine } from "../../format.js";
import type { ProviderName } from "../../provider/resolve.js";
import type { LLMProvider } from "../../provider/types.js";
import type { AgentDefinition } from "../agents/registry.js";
import {
	buildChildLaunch,
	findChildByLaunch,
	type LaunchEnvironmentFacts,
	listChildLaunches,
	validateChildContinuation,
} from "../child-launch.js";
import { acquireChildLease } from "../child-lease.js";
import { type ChildModelBinding, resolveChildModel } from "../child-model.js";
import {
	assembleCurrentChildEnvironment,
	buildContinuationHistory,
	checkResumeArgs,
	lifetimeUsageLine,
	providerMismatch,
	RESUME_REFUSAL_TAIL,
} from "../child-resume.js";
import { defaultChildTimeoutMs, MAX_BYTES } from "../constants.js";
import type { AgentEvent, ToolCallDecision } from "../loop.js";
import type { AgentMessage } from "../messages.js";
import { createChildSession } from "../session/manager.js";
import type { SessionStore } from "../session/store.js";
import { childUsageTrailer, runSubagent, type SubagentOutcome } from "../subagent.js";
import {
	buildTaskRecord,
	collectTaskRecords,
	type TaskRecordTerminal,
	type TaskRecordTranscript,
	type TaskRecordWorktree,
} from "../task-record.js";
import {
	assessWorktreeRemoval,
	buildWorktreeNotice,
	buildWorktreeTrailer,
	type ChildWorktree,
	createChildWorktree,
	type RepoState,
	removeChildWorktree,
	resolveRepoState,
	type WorktreeRemovalAssessment,
	worktreeChangeStat,
} from "../worktree.js";
import { taskPresentation } from "./presentation.js";
import type { Tool, ToolExecuteResult } from "./types.js";

/**
 * The task tool (M5 design §3): delegate a self-contained job to a fresh
 * subagent. The child runs in-process (nested loop), shares the parent's cwd
 * and tool pool (minus task itself), and its final assistant message becomes
 * this tool's result — capped, trailed, and failure-taught per the contract.
 * SA-03: every result also carries a TaskRecord (../task-record.ts) — the
 * structured account persisted with the result message.
 */

const taskSchema = Type.Object({
	prompt: Type.String({
		description:
			"Complete, self-contained task for a fresh subagent. It sees nothing of this conversation; include all needed context (paths, what to return). Keep the prompt focused (~300 words max): the child re-reads files itself; pasting repo context into the prompt wastes its context window.",
	}),
	resume: Type.Optional(
		Type.String({
			description:
				"Child session id from a previous task result — continue that settled child with this prompt as its next instruction. Role, model, cwd and worktree are immutable on resume.",
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Named agent to run (see <advertised_agents> in the system prompt if present); omit for a generic subagent",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1000,
			description:
				"Optional wall-clock budget in ms for the child run. REPL default: no limit (Ctrl+C is the backstop); print/headless runs default to 60 min. Set only for tasks expected to be cheap.",
		}),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Run in an isolated git worktree (own checkout, own branch; requires a git repository). Use for writing tasks that must not touch the current files; the result names the branch to merge. Requires the git repository to have at least one commit.",
		}),
	),
});

export interface TaskToolOptions {
	/** Read at spawn: `/model` may swap the protocol family mid-session —
	 *  children must inherit whatever is current, not the construction-time
	 *  instance (multi-provider review P1-1). */
	getProvider: () => LLMProvider;
	/** Read at spawn: `/model` writes the runner's model mid-session. */
	getModel: () => string;
	/** Current canonical provider/model reference; family-exact when supplied
	 *  (the real runner always wires it). The getModel() fallback is a
	 *  documented approximation — SA-02 design D1. */
	getModelReference?: () => string;
	/** Read at spawn: `/new`/`/resume` re-assemble the system prompt. */
	getSystem: () => string;
	/** SA-06: launch-environment facts read at spawn (retained assembly
	 *  sources + extension identities). Absent → no launch block is written
	 *  and the child is conservatively not resumable. */
	getLaunchEnvironment?: () => LaunchEnvironmentFacts;
	/** The parent's tool array; task itself is filtered out of the child pool. */
	getTools: () => Tool[];
	/** Project `.imp/agents` exists but was skipped by the trust gate — the
	 *  roster must say so instead of "no agents are defined" (M8 review). */
	agentsProjectGated?: boolean;
	/** Current parent session — children link to it and live beside it. Null when sessions are disabled. */
	getSession: () => SessionStore | null;
	/** Hermetic tests: session base dir override (passed through to the session manager). */
	sessionBaseDir?: string;
	/** Transcript opt-out (IMP_CHILD_SESSIONS=0). Default: env, read once. */
	childSessions?: boolean;
	/** Injectable wall clock for tests. */
	timeoutMs?: number;
	/** M15: the runner's resolved auto-compaction decision (env > project
	 *  settings > global settings > on) — read at spawn like getModel. */
	getAutoCompact?: () => boolean;
	/** The parent's permission gate, forwarded into the child loop (M6a).
	 * Receives the call plus which named agent (if any) is running and the
	 * child's working directory — the worktree path when isolation is active
	 * (M6b) — the caller marks the event as subagent-sourced. */
	onToolCall?: (
		call: { toolCallId: string; name: string; args: Record<string, unknown> },
		info: { agent?: string; cwd?: string },
		// biome-ignore lint/suspicious/noConfusingVoidType: mirrors the loop's gate contract — a gate may return a decision, nothing (void), or undefined
	) => Promise<ToolCallDecision | void | undefined> | ToolCallDecision | void | undefined;
	/** Observes the child's tool events (tool_start/tool_end) with the same
	 * agent and cwd context as onToolCall (M6a audit path). */
	onEvent?: (
		event: AgentEvent,
		info: { agent?: string; cwd?: string; sourceId: string; taskToolCallId?: string },
	) => void;
	/** The parent's working directory — worktree children resolve the repo
	 * from here (M6b). Defaults to process.cwd() at spawn time. */
	cwd?: string;
	/** Rebuild the builtin tool pool rooted at another cwd (M6b worktree
	 * children). Returning undefined falls back to the parent pool minus task. */
	getToolsForCwd?: (cwd: string) => Tool[] | undefined;
	/** SA-02: rebuild the child's tool pool bound to the CHILD's model (the
	 *  read tool's image gate must follow the child, not the parent). At the
	 *  parent cwd the runner swaps only its own read instance (extensions and
	 *  custom tools ride along); at a worktree cwd it rebuilds the builtins.
	 *  Absent → the older wiring keeps its (parent-bound) bindings. */
	getToolsForChild?: (
		cwd: string,
		binding: { providerName: ProviderName; modelId: string },
	) => Tool[] | undefined;
	/** Test seam: worktree base dir override (IMP_WORKTREE_DIR in production). */
	worktreeBaseDir?: string;
	/** Registered agents (M5c); the runner loads them from disk, tests inject. */
	agents?: readonly AgentDefinition[];
	/** Test-only seam (SA-08 reopened F-1): invoked after validation and
	 *  before the single-writer lease is acquired in the resume branch, so a
	 *  test can deterministically interleave another executor's completed
	 *  round between the lookup and the acquire. Production never sets it. */
	onBeforeResumeLease?: () => void | Promise<void>;
}

/** SA-01: what the cleanup attempt did — drives the result text (design §D5). */
type CleanupOutcome =
	| { state: "removed" }
	| { state: "failed"; errors: string[] }
	| { state: "kept"; assessment: Exclude<WorktreeRemovalAssessment, { verdict: "clean" }> };

/** SA-01: assess-then-maybe-remove. Auto-removal happens ONLY on a positively
 *  clean assessment; a failed check or failed removal preserves the worktree. */
async function attemptWorktreeCleanup(wt: ChildWorktree, repo: RepoState): Promise<CleanupOutcome> {
	const assessment = await assessWorktreeRemoval(wt, repo);
	if (assessment.verdict !== "clean") return { state: "kept", assessment };
	const errors = await removeChildWorktree(wt, repo);
	return errors.length === 0 ? { state: "removed" } : { state: "failed", errors };
}

/** SA-01 §D5: a failed removal names what may remain and claims nothing about
 *  the tree (also covers the half-removed case: dir gone, branch delete failed). */
function cleanupFailureNote(errors: string[], wt: ChildWorktree): string {
	return `[task] worktree cleanup failed: ${errors.join("; ")}. The worktree or its branch may still exist: ${wt.path}, branch ${wt.branch}.`;
}

/** SA-01 §D5: retained but not verified — never claims "changes kept". */
function keptForSafetyNote(
	assessment: Exclude<WorktreeRemovalAssessment, { verdict: "clean" }>,
	wt: ChildWorktree,
): string {
	return `[task] worktree kept for safety: ${assessment.detail}. Path: ${wt.path}, branch ${wt.branch}. Nothing was deleted.`;
}

/** The note the setup-error paths append ("" when the worktree was removed). */
function cleanupOutcomeNote(cleanup: CleanupOutcome, wt: ChildWorktree): string {
	if (cleanup.state === "failed") return cleanupFailureNote(cleanup.errors, wt);
	if (cleanup.state === "kept") return keptForSafetyNote(cleanup.assessment, wt);
	return "";
}

/** SA-03: transcript facts — only what the store can attest to. `writeFailed`
 *  is the observed-failure flag (message appends AND compaction checkpoints);
 *  an unpersisted store WITHOUT an observed failure is `no-content`, never a
 *  fabricated error. */
function transcriptFor(
	session: SessionStore | null,
	childSessions: boolean,
	writeFailed: boolean,
): TaskRecordTranscript {
	if (session?.isPersisted) {
		return writeFailed
			? { present: true, path: session.filePath, writeFailed: true }
			: { present: true, path: session.filePath };
	}
	if (session !== null) return { present: false, why: writeFailed ? "write-failed" : "no-content" };
	return { present: false, why: childSessions ? "no-parent-session" : "disabled" };
}

/** SA-03 D7: observe the child session's write failures for this attempt —
 *  message appends AND compaction checkpoints (`compactSession` writes solely
 *  through `appendCompaction`). A throw sets the fact flag and is re-thrown
 *  unchanged: control flow stays exactly as before (a message failure crashes
 *  the child loop; a compaction failure is caught by `compactChildHistory` and
 *  the child continues un-compacted). */
function observeSessionWrites(session: SessionStore, onFailure: () => void): void {
	const appendMessage = session.appendMessage.bind(session);
	session.appendMessage = (message: AgentMessage) => {
		try {
			return appendMessage(message);
		} catch (err) {
			onFailure();
			throw err;
		}
	};
	const appendCompaction = session.appendCompaction.bind(session);
	session.appendCompaction = (...args: Parameters<SessionStore["appendCompaction"]>) => {
		try {
			return appendCompaction(...args);
		} catch (err) {
			onFailure();
			throw err;
		}
	};
}

/** SA-03: the cleanup outcome in structured form (SA-01's layered honesty). */
function worktreeRecord(wt: ChildWorktree, cleanup: CleanupOutcome): TaskRecordWorktree {
	const base = { path: wt.path, branch: wt.branch };
	if (cleanup.state === "removed") return { ...base, disposition: "removed" };
	if (cleanup.state === "failed") {
		return { ...base, disposition: "removal-failed", detail: cleanup.errors.join("; ") };
	}
	return cleanup.assessment.verdict === "work-present"
		? { ...base, disposition: "kept-work", detail: cleanup.assessment.detail }
		: { ...base, disposition: "kept-unknown", detail: cleanup.assessment.detail };
}

/** Byte-accurate tail cut that never splits a UTF-8 sequence. */
function tailTruncate(text: string): { text: string; dropped: number } {
	const total = Buffer.byteLength(text, "utf8");
	if (total <= MAX_BYTES) return { text, dropped: 0 };
	const buf = Buffer.from(text, "utf8");
	const tail = buf.subarray(buf.length - MAX_BYTES);
	// Skip a leading partial sequence (continuation bytes 10xxxxxx), max 3.
	let start = 0;
	while (start < 3 && start < tail.length && (tail[start] ?? 0) >>> 6 === 0b10) {
		start++;
	}
	const kept = tail.length - start;
	return { text: tail.subarray(start).toString("utf8"), dropped: total - kept };
}

/** SA-07: one tool-pool selection for fresh and resumed children — rebuild
 *  the pool for the child's cwd/binding (a worktree child REQUIRES a
 *  rebuilt pool; a shared-cwd child falls back to the parent pool), apply
 *  the agent's `tools:` allowlist narrowing, and drop `task` itself — the
 *  drop is CANONICAL for both paths (the pre-SA-07 worktree path did not
 *  re-filter; no shipped wiring ever puts `task` in a rebuilt pool, and the
 *  helper makes the rule explicit so the executed pool and the recorded
 *  contract stay one projection). Fresh
 *  dispatch and resume must share this: the launch record stores the
 *  NARROWED array, so rebuilding without the allowlist would refuse every
 *  allowlisted agent with a false tools-drift. */
function selectChildToolPool(input: {
	agent: AgentDefinition | undefined;
	cwd: string;
	binding: ChildModelBinding;
	parentPool: Tool[];
	requireRebuild: boolean;
	rebuild: (cwd: string, binding: { providerName: ProviderName; modelId: string }) => Tool[] | undefined;
}): Tool[] | { output: string; isError: true } {
	const rebuilt = input.rebuild(input.cwd, {
		providerName: input.binding.providerName,
		modelId: input.binding.wireModelId,
	});
	const pool = rebuilt ?? (input.requireRebuild ? undefined : input.parentPool);
	if (pool === undefined) {
		return {
			output:
				"worktree isolation is not available in this host (no per-directory tool pool wired) — retry the task without the worktree option.",
			isError: true,
		};
	}
	const filtered = pool.filter((tool) => tool.name !== "task");
	if (input.agent?.tools === undefined) return filtered;
	const byName = new Map(filtered.map((tool) => [tool.name, tool] as const));
	const unknown = input.agent.tools.filter((name) => !byName.has(name));
	if (unknown.length > 0) {
		return {
			output: `agent "${input.agent.name}" lists unknown tools: ${unknown.join(", ")}. Available: ${filtered
				.map((tool) => tool.name)
				.join(", ")}.`,
			isError: true,
		};
	}
	return input.agent.tools.map((name) => byName.get(name)).filter((tool) => tool !== undefined);
}

/** SA-07 §4.3: the child's most recent recorded worktree disposition (for
 *  the resume result's retention line — "deliberately kept" must not be
 *  conflated with "kept because the assessment was uncertain/failed"). */
function lastWorktreeDisposition(
	parent: SessionStore,
	childId: string,
): TaskRecordWorktree["disposition"] | undefined {
	const records = collectTaskRecords(parent.getEntries()).filter((record) => record.childId === childId);
	for (let i = records.length - 1; i >= 0; i--) {
		const worktree = records[i]?.worktree;
		if (worktree !== undefined) return worktree.disposition;
	}
	return undefined;
}

export function createTaskTool(options: TaskToolOptions): Tool {
	const childSessions = options.childSessions ?? process.env.IMP_CHILD_SESSIONS !== "0";
	const timeoutMs = options.timeoutMs;
	const agents = options.agents ?? [];
	const agentsByName = new Map(agents.map((a) => [a.name, a] as const));
	return {
		name: "task",
		presentation: taskPresentation,
		concurrencySafe: true,
		promptSnippet: "delegate a self-contained multi-step job to a fresh subagent.",
		// prompt-audit P8: the roster moved to the <advertised_agents> system
		// block (capped, escaped, budgeted) — a dynamic description defeats
		// provider tool-schema caching and grows unbounded with agent count.
		description:
			"Delegate a self-contained task to a fresh subagent with its own context window. The prompt is all the subagent sees — include every path and detail it needs and what to return. Its final message becomes the tool result. Prefer this for multi-step exploration (searches, file reads, research) that would otherwise bloat this conversation; keep one-shot questions here. Several task calls in one turn run concurrently — delegate only INDEPENDENT subtasks; jobs that modify the same files must be delegated one at a time. Named agents are listed in the system prompt's <advertised_agents> block.",
		parameters: taskSchema,

		async execute(args, signal, context): Promise<ToolExecuteResult> {
			// One observer namespace per invocation, independent of labels and sessions.
			const sourceId = randomUUID();
			// SA-03: per-execute attempt identity — the record's unique key.
			const attemptId = randomUUID();
			const taskToolCallId = context?.toolCallId;
			// Read once: the record reports it and the child session links to it.
			const parentStore = options.getSession();
			// Child cwd for gate events and the SA-03 record (M6b): the worktree
			// path when isolation is active, otherwise the parent's cwd — gates
			// resolve paths against the loop that executes the call. A rejection
			// reports the parent cwd (no child ran; the worktree field names the
			// created-and-removed path separately).
			const parentCwd = options.cwd ?? process.cwd();
			let childCwd = parentCwd;
			// SA-03: the record accumulator. Fields are set progressively as the
			// call resolves; EVERY return path goes through finish(), which takes
			// the terminal facts explicitly (rejection paths included).
			const rec: {
				childId?: string;
				agent?: string;
				tools?: string[];
				timeoutMs?: number;
				binding?: ChildModelBinding;
				launched?: boolean;
				transcript?: TaskRecordTranscript;
				worktree?: TaskRecordWorktree;
			} = {};
			// Resolve the named agent (if any) before any side effects.
			const wanted = typeof args.agent === "string" && args.agent !== "" ? args.agent : undefined;
			const agent = wanted === undefined ? undefined : agentsByName.get(wanted);
			const rejectTerminal = (output: string): TaskRecordTerminal => ({
				status: "rejected",
				reason: firstLine(output),
				turns: 0,
				textPresent: false,
			});
			const finish = (result: ToolExecuteResult, terminal: TaskRecordTerminal): ToolExecuteResult => ({
				...result,
				taskRecord: buildTaskRecord({
					sourceId,
					attemptId,
					taskToolCallId,
					parentSessionId: parentStore?.header.id,
					childId: rec.childId,
					launched: rec.launched === true,
					agent: rec.agent ?? agent?.name,
					binding: rec.binding,
					cwd: rec.launched === true ? childCwd : parentCwd,
					tools: rec.tools,
					timeoutMs: rec.timeoutMs,
					status: terminal.status,
					reason: terminal.reason,
					turns: terminal.turns,
					textPresent: terminal.textPresent,
					transcript: rec.transcript,
					worktree: rec.worktree,
					usage: terminal.usage,
				}),
			});

			// --- SA-07: resume a settled child ---------------------------------
			// Design: docs/sa-07-child-resume-design.md. Everything below runs
			// BEFORE fresh-dispatch resolution (agent/model/tools/worktree), and
			// every path either refuses with no side effect or runs the attempt.
			if (args.resume !== undefined) {
				const check = checkResumeArgs({
					resume: args.resume,
					agent: args.agent,
					worktree: args.worktree,
					prompt: args.prompt,
					childSessions,
					hasParentSession: parentStore !== null,
				});
				if (!check.ok) {
					return finish({ output: check.message, isError: true }, rejectTerminal(check.message));
				}
				if (parentStore === null) {
					const output = "resume requires an active parent session to resolve children against";
					return finish({ output, isError: true }, rejectTerminal(output));
				}
				const refuse = (output: string): ToolExecuteResult =>
					finish({ output, isError: true }, rejectTerminal(output));

				// §4.1 step 2: managed lookup (SA-06).
				const found = findChildByLaunch(parentStore, check.childId);
				if (!found.ok) {
					let output = `cannot resume child "${check.childId}": ${found.message}`;
					if (found.code === "not-found") {
						const candidates = listChildLaunches(parentStore).filter((entry) => entry.id !== undefined);
						output +=
							candidates.length > 0
								? `\nthis session's children: ${candidates
										.map((entry) => `${entry.id} (${entry.status})`)
										.join(", ")}`
								: "\nthis session has no recorded children";
					}
					return refuse(`${output}\n${RESUME_REFUSAL_TAIL}`);
				}
				const file = found.file;
				const launch = file.launch;

				// §4.1 step 3: current environment + provider-identity gate.
				const env = options.getLaunchEnvironment?.();
				if (env === undefined) {
					return refuse(
						`cannot resume child "${launch.childId}": this host does not expose the launch-environment facts needed to validate it.\n${RESUME_REFUSAL_TAIL}`,
					);
				}
				const liveProvider = options.getProvider();
				const mismatch = providerMismatch(launch.model.providerName, liveProvider.name);
				if (mismatch !== undefined) {
					return refuse(`cannot resume child "${launch.childId}": ${mismatch}`);
				}
				// §5.1: rebuild the tool pool with the SAME selection rules fresh
				// dispatch uses (including the agent allowlist narrowing).
				const resumeAgent = launch.agent === undefined ? undefined : agentsByName.get(launch.agent.name);
				const parentPool = options.getTools().filter((tool) => tool.name !== "task");
				const poolSelection = selectChildToolPool({
					agent: resumeAgent,
					cwd: launch.cwd,
					binding: launch.model,
					parentPool,
					requireRebuild: launch.worktree !== undefined,
					rebuild: (cwd, childBinding) =>
						options.getToolsForChild?.(cwd, childBinding) ?? options.getToolsForCwd?.(cwd),
				});
				if ("isError" in poolSelection) {
					return refuse(
						`cannot resume child "${launch.childId}": ${poolSelection.output}\n${RESUME_REFUSAL_TAIL}`,
					);
				}
				const tools = poolSelection;

				// §4.1 step 4: SA-06 validation, AND-ed with the settled state.
				const current = assembleCurrentChildEnvironment({
					launch,
					launchEnvironment: env,
					cwd: options.cwd ?? process.cwd(),
					agentResolver: (name) => {
						const definition = agentsByName.get(name);
						return definition === undefined ? undefined : { system: definition.system };
					},
					childTools: tools.map((tool) =>
						tool.mcpServer === undefined
							? { name: tool.name }
							: { name: tool.name, mcpServer: tool.mcpServer },
					),
				});
				const verdict = await validateChildContinuation(file, parentStore, current);
				if (!verdict.resumable || verdict.executionState !== "settled") {
					const reasonLines = verdict.reasons.map((reason) => `- ${reason.code}: ${reason.message}`);
					const lead =
						verdict.reasons.length > 0
							? `resume validation refused (${verdict.reasons.length} reason(s)):`
							: "it may still be running, or the process died before any parent-side write";
					const output = `cannot resume child "${launch.childId}": ${lead}${
						reasonLines.length > 0 ? `\n${reasonLines.join("\n")}` : ""
					}\n${RESUME_REFUSAL_TAIL}`;
					return refuse(output);
				}

				// SA-08 reopened F-1: test seam — the deterministic interleaving
				// point (another executor completes here) that the fix must
				// survive. Inert in production (never set).
				if (options.onBeforeResumeLease !== undefined) await options.onBeforeResumeLease();

				// §4.1 step 5: single-writer lease, AND-ed with resumable.
				const acquired = acquireChildLease(file.filePath, attemptId);
				if (!acquired.ok) {
					return refuse(
						`cannot resume child "${launch.childId}": ${acquired.message}\n${RESUME_REFUSAL_TAIL}`,
					);
				}
				const lease = acquired.lease;
				let leaseAnomaly = false;
				const attemptAbort = new AbortController();
				const relayAbort = () => attemptAbort.abort();
				// The try opens the instant the lease is held: EVERY refusal or
				// throw from here on releases it in finally.
				try {
					if (signal.aborted) attemptAbort.abort();
					else signal.addEventListener("abort", relayAbort);
					lease.startHeartbeat(() => {
						leaseAnomaly = true;
						attemptAbort.abort();
					});

					// §4.1 steps 6–7: repair + effective history (nothing mutates
					// the child file before the repair's own append-safe step).
					const history = buildContinuationHistory(file.store);
					if (!history.ok) {
						return refuse(`cannot resume child "${launch.childId}": ${history.problem}`);
					}
					let transcriptWriteFailed = false;
					observeSessionWrites(file.store, () => {
						transcriptWriteFailed = true;
					});
					const resumeTimeout =
						(args.timeoutMs as number | undefined) ??
						resumeAgent?.timeoutMs ??
						timeoutMs ??
						defaultChildTimeoutMs();
					rec.launched = true;
					rec.childId = launch.childId;
					rec.agent = launch.agent?.name;
					rec.binding = launch.model;
					rec.tools = tools.map((tool) => tool.name);
					rec.timeoutMs = resumeTimeout;
					childCwd = launch.cwd;

					// §4.1 step 8: the attempt — recorded contract, live gate,
					// effective history seeded, ONE new instruction pushed by the loop.
					const outcome = await runSubagent({
						autoCompact: options.getAutoCompact?.(),
						provider: liveProvider,
						model: launch.model.wireModelId,
						modelReference: launch.model.reference,
						system: options.getSystem(),
						extraSystem: resumeAgent?.system,
						tools,
						prompt: String(args.prompt),
						signal: attemptAbort.signal,
						timeoutMs: resumeTimeout,
						session: file.store,
						initialHistory: history.messages,
						initialFloor: history.compactionBoundary,
						onMessage: (message: AgentMessage) => file.store.appendMessage(message),
						onToolCall: options.onToolCall
							? (call) => options.onToolCall?.(call, { agent: launch.agent?.name, cwd: launch.cwd })
							: undefined,
						onEvent: options.onEvent
							? (event) =>
									options.onEvent?.(event, {
										agent: launch.agent?.name,
										cwd: launch.cwd,
										sourceId,
										...(taskToolCallId === undefined ? {} : { taskToolCallId }),
									})
							: undefined,
					});
					rec.transcript = transcriptFor(file.store, childSessions, transcriptWriteFailed);
					if (launch.worktree !== undefined) {
						rec.worktree = {
							path: launch.worktree.path,
							branch: launch.worktree.branch,
							disposition: "kept-unknown",
							detail: "resume attempt — worktrees are never auto-removed on resume",
						};
					}
					const terminal: TaskRecordTerminal = {
						status: outcome.status,
						reason: outcome.reason,
						turns: outcome.turns,
						textPresent: outcome.text !== undefined,
						usage: outcome.usageDetail.incomplete ? { ...outcome.usage, incomplete: true } : outcome.usage,
					};

					// §4.3: result composition (base classification + resume lines).
					const base = taskResult(outcome, file.store, resumeTimeout, String(args.prompt));
					const lines: string[] = [];
					if (history.repairs.length > 0) {
						lines.push(`transcript repaired: ${history.repairs.join("; ")}.`);
					}
					if (launch.worktree !== undefined) {
						let line = `worktree kept at ${launch.worktree.path} (branch ${launch.worktree.branch}) — resume attempts do not remove it; merge ${launch.worktree.branch} when done.`;
						const prior = lastWorktreeDisposition(parentStore, launch.childId);
						if (prior === "kept-work" || prior === "removal-failed") {
							line += ` (the previous attempt recorded: ${prior})`;
						}
						lines.push(line);
					}
					lines.push(
						"files may have changed since the previous attempt — re-inspect before relying on earlier observations.",
					);
					if (leaseAnomaly) {
						lines.push(
							"attempt stopped: its lease was taken over (lease anomaly) — another attempt may be resuming this child.",
						);
					}
					lines.push(
						lifetimeUsageLine(
							collectTaskRecords(parentStore.getEntries()).filter(
								(record) => record.childId === launch.childId,
							),
							terminal.usage,
						),
					);
					return finish({ ...base, output: `${base.output}\n${lines.join("\n")}` }, terminal);
				} finally {
					signal.removeEventListener("abort", relayAbort);
					lease.release();
				}
			}
			// --- end SA-07 resume ------------------------------------------

			if (wanted !== undefined && agent === undefined) {
				const available = agents.length
					? `Available agents: ${agents.map((a) => a.name).join(", ")} (defined in .imp/agents/ and ~/.imp/agents/).`
					: options.agentsProjectGated === true
						? "No agents are loaded — this directory's .imp/agents was skipped because the directory is not trusted (review it, then restart with: imp --trust)."
						: "No agents are defined (create .imp/agents/*.md or ~/.imp/agents/*.md).";
				const output = `unknown agent "${wanted}". ${available}`;
				return finish({ output, isError: true }, rejectTerminal(output));
			}

			// SA-02: resolve the child model ONCE, before any side effect — a
			// rejected configuration must not create a worktree, a child session,
			// or a provider call. Wire requests use binding.wireModelId; every
			// metadata lookup uses binding.reference.
			const resolution = resolveChildModel({
				parentReference: options.getModelReference?.() ?? options.getModel(),
				override: agent?.model,
				agentName: agent?.name,
			});
			if (!resolution.ok)
				return finish({ output: resolution.error, isError: true }, rejectTerminal(resolution.error));
			const binding = resolution.binding;
			rec.binding = binding;

			// Tools narrowing first (review B1): it can only reject, never touch
			// the filesystem — running it before worktree creation means no
			// teaching error can leak a created worktree.
			const parentPool = options.getTools().filter((tool) => tool.name !== "task");

			// Worktree isolation (M6b): agent frontmatter default, call override.
			const wantWorktree =
				args.worktree === true || (args.worktree === undefined && agent?.worktree === true);
			let wt: ChildWorktree | undefined;
			let repo: RepoState | undefined;
			let cleanup: CleanupOutcome | undefined;
			let prompt = String(args.prompt);
			let tools: Tool[];
			if (wantWorktree) {
				const cwd = options.cwd ?? process.cwd();
				try {
					repo = await resolveRepoState(cwd);
					wt = await createChildWorktree(
						repo,
						`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
						options.worktreeBaseDir,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return finish({ output: message, isError: true }, rejectTerminal(message));
				}
				// Subdirectory parents keep their relative position inside the
				// worktree (pi's agentCwd pattern): relative paths keep working.
				const agentCwd = repo.cwdRelative ? path.join(wt.path, repo.cwdRelative) : wt.path;
				childCwd = agentCwd;
				prompt += buildWorktreeNotice(wt, agentCwd, cwd);
				// A worktree child without a per-cwd pool would inherit tools
				// rooted at the PARENT cwd — silently violating the isolation
				// this feature exists to provide. A missing function AND an
				// undefined return both fail loudly (review nit 3).
				const selection = selectChildToolPool({
					agent,
					cwd: agentCwd,
					binding,
					parentPool,
					requireRebuild: true,
					rebuild: (cwd, childBinding) =>
						options.getToolsForChild?.(cwd, childBinding) ?? options.getToolsForCwd?.(cwd),
				});
				if ("isError" in selection) {
					// SA-01: the fresh worktree is rolled back only when it is
					// positively clean; a failed check or a failed removal is
					// reported instead of silently leaking or losing it.
					const attempt = await attemptWorktreeCleanup(wt, repo);
					rec.worktree = worktreeRecord(wt, attempt);
					const note = cleanupOutcomeNote(attempt, wt);
					const output = note ? `${selection.output}\n${note}` : selection.output;
					return finish({ output, isError: true }, rejectTerminal(output));
				}
				tools = selection;
				rec.tools = selection.map((tool) => tool.name);
			} else {
				// SA-02: prefer the child-bound pool; fall back to the parent pool
				// (custom wirings that predate the seam keep their bindings).
				const selection = selectChildToolPool({
					agent,
					cwd: childCwd,
					binding,
					parentPool,
					requireRebuild: false,
					rebuild: (cwd, childBinding) => options.getToolsForChild?.(cwd, childBinding),
				});
				if ("isError" in selection) return finish(selection, rejectTerminal(selection.output));
				tools = selection;
				rec.tools = selection.map((tool) => tool.name);
			}
			// #subagent-softlanding rev 4 precedence: call args > agent
			// frontmatter > mode default (TTY: undefined = unlimited).
			const effectiveTimeout =
				(args.timeoutMs as number | undefined) ?? agent?.timeoutMs ?? timeoutMs ?? defaultChildTimeoutMs();
			rec.timeoutMs = effectiveTimeout;

			let session: SessionStore | null = null;
			let outcome: SubagentOutcome;
			// SA-03 D7: any observed session-write failure (message append or
			// compaction checkpoint) sets the fact flag; control flow unchanged.
			let transcriptWriteFailed = false;
			try {
				if (childSessions && parentStore !== null) {
					session = createChildSession(parentStore, options.sessionBaseDir, (childId) => {
						const env = options.getLaunchEnvironment?.();
						if (env === undefined) return undefined;
						return buildChildLaunch({
							parentSessionId: parentStore.header.id,
							childId,
							impVersion: env.impVersion,
							...(agent === undefined
								? {}
								: { agent: { name: agent.name, system: agent.system, source: agent.source } }),
							model: binding,
							cwd: childCwd,
							...(wt === undefined || repo === undefined
								? {}
								: {
										worktree: {
											repoRoot: repo.root,
											baseline: repo.head,
											path: wt.path,
											branch: wt.branch,
											...(wt.creationReflog === undefined ? {} : { creationReflog: wt.creationReflog }),
										},
									}),
							tools: tools.map((tool) =>
								tool.mcpServer === undefined
									? { name: tool.name }
									: { name: tool.name, mcpServer: tool.mcpServer },
							),
							systemText: env.systemText,
							contextFiles: env.contextFiles,
							promptFiles: env.promptFiles,
							extensionContexts: env.extensionContexts,
							extensions: env.extensions,
						});
					});
					observeSessionWrites(session, () => {
						transcriptWriteFailed = true;
					});
				}
				rec.launched = true;
				outcome = await runSubagent({
					autoCompact: options.getAutoCompact?.(),
					provider: options.getProvider(),
					model: binding.wireModelId,
					modelReference: binding.reference,
					system: options.getSystem(),
					extraSystem: agent?.system,
					tools,
					prompt,
					signal,
					timeoutMs: effectiveTimeout,
					session: session ?? undefined,
					onMessage: session ? (message: AgentMessage) => session?.appendMessage(message) : undefined,
					onToolCall: options.onToolCall
						? (call) => options.onToolCall?.(call, { agent: agent?.name, cwd: childCwd })
						: undefined,
					onEvent: options.onEvent
						? (event) =>
								options.onEvent?.(event, {
									agent: agent?.name,
									cwd: childCwd,
									sourceId,
									...(taskToolCallId === undefined ? {} : { taskToolCallId }),
								})
						: undefined,
				});
			} finally {
				// Cleanup runs on every path (completed, cap, abort, timeout, crash,
				// provider failure): SA-01 — auto-remove ONLY when the assessment
				// positively certified the worktree untouched; work-present and
				// unknown both keep it and the result says why.
				if (wt !== undefined && repo !== undefined) {
					cleanup = await attemptWorktreeCleanup(wt, repo);
				}
			}
			rec.childId = session?.header.id;
			rec.transcript = transcriptFor(session, childSessions, transcriptWriteFailed);
			if (wt !== undefined && cleanup !== undefined) rec.worktree = worktreeRecord(wt, cleanup);

			// SA-03: terminal facts straight from the runtime outcome.
			const terminal: TaskRecordTerminal = {
				status: outcome.status,
				reason: outcome.reason,
				turns: outcome.turns,
				textPresent: outcome.text !== undefined,
				// SA-04: totals + the reserved incompleteness flag (shape frozen by
				// SA-03; the flag appears only when a started request never reported).
				usage: outcome.usageDetail.incomplete ? { ...outcome.usage, incomplete: true } : outcome.usage,
			};
			const base = taskResult(outcome, session, effectiveTimeout, String(args.prompt));
			if (cleanup === undefined || cleanup.state === "removed") return finish(base, terminal);
			if (cleanup.state === "failed") {
				return finish(
					{
						...base,
						output: `${base.output}\n${cleanupFailureNote(cleanup.errors, wt as ChildWorktree)}`,
					},
					terminal,
				);
			}
			if (cleanup.assessment.verdict === "work-present") {
				const kept = wt as ChildWorktree;
				const stat = await worktreeChangeStat(kept, repo as RepoState);
				return finish({ ...base, output: `${base.output}${buildWorktreeTrailer(kept, stat)}` }, terminal);
			}
			return finish(
				{
					...base,
					output: `${base.output}\n${keptForSafetyNote(cleanup.assessment, wt as ChildWorktree)}`,
				},
				terminal,
			);
		},
	};
}

/** Map a child outcome to the §3 result contract (#subagent-softlanding rev 4
 *  layered honesty). Exported for tests. `originalPrompt` is args.prompt BEFORE
 *  the worktree notice is appended — the excerpt must show the task, not the
 *  isolation boilerplate. */
export function taskResult(
	outcome: SubagentOutcome,
	session: SessionStore | null,
	timeoutMs?: number,
	originalPrompt?: string,
): ToolExecuteResult {
	// A lazy session object alone does not guarantee a transcript exists.
	const where = session?.isPersisted ? session.filePath : undefined;
	// SA-07 §3.3: the resume handle, stated as a handle (not a promise —
	// resumability is decided at resume time by SA-06's validation rules).
	const continueLine =
		where === undefined || session === null
			? undefined
			: `child session id: ${session.header.id} — continue it later with task({resume: "${session.header.id}", prompt: "…"}) (resumable only while imp version, system/agent/tools, provider and the recorded cwd/worktree are unchanged)`;
	const handoff = () => {
		if (where === undefined) {
			// No transcript to hand off: say so plainly (never a dangling
			// "transcript:" colon), keep the task excerpt + guidance.
			const lines = ["(transcript not persisted — work was not saved)"];
			if (originalPrompt !== undefined) {
				lines.push(`the child's task was: "${excerpt(originalPrompt, 200)}"`);
			}
			lines.push("Re-dispatch with a narrower prompt.");
			return lines.join("\n");
		}
		const lines = ["work is preserved in the full transcript:", `  ${where}`];
		if (continueLine !== undefined) lines.push(continueLine);
		if (originalPrompt !== undefined) {
			lines.push(`the child's task was: "${excerpt(originalPrompt, 200)}"`);
		}
		lines.push("Re-dispatch with a narrower prompt, or read the transcript and continue the work yourself.");
		return lines.join("\n");
	};

	if (outcome.status === "aborted" || outcome.status === "timeout") {
		const lead =
			outcome.status === "timeout"
				? `task timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s`
				: "task aborted before completion";
		return {
			output: `${lead} (${outcome.turns} turns ran). ${handoff()}`,
			isError: true,
		};
	}

	if (outcome.status === "crash" && outcome.text === undefined) {
		return {
			output: `task failed after ${outcome.turns} turns: ${outcome.reason ?? "unknown error"}. ${handoff()}`,
			isError: true,
		};
	}

	// Success-shaped: completed / max_iterations / crash-with-partial.
	// The no-output marker belongs to `completed` ONLY — a capped child with
	// no text gets the honest handoff below (incident A: 40 turns of digging,
	// zero text, parent misled by "completed with no output").
	const text =
		outcome.text ?? (outcome.status === "completed" ? "(subagent completed with no output)" : undefined);
	if (text === undefined) {
		// max_iterations / crash with no assistant text anywhere: layered-C
		// no-text form — honest failure report with full recovery guidance.
		return {
			output: `[task] child spent all ${outcome.turns} turns without producing a final answer (it was still calling tools on the last turn). ${handoff()}`,
			isError: false,
		};
	}
	const { text: tail, dropped } = tailTruncate(text);
	const parts: string[] = [];
	if (dropped > 0) {
		parts.push(
			`[task] result truncated to its last 50KB (dropped ${dropped} bytes). For large output, have the subagent write a file and report its path instead.`,
		);
	}
	parts.push(tail);
	if (outcome.status === "max_iterations") {
		parts.push(
			`[task] hit the ${outcome.turns}-turn cap; this is the child's wrap-up answer, not a confirmed completion.`,
		);
	}
	if (outcome.status === "crash") {
		parts.push(`[task] child failed after ${outcome.turns} turns: ${outcome.reason}; partial result above.`);
	}
	parts.push(childUsageTrailer(outcome.turns, outcome.usage));
	if (continueLine !== undefined) parts.push(continueLine);
	return { output: parts.join("\n\n"), isError: false };
}

/** CJK-safe head excerpt: cut on a code-point boundary so no surrogate pair
 *  is split (tailTruncate is the byte-tail analogue on the output side). */
function excerpt(text: string, maxChars: number): string {
	const chars = Array.from(text);
	return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join("")}…`;
}
