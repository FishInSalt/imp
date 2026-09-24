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
	buildWorktreeNotice,
	buildWorktreeTrailer,
	type ChildWorktree,
	createChildWorktree,
	hasWorktreeChanges,
	type RepoState,
	removeChildWorktree,
	resolveRepoState,
	worktreeChangeStat,
} from "../worktree.js";
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
	onEvent?: (event: AgentEvent, info: { agent?: string; cwd?: string }) => void;
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
		concurrencySafe: true,
		promptSnippet: "delegate a self-contained multi-step job to a fresh subagent.",
		// prompt-audit P8: the roster moved to the <advertised_agents> system
		// block (capped, escaped, budgeted) — a dynamic description defeats
		// provider tool-schema caching and grows unbounded with agent count.
		description:
			"Delegate a self-contained task to a fresh subagent with its own context window. The prompt is all the subagent sees — include every path and detail it needs and what to return. Its final message becomes the tool result. Prefer this for multi-step exploration (searches, file reads, research) that would otherwise bloat this conversation; keep one-shot questions here. Several task calls in one turn run concurrently — delegate only INDEPENDENT subtasks; jobs that modify the same files must be delegated one at a time. Named agents are listed in the system prompt's <advertised_agents> block.",
		parameters: taskSchema,

		async execute(args, signal): Promise<ToolExecuteResult> {
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
			let cleanupErrors: string[] = [];
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
					cleanupErrors = await removeChildWorktree(wt, repo);
					return {
						output:
							"worktree isolation is not available in this host (no per-directory tool pool wired) — retry the task without the worktree option.",
						isError: true,
					};
				}
				const narrowed = validateSubset(rebuilt);
				if ("isError" in narrowed) {
					cleanupErrors = await removeChildWorktree(wt, repo);
					return narrowed;
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
						? (event) => options.onEvent?.(event, { agent: agent?.name, cwd: childCwd })
						: undefined,
				});
			} finally {
				// Cleanup runs on every path (design D8): completed, aborted,
				// timeout, crash. Preserved work is never discarded. Removal
				// failures surface instead of leaking silently (review nit 2).
				if (wt !== undefined && repo !== undefined) {
					const changed = await hasWorktreeChanges(wt, repo).catch(() => true);
					if (!changed) {
						cleanupErrors = await removeChildWorktree(wt, repo);
						if (cleanupErrors.length === 0) wt = undefined;
					}
				}
			}
			const base = taskResult(outcome, session, effectiveTimeout, String(args.prompt));
			if (wt === undefined && cleanupErrors.length === 0) return base;
			if (wt === undefined) {
				return {
					...base,
					output: `${base.output}\n[task] worktree cleanup failed: ${cleanupErrors.join("; ")}`,
				};
			}
			const stat = await worktreeChangeStat(wt, repo as RepoState);
			return { ...base, output: `${base.output}${buildWorktreeTrailer(wt, stat)}` };
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
