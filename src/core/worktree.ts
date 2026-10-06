import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Worktree isolation for subagents (M6b, docs/design/m6b-worktree-design.md).
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
	/** SA-01 D2 step 3: `reflog show --format=%H %gs` lines captured right after
	 *  creation. The cleanup assessment requires the branch reflog to still end
	 *  with these lines, so a rewritten log (update-ref -d + recreate, expiry)
	 *  cannot masquerade as "no history was discarded". Undefined = capture
	 *  failed → cleanup verdict `unknown` (the worktree is retained). */
	creationReflog?: string[];
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
		child.on("error", () =>
			// Spawn failure is -1, never a git exit code: `git diff --quiet` exits 1
			// for "differences", so conflating the two would read a broken git as
			// "changes" — or an unspawnable status as "no changes" (SA-01 D3).
			resolve({ status: -1, stdout, stderr: "git failed to spawn" }),
		);
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
	const raw = (override ?? process.env.INK_WORKTREE_DIR ?? "").trim();
	return raw === "" ? tmpdir() : path.resolve(raw);
}

/** Create one worktree + branch for a child. `name` must be filesystem-safe. */
export async function createChildWorktree(
	repo: RepoState,
	name: string,
	overrideBaseDir?: string,
): Promise<ChildWorktree> {
	const dir = path.join(worktreeBaseDir(overrideBaseDir), `ink-worktree-${name}`);
	const branch = `ink/task-${name}`;
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
	// SA-01 D2 step 3: snapshot the branch reflog immediately after creation.
	// Best-effort — a capture failure stores `undefined`, which makes the later
	// cleanup assessment `unknown` (retain the worktree rather than guess).
	let creationReflog: string[] | undefined;
	const reflog = await git(repo.root, ["reflog", "show", "--format=%H %gs", `refs/heads/${branch}`]);
	if (reflog.status === 0) {
		creationReflog = reflog.stdout.split("\n").filter((line) => line !== "");
	}
	return { path: dir, branch, nodeModulesLinked, creationReflog };
}

/** SA-01: verdict of the auto-removal safety assessment. `clean` requires every
 *  check to pass positively; anything else keeps the worktree. */
export type WorktreeRemovalAssessment =
	| { verdict: "clean" }
	| { verdict: "work-present"; detail: string }
	| { verdict: "unknown"; detail: string };

function commandFailure(result: { status: number; stdout: string; stderr: string }): string {
	return (result.stderr || result.stdout).trim() || `exit ${result.status}`;
}

/** Decide whether a task-owned worktree can be auto-removed (design
 *  docs/design/sa-01-worktree-cleanup-design.md §D2). Never throws — internal errors
 *  become `unknown`, which preserves the worktree. */
export async function assessWorktreeRemoval(
	wt: ChildWorktree,
	repo: RepoState,
): Promise<WorktreeRemovalAssessment> {
	try {
		return await assessWorktreeRemovalInner(wt, repo);
	} catch (err) {
		return {
			verdict: "unknown",
			detail: `assessment failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

async function assessWorktreeRemovalInner(
	wt: ChildWorktree,
	repo: RepoState,
): Promise<WorktreeRemovalAssessment> {
	const unknown = (detail: string): WorktreeRemovalAssessment => ({ verdict: "unknown", detail });
	const work = (detail: string): WorktreeRemovalAssessment => ({ verdict: "work-present", detail });

	// 1. Ownership: the repo must still register this path under this branch.
	let wtReal: string;
	try {
		wtReal = realpathSync(wt.path);
	} catch {
		return unknown("worktree path does not resolve (moved or deleted)");
	}
	const listed = await git(repo.root, ["worktree", "list", "--porcelain"]);
	if (listed.status !== 0) return unknown(`git worktree list failed: ${commandFailure(listed)}`);
	let owned = false;
	for (const block of listed.stdout.split(/\n\n+/)) {
		const lines = block.split("\n").filter((line) => line !== "");
		const entryPath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (entryPath === undefined || entryPath === "") continue;
		let entryReal: string;
		try {
			entryReal = realpathSync(entryPath); // stale/prunable entries are skipped
		} catch {
			continue;
		}
		if (entryReal !== wtReal) continue;
		const branchLine = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
		if (branchLine !== `refs/heads/${wt.branch}`) {
			return unknown(
				`worktree is registered under ${branchLine ?? "no branch"}, not refs/heads/${wt.branch}`,
			);
		}
		owned = true;
		break;
	}
	if (!owned) return unknown("worktree is not registered under the expected path");

	// 2. Branch + HEAD identity vs the creation baseline. A different HEAD is
	//    positive evidence of new commits (empty/net-zero history included).
	const symRef = await git(wt.path, ["symbolic-ref", "-q", "HEAD"]);
	if (symRef.status !== 0 || symRef.stdout.trim() !== `refs/heads/${wt.branch}`) {
		const found = symRef.stdout.trim();
		return unknown(`worktree HEAD is not on the expected branch (${found || commandFailure(symRef)})`);
	}
	const head = await git(wt.path, ["rev-parse", "HEAD"]);
	if (head.status !== 0) return unknown(`git rev-parse HEAD failed: ${commandFailure(head)}`);
	if (head.stdout.trim() !== repo.head) {
		return work("commit history differs from the creation baseline");
	}

	// 3. Discarded-history probe: the branch reflog must still end with the
	//    creation snapshot, and every entry must sit at the baseline.
	if (wt.creationReflog === undefined || wt.creationReflog.length === 0) {
		return unknown("creation reflog snapshot unavailable");
	}
	const reflog = await git(repo.root, ["reflog", "show", "--format=%H %gs", `refs/heads/${wt.branch}`]);
	if (reflog.status !== 0) return unknown(`git reflog failed: ${commandFailure(reflog)}`);
	const entries = reflog.stdout.split("\n").filter((line) => line !== "");
	if (entries.length === 0) {
		return unknown("branch reflog was cleared — cannot verify that discarded commit history is absent");
	}
	const snapshot = wt.creationReflog;
	const tail = entries.slice(entries.length - snapshot.length);
	if (tail.length !== snapshot.length || !snapshot.every((line, i) => tail[i] === line)) {
		return unknown("branch reflog was rewritten or truncated — the creation entry is gone");
	}
	if (entries.some((line) => line.slice(0, 40) !== repo.head)) {
		return work("branch reflog shows commit history that later moved away from the creation baseline");
	}

	// 4. node_modules at the worktree root: the only exempt occupant is the
	//    runtime-created link, verified now. The check runs regardless of the
	//    creation-time flag — otherwise gitignored user content there is invisible
	//    to every git command below (acceptance-round P1). A repo that tracks
	//    node_modules therefore never auto-cleans; the retention is visible in the
	//    result note.
	let filterSyntheticLink = false;
	const link = path.join(wt.path, "node_modules");
	let stat: ReturnType<typeof lstatSync> | undefined;
	try {
		stat = lstatSync(link);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			return unknown(`node_modules is unreadable: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (stat !== undefined) {
		if (!wt.nodeModulesLinked) {
			return unknown("node_modules exists but is not the runtime-created synthetic link");
		}
		if (!stat.isSymbolicLink()) {
			return unknown("node_modules is no longer the verified synthetic link");
		}
		let target: string;
		let rootModules: string;
		try {
			target = realpathSync(link);
			rootModules = realpathSync(path.join(repo.root, "node_modules"));
		} catch {
			return unknown("node_modules link cannot be verified");
		}
		if (target !== rootModules) {
			return unknown("node_modules link points outside the repository");
		}
		filterSyntheticLink = true;
	}

	// 5. Index flags (skip-worktree/assume-unchanged) hide real modifications
	//    from both status and diff — refuse to certify such a worktree.
	const flags = await git(wt.path, ["ls-files", "-v"]);
	if (flags.status !== 0) return unknown(`git ls-files failed: ${commandFailure(flags)}`);
	if (flags.stdout.split("\n").some((line) => line !== "" && !line.startsWith("H"))) {
		return unknown("index flags (skip-worktree/assume-unchanged) make change detection unreliable");
	}

	// 6. Status — no pathspec (a `:!node_modules` exclusion could hide tracked
	//    content under that path). The explicit flags override display-oriented
	//    config that can hide real state: `status.showUntrackedFiles=no` hides
	//    untracked files even from `--porcelain`, and submodule-ignore configs
	//    hide submodule changes. Only the verified link's own untracked line is
	//    filtered out afterwards.
	const status = await git(wt.path, [
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--ignore-submodules=none",
	]);
	if (status.status !== 0) return unknown(`git status failed: ${commandFailure(status)}`);
	const statusLines = status.stdout
		.split("\n")
		.filter((line) => line !== "")
		.filter((line) => !(filterSyntheticLink && line === "?? node_modules"));
	if (statusLines.length > 0) return work("uncommitted, staged, or untracked files");

	// 7. Diff: independent confirmation that the tree equals the baseline
	//    (`--ignore-submodules=none` against submodule-ignore configs).
	const diff = await git(wt.path, ["diff", "--quiet", "--ignore-submodules=none", repo.head, "--"]);
	if (diff.status === 0) return { verdict: "clean" };
	if (diff.status === 1) return work("committed changes relative to the creation baseline");
	return unknown(`git diff failed: ${commandFailure(diff)}`);
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
	/** Branch name without refs/heads/ (ink/task-*). */
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

/** Enumerate Ink child worktrees of `repo`, including historical imp names
 *  (M6b handbacks awaiting a manual merge). Source of truth is
 *  `git worktree list --porcelain` — no bookkeeping can drift from reality. */
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
		const directoryName = path.basename(wtPath);
		// Recognize retained historical children without renaming or removing them.
		if (!directoryName.startsWith("ink-worktree-") && !directoryName.startsWith("imp-worktree-")) continue;
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

/** SA-06: what a continuation must re-verify about a recorded worktree. All
 *  elements are identity checks; "no cleanliness checks" does not mean "no
 *  identity checks" (SA-06 design §4.2). */
export interface WorktreeIdentity {
	repoRoot: string;
	path: string;
	branch: string;
	baseline: string;
	/** SA-01 creation snapshot; when present the branch reflog must still
	 *  END with it (newest-first listing: the child's commits prepend, so the
	 *  snapshot stays the oldest tail; a rewritten log loses it). */
	creationReflog?: readonly string[];
}

export type WorktreeProbeResult =
	| { ok: true; detail?: string }
	| {
			ok: false;
			code:
				| "worktree-repo-missing"
				| "worktree-missing"
				| "worktree-replaced"
				| "worktree-unregistered"
				| "worktree-branch-swapped"
				| "worktree-history-replaced";
			message: string;
	  };

/**
 * Probe a recorded worktree identity for continuation (SA-06): repository
 * root resolves, the exact path is registered under the recorded branch, the
 * recorded baseline is an ancestor of the branch tip (the child's own commits
 * are expected work, not drift), and — when a creation reflog snapshot was
 * captured at launch — the snapshot is still a prefix of the branch reflog.
 * Never throws; every failure maps to a reason code, never a raw exit code.
 */
export async function probeWorktreeIdentity(identity: WorktreeIdentity): Promise<WorktreeProbeResult> {
	const fail = (
		code: Exclude<WorktreeProbeResult, { ok: true }>["code"],
		message: string,
	): WorktreeProbeResult => ({ ok: false, code, message });
	let repoReal: string;
	try {
		repoReal = realpathSync(identity.repoRoot);
	} catch {
		return fail("worktree-repo-missing", `repository root ${identity.repoRoot} does not resolve`);
	}
	let wtReal: string;
	try {
		wtReal = realpathSync(identity.path);
	} catch {
		return fail("worktree-missing", `worktree path ${identity.path} does not resolve (removed or moved)`);
	}
	// The directory itself must still BE this checkout: the repository-side
	// registration alone cannot prove the path holds a live worktree of the
	// recorded repository (it could have been replaced by an unrelated repo —
	// acceptance round 1, P1).
	const commonDir = await git(wtReal, ["rev-parse", "--git-common-dir"]);
	if (commonDir.status !== 0) {
		return fail(
			"worktree-replaced",
			`the directory at ${identity.path} is not a git worktree: ${commandFailure(commonDir)}`,
		);
	}
	let commonRoot: string;
	try {
		const raw = commonDir.stdout.trim();
		const absolute = path.isAbsolute(raw) ? raw : path.resolve(wtReal, raw);
		commonRoot = path.dirname(realpathSync(absolute));
	} catch {
		return fail("worktree-replaced", `could not resolve the git common directory of ${identity.path}`);
	}
	if (commonRoot !== repoReal) {
		return fail(
			"worktree-replaced",
			`the checkout at ${identity.path} belongs to ${commonRoot}, not to ${identity.repoRoot}`,
		);
	}
	const topLevel = await git(wtReal, ["rev-parse", "--show-toplevel"]);
	if (topLevel.status !== 0) {
		return fail(
			"worktree-replaced",
			`could not resolve the worktree root of ${identity.path}: ${commandFailure(topLevel)}`,
		);
	}
	let topReal: string;
	try {
		topReal = realpathSync(topLevel.stdout.trim());
	} catch {
		return fail("worktree-replaced", `the worktree root ${topLevel.stdout.trim()} does not resolve`);
	}
	if (topReal !== wtReal) {
		return fail(
			"worktree-replaced",
			`${identity.path} is inside a checkout rooted at ${topReal}, not at itself`,
		);
	}
	const headRef = await git(wtReal, ["symbolic-ref", "-q", "HEAD"]);
	if (headRef.status !== 0 || headRef.stdout.trim() !== `refs/heads/${identity.branch}`) {
		return fail(
			"worktree-branch-swapped",
			`HEAD at ${identity.path} is ${headRef.stdout.trim() || "(detached)"}, not refs/heads/${identity.branch}`,
		);
	}
	const listed = await git(repoReal, ["worktree", "list", "--porcelain"]);
	if (listed.status !== 0) {
		return fail(
			"worktree-repo-missing",
			`git worktree list failed at ${identity.repoRoot}: ${commandFailure(listed)}`,
		);
	}
	const expectedBranch = `refs/heads/${identity.branch}`;
	let registeredBranch: string | null = null;
	for (const block of listed.stdout.split(/\n\n+/)) {
		const lines = block.split("\n").filter((line) => line !== "");
		const entryPath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (entryPath === undefined || entryPath === "") continue;
		let entryReal: string;
		try {
			entryReal = realpathSync(entryPath); // stale/prunable entries are skipped
		} catch {
			continue;
		}
		if (entryReal !== wtReal) continue;
		registeredBranch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? "";
		break;
	}
	if (registeredBranch === null) {
		return fail(
			"worktree-unregistered",
			`worktree ${identity.path} is no longer registered in ${identity.repoRoot} — it was removed`,
		);
	}
	if (registeredBranch !== expectedBranch) {
		return fail(
			"worktree-branch-swapped",
			`the worktree at ${identity.path} is on ${registeredBranch === "" ? "(detached HEAD)" : registeredBranch}, not ${expectedBranch}`,
		);
	}
	const tipResult = await git(repoReal, ["rev-parse", "--verify", "--quiet", expectedBranch]);
	const tip = tipResult.stdout.trim();
	if (tipResult.status !== 0 || tip === "") {
		return fail("worktree-history-replaced", `branch ${expectedBranch} cannot be resolved`);
	}
	const ancestor = await git(repoReal, ["merge-base", "--is-ancestor", identity.baseline, tip]);
	if (ancestor.status === 1) {
		return fail(
			"worktree-history-replaced",
			`branch tip ${tip.slice(0, 12)} does not descend from the creation baseline ${identity.baseline.slice(0, 12)}`,
		);
	}
	if (ancestor.status !== 0) {
		return fail(
			"worktree-history-replaced",
			`could not verify ancestry of ${identity.baseline} in ${expectedBranch}: ${commandFailure(ancestor)}`,
		);
	}
	if (identity.creationReflog !== undefined && identity.creationReflog.length > 0) {
		const reflog = await git(repoReal, ["reflog", "show", "--format=%H %gs", expectedBranch]);
		if (reflog.status !== 0) {
			return fail(
				"worktree-history-replaced",
				`git reflog failed for ${expectedBranch}: ${commandFailure(reflog)}`,
			);
		}
		// `git reflog show` lists newest first: the child's own commits PREPEND
		// entries, so the creation snapshot must still be the listing's TAIL
		// (the oldest entries) — SA-01's D2-step-3 rule verbatim. A rewritten
		// log (update-ref -d + recreate, expiry) loses that tail.
		const entries = reflog.stdout.split("\n").filter((line) => line !== "");
		const snapshot = identity.creationReflog;
		const tail = entries.slice(entries.length - snapshot.length);
		if (tail.length !== snapshot.length || !snapshot.every((line, i) => tail[i] === line)) {
			return fail(
				"worktree-history-replaced",
				"the branch reflog no longer ends with the creation snapshot — the branch was recreated or its history rewritten",
			);
		}
		return { ok: true };
	}
	return {
		ok: true,
		detail: "creation reflog snapshot unavailable at launch — ancestry verified, rewrite check skipped",
	};
}
