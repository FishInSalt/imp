/**
 * SA-07 red evidence (design: docs/sa-07-child-resume-design.md).
 *
 * These tests encode the FINAL contract and are expected to fail on the
 * pre-implementation tree:
 *   R1 — `resume` is not a task parameter: the call below runs a FRESH child
 *        instead of continuing the same one.
 *   R2 — the store has no structural torn-final-line detection/repair.
 *   R3 — the task schema does not expose `resume`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSession, sessionsDirFor } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { createTaskTool } from "../src/core/tools/task.js";
import type { LLMRequest } from "../src/provider/types.js";
import { assistant, type ScriptStep, scriptedProvider, user } from "./helpers/fakes.js";

const SYSTEM = "PARENT SYSTEM\n- Date: 2026-09-29";

function resumeHarness(args: {
	session: SessionStore;
	sessionBaseDir: string;
	cwd: string;
	scripts: ScriptStep[];
}) {
	const sink: LLMRequest[] = [];
	const provider = scriptedProvider(args.scripts, sink, "anthropic");
	const task = createTaskTool({
		getProvider: () => provider,
		getModel: () => "parent-wire",
		getModelReference: () => "anthropic/parent-wire",
		getSystem: () => SYSTEM,
		getTools: () => [],
		getSession: () => args.session,
		childSessions: true,
		sessionBaseDir: args.sessionBaseDir,
		agents: [],
		cwd: args.cwd,
		getLaunchEnvironment: () => ({
			impVersion: "9.9.9",
			systemText: SYSTEM,
			contextFiles: [],
			promptFiles: [],
			extensionContexts: [],
			extensions: [],
		}),
	});
	return { task, sink };
}

describe("SA-07 resume — red evidence", () => {
	it("RED R1: resume continues the SAME child with exactly one new instruction", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-resume-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "imp-resume-cwd-"));
		const parent = createSession(cwd, base);
		const { task, sink } = resumeHarness({
			session: parent,
			sessionBaseDir: base,
			cwd,
			scripts: [
				assistant([{ type: "text", text: "child done" }]),
				assistant([{ type: "text", text: "second answer" }]),
			],
		});

		const first = await task.execute({ prompt: "first task" }, new AbortController().signal, {
			toolCallId: "call-1",
		});
		const childId = first.taskRecord?.childId;
		if (childId === undefined) throw new Error("no childId in the first record");
		const transcript = first.taskRecord?.transcript;
		if (transcript === undefined || transcript.present === false) throw new Error("no transcript");

		// Persist the record like the loop does; the child is now settled.
		parent.appendMessage({
			role: "toolResult",
			results: [
				{
					toolCallId: "call-1",
					toolName: "task",
					content: first.output,
					isError: false,
					taskRecord: first.taskRecord,
				},
			],
		});

		// RED today: `resume` is not a parameter — this runs a FRESH child.
		const second = await task.execute({ resume: childId, prompt: "check the second case" }, new AbortController().signal, {
			toolCallId: "call-2",
		});

		// 1. The logical identity is preserved: the SAME child.
		expect(second.taskRecord?.childId).toBe(childId);

		// 2. Exactly one new user instruction appended to the SAME transcript;
		//    the original instruction is present once and not re-sent as a new
		//    message.
		const reopened = SessionStore.open(transcript.path);
		const messages = reopened.buildContext().messages;
		const userTexts = messages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(userTexts.filter((t) => t === "check the second case")).toHaveLength(1);
		expect(userTexts.filter((t) => t === "first task")).toHaveLength(1);

		// 3. The continuation request carried the child's own prior context.
		expect(sink).toHaveLength(2);
		expect(JSON.stringify(sink[1]?.messages)).toContain("first task");

		// 4. No second child file was created.
		const childrenDir = path.join(sessionsDirFor(cwd, base), "children");
		expect(readdirSync(childrenDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("RED R2a: a complete entry without a trailing newline is TERMINATED (kept), not lost", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store");
		store.appendMessage(user("first"));
		store.appendMessage(user("second"));
		// Shape b: a complete entry whose trailing newline never landed.
		const raw = readFileSync(filePath, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		writeFileSync(filePath, raw.slice(0, -1));

		const reopened = SessionStore.open(filePath) as unknown as {
			tornFinalLine?: boolean;
			repairTornFinalLine?: () => { action: string; bytes: number } | undefined;
		};
		// RED today: the structural fact does not exist (the line parses, so
		// nothing flags it — and the next append would merge two entries).
		expect(reopened.tornFinalLine).toBe(true);
		const repair = reopened.repairTornFinalLine?.();
		expect(repair?.action).toBe("terminated");
		expect(readFileSync(filePath, "utf8").endsWith("\n")).toBe(true);
		// The complete entry is KEPT: both messages survive a reopen.
		const finalStore = SessionStore.open(filePath);
		expect(finalStore.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("RED R2b: an unparseable fragment is TRUNCATED at the last newline", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-torn2-"));
		const filePath = path.join(base, "torn.jsonl");
		const store = SessionStore.create(filePath, base, "torn-store-2");
		store.appendMessage(user("first"));
		writeFileSync(filePath, `${readFileSync(filePath, "utf8")}{"type":"mess`);

		const reopened = SessionStore.open(filePath) as unknown as {
			tornFinalLine?: boolean;
			repairTornFinalLine?: () => { action: string; bytes: number } | undefined;
		};
		expect(reopened.tornFinalLine).toBe(true);
		const repair = reopened.repairTornFinalLine?.();
		expect(repair?.action).toBe("truncated");
		expect(repair?.bytes).toBeGreaterThan(0);
		expect(readFileSync(filePath, "utf8").endsWith("\n")).toBe(true);
		const finalStore = SessionStore.open(filePath);
		expect(finalStore.getEntries().filter((entry) => entry.type === "message")).toHaveLength(1);
	});

	it("RED R3: the task schema exposes the resume parameter", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-resume3-"));
		const parent = createSession(base, base);
		const { task } = resumeHarness({
			session: parent,
			sessionBaseDir: base,
			cwd: base,
			scripts: [assistant([{ type: "text", text: "x" }])],
		});
		const properties = (task.parameters as unknown as { properties?: Record<string, unknown> }).properties;
		expect(properties?.resume).toBeDefined();
	});
});
