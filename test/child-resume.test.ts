/**
 * SA-07 resume tests (design: docs/sa-07-child-resume-design.md).
 *
 * The R* cases were the red-evidence set (committed before implementation);
 * the T* cases complete the design's test plan.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../src/core/agents/registry.js";
import { lifetimeUsageLine } from "../src/core/child-resume.js";
import { createSession, sessionsDirFor } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import { buildTaskRecord } from "../src/core/task-record.js";
import { createTaskTool, type TaskToolOptions, taskResult } from "../src/core/tools/task.js";
import type { Tool, ToolExecuteResult } from "../src/core/tools/types.js";
import { createWriteTool } from "../src/core/tools/write.js";
import type { LLMRequest } from "../src/provider/types.js";
import { assistant, type ScriptStep, scriptedProvider, user } from "./helpers/fakes.js";

const SYSTEM = "PARENT SYSTEM\n- Date: 2026-09-29";

function countingEcho(): { tool: Tool; calls: () => number } {
	let calls = 0;
	const tool: Tool = {
		name: "echo",
		description: "echoes",
		parameters: Type.Object({ message: Type.String() }),
		async execute(args) {
			calls += 1;
			return { output: `echo: ${String(args.message)}` };
		},
	};
	return { tool, calls: () => calls };
}

function otherTool(): Tool {
	return {
		name: "other",
		description: "other",
		parameters: Type.Object({}),
		async execute() {
			return { output: "other" };
		},
	};
}

interface HarnessArgs {
	session: SessionStore;
	baseDir: string;
	cwd: string;
	scripts?: ScriptStep[];
	providerName?: string;
	system?: string;
	impVersion?: string;
	agents?: AgentDefinition[];
	tools?: Tool[];
	timeoutMs?: number;
	childSessions?: boolean;
	getSessionOverride?: () => SessionStore | null;
	getToolsForChild?: TaskToolOptions["getToolsForChild"];
	onToolCall?: TaskToolOptions["onToolCall"];
	withEnv?: boolean;
}

function harness(args: HarnessArgs): { task: Tool; sink: LLMRequest[] } {
	const sink: LLMRequest[] = [];
	const provider = scriptedProvider(args.scripts ?? [], sink, args.providerName ?? "anthropic");
	const system = args.system ?? SYSTEM;
	const task = createTaskTool({
		getProvider: () => provider,
		getModel: () => "parent-wire",
		getModelReference: () => "anthropic/parent-wire",
		getSystem: () => system,
		getTools: () => args.tools ?? [],
		getSession: args.getSessionOverride ?? (() => args.session),
		childSessions: args.childSessions ?? true,
		sessionBaseDir: args.baseDir,
		agents: args.agents ?? [],
		cwd: args.cwd,
		...(args.getToolsForChild === undefined ? {} : { getToolsForChild: args.getToolsForChild }),
		...(args.onToolCall === undefined ? {} : { onToolCall: args.onToolCall }),
		...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
		...(args.withEnv === false
			? {}
			: {
					getLaunchEnvironment: () => ({
						impVersion: args.impVersion ?? "9.9.9",
						systemText: system,
						contextFiles: [],
						promptFiles: [],
						extensionContexts: [],
						extensions: [],
					}),
				}),
	});
	return { task, sink };
}

function persistRecord(parent: SessionStore, result: ToolExecuteResult, toolCallId = "call-1"): void {
	parent.appendMessage({
		role: "toolResult",
		results: [
			{
				toolCallId,
				toolName: "task",
				content: result.output,
				isError: result.isError ?? false,
				taskRecord: result.taskRecord,
			},
		],
	});
}

async function dispatchAndPersist(args: {
	session: SessionStore;
	baseDir: string;
	cwd: string;
	scripts?: ScriptStep[];
	tools?: Tool[];
	prompt?: string;
	agent?: string;
	agents?: AgentDefinition[];
	timeoutMs?: number;
	getToolsForChild?: TaskToolOptions["getToolsForChild"];
	worktree?: boolean;
}): Promise<{ result: ToolExecuteResult; task: Tool; sink: LLMRequest[] }> {
	const { task, sink } = harness({
		session: args.session,
		baseDir: args.baseDir,
		cwd: args.cwd,
		scripts: args.scripts,
		tools: args.tools,
		agents: args.agents,
		timeoutMs: args.timeoutMs,
		getToolsForChild: args.getToolsForChild,
	});
	const result = await task.execute(
		{
			prompt: args.prompt ?? "first task",
			...(args.agent === undefined ? {} : { agent: args.agent }),
			...(args.worktree === undefined ? {} : { worktree: args.worktree }),
		},
		new AbortController().signal,
		{ toolCallId: "call-1" },
	);
	if (result.taskRecord?.transcript?.present === true) persistRecord(args.session, result);
	return { result, task, sink };
}

function childIdOf(result: ToolExecuteResult): string {
	const childId = result.taskRecord?.childId;
	if (childId === undefined) throw new Error("no childId in the record");
	return childId;
}

async function fixture(): Promise<{ base: string; cwd: string; parent: SessionStore }> {
	const base = await mkdtemp(path.join(tmpdir(), "imp-resume-"));
	const cwd = await mkdtemp(path.join(tmpdir(), "imp-resume-cwd-"));
	const parent = createSession(cwd, base);
	return { base, cwd, parent };
}

const signal = () => new AbortController().signal;

describe("SA-07 resume", () => {
	it("R1: resume continues the SAME child with exactly one new instruction", async () => {
		const { base, cwd, parent } = await fixture();
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [
				assistant([{ type: "text", text: "child done" }]),
				assistant([{ type: "text", text: "second answer" }]),
			],
		});
		const first = await task.execute({ prompt: "first task" }, signal(), { toolCallId: "call-1" });
		const childId = childIdOf(first);
		const transcript = first.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		persistRecord(parent, first);

		const second = await task.execute({ resume: childId, prompt: "check the second case" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.taskRecord?.childId).toBe(childId);
		const reopened = SessionStore.open(transcript.path);
		const messages = reopened.buildContext().messages;
		const userTexts = messages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(userTexts.filter((t) => t === "check the second case")).toHaveLength(1);
		expect(userTexts.filter((t) => t === "first task")).toHaveLength(1);
		expect(sink).toHaveLength(2);
		expect(JSON.stringify(sink[1]?.messages)).toContain("first task");
		const childrenDir = path.join(sessionsDirFor(cwd, base), "children");
		expect(readdirSync(childrenDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("R2a: a complete entry without a trailing newline is TERMINATED (kept), not lost", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store");
		store.appendMessage(user("first"));
		store.appendMessage(user("second"));
		const raw = readFileSync(filePath, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		writeFileSync(filePath, raw.slice(0, -1));
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true);
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("terminated");
		expect(readFileSync(filePath, "utf8").endsWith("\n")).toBe(true);
		const finalStore = SessionStore.open(filePath);
		expect(finalStore.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("R2b: an unparseable fragment is TRUNCATED at the last newline", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn2-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-2");
		store.appendMessage(user("first"));
		writeFileSync(filePath, `${readFileSync(filePath, "utf8")}{"type":"mess`);
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true);
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("truncated");
		expect(repair?.bytes).toBeGreaterThan(0);
		expect(readFileSync(filePath, "utf8").endsWith("\n")).toBe(true);
		const finalStore = SessionStore.open(filePath);
		expect(finalStore.getEntries().filter((entry) => entry.type === "message")).toHaveLength(1);
	});

	it("R2c: a torn tail that parses as JSON but is not a valid entry is TRUNCATED", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn3-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-3");
		store.appendMessage(user("first"));
		// A complete outer JSON object whose bytes fail ENTRY validation —
		// terminating it would leave an interior invalid line after the next
		// append, and interior corruption is fatal on open.
		writeFileSync(filePath, `${readFileSync(filePath, "utf8")}{"type":"message","id":"deadbeef"}`);
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true);
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("truncated");
		// Repair + append + reopen must be clean.
		const finalStore = SessionStore.open(filePath);
		finalStore.appendMessage(user("after"));
		const check = SessionStore.open(filePath);
		expect(check.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("R2e: repair is byte-accurate — CJK/emoji history keeps a byte-identical prefix", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn5-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-5");
		const text = "用户任务：请检查配置 🔧 路径 /tmp/多字节/文件.txt";
		store.appendMessage(user(text));
		const intact = readFileSync(filePath); // complete prefix, BYTES
		appendFileSync(filePath, '{"type":');
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true);
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("truncated");
		expect(repair?.bytes).toBe('{"type":'.length);
		expect(readFileSync(filePath).equals(intact)).toBe(true); // byte-for-byte
		const finalStore = SessionStore.open(filePath);
		const messages = finalStore.buildContext().messages;
		expect(messages).toHaveLength(1);
		const only = messages[0];
		if (only?.role !== "user") throw new Error("expected the preserved user message");
		expect(only.content).toBe(text);
	});

	it("R2f: an invalid final line WITH a trailing newline is truncated (open dropped it; append must not bury it)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn6-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-6");
		store.appendMessage(user("first"));
		appendFileSync(filePath, '{"broken line"\n');
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true); // dropped despite the newline
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("truncated");
		const finalStore = SessionStore.open(filePath);
		finalStore.appendMessage(user("after"));
		const check = SessionStore.open(filePath);
		expect(check.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("R2g: a session_model line missing its payload is truncated, not terminated", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn7-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-7");
		store.appendMessage(user("first"));
		appendFileSync(filePath, '{"type":"session_model","explicit":true}');
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true); // open() dropped it
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("truncated"); // must NOT be kept by terminating
		const finalStore = SessionStore.open(filePath);
		finalStore.appendMessage(user("after"));
		const check = SessionStore.open(filePath);
		expect(check.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("R2h: a position marker with a bad leafId is KEPT (open ignores it; repair must not truncate)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn8-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-8");
		store.appendMessage(user("first"));
		appendFileSync(filePath, '{"type":"position","leafId":5}');
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true); // no trailing newline
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("terminated"); // open() keeps this line
		const finalStore = SessionStore.open(filePath);
		finalStore.appendMessage(user("after"));
		const check = SessionStore.open(filePath);
		expect(check.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("R2d: a header-only file without a trailing newline is TERMINATED (never zeroed)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn4-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-4");
		store.appendMessage(user("first"));
		// Force the persisted single-line header: no entries, no newline.
		writeFileSync(filePath, readFileSync(filePath, "utf8").split("\n")[0] ?? "");
		const reopened = SessionStore.open(filePath);
		expect(reopened.tornFinalLine).toBe(true);
		const repair = reopened.repairTornFinalLine();
		expect(repair?.action).toBe("terminated"); // the header must survive
		const finalStore = SessionStore.open(filePath);
		finalStore.appendMessage(user("after"));
		const check = SessionStore.open(filePath);
		expect(check.getEntries().filter((entry) => entry.type === "message")).toHaveLength(1);
	});

	it("R3: the task schema exposes the resume parameter", async () => {
		const { base, cwd, parent } = await fixture();
		const { task } = harness({ session: parent, baseDir: base, cwd });
		const properties = (task.parameters as unknown as { properties?: Record<string, unknown> }).properties;
		expect(properties?.resume).toBeDefined();
	});

	it("T1: the argument matrix rejects contradictory or empty inputs before any side effect", async () => {
		const { base, cwd, parent } = await fixture();
		const { task } = harness({ session: parent, baseDir: base, cwd });
		const cases: Array<{ args: Record<string, unknown>; expect: string }> = [
			{ args: { resume: "  ", prompt: "x" }, expect: "resume must be a child session id" },
			{ args: { resume: "r", prompt: "x", agent: "worker" }, expect: "agent is immutable on resume" },
			{ args: { resume: "r", prompt: "x", worktree: true }, expect: "worktree is immutable on resume" },
			{ args: { resume: "r", prompt: "x", worktree: false }, expect: "worktree is immutable on resume" },
			{ args: { resume: "r", prompt: "   " }, expect: "a resume needs a non-empty prompt" },
		];
		for (const single of cases) {
			const result = await task.execute(single.args, signal(), { toolCallId: "call-x" });
			expect(result.isError).toBe(true);
			expect(result.output).toContain(single.expect);
		}
		const disabled = harness({ session: parent, baseDir: base, cwd, childSessions: false });
		const disabledResult = await disabled.task.execute({ resume: "r", prompt: "x" }, signal());
		expect(disabledResult.output).toContain("child sessions are disabled");
		const noParent = harness({ session: parent, baseDir: base, cwd, getSessionOverride: () => null });
		const noParentResult = await noParent.task.execute({ resume: "r", prompt: "x" }, signal());
		expect(noParentResult.output).toContain("requires an active parent session");
		// No side effects from any rejection: nothing appended to the parent file.
		expect(parent.getEntries().filter((entry) => entry.type === "message")).toHaveLength(0);
	});

	it("T2: an unknown id refuses with the parent's child candidates", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const { task } = harness({ session: parent, baseDir: base, cwd, scripts: [] });
		const missed = await task.execute({ resume: "nope", prompt: "x" }, signal());
		expect(missed.isError).toBe(true);
		expect(missed.output).toContain('cannot resume child "nope"');
		expect(missed.output).toContain("this session's children:");
		expect(missed.output).toContain(childId);
	});

	it("T4: a child with no settled record refuses (may still be running)", async () => {
		const { base, cwd, parent } = await fixture();
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const first = await task.execute({ prompt: "first task" }, signal(), { toolCallId: "call-1" });
		const childId = childIdOf(first); // deliberately NOT persisted
		const second = await task.execute({ resume: childId, prompt: "x" }, signal(), { toolCallId: "call-2" });
		expect(second.isError).toBe(true);
		expect(second.output).toContain("no settled task record");
		expect(sink).toHaveLength(1); // the resume never reached the provider
	});

	it("T5: a rejected record for the child does not make it resumable", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		// Replace the settled record with a rejected one for the same child id.
		const rejected = buildTaskRecord({
			attemptId: "rej-attempt",
			sourceId: "rej-source",
			childId,
			launched: false,
			cwd,
			status: "rejected",
			turns: 0,
			textPresent: false,
		});
		parent.appendMessage({
			role: "toolResult",
			results: [
				{
					toolCallId: "call-rej",
					toolName: "task",
					content: "rejected",
					isError: true,
					taskRecord: rejected,
				},
			],
		});
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "x" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "x" }, signal());
		// The settled record from the first attempt is still in the file — the
		// child IS resumable; what must NOT happen is the rejected record being
		// counted as a settled attempt.
		expect(second.taskRecord?.status).not.toBe("rejected");
		expect(second.output).toContain("child lifetime: 2 attempts");
	});

	it("T6: agent missing after launch refuses; a changed agent body refuses as drift", async () => {
		const { base, cwd, parent } = await fixture();
		const defA: AgentDefinition = {
			name: "worker",
			description: "d",
			system: "WORKER BODY",
			source: "/tmp/imp-agents/worker.md",
		};
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			agent: "worker",
			agents: [defA],
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const missing = harness({ session: parent, baseDir: base, cwd, scripts: [] });
		const missingResult = await missing.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(missingResult.isError).toBe(true);
		expect(missingResult.output).toContain("agent-missing");
		const defB: AgentDefinition = { ...defA, system: "WORKER BODY CHANGED" };
		const drifted = harness({ session: parent, baseDir: base, cwd, scripts: [], agents: [defB] });
		const driftedResult = await drifted.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(driftedResult.isError).toBe(true);
		expect(driftedResult.output).toContain("agent-drift");
	});

	it("T6b: permissions stay live — a gate denial surfaces and the call never runs", async () => {
		const { base, cwd, parent } = await fixture();
		const { tool, calls } = countingEcho();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		expect(calls()).toBe(0);
		const gateCalls: Array<{ name: string; cwd?: string }> = [];
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [
				assistant([{ type: "toolCall", id: "c9", name: "echo", arguments: { message: "x" } }]),
				assistant([{ type: "text", text: "after denial" }]),
			],
			onToolCall: (call, info) => {
				gateCalls.push({ name: call.name, cwd: info.cwd });
				return { block: true, reason: "denied by the live gate" };
			},
		});
		const second = await task.execute({ resume: childId, prompt: "try the tool" }, signal());
		expect(second.isError ?? false).toBe(false);
		expect(gateCalls).toEqual([{ name: "echo", cwd }]);
		expect(calls()).toBe(0); // never executed — the LIVE gate is the authority
		expect(JSON.stringify(sink[1]?.messages)).toContain("denied by the live gate");
	});

	it("T7/T8: system drift and version drift refuse with their codes", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const drifted = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [],
			system: `${SYSTEM} changed`,
		});
		const systemResult = await drifted.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(systemResult.isError).toBe(true);
		expect(systemResult.output).toContain("system-drift");
		const versioned = harness({ session: parent, baseDir: base, cwd, scripts: [], impVersion: "9.9.10" });
		const versionResult = await versioned.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(versionResult.isError).toBe(true);
		expect(versionResult.output).toContain("version-drift");
	});

	it("T9: a provider mismatch refuses (the transcript must not cross endpoints)", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const switched = harness({ session: parent, baseDir: base, cwd, scripts: [], providerName: "zai" });
		const refused = await switched.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("the current provider is zai");
	});

	it("T10: a grown tool pool refuses as tools-drift", async () => {
		const { base, cwd, parent } = await fixture();
		const { tool } = countingEcho();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const grown = harness({ session: parent, baseDir: base, cwd, scripts: [], tools: [tool, otherTool()] });
		const refused = await grown.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("tools-drift");
		expect(refused.output).toContain("would be added to the contract");
	});

	it("T11: cwd drift and a vanished cwd refuse", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const elsewhere = await mkdtemp(path.join(tmpdir(), "imp-elsewhere-"));
		const moved = harness({ session: parent, baseDir: base, cwd: elsewhere, scripts: [] });
		const drift = await moved.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(drift.isError).toBe(true);
		expect(drift.output).toContain("cwd-drift");

		const gone = await mkdtemp(path.join(tmpdir(), "imp-gone-"));
		const goneParent = createSession(gone, base);
		const { result: goneResult } = await dispatchAndPersist({
			session: goneParent,
			baseDir: base,
			cwd: gone,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const goneChild = childIdOf(goneResult);
		rmSync(gone, { recursive: true, force: true });
		const vanished = harness({ session: goneParent, baseDir: base, cwd: gone, scripts: [] });
		const missing = await vanished.task.execute({ resume: goneChild, prompt: "x" }, signal());
		expect(missing.isError).toBe(true);
		expect(missing.output).toContain("cwd-missing");
	});

	it("T13: a compacted child resumes from summary + retained tail, not the raw transcript", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const transcript = result.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		const child = SessionStore.open(transcript.path);
		child.appendCompaction("SUMMARY OF EARLIER WORK", [user("kept tail instruction")], 1234);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "resumed" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "new instruction" }, signal());
		expect(second.isError ?? false).toBe(false);
		const request = sink[0]; // the resume harness's own first request
		expect(request?.messages).toHaveLength(3); // summary + retained tail + ONE new instruction
		const serialized = JSON.stringify(request?.messages);
		expect(serialized).toContain("SUMMARY OF EARLIER WORK");
		expect(serialized).toContain("kept tail instruction");
		expect(serialized).toContain("new instruction");
		expect(serialized).not.toContain("first task");
	});

	it("T14: a crash-tail orphan is closed with an explicit unknown-outcome result before the new instruction", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const transcript = result.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		const child = SessionStore.open(transcript.path);
		child.appendMessage(
			assistant([{ type: "toolCall", id: "orphan1", name: "echo", arguments: { message: "lost" } }]),
		);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "resumed" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal());
		expect(second.isError ?? false).toBe(false);
		expect(second.output).toContain("transcript repaired: 1 interrupted tool call(s)");
		const entries = SessionStore.open(transcript.path).getEntries();
		const orphanIndex = entries.findIndex(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		const repairIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.results.some((r) => r.toolCallId === "orphan1"),
		);
		expect(repairIndex).toBeGreaterThan(orphanIndex);
		const repaired = entries[repairIndex];
		if (repaired?.type !== "message" || repaired.message.role !== "toolResult")
			throw new Error("no repair entry");
		expect(repaired.message.results[0]?.isError).toBe(true);
		expect(repaired.message.results[0]?.content).toContain("[imp] this tool call was interrupted");
		// The repaired pair precedes the new instruction in the request.
		const serialized = JSON.stringify(sink[0]?.messages);
		expect(serialized).toContain("interrupted before a result was recorded");
		expect(serialized.indexOf("interrupted before a result was recorded")).toBeLessThan(
			serialized.indexOf("continue please"),
		);
	});

	it("T16: an orphan beyond the crash tail refuses (malformed history) with no mutation", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const transcript = result.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		const child = SessionStore.open(transcript.path);
		child.appendMessage(assistant([{ type: "toolCall", id: "old-call", name: "echo", arguments: {} }]));
		child.appendMessage(user("later prompt"));
		const before = readFileSync(transcript.path, "utf8");
		const { task } = harness({ session: parent, baseDir: base, cwd, scripts: [] });
		const refused = await task.execute({ resume: childId, prompt: "x" }, signal());
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("inconsistent beyond a crash tail");
		expect(readFileSync(transcript.path, "utf8")).toBe(before); // refusals mutate nothing
	});

	it("T17: an orphan introduced by a NON-last assistant refuses as well", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		const transcript = result.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		const child = SessionStore.open(transcript.path);
		child.appendMessage(assistant([{ type: "toolCall", id: "old-call", name: "echo", arguments: {} }]));
		child.appendMessage(assistant([{ type: "toolCall", id: "new-call", name: "echo", arguments: {} }]));
		child.appendMessage({
			role: "toolResult",
			results: [{ toolCallId: "new-call", toolName: "echo", content: "ok", isError: false }],
		});
		const { task } = harness({ session: parent, baseDir: base, cwd, scripts: [] });
		const refused = await task.execute({ resume: childId, prompt: "x" }, signal());
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("inconsistent beyond a crash tail");
	});

	it("T22: recorded tool calls are never re-executed by history restoration", async () => {
		const { base, cwd, parent } = await fixture();
		const { tool, calls } = countingEcho();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [
				assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "x" } }]),
				assistant([{ type: "text", text: "done" }]),
			],
		});
		expect(calls()).toBe(1);
		const childId = childIdOf(result);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "resumed" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "next" }, signal());
		expect(second.isError ?? false).toBe(false);
		expect(calls()).toBe(1); // still one: the recorded call was NOT replayed
		expect(JSON.stringify(sink[0]?.messages)).toContain("echo: x"); // its RECORDED result is in context
	});

	it("T23: a capped child resumes with a fresh turn budget", async () => {
		const { base, cwd, parent } = await fixture();
		const loopStep = assistant([{ type: "toolCall", id: "cap", name: "echo", arguments: { message: "x" } }]);
		const { tool } = countingEcho();
		const first = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [loopStep],
		});
		expect(first.result.taskRecord?.status).toBe("max_iterations");
		const childId = childIdOf(first.result);
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "wrap up" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "finish the investigation" }, signal());
		expect(second.isError ?? false).toBe(false);
		expect(second.output).toContain("wrap up");
		expect(second.output).toContain("(child: 1 turns"); // THIS attempt only
		expect(second.output).toContain("(child lifetime: 2 attempts");
	}, 30_000);

	it("T4b: crashed and timed-out children are settled and resumable", async () => {
		const { base, cwd, parent } = await fixture();
		const crashed = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [
				() => {
					throw new Error("boom");
				},
			],
		});
		expect(crashed.result.taskRecord?.status).toBe("crash");
		const crashId = childIdOf(crashed.result);
		const { task: crashTask } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "recovered" }])],
		});
		const crashResume = await crashTask.execute({ resume: crashId, prompt: "recover" }, signal());
		expect(crashResume.isError ?? false).toBe(false);
		expect(crashResume.output).toContain("recovered");

		const timedOut = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			timeoutMs: 1000,
			scripts: [
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 1500));
					return assistant([{ type: "text", text: "late" }]);
				},
			],
		});
		expect(timedOut.result.taskRecord?.status).toBe("timeout");
		const timeoutId = childIdOf(timedOut.result);
		const { task: timeoutTask } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "after timeout" }])],
		});
		const timeoutResume = await timeoutTask.execute({ resume: timeoutId, prompt: "continue" }, signal());
		expect(timeoutResume.isError ?? false).toBe(false);
		expect(timeoutResume.output).toContain("after timeout");
	}, 15_000);

	it("T24: two concurrent resumes of one child — exactly one writer", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		let releaseGate!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [
				async () => {
					await held;
					return assistant([{ type: "text", text: "winner" }]);
				},
			],
		});
		const first = task.execute({ resume: childId, prompt: "attempt A" }, signal(), { toolCallId: "call-a" });
		await new Promise((resolve) => setTimeout(resolve, 30)); // let A acquire + reach the provider
		const second = await task.execute({ resume: childId, prompt: "attempt B" }, signal(), {
			toolCallId: "call-b",
		});
		releaseGate();
		const firstResult = await first;
		expect(firstResult.isError ?? false).toBe(false);
		expect(firstResult.output).toContain("winner");
		expect(second.isError).toBe(true);
		expect(second.output).toContain("already running in this process");
	}, 15_000);

	it("T26/T27/T27b: the attempt record keeps identity and the usage split stays exact", async () => {
		const { base, cwd, parent } = await fixture();
		const { tool } = countingEcho();
		const first = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(first.result);
		const transcript = first.result.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "resumed" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "next" }, signal(), {
			toolCallId: "call-2",
		});
		const record = second.taskRecord;
		expect(record?.childId).toBe(childId);
		expect(record?.attemptId).not.toBe(first.result.taskRecord?.attemptId);
		expect(record?.launched).toBe(true);
		expect(record?.binding?.reference).toBe("anthropic/parent-wire");
		expect(record?.cwd).toBe(cwd);
		expect(record?.transcript).toMatchObject({ present: true, path: transcript.path });
		expect(record?.worktree).toBeUndefined();
		// Attempt trailer: THIS attempt only; lifetime: both attempts summed.
		expect(second.output).toContain("(child: 1 turns, 10 in / 5 out)");
		expect(second.output).toContain("(child lifetime: 2 attempts, 20 in / 10 out)");
		// §8 pricing identity: the resumed assistant message carries the recorded reference.
		const reopened = SessionStore.open(transcript.path);
		const assistants = reopened
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const last = assistants[assistants.length - 1];
		if (last?.type !== "message" || last.message.role !== "assistant") throw new Error("no assistant");
		expect(last.message.modelReference).toBe("anthropic/parent-wire");
	});

	it("T27c: lifetime usage marks absence and incompleteness as ≥ (unit)", () => {
		const base = {
			attemptId: "a",
			sourceId: "s",
			launched: true,
			cwd: "/tmp",
			status: "completed",
			turns: 1,
			textPresent: true,
		} as const;
		const absent = buildTaskRecord({ ...base });
		expect(lifetimeUsageLine([absent], { inputTokens: 1, outputTokens: 1 })).toContain("≥");
		const incomplete = buildTaskRecord({
			...base,
			usage: { inputTokens: 5, outputTokens: 2, incomplete: true },
		});
		expect(lifetimeUsageLine([incomplete], { inputTokens: 1, outputTokens: 1 })).toContain("≥");
		const complete = buildTaskRecord({ ...base, usage: { inputTokens: 5, outputTokens: 2 } });
		const line = lifetimeUsageLine([complete], { inputTokens: 1, outputTokens: 1 });
		expect(line).toContain("2 attempts");
		expect(line).not.toContain("≥");
		expect(line).toContain("6 in / 3 out");
	});

	it("T31 (F3): a resumed attempt's result text never falls back into the restored history", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "OLD ANSWER: no defect in first case" }])],
		});
		const childId = childIdOf(result);

		// (a) the attempt fails before producing anything.
		const failing = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [
				() => {
					throw new Error("provider exploded");
				},
			],
		});
		const failed = await failing.task.execute({ resume: childId, prompt: "check the second case" }, signal());
		expect(failed.isError).toBe(true);
		expect(failed.output).not.toContain("OLD ANSWER");
		expect(failed.output).toContain("task failed after 0 turns");
		expect(failed.taskRecord?.textPresent).toBe(false);

		// (b) the attempt completes without text of its own.
		const silent = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([])],
		});
		const quiet = await silent.task.execute({ resume: childId, prompt: "check the second case" }, signal());
		expect(quiet.output).not.toContain("OLD ANSWER");
		expect(quiet.output).toContain("completed with no output");
		expect(quiet.taskRecord?.textPresent).toBe(false);
	});

	it("T32 (F3): mid-attempt compaction cannot resurrect the seeded answer (unit)", async () => {
		const oldUser = user("first task");
		const oldAnswer = assistant([{ type: "text", text: `OLD ANSWER ${"filler ".repeat(800)}` }]);
		const provider = scriptedProvider([
			assistant([{ type: "text", text: "SUMMARY OF PRIOR WORK" }]), // summarizer call
			assistant([]), // the attempt's own (silent) completion
		]);
		const outcome = await runSubagent({
			provider,
			model: "m",
			system: "S",
			tools: [],
			prompt: "second instruction",
			initialHistory: [oldUser, oldAnswer],
			initialFloor: 0,
			settings: { reserveTokens: 0, triggerTokens: 1, keepRecentTokens: 100, contextWindow: 1000 },
		});
		expect(outcome.usageDetail.summarizerCalls).toBe(1); // the splice really happened
		expect(outcome.status).toBe("completed");
		expect(outcome.text).toBeUndefined(); // never the seeded answer
	});

	it("T26b: a kept worktree child resumes in place — never auto-removed, prior disposition named", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-wt-resume-"));
		const repo = path.join(base, "repo");
		mkdirSync(repo, { recursive: true });
		const { spawnSync } = await import("node:child_process");
		const rgit = (args: string[]) => {
			const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
			if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		};
		rgit(["init", "-q", "-b", "main"]);
		rgit(["config", "user.email", "t@imp.dev"]);
		rgit(["config", "user.name", "t"]);
		writeFileSync(path.join(repo, "seed.txt"), "committed\n", "utf8");
		rgit(["add", "."]);
		rgit(["commit", "-qm", "seed"]);
		const parent = createSession(repo, base);
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd: repo,
			tools: [],
			getToolsForChild: (cwd: string) => [createWriteTool({ cwd })],
			scripts: [
				assistant([
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "kept.txt", content: "work\n" } },
				]),
				assistant([{ type: "text", text: "wrote the file" }]),
				assistant([{ type: "text", text: "second pass done" }]),
			],
		});
		const first = await task.execute({ prompt: "create the file", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		expect(first.output).toContain("changes kept in worktree");
		const childId = childIdOf(first);
		const worktreePath = first.taskRecord?.worktree?.path;
		if (worktreePath === undefined) throw new Error("no worktree path");
		persistRecord(parent, first);

		const second = await task.execute({ resume: childId, prompt: "now do a second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(false);
		expect(second.output).toContain("second pass done");
		expect(second.taskRecord?.childId).toBe(childId);
		expect(second.taskRecord?.cwd).toBe(worktreePath);
		expect(second.taskRecord?.worktree?.disposition).toBe("kept-unknown");
		expect(second.output).toContain("worktree kept at");
		expect(second.output).toContain("(the previous attempt recorded: kept-work)");
		expect(existsSync(worktreePath)).toBe(true); // resume never removes it
	}, 30_000);

	it("T3-fresh: the fresh result discloses the child id as a handle", async () => {
		const { base, cwd, parent } = await fixture();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "done" }])],
		});
		const childId = childIdOf(result);
		expect(result.output).toContain(`child session id: ${childId}`);
		expect(result.output).toContain(`task({resume: "${childId}"`);
	});

	it("T21-unit: taskResult never emits the handle line without a persisted session", () => {
		const outcome = {
			status: "completed" as const,
			text: "answer",
			turns: 1,
			usage: { inputTokens: 1, outputTokens: 1 },
			usageDetail: {
				task: { inputTokens: 1, outputTokens: 1 },
				summarizer: { inputTokens: 0, outputTokens: 0 },
				summarizerCalls: 0,
				incomplete: false,
			},
		};
		expect(taskResult(outcome, null).output).not.toContain("child session id:");
	});
});
