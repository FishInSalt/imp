import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/core/session/manager.js";
import { copyToClipboard } from "../src/repl/clipboard-write.js";
import { user } from "./helpers/fakes.js";

describe("clipboard-write (M16 /copy backing)", () => {
	it("falls back to OSC 52 when no platform command runs (headless linux env)", async () => {
		const writes: string[] = [];
		// darwin pushes pbcopy; a PATH without it makes runClipboardCommand
		// fail (spawn ENOENT) → the escape is the last resort.
		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			await copyToClipboard("hello", {
				write: (data) => writes.push(data),
				env: { TERMUX_VERSION: "", WAYLAND_DISPLAY: "", DISPLAY: "" },
			});
		} finally {
			process.env.PATH = previousPath;
		}
		const expected = Buffer.from("hello", "utf8").toString("base64");
		expect(writes).toEqual([`\x1B]52;c;${expected}\x07`]);
	});

	it("refuses texts whose OSC 52 encoding exceeds the 100k cap", async () => {
		const writes: string[] = [];
		// PATH cleared so pbcopy (present on macOS runners!) cannot succeed
		// and write 200KB into the developer's real clipboard.
		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			await expect(
				copyToClipboard("x".repeat(200_001), {
					write: (data) => writes.push(data),
					env: {},
				}),
			).rejects.toThrow(/no clipboard writer available/);
		} finally {
			process.env.PATH = previousPath;
		}
		expect(writes).toHaveLength(0);
	});
});

describe("session_info entries (M16 /name)", () => {
	it("set → shows → append overwrites; empty name clears", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-name-"));
		const store = createSession(path.join(base, "proj"), base);
		store.appendMessage(user("hello"));
		expect(store.getSessionName()).toBeUndefined();
		store.appendSessionName("fix the parser");
		expect(store.getSessionName()).toBe("fix the parser");
		store.appendSessionName("round two");
		expect(store.getSessionName()).toBe("round two");
		store.appendSessionName("   ");
		expect(store.getSessionName()).toBeUndefined();
		// compaction/stats see zero difference: metadata, not context
		expect(store.buildContext().messages).toHaveLength(1);
	});

	it("branch-local (M16 review P2-4): /fork leaves the name behind; /tree back returns it", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-name-"));
		const store = createSession(path.join(base, "proj"), base);
		store.appendMessage(user("first"));
		store.appendMessage(user("second"));
		store.appendSessionName("on the main branch");
		// fork BEFORE the first user message: the write position moves to the
		// root, and the name entry is off the new branch's path
		const forkPoint = store.userForkPoints()[0];
		expect(forkPoint).toBeDefined();
		store.forkBefore(forkPoint?.id ?? "");
		expect(store.getSessionName()).toBeUndefined();
		// the name entry is the leaf of the abandoned branch — /tree lists it
		// (otherBranchTips) and switching to that tip restores the name
		const tips = store.otherBranchTips();
		expect(tips.length).toBeGreaterThan(0);
		const nameTip = tips[tips.length - 1]; // the abandoned old branch
		expect(nameTip).toBeDefined();
		store.switchBranch(nameTip?.id ?? "");
		expect(store.getSessionName()).toBe("on the main branch");
	});

	it("forward compat (M16 review P2-5): unknown FIELDS ride along; the name still reads", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-name-"));
		const dir = path.join(base, "proj-sessions");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "s.jsonl");
		writeFileSync(
			file,
			JSON.stringify({
				type: "session",
				version: 1,
				id: "a1b2c3d4-0000",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) +
				"\n" +
				JSON.stringify({
					type: "session_info",
					id: "aaaa0001",
					parentId: null,
					timestamp: new Date().toISOString(),
					name: "futureproof",
					futureField: { nested: true },
				}) +
				"\n",
			"utf-8",
		);
		const { SessionStore } = await import("../src/core/session/store.js");
		expect(SessionStore.open(file).getSessionName()).toBe("futureproof");
	});

	it("round-trips through the file: reopen finds the name", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-name-"));
		const store = createSession(path.join(base, "proj"), base);
		store.appendMessage(user("hello"));
		store.appendSessionName("persisted");
		const { SessionStore } = await import("../src/core/session/store.js");
		const reopened = SessionStore.open(store.filePath);
		expect(reopened.getSessionName()).toBe("persisted");
	});
});
