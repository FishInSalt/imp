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
   RESOLVE to a directory — `statSync` follows symlinks — in BOTH branches.
   A regular file, a symlink whose final object is a file, or a stat
   failure refuses with the new code `cwd-not-directory` (message carries
   the stat error when there is one); a dangling symlink is already
   `cwd-missing` (existsSync is false). Precisely (design-review
   corrections folded):
   - Placement, worktree branch: `existsSync` -> dirness -> containment.
     Dirness FIRST is load-bearing: containment alone ACCEPTS a
     symlink-inside-the-worktree whose final object is a file inside it
     (F2-e).
   - Placement, non-worktree branch: `cwd-drift` (unchanged) ->
     `existsSync` -> dirness — never ahead of the drift comparison.
   - `statSync` failure mapping: ENOENT -> `cwd-missing` (a path that
     vanished between the pre-check and the stat is an existence verdict);
     any other error -> `cwd-not-directory` with the error text. EACCES on
     the `existsSync` pre-check itself -> `cwd-missing` (existence could
     not be established).
   - A symlink to a directory that stays inside the worktree remains
     usable (F2-g positive control).
   - `statSync` must be added to the `node:fs` import (child-launch.ts:2).
   Rationale (owner's finding): a file cwd passes existsSync, realpathSync
   and containment but cannot host an execution environment; the attempt
   must refuse before any provider call. This also covers a previously
   legitimate subdirectory replaced by a file between attempts — no race
   is needed for the failure. The new stat inherits the pre-existing
   stat-to-execution TOCTOU class already named in §5.

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
  symlink-to-directory positive control. Fixture requirements
  (design-review corrections): F2-d/F2-e MUST keep the worktree alive
  (the first pass writes, as in T26b) or the refusal would come from a
  `worktree-*` reason and the test would pass for the wrong mechanism;
  F2-f MUST pass `options.cwd` equal to the original directory string or
  the resume's `cwd-drift` comparison fires first.
- The F1-b regression is reworked to reorder `header.launch` ON DISK
  inside the `onBeforeResumeLease` seam, so it exercises the two-read
  comparison path. It is a GUARD, not red-first: the ea3e469 stringify
  generation would refuse it (verified), the pre-fix generation had no
  comparison at all, and the current canonical comparison accepts it —
  its job is to stop a future simplification from reintroducing
  order-sensitive equality (the owner's non-blocking test-gap note).
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
| F1-b' | launch key order changed between the two reads (via the seam) | guard only (ea3e469 stringify generation would refuse; pre-fix has no comparison) | accepted under canonical comparison |
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
- 2026-09-29 (owner round 2 delta): pre-implementation adversarial review
  of 94e5e12 — **APPROVE WITH CORRECTIONS**. Verified: existsSync/statSync
  semantics for every shape (file, symlink-to-file, dangling, ENOENT
  race), F2-f's reachability through the non-worktree drift check
  (options.cwd must equal the original directory string), the fixture
  traps (F2-d/e must keep the worktree alive), and that the seam-time
  reorder must rewrite the on-disk header. Folded: explicit placement in
  both branches, ENOENT->cwd-missing mapping, EACCES-on-pre-check note,
  F2-d/e/f fixture requirements, F2-e load-bearing note, statSync import
  note, F1-b guard labeling. One review claim was checked against the
  tree and does NOT hold: task.ts:578 at 94e5e12 already compares headers
  with `canonicalJson` (from eb7fa2d), not `JSON.stringify` — the review
  read the ea3e469 generation; the guard is still valuable against a
  revert, as labeled.
- 2026-09-29 (owner round 2 delta): post-implementation adversarial review
  of 45766a6 — **APPROVE**, no corrections required. Independently
  verified: branch orders and codes match §2.2 item 5 exactly; ENOENT and
  other stat-error mappings; no over-refusal (F2-c/F2-g green, 44/44);
  F2-d/e/f genuinely red at 61bed02 on the isError assertion and green at
  45766a6 with unchanged expectations; sink counts measured (F2-d/e
  requestsBefore=2, F2-f=1, zero new calls on refusal); the guard was
  ported into an ea3e469 worktree and FAILS there (stringify refuses) and
  passes at HEAD — a real guard. Observations folded/recorded: the
  zero-provider-call assertion now precedes the isError assertion in
  F2-d/e/f so a future red run fails on "a provider call happened" (the
  owner's exact complaint); file-cwd-plus-failed-probe double reporting is
  pre-existing structure and stays.

## 8. Owner round 3, F-4: capture the provider with the model binding at spawn

### 8.1 The finding

src/core/tools/task.ts, fresh dispatch: the model binding is resolved and
saved at 712-713, then the path awaits (resolveRepoState /
createChildWorktree, 738-744), and only at 848 does the attempt read
`provider: options.getProvider()`. `/model` may run in the parent while a
spawn is in flight; the runner updates `providerName` and `provider` in one
synchronous block (runner.ts:1157-1158), so two ADJACENT reads form a
coherent pair — but reads separated by awaits do not. Owner repro: actual
call provider=openai model=claude-fixture while the record says
providerName=anthropic reference=anthropic/claude-fixture, status
completed. The resume path reads the live provider once (task.ts:477) and
passes that captured instance to the attempt — it has no such window.

### 8.2 Fix (capture the pair in one synchronous step)

At the resolution point, read the parent reference and the provider
back-to-back and derive the binding from the same instant:

```ts
const parentReference = options.getModelReference?.() ?? options.getModel();
const provider = options.getProvider();
const resolution = resolveChildModel({ parentReference, override: agent?.model, agentName: agent?.name });
```

(Design-review FC-1: these two reads must be the FIRST statements of the
resolution step, before `resolveChildModel`, and the captured `provider`
const is used verbatim at the attempt; nothing that can yield may precede
the pair read. FC-5: the capture lives inside the execute handler — one
read per invocation, never hoisted to module scope, so back-to-back spawns
each inherit their own instant.)

The attempt uses the captured `provider` (replacing the late
`options.getProvider()` at 848). No other fresh-path consumer reads the
provider INSTANCE: the pool rebuild and capability decisions consume
`binding` (captured with it; `getToolsForChild` receives `binding`), and
the launch record persists `binding` only (no credentials, no instances).
Semantics: the child inherits the model+provider pair that was current at
the resolution instant — the SA-02 rule "whatever is current at spawn",
with "spawn" now pinned to the synchronous pair read.

Design decision (no new refusal): a caller wiring contradictory getters
would still call one provider instance while recording another family.
No production wiring does this (runner.ts:1157-1158 updates both fields in
one synchronous block, so adjacent reads cannot observe a middle state),
and the recorded identity is already gated at continuation by the resume
path's `providerMismatch`. Adding a fresh-spawn name-agreement refusal
would be new behavior beyond this finding; it is recorded as a known limit
(§5-class) rather than implemented.

Scope precision (design-review FC-2): this pins the provider/model pair
for ATTEMPT CONSTRUCTION only. `getAutoCompact()` (847) and the `onEvent`
emission context (853-861) still read live runner state at attempt time —
pre-existing, outside this finding, recorded as a known limit alongside
§5. The claim is NOT "the whole spawn is pinned".

Consequence, stated explicitly (implementation review F-4c): a /model swap
in this window can change the child's AUTO-COMPACTION decision or event
context while `binding` stays pinned. It does NOT change the wire
provider/model or the recorded identity (`rec.binding` and the request's
`model`/`modelReference` all come from the captured pair). This residual
is an owner-accepted scope boundary, not a defect.

Resume-path note (implementation review F-4b; corrected per owner
round 4): the resume branch reads `liveProvider` once (task.ts:477) and
uses that captured instance at the attempt. A yield point DOES exist
between the two (`await validateChildContinuation(...)`, plus the lease
acquisition), so a /model swap can happen in that window — the attempt
still runs on the CAPTURED instance, and that capture (not the absence of
a window) is the correctness argument. The comment at the read pins the
invariant: do not move the read after the await; no code path re-reads the
provider inside the attempt, and none may be added.

### 8.3 Test (red-first)

F4-a: a worktree child whose provider is swapped exactly inside the async
window — the test harness's `getToolsForChild` callback (invoked after
worktree creation, before the attempt) flips the getter's current provider
from A to B. The DISCRIMINATING assertion (design-review FC-3): A's sink
has exactly one entry containing the prompt (plus B's sink empty — the
record-binding assertion alone also holds for a stale binding and is not
discriminating). Red on the current code: the late read at 848 sends the
attempt to B. Harness plumbing (FC-4): the LOCAL
`test/child-resume.test.ts` HarnessArgs gains an optional
`getProvider?: () => LLMProvider`; the related mid-flight test in
test/task-tool.test.ts:331 uses its own inline wiring and is untouched.
FC-5: per-invocation capture only.

## 9. Owner round 3, F-5: order-aware tool pairing (SA-07 §6.1 revision)

### 9.1 The finding

scanToolPairs (child-resume.ts:144-182) works on SETS: declared ids
(first occurrence wins — duplicates silently dropped), resolved ids (any
result id, including never-declared ones), missing = declared - resolved;
the crash-tail rule then inspects that set. Owner repros, all currently
accepted (one provider call each, no repair):
- a tool result with no corresponding call;
- a tool result recorded BEFORE its call;
- a trailing unfinished call that reuses an earlier completed call's id
  (masked by the earlier result; no "unknown outcome" repair added).

This is a DESIGN revision: sa-07 design §6.1 specified the set-based scan.
The revision replaces §6.1's collection phase; the crash-tail rule for
repair keeps its shape, and "refuse what cannot be paired, repair only the
confirmed crash tail" becomes enforced by construction.

### 9.2 Revised scan (single ordered pass)

Walking the effective history's messages in order, maintain `pending`
(declared, unmatched) and the seen-call id set:

1. assistant `toolCall` id already seen → REFUSE: "tool call <id> is
   declared more than once — the transcript cannot be paired unambiguously"
   [F5-c: the reused id is ambiguous, never repaired].
2. toolResult id not declared BEFORE this point → REFUSE: "a tool result
   for <id> has no preceding tool call" [F5-a: no call at all; F5-b:
   result before call]. The compaction snap (findCutIndex retains a
   user/assistant head; §6.1) guarantees the effective history cannot
   legitimately start with a result, so this shape is genuine damage.
3. toolResult id already matched by an earlier result → REFUSE: "the tool
   result for <id> is recorded more than once".
4. otherwise: match (remove from `pending`).

Implementation precision (design-review FC-6/FC-7/FC-8): F5-a and F5-b
share ONE refusal string (the tests assert the shared substring; the two
shapes are intentionally indistinguishable at the message level). The scan
keeps THREE distinct structures — `seenCallIds` (rule 1), `matchedIds`
(rule 3), `pending` (the missing set) — do not unify them. Invariants:
a matched id is removed from `pending`, so it can never appear in
`missing`; a duplicate id refuses before the crash-tail rule runs, so the
two can never interact.

After the pass: `missing` = `pending`. Empty → proceed. Non-empty → the
UNCHANGED crash-tail rule: every missing id belongs to the LAST assistant
message and every message after it is a toolResult → repairable (repair
exactly those ids); anything else → refuse `history-unpairable`.

Order tolerance kept deliberate: results within one batch may arrive in a
different order than the calls (each still after its call) — parallel
tool completion is legitimate; the scan pairs by id with the order
constraints above.

### 9.3 Tests (red-first; refusal asserts zero provider calls)

- F5-a: append an orphan toolResult (id with no call anywhere) → refused,
  sink unchanged.
- F5-b: append toolResult(id X) then assistant(toolCall X) → refused,
  sink unchanged.
- F5-c: the first pass completes a real call/result pair (countingEcho);
  the test reads the ACTUAL call id from that transcript and appends a
  trailing assistant(toolCall, that exact id) → refused (duplicate), and
  the file is byte-compared to prove NO repair was appended (design-review
  FC-11: without id reuse the test cannot be red).
- "Zero provider calls" is asserted as a length-marker comparison
  (`sink.length` captured after the first pass and unchanged after the
  refused resume), never `sink` empty (FC-12).
- Positive controls stay green: T14 (single trailing orphan → repaired),
  T16 (orphan beyond the crash tail → refused), T22 (valid pairing).

### 9.4 Docs

sa-07 design §6.1 gets a revision pointer to this section (set semantics
superseded; repair rule unchanged); §16 gets the round-3 log entry.

## 10. Round-3 review log (pre-implementation)

- 2026-09-29: fresh-context adversarial review of 5d6a489 (§8-§9) —
  **APPROVE WITH CORRECTIONS**, no rejection-level defect. Independently
  verified: the late-read window at task.ts:848 (red-able); the runner's
  synchronous provider/providerName swap (runner.ts:1157-1158) making the
  adjacent pair read coherent; every legitimate transcript shape against
  the ordered scan (compaction head snap, synthetic repair results,
  parallel results out of order, multiple results per message, matched +
  trailing new call, text+toolCall blocks) — no over-refusal; T14/T16/T22
  stay green; scanToolPairs has exactly one call site. Folded: FC-1
  (pair read first, provider const verbatim at the attempt), FC-2 (scope
  narrowed to attempt construction; onEvent/getAutoCompact residual
  windows recorded as known limits), FC-3 (F4-a's discriminating
  assertion), FC-4 (correct harness named), FC-5 (per-invocation
  capture), FC-6/FC-7/FC-8 (shared refusal string; three distinct
  structures; matched-pending invariants), FC-11 (F5-c must reuse the
  actual first-pass call id and prove no repair), FC-12 (length-marker
  sink assertion).

## 11. Round-3 review log (post-implementation)

- 2026-09-29: fresh-context adversarial implementation review of
  073b3e2..999aa54 — **APPROVE WITH CORRECTIONS**, no code rework.
  Independently verified: the capture is first/adjacent and per-invocation
  (runner.ts:1157-1158 coherence argument re-checked); F4-a is
  discriminating (old code lands the request in sinkB); the ordered scan
  against the loop's real append grammar (one toolResult batch after each
  call, fillMissingToolResults closes capped children, compaction heads,
  synthetic repairs) with no over-refusal; T23's unique-id fixture is a
  legitimate artifact correction with unchanged expectations; F5-c reads
  the real id and byte-compares the transcript. Folded: F-4a (comment now
  requires first AND adjacent), F-4b (resume read pinned in a comment +
  this record), F-4c (consequence of the residual window stated).
  One review claim was checked and does NOT hold: F-5a ("an orphan result
  whose id collides with a later call is silently dropped") — under rule 2
  the result refuses AT ITS POSITION because no preceding declaration
  exists (and the F5-b test exercises exactly that order and passes); the
  review's suggested `pending.has(id)` guard is equivalent to rules 2+3.
  No gap; no change.

## 12. Owner round 4, F-5b: the turn-boundary rule (blocking)

### 12.1 The finding

The ordered pass (section 9) validates each result against an EARLIER
declaration, but never checks whether a NEW turn (user or assistant
message) began while calls were still awaiting results. Owner repros, all
currently ACCEPTED (launched true, one provider call; confirmed with the
real OpenAI adapter against a local fake HTTP service that the wrong
order reaches the request body):

- assistant: call c1 -> assistant: another reply -> toolResult c1 -> user.
- a user message inserted between a call and its result.
- a new batch of tool calls while the previous batch is unresolved.

End-of-scan `pending` checks cannot catch these: the late results balance
the sets, so `missing` is empty and the scan returns repairable.

### 12.2 The rule

At every message boundary, BEFORE processing that message: if it is a
user or assistant message and `pending` is non-empty, REFUSE — "a new
<role> message begins a turn while tool call(s) <ids> are still awaiting
results — the transcript cannot be paired unambiguously (start a new task
instead)". This is checked per message, not only at the end, and runs in
the read-only scan phase (before any transcript modification and before
any provider call).

Interaction with the crash-tail rule (unchanged): the repairable tail
shape has by definition NO user/assistant message after the unresolved
batch (only toolResult messages), so the boundary rule cannot fire on it;
T14 keeps its behavior. Wording unification (design-review correction):
T16's and T17's shapes (call -> user; call -> call -> result) DO carry a
later user/assistant message, so they now refuse with the BOUNDARY
wording instead of "inconsistent beyond a crash tail"; their assertions
are updated accordingly (refusal, no mutation, zero provider calls —
behavior unchanged, not a weakened expectation). The tail message now
fires only for unresolved batches followed purely by toolResult
messages. Result-order tolerance within one batch
(parallel completion) is unaffected: toolResult messages never trigger
the boundary rule. Legitimate grammar invariant (verified against the
loop): between an assistant call batch and its toolResult message the
loop appends nothing else; capped children have their outstanding calls
closed by fillMissingToolResults before the run ends. Compaction heads
snap to user/assistant, so a retained tail cannot begin mid-pair.

### 12.3 Tests (red-first)

- F5-d: call c1, then another assistant message, then result c1, then a
  user message -> refused at the second assistant message; zero provider
  calls; transcript bytes unchanged.
- F5-e: call c1, then a user message, then result c1 -> refused at the
  user message; zero provider calls.
- F5-f: call c1, then a second assistant message with call c2, then
  results for BOTH ids (sets balance — on the current code this is
  ACCEPTED, which is the red) -> refused at the second assistant message;
  zero provider calls.
- F5-g (positive control): one batch (c1, c2) whose results arrive
  OUT OF ORDER in a single toolResult message -> accepted (guards against
  over-refusal; green before and after). No tools are needed in either
  harness for F5-d/e/f/g: their first passes are tool-free and the crafted
  history's tool NAMES are never pool-checked (F5-c's echo requirement is
  specific to its real first-pass pool).
- Assertion strengthening (design-review correction): F5-d/e/f assert the
  boundary wording, the PENDING id by name, the zero-provider-call sink
  marker, and transcript byte-equality — pinning the refusal to the
  boundary check rather than the tail inference.
- T14/T16 (tail repair / non-tail refusal) stay green, as do F5-a/b/c
  and the ordering controls from section 9.

All three refusal cases use the echo tool in both harnesses so the
recorded pool rebuilds identically and the scan — not tools-drift — is
what refuses. On the current code all three are accepted (red evidence).

### 12.4 Round-4 review log (pre-implementation)

- 2026-09-29: fresh-context adversarial review of 8cebb92 (§12 + the
  §8.2 correction) — **APPROVE WITH CORRECTIONS**, rule sound, no
  legitimate transcript refused. Independently verified by driving
  buildContinuationHistory directly: the three repro shapes are accepted
  today (red-able) and the out-of-order batch stays legal; the loop
  grammar invariants (one toolResult append per batch, fillMissingTool
  Results before a capped/aborted run ends, findCutIndex heads, the
  resume's own instruction push AFTER the scan) hold. Folded: T16/T17
  wording unification (above), F5-f's both-results construction, F5-d/e/f
  assertion strengthening, F5-g's no-tools note, the softened
  re-read invariant. One review claim does not hold as stated: §8.2 does
  NOT mention `transcriptFor` (that word appears only in §1's rebind
  notes) — nothing to drop there.
- 2026-09-29: post-implementation review of ced0c1d — **APPROVE WITH
  CORRECTIONS** (one test-hygiene item, folded: T17 now asserts transcript
  byte-equality and zero provider calls like T16). Independently verified:
  the boundary check's placement/wording, no over-refusal against the loop
  grammar and compaction heads, the disproved 'late declaration' claim is
  covered two ways, F5-d/e/f red for the accepted-shape reason at 5da0473,
  and diff --check clean across the delivery range.
- Observed intermittency (unrelated to this delta, recorded for honesty):
  during the fold's first full-suite run, test/login-dialog.test.ts case
  17b failed once under full parallelism; the file alone is 16/16 and 17b
  repeated green 3/3, and the next full run was green. Mechanism: the
  suite's frameEventually polls with a fixed 6000ms budget
  (test/login-dialog.test.ts:22, :521) and can starve under load — the
  same signature as the owner's round-3 observation. Not modified here
  (outside the delivery's scope); a candidate separate fix is a larger
  budget or an injectable poll timer.

## 13. Owner round 5, F-6: batched image hoisting in the chat-completions wire

### 13.1 The finding

The internal pairing scan accepts a batch split across consecutive
toolResult messages (a run of toolResult messages may complete one batch;
the crash-tail repair appends missing results as another toolResult
message — section 12). But the chat-completions conversion
(src/provider/openai-completions.ts, `toWireMessages`, the `toolResult`
case around 138-180) hoists each toolResult message's images into a user
message IMMEDIATELY after that message. For the internal history
[assistant(c1, c2), toolResult(c1 with image), toolResult(c2)] the wire
becomes assistant -> tool c1 -> user(image) -> tool c2: a user message
while the batch's tool messages are still incomplete — exactly the
ordering the round-4 boundary rule refuses INTERNALLY, reintroduced by
the conversion after the scan. The same holds for the repaired tail
[assistant(c1, c2), toolResult(c1 with image), toolResult(c2 synthetic)].
Owner repro used the real OpenAI adapter with a locally replaced fetch
and captured the emitted body order (no external service; the claim is
the wrong wire order, not an observed server rejection). Affected
adapters: every consumer of this conversion (openai, zai, deepseek,
moonshotai, thinking wrappers).

### 13.2 Fix: defer the hoisted message to the end of the toolResult run

`toWireMessages` buffers the run's images outside the per-message case.
Flush points, stated explicitly (design-review F6-C1): (a) at the TOP of
the loop iteration when the current message is NOT a toolResult (i.e.
before emitting that message), and (b) once after the loop terminates.
The flush uses `wire.push` at the current position — never an index — and
`wire` is seeded with the system message BEFORE the loop, so neither the
system message nor the run's internal order can be displaced. The flush
emits ONE user message ("Attached image(s) from tool result:" + all
buffered images); with zero buffered images it is a no-op (non-image runs
stay byte-identical). Every tool message of the run is emitted first and
the image user message follows. This is a deliberate
deviation from the previous pi-parity placement (which assumed a single
toolResult message per batch): a wrong wire order is not worth parity.
Conversion-only — no transcript rewrite, no tool replay (owner
requirement).

### 13.3 Tests (red-first; test/images.test.ts capture harness)

- F6-a: [user, assistant(t1, t2), toolResult(t1 with image),
  toolResult(t2)] -> assert the EXACT role sequence
  ["system","user","assistant","tool","tool","user"] with tool ids
  [t1, t2], and the flushed message's content shape (text lead +
  image_url) — exact-sequence equality, not just tail position
  (design-review F6-C2). On the current code the user message sits
  between the two tool messages: red.
- F6-b: the repaired shape through the REAL repair (F6-C4): build a store
  with SessionStore.create + [user, assistant(t1, t2), toolResult(t1 with
  image)], run buildContinuationHistory (the repair appends the t2
  unknown-outcome result), drive the provider with `history.messages`,
  assert the same exact role sequence plus both tool results before the
  image message (pins repair + conversion integration).
- F6-c (F6-C3, green control): run where ONLY the last toolResult has an
  image -> ["system","user","assistant","tool","tool","user"] — already
  the correct order today; guards the flush against moving it.
- F6-d (F6-C3): several results in the run carry images -> ONE merged
  user message containing BOTH image URLs in order (on the current code:
  two user messages with the wrong order: red).
- Positive controls unchanged and reused via the existing drive()/server
  harness (F6-C4): the single-result imageTurn hoisting tests, the
  non-vision placeholder tests, the zai wrapper test.

### 13.4 Round-5 review log

- 2026-09-29: pre-implementation adversarial review of 69d8122 —
  **APPROVE WITH CORRECTIONS**, no rejection-level defect. Independently
  reproduced via the real adapter + local capture server: F6-a's wire is
  ["system","user","assistant","tool","user","tool"] and F6-b's repaired
  variant is ["system","user","assistant","tool","user","tool"] (both
  red today); non-image runs are already correct and stay
  byte-identical; the immediate-hoist site is unique to
  openai-completions.ts (all four wrappers pass no message
  transformation); Anthropic/codex embed images natively and are
  unaffected; downloadUnsupportedImages runs before the conversion, so
  the buffer degrades to the current text-only output on non-vision
  models. Folded: F6-C1 (explicit flush points; wire.push at position;
  system seeded before the loop), F6-C2 (exact role-sequence assertions
  + content shape), F6-C3 (F6-c/F6-d added), F6-C4 (existing harness;
  F6-b through the real store/repair). Unverified by the reviewer and
  left for the implementation: the fix itself against the run-at-end and
  run-followed-by-assistant shapes; merged multi-image messages against a
  live gateway (reuses the existing multi-image shape; no new wire
  construct).
- 2026-09-29: post-implementation adversarial review of fb01a9e —
  **APPROVE**, no corrections required. Independently verified: buffer
  ownership and both flush points (wire.push at position; system seeded
  first); every emission shape (single-result golden, last-only image,
  merged multi-image, run-followed-by-assistant/user, run-at-end,
  text-only byte-identical, non-vision placeholders — the downgrade runs
  BEFORE the conversion); the rename left no stale `hoisted` references;
  the immediate-hoist site is unique to openai-completions.ts and the
  wrappers pass messages through; F6-b feeds the REAL repaired list
  (repairs string origin checked); the new tests fail at f3a5536 exactly
  on the extra `user` between the tool messages; gates re-run (images
  29/29, full 125 files / 2377 tests). Recorded observations (no action):
  the flush guard precedes the exhaustive default throw (harmless; the
  throw aborts conversion anyway) and flushPendingImages reassigns the
  buffer in its closure (correct; noted as an edit-sensitive pattern).
  UNVERIFIED: the pi-parity comment line references were not checked
  against a pi checkout (comments only).
