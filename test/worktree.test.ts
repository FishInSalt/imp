import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assessWorktreeRemoval,
	buildWorktreeNotice,
	buildWorktreeTrailer,
	createChildWorktree,
	removeChildWorktree,
	resolveRepoState,
	worktreeChangeStat,
} from "../src/core/worktree.js";

/** A throwaway git repo with one commit — the hermetic base for every test. */
async function makeRepo(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "imp-wt-repo-"));
	git(root, ["init", "-q", "-b", "main"]);
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
		git(root, ["init", "-q", "-b", "main"]);
		await expect(resolveRepoState(root)).rejects.toThrow(/no commits yet/);
	});

	it("create → dirty file → work-present; removeWorktree cleans branch and list", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "t1", baseDir());
		expect(existsSync(path.join(wt.path, "seed.txt"))).toBe(true);

		expect(await assessWorktreeRemoval(wt, state)).toEqual({ verdict: "clean" });
		writeFileSync(path.join(wt.path, "made.txt"), "child work\n", "utf8");
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
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
		// status is clean, but the HEAD/diff checks still see it
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
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
		const notice = buildWorktreeNotice(wt, root, root);
		expect(notice).toContain(wt.path);
		expect(notice).toContain("translate them");
		expect(notice).toContain(`commit them on the current branch (${wt.branch})`);
		const trailer = buildWorktreeTrailer(wt, "2 files changed, +10 -1");
		expect(trailer).toContain(`git merge ${wt.branch}`);
		expect(trailer).toContain("2 files changed, +10 -1");
		await removeChildWorktree(wt, state);
	});
});

describe("assessWorktreeRemoval (SA-01)", () => {
	const commitAll = (wtPath: string, message: string): void => {
		git(wtPath, ["add", "-A"]);
		git(wtPath, ["commit", "-qm", message]);
	};

	it("U1: untouched task-owned worktree with a live synthetic link → clean; removal succeeds", async () => {
		const root = await makeRepo();
		mkdirSync(path.join(root, "node_modules"), { recursive: true });
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u1", baseDir());
		expect(wt.nodeModulesLinked).toBe(true);
		expect(await assessWorktreeRemoval(wt, state)).toEqual({ verdict: "clean" });
		expect(await removeChildWorktree(wt, state)).toEqual([]);
		expect(existsSync(wt.path)).toBe(false);
		const listed = spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" });
		expect(listed.stdout).not.toContain(wt.path);
	});

	it("U2: dirty, staged, and untracked files → work-present", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		let wt = await createChildWorktree(state, "u2a", baseDir());
		writeFileSync(path.join(wt.path, "untracked.txt"), "x\n", "utf8");
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
		await removeChildWorktree(wt, state);
		wt = await createChildWorktree(state, "u2b", baseDir());
		writeFileSync(path.join(wt.path, "staged.txt"), "x\n", "utf8");
		git(wt.path, ["add", "staged.txt"]);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
		await removeChildWorktree(wt, state);
		wt = await createChildWorktree(state, "u2c", baseDir());
		writeFileSync(path.join(wt.path, "seed.txt"), "modified\n", "utf8");
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
		await removeChildWorktree(wt, state);
	});

	it("U3: normal, empty, and change-then-revert commits → work-present", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		let wt = await createChildWorktree(state, "u3a", baseDir());
		writeFileSync(path.join(wt.path, "work.txt"), "work\n", "utf8");
		commitAll(wt.path, "work");
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
		await removeChildWorktree(wt, state);
		wt = await createChildWorktree(state, "u3b", baseDir());
		git(wt.path, ["commit", "-q", "--allow-empty", "-m", "empty"]);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
		await removeChildWorktree(wt, state);
		wt = await createChildWorktree(state, "u3c", baseDir());
		writeFileSync(path.join(wt.path, "seed.txt"), "changed\n", "utf8");
		commitAll(wt.path, "change");
		writeFileSync(path.join(wt.path, "seed.txt"), "committed\n", "utf8");
		commitAll(wt.path, "revert");
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
		await removeChildWorktree(wt, state);
	});

	it("U4: corrupt worktree admin (.git file removed) → unknown, nothing destructive", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u4", baseDir());
		rmSync(path.join(wt.path, ".git"));
		const assessment = await assessWorktreeRemoval(wt, state);
		expect(assessment.verdict).toBe("unknown");
		expect(existsSync(wt.path)).toBe(true);
		const branches = spawnSync("git", ["branch", "--list", wt.branch], { cwd: root, encoding: "utf8" });
		expect(branches.stdout).toContain(wt.branch);
	});

	it("U5: moved worktree (ownership mismatch) → unknown", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u5", baseDir());
		renameSync(wt.path, `${wt.path}-moved`);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("unknown");
	});

	it("U6: branch ref deleted → unknown", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u6", baseDir());
		git(root, ["update-ref", "-d", `refs/heads/${wt.branch}`]);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("unknown");
		spawnSync("git", ["branch", "--list", wt.branch], { cwd: root, encoding: "utf8" });
	});

	it("U7: status/diff command failures → unknown, no removal", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
		expect(realGit).not.toBe("");
		const shimDir = mkdtempSync(path.join(tmpdir(), "imp-git-shim-"));
		const shim = path.join(shimDir, "git");
		writeFileSync(
			shim,
			`#!/bin/sh\nif [ "$1" = "$IMP_FAIL_GIT" ]; then exit 128; fi\nexec "${realGit}" "$@"\n`,
			{ mode: 0o755 },
		);
		const wt = await createChildWorktree(state, "u7", baseDir());
		const previousPath = process.env.PATH;
		process.env.PATH = `${shimDir}:${previousPath ?? ""}`;
		try {
			for (const verb of ["status", "diff"]) {
				process.env.IMP_FAIL_GIT = verb;
				expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("unknown");
			}
		} finally {
			process.env.PATH = previousPath;
			delete process.env.IMP_FAIL_GIT;
		}
		const branches = spawnSync("git", ["branch", "--list", wt.branch], { cwd: root, encoding: "utf8" });
		expect(branches.stdout).toContain(wt.branch);
	});

	it("U8: verified link → clean; replaced link → unknown", async () => {
		const root = await makeRepo();
		mkdirSync(path.join(root, "node_modules"), { recursive: true });
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u8", baseDir());
		expect(await assessWorktreeRemoval(wt, state)).toEqual({ verdict: "clean" });
		rmSync(path.join(wt.path, "node_modules"));
		mkdirSync(path.join(wt.path, "node_modules"));
		writeFileSync(path.join(wt.path, "node_modules", "user-file.txt"), "mine\n", "utf8");
		const assessment = await assessWorktreeRemoval(wt, state);
		expect(assessment.verdict).toBe("unknown");
		if (assessment.verdict === "unknown") {
			expect(assessment.detail).toContain("no longer the verified synthetic link");
		}
	});

	it("U9: commit + reset --hard <baseline> → work-present (reflog evidence)", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u9", baseDir());
		git(wt.path, ["commit", "-q", "--allow-empty", "-m", "gone"]);
		git(wt.path, ["reset", "-q", "--hard", state.head]);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
	});

	it("U10: assume-unchanged modified tracked file → unknown", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u10", baseDir());
		writeFileSync(path.join(wt.path, "seed.txt"), "sneaky\n", "utf8");
		git(wt.path, ["update-index", "--assume-unchanged", "seed.txt"]);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("unknown");
	});

	it("U11: branch ref deleted and recreated at the baseline → unknown (creation snapshot suffix)", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u11", baseDir());
		git(wt.path, ["commit", "-q", "--allow-empty", "-m", "gone"]);
		git(root, ["update-ref", "-d", `refs/heads/${wt.branch}`]);
		git(root, ["update-ref", `refs/heads/${wt.branch}`, state.head]);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("unknown");
	});

	it("U12: commit + branch rename round-trip + reset → work-present (entries survive)", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u12", baseDir());
		git(wt.path, ["commit", "-q", "--allow-empty", "-m", "gone"]);
		git(root, ["branch", "-m", wt.branch, `${wt.branch}-tmp`]);
		git(root, ["branch", "-m", `${wt.branch}-tmp`, wt.branch]);
		git(wt.path, ["reset", "-q", "--hard", state.head]);
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
	});

	it("U13: commit + reset + reflog cleared → unknown, never clean", async () => {
		const root = await makeRepo();
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u13", baseDir());
		git(wt.path, ["commit", "-q", "--allow-empty", "-m", "gone"]);
		git(wt.path, ["reset", "-q", "--hard", state.head]);
		git(root, ["reflog", "expire", "--expire=all", "--all"]);
		const assessment = await assessWorktreeRemoval(wt, state);
		expect(assessment.verdict).toBe("unknown");
		const branches = spawnSync("git", ["branch", "--list", wt.branch], { cwd: root, encoding: "utf8" });
		expect(branches.stdout).toContain(wt.branch);
	});

	it("U14: status.showUntrackedFiles=no cannot hide untracked files (work-present)", async () => {
		const root = await makeRepo();
		git(root, ["config", "status.showUntrackedFiles", "no"]);
		const state = await resolveRepoState(root);
		const wt = await createChildWorktree(state, "u14", baseDir());
		writeFileSync(path.join(wt.path, "valuable.txt"), "not throwaway\n", "utf8");
		expect((await assessWorktreeRemoval(wt, state)).verdict).toBe("work-present");
	});

	it("U15: a gitignored node_modules created by the child → unknown (not the runtime link)", async () => {
		const root = await makeRepo();
		writeFileSync(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
		git(root, ["add", ".gitignore"]);
		git(root, ["commit", "-qm", "ignore node_modules"]);
		const state = await resolveRepoState(root);
		// No root node_modules → no synthetic link is created.
		const wt = await createChildWorktree(state, "u15", baseDir());
		expect(wt.nodeModulesLinked).toBe(false);
		mkdirSync(path.join(wt.path, "node_modules"), { recursive: true });
		writeFileSync(path.join(wt.path, "node_modules", "user-work.txt"), "mine\n", "utf8");
		const assessment = await assessWorktreeRemoval(wt, state);
		expect(assessment.verdict).toBe("unknown");
		if (assessment.verdict === "unknown") {
			expect(assessment.detail).toContain("not the runtime-created synthetic link");
		}
	});
});
