import { spawn } from "node:child_process";
import { existsSync, symlinkSync, realpathSync } from "node:fs";
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
	const root = common ? path.dirname(realpathSync(path.resolve(cwd, common))) : "";
	if (!root || !existsSync(root)) {
		throw new Error(`could not resolve the repository root above "${cwd}" — retry the task without the worktree option.`);
	}
	const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).stdout.trim().replace(/[\\/]+$/, "");
	const head = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
	// an empty repo resolves HEAD to the literal string "HEAD" with exit 0
	if (!/^[0-9a-f]{7,40}$/.test(head)) {
		throw new Error(`the repository at "${root}" has no commits yet — commit once before using worktree isolation.`);
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
	const add = await git(repo.root, ["worktree", "add", dir, "-b", branch, "HEAD"]);
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

/** Any change vs the base commit: committed, staged, or plain dirty files. */
export async function hasWorktreeChanges(wt: ChildWorktree, repo: RepoState): Promise<boolean> {
	const status = await git(wt.path, ["status", "--porcelain"]);
	if (status.status === 0 && status.stdout.trim() !== "") return true;
	const diff = await git(wt.path, ["diff", "--quiet", repo.head, "--"]);
	return diff.status === 1;
}

/** Compact change summary for the result trailer: shortstat vs HEAD plus
 * untracked names (git diff never lists those — the parent needs them to
 * know what to `git add`). */
export async function worktreeChangeStat(wt: ChildWorktree): Promise<string> {
	const stat = await git(wt.path, ["diff", "--shortstat", "HEAD", "--"]);
	const line = stat.status === 0 ? stat.stdout.trim() : "";
	const untracked = (await git(wt.path, ["status", "--porcelain"])).stdout
		.split("\n")
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
export function buildWorktreeNotice(wt: ChildWorktree, parentCwd: string): string {
	return [
		"",
		"---",
		`[worktree] You are working in an isolated git worktree at ${wt.path} — same repository, separate working copy of the committed state.`,
		`Paths in the task refer to the parent's working directory (${parentCwd}); translate them to your worktree. Uncommitted parent changes are not visible here — re-read files before relying on details.`,
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
