import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApi, ToolCallEvent } from "../src/extensions/types.js";

// The real example file against a fake api (the example-extension test
// pattern): the factory's tool_call handler is driven directly with synthetic
// events, confirm is a spy the test answers — no REPL, no LLM, no network.

let fakeHome = "";

beforeEach(async () => {
	fakeHome = await mkdtemp(path.join(os.tmpdir(), "imp-guard-unit-"));
	vi.stubEnv("HOME", fakeHome); // guardian computes floors + the audit path from homedir
});

/** A minimal api double: captures subscriptions, confirm is controllable. */
function fakeApi(cwd: string): {
	api: ExtensionApi;
	gate: (event: Partial<ToolCallEvent>) => Promise<unknown>;
	confirm: ReturnType<typeof vi.fn>;
} {
	const handlers: Record<string, (event: ToolCallEvent) => unknown> = {};
	const confirm = vi.fn(async () => false);
	const api = {
		cwd,
		version: "test",
		origin: "project",
		registerTool: () => {},
		registerCommand: () => {},
		registerContext: () => {},
		on: (event: string, handler: (event: ToolCallEvent) => unknown) => {
			handlers[event] = handler;
		},
		confirm,
	} as unknown as ExtensionApi;
	const gate = (event: Partial<ToolCallEvent>): Promise<unknown> =>
		(handlers.tool_call as (e: ToolCallEvent) => Promise<unknown>)({
			type: "tool_call",
			toolCallId: "t1",
			name: "bash",
			args: {},
			...event,
		} as ToolCallEvent);
	return { api, gate, confirm };
}

/** Freshly imports the real guardian and wires it to a fake api. */
async function loadGuardian(cwd: string) {
	const mod = (await import(pathToFileURL(path.resolve("examples/extensions/guardian.mjs")).href)) as {
		default: (api: ExtensionApi) => void;
	};
	const wired = fakeApi(cwd);
	mod.default(wired.api);
	return wired;
}

const writeEvent = (cwd: string, target: string): Partial<ToolCallEvent> => ({
	name: "write",
	args: { path: target, content: "x" },
	cwd,
});

describe("guardian caller-cwd resolution (spec part 3 item 7)", () => {
	it("a worktree child writing an ABSOLUTE path inside its own worktree is allowed without asking (the M6b false positive)", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		const worktree = path.join("/tmp", "imp-worktree-abc123");
		const decision = await gate({
			...writeEvent(worktree, path.join(worktree, "src", "fix.ts")),
			subagent: true,
			agent: "builder",
		});
		expect(decision).toBeUndefined(); // no block
		expect(confirm).not.toHaveBeenCalled(); // and no question — it is inside the caller's tree
	});

	it("a write outside the caller cwd still asks; the declined answer returns the pre-confirm teaching text", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		const decision = await gate(writeEvent("/proj", "../escape.txt"));
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(decision).toEqual({
			block: true,
			reason:
				"writing outside the project directory (/proj) — keep changes inside it, or hand files beyond the project to the human",
		});
	});

	it("an approved outside-cwd write runs (no block)", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		confirm.mockResolvedValue(true);
		const decision = await gate(writeEvent("/proj", "/elsewhere/ok.txt"));
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(decision).toBeUndefined();
	});

	it("relative paths resolve against the caller cwd, not api.cwd (subagent event.cwd wins)", async () => {
		const { gate } = await loadGuardian("/proj");
		// same relative path, different caller: inside the worktree → allowed
		const inWorktree = await gate({ ...writeEvent("/tmp/imp-worktree-x", "note.txt"), subagent: true });
		expect(inWorktree).toBeUndefined();
		// ../../etc from the project root is still outside → asks (declined here)
		const outside = await gate(writeEvent("/proj", "../outside.txt"));
		expect(outside).toMatchObject({ block: true });
	});
});

describe("guardian ask-first destructive bash (spec part 3 item 8)", () => {
	it("rm -rf declined → the exact pre-confirm teaching reason; approved → runs", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		const declined = await gate({ args: { command: "rm -rf node_modules" } });
		expect(declined).toEqual({
			block: true,
			reason:
				"recursive force delete — list the files that would go and ask first, or delete the specific files one by one",
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]?.[0]).toContain("[guardian]");
		expect(String(confirm.mock.calls[0]?.[1])).toContain("rm -rf node_modules");

		confirm.mockResolvedValue(true);
		const approved = await gate({ args: { command: "rm -rf node_modules" } });
		expect(approved).toBeUndefined();
	});

	it("IMP_GUARDIAN_BLOCK custom patterns ask too; declined keeps the pattern reason", async () => {
		vi.stubEnv("IMP_GUARDIAN_BLOCK", "deploy-prod");
		const { gate } = await loadGuardian("/proj");
		const decision = await gate({ args: { command: "deploy-prod --yes" } });
		expect(decision).toEqual({
			block: true,
			reason: "matched your IMP_GUARDIAN_BLOCK pattern deploy-prod — adjust the env var if this should run",
		});
	});

	it("harmless bash never asks", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		expect(await gate({ args: { command: "ls -la && echo hi" } })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("guardian hard floor — never asks, always denies (spec part 3 item 9)", () => {
	it("writes under /etc, ~/.ssh, ~/.gnupg are denied without a confirm call", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		for (const target of [
			"/etc/imp-must-not-touch.conf",
			path.join(fakeHome, ".ssh", "authorized_keys"),
			path.join(fakeHome, ".gnupg", "private-keys-v1.d", "x.key"),
		]) {
			const decision = await gate(writeEvent("/proj", target));
			expect(decision).toMatchObject({ block: true });
			expect(String((decision as { reason: string }).reason)).toContain("[guardian]");
			expect(String((decision as { reason: string }).reason)).toContain("never asks");
		}
		expect(confirm).not.toHaveBeenCalled();
	});

	it("rm -rf aimed at a home directory root itself is denied without asking (~, $HOME, and absolute forms)", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		for (const command of [`rm -rf ${fakeHome}`, "rm -rf ~", "rm -rf $HOME", `rm -rf ${fakeHome}/`]) {
			const decision = await gate({ args: { command } });
			expect(decision).toMatchObject({ block: true });
			expect(String((decision as { reason: string }).reason)).toContain(fakeHome);
		}
		expect(confirm).not.toHaveBeenCalled();
	});

	it("rm aimed under a protected dir (e.g. /etc) is denied without asking too", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		const decision = await gate({ args: { command: "rm -rf /etc/hosts.bak" } });
		expect(decision).toMatchObject({ block: true });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("rm -rf inside the caller cwd still goes through the ask path, not the floor", async () => {
		const { gate, confirm } = await loadGuardian("/proj");
		await gate({ args: { command: "rm -rf /proj/build" } });
		expect(confirm).toHaveBeenCalledTimes(1); // asked, not floor-denied
	});
});
