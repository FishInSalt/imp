import path from "node:path";
import { Type } from "typebox";
import { formatTokens } from "../../format.js";
import type { LLMProvider } from "../../provider/types.js";
import { MAX_BYTES } from "../constants.js";
import type { AgentDefinition } from "../agents/registry.js";
import {
	buildWorktreeNotice,
	buildWorktreeTrailer,
	createChildWorktree,
	hasWorktreeChanges,
	removeChildWorktree,
	resolveRepoState,
	worktreeChangeStat,
	type ChildWorktree,
	type RepoState,
} from "../worktree.js";
import { createChildSession } from "../session/manager.js";
import type { SessionStore } from "../session/store.js";
import { childUsageTrailer, runSubagent, type SubagentOutcome } from "../subagent.js";
import type { AgentEvent, ToolCallDecision } from "../loop.js";
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
			"Complete, self-contained task for a fresh subagent. It sees nothing of this conversation; include all needed context (paths, what to return).",
	}),
	agent: Type.Optional(
		Type.String({ description: "Named agent to run (listed in the tool description); omit for a generic subagent" }),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Run in an isolated git worktree (own checkout, own branch; requires a git repository). Use for writing tasks that must not touch the current files; the result names the branch to merge. Requires the git repository to have at least one commit.",
		}),
	),
});

export interface TaskToolOptions {
	provider: LLMProvider;
	/** Read at spawn: `/model` writes the runner's model mid-session. */
	getModel: () => string;
	/** Read at spawn: `/new`/`/resume` re-assemble the system prompt. */
	getSystem: () => string;
	/** The parent's tool array; task itself is filtered out of the child pool. */
	getTools: () => Tool[];
	/** Current parent session — children link to it and live beside it. Null when sessions are disabled. */
	getSession: () => SessionStore | null;
	/** Hermetic tests: session base dir override (passed through to the session manager). */
	sessionBaseDir?: string;
	/** Transcript opt-out (IMP_CHILD_SESSIONS=0). Default: env, read once. */
	childSessions?: boolean;
	/** Injectable wall clock for tests. */
	timeoutMs?: number;
	/** The parent's permission gate, forwarded into the child loop (M6a).
	 * Receives the call plus which named agent (if any) is running — the
	 * caller marks the event as subagent-sourced. */
	onToolCall?: (
		call: { toolCallId: string; name: string; args: Record<string, unknown> },
		info: { agent?: string },
	) => Promise<ToolCallDecision | void | undefined> | ToolCallDecision | void | undefined;
	/** Observes the child's tool events (tool_start/tool_end) with the same
	 * agent context as onToolCall (M6a audit path). */
	onEvent?: (event: AgentEvent, info: { agent?: string }) => void;
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
	// Auto-routing hint (Claude Code prompt.ts pattern): the description
	// enumerates agents so the model can pick one without guessing.
	const roster = agents.length
		? ` Agents: ${agents.map((a) => `${a.name} — ${a.description}`).join("; ")}.`
		: "";

	return {
		name: "task",
		concurrencySafe: true,
		description:
			`Delegate a self-contained task to a fresh subagent with its own context window. The prompt is all the subagent sees — include every path and detail it needs and what to return. Its final message becomes the tool result. Prefer this for multi-step exploration (searches, file reads, research) that would otherwise bloat this conversation; keep one-shot questions here. Several task calls in one turn run concurrently — delegate only INDEPENDENT subtasks; jobs that modify the same files must be delegated one at a time.${roster}`,
		parameters: taskSchema,

		async execute(args, signal): Promise<ToolExecuteResult> {
			// Resolve the named agent (if any) before any side effects.
			const wanted = typeof args.agent === "string" && args.agent !== "" ? args.agent : undefined;
			const agent = wanted === undefined ? undefined : agentsByName.get(wanted);
			if (wanted !== undefined && agent === undefined) {
				const available = agents.length
					? `Available agents: ${agents.map((a) => a.name).join(", ")} (defined in .imp/agents/ and ~/.imp/agents/).`
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
			const wantWorktree = args.worktree === true || (args.worktree === undefined && agent?.worktree === true);
			let wt: ChildWorktree | undefined;
			let repo: RepoState | undefined;
			let cleanupErrors: string[] = [];
			let prompt = String(args.prompt);
			let tools: Tool[];
			if (wantWorktree) {
				const cwd = options.cwd ?? process.cwd();
				try {
					repo = await resolveRepoState(cwd);
					wt = await createChildWorktree(repo, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, options.worktreeBaseDir);
				} catch (err) {
					return {
						output: err instanceof Error ? err.message : String(err),
						isError: true,
					};
				}
				// Subdirectory parents keep their relative position inside the
				// worktree (pi's agentCwd pattern): relative paths keep working.
				const agentCwd = repo.cwdRelative ? path.join(wt.path, repo.cwdRelative) : wt.path;
				prompt += buildWorktreeNotice(wt, agentCwd, cwd);
				// A worktree child without a per-cwd pool would inherit tools
				// rooted at the PARENT cwd — silently violating the isolation
				// this feature exists to provide. A missing function AND an
				// undefined return both fail loudly (review nit 3).
				const rebuilt = options.getToolsForCwd?.(agentCwd);
				if (rebuilt === undefined) {
					cleanupErrors = await removeChildWorktree(wt, repo);
					return {
						output: "worktree isolation is not available in this host (no per-directory tool pool wired) — retry the task without the worktree option.",
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
			const effectiveTimeout = agent?.timeoutMs ?? timeoutMs;

			let session: SessionStore | null = null;
			let outcome;
			try {
				if (childSessions) {
					const parent = options.getSession();
					if (parent !== null) session = createChildSession(parent, options.sessionBaseDir);
				}
				outcome = await runSubagent({
					provider: options.provider,
					model: agent?.model ?? options.getModel(),
					system: options.getSystem(),
					extraSystem: agent?.system,
					tools,
					prompt,
					signal,
					timeoutMs: effectiveTimeout,
					session: session ?? undefined,
					onMessage: session ? (message) => session?.appendMessage(message) : undefined,
					onToolCall: options.onToolCall
						? (call) => options.onToolCall?.(call, { agent: agent?.name })
						: undefined,
					onEvent: options.onEvent
						? (event) => options.onEvent?.(event, { agent: agent?.name })
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
			const base = taskResult(outcome, session, effectiveTimeout);
			if (wt === undefined && cleanupErrors.length === 0) return base;
			if (wt === undefined) {
				return { ...base, output: `${base.output}\n[task] worktree cleanup failed: ${cleanupErrors.join("; ")}` };
			}
			const stat = await worktreeChangeStat(wt, repo as RepoState);
			return { ...base, output: `${base.output}${buildWorktreeTrailer(wt, stat)}` };
		},
	};
}

/** Map a child outcome to the §3 result contract. Exported for tests. */
export function taskResult(
	outcome: SubagentOutcome,
	session: SessionStore | null,
	timeoutMs?: number,
): ToolExecuteResult {
	const where = session ? `session ${session.header.id.slice(0, 8)}` : "not persisted";

	if (outcome.status === "aborted" || outcome.status === "timeout") {
		const lead =
			outcome.status === "timeout"
				? `task timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s`
				: "task aborted before completion";
		return {
			output: `${lead} (${outcome.turns} turns ran). Partial transcript: ${where}.`,
			isError: true,
		};
	}

	if (outcome.status === "crash" && outcome.text === undefined) {
		return {
			output: `task failed after ${outcome.turns} turns: ${outcome.reason ?? "unknown error"}. Partial transcript: ${where}.`,
			isError: true,
		};
	}

	// Success-shaped: completed / max_iterations / crash-with-partial.
	let text = outcome.text ?? "(subagent completed with no output)";
	const { text: tail, dropped } = tailTruncate(text);
	const parts: string[] = [];
	if (dropped > 0) {
		parts.push(
			`[task] result truncated to its last 50KB (dropped ${dropped} bytes). For large output, have the subagent write a file and report its path instead.`,
		);
	}
	parts.push(tail);
	if (outcome.status === "max_iterations") {
		parts.push("[task] hit the turn cap; result may be incomplete.");
	}
	if (outcome.status === "crash") {
		parts.push(`[task] child failed after ${outcome.turns} turns: ${outcome.reason}; partial result above.`);
	}
	parts.push(childUsageTrailer(outcome.turns, outcome.usage));
	return { output: parts.join("\n\n"), isError: false };
}
