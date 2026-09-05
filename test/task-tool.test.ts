import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { assistant, gate, scriptedProvider, user } from "./helpers/fakes.js";
import { createChildSession, createSession, listSessions, sessionsDirFor } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createTaskTool, taskResult } from "../src/core/tools/task.js";
import type { SubagentOutcome } from "../src/core/subagent.js";
import type { ToolExecuteResult } from "../src/core/tools/types.js";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createWriteTool } from "../src/core/tools/write.js";
import type { LLMProvider } from "../src/provider/types.js";
import type { LLMRequest } from "../src/provider/types.js";
import type { Tool } from "../src/core/tools/types.js";
import { createRunner } from "../src/runner.js";
import { makeRenderer } from "./helpers/fakes.js";

const echo: Tool = {
	name: "echo",
	description: "echoes",
	parameters: Type.Object({ message: Type.String() }),
	async execute(args) {
		return { output: `echo: ${String(args.message)}` };
	},
};

function outcome(overrides: Partial<SubagentOutcome>): SubagentOutcome {
	return {
		status: "completed",
		text: "answer text",
		turns: 2,
		usage: { inputTokens: 10, outputTokens: 5 },
		...overrides,
	};
}

describe("taskResult contract (§3)", () => {
	it("success: text + byte-pinned usage trailer", () => {
		const result = taskResult(outcome({}), null);
		expect(result).toEqual({
			output: "answer text\n\n(child: 2 turns, 10 in / 5 out)",
			isError: false,
		});
	});

	it("trailer with cache read includes the cache segment", () => {
		const result = taskResult(
			outcome({ turns: 7, usage: { inputTokens: 12345, outputTokens: 1400, cacheReadTokens: 9800 } }),
			null,
		);
		expect(result.output).toContain("(child: 7 turns, 12.3k in / 1.4k out / 9.8k cache)");
	});

	it("no assistant text anywhere → the explicit no-output marker", () => {
		const result = taskResult(outcome({ text: undefined }), null);
		expect(result.output).toContain("(subagent completed with no output)");
	});

	it("oversized text: tail kept, teaching header names the dropped bytes", () => {
		const big = `${"x".repeat(60 * 1024)}TAIL-MARKER`;
		const result = taskResult(outcome({ text: big }), null);
		expect(result.output.startsWith("[task] result truncated to its last 50KB (dropped ")).toBe(true);
		expect(result.output).toContain("dropped 10251 bytes)"); // 61440+11 − 51200
		expect(result.output.endsWith("TAIL-MARKER\n\n(child: 2 turns, 10 in / 5 out)")).toBe(true);
		expect(result.output).toContain("have the subagent write a file and report its path");
	});

	it("CJK-safe tail cut: no mojibake at the seam", () => {
		const big = `${"你好".repeat(30 * 1024)}终点`; // 3 bytes/char, > 50KB
		const result = taskResult(outcome({ text: big }), null);
		expect(result.output).toContain("终点"); // the tail survives intact
		expect(result.output).not.toContain("\uFFFD"); // no replacement chars
	});

	it("aborted: isError teaching line with the child session id", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-task-"));
		const parent = createSession(baseDir, baseDir);
		const child = createChildSession(parent, baseDir);
		const result = taskResult(outcome({ status: "aborted", turns: 3 }), child);
		expect(result.isError).toBe(true);
		expect(result.output).toBe(
			`task aborted before completion (3 turns ran). Partial transcript: session ${child.header.id.slice(0, 8)}.`,
		);
	});

	it("aborted without a session: 'not persisted'", () => {
		const result = taskResult(outcome({ status: "aborted" }), null);
		expect(result.output).toBe("task aborted before completion (2 turns ran). Partial transcript: not persisted.");
	});

	it("timeout: isError with the injected budget in seconds", () => {
		const result = taskResult(outcome({ status: "timeout", turns: 1 }), null, 1000);
		expect(result.output).toBe("task timed out after 1s (1 turns ran). Partial transcript: not persisted.");
	});

	it("crash with partial text: success-shaped + failure trailer; no usage ambiguity", () => {
		const result = taskResult(
			outcome({ status: "crash", reason: "endpoint exploded", turns: 2 }),
			null,
		);
		expect(result.isError).toBe(false);
		expect(result.output).toBe(
			"answer text\n\n[task] child failed after 2 turns: endpoint exploded; partial result above.\n\n(child: 2 turns, 10 in / 5 out)",
		);
	});

	it("zero-turn crash: isError teaching line", () => {
		const result = taskResult(outcome({ status: "crash", reason: "connection refused", text: undefined, turns: 0 }), null);
		expect(result.isError).toBe(true);
		expect(result.output).toBe(
			"task failed after 0 turns: connection refused. Partial transcript: not persisted.",
		);
	});

	it("max_iterations: success-shaped + cap trailer + usage trailer", () => {
		const result = taskResult(outcome({ status: "max_iterations" }), null);
		expect(result.isError).toBe(false);
		expect(result.output).toBe(
			"answer text\n\n[task] hit the turn cap; result may be incomplete.\n\n(child: 2 turns, 10 in / 5 out)",
		);
	});
});

describe("createTaskTool end-to-end", () => {
	it("happy path: child transcript persisted under children/, linked by parent id, excluded from listing", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-task-"));
		const cwd = path.join(baseDir, "proj");
		const parent = createSession(cwd, baseDir);
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "the bug is on line 3" }])], sink);
		const task = createTaskTool({
			provider,
			getModel: () => "glm-5.3",
			getSystem: () => "PARENT-SYSTEM",
			getTools: () => [echo],
			getSession: () => parent,
			sessionBaseDir: baseDir,
		});

		const result = await task.execute({ prompt: "find the bug" }, new AbortController().signal);

		expect(result.isError ?? false).toBe(false);
		expect(result.output).toContain("the bug is on line 3");
		expect(sink).toHaveLength(1);

		// child session file: linked, complete, and invisible to /sessions
		const childrenDir = path.join(sessionsDirFor(cwd, baseDir), "children");
		const listed = listSessions(cwd, baseDir);
		expect(listed.map((s) => s.id)).toContain(parent.header.id);
		const { readdirSync } = await import("node:fs");
		const files = readdirSync(childrenDir).filter((f) => f.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		const child = SessionStore.open(path.join(childrenDir, files[0] as string));
		expect(child.header.parent).toBe(parent.header.id);
		const messages = child.buildContext().messages;
		expect(messages[0]).toEqual(user("find the bug"));
		expect(messages.some((m) => m.role === "assistant")).toBe(true);
	});

	it("childSessions=false: works, no children/ dir, 'not persisted' in errors", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-task-"));
		const parent = createSession(baseDir, baseDir);
		const provider = scriptedProvider([
			assistant([
				{ type: "text", text: "partial before crash" },
				{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } },
			]),
			() => {
				throw new Error("boom");
			},
		]);
		const task = createTaskTool({
			provider,
			getModel: () => "m",
			getSystem: () => "",
			getTools: () => [echo],
			getSession: () => parent,
			sessionBaseDir: baseDir,
			childSessions: false,
		});
		const result = await task.execute({ prompt: "go" }, new AbortController().signal);
		expect(result.output).toContain("partial result above"); // crash-with-partial
		expect(result.output).toContain("partial before crash");
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(sessionsDirFor(parent.header.cwd, baseDir), "children"))).toBe(false);
	});

	it("getSession() → null (sessions disabled): still runs, errors say 'not persisted'", async () => {
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])]);
		const task = createTaskTool({
			provider,
			getModel: () => "m",
			getSystem: () => "",
			getTools: () => [echo],
			getSession: () => null,
		});
		const result = await task.execute({ prompt: "go" }, new AbortController().signal);
		expect(result.output).toBe("ok\n\n(child: 1 turns, 10 in / 5 out)");
	});

	it("getters are read at spawn: a /model switch reaches the child", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-task-"));
		const parent = createSession(baseDir, baseDir);
		const sink: LLMRequest[] = [];
		let model = "old-model";
		const task = createTaskTool({
			provider: scriptedProvider([assistant([{ type: "text", text: "1" }]), assistant([{ type: "text", text: "2" }])], sink),
			getModel: () => model,
			getSystem: () => "SYS",
			getTools: () => [echo],
			getSession: () => parent,
			sessionBaseDir: baseDir,
		});
		await task.execute({ prompt: "a" }, new AbortController().signal);
		model = "new-model";
		await task.execute({ prompt: "b" }, new AbortController().signal);
		expect(sink.map((r) => r.model)).toEqual(["old-model", "new-model"]);
	});
});

describe("named agents (M5c)", () => {
	const scout = {
		name: "scout",
		description: "Explores a codebase to answer research questions",
		tools: ["echo"],
		model: "glm-4.6",
		system: "You are a code scout. AGENT-BODY-MARKER.",
		source: "/x/scout.md",
	};
	const reviewer = {
		name: "reviewer",
		description: "Reviews a diff for regressions",
		system: "Review carefully.",
		source: "/x/reviewer.md",
	};

	function agentTask(agents: readonly unknown[], overrides?: Record<string, unknown>) {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "scout says hi" }])], sink);
		const task = createTaskTool({
			provider,
			getModel: () => "parent-model",
			getSystem: () => "PARENT-SYSTEM",
			getTools: () => [echo],
			getSession: () => null,
			agents: agents as never,
			...overrides,
		});
		return { task, sink };
	}

	it("unknown agent → teaching error listing available agents; provider never called", async () => {
		const { task, sink } = agentTask([scout, reviewer]);
		const result = await task.execute({ prompt: "go", agent: "ghost" }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toBe(
			'unknown agent "ghost". Available agents: scout, reviewer (defined in .imp/agents/ and ~/.imp/agents/).',
		);
		expect(sink).toHaveLength(0);
	});

	it("unknown agent with no registry → points at the file locations", async () => {
		const { task, sink } = agentTask([]);
		const result = await task.execute({ prompt: "go", agent: "ghost" }, new AbortController().signal);
		expect(result.output).toBe(
			'unknown agent "ghost". No agents are defined (create .imp/agents/*.md or ~/.imp/agents/*.md).',
		);
		expect(sink).toHaveLength(0);
	});

	it("named agent: model + tools subset + system order (parent → CHILD_SUFFIX → agent body)", async () => {
		const { task, sink } = agentTask([scout]);
		const result = await task.execute({ prompt: "find the bug", agent: "scout" }, new AbortController().signal);
		expect(result.isError ?? false).toBe(false);
		const request = sink[0] as LLMRequest;
		expect(request.model).toBe("glm-4.6"); // frontmatter override beats parent
		expect(request.tools.map((t) => t.name)).toEqual(["echo"]); // subset
		expect(request.system.indexOf("PARENT-SYSTEM")).toBe(0);
		expect(request.system.indexOf("Subagent mode")).toBeGreaterThan("PARENT-SYSTEM".length);
		expect(request.system.indexOf("AGENT-BODY-MARKER")).toBeGreaterThan(request.system.indexOf("Subagent mode"));
	});

	it("agent listing an unknown tool → teaching error listing the valid pool; provider never called", async () => {
		const bad = { ...scout, tools: ["echo", "bash2"] };
		const { task, sink } = agentTask([bad]);
		const result = await task.execute({ prompt: "go", agent: "scout" }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toBe(
			'agent "scout" lists unknown tools: bash2. Available: echo.',
		);
		expect(sink).toHaveLength(0);
	});

	it("agent timeout override drives the timeout error's seconds", async () => {
		const g = gate();
		const slow: Tool = {
			name: "echo",
			description: "holds",
			parameters: Type.Object({ message: Type.String() }),
			async execute(args, signal) {
				await Promise.race([
					g.promise,
					new Promise<void>((resolve) => {
						if (signal.aborted) return resolve();
						signal.addEventListener("abort", () => resolve(), { once: true });
					}),
				]);
				return { output: `echo: ${String(args.message)}` };
			},
		};
		const timed = { ...scout, tools: undefined, timeoutMs: 1000 };
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hold" } }]),
		], sink);
		const task = createTaskTool({
			provider,
			getModel: () => "m",
			getSystem: () => "",
			getTools: () => [slow],
			getSession: () => null,
			agents: [timed],
			timeoutMs: 60_000, // factory default — the agent's 1s must win
		});
		const result = await task.execute({ prompt: "go", agent: "scout" }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("task timed out after 1s (1 turns ran)");
	});

	it("the tool description enumerates the roster (auto-routing hint)", () => {
		const { task } = agentTask([scout, reviewer]);
		expect(task.description).toContain("Agents: scout — Explores a codebase");
		expect(task.description).toContain("reviewer — Reviews a diff for regressions");
	});

	it("no agents → description has no roster suffix", () => {
		const { task } = agentTask([]);
		expect(task.description).not.toContain("Agents:");
	});

	it("M6a: the gate fires inside the child with the agent name; a block reaches the child as an isError result", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } }]),
				assistant([{ type: "text", text: "noted the block" }]),
			],
			sink,
		);
		const gateCalls: Array<{ name: string; agent?: string }> = [];
		const { task } = agentTask([scout], {
			provider,
			onToolCall: (call: { name: string }, info: { agent?: string }) => {
				gateCalls.push({ name: call.name, agent: info.agent });
				return { block: true, reason: "scout is read-only" };
			},
		});
		const result = await task.execute({ prompt: "go", agent: "scout" }, new AbortController().signal);
		expect(gateCalls).toEqual([{ name: "echo", agent: "scout" }]);
		// the block reason is the child's tool result (request 2), and the child recovered
		expect(JSON.stringify(sink[1]?.messages)).toContain("scout is read-only");
		expect(result.isError ?? false).toBe(false);
		expect(result.output).toContain("noted the block");
	});

	it("M6a: onEvent observes the child's tool events with the agent name", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hi" } }]),
				assistant([{ type: "text", text: "done" }]),
			],
			sink,
		);
		const events: Array<{ type: string; agent?: string }> = [];
		const { task } = agentTask([scout], {
			provider,
			onEvent: (event: { type: string }, info: { agent?: string }) => {
				if (event.type === "tool_start" || event.type === "tool_end") {
					events.push({ type: event.type, agent: info.agent });
				}
			},
		});
		await task.execute({ prompt: "go", agent: "scout" }, new AbortController().signal);
		expect(events).toEqual([
			{ type: "tool_start", agent: "scout" },
			{ type: "tool_end", agent: "scout" },
		]);
	});

	it("M6a: generic tasks carry agent: undefined into the gate", async () => {
		const sink: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "done" }])], sink);
		const gateCalls: Array<{ agent?: string }> = [];
		const { task } = agentTask([], {
			provider,
			onToolCall: (_call, info) => {
				gateCalls.push({ agent: info.agent });
			},
		});
		const result = await task.execute({ prompt: "plain" }, new AbortController().signal);
		expect(result.output).toContain("done");
		expect(gateCalls).toEqual([]);
		expect(sink).toHaveLength(1); // no tool calls happened: nothing gated
	});

	it("description carries the concurrency discipline (same-file jobs sequential)", () => {
		const { task } = agentTask([]);
		expect(task.description).toContain("delegate only INDEPENDENT subtasks");
		expect(task.description).toContain("jobs that modify the same files must be delegated one at a time");
	});
});

describe("runner integration (default set)", () => {
	it("task ships with the runner: parent → child → parent round trip, fresh child context, task excluded from child pool", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-runner-"));
		const cwd = path.join(baseDir, "proj");
		const sink: LLMRequest[] = [];
		// one shared provider: request 1 = parent (task call), request 2 = child
		// (final text), request 3 = parent (final text after the tool result).
		const provider = scriptedProvider(
			[
				assistant([{ type: "toolCall", id: "t1", name: "task", arguments: { prompt: "scout the repo" } }]),
				assistant([{ type: "text", text: "scout report: 3 files" }]),
				assistant([{ type: "text", text: "done scouting" }]),
			],
			sink,
		);
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "glm-5.3",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
			provider,
		});

		expect(runner.history).toEqual([]);
		const result = await runner.runTurn({ userMessage: "scout it" });
		expect(result.stopReason).toBe("completed");

		expect(sink).toHaveLength(3);
		// child request: fresh context, runner's system + suffix, no task tool
		const childRequest = sink[1] as LLMRequest;
		expect(childRequest.messages).toEqual([user("scout the repo")]);
		expect(childRequest.system).toContain("Subagent mode");
		expect(childRequest.system).toContain("You do not");
		expect(childRequest.tools.map((t) => t.name)).not.toContain("task");
		// parent's second request carries the tool result with the child's text
		const parentRequest = sink[2] as LLMRequest;
		const toolResult = parentRequest.messages.find((m) => m.role === "toolResult");
		expect(toolResult && toolResult.role === "toolResult" ? toolResult.results[0]?.content : "").toContain(
			"scout report: 3 files",
		);

		// the child transcript landed next to the parent session
		const { readdirSync, existsSync } = await import("node:fs");
		const childrenDir = path.join(sessionsDirFor(cwd, baseDir), "children");
		expect(existsSync(childrenDir)).toBe(true);
		expect(readdirSync(childrenDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
	}, 20000);

	it("M5c: runner discovers .imp/agents from cwd, warns on bad files, named agent reaches the child", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-runner-"));
		const cwd = path.join(baseDir, "proj");
		const agentsHome = await mkdtemp(path.join(tmpdir(), "imp-agents-home-"));
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(path.join(cwd, ".imp", "agents"), { recursive: true });
		writeFileSync(
			path.join(cwd, ".imp", "agents", "scout.md"),
			'---\nname: scout\ndescription: explores\nmodel: glm-4.6\n---\nAGENT-BODY-RUNNER',
			"utf8",
		);
		writeFileSync(path.join(cwd, ".imp", "agents", "broken.md"), "---\nname: broken\n---\n", "utf8");

		const sink: LLMRequest[] = [];
		// one shared provider: parent (task call) → child (final text) → parent (final text)
		const provider = scriptedProvider(
			[
				assistant([
					{ type: "toolCall", id: "t1", name: "task", arguments: { prompt: "scout it", agent: "scout" } },
				]),
				assistant([{ type: "text", text: "child done" }]),
				assistant([{ type: "text", text: "parent done" }]),
			],
			sink,
		);
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "glm-5.3",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			agentsHomeDir: agentsHome,
			renderer,
			provider,
		});

		// the bad file warned at warmup, teaching-style
		expect(output()).toContain("agent file skipped: ");
		expect(output()).toContain('missing required field "description"');

		const result = await runner.runTurn({ userMessage: "go scout" });
		expect(result.stopReason).toBe("completed");
		const childRequest = sink[1] as LLMRequest;
		expect(childRequest.system).toContain("AGENT-BODY-RUNNER"); // agent body reached the child
		expect(childRequest.model).toBe("glm-4.6"); // agent override beat the runner's glm-5.3
	}, 20000);
});

describe("system prompt gate (M5a)", () => {
	it("the §Tools list advertises exactly one task line", () => {
		const prompt = buildSystemPrompt({ cwd: "/w", platform: "darwin", arch: "arm64", date: "2026-09-04" });
		expect(prompt.match(/^- task:/gm)).toHaveLength(1);
	});
});

describe("worktree isolation (M6b)", () => {
	/** A hermetic git repo cwd + a task tool whose worktree children get a real
	 * write tool rooted at their worktree path (mirrors the runner wiring). */
	async function repoTask(overrides?: Record<string, unknown>) {
		const root = await mkdtemp(path.join(tmpdir(), "imp-wt-e2e-"));
		const rgit = (args: string[]) => {
			const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
			if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		};
		rgit(["init", "-q"]);
		rgit(["config", "user.email", "t@imp.dev"]);
		rgit(["config", "user.name", "t"]);
		writeFileSync(path.join(root, "seed.txt"), "committed\n", "utf8");
		rgit(["add", "."]);
		rgit(["commit", "-qm", "seed"]);
		const sink: LLMRequest[] = [];
		const childCwds: string[] = [];
		const provider = scriptedProvider([], sink);
		const task = createTaskTool({
			provider,
			getModel: () => "m",
			getSystem: () => "PARENT",
			getTools: () => [],
			getSession: () => null,
			cwd: root,
			getToolsForCwd: (cwd: string) => {
				childCwds.push(cwd);
				return [createWriteTool({ cwd })];
			},
			worktreeBaseDir: path.join(tmpdir(), `imp-wt-e2e-base-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
			...overrides,
		});
		return { task, sink, root, childCwds, rgit };
	}

	it("a child writing inside its worktree keeps the work: file lands there, parent tree untouched, trailer names the branch", async () => {
		const sink: LLMRequest[] = [];
		const { task, root, childCwds } = await repoTask({
			provider: scriptedProvider(
				[
					assistant([
						{
							type: "toolCall",
							id: "w1",
							name: "write",
							arguments: { path: "child-note.txt", content: "written by the child" },
						},
					]),
					assistant([{ type: "text", text: "wrote the note" }]),
				],
				sink,
			),
		});
		const result = await task.execute({ prompt: "write child-note.txt", worktree: true }, new AbortController().signal);
		expect(result.isError ?? false).toBe(false);
		const childPrompt = JSON.stringify((sink[0] as LLMRequest).messages);
		expect(childPrompt).toContain("[worktree]");
		expect(childPrompt).toContain("isolated git worktree");
		const wtPath = childCwds[0] as string;
		expect(wtPath).toContain("imp-worktree-");
		expect(existsSync(path.join(wtPath, "child-note.txt"))).toBe(true);
		expect(existsSync(path.join(root, "child-note.txt"))).toBe(false);
		expect(result.output).toContain("wrote the note");
		expect(result.output).toContain("[task] changes kept in worktree");
		expect(result.output).toContain("git merge imp/task-");
		expect(result.output).toContain("untracked: child-note.txt");
	});

	it("a child that changes nothing gets its worktree removed and no trailer", async () => {
		const sink: LLMRequest[] = [];
		const { task, root } = await repoTask({
			provider: scriptedProvider([assistant([{ type: "text", text: "just looked around" }])], sink),
		});
		const result = await task.execute({ prompt: "look only", worktree: true }, new AbortController().signal);
		expect(result.output).toContain("just looked around");
		expect(result.output).not.toContain("changes kept in worktree");
		const listed = spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" });
		expect(listed.stdout).not.toContain("imp-worktree-");
		const branches = spawnSync("git", ["branch", "--list", "imp/task-*"], { cwd: root, encoding: "utf8" });
		expect(branches.stdout.trim()).toBe("");
	});

	it("no per-cwd tool pool wired → teaching error (isolation would be silently violated)", async () => {
		// a real repo, but a host that never wired getToolsForCwd
		const root = await mkdtemp(path.join(tmpdir(), "imp-wt-nopool-"));
		const rgit = (args: string[]) => {
			const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
			if (r.status !== 0) throw new Error(`git: ${r.stderr}`);
		};
		rgit(["init", "-q"]);
		rgit(["config", "user.email", "t@imp.dev"]);
		rgit(["config", "user.name", "t"]);
		writeFileSync(path.join(root, "seed.txt"), "x\n", "utf8");
		rgit(["add", "."]);
		rgit(["commit", "-qm", "seed"]);
		const sink: LLMRequest[] = [];
		const task = createTaskTool({
			provider: scriptedProvider([], sink),
			getModel: () => "m",
			getSystem: () => "PARENT",
			getTools: () => [],
			getSession: () => null,
			cwd: root,
			// getToolsForCwd deliberately absent
		});
		const result = await task.execute({ prompt: "go", worktree: true }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("no per-directory tool pool");
		expect(sink).toHaveLength(0);
		// the half-created worktree was rolled back
		const listed = spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" });
		expect(listed.stdout).not.toContain("imp-worktree-");
	});

	it("non-git cwd → teaching error, provider never called", async () => {
		const nowhere = await mkdtemp(path.join(tmpdir(), "imp-wt-nogit-"));
		const sink: LLMRequest[] = [];
		const task = createTaskTool({
			provider: scriptedProvider([], sink),
			getModel: () => "m",
			getSystem: () => "PARENT",
			getTools: () => [],
			getSession: () => null,
			cwd: nowhere,
		});
		const result = await task.execute({ prompt: "go", worktree: true }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires a git repository");
		expect(result.output).toContain("without the worktree");
		expect(sink).toHaveLength(0);
	});

	it("agent frontmatter worktree: true defaults the isolation on; the call can still opt out", async () => {
		const sink: LLMRequest[] = [];
		const { task, childCwds } = await repoTask({
			provider: scriptedProvider([assistant([{ type: "text", text: "idle" }])], sink),
			agents: [
				{
					name: "builder",
					description: "writes code",
					worktree: true,
					system: "Build things.",
					source: "/x/builder.md",
				},
			],
		});
		const r1 = await task.execute({ prompt: "build", agent: "builder" }, new AbortController().signal);
		expect(childCwds).toHaveLength(1);
		expect(r1.output).toContain("idle");
		const r2 = await task.execute({ prompt: "build again", agent: "builder", worktree: false }, new AbortController().signal);
		expect(childCwds).toHaveLength(1);
		expect(r2.output).toContain("idle");
	});

	it("crash mid-child still preserves the child's uncommitted work (cleanup in finally)", async () => {
		const sink: LLMRequest[] = [];
		let call = 0;
		const throwing: LLMProvider = {
			name: "crasher",
			async *stream(request) {
				sink.push({ ...request, messages: [...request.messages] });
				call++;
				if (call === 1) {
					yield { type: "tool_call_start", id: "w1", name: "write" };
					yield {
						type: "message_end",
						message: assistant([
							{ type: "toolCall", id: "w1", name: "write", arguments: { path: "crash-work.txt", content: "before the crash" } },
						]),
					};
					return;
				}
				throw new Error("endpoint exploded");
			},
		};
		const { task, root } = await repoTask({ provider: throwing });
		const result = await task.execute({ prompt: "write then die", worktree: true }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("endpoint exploded");
		expect(result.output).toContain("[task] changes kept in worktree");
		const wtLine = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout
			.split("\n")
			.find((l) => l.startsWith("worktree ") && l.includes("imp-worktree-"));
		const wtPath = wtLine?.slice("worktree ".length).trim() ?? "";
		expect(existsSync(path.join(wtPath, "crash-work.txt"))).toBe(true);
	});
});
