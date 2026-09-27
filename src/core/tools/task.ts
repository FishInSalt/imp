import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { parseModelRef } from "../../provider/resolve.js";
import type { LLMProvider } from "../../provider/types.js";
import type { AgentDefinition } from "../agents/registry.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../compaction.js";
import { defaultChildTimeoutMs, MAX_BYTES } from "../constants.js";
import type { AgentEvent, ToolCallDecision } from "../loop.js";
import { createChildSession } from "../session/manager.js";
import type { SessionStore } from "../session/store.js";
import { childUsageTrailer, runSubagent, type SubagentOutcome } from "../subagent.js";
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
 */

const taskSchema = Type.Object({
	prompt: Type.String({
		description:
			"Complete, self-contained task for a fresh subagent. It sees nothing of this conversation; include all needed context (paths, what to return). Keep the prompt focused (~300 words max): the child re-reads files itself; pasting repo context into the prompt wastes its context window.",
	}),
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
	/** Current canonical provider/model reference for metadata, not routing. */
	getModelReference?: () => string;
	/** Read at spawn: `/new`/`/resume` re-assemble the system prompt. */
	getSystem: () => string;
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
	/** Test seam: worktree base dir override (IMP_WORKTREE_DIR in production). */
	worktreeBaseDir?: string;
	/** Registered agents (M5c); the runner loads them from disk, tests inject. */
	agents?: readonly AgentDefinition[];
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
			const taskToolCallId = context?.toolCallId;
			// Resolve the named agent (if any) before any side effects.
			const wanted = typeof args.agent === "string" && args.agent !== "" ? args.agent : undefined;
			const agent = wanted === undefined ? undefined : agentsByName.get(wanted);
			if (wanted !== undefined && agent === undefined) {
				const available = agents.length
					? `Available agents: ${agents.map((a) => a.name).join(", ")} (defined in .imp/agents/ and ~/.imp/agents/).`
					: options.agentsProjectGated === true
						? "No agents are loaded — this directory's .imp/agents was skipped because the directory is not trusted (review it, then restart with: imp --trust)."
						: "No agents are defined (create .imp/agents/*.md or ~/.imp/agents/*.md).";
				return { output: `unknown agent "${wanted}". ${available}`, isError: true };
			}

			// Tools narrowing first (review B1): it can only reject, never touch
			// the filesystem — running it before worktree creation means no
			// teaching error can leak a created worktree.
			const parentPool = options.getTools().filter((tool) => tool.name !== "task");
			const validateSubset = (pool: Tool[]): Tool[] | { output: string; isError: true } => {
				if (agent?.tools === undefined) return pool;
				const byName = new Map(pool.map((t) => [t.name, t] as const));
				const unknown = agent.tools.filter((n) => !byName.has(n));
				if (unknown.length > 0) {
					return {
						output: `agent "${agent.name}" lists unknown tools: ${unknown.join(", ")}. Available: ${pool.map((t) => t.name).join(", ")}.`,
						isError: true,
					};
				}
				return agent.tools.map((n) => byName.get(n)).filter((t) => t !== undefined);
			};

			// Worktree isolation (M6b): agent frontmatter default, call override.
			const wantWorktree =
				args.worktree === true || (args.worktree === undefined && agent?.worktree === true);
			let wt: ChildWorktree | undefined;
			let repo: RepoState | undefined;
			let cleanup: CleanupOutcome | undefined;
			let prompt = String(args.prompt);
			let tools: Tool[];
			// Child cwd for gate events (M6b): the worktree path when isolation is
			// active, otherwise the parent's cwd — gates resolve paths against the
			// loop that executes the call, not the project root.
			let childCwd = options.cwd ?? process.cwd();
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
					return {
						output: err instanceof Error ? err.message : String(err),
						isError: true,
					};
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
				const rebuilt = options.getToolsForCwd?.(agentCwd);
				if (rebuilt === undefined) {
					// SA-01: the fresh worktree is rolled back only when it is
					// positively clean; a failed check or a failed removal is
					// reported instead of silently leaking or losing it.
					const attempt = await attemptWorktreeCleanup(wt, repo);
					const note = cleanupOutcomeNote(attempt, wt);
					return {
						output: `worktree isolation is not available in this host (no per-directory tool pool wired) — retry the task without the worktree option.${note ? `\n${note}` : ""}`,
						isError: true,
					};
				}
				const narrowed = validateSubset(rebuilt);
				if ("isError" in narrowed) {
					const attempt = await attemptWorktreeCleanup(wt, repo);
					const note = cleanupOutcomeNote(attempt, wt);
					return { ...narrowed, output: note ? `${narrowed.output}\n${note}` : narrowed.output };
				}
				tools = narrowed;
			} else {
				const narrowed = validateSubset(parentPool);
				if ("isError" in narrowed) return narrowed;
				tools = narrowed;
			}
			// #subagent-softlanding rev 4 precedence: call args > agent
			// frontmatter > mode default (TTY: undefined = unlimited).
			const effectiveTimeout =
				(args.timeoutMs as number | undefined) ?? agent?.timeoutMs ?? timeoutMs ?? defaultChildTimeoutMs();

			const parentModel = options.getModel();
			const parentReference = options.getModelReference?.() ?? parentModel;
			const slash = parentReference.indexOf("/");
			const parentProvider = slash > 0 ? parentReference.slice(0, slash) : undefined;
			const model = agent?.model ?? parentModel;
			const parsedOverride = parseModelRef(model);
			// Only recognized provider prefixes are explicit; bare IDs may contain slashes.
			const overrideSlash = model.trim().indexOf("/");
			const explicitProvider =
				agent?.model !== undefined &&
				overrideSlash > 0 &&
				parsedOverride.modelId === model.trim().slice(overrideSlash + 1);
			const crossProvider =
				explicitProvider && (parentProvider === undefined || parsedOverride.provider !== parentProvider);
			const modelReference = agent?.model
				? explicitProvider || parentProvider === undefined
					? model
					: `${parentProvider}/${model}`
				: parentReference;

			let session: SessionStore | null = null;
			let outcome: SubagentOutcome;
			try {
				if (childSessions) {
					const parent = options.getSession();
					if (parent !== null) session = createChildSession(parent, options.sessionBaseDir);
				}
				outcome = await runSubagent({
					autoCompact: options.getAutoCompact?.(),
					provider: options.getProvider(),
					model,
					modelReference,
					// Profiles do not route providers. Never use another provider's window.
					settings: crossProvider ? DEFAULT_COMPACTION_SETTINGS : undefined,
					system: options.getSystem(),
					extraSystem: agent?.system,
					tools,
					prompt,
					signal,
					timeoutMs: effectiveTimeout,
					session: session ?? undefined,
					onMessage: session ? (message) => session?.appendMessage(message) : undefined,
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
			const base = taskResult(outcome, session, effectiveTimeout, String(args.prompt));
			if (cleanup === undefined || cleanup.state === "removed") return base;
			if (cleanup.state === "failed") {
				return {
					...base,
					output: `${base.output}\n${cleanupFailureNote(cleanup.errors, wt as ChildWorktree)}`,
				};
			}
			if (cleanup.assessment.verdict === "work-present") {
				const kept = wt as ChildWorktree;
				const stat = await worktreeChangeStat(kept, repo as RepoState);
				return { ...base, output: `${base.output}${buildWorktreeTrailer(kept, stat)}` };
			}
			return {
				...base,
				output: `${base.output}\n${keptForSafetyNote(cleanup.assessment, wt as ChildWorktree)}`,
			};
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
	return { output: parts.join("\n\n"), isError: false };
}

/** CJK-safe head excerpt: cut on a code-point boundary so no surrogate pair
 *  is split (tailTruncate is the byte-tail analogue on the output side). */
function excerpt(text: string, maxChars: number): string {
	const chars = Array.from(text);
	return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join("")}…`;
}
