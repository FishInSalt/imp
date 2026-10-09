/**
 * SA-07 resume tests (design: docs/design/sa-07-child-resume-design.md).
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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../src/core/agents/registry.js";
import { acquireChildLease } from "../src/core/child-lease.js";
import { lifetimeUsageLine } from "../src/core/child-resume.js";
import { createSession, sessionsDirFor } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import { buildTaskRecord } from "../src/core/task-record.js";
import { createTaskTool, type TaskToolOptions, taskResult } from "../src/core/tools/task.js";
import type { Tool, ToolExecuteResult } from "../src/core/tools/types.js";
import { createWriteTool } from "../src/core/tools/write.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { assistant, type ScriptStep, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir, mkTempDirAsync } from "./helpers/mktemp.js";

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

/** #loop-health test vehicle: a tool that holds until its signal aborts
 *  (the child clock fires), for driving a settled-but-not-completed attempt. */
function holdingEcho(): { tool: Tool; calls: () => number } {
	let calls = 0;
	const tool: Tool = {
		name: "echo",
		description: "holds until aborted",
		parameters: Type.Object({ message: Type.String() }),
		async execute(_args, signal) {
			calls += 1;
			if (!signal.aborted) {
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
			}
			return { output: "held" };
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
	inkVersion?: string;
	agents?: AgentDefinition[];
	tools?: Tool[];
	timeoutMs?: number;
	childSessions?: boolean;
	getSessionOverride?: () => SessionStore | null;
	getToolsForChild?: TaskToolOptions["getToolsForChild"];
	onToolCall?: TaskToolOptions["onToolCall"];
	onBeforeResumeLease?: TaskToolOptions["onBeforeResumeLease"];
	/** SA-08 round 3 (F-4): override the getter so a test can swap the
	 *  provider inside the async spawn window. */
	getProvider?: () => LLMProvider;
	/** SA-09: the parent session's live thinking level (inherit fallback). */
	getThinkingLevel?: TaskToolOptions["getThinkingLevel"];
	withEnv?: boolean;
}

function harness(args: HarnessArgs): { task: Tool; sink: LLMRequest[] } {
	const sink: LLMRequest[] = [];
	const provider = scriptedProvider(args.scripts ?? [], sink, args.providerName ?? "anthropic");
	const system = args.system ?? SYSTEM;
	// Worktree children get a per-harness base inside the test's temp root
	// (fixture-hygiene §A1) instead of the raw-tmpdir default.
	const worktreeBaseDir = mkTempDir("ink-cr-wt-base-");
	const task = createTaskTool({
		getProvider: args.getProvider ?? (() => provider),
		getModel: () => "parent-wire",
		getModelReference: () => "anthropic/parent-wire",
		...(args.getThinkingLevel === undefined ? {} : { getThinkingLevel: args.getThinkingLevel }),
		getSystem: () => system,
		getTools: () => args.tools ?? [],
		getSession: args.getSessionOverride ?? (() => args.session),
		childSessions: args.childSessions ?? true,
		sessionBaseDir: args.baseDir,
		worktreeBaseDir,
		agents: args.agents ?? [],
		cwd: args.cwd,
		...(args.getToolsForChild === undefined ? {} : { getToolsForChild: args.getToolsForChild }),
		...(args.onToolCall === undefined ? {} : { onToolCall: args.onToolCall }),
		...(args.onBeforeResumeLease === undefined ? {} : { onBeforeResumeLease: args.onBeforeResumeLease }),
		...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
		...(args.withEnv === false
			? {}
			: {
					getLaunchEnvironment: () => ({
						inkVersion: args.inkVersion ?? "9.9.9",
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

/** SA-08 reopened F-2: rewrite ONLY the header line's launch.cwd — the
 *  tamper shape (worktree block stays valid, execution cwd diverges). */
function rewriteHeaderCwd(filePath: string, cwd: string): void {
	const raw = readFileSync(filePath, "utf8");
	const nl = raw.indexOf("\n");
	if (nl <= 0) throw new Error("no header line");
	const header = JSON.parse(raw.slice(0, nl)) as { launch: { cwd: string } };
	header.launch.cwd = cwd;
	writeFileSync(filePath, `${JSON.stringify(header)}${raw.slice(nl)}`);
}

/** SA-08 reopened F-2: a real repo (optionally with a seeded subdirectory). */
async function gitRepoWithSeed(base: string, sub?: string): Promise<string> {
	const repo = path.join(base, "repo");
	const seedDir = sub === undefined ? repo : path.join(repo, sub);
	mkdirSync(seedDir, { recursive: true });
	const { spawnSync } = await import("node:child_process");
	const rgit = (args: string[]) => {
		const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	};
	rgit(["init", "-q", "-b", "main"]);
	rgit(["config", "user.email", "t@ink.invalid"]);
	rgit(["config", "user.name", "t"]);
	writeFileSync(path.join(seedDir, "seed.txt"), "committed\n", "utf8");
	rgit(["add", "."]);
	rgit(["commit", "-qm", "seed"]);
	return repo;
}

async function fixture(): Promise<{ base: string; cwd: string; parent: SessionStore }> {
	const base = await mkTempDirAsync("ink-resume-");
	const cwd = await mkTempDirAsync("ink-resume-cwd-");
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

	it("SA-08/F1-a: a completed round between lookup and lease is seen (deterministic interleaving)", async () => {
		const { base, cwd, parent } = await fixture();
		let txPath = "";
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [
				assistant([{ type: "text", text: "child done" }]),
				assistant([{ type: "text", text: "resumed answer" }]),
			],
			onBeforeResumeLease: () => {
				// The other executor: acquire, complete one round, release —
				// strictly between our lookup/validation and our acquire. The
				// seam runs before our acquire, so this is protocol-legal.
				const other = acquireChildLease(txPath, "interleave-attempt");
				expect(other.ok).toBe(true);
				if (!other.ok) return;
				const store = SessionStore.open(txPath);
				store.appendMessage(user("other executor instruction"));
				store.appendMessage(assistant([{ type: "text", text: "other executor answer" }]));
				other.lease.release();
			},
		});
		const first = await task.execute({ prompt: "first task" }, signal(), { toolCallId: "call-1" });
		const childId = childIdOf(first);
		const transcript = first.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		txPath = transcript.path;
		persistRecord(parent, first);

		const second = await task.execute({ resume: childId, prompt: "resume prompt" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(false);

		// (a) the attempt's wire request carries the interleaved round.
		expect(JSON.stringify(sink[1]?.messages)).toContain("other executor instruction");
		// (b) no fork: both rounds are on the effective chain, and our
		// instruction chains onto the other round's last entry.
		const reopened = SessionStore.open(txPath);
		const messages = reopened.buildContext().messages;
		const userTexts = messages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(userTexts).toContain("other executor instruction");
		expect(userTexts).toContain("resume prompt");
		const entries = reopened.getEntries();
		const theirs = entries.find(
			(e) =>
				e.type === "message" &&
				e.message.role === "assistant" &&
				JSON.stringify(e.message).includes("other executor answer"),
		);
		const ours = entries.find(
			(e) => e.type === "message" && e.message.role === "user" && e.message.content === "resume prompt",
		);
		expect(ours?.parentId).toBe(theirs?.id);
	});

	it("SA-08/F1-b: a launch key-order change between the two reads is accepted (canonical guard)", async () => {
		const { base, cwd, parent } = await fixture();
		let txPath = "";
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [
				assistant([{ type: "text", text: "child done" }]),
				assistant([{ type: "text", text: "resumed answer" }]),
			],
			onBeforeResumeLease: () => {
				// Reorder the launch object's keys ON DISK between the two reads:
				// a comparison coupled to serialization order would refuse here;
				// canonical equality must not. Guard, not red-first (see design).
				const raw = readFileSync(txPath, "utf8");
				const nl = raw.indexOf("\n");
				if (nl <= 0) throw new Error("no header line");
				const header = JSON.parse(raw.slice(0, nl)) as { launch: Record<string, unknown> } & Record<
					string,
					unknown
				>;
				header.launch = Object.fromEntries(Object.entries(header.launch).reverse());
				writeFileSync(txPath, `${JSON.stringify(header)}${raw.slice(nl)}`);
			},
		});
		const first = await task.execute({ prompt: "first task" }, signal(), { toolCallId: "call-1" });
		const childId = childIdOf(first);
		const transcript = first.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		txPath = transcript.path;
		persistRecord(parent, first);

		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(false);
		expect(second.taskRecord?.launched).toBe(true);
	});

	it("R2a: a complete entry without a trailing newline is TERMINATED (kept), not lost", async () => {
		const base = await mkTempDirAsync("ink-torn-");
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
		const base = await mkTempDirAsync("ink-torn2-");
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
		const base = await mkTempDirAsync("ink-torn3-");
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
		const base = await mkTempDirAsync("ink-torn5-");
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
		const base = await mkTempDirAsync("ink-torn6-");
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
		const base = await mkTempDirAsync("ink-torn7-");
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
		const base = await mkTempDirAsync("ink-torn8-");
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
		const base = await mkTempDirAsync("ink-torn4-");
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
		const versioned = harness({ session: parent, baseDir: base, cwd, scripts: [], inkVersion: "9.9.10" });
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
		const elsewhere = await mkTempDirAsync("ink-elsewhere-");
		const moved = harness({ session: parent, baseDir: base, cwd: elsewhere, scripts: [] });
		const drift = await moved.task.execute({ resume: childId, prompt: "x" }, signal());
		expect(drift.isError).toBe(true);
		expect(drift.output).toContain("cwd-drift");

		const gone = await mkTempDirAsync("ink-gone-");
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
		expect(repaired.message.results[0]?.content).toContain("[ink] this tool call was interrupted");
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
		// Owner round 4: shapes carrying a later user/assistant message refuse
		// at the BOUNDARY (the tail wording now covers only pure toolResult
		// tails); behavior is unchanged — refusal, no mutation, no calls.
		expect(refused.output).toContain("still awaiting results");
		expect(refused.output).toContain("old-call");
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
		const rawBefore = readFileSync(transcript.path, "utf8");
		const { task, sink } = harness({ session: parent, baseDir: base, cwd, scripts: [] });
		const before = sink.length;
		const refused = await task.execute({ resume: childId, prompt: "x" }, signal());
		expect(refused.isError).toBe(true);
		// Owner round 4: boundary wording (the second assistant message begins
		// a turn while old-call still awaits results).
		expect(refused.output).toContain("still awaiting results");
		expect(refused.output).toContain("old-call");
		// The refusal predates any repair or provider call (impl-review fold).
		expect(sink).toHaveLength(before);
		expect(readFileSync(transcript.path, "utf8")).toBe(rawBefore);
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

	it("T23: a settled non-completed child resumes with a fresh turn budget", async () => {
		const { base, cwd, parent } = await fixture();
		// #loop-health: no live child can produce max_iterations anymore (the
		// 60-turn wall is gone). A holding tool + the child clock drives the
		// same "settled, not completed" first attempt (timeout); the resume
		// and lifetime assertions stay exactly as before.
		const { tool } = holdingEcho();
		const first = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			timeoutMs: 1000,
			scripts: [assistant([{ type: "toolCall", id: "hold-1", name: "echo", arguments: { message: "x" } }])],
		});
		expect(first.result.taskRecord?.status).toBe("timeout");
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

	it("T23b: a resumed attempt carries only its own health facts", async () => {
		const { base, cwd, parent } = await fixture();
		const { tool } = countingEcho();
		const loopSteps: ScriptStep[] = [];
		for (let i = 0; i < 5; i++) {
			loopSteps.push(
				assistant([{ type: "toolCall", id: `h${i}`, name: "echo", arguments: { message: "again" } }]),
			);
		}
		loopSteps.push(assistant([{ type: "text", text: "wrapped" }]));
		const first = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: loopSteps,
		});
		expect(first.result.taskRecord?.health).toHaveLength(1);
		expect(first.result.taskRecord?.health?.[0]).toMatchObject({ code: "repeat-loop", count: 5 });
		const childId = childIdOf(first.result);
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "clean resume" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "finish" }, signal());
		expect(second.isError ?? false).toBe(false);
		expect(second.output).toContain("clean resume");
		expect(second.output).not.toContain("[task] health:"); // THIS attempt only
		expect(second.taskRecord?.health).toBeUndefined();
	}, 30_000);

	it("T23c: a legacy max_iterations record in the parent session does not block resume", async () => {
		const { base, cwd, parent } = await fixture();
		const { tool } = countingEcho();
		const { task: firstTask } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "old attempt" }])],
		});
		const first = await firstTask.execute({ prompt: "first task" }, signal(), { toolCallId: "call-1" });
		const childId = childIdOf(first);
		const original = first.taskRecord;
		if (original === undefined) throw new Error("no record");
		// What an old imp wrote when the 60-turn wall fired: a max_iterations
		// record for a child that actually settled normally. Resume never
		// branches on the record's terminal status.
		const legacy = buildTaskRecord({ ...original, status: "max_iterations" });
		parent.appendMessage({
			role: "toolResult",
			results: [
				{
					toolCallId: "call-1",
					toolName: "task",
					content: first.output,
					isError: false,
					taskRecord: legacy,
				},
			],
		});
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [tool],
			scripts: [assistant([{ type: "text", text: "resumed legacy" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "continue" }, signal());
		expect(second.isError ?? false).toBe(false);
		expect(second.output).toContain("resumed legacy");
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
		const base = await mkTempDirAsync("ink-wt-resume-");
		const repo = path.join(base, "repo");
		mkdirSync(repo, { recursive: true });
		const { spawnSync } = await import("node:child_process");
		const rgit = (args: string[]) => {
			const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
			if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		};
		rgit(["init", "-q", "-b", "main"]);
		rgit(["config", "user.email", "t@ink.invalid"]);
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

	it("SA-08/F4-a: a provider swap during the spawn window does not reroute the attempt", async () => {
		const base = await mkTempDirAsync("ink-prov-swap-");
		const repo = await gitRepoWithSeed(base);
		const parent = createSession(repo, base);
		const sinkA: LLMRequest[] = [];
		const sinkB: LLMRequest[] = [];
		const providerA = scriptedProvider(
			[assistant([{ type: "text", text: "first pass done" }])],
			sinkA,
			"anthropic",
		);
		const providerB = scriptedProvider(
			[assistant([{ type: "text", text: "should not run" }])],
			sinkB,
			"anthropic",
		);
		let current: LLMProvider = providerA;
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd: repo,
			tools: [],
			getProvider: () => current,
			getToolsForChild: () => {
				// The deterministic /model swap: inside the async spawn window
				// (after resolution + worktree creation, before the attempt).
				current = providerB;
				return [];
			},
		});
		const first = await task.execute({ prompt: "first pass", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		// The DISCRIMINATING assertion: the attempt ran on the captured
		// provider pair, not the swapped one.
		expect(sinkA).toHaveLength(1);
		expect(JSON.stringify(sinkA[0]?.messages)).toContain("first pass");
		expect(sinkB).toHaveLength(0);
		expect(first.taskRecord?.binding?.reference).toBe("anthropic/parent-wire");
	}, 30_000);

	it("SA-09: a thinking-level change inside the spawn window does not drift the attempt", async () => {
		const base = await mkTempDirAsync("ink-think-pin-");
		const repo = await gitRepoWithSeed(base);
		const parent = createSession(repo, base);
		let level: "low" | "high" = "low";
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd: repo,
			tools: [],
			scripts: [assistant([{ type: "text", text: "done" }])],
			getThinkingLevel: () => level,
			getToolsForChild: () => {
				// The deterministic swap: runs inside the async spawn window
				// (after the spawn-time pin, before the attempt).
				level = "high";
				return [];
			},
		});
		const result = await task.execute({ prompt: "go", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(result.isError ?? false).toBe(false);
		expect(sink[0]?.thinking).toBe("low"); // the pin, not the swap
	}, 30_000);

	it("SA-09: resume re-resolves from the CURRENT file (a level added between launches wins)", async () => {
		const base = await mkTempDirAsync("ink-think-resume-");
		const cwd = await mkTempDirAsync("ink-think-resume-cwd-");
		const parent = createSession(cwd, base);
		const scout = (thinking?: "high"): AgentDefinition => ({
			name: "scout",
			description: "d",
			system: "Scout body.",
			source: "/x/scout.md",
			...(thinking === undefined ? {} : { thinking }),
		});
		const first = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "first" }])],
			agents: [scout()],
			getThinkingLevel: () => "low",
		});
		const dispatched = await first.task.execute({ prompt: "one", agent: "scout" }, signal(), {
			toolCallId: "call-1",
		});
		expect(dispatched.isError ?? false).toBe(false);
		expect(first.sink[0]?.thinking).toBe("low"); // inherited at spawn
		persistRecord(parent, dispatched);
		const childId = childIdOf(dispatched);

		// Between launches the file gained `thinking: high`; the parent stays low.
		const second = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "second answer" }])],
			agents: [scout("high")],
			getThinkingLevel: () => "low",
		});
		const resumed = await second.task.execute({ resume: childId, prompt: "two" }, signal(), {
			toolCallId: "call-2",
		});
		expect(resumed.isError ?? false).toBe(false);
		expect(second.sink[0]?.thinking).toBe("high"); // current file beats the parent
	});

	it("SA-09: resume re-resolves from the CURRENT parent level when the file has none", async () => {
		const base = await mkTempDirAsync("ink-think-resume2-");
		const cwd = await mkTempDirAsync("ink-think-resume2-cwd-");
		const parent = createSession(cwd, base);
		const scout = {
			name: "scout",
			description: "d",
			system: "Scout body.",
			source: "/x/scout.md",
		};
		const first = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "first" }])],
			agents: [scout],
			getThinkingLevel: () => "low",
		});
		const dispatched = await first.task.execute({ prompt: "one", agent: "scout" }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.sink[0]?.thinking).toBe("low");
		persistRecord(parent, dispatched);
		const childId = childIdOf(dispatched);

		const second = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "second answer" }])],
			agents: [scout],
			getThinkingLevel: () => "high",
		});
		const resumed = await second.task.execute({ resume: childId, prompt: "two" }, signal(), {
			toolCallId: "call-2",
		});
		expect(resumed.isError ?? false).toBe(false);
		expect(second.sink[0]?.thinking).toBe("high"); // the current parent level
	});

	it("SA-08/F2-a: a worktree child's cwd must sit inside the verified worktree (tampered cwd refused)", async () => {
		const base = await mkTempDirAsync("ink-wt-cwd-");
		const repo = await gitRepoWithSeed(base);
		const parent = createSession(repo, base);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd: repo,
			tools: [],
			getToolsForChild: (cwd: string) => [createWriteTool({ cwd })],
			scripts: [
				assistant([
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "kept.txt", content: "work\n" } },
				]),
				assistant([{ type: "text", text: "first pass done" }]),
				assistant([{ type: "text", text: "should not run" }]),
			],
		});
		const first = await task.execute({ prompt: "first pass", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		const childId = childIdOf(first);
		const transcript = first.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		persistRecord(parent, first);

		// Tamper: keep the valid worktree identity, point the execution cwd
		// at an unrelated directory.
		const unrelated = path.join(base, "unrelated");
		mkdirSync(unrelated, { recursive: true });
		rewriteHeaderCwd(transcript.path, unrelated);

		const requestsBefore = sink.length;
		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("worktree-cwd-outside");
		expect(second.output).toContain(unrelated);
		expect(sink).toHaveLength(requestsBefore); // the attempt never ran
	}, 30_000);

	it("SA-08/F2-b: a cwd symlink inside the worktree that resolves outside is refused", async () => {
		const base = await mkTempDirAsync("ink-wt-link-");
		const repo = await gitRepoWithSeed(base);
		const parent = createSession(repo, base);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd: repo,
			tools: [],
			getToolsForChild: (cwd: string) => [createWriteTool({ cwd })],
			scripts: [
				assistant([
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "kept.txt", content: "work\n" } },
				]),
				assistant([{ type: "text", text: "first pass done" }]),
				assistant([{ type: "text", text: "should not run" }]),
			],
		});
		const first = await task.execute({ prompt: "first pass", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		const childId = childIdOf(first);
		const worktreePath = first.taskRecord?.worktree?.path;
		const transcript = first.taskRecord?.transcript;
		if (worktreePath === undefined) throw new Error("no worktree path");
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		persistRecord(parent, first);

		// A symlinked path component INSIDE the worktree resolving outside
		// (the probe side owns the symlinked-worktree-root case).
		const outside = path.join(base, "outside");
		mkdirSync(outside, { recursive: true });
		const link = path.join(worktreePath, "linked");
		symlinkSync(outside, link);
		rewriteHeaderCwd(transcript.path, link);

		const requestsBefore = sink.length;
		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("worktree-cwd-outside");
		expect(sink).toHaveLength(requestsBefore); // the attempt never ran
	}, 30_000);

	it("SA-08/F2-c: a legitimate subdirectory-parent worktree child still resumes (no over-refusal)", async () => {
		const base = await mkTempDirAsync("ink-wt-sub-");
		const repo = await gitRepoWithSeed(base, "pkg");
		const sub = path.join(repo, "pkg");
		const parent = createSession(sub, base);
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd: sub,
			tools: [],
			getToolsForChild: (cwd: string) => [createWriteTool({ cwd })],
			scripts: [
				assistant([
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "kept.txt", content: "work\n" } },
				]),
				assistant([{ type: "text", text: "first pass done" }]),
				assistant([{ type: "text", text: "second pass done" }]),
			],
		});
		const first = await task.execute({ prompt: "first pass", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		const childId = childIdOf(first);
		const worktreePath = first.taskRecord?.worktree?.path;
		if (worktreePath === undefined) throw new Error("no worktree path");
		// Subdirectory parents keep their relative position inside the worktree.
		expect(first.taskRecord?.cwd).toBe(path.join(worktreePath, "pkg"));
		persistRecord(parent, first);

		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(false);
		expect(second.taskRecord?.cwd).toBe(path.join(worktreePath, "pkg"));
	}, 30_000);

	it("SA-08/F2-d: a plain file as the worktree child's cwd is refused (zero provider calls)", async () => {
		const base = await mkTempDirAsync("ink-wt-file-");
		const repo = await gitRepoWithSeed(base);
		const parent = createSession(repo, base);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd: repo,
			tools: [],
			getToolsForChild: (cwd: string) => [createWriteTool({ cwd })],
			scripts: [
				assistant([
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "kept.txt", content: "work\n" } },
				]),
				assistant([{ type: "text", text: "first pass done" }]),
				assistant([{ type: "text", text: "should not run" }]),
			],
		});
		const first = await task.execute({ prompt: "first pass", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		const childId = childIdOf(first);
		const worktreePath = first.taskRecord?.worktree?.path;
		const transcript = first.taskRecord?.transcript;
		if (worktreePath === undefined) throw new Error("no worktree path");
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		persistRecord(parent, first);

		const fileCwd = path.join(worktreePath, "plain.txt");
		writeFileSync(fileCwd, "not a directory\n", "utf8");
		rewriteHeaderCwd(transcript.path, fileCwd);

		const requestsBefore = sink.length;
		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(sink).toHaveLength(requestsBefore); // the attempt never ran — checked FIRST
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("cwd-not-directory");
	}, 30_000);

	it("SA-08/F2-e: a symlink inside the worktree whose final object is a file is refused", async () => {
		const base = await mkTempDirAsync("ink-wt-linkfile-");
		const repo = await gitRepoWithSeed(base);
		const parent = createSession(repo, base);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd: repo,
			tools: [],
			getToolsForChild: (cwd: string) => [createWriteTool({ cwd })],
			scripts: [
				assistant([
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "kept.txt", content: "work\n" } },
				]),
				assistant([{ type: "text", text: "first pass done" }]),
				assistant([{ type: "text", text: "should not run" }]),
			],
		});
		const first = await task.execute({ prompt: "first pass", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		const childId = childIdOf(first);
		const worktreePath = first.taskRecord?.worktree?.path;
		const transcript = first.taskRecord?.transcript;
		if (worktreePath === undefined) throw new Error("no worktree path");
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		persistRecord(parent, first);

		// The symlink's target is INSIDE the worktree, so containment alone
		// would accept it — dirness-first is the load-bearing check.
		const target = path.join(worktreePath, "plain.txt");
		writeFileSync(target, "not a directory\n", "utf8");
		const link = path.join(worktreePath, "link.txt");
		symlinkSync(target, link);
		rewriteHeaderCwd(transcript.path, link);

		const requestsBefore = sink.length;
		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(sink).toHaveLength(requestsBefore); // the attempt never ran — checked FIRST
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("cwd-not-directory");
	}, 30_000);

	it("SA-08/F2-f: a non-worktree cwd that became a file between attempts is refused", async () => {
		const { base, cwd, parent } = await fixture();
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [
				assistant([{ type: "text", text: "child done" }]),
				assistant([{ type: "text", text: "should not run" }]),
			],
		});
		const first = await task.execute({ prompt: "first task" }, signal(), { toolCallId: "call-1" });
		expect(first.isError ?? false).toBe(false);
		const childId = childIdOf(first);
		persistRecord(parent, first);

		// The directory the child ran in is replaced by a plain file. The
		// caller's cwd string is unchanged, so the drift comparison passes
		// and the type check is what must refuse.
		rmSync(cwd, { recursive: true, force: true });
		writeFileSync(cwd, "not a directory\n", "utf8");

		const requestsBefore = sink.length;
		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(sink).toHaveLength(requestsBefore); // the attempt never ran — checked FIRST
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("cwd-not-directory");
	});

	it("SA-08/F2-g: a symlink inside the worktree to a directory inside still resumes (no over-refusal)", async () => {
		const base = await mkTempDirAsync("ink-wt-linkdir-");
		const repo = await gitRepoWithSeed(base);
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
				assistant([{ type: "text", text: "first pass done" }]),
				assistant([{ type: "text", text: "second pass done" }]),
			],
		});
		const first = await task.execute({ prompt: "first pass", worktree: true }, signal(), {
			toolCallId: "call-1",
		});
		expect(first.isError ?? false).toBe(false);
		const childId = childIdOf(first);
		const worktreePath = first.taskRecord?.worktree?.path;
		const transcript = first.taskRecord?.transcript;
		if (worktreePath === undefined) throw new Error("no worktree path");
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		persistRecord(parent, first);

		const real = path.join(worktreePath, "real");
		mkdirSync(real, { recursive: true });
		const alias = path.join(worktreePath, "alias");
		symlinkSync(real, alias);
		rewriteHeaderCwd(transcript.path, alias);

		const second = await task.execute({ resume: childId, prompt: "second pass" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(false);
		expect(second.taskRecord?.launched).toBe(true);
	}, 30_000);

	it("SA-08/F5-a: a tool result with no preceding call is refused (zero provider calls)", async () => {
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
		child.appendMessage({
			role: "toolResult",
			results: [{ toolCallId: "ghost", toolName: "echo", content: "orphaned", isError: false }],
		});
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "should not run" }])],
		});
		const before = sink.length;
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("has no preceding tool call");
		expect(sink).toHaveLength(before); // zero provider calls
	});

	it("SA-08/F5-b: a tool result recorded before its call is refused (zero provider calls)", async () => {
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
		child.appendMessage({
			role: "toolResult",
			results: [{ toolCallId: "early", toolName: "echo", content: "before the call", isError: false }],
		});
		child.appendMessage(
			assistant([{ type: "toolCall", id: "early", name: "echo", arguments: { message: "x" } }]),
		);
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "should not run" }])],
		});
		const before = sink.length;
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("has no preceding tool call");
		expect(sink).toHaveLength(before); // zero provider calls
	});

	it("SA-08/F5-c: a trailing call reusing a completed id is refused, and no repair is appended", async () => {
		const { base, cwd, parent } = await fixture();
		const echo = countingEcho();
		const { result } = await dispatchAndPersist({
			session: parent,
			baseDir: base,
			cwd,
			tools: [echo.tool],
			scripts: [
				assistant([{ type: "toolCall", id: "c1", name: "echo", arguments: { message: "hé" } }]),
				assistant([{ type: "text", text: "done" }]),
			],
		});
		const childId = childIdOf(result);
		const transcript = result.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");
		// Reuse the ACTUAL completed call id from the first-pass transcript.
		const entries = SessionStore.open(transcript.path).getEntries();
		let completedId: string | undefined;
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.blocks) {
				if (block.type === "toolCall") completedId = block.id;
			}
		}
		if (completedId === undefined) throw new Error("no completed call id in the transcript");
		const child = SessionStore.open(transcript.path);
		child.appendMessage(
			assistant([{ type: "toolCall", id: completedId, name: "echo", arguments: { message: "again" } }]),
		);
		const rawBefore = readFileSync(transcript.path, "utf8");
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			tools: [echo.tool], // the recorded pool must rebuild identically
			scripts: [assistant([{ type: "text", text: "should not run" }])],
		});
		const before = sink.length;
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("declared more than once");
		expect(sink).toHaveLength(before); // zero provider calls
		expect(readFileSync(transcript.path, "utf8")).toBe(rawBefore); // no repair appended
	});

	it("SA-08/F5-d: a new assistant turn while a call awaits results is refused", async () => {
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
		child.appendMessage(assistant([{ type: "toolCall", id: "cross-d", name: "echo", arguments: {} }]));
		child.appendMessage(assistant([{ type: "text", text: "another turn" }]));
		child.appendMessage({
			role: "toolResult",
			results: [{ toolCallId: "cross-d", toolName: "echo", content: "late", isError: false }],
		});
		child.appendMessage(user("continue"));
		const rawBefore = readFileSync(transcript.path, "utf8");
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "should not run" }])],
		});
		const before = sink.length;
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("still awaiting results");
		expect(second.output).toContain("cross-d");
		expect(sink).toHaveLength(before); // zero provider calls
		expect(readFileSync(transcript.path, "utf8")).toBe(rawBefore); // no mutation
	});

	it("SA-08/F5-e: a user message inserted between a call and its result is refused", async () => {
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
		child.appendMessage(assistant([{ type: "toolCall", id: "cross-e", name: "echo", arguments: {} }]));
		child.appendMessage(user("interjected"));
		child.appendMessage({
			role: "toolResult",
			results: [{ toolCallId: "cross-e", toolName: "echo", content: "late", isError: false }],
		});
		const rawBefore = readFileSync(transcript.path, "utf8");
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "should not run" }])],
		});
		const before = sink.length;
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("still awaiting results");
		expect(second.output).toContain("cross-e");
		expect(sink).toHaveLength(before); // zero provider calls
		expect(readFileSync(transcript.path, "utf8")).toBe(rawBefore); // no mutation
	});

	it("SA-08/F5-f: a second batch while the first still awaits results is refused", async () => {
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
		child.appendMessage(assistant([{ type: "toolCall", id: "cross-f1", name: "echo", arguments: {} }]));
		child.appendMessage(assistant([{ type: "toolCall", id: "cross-f2", name: "echo", arguments: {} }]));
		// BOTH results arrive, so the sets balance — the current code accepts
		// this; the boundary rule must refuse at the second assistant message.
		child.appendMessage({
			role: "toolResult",
			results: [
				{ toolCallId: "cross-f2", toolName: "echo", content: "r2", isError: false },
				{ toolCallId: "cross-f1", toolName: "echo", content: "r1", isError: false },
			],
		});
		const rawBefore = readFileSync(transcript.path, "utf8");
		const { task, sink } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "should not run" }])],
		});
		const before = sink.length;
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(true);
		expect(second.output).toContain("still awaiting results");
		expect(second.output).toContain("cross-f1");
		expect(sink).toHaveLength(before); // zero provider calls
		expect(readFileSync(transcript.path, "utf8")).toBe(rawBefore); // no mutation
	});

	it("SA-08/F5-g: out-of-order results within one batch stay legal (no over-refusal)", async () => {
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
			assistant([
				{ type: "toolCall", id: "batch1", name: "echo", arguments: {} },
				{ type: "toolCall", id: "batch2", name: "echo", arguments: {} },
			]),
		);
		child.appendMessage({
			role: "toolResult",
			results: [
				{ toolCallId: "batch2", toolName: "echo", content: "r2", isError: false },
				{ toolCallId: "batch1", toolName: "echo", content: "r1", isError: false },
			],
		});
		const { task } = harness({
			session: parent,
			baseDir: base,
			cwd,
			scripts: [assistant([{ type: "text", text: "resumed fine" }])],
		});
		const second = await task.execute({ resume: childId, prompt: "continue please" }, signal(), {
			toolCallId: "call-2",
		});
		expect(second.isError ?? false).toBe(false);
		expect(second.taskRecord?.launched).toBe(true);
	});

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
			health: [],
		};
		expect(taskResult(outcome, null).output).not.toContain("child session id:");
	});
});
