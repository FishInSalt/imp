import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWorktreeNotice,
	buildWorktreeTrailer,
	createChildWorktree,
	hasWorktreeChanges,
	removeChildWorktree,
	resolveRepoState,
	worktreeChangeStat,
} from "../src/core/worktree.js";

/** A throwaway git repo with one commit — the hermetic base for every test. */
async function makeRepo(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "imp-wt-repo-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "test@imp.dev"]);
	git(root, ["config", "user.name", "imp test"]);
	writeFileSync(path.join(root, "seed.txt"), "committed\n", "utf8");
	git(root, ["add", "."]);
	git(root, ["commit", "-qm", "seed"]);
	return root;
}

function git(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

const baseDir = () =>
	path.join(tmpdir(), `imp-wt-base-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

describe("worktree isolation (M6b)", () => {
	it("resolveRepoState: root, head, and a subdirectory cwd maps relatively", async () => {
		const root = await makeRepo();
		mkdirSync(path.join(root, "packages", "app"), { recursive: true });
		const state = await resolveRepoState(path.join(root, "packages", "app"));
		expect(state.root).toBe(realpathSync(root));
		expect(state.head).toMatch(/^[0-9a-f]{40}$/);
		expect(state.cwdRelative).toBe(path.join("packages", "app"));
	});

	it("resolveRepoState: non-git cwd → teaching error naming the retry", async () => {
		const nowhere = await mkdtemp(path.join(tmpdir(), "imp-wt-nogit-"));
		await expect(resolveRepoState(nowhere)).rejects.toThrow(
			/requires a git repository.*without the worktree/s,
		);
	});

	it("resolveRepoState: a repo with no commits yet → teaching error", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "imp-wt-empty-"));
		git(root, ["init", "-q"]);
		await expect(resolveRepoState(root)).rejects.toThrow(/no commits yet/);
	});

	it("create → dirty file → hasChanges true; removeWorktree cleans branch and list", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "t1", baseDir());
		expect(existsSync(path.join(wt.path, "seed.txt"))).toBe(true);

		expect(await hasWorktreeChanges(wt, state)).toBe(false);
		writeFileSync(path.join(wt.path, "made.txt"), "child work\n", "utf8");
		expect(await hasWorktreeChanges(wt, state)).toBe(true);
		expect(await worktreeChangeStat(wt, state)).toContain("made.txt");

		const errors = await removeChildWorktree(wt, state);
		expect(errors).toEqual([]);
		expect(existsSync(wt.path)).toBe(false);
		const listed = spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" });
		expect(listed.stdout).not.toContain(wt.path);
		const branches = spawnSync("git", ["branch", "--list", wt.branch], { cwd: root, encoding: "utf8" });
		expect(branches.stdout.trim()).toBe("");
	});

	it("committed child work counts as changes too", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "t2", baseDir());
		writeFileSync(path.join(wt.path, "committed.txt"), "clean tree, new commit\n", "utf8");
		git(wt.path, ["add", "."]);
		git(wt.path, ["config", "user.email", "child@imp.dev"]);
		git(wt.path, ["config", "user.name", "child"]);
		git(wt.path, ["commit", "-qm", "child change"]);
		// status is clean, but the diff vs base commit still sees it
		expect(await hasWorktreeChanges(wt, state)).toBe(true);
		await removeChildWorktree(wt, state);
	});

	it("node_modules at the repo root is symlinked into the worktree", async () => {
		const root = await makeRepo();
		mkdirSync(path.join(root, "node_modules"), { recursive: true });
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "t3", baseDir());
		expect(wt.nodeModulesLinked).toBe(true);
		expect(existsSync(path.join(wt.path, "node_modules"))).toBe(true);
		await removeChildWorktree(wt, state);
	});

	it("notice and trailer teach the merge path", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "t4", baseDir());
		const notice = buildWorktreeNotice(wt, root);
		expect(notice).toContain(wt.path);
		expect(notice).toContain("translate them");
		expect(notice).toContain(`commit them on the current branch (${wt.branch})`);
		const trailer = buildWorktreeTrailer(wt, "2 files changed, +10 -1");
		expect(trailer).toContain(`git merge ${wt.branch}`);
		expect(trailer).toContain("2 files changed, +10 -1");
		await removeChildWorktree(wt, state);
	});
});
