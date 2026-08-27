import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import {
	createSession,
	listSessions,
	resolveSession,
	SessionNotFoundError,
	sessionsDirFor,
} from "../src/core/session/manager.js";
import type { SessionStore } from "../src/core/session/store.js";

const user = (content: string): AgentMessage => ({ role: "user", content });
const assistantText = (text: string): AgentMessage => ({
	role: "assistant",
	blocks: [{ type: "text", text }],
	usage: { inputTokens: 10, outputTokens: 5 },
	stopReason: "end_turn",
});

async function setup(): Promise<{ baseDir: string; cwd: string }> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-sessions-"));
	const cwd = path.join(baseDir, "proj");
	return { baseDir, cwd };
}

function seed(baseDir: string, cwd: string, messages: AgentMessage[]): SessionStore {
	const store = createSession(cwd, baseDir);
	for (const message of messages) store.appendMessage(message);
	return store;
}

describe("session manager", () => {
	it("sessions dir sanitizes the cwd path (pi-style dashes)", async () => {
		const dir = sessionsDirFor("/Users/z/proj", "/base");
		expect(dir).toBe(path.join("/base", "Users-z-proj"));
	});

	it("creates session files under the project dir and lists them newest first", async () => {
		const { baseDir, cwd } = await setup();
		const s1 = seed(baseDir, cwd, [user("first session question"), assistantText("a")]);
		await new Promise((r) => setTimeout(r, 20)); // distinct mtime
		const s2 = seed(baseDir, cwd, [user("second session question"), assistantText("b")]);

		const list = listSessions(cwd, baseDir);
		expect(list.length).toBe(2);
		expect(list[0]?.id).toBe(s2.header.id);
		expect(list[1]?.id).toBe(s1.header.id);
		expect(list[0]?.title).toBe("second session question");
		expect(list[0]?.messageCount).toBe(2);
		expect(list[0]?.turnCount).toBe(1);
	});

	it("continueRecent resolves the latest session, or null when none", async () => {
		const { baseDir, cwd } = await setup();
		expect(resolveSession(cwd, { continueRecent: true, baseDir })).toBeNull();
		const store = seed(baseDir, cwd, [user("hi"), assistantText("hello")]);
		const resumed = resolveSession(cwd, { continueRecent: true, baseDir });
		expect(resumed?.header.id).toBe(store.header.id);
		expect(resumed?.buildContext().messages.length).toBe(2);
	});

	it("resume matches by full id, prefix, and file name; ambiguous prefixes error", async () => {
		const { baseDir, cwd } = await setup();
		const store = seed(baseDir, cwd, [user("x"), assistantText("y")]);
		const id = store.header.id;

		expect(resolveSession(cwd, { resume: id, baseDir })?.header.id).toBe(id);
		expect(resolveSession(cwd, { resume: id.slice(0, 8), baseDir })?.header.id).toBe(id);
		const fileName = path.basename(store.filePath);
		expect(resolveSession(cwd, { resume: fileName, baseDir })?.header.id).toBe(id);
		expect(resolveSession(cwd, { resume: fileName.replace(/\.jsonl$/, ""), baseDir })?.header.id).toBe(id);

		expect(() => resolveSession(cwd, { resume: "zzz", baseDir })).toThrow(SessionNotFoundError);
	});

	it("ambiguous prefix across two sessions throws with candidates listed", async () => {
		const { baseDir, cwd } = await setup();
		const a = seed(baseDir, cwd, [user("a")]);
		seed(baseDir, cwd, [user("b")]);
		// resume by the unique full id works even with several sessions present
		const resumed = resolveSession(cwd, { resume: a.header.id, baseDir });
		expect(resumed?.header.id).toBe(a.header.id);
	});

	it("corrupt session files are skipped, not fatal", async () => {
		const { baseDir, cwd } = await setup();
		seed(baseDir, cwd, [user("good"), assistantText("one")]);
		const dir = sessionsDirFor(cwd, baseDir);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path.join(dir, "broken.jsonl"), "garbage that is not json\n");
		const list = listSessions(cwd, baseDir);
		expect(list.length).toBe(1);
	});
});
