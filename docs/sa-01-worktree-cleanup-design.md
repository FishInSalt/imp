# SA-01 design: conservative worktree cleanup

Status: APPROVED (2026-09-27) — four adversarial review rounds (REJECT×3 →
APPROVE, round 4); implementation may proceed. Review dispositions in §5–§7.
Branch: `fix/sa-01-worktree-cleanup` (from `main` @ `0d0267c`).
Source task: `docs/subagent-delegation-task-list.md` SA-01.
Touched modules: `src/core/worktree.ts`, `src/core/tools/task.ts`, `test/worktree.test.ts`, `test/task-tool.test.ts`.

## 1. Problem (source-verified)

Four defects combine into one failure mode: a task-owned worktree can be force-removed
(`git worktree remove --force` + `git branch -D`) when its state was never proven to
be "no work to preserve".

- **P1 — error exit codes read as "no changes".** `hasWorktreeChanges()`
  (`src/core/worktree.ts`) falls back to `return diff.status === 1`. `git diff --quiet`
  exits 1 only for "differences"; any other failure (128, spawn failure, missing
  object) falls through to `false` = "clean". `git status` failing the same way is
  equally invisible. The caller's `.catch(() => true)` (`task.ts` finally) never fires:
  `git()` resolves failures as ordinary result objects.
- **P2 — commit history is not checked.** The check compares the working tree against
  `repo.head`; a child that commits an empty commit, or a change-then-revert, leaves a
  tree that is byte-identical to the baseline, so both checks pass and the branch is
  deleted with the worktree. Net-zero *tree* is not net-zero *history*. The harder
  variant (round-1 F1): commits followed by `git reset --hard <baseline>` also leave
  HEAD, the branch ref, status, and tree all at the baseline — only the branch reflog
  still records the moved-away commit.
- **P3 — the `node_modules` exclusion trusts a creation-time boolean.**
  `wt.nodeModulesLinked` is captured at creation; cleanup later excludes
  `node_modules` from `git status` based on that flag alone. If the synthetic link was
  replaced by real content (even gitignored content), the exclusion can hide it.
- **P4 — cleanup-failure surfacing is dead code in `task.ts`.** `wt` is cleared only
  when `cleanupErrors.length === 0`, so the following `if (wt === undefined)` branch
  that would print `[task] worktree cleanup failed: …` is unreachable. When removal
  fails, the result instead claims `changes kept in worktree … merge it`; when removal
  half-succeeds (directory removed, branch delete failed), that claim points at a
  deleted path. The early setup-error paths (`rebuilt === undefined`, tool-subset
  validation failure) assign `cleanupErrors` and then return without ever reading it.

The task list additionally requires: verify the synthetic link *now* before excluding
it; keep the destructive window conservative; state race assumptions; no `/worktrees`
policy change, no sweep/merge/export features.

One more defect was found while writing this design (not itemized in the task list,
within SA-01 scope): in `task.ts` the `[task] worktree cleanup failed: …` branch is
unreachable because `wt` is only cleared when `cleanupErrors.length === 0`, so a
failed removal silently falls through to the `changes kept` trailer (and a
half-removed worktree — directory gone, branch delete failed — gets a trailer that
names a deleted path). Covered by P4/D5 (section-1 problem label and decision
number; review findings use separate F/R2-P/R3-P numbering).

## 2. Decisions

### D1 — a tri-state assessment replaces the boolean

```ts
export type WorktreeRemovalAssessment =
	| { verdict: "clean" }                              // positively verified: nothing to preserve
	| { verdict: "work-present"; detail: string }       // evidence of work found
	| { verdict: "unknown"; detail: string };           // a check could not be completed

export async function assessWorktreeRemoval(
	wt: ChildWorktree, repo: RepoState,
): Promise<WorktreeRemovalAssessment>;
```

Total function: it never rejects; internal Git/fs errors become `unknown` with the
reason. "Clean" requires *every* check to succeed with a positive result; anything
else preserves. `hasWorktreeChanges()` is deleted (its only production caller is
`task.ts`; tests are updated).

### D2 — checks, order, and exit-code semantics

Ran against the real worktree; every command must succeed with the documented exit
code, otherwise the verdict is `unknown` with the failing command and stderr. The
`git -C <dir> …` notation below is shorthand for the module's `git(cwd, args)` helper
(cwd is passed as the spawn option — no `-C` flag is used). The first non-`clean`
verdict wins; checks short-circuit in the listed order.

1. **Ownership.** `git -C repo.root worktree list --porcelain` must contain a block
   whose `worktree` path (realpath-resolved on both sides — macOS lists
   `/private/var/…` for a `/var/…` creation path, and `createChildWorktree` does not
   realpath its base dir) equals `realpath(wt.path)` and whose `branch` line is
   exactly `refs/heads/<wt.branch>`. Missing block / path mismatch / different branch
   → `unknown` ("worktree is not registered under the expected path and branch").
2. **Branch + HEAD identity.** `git -C wt.path symbolic-ref -q HEAD` must be
   `refs/heads/<wt.branch>` (detached or other branch → `unknown`).
   `git -C wt.path rev-parse HEAD` must equal `repo.head` — the creation baseline
   captured before `git worktree add <path> -b <branch> <repo.head>`. A different HEAD
   → `work-present` ("commit history differs from the creation baseline"), covering
   normal, empty, and net-zero commits alike. This is a hard gate: a later check
   never overrides it. The baseline is a parent-side snapshot taken at task start:
   later parent HEAD movement is never compared — the worktree's own HEAD and
   branch are what must match the snapshot.
3. **Discarded-history probe (round-1 F1, hardened in round 2).**
   At creation, `createChildWorktree` captures
   `git reflog show --format=%H %gs refs/heads/<branch>` (run in `repo.root`)
   immediately after `worktree add` succeeds and stores the output lines as
   `ChildWorktree.creationReflog?: string[]` (absent **or empty** = capture
   failed/unavailable — an empty snapshot must never make the suffix check pass
   vacuously). At cleanup, compare lines after trimming the trailing newline;
   inner lines are compared byte-for-byte. Run
   `git -C repo.root reflog show --format=%H %gs refs/heads/<wt.branch>`:
   - no `creationReflog` (absent or empty) → `unknown` ("creation reflog snapshot
     unavailable") — evaluated before anything else;
   - the cleanup invocation exits non-zero → `unknown` ("git reflog failed: …");
   - its output is empty while a creation snapshot exists → `unknown` ("branch
     reflog unavailable — it was cleared; cannot verify that discarded commit
     history is absent"). An empty current list can never end with a non-empty
     snapshot; the case is stated explicitly to keep the empty case unambiguous
     (round-3 R3-P0);
   - the current lines must **end with** the creation snapshot lines byte-for-byte
     (equality allowed — a child that did nothing leaves exactly the snapshot;
     reflog entries only append at the head, so the oldest lines are invariant);
     a mismatch, including a current list shorter than the snapshot, → `unknown`
     ("branch reflog was rewritten or truncated — the creation entry is gone");
   - every entry's SHA must equal `repo.head`; any other SHA → `work-present`
     ("branch reflog shows commit history that later moved away from the creation
     baseline").
   Verified git-2.50.1 behaviors this rests on (throwaway /tmp experiments):
   `worktree add -b` writes exactly one creation entry; a commit (including
   `--allow-empty`) appends a non-baseline entry; `reset --hard <baseline>` and a
   `branch -m` round-trip append entries without erasing older ones; `update-ref -d`
   + `update-ref` replaces the log with a single empty-message entry whose line no
   longer matches the creation snapshot; `git reflog expire --expire=all --all`
   clears the log to empty (exit 0) — the empty-current rule maps that to `unknown`;
   a reflog-less ref prints nothing with exit 0. The snapshot capture is best-effort
   and never throws: a failure is stored as `creationReflog: undefined`, so task
   creation still fails only when `worktree add` itself fails (keeping `task.ts`'s
   setup-error path the single rollback). `creationReflog` is optional and
   `createChildWorktree`'s only production caller is `task.ts`, so no call site
   breaks.
4. **Synthetic `node_modules` link, verified now.** Only when `wt.nodeModulesLinked`
   was true at creation. lstat `<wt.path>/node_modules`:
   - symlink whose realpath equals `realpath(repo.root/node_modules)` → mark it as
     a *known synthetic entry* (consumed by step 6);
   - absent → nothing to filter;
   - anything else (real directory, different target, unreadable) → `unknown`
     ("node_modules is no longer the verified synthetic link") — never silently
     excluded, never implicitly deletable. (If `nodeModulesLinked` is false, the
     path is ordinary user state and git sees it normally.)
5. **Index-flag probe (round-1 F3).** `git -C wt.path ls-files -v`: exit 0 required;
   every line must start with `H` (tracked, no special flags). Any other prefix
   (`h` assume-unchanged, `S` skip-worktree, …) → `unknown` ("index flags make change
   detection unreliable") — such flags hide real modifications from both `status`
   and `diff` (verified experimentally).
6. **Status.** `git -C wt.path status --porcelain` — no pathspec (round-1 F4: a
   `:!node_modules` pathspec can suppress tracked-content changes under that path).
   Exit 0 required; then filter: when step 4 marked the link as known-synthetic, drop
   a single line that is exactly `?? node_modules`; every other line is real state.
   Remaining output non-empty → `work-present` ("uncommitted, staged, or untracked
   files"); empty → continue. A gitignored link may or may not emit the untracked
   line depending on the ignore configuration (both observed); the filter handles
   both. A tracked-content deletion under `node_modules` surfaces here instead of
   being suppressed.
7. **Diff.** `git -C wt.path diff --quiet <repo.head> --`: exit 0 → continue;
   exit 1 → `work-present` ("committed changes relative to the creation baseline");
   any other exit → `unknown` ("git diff failed: …"). Independent confirmation
   signal for steps 2/3/6, and the backstop when they were fooled (e.g. content the
   worktree index does not track).

`clean` = all seven checks passed positively.

### D3 — `git()` distinguishes spawn failure

The spawn `error` handler currently resolves `{ status: 1 }`, which is
indistinguishable from `git diff --quiet`'s legitimate "differences" code. It resolves
`{ status: -1 }` instead. Audit of existing callers: `resolveRepoState` and
`removeChildWorktree` compare `!== 0` / `=== 0`, `listChildWorktrees` and
`worktreeChangeStat` compare `=== 0`; none depends on the value `1`. The new
assessment treats negative/other codes as `unknown`.

### D4 — removal only on `clean`, in both call-site classes

`task.ts` auto-removes only when the verdict is `clean`. `work-present` and `unknown`
both keep the worktree and its branch. The early setup-error paths use the same
assess-then-maybe-remove sequence (the child never ran, so a healthy fresh worktree
still assesses `clean` and is removed; a failed check keeps it).

### D5 — result composition (fixes P4)

After the run, exactly one of these shapes holds:

| State | Suffix appended to the task result |
| --- | --- |
| removed (assessment `clean`, removal succeeded) | none (current behavior) |
| removal failed (`removeChildWorktree` returned errors) | `[task] worktree cleanup failed: <errors>. The worktree or its branch may still exist: <path>, branch <branch>.` (works for the half-removed case — it claims nothing about the tree) |
| kept, verdict `work-present` | existing `buildWorktreeTrailer` with `worktreeChangeStat` (unchanged) |
| kept, verdict `unknown` | `[task] worktree kept for safety: could not verify it is untouched (<detail>). Path: <path>, branch: <branch>. Nothing was deleted.` — no `changes kept` claim, no stat call |
| no worktree | unchanged |

Setup-error paths preserve their existing teaching error verbatim and append the
applicable `cleanup failed` or `kept for safety` line instead of discarding
`cleanupErrors` (the row above describes the normal-completion path, which has a
`taskResult` base to suffix).

### D6 — `removeChildWorktree` stays as-is

Force + prune, best effort, error strings returned. `--force` is still required after
a verified-clean assessment because the excluded synthetic link keeps the directory
non-empty.

### D7 — race assumptions and non-goals (documented in code)

- TOCTOU between the final check and `worktree remove --force` is not defended; no
  promise against concurrent external filesystem/Git mutation. The window is kept
  minimal: checks run immediately before the removal call, no unrelated I/O between.
- Ref-history rewriting is detected by the step-3 creation-snapshot suffix check
  and the empty-current rule: a `branch -m` round-trip keeps the moved-away entries
  (non-baseline SHA → `work-present`), while `update-ref -d`+recreate breaks the
  suffix, and a fully cleared log (`git reflog expire`, reflog-pruning maintenance)
  hits the empty-current rule — both `unknown`. Deliberate evidence tampering —
  deleting exactly the moved-away entries with `git reflog delete`, or forging an
  entry that reproduces the creation line byte-for-byte — is out of scope; this
  design claims ordinary-flow protection, not tamper-proofing.
- The creation baseline `repo.head` is a parent-side snapshot; only the worktree's
  own HEAD/branch/ref state is ever compared against it.
- Repos carrying skip-worktree/assume-unchanged index flags (e.g. sparse
  checkouts) or with `core.logAllRefUpdates=false` will assess `unknown` and retain
  worktrees; accepted conservative behavior, visible in the result note, revisit
  only with a reviewed opt-in.
- The step-5 probe reads the whole index (`ls-files -v`); acceptable at the repo sizes
  this feature targets, revisit if profiling ever shows it.
- `worktreeChangeStat` is only called for `work-present` retention.
- No automatic merge, patch export, stale-worktree sweeping, sandboxing, new CLI, or
  change to `/worktrees` user-directed removal semantics.

## 3. Test plan (labels map to SA-01 acceptance items)

Unit (`test/worktree.test.ts`, real temp git repos):

- U1 untouched worktree with a live synthetic link → `clean`; removal succeeds; parent
  checkout unchanged. (acceptance 1, 5a)
- U2 dirty tracked / staged / untracked file → `work-present`. (acceptance 2)
- U3 normal commit, empty commit, change-then-revert commit → `work-present`
  (regression for P2; currently `clean` — red before the fix). (acceptance 2)
- U4 corrupt `.git` file (refs unusable) → `unknown`; branch ref and directory still
  exist afterwards — no destructive command was issued. (acceptance 3 partial, 4)
- U5 moved worktree (ownership mismatch) → `unknown`. (acceptance 4)
- U6 branch ref deleted → `unknown`. (acceptance 3/4)
- U7 PATH shim making `git status` (or `git diff`) exit 128 → `unknown`, no removal.
  (acceptance 3 — the only way to fail a single subcommand in isolation; shim lives in
  a temp dir, PATH restored in teardown)
- U8 link verified → clean despite link; link replaced by a real directory with user
  files → `unknown` (or `work-present` when git sees the files). (acceptance 5)
- U9 commit(s) followed by `git reset --hard <baseline>` → `work-present` via the
  reflog probe (round-1 F1; currently `clean` — red before the fix).
- U10 tracked file modified with the index's assume-unchanged flag set → `unknown`
  (round-1 F3; currently `clean` — red before the fix).
- U11 branch ref deleted and recreated at the baseline (`update-ref -d` +
  `update-ref`) after a commit → `unknown` via the creation-snapshot suffix check
  (round-2 P1; previously would have been `clean`).
- U12 commit → `branch -m` round-trip → `reset --hard <baseline>` → `work-present`
  via the retained non-baseline reflog entry; branch and directory intact (round-2
  P1 rename variant).
- U13 commit → reset → `git reflog expire --expire=all --all` (log fully cleared) →
  `unknown`, branch and directory intact (round-3 R3-P0; currently `clean` — red
  before the fix).

Injection notes: chmod-based injections (unreadable index) must be skipped when
running as root; the PATH-shim utility saves and restores `process.env.PATH` in every
path.

Integration (`test/task-tool.test.ts`):

- I1 child makes an empty commit → worktree kept, trailer present, branch still
  exists (currently removed: the SA-01 headline regression). (acceptance 2)
- I2 child corrupts its `.git` file → kept, result contains `kept for safety`, branch
  and directory still exist. (acceptance 3, 4)
- I3 `git worktree lock` injected before the child runs → `clean` assessment but
  removal fails → result contains `worktree cleanup failed` and the branch still
  exists (regression for P4; today this path is silent). (acceptance 6)
- I4 setup-error path (agent lists an unknown tool) with a locked worktree → the
  returned teaching error carries the cleanup-failure line. (acceptance 6)
- I5 existing green tests unchanged: untouched child → worktree removed, no trailer;
  dirty child → kept with trailer; crash → kept with trailer; abort → cleaned
  (test at `task-tool.test.ts:1122`).
- I6 cap path: child writes once, then calls a harmless tool until the 60-turn cap →
  `max_iterations` outcome, worktree retained with trailer, branch exists.
  (acceptance 6 — round-1 F2; previously uncovered)
- I7 timeout path: child writes once, then hangs past `timeoutMs` → `timeout`
  outcome, worktree retained with trailer, branch exists. (acceptance 6 — round-1 F2)

## 4. Verification protocol

- Red→green: U3/U4/U7 and I1/I2/I3 fail before the implementation, pass after.
- `npm run typecheck`, `npm run lint`, then `npm test` (full suite) — exact counts
  reported.
- Independent implementation review (fresh context, adversarial) before declaring
  done; findings resolved or explicitly deferred with reasons.

## 5. Review round 1 disposition (2026-09-27)

Verdict REJECT. Dispositions:

- **F1 (P1) reset-to-baseline blind spot** — fixed: D2 step 3 reflog probe, U9.
- **F2 (P1) cap/timeout untested** — fixed: I6, I7.
- **F3 (P2) assume-unchanged/skip-worktree hides edits** — fixed: D2 step 5 probe, U10.
- **F4 (P2) `:!node_modules` pathspec can suppress tracked-content changes** — fixed:
  D2 step 6 drops the pathspec and filters only the verified link's own `?? node_modules`
  line.
- **F5 (P3) realpath wording** — confirmed correct; D2 step 1 now states the macOS
  `/private/var` case explicitly.
- **F6 (P3) lock/`remove --force`, D3 caller audit** — verified by the reviewer; no
  change needed.
- **F7 (P3) D5 setup-error row wording** — fixed in D5.
- **F8 (P3) injection viability** — incorporated as the injection notes in §3.
- **F9 (P3) scope** — clean; no change.

## 6. Review round 2 disposition (2026-09-27)

Verdict REJECT (1×P1, 1×P2, P3 notes). Dispositions:

- **R2-P1 ref-history rewriting** — the mechanism was partially misattributed
  (`branch -m` round-trips preserve the reflog, verified) but a real hole exists:
  `update-ref -d` + recreate silently replaces the log with an all-baseline,
  empty-message entry. Fixed: creation snapshot + suffix check in D2 step 3;
  U11/U12. The reviewer's alternative (fsck dangling-commit scan) was rejected:
  pre-existing dangling objects and concurrent tasks make it false-positive-prone
  on shared repos.
- **R2-P2 `ls-files -v` strictness** — accepted and documented in D7: sparse
  checkout/index-flag repos retain worktrees (conservative), visible in the note.
- **R2-P3 wording nits** — gitignored-link line corrected in step 6; `git -C`
  shorthand clarified in D2's preamble.

## 7. Review round 3 disposition (2026-09-27)

Verdict REJECT (1×P0, 1×P1, 2×P2). Dispositions:

- **R3-P0 empty-current-list ambiguity** — the intended semantics already mapped an
  empty cleanup-output to `unknown`, but the wording grouped it ambiguously with the
  snapshot cases. Fixed: D2 step 3 now states each case as its own bullet (no
  snapshot / non-zero exit / empty current output / suffix mismatch incl. shorter
  list / non-baseline SHA), and U13 pins the cleared-log case so the behavior cannot
  silently regress.
- **R3-P1 baseline scope** — D2 step 2 and D7 now state that `repo.head` is a
  parent-side creation snapshot; later parent HEAD movement is never compared, and
  rebase/amend flows remain fail-safe (retention via work-present or unknown).
- **R3-P2 capture failure/compat** — documented: capture failures are swallowed
  into `creationReflog: undefined`; no call sites break.
- **R3-P2 consistency** — `git gc`/`reflog expire` clearing the log is now covered
  explicitly by the empty-current rule in D7.
