# SA-08 reopened — fix design (F-1 stale lookup vs lease, F-2 cwd/worktree consistency, F-3 TaskRecord binding consistency)

Status: design awaiting the pre-implementation independent review (§7). The
owner's integration review reopened SA-08 on 2026-09-29 with two P1s and one
P2, each independently reproduced; the earlier SA-08 closure record (sa-07
design §16) is overturned as a closure claim and stays as history.

Scope: exactly these three findings. No new features. Every fix is inside
the acceptance surface the task list already has.

## 0. The three findings (owner's evidence, condensed)

- F-1 (P1): a resume reads the child file at lookup, validates it, and only
  then acquires the single-writer lease; another executor can legally
  acquire, complete a round, and release in that window. The current call
  then acquires lawfully but repairs/builds/append from the STALE snapshot:
  the completed round stays in the file, the new attempt forks off the old
  leaf, and the effective context misses it. Owner repro output:
  `wireIncludesLatest: false, effectiveIncludesLatest: false,
  rawIncludesLatest: true`.
- F-2 (P1): for worktree children the validator probes
  `launch.worktree.path` (repo/branch/history) but never relates it to
  `launch.cwd`, which is what the tool pool, the permission gate, and the
  event stream actually use. Owner repro: valid worktree identity + `cwd`
  pointing at an unrelated directory resumes and runs there.
- F-3 (P2): the launch record now enforces
  `reference === providerName + "/" + wireModelId` (a3aaa72) but
  `TaskRecord` still accepts any three strings, and the parent-side
  aggregation prices by `record.binding.reference`. Owner repro: a tampered
  record is accepted, priced ($9 from a test rate), and reported
  `incomplete.child: false`.

## 1. F-1 — the lookup snapshot must not outlive the lease

### 1.1 Current flow (src/core/tools/task.ts, resume branch)

1. `findChildByLaunch(parentStore, check.childId)` (line 434) opens the
   child store and captures `file.store` + `file.messageCount` + `launch`.
2. Tool-pool rebuild (469-481) and `validateChildContinuation(file, ...)`
   (499) use that snapshot.
3. `acquireChildLease(file.filePath, attemptId)` (512).
4. Repair + history (`buildContinuationHistory(file.store)`, 535),
   `observeSessionWrites(file.store, ...)` (543), the attempt
   (`runSubagent({ session: file.store, ... })`, 566),
   `onMessage: (m) => file.store.appendMessage(m)` (578), and
   `taskResult(outcome, file.store, ...)` (601) all keep using the
   snapshot taken at step 1.

The interleaving needs no overlapping leases: process B holds the lease
strictly between our step 1/2 and our step 3. When our step 3 succeeds, the
file has B's completed round but our in-memory store does not; our appends
chain onto the old leaf (a second branch), and the effective history from
our new tail never sees B's round.

### 1.2 Fix: re-resolve the authoritative child state under the lease

Directly after `acquireChildLease` succeeds (inside the existing
try/finally), before any repair or append:

1. `const reopened = findChildByLaunch(parentStore, check.childId)`.
   - `!reopened.ok` → refuse with `reopened.message` (release via finally).
   - `reopened.file.filePath !== file.filePath` → refuse: the id now
     resolves to a different file than the one being validated/leased.
   - `JSON.stringify(reopened.file.launch) !== JSON.stringify(launch)` →
     refuse: the header was rewritten while the attempt was being prepared.
   - `reopened.file.messageCount === 0` → refuse (reuse the
     `empty-transcript` wording): the file lost its content after the first
     lookup.
2. Rebind the snapshot variable: `file` becomes `let`, and after the
   four checks above, `file = reopened.file`. Every downstream read that
   used the snapshot (`buildContinuationHistory`, `observeSessionWrites`,
   the `runSubagent` session, the `onMessage` append, `transcriptFor`, and
   `taskResult`'s session argument) automatically uses the authoritative
   store — a forgotten site cannot keep the stale one because no reference
   to the old store remains in scope. (Review correction C-1: the original
   enumeration missed `transcriptFor`, task.ts:593; the mechanical rebind
   removes the enumeration risk.) `launch` is unchanged (deep-equality
   above guarantees it).

Rationale: `findChildByLaunch` re-runs the exact SA-06 lookup boundary
(fresh read, structural `effectiveHistoryProblem`, header/parent identity,
launch parse incl. the a3aaa72 derivation check, duplicate refusal). The
fix adds no new parsing semantics — it re-runs the same one under the lock.
The pre-lease validation remains as the no-side-effect early refusal.

**Refusal record semantics (implementation review C-1).** Every post-lease
refusal (the four re-resolution checks and the pre-existing history
refusal) returns before any transcript mutation and before any provider
call. The SA-03 rejection shape (launched:false, zero turns, no child
reference) is therefore accurate: no work ran and there is nothing to
account for, so such a record contributes nothing to usage totals or the
lifetime line by design. An `attempted`/incomplete marker was considered
and rejected — it would fabricate unknown work where none exists. The
refusal itself stays visible in the tool result.

### 1.3 Deliberately not re-validated

- `executionState` / parent-side records: those reads use the parent store;
  its records can only GAIN settled entries from a parallel executor, and a
  settled child stays settled. A stale parent view cannot un-settle.
  (Parent-file appends from a second process are the session layer's
  existing behavior — outside this finding.)
- Environment fingerprints (agent/system/tools/extensions): snapshotted
  from OUR live options; another executor cannot mutate them.
- The worktree probe: unchanged (F-2 adds the cwd relation; the probe
  itself stays where it is).

### 1.4 Alternatives rejected

- Acquire the lease before lookup/validation: every refusal would first
  create + retire lease artifacts, and SA-07 deliberately keeps refusals
  side-effect-free ("no claim is created for a resume that cannot run").
- In-store reload hooks / file watching: a fourth state mechanism next to
  the store, the lease, and the file; re-resolution under the lease is the
  direct expression of the protocol.

### 1.5 Test seam and the deterministic interleaving regression

New `TaskToolOptions` field (test-only, production never sets it, same
standing as the "injectable wall clock" comment):

```ts
/** Test-only seam (SA-08 reopened F-1): invoked after validation and
 *  before the single-writer lease is acquired, so a test can
 *  deterministically interleave another executor's completed round
 *  between the lookup and the acquire. */
onBeforeResumeLease?: () => void | Promise<void>;
```

Invoked immediately before `acquireChildLease(...)` (after the verdict
check). A throwing seam propagates before any lease exists — no cleanup
path is added.

Regression (test/child-resume.test.ts, new case): dispatch a child to
completion, then resume with a seam that performs a whole other-executor
round under a REAL lease:

1. `const other = acquireChildLease(txPath, "interleave-attempt")` — the
   seam runs before our acquire, so this is protocol-legal single-process.
2. `SessionStore.open(txPath)` → append a user instruction + an assistant
   final message (a minimal settled round), then `other.lease.release()`.

Assertions:
- (a) the resumed attempt's wire request (provider sink) contains the other
  round's instruction text;
- (b) a FRESH store opened after the attempt has both rounds in order in
  `buildContext()` (no fork), AND the attempt's instruction entry chains
  onto the other round's last entry (parentId check on the reopened
  entries — the structural no-fork proof, not just a content sweep);
- (c) the resume result is a launched outcome, not an error.

The seam round simulates the child-side half of a completed attempt. The
real two-process scenario also writes a parent-side TaskRecord; our
in-memory parent view cannot see another process's append, so the test
deliberately does not fabricate one in memory — §1.3 shows the stale
parent view cannot un-settle, and parent-file appends are the session
layer's existing behavior. This scope is explicit, not silent (review
correction C-2).

Red evidence: with the fix reverted, (a) and (b) fail (the owner's exact
shape). The unrelated single-process suites stay green.

## 2. F-2 — the validated worktree identity must constrain the execution cwd

### 2.1 Current behavior

- Fresh dispatch builds the worktree child's cwd BY CONSTRUCTION as
  `wt.path` or, for subdirectory parents, `path.join(wt.path,
  repo.cwdRelative)` (`task.ts:690-693` — "subdirectory parents keep their
  relative position inside the worktree").
- Resume validation (`child-launch.ts:907-920`, worktree branch) probes
  `launch.worktree.path` only; `launch.cwd` is neither existence-checked
  nor related to the worktree.
- Execution uses `launch.cwd`: pool rebuild (474), gate/event context
  (573-579). Owner repro: a valid worktree identity plus an unrelated
  `cwd` resumes, and the attempt runs with the unrelated cwd.

### 2.2 Fix (validator, worktree branch)

After the existing `probeWorktreeIdentity` result:

1. `!existsSync(launch.cwd)` → reason `cwd-missing` (same wording as the
   non-worktree branch).
2. Else, when `probe.ok`: resolve `realpathSync` for both `launch.cwd` and
   `launch.worktree.path` (both wrapped in try/catch — no resolver error
   escapes the validator); allowed iff
   `realCwd === realWt || realCwd.startsWith(prefix)`, where `prefix` is
   `realWt` with exactly one trailing `path.sep` (a `realWt` that already
   ends in a separator — the filesystem root — is used as-is). Otherwise
   new reason `worktree-cwd-outside`:
   "the recorded execution cwd X is not inside the verified worktree Y
   (after resolving symlinks) — the validated environment and the execution
   environment must agree".
3. A `realpathSync` failure on either side (vanished path, unreadable
   component) → refuse `worktree-cwd-outside` with the resolver error in
   the message: the consistency guarantee cannot be established, so the
   attempt does not run. (The worktree side only reaches this branch when
   the probe already succeeded.)
4. Case policy: no case folding is applied — a case variant that differs
   from the recorded construction refuses (conservative). Legitimate flows
   record cwd as `wt.path` or `path.join(wt.path, cwdRelative)`, so their
   strings compare equal without folding. (Review correction C-4.)
5. Directory type (owner round 2, F-2b): after existence, the cwd must
   RESOLVE to a directory — `statSync` follows symlinks — in BOTH branches
   (worktree and non-worktree). A regular file, a symlink whose final
   object is a file, or a stat failure refuses with the new code
   `cwd-not-directory` (message carries the stat error when there is one);
   a dangling symlink is already `cwd-missing` (existsSync is false). In
   the worktree branch the dirness check runs BEFORE the containment
   check, so a file inside the worktree gets the precise code rather than
   a containment verdict. Non-worktree children get the same check after
   their existing cwd-drift/cwd-missing steps. A symlink to a directory
   that stays inside the worktree remains usable (F2-g positive control).
   Rationale (owner's finding): a file cwd passes existsSync, realpathSync
   and containment but cannot host an execution environment; the attempt
   must refuse before any provider call. This also covers a previously
   legitimate subdirectory replaced by a file between attempts — no race
   is needed for the failure.

Explicitly in range: the worktree root and any subdirectory of it at any
depth (the fresh-dispatch relative-position construction). Out of range:
anything else, including a path inside the worktree that resolves outside
it through a symlink. No repair — refusal only. This is environment
consistency, not a sandbox: nothing here constrains what tools may do
inside the worktree.

### 2.3 Alternatives rejected

- Exact equality `cwd === worktree.path`: breaks the supported subdirectory
  parents (would refuse legitimate resumes).
- Lexical prefix without realpath: symlink escape (the exact case the owner
  asked to handle).
- Sandboxing (bind mounts, chroot): explicitly out of scope per the
  finding.

### 2.4 Tests (red-first)

- Tampered `cwd` (valid worktree block kept, cwd rewritten to an unrelated
  temp dir) → refused with `worktree-cwd-outside`; no attempt runs. [the
  owner's repro, now red→green]
- Symlink case: a symlinked path component INSIDE the worktree resolving
  outside (not a symlinked worktree root — that is the probe side's case,
  review correction C-5) → refused.
- Directory-type cases (F-2b, owner round 2): F2-d/F2-e/F2-f above, each
  asserting the refusal and that no provider call happened; F2-g is the
  symlink-to-directory positive control. The F1-b regression is reworked
  to reorder `header.launch` INSIDE the `onBeforeResumeLease` seam, so it
  exercises the two-read comparison path (the old `JSON.stringify`
  implementation would fail it; the owner's non-blocking test-gap note).
- Positive control: a legitimate subdirectory-parent worktree child (cwd =
  join(wt.path, rel)) resumes unchanged → accepted (guards against
  over-refusal).
- Non-worktree children unaffected (their `cwd-drift`/`cwd-missing` branch
  is untouched).

## 3. F-3 — TaskRecord binding must satisfy the same derivation rule

### 3.1 Current behavior

`task-record.ts::isBinding` (line 201) accepts three non-empty strings;
`parseTaskRecord` therefore accepts a record whose three fields disagree,
and `usage-totals.ts:176` prices its usage by `record.binding.reference`.
The launch path already enforces the derivation (a3aaa72); the
authoritative billing record does not. Owner repro: parent session write +
reopen + aggregation → accepted, priced, `incomplete.child: false`.

### 3.2 Fix: one shared predicate

- `child-model.ts` exports:

  ```ts
  export function isModelBinding(value: unknown): value is ChildModelBinding {
    // non-empty strings for providerName/wireModelId/reference AND
    // reference === `${providerName}/${wireModelId}` (the bind() rule)
  }
  ```

- `child-launch.ts::isBinding` (launch records; undefined NOT allowed)
  delegates to it — behavior identical to a3aaa72.
- `task-record.ts::isBinding` (binding optional) delegates; `undefined`
  stays acceptable.

### 3.3 Rejection semantics

A record failing the check parses to `null` — the design-consistent
"unparsable record" path, not a new one:

- `usage-totals` rule 2b: the child bucket is marked incomplete and nothing
  from the record is counted or priced (no attribution to a possibly wrong
  model; no `usd`).
- `validateChildContinuation`: the record no longer counts as settled
  (a child whose ONLY record was tampered refuses as `no-record` —
  conservative direction).
- Lifetime line and worktree-disposition reads ignore it, as they already
  do for unparsable records.

Partial trust is not an option by this repo's own discipline: an invalid
identity is unusable for attribution, so the record is unknown, and unknown
is disclosed.

### 3.4 Fixture/test updates

- `test/usage-totals.test.ts:270` uses `{providerName: "anthropic",
  wireModelId: "m", reference: "unknown/model-b"}` to pin "known identity,
  unpriced" — re-derive it (`wireModelId: "model-b"`, `reference:
  "anthropic/model-b"`, still absent from the test rate table) so the
  intent survives the tightening.
- New unit case (`test/task-record.test.ts`): a record with a disagreeing
  triple fails `parseTaskRecord`; a derived one still parses.
- New integration case (`test/usage-totals.test.ts`): write the tampered
  record into a parent session FILE, reopen via `SessionStore.open`,
  aggregate → `incomplete.child: true`, child bucket empty, no model
  bucket / no `usd` for the tampered reference. [the owner's repro shape]
- Fixture audit: an implementation-time grep re-checks every `test/`
  fixture for co-occurring `providerName`/`wireModelId`/`reference`
  triples before the change lands; the known one is
  `test/usage-totals.test.ts:270` (review correction C-6 — the earlier
  one-off audit is hereby superseded by the re-check).

## 4. Documentation and process

- sa-07 design §16: append a REOPENED note pointing here; the overturned
  closure record stays as history, and the round-4/5 post-hoc-review
  deviation note is untouched.
- This design must pass the pre-implementation independent review (§7)
  before any implementation commit. Round log below.
- Ledger entry (PROJECT_PLAN.md) at merge time, stating the reopening and
  the three fixes; the original SA-08 close-out entry stays as history.

## 5. Known limits / notes

- Concurrent PARENT-session writers are the same class of stale-view
  problem as F-1 but are deliberately left at the session layer: the lease
  arbitrates the child file, and parent-file appends by a second process
  keep the session layer's existing behavior (unchanged by SA-07 and by
  this reopening). Named explicitly so the scope choice is visible, not
  implicit (review correction C-7).
- `onBeforeResumeLease` is an inert test seam in production wiring.
- The launch header comparison is canonical structural equality
  (key-sorted; implementation review C-2): any value change in an external
  rewrite refuses, while key order alone does not (guard test SA-08/F1-b).
  No supported flow rewrites a header at all.
- F-2's containment uses `realpathSync` at validation time; a worktree
  swapped AFTER validation but before/while the attempt runs remains a
  pre-existing TOCTOU outside this finding (the attempt is not a sandbox).

## 6. Test plan summary (red-evidence first)

| # | Case | Red before fix | After fix |
|---|------|----------------|-----------|
| F1-a | interleaved completed round between lookup and acquire (deterministic seam) | wire + effective history miss the round (fork) | both include it; no fork |
| F2-a | valid worktree + unrelated cwd | resumes and runs in the unrelated dir | refused `worktree-cwd-outside` |
| F2-b | cwd symlink resolving outside the worktree | (same acceptance bug) | refused |
| F2-c | legit subdirectory cwd | accepted | accepted (unchanged) |
| F2-d | worktree cwd = a plain file inside the worktree | accepted (P2 repro) | refused `cwd-not-directory`, zero provider calls |
| F2-e | worktree cwd = symlink inside the worktree to a file inside | accepted (P2) | refused `cwd-not-directory`, zero provider calls |
| F2-f | non-worktree cwd directory replaced by a file between attempts | accepted (P2) | refused `cwd-not-directory`, zero provider calls |
| F2-g | worktree cwd = symlink inside the worktree to a directory inside | accepted | accepted (no over-refusal) |
| F1-b' | launch key order changed between the two reads (via the seam) | would refuse under `JSON.stringify` | accepted under canonical comparison |
| F3-a | tampered TaskRecord binding, parse | parsed | null |
| F3-b | tampered TaskRecord binding, reopen + aggregate | priced, complete | unpriced, `incomplete.child` |
| — | full suite (125 files) | green | green |

## 7. Review log (pre-implementation independent design review)

- 2026-09-29: fresh-context adversarial review of this document —
  **APPROVE WITH CORRECTIONS**. Independently verified: the stale-store
  mechanism (`SessionStore.open` re-reads from disk, no process-level
  cache), the seam's single-process lease legality (the in-process map is
  empty at seam time, so the other-executor acquire/release is
  protocol-legal), F-3's rejection semantics matching the rule-2b branch,
  and §1.3's no-un-settle argument. Corrections folded: C-1 (rebind the
  snapshot variable instead of enumerating swap sites — `transcriptFor`
  was missed), C-2 (parent-side scope made explicit + parentId no-fork
  assertion added), C-3 (deep-equal rationale corrected:
  `parseChildLaunch` returns the raw parsed object, so serialization
  equality also refuses added/renamed fields — conservative by design),
  C-4 (realpath throw/root/case policies made explicit), C-5 (symlink
  test shape), C-6 (implementation-time fixture grep), C-7 (parent-session
  writer class named). No rejection-level defect found.
- 2026-09-29: post-implementation adversarial review of 4efd495..ea3e469
  (fresh context, read-only, budgeted) — **APPROVE WITH CORRECTIONS**.
  Independently verified: no residual pre-lease snapshot reads after the
  rebind (all six downstream sites enumerated), lease release on every
  post-acquire return, the containment edge cases (root, trailing
  separator, `/wt-other` prefix, realpath throw), the shared predicate's
  consumers (usage-totals pricing + parse gate only), the seam's
  production inertness (runner.ts:529 does not set it), and that exactly
  the five intended cases are red at 4efd495 and green at ea3e469 with no
  weakened expectations. Corrections: C-1 disposition documented in §1.2
  (nothing ran -> nothing to account; the alternative marker would
  fabricate unknown work), C-2 fixed (order-insensitive canonical
  comparison + SA-08/F1-b guard), C-3 informational. Fold gates: 125
  files / 2361 tests green.
- 2026-09-29 (owner round 2): the owner's re-verification closed F-1/F-2/
  F-3 but kept SA-08 open on one P2 — a regular FILE as execution cwd
  passes existsSync + realpathSync + containment (reproduced: launched
  true, one provider call; also reachable without any race by a
  subdirectory replaced with a file between attempts). Fixed as F-2b
  above (directory-type check in both branches, new code
  `cwd-not-directory`), with the F1-b regression reworked onto the seam
  (non-blocking test-gap note). This delta's pre-implementation review is
  recorded below.
