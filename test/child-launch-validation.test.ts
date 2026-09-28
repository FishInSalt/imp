import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildChildLaunch,
	type ChildLaunchFile,
	type CurrentChildEnvironment,
	findChildByLaunch,
	validateChildContinuation,
} from "../src/core/child-launch.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { buildTaskRecord } from "../src/core/task-record.js";

const MODEL = {
	providerName: "anthropic",
	wireModelId: "claude-sonnet-4-6",
	reference: "anthropic/claude-sonnet-4-6",
} as const;
const SYSTEM_TEXT = "You are imp.\n\n- Date: 2026-09-28\n\nrest";
const AGENT_BODY = "You are scout.";
const CONTEXT_PATH = "/p/AGENTS.md";
const PROMPT_PATH = "/p/.imp/SYSTEM.md";
const EXT = [{ name: "foo", origin: "global" as const, path: "/p/foo.mjs", sha256: "b".repeat(64) }];

interface World {
	parent: SessionStore;
	file: ChildLaunchFile;
	current: CurrentChildEnvironment;
	cwd: string;
}

/** Parent session (with a settled record) + child file with a launch block,
 *  plus a current-environment fixture that matches everything by default. */
async function makeWorld(options: { noRecord?: boolean; noContent?: boolean } = {}): Promise<World> {
	const base = await mkdtemp(path.join(tmpdir(), "imp-clv-"));
	const cwd = mkdtempSync(path.join(tmpdir(), "imp-clv-cwd-"));
	const parent = createSession(cwd, base);
	parent.appendMessage({ role: "user", content: "parent message" });
	const childId = "child-1";
	const launch = buildChildLaunch({
		parentSessionId: parent.header.id,
		childId,
		impVersion: "9.9.9",
		agent: { name: "scout", system: AGENT_BODY, source: "/agents/scout.md" },
		model: { ...MODEL },
		cwd,
		tools: [{ name: "web_search", mcpServer: "searx" }, { name: "read" }],
		systemText: SYSTEM_TEXT,
		contextFiles: [{ path: CONTEXT_PATH, content: "hello" }],
		promptFiles: [{ kind: "override", path: PROMPT_PATH, text: "sys" }],
		extensionContexts: [{ id: "ctx", text: "ext ctx" }],
		extensions: EXT,
	});
	const filePath = path.join(path.dirname(parent.filePath), "children", "child.jsonl");
	mkdirSync(path.dirname(filePath), { recursive: true });
	if (options.noContent) {
		// Header + launch persisted, zero conversation entries.
		const header = {
			type: "session",
			version: 1,
			id: childId,
			timestamp: new Date().toISOString(),
			cwd: parent.header.cwd,
			parent: parent.header.id,
			launch,
		};
		writeFileSync(filePath, `${JSON.stringify(header)}\n`, "utf8");
	} else {
		const store = SessionStore.create(
			filePath,
			parent.header.cwd,
			childId,
			parent.header.id,
			launch as never,
		);
		store.appendMessage({ role: "user", content: "child prompt" });
	}
	if (!options.noRecord) {
		const record = buildTaskRecord({
			attemptId: "attempt-1",
			sourceId: "source-1",
			launched: true,
			parentSessionId: parent.header.id,
			childId,
			cwd,
			status: "completed",
			turns: 1,
			textPresent: true,
			tools: ["read"],
		});
		parent.appendMessage({
			role: "toolResult",
			results: [
				{
					toolCallId: "call-1",
					toolName: "task",
					content: "child done",
					isError: false,
					taskRecord: record,
				},
			],
		});
	}
	const found = findChildByLaunch(parent, childId);
	if (!found.ok) throw new Error(`fixture lookup failed: ${found.code} ${found.message}`);
	const current: CurrentChildEnvironment = {
		impVersion: "9.9.9",
		systemText: SYSTEM_TEXT,
		cwd,
		agentResolver: (name) => (name === "scout" ? { system: AGENT_BODY } : undefined),
		contextFiles: [{ path: CONTEXT_PATH, content: "hello" }],
		promptFiles: [{ kind: "override", path: PROMPT_PATH, text: "sys" }],
		extensionContexts: [{ id: "ctx", text: "ext ctx" }],
		extensions: [...EXT],
		// Deliberately unsorted: the validator canonicalizes before comparing.
		childTools: [{ name: "web_search", mcpServer: "searx" }, { name: "read" }],
		binding: { ...MODEL },
	};
	return { parent, file: found.file, current, cwd };
}

function codes(reasons: Array<{ code: string }>): string[] {
	return reasons.map((r) => r.code);
}

describe("child continuation — verdict basics", () => {
	it("an unchanged environment, a settled record and content yields resumable", async () => {
		const { parent, file, current } = await makeWorld();
		const verdict = await validateChildContinuation(file, parent, current);
		expect(verdict.reasons).toEqual([]);
		expect(verdict).toMatchObject({
			resumable: true,
			executionState: "settled",
			attempts: 1,
			lastStatus: "completed",
		});
	});

	it("unknown fields in the launch block never influence the verdict", async () => {
		const { parent, file, current } = await makeWorld();
		const tampered: ChildLaunchFile = {
			...file,
			launch: { ...file.launch, approved: true } as never,
		};
		const verdict = await validateChildContinuation(tampered, parent, current);
		// Unknown fields are ignored by construction: the record cannot grant
		// anything (no permission grants exist in the schema), so the verdict
		// is unchanged by an injected "approved: true".
		expect(verdict.resumable).toBe(true);
	});

	it("no settled record => not resumable, execution state unknown (invariant)", async () => {
		const { parent, file, current } = await makeWorld({ noRecord: true });
		const verdict = await validateChildContinuation(file, parent, current);
		expect(codes(verdict.reasons)).toContain("no-record");
		expect(verdict.executionState).toBe("unknown");
		expect(verdict.resumable).toBe(false);
	});

	it("zero conversation content => empty-transcript, not resumable", async () => {
		const { parent, file, current } = await makeWorld({ noContent: true });
		const verdict = await validateChildContinuation(file, parent, current);
		expect(codes(verdict.reasons)).toContain("empty-transcript");
		expect(verdict.resumable).toBe(false);
	});

	it("records on an abandoned branch still count (all-entries basis) with onCurrentBranch false", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-clv-"));
		const cwd = mkdtempSync(path.join(tmpdir(), "imp-clv-cwd-"));
		const parent = createSession(cwd, base);
		const childId = "child-fork";
		const launch = buildChildLaunch({
			parentSessionId: parent.header.id,
			childId,
			impVersion: "9.9.9",
			model: { ...MODEL },
			cwd,
			tools: [{ name: "read" }],
			systemText: SYSTEM_TEXT,
			contextFiles: [],
			promptFiles: [],
			extensionContexts: [],
			extensions: [],
		});
		const filePath = path.join(path.dirname(parent.filePath), "children", "forked.jsonl");
		mkdirSync(path.dirname(filePath), { recursive: true });
		const child = SessionStore.create(
			filePath,
			parent.header.cwd,
			childId,
			parent.header.id,
			launch as never,
		);
		child.appendMessage({ role: "user", content: "prompt" });
		// Hand-crafted parent tree: A -> {B record entry, C tip} — the record
		// lives on a branch the current leaf does not walk.
		const record = buildTaskRecord({
			attemptId: "attempt-fork",
			sourceId: "source-1",
			launched: true,
			childId,
			cwd,
			status: "completed",
			turns: 1,
			textPresent: true,
		});
		const line = (id: string, parentId: string | null, message: unknown) =>
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				message,
			});
		const header = {
			type: "session",
			version: 1,
			id: parent.header.id,
			timestamp: new Date().toISOString(),
			cwd,
		};
		writeFileSync(
			parent.filePath,
			`${[
				JSON.stringify(header),
				line("aaaaaaaa", null, { role: "user", content: "A" }),
				line("bbbbbbbb", "aaaaaaaa", {
					role: "toolResult",
					results: [
						{
							toolCallId: "call-1",
							toolName: "task",
							content: "done",
							isError: false,
							taskRecord: record,
						},
					],
				}),
				line("cccccccc", "aaaaaaaa", { role: "user", content: "C — the tip" }),
			].join("\n")}\n`,
			"utf8",
		);
		const reopened = SessionStore.open(parent.filePath);
		const found = findChildByLaunch(reopened, childId);
		if (!found.ok) throw new Error(`${found.code}: ${found.message}`);
		const current: CurrentChildEnvironment = {
			impVersion: "9.9.9",
			systemText: SYSTEM_TEXT,
			cwd,
			agentResolver: () => undefined,
			contextFiles: [],
			promptFiles: [],
			extensionContexts: [],
			extensions: [],
			childTools: [{ name: "read" }],
			binding: { ...MODEL },
		};
		const verdict = await validateChildContinuation(found.file, reopened, current);
		expect(verdict.resumable).toBe(true);
		expect(verdict.executionState).toBe("settled");
		expect(verdict.onCurrentBranch).toBe(false);
	});
});

describe("child continuation — drift matrix", () => {
	it("imp version drift => version-drift", async () => {
		const { parent, file, current } = await makeWorld();
		const verdict = await validateChildContinuation(file, parent, { ...current, impVersion: "0.0.1" });
		expect(codes(verdict.reasons)).toContain("version-drift");
	});

	it("agent removed / body edited => agent-missing / agent-drift", async () => {
		const { parent, file, current } = await makeWorld();
		const missing = await validateChildContinuation(file, parent, {
			...current,
			agentResolver: () => undefined,
		});
		expect(codes(missing.reasons)).toContain("agent-missing");
		const drifted = await validateChildContinuation(file, parent, {
			...current,
			agentResolver: () => ({ system: "You are scout. (edited)" }),
		});
		expect(codes(drifted.reasons)).toContain("agent-drift");
	});

	it("assembled system text change => system-drift", async () => {
		const { parent, file, current } = await makeWorld();
		const verdict = await validateChildContinuation(file, parent, {
			...current,
			systemText: `${SYSTEM_TEXT}\nnew rules`,
		});
		expect(codes(verdict.reasons)).toContain("system-drift");
	});

	it("a date-only change is NOT drift (the normalized line)", async () => {
		const { parent, file, current } = await makeWorld();
		const nextDay = SYSTEM_TEXT.replace("2026-09-28", "2026-10-31");
		const verdict = await validateChildContinuation(file, parent, { ...current, systemText: nextDay });
		expect(verdict.resumable).toBe(true);
	});

	it("context files changed vs no longer readable produce context-files-drift with distinct messages", async () => {
		const { parent, file, current } = await makeWorld();
		const changed = await validateChildContinuation(file, parent, {
			...current,
			contextFiles: [{ path: CONTEXT_PATH, content: "hello (edited)" }],
		});
		expect(codes(changed.reasons)).toContain("context-files-drift");
		expect(changed.reasons.find((r) => r.code === "context-files-drift")?.message).toContain(
			"content changed",
		);

		const unreadable = await validateChildContinuation(file, parent, {
			...current,
			contextFiles: [],
		});
		expect(codes(unreadable.reasons)).toContain("context-files-drift");
		expect(unreadable.reasons.find((r) => r.code === "context-files-drift")?.message).toMatch(
			/no longer readable|missing/,
		);
	});

	it("prompt files, extension contexts, extensions, tools and binding each yield their code", async () => {
		const { parent, file, current } = await makeWorld();
		const cases: Array<[Partial<CurrentChildEnvironment>, string]> = [
			[
				{ promptFiles: [{ kind: "override", path: PROMPT_PATH, text: "sys (edited)" }] },
				"prompt-files-drift",
			],
			[{ extensionContexts: [{ id: "ctx", text: "ext ctx (edited)" }] }, "extension-contexts-drift"],
			[
				{ extensions: [{ name: "foo", origin: "global", path: "/p/foo.mjs", sha256: "c".repeat(64) }] },
				"extension-drift",
			],
			[{ childTools: [{ name: "read" }] }, "tools-drift"],
			[{ childTools: [{ name: "read" }, { name: "web_search", mcpServer: "other" }] }, "tools-drift"],
			[{ binding: { providerName: "openai", wireModelId: "x", reference: "openai/x" } }, "model-drift"],
		];
		for (const [over, code] of cases) {
			const verdict = await validateChildContinuation(file, parent, { ...current, ...over });
			expect(codes(verdict.reasons), JSON.stringify(over)).toContain(code);
			expect(verdict.resumable).toBe(false);
		}
	});

	it("shared-cwd child: moved parent cwd => cwd-drift; vanished cwd => cwd-missing", async () => {
		const { parent, file, current, cwd } = await makeWorld();
		const moved = mkdtempSync(path.join(tmpdir(), "imp-clv-elsewhere-"));
		const drift = await validateChildContinuation(file, parent, { ...current, cwd: moved });
		expect(codes(drift.reasons)).toContain("cwd-drift");
		rmSync(cwd, { recursive: true, force: true });
		const missing = await validateChildContinuation(file, parent, { ...current, cwd });
		expect(codes(missing.reasons)).toContain("cwd-missing");
	});
});

// --- real-git worktree probe cases ----------------------------------------

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function seedRepo(dir: string): void {
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "t@imp.dev"]);
	git(dir, ["config", "user.name", "t"]);
	writeFileSync(path.join(dir, "seed.txt"), "committed\n", "utf8");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-qm", "seed"]);
}

interface WorktreeWorld extends World {
	repo: string;
	wtPath: string;
	branch: string;
}

async function makeWorktreeWorld(): Promise<WorktreeWorld> {
	const base = await mkdtemp(path.join(tmpdir(), "imp-clv-"));
	const cwd = mkdtempSync(path.join(tmpdir(), "imp-clv-cwd-"));
	const repo = mkdtempSync(path.join(tmpdir(), "imp-clv-repo-"));
	seedRepo(repo);
	const baseline = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	const wtPath = path.join(repo, "..", `imp-wt-${path.basename(repo)}`);
	const branch = "imp/task-matrix";
	const add = git(repo, ["worktree", "add", "--quiet", wtPath, "-b", branch, baseline]);
	if (add.status !== 0) throw new Error(`worktree add failed: ${add.stderr}`);
	const reflog = git(repo, ["reflog", "show", "--format=%H %gs", `refs/heads/${branch}`]);
	const creationReflog = reflog.stdout.split("\n").filter((l) => l !== "");
	const parent = createSession(cwd, base);
	parent.appendMessage({ role: "user", content: "parent message" });
	const childId = "child-wt";
	const launch = buildChildLaunch({
		parentSessionId: parent.header.id,
		childId,
		impVersion: "9.9.9",
		model: { ...MODEL },
		cwd: wtPath,
		worktree: { repoRoot: repo, baseline, path: wtPath, branch, creationReflog },
		tools: [{ name: "read" }],
		systemText: SYSTEM_TEXT,
		contextFiles: [],
		promptFiles: [],
		extensionContexts: [],
		extensions: [],
	});
	const filePath = path.join(path.dirname(parent.filePath), "children", "wt.jsonl");
	mkdirSync(path.dirname(filePath), { recursive: true });
	const child = SessionStore.create(filePath, parent.header.cwd, childId, parent.header.id, launch as never);
	child.appendMessage({ role: "user", content: "child prompt" });
	const record = buildTaskRecord({
		attemptId: "attempt-wt",
		sourceId: "source-1",
		launched: true,
		childId,
		cwd: wtPath,
		status: "completed",
		turns: 1,
		textPresent: true,
	});
	parent.appendMessage({
		role: "toolResult",
		results: [
			{
				toolCallId: "call-1",
				toolName: "task",
				content: "done",
				isError: false,
				taskRecord: record,
			},
		],
	});
	const found = findChildByLaunch(parent, childId);
	if (!found.ok) throw new Error(`fixture lookup failed: ${found.code} ${found.message}`);
	const current: CurrentChildEnvironment = {
		impVersion: "9.9.9",
		systemText: SYSTEM_TEXT,
		cwd,
		agentResolver: () => undefined,
		contextFiles: [],
		promptFiles: [],
		extensionContexts: [],
		extensions: [],
		childTools: [{ name: "read" }],
		binding: { ...MODEL },
	};
	return { parent, file: found.file, current, cwd, repo, wtPath, branch };
}

describe("child continuation — worktree probe", () => {
	it("a kept worktree with the child's own commit (and dirty files) stays resumable", async () => {
		const world = await makeWorktreeWorld();
		writeFileSync(path.join(world.wtPath, "child-work.txt"), "work\n", "utf8");
		git(world.wtPath, ["add", "."]);
		git(world.wtPath, ["commit", "-qm", "child commit"]);
		writeFileSync(path.join(world.wtPath, "dirty.txt"), "dirty\n", "utf8");
		const verdict = await validateChildContinuation(world.file, world.parent, world.current);
		expect(verdict.reasons).toEqual([]);
		expect(verdict.resumable).toBe(true);
	});

	it("a vanished worktree path => worktree-missing", async () => {
		const world = await makeWorktreeWorld();
		rmSync(world.wtPath, { recursive: true, force: true });
		const verdict = await validateChildContinuation(world.file, world.parent, world.current);
		expect(codes(verdict.reasons)).toContain("worktree-missing");
	});

	it("a branch swapped at the same path => worktree-branch-swapped", async () => {
		const world = await makeWorktreeWorld();
		const swapped = git(world.wtPath, ["checkout", "-q", "-b", "some-other-branch"]);
		expect(swapped.status).toBe(0);
		const verdict = await validateChildContinuation(world.file, world.parent, world.current);
		expect(codes(verdict.reasons)).toContain("worktree-branch-swapped");
	});

	it("duplicate tool names in a tampered record compare by set semantics (no drift)", async () => {
		const { parent, file, current } = await makeWorld();
		const duplicated: ChildLaunchFile = {
			...file,
			launch: { ...file.launch, tools: [...file.launch.tools, ...file.launch.tools] } as never,
		};
		const verdict = await validateChildContinuation(duplicated, parent, current);
		expect(verdict.resumable).toBe(true);
	});

	it("a rewritten history (branch reset off the baseline) => worktree-history-replaced", async () => {
		const world = await makeWorktreeWorld();
		// An unrelated root commit in the main repo, then reset the child's
		// branch onto it: same branch, same registration, non-descendant tip.
		const orphan = git(world.repo, ["checkout", "-q", "--orphan", "side"]);
		expect(orphan.status).toBe(0);
		writeFileSync(path.join(world.repo, "unrelated.txt"), "x\n", "utf8");
		git(world.repo, ["add", "."]);
		git(world.repo, ["commit", "-qm", "unrelated root"]);
		const reset = git(world.wtPath, ["reset", "--hard", "side"]);
		expect(reset.status).toBe(0);
		const verdict = await validateChildContinuation(world.file, world.parent, world.current);
		expect(codes(verdict.reasons)).toContain("worktree-history-replaced");
	});

	it("a reflog that no longer ends with the recorded snapshot => worktree-history-replaced", async () => {
		const world = await makeWorktreeWorld();
		const fake: ChildLaunchFile = {
			...world.file,
			launch: {
				...world.file.launch,
				worktree: {
					...(world.file.launch.worktree as object),
					creationReflog: [`${"f".repeat(40)} branch: Created from elsewhere`],
				},
			} as never,
		};
		const verdict = await validateChildContinuation(fake, world.parent, world.current);
		expect(codes(verdict.reasons)).toContain("worktree-history-replaced");
	});

	it("a vanished repository root => worktree-repo-missing", async () => {
		const world = await makeWorktreeWorld();
		rmSync(world.repo, { recursive: true, force: true });
		const verdict = await validateChildContinuation(world.file, world.parent, world.current);
		expect(codes(verdict.reasons)).toContain("worktree-repo-missing");
	});
});
