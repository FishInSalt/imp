# M6b — Worktree isolation for subagents (design)

> Status: settled 2026-09-05. Verified references: pi-subagents `src/runs/shared/worktree.ts`
> (802 lines, local npm package) and Claude Code restored source `utils/worktree.ts` +
> `tools/AgentTool/AgentTool.tsx`. Every claim below was read from those files, not assumed.

## 1. Problem

Concurrent subagents share the parent's cwd. edit/write serialize through the process-wide
file lock and a failed `oldText` match degrades into a teaching error, but bash mutations
bypass the lock and a whole-file `write` silently clobbers an earlier one (documented in
README "Concurrency boundary"). Worktree isolation removes the shared surface entirely:
each delegated *writing* task runs on its own checkout of the repository.

## 2. Mechanism

`git worktree add <path> -b <branch> HEAD` creates an independent working directory sharing
the `.git` object store. Cost ≈ one checkout. The child gets the **committed** state (HEAD):
uncommitted and untracked files in the parent tree are NOT visible — mitigated by a notice,
not by machinery (both references do the same).

## 3. Decisions

| # | Decision | Choice (source) |
|---|----------|-----------------|
| D1 | Trigger | `worktree?: boolean` param on task + optional `worktree:` in agent frontmatter (agent default, call override — both references) |
| D2 | Location | `os.tmpdir()` default, `IMP_WORKTREE_DIR` override (pi default; inside-repo pollutes `git status`) |
| D3 | Base | HEAD; dirty parent tree allowed, child prompt gets a notice (CC `forkSubagent.ts:205-209` pattern) |
| D4 | Handback | Keep-worktree-and-report (CC): no changes → remove worktree+branch; changes → keep, result carries `worktree path / branch / change stat`; the **parent** merges. Patch machinery rejected (pi's guards exist because patches lose untracked/binary nuance) |
| D5 | Tool pool | Builtins rebuilt with `cwd = worktree` (factories already take cwd); **extension tools excluded** from worktree children — stated in the child notice and README (their `api.cwd` cannot be redirected, mixing would silently split the pool across two trees) |
| D6 | node_modules | Symlink from repo root when present (pi `linkNodeModulesIfPresent`) — without it builds fail mysteriously |
| D7 | Non-git / nested | Non-git cwd → teaching error telling the model to retry without `worktree`; worktree-in-worktree → resolve the canonical repo root (CC comment at `worktree.ts:922-925`) |
| D8 | Cleanup | Same rule on completed/aborted/timeout/crash: no changes → `worktree remove` + `branch -D` + `prune`; changes → preserve. Never silently discard work (both references agree) |

## 4. Child notice (appended to the prompt, D3)

```
You are working in an isolated git worktree at <path> — same repository, separate
working copy. Paths from the task refer to the parent's working directory; translate
them to the worktree. The worktree reflects the committed state (HEAD); uncommitted
parent changes are not visible, so re-read files before relying on details.
When your changes are complete, commit them on the current branch with a descriptive
message — the parent merges your branch.
```

The commit instruction makes the branch handback real (D4): without it the branch never
receives commits and "merge the branch" is meaningless.

## 5. Result trailer (D4)

When work is preserved:

```
[task] changes kept in worktree <path> on branch <name> — merge it in the parent
directory with `git merge <name>`, or inspect with `git -C <path> diff` first.
```

Change stat (files, +/−) is computed with `git diff --shortstat HEAD` inside the worktree.
When nothing changed, the worktree is removed and the ordinary result comes back.

## 6. Lifecycle

```
execute(worktree=true)
  ├─ resolve repo state (D7)      → teaching error, provider never called
  ├─ git worktree add -b <branch> HEAD (baseCommit recorded)
  ├─ link node_modules (D6)
  ├─ child pool = builtins(cwd=worktree) (D5) + notice (D4)
  ├─ runSubagent(...)             — abort/timeout/crash fall through to cleanup
  └─ hasChanges(worktree, baseCommit)?
        ├─ no  → worktree remove + branch -D + prune; plain result
        └─ yes → keep; result += trailer
```

## 7. Out of scope (explicit)

- Parent-side merge of several child branches (git + parent model's job; conflicts are
  ordinary git conflicts).
- Submodules (known worktree pitfalls) — declared unsupported.
- Propagation of uncommitted/untracked parent state (notice only).
- Extension tools inside worktree children (D5).
- Cleanup of *old* preserved worktrees across sessions (a `/worktrees` listing command is
  a natural follow-up, not part of M6b).

## 8. Tests (hermetic git repos under tmpdir — no network)

1. Unit: resolve/add/hasChanges/remove on throwaway repos; non-git → teaching error.
2. e2e: task(worktree) with the real write tool — child writes a file inside the worktree;
   assert file lands in the worktree path, parent tree untouched, result trailer names
   branch, worktree preserved; then a no-change task removes the worktree.
3. Abort path: aborted child with changes → worktree preserved, outcome notes it.
4. Frontmatter: agent `worktree: true` flag reaches the task; call param overrides.
5. Extension tools excluded: pool assert in a runner-level test.

## 9. Post-review revision (2026-09-05, independent reviewer pass)

Verdict was fix-first; all blockers and nits resolved in `fix/m6b-review`.

- **B1 (blocker)**: the agent unknown-tools teaching error returned after
  worktree creation but before the cleanup scope — leaking an empty worktree
  and branch per misconfigured call. Fix: tools narrowing moved BEFORE
  creation; everything after creation lives inside the try/finally (session
  creation included).
- **B2 (blocker)**: the branch was based on the MAIN root's HEAD while change
  detection diffed against the PARENT's HEAD — a parent inside a linked
  worktree got silent wrong-tree merges and never-cleaning worktrees. Fix:
  `worktree add … repo.head`. Regression test builds the exact nested setup.
- **Deadlock (found while testing B-coverage)**: an already-aborted parent
  signal never fires "abort" again — `addEventListener` on it silently did
  nothing and the child hung forever. Fix: relay immediately when the signal
  (or timeout clock) is already aborted.
- Nits: change stat now diffs vs the base commit (committed work shows);
  cleanup failures surface in the result instead of leaking silently;
  `getToolsForCwd` returning undefined fails loudly (same guard as missing);
  symlinked node_modules excluded from change detection (unignored
  `node_modules` no longer forces "changed"); realpath failure is a teaching
  error; subdirectory parents remap the child working directory (pi agentCwd
  pattern — cited in research, missed in v1); notice states the working
  directory and the extension-tool exclusion; README stale/overclaiming lines
  fixed.
- Coverage added: B1/B2 regressions, abort-mid-child cleanup, committed-work
  stat, two parallel worktree tasks (distinct branches, concurrent add),
  unignored node_modules no-change cleanup.
