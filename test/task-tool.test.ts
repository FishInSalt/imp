import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { assistant, scriptedProvider, user } from "./helpers/fakes.js";
import { createChildSession, createSession, listSessions, sessionsDirFor } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createTaskTool, taskResult } from "../src/core/tools/task.js";
import type { SubagentOutcome } from "../src/core/subagent.js";
import type { ToolExecuteResult } from "../src/core/tools/types.js";
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
});

describe("system prompt gate (M5a)", () => {
	it("the §Tools list advertises exactly one task line", () => {
		const prompt = buildSystemPrompt({ cwd: "/w", platform: "darwin", arch: "arm64", date: "2026-09-04" });
		expect(prompt.match(/^- task:/gm)).toHaveLength(1);
	});
});
