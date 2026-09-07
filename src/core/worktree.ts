import { spawn } from "node:child_process";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Worktree isolation for subagents (M6b, docs/m6b-worktree-design.md).
 *
 * `git worktree add <path> -b <branch> HEAD` gives a delegated writing task its
 * own checkout: the child cannot touch the parent's files, and the parent gets
 * the work back as a branch it merges deliberately. Verified references:
 * pi-subagents `runs/shared/worktree.ts` and Claude Code `utils/worktree.ts`
 * (choices and their reasons in the design doc §3).
 */

export interface RepoState {
	/** Canonical repo root — even when cwd is inside a nested worktree. */
	root: string;
	/** Path of cwd relative to root ("" at the root). */
	cwdRelative: string;
	/** The commit new worktrees branch from. */
	head: string;
}

export interface ChildWorktree {
	path: string;
	branch: string;
	/** Symlinked node_modules was created (excluded from change detection). */
	nodeModulesLinked: boolean;
}

function git(cwd: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", () => resolve({ status: 1, stdout, stderr: "git failed to spawn" }));
		child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
	});
}

/**
 * Resolve the repository the cwd belongs to. Throws teaching-style when the cwd
 * is not a git repository — worktree isolation is opt-in, so the model can
 * retry the task without `worktree` (the task tool turns this into its error).
 */
export async function resolveRepoState(cwd: string): Promise<RepoState> {
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.status !== 0 || inside.stdout.trim() !== "true") {
		throw new Error(
			`worktree isolation requires a git repository — "${cwd}" is not one. Retry the task without the worktree option.`,
		);
	}
	// --git-common-dir is the shared root even from inside a linked worktree:
	// children always attach to the main repository, never nest (CC pattern).
	const common = (await git(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim().replace(/\\/g, "/");
	let root = "";
	if (common !== "") {
		try {
			root = path.dirname(realpathSync(path.resolve(cwd, common)));
		} catch {
			throw new Error(
				`could not resolve the repository root above "${cwd}" — retry the task without the worktree option.`,
			);
		}
	}
	if (!root || !existsSync(root)) {
		throw new Error(
			`could not resolve the repository root above "${cwd}" — retry the task without the worktree option.`,
		);
	}
	const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).stdout.trim().replace(/[\\/]+$/, "");
	const head = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
	// an empty repo resolves HEAD to the literal string "HEAD" with exit 0
	if (!/^[0-9a-f]{7,40}$/.test(head)) {
		throw new Error(
			`the repository at "${root}" has no commits yet — commit once before using worktree isolation.`,
		);
	}
	return { root, cwdRelative: prefix ? path.normalize(prefix) : "", head };
}

function worktreeBaseDir(override?: string): string {
	const raw = (override ?? process.env.IMP_WORKTREE_DIR ?? "").trim();
	return raw === "" ? tmpdir() : path.resolve(raw);
}

/** Create one worktree + branch for a child. `name` must be filesystem-safe. */
export async function createChildWorktree(
	repo: RepoState,
	name: string,
	overrideBaseDir?: string,
): Promise<ChildWorktree> {
	const dir = path.join(worktreeBaseDir(overrideBaseDir), `imp-worktree-${name}`);
	const branch = `imp/task-${name}`;
	// Base the branch on the PARENT's HEAD (repo.head), not the main root's:
	// when the parent itself runs inside a linked worktree the two differ, and
	// change detection diffs against repo.head (review B2).
	const add = await git(repo.root, ["worktree", "add", dir, "-b", branch, repo.head]);
	if (add.status !== 0) {
		throw new Error(`git worktree add failed: ${(add.stderr || add.stdout).trim()}`);
	}
	let nodeModulesLinked = false;
	const rootModules = path.join(repo.root, "node_modules");
	const wtModules = path.join(dir, "node_modules");
	if (existsSync(rootModules) && !existsSync(wtModules)) {
		try {
			symlinkSync(rootModules, wtModules, "junction");
			nodeModulesLinked = true;
		} catch {
			// builds inside the worktree may fail on missing deps; the child
			// sees a normal filesystem and can install or report — never fatal
		}
	}
	return { path: dir, branch, nodeModulesLinked };
}

/** Any change vs the base commit: committed, staged, or plain dirty files.
 * The symlinked node_modules is synthetic — excluded, or repos that do not
 * gitignore it would always look changed (review nit 4). */
export async function hasWorktreeChanges(wt: ChildWorktree, repo: RepoState): Promise<boolean> {
	const statusArgs = wt.nodeModulesLinked
		? ["status", "--porcelain", "--", ":!node_modules"]
		: ["status", "--porcelain"];
	const status = await git(wt.path, statusArgs);
	if (status.status === 0 && status.stdout.trim() !== "") return true;
	const diff = await git(wt.path, ["diff", "--quiet", repo.head, "--"]);
	return diff.status === 1;
}

/** Compact change summary for the result trailer: shortstat vs HEAD plus
 * untracked names (git diff never lists those — the parent needs them to
 * know what to `git add`). */
export async function worktreeChangeStat(wt: ChildWorktree, repo: RepoState, base?: string): Promise<string> {
	// vs the base commit, not HEAD: the notice tells the child to COMMIT, and
	// committed work must still show in the summary (review nit 1). The task
	// trailer passes no base (repo.head = the parent HEAD captured at task
	// start); /worktrees passes the merge-base so main's forward commits are
	// not misattributed to the child (M8 review F2).
	const stat = await git(wt.path, ["diff", "--shortstat", base ?? repo.head, "--"]);
	const line = stat.status === 0 ? stat.stdout.trim() : "";
	const statusArgs = wt.nodeModulesLinked
		? ["status", "--porcelain", "--", ":!node_modules"]
		: ["status", "--porcelain"];
	// only "??" entries are untracked — modified tracked files already appear
	// in the shortstat and must not be double-reported under the wrong label
	// (M8 review F6, pre-existing since M6b)
	const untracked = (await git(wt.path, statusArgs)).stdout
		.split("\n")
		.filter((l) => l.startsWith("?? "))
		.map((l) => l.slice(3).trim())
		.filter((name, i, all) => name !== "" && all.indexOf(name) === i);
	if (line === "" && untracked.length === 0) return "";
	const parts = [line];
	if (untracked.length > 0) {
		const shown = untracked.slice(0, 5).join(", ");
		const more = untracked.length > 5 ? `, +${untracked.length - 5} more` : "";
		parts.push(`untracked: ${shown}${more}`);
	}
	return parts.filter((p) => p !== "").join("; ");
}

/** One kept worktree as /worktrees shows it (M6b §7 follow-up). */
export interface WorktreeListEntry {
	path: string;
	/** Branch name without refs/heads/ (imp/task-*). */
	branch: string;
	/** The branch commit is an ancestor of the main checkout's HEAD —
	 *  committed work on the branch cannot be lost by removing it. Says
	 *  NOTHING about uncommitted files: the caller must also check `stat`. */
	merged: boolean;
	/** Content already sits in main via squash/cherry-pick (patch-id
	 *  equivalent) even though the commit is not an ancestor — nothing to
	 *  merge; a literal merge would only create an empty merge commit. */
	patchEquivalent: boolean;
	/** Change summary vs the merge-base ("" when none) — includes
	 *  uncommitted work, which is exactly what `merged` cannot see. */
	stat: string;
	/** The worktree directory is gone (deleted behind git's back); the
	 *  listed path is dead until `git worktree prune`. */
	missing: boolean;
}

/** Enumerate imp-kept child worktrees of `repo` (M6b handbacks awaiting a
 *  manual merge). Source of truth is `git worktree list --porcelain` — no
 *  bookkeeping of our own can drift from reality. */
export async function listChildWorktrees(repo: RepoState): Promise<WorktreeListEntry[]> {
	const raw = await git(repo.root, ["worktree", "list", "--porcelain"]);
	if (raw.status !== 0) throw new Error(`git worktree list failed: ${(raw.stderr || raw.stdout).trim()}`);
	const entries: WorktreeListEntry[] = [];
	for (const block of raw.stdout.split(/\n\n+/)) {
		const lines = block.split("\n").filter((l) => l !== "");
		const wtPath = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
		const branchRef = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
		if (wtPath === undefined || branchRef === undefined) continue;
		if (wtPath === repo.root) continue; // the main checkout is never a handback (M8 review F4)
		if (!path.basename(wtPath).startsWith("imp-worktree-")) continue; // only imp's children
		const branch = branchRef.replace(/^refs\/heads\//, "");
		const mergedProbe = await git(repo.root, ["merge-base", "--is-ancestor", branch, "HEAD"]);
		const merged = mergedProbe.status === 0;
		// squash/cherry-pick detection: commits in `branch` whose patch already
		// exists in HEAD render as "-" lines in `git cherry`
		let patchEquivalent = false;
		if (!merged) {
			const cherry = await git(repo.root, ["cherry", "HEAD", branch]);
			const cherryLines = cherry.stdout.split("\n").filter((l) => l !== "");
			if (cherry.status === 0 && cherryLines.length > 0 && cherryLines.every((l) => l.startsWith("-"))) {
				patchEquivalent = true;
			}
		}
		// honest stat base: the merge-base, so main's forward commits are not
		// misattributed to the child (M8 review F2). Patch-equivalent entries
		// diff from the branch TIP instead — their committed work is already
		// in main, so only genuinely uncommitted files should show.
		let base = repo.head;
		if (patchEquivalent) {
			const tip = await git(repo.root, ["rev-parse", branch]);
			if (tip.status === 0 && tip.stdout.trim() !== "") base = tip.stdout.trim();
		} else {
			const mergeBase = await git(repo.root, ["merge-base", repo.head, branch]);
			if (mergeBase.status === 0 && mergeBase.stdout.trim() !== "") base = mergeBase.stdout.trim();
		}
		const wt: ChildWorktree = {
			path: wtPath,
			branch,
			nodeModulesLinked: existsSync(path.join(wtPath, "node_modules")),
		};
		entries.push({
			path: wtPath,
			branch,
			merged,
			patchEquivalent,
			stat: await worktreeChangeStat(wt, repo, base),
			missing: !existsSync(wtPath),
		});
	}
	return entries.sort((a, b) => a.branch.localeCompare(b.branch));
}

/** Remove worktree + its branch. Best effort: prunes stale metadata too. */
export async function removeChildWorktree(wt: ChildWorktree, repo: RepoState): Promise<string[]> {
	const errors: string[] = [];
	const remove = await git(repo.root, ["worktree", "remove", "--force", wt.path]);
	if (remove.status !== 0) errors.push(`worktree remove failed: ${(remove.stderr || remove.stdout).trim()}`);
	if (remove.status === 0) {
		const branch = await git(repo.root, ["branch", "-D", wt.branch]);
		if (branch.status !== 0) errors.push(`branch delete failed: ${(branch.stderr || branch.stdout).trim()}`);
	}
	await git(repo.root, ["worktree", "prune"]);
	return errors;
}

/**
 * The notice appended to a worktree child's prompt (design §4): paths
 * translate, only committed state is visible, commit before finishing — the
 * commit instruction is what makes the branch handback real.
 */
export function buildWorktreeNotice(wt: ChildWorktree, agentCwd: string, parentCwd: string): string {
	return [
		"",
		"---",
		`[worktree] You are working in an isolated git worktree at ${wt.path} — same repository, separate working copy of the committed state. Your working directory is ${agentCwd}.`,
		`Paths in the task refer to the parent's working directory (${parentCwd}); translate them to your working directory. Uncommitted parent changes are not visible here — re-read files before relying on details. Extension tools are not available in this worktree.`,
		`When your changes are complete, commit them on the current branch (${wt.branch}) with a descriptive message; the parent merges your branch.`,
	].join("\n");
}

/**
 * The result trailer when work is preserved (design §5) — tells the parent
 * model exactly how to get at the child's work.
 */
export function buildWorktreeTrailer(wt: ChildWorktree, stat: string): string {
	const statLine = stat === "" ? "" : ` (${stat})`;
	return `\n[task] changes kept in worktree ${wt.path} on branch ${wt.branch}${statLine} — merge it in the parent directory with \`git merge ${wt.branch}\`, or inspect first with \`git -C ${wt.path} diff\`.`;
}
