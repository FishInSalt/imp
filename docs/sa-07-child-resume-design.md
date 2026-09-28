# SA-07 — Synchronous continuation of settled children (design)

- Date: 2026-09-29
- Branch: `feat/sa-07-child-resume`
- Baseline: `bae428e` (main; SA-06 merged)
- Status: REVIEWED — two-track adversarial review returned APPROVE WITH
  CORRECTIONS; all findings folded (see §16). Implementation may proceed.
- Task-list source: `docs/subagent-delegation-task-list.md`, SA-07 section.
- Depends on the frozen contracts of SA-03 (`src/core/task-record.ts`),
  SA-04 (`SubagentUsageDetail` / attempt ledger), SA-06
  (`src/core/child-launch.ts`, merged in `e7dddff`). Regression-checks SA-01
  (worktree cleanup) and SA-02 (child model binding). Accounting integration
  with SA-05 is verified here (task list: "its accounting integration must be
  verified with SA-07").

## 1. Problem and evidence

A `task` dispatch is one-shot. When a child settles — completed, capped,
aborted, timed out, or crashed — the parent has exactly two options: dispatch
a fresh child (the original prompt is the only context it gets; every file
read and observation is paid for again) or do the work itself by reading the
child's JSONL transcript. The persisted state (SA-03 records, SA-06 launch
blocks) exists, but nothing consumes it for continuation.

Real causes recorded in the project ledger:

- 2026-09-23: a review child hit the 40-turn cap with zero text, 44.9k tokens
  spent with no return (`#subagent-softlanding`); the follow-up batch made the
  failure honest but could not recover the work.
- The same pattern repeated during `#compaction-ux`: a delegated child hit
  the cap; the recovery was to split the work into two fresh dispatches and
  re-explore from zero.
- The current result text says it plainly: "Re-dispatch with a narrower
  prompt, or read the transcript and continue the work yourself."

The everyday non-incident case matters even more: review → fix loops. The
parent reads the child's findings and wants the SAME child to check one more
thing, with its context intact. That is impossible today.

The requested direction (`docs/subagent-delegation-task-list.md`): "Add
synchronous continuation of an identified, already-settled child, without
building a background-task system." SA-03 through SA-06 built identity,
accounting, and durable validated launch state precisely as this feature's
foundation; SA-07 is the consumer.

## 2. Scope and non-goals

In scope (task-list SA-07):

- `task({ resume: "<childId>", prompt: "..." })` continues one settled child
  synchronously, in the recorded role/model/tool/cwd/worktree contract,
  appending exactly one new instruction to the child's own effective history.
- Validation via SA-06 on the frozen lookup/validation contract; SA-07 ANDs
  its own single-writer lease and provider-identity gate.
- Conservative transcript repair at the continuation boundary only.
- Per-attempt accounting with the logical child identity preserved; lifetime
  usage reported separately from the new attempt's usage.

Non-goals (explicit): background notifications, wait tool, live steering,
scheduling, automatic retry, automatic resume loops for capped children,
recursive delegation, cross-project resume, provider switching, worktree
recreation, fresh-child or parent-cwd fallback, a second child registry, a
second usage ledger, or a second metadata format. Independent review still
requires a NEW fresh-context child — resume is continuation of one logical
work stream, not a mechanism for fresh perspectives.

Model-visible behavior that must stay unchanged: fresh dispatch semantics
(apart from one additive result line, §4.3), the five-concurrent-call chunk
semantics, child turn cap and timeout precedence, permission gating through
the parent's live gate.

## 3. API

### 3.1 The parameter

`task` gains one optional field:

```ts
resume: Type.Optional(Type.String({
  description:
    "Child session id from a previous task result — continue that settled child with this prompt as its next instruction. Role, model, cwd and worktree are immutable on resume.",
})),
```

`childId` is the child session id issued at first dispatch (the id in
`launch.childId` / `header.id` / the SA-03 record's `childId` field). It is
the ONLY accepted identifier form: transcript paths, `"latest"`, and other
sentences are rejected by lookup (`not-found`) — managed lookup is the single
entry point.

### 3.2 Argument validation (before any side effect)

| Argument state | Result |
| --- | --- |
| `resume` present, empty/whitespace-only | rejection: `resume must be a child session id` |
| `resume` + `agent` | rejection: role is immutable; the child continues as its recorded role (drop `agent`) |
| `resume` + `worktree` (ANY value, including `false`) | rejection: the worktree decision is immutable; the rejection keys on PRESENCE (`args.worktree !== undefined`), never truthiness — `worktree: false` must not slip through as "not passed" |
| `resume` + `timeoutMs` | ALLOWED — the explicit new attempt's clock |
| `resume` + empty/whitespace-only `prompt` | rejection: a resume needs a non-empty instruction |
| `resume` with `IMP_CHILD_SESSIONS=0` (or `childSessions: false`) | rejection: child sessions are disabled |
| `resume` with no parent session (`getSession() === null`) | rejection: no parent session to resolve children against |

The `agent` rejection deliberately ignores whether the given agent EQUALS the
recorded one: immutable fields are not passed at all; the record is the only
authority. (Fresh-dispatch validation for `agent`/`worktree` is unchanged.)
A resume call counts against the five-call chunking exactly like any other
`task` call; five resumes of one child in one chunk serialize through §7 —
one runs, the others refuse.

### 3.3 ID disclosure (how the parent learns eligible ids)

When a child session is persisted, the task result's handoff block gains one
line (fresh and resume results alike):

```
child session id: <id> — continue it later with task({resume: "<id>", prompt: "…"})
```

This is a handle, not a promise: resumability is decided at resume time, so
the line states the coarse conditions in one clause — resumable only while
imp version, assembled system/agent/tool contract, provider and the recorded
cwd/worktree are unchanged (the SA-06 codes are the exact set). Refusals
print the reasons (§4.2); a `not-found` refusal additionally lists
this parent's child ids from `listChildLaunches(parent)` (id + status only;
no per-child validation, no fleet subsystem). The id is deliberately
model-visible (the parent model needs it to act) — not UI-only display
data, and not carried through `display`/record-only paths.

## 4. Resume pipeline

### 4.1 Order (each step's failure has no later side effects)

Inside `createTaskTool`'s `execute`, when `args.resume` is present, a
dedicated branch runs BEFORE agent/model/tools/worktree resolution (those
belong to fresh dispatch):

1. Argument validation (§3.2) → rejection.
2. `findChildByLaunch(parentStore, args.resume)` → passthrough refusal
   (`not-found` | `ambiguous` | `not-owned` | `outside` | `malformed` |
   `missing-launch` | `invalid-launch`) with §3.3 candidate list for
   `not-found`.
3. Environment assembly + provider-identity gate (§5) → refusal.
4. `validateChildContinuation(file, parentStore, current)` → refusal listing
   every reason `(code: message)`; AND `verdict.executionState === "settled"`
   → else refusal ("may still be running, or the process died before any
   parent-side write").
5. Lease acquisition (§7) → refusal (`busy` / `owned-elsewhere` /
   `io-error`). The attempt's try/finally opens the
   INSTANT acquire returns `{ok:true}` — every refusal or throw from step 6
   onward releases the lease in `finally` (a live lease leaked by a refusal
   path is a contract violation, not a recoverable nuisance).
6. Transcript repair (§6): 6.1 read-only pairing scan (may refuse
   `history-unpairable`); 6.2 truncate a torn final fragment; 6.3 repair the
   crash-tail orphan. Nothing before 6.2 mutates the child file.
7. Effective history: one `store.buildContext()` call →
   `{ messages, compactionBoundary }` (also used by 6.1; the lookup already
   ran SA-06's structural validation on this branch).
8. `runSubagent` (§8) with `initialHistory = messages`,
   `initialFloor = compactionBoundary`.
9. `finish()` with the attempt record (§9); `finally`: lease release.

`launched` in the record is `true` from the moment step 8 starts; refusal
records (steps 1–6) are `status: "rejected"` with no `childId` (nothing ran —
SA-03 shape discipline), while the refusal TEXT carries the attempted id.

### 4.2 Refusal surface (and what never happens)

Every refusal is a teaching error (`isError: true`) that lists what was found
and what to do. The default guidance line: "Start a new task instead —
independent review still requires a new fresh-context child."

Never, on any refusal path: a fresh child, the parent cwd, a different model,
a re-validated-by-guessing record, silent transcript replacement, or any
mutation of the child file. The only mutation points in the entire feature
are step 6.2 and 6.3 plus the normal appends of the new attempt.

### 4.3 Result composition (success-shaped resume)

`taskResult` base (identical status classification to fresh) plus, in order:

1. repair note when repairs happened: `transcript repaired: N interrupted
   tool call(s) closed with an explicit unknown-outcome result[, dropped a
   <n>-byte torn tail | terminated an unterminated final record].` The
   repair precedes the new instruction, so the
   CHILD model sees the unknown-outcome marker as settled history — never as
   a fresh error caused by its new prompt.
2. worktree retention line when the launch record has a worktree:
   `worktree kept at <path> (branch <branch>) — resume attempts do not
   remove it; merge <branch> when done.` When the child's LAST record shows
   `kept-work` or `removal-failed`, the line names that prior disposition
   too, so "deliberately kept" and "kept because the earlier assessment was
   uncertain or failed" are never conflated.
3. the files-changed caution: `files may have changed since the previous
   attempt — re-inspect before relying on earlier observations.`
4. the existing usage trailer `(child: …)` — THIS attempt only.
5. the lifetime line (§9.2).
6. the §3.3 id line.

All lines are short and bounded; CJK safety is inherited (no tail truncation
applies to these).

## 5. Environment assembly (SA-06 contract side, plus one SA-07 gate)

`CurrentChildEnvironment` (SA-06 §5.4 interface) is assembled from live
sources — the same ones a fresh dispatch would use now:

| Field | Source |
| --- | --- |
| `impVersion` | `options.getLaunchEnvironment().impVersion` (VERSION) |
| `systemText` | `getLaunchEnvironment().systemText` (current assembled system, L6-normalized by the verdict) |
| `cwd` | `options.cwd ?? process.cwd()` (consulted only when the record has no worktree) |
| `agentResolver` | `name → agentsByName.get(name) ? { system } : undefined` (the live roster) |
| `contextFiles` / `promptFiles` / `extensionContexts` / `extensions` | straight from `getLaunchEnvironment()` |
| `childTools` | the pool rebuilt for the RECORDED cwd and binding (below), `task` filtered out |
| `binding` | `file.launch.model` — the recorded binding (§5.2) |

If `getLaunchEnvironment()` is absent → refusal: the host wiring cannot
reconstruct launch facts (children created there would have no `launch`
block, so this is primarily a wiring-error surface).

Permissions are NOT reconstructed from the record (SA-06 §4.4): every tool
call of the resumed attempt flows through the parent's LIVE gate
(`options.onToolCall`) with `{ agent: launch.agent?.name, cwd: launch.cwd }`.
A call the current gate denies surfaces as the gate's normal denial (an
isError result the model sees) — the record never re-authorizes anything,
and a tool present in history is never silently re-executed (§6.1, T22).
The task-list bullet "missing/incompatible permissions fail before
model/tool execution" is therefore realized as: the live gate is the only
authority, consulted fresh for every call.

### 5.1 Tool pool reconstruction (ONE shared selection helper)

The fresh path's selection is factored into one helper
(`selectChildToolPool(agent, cwd, binding, sources)` in task.ts): rebuild
(`getToolsForChild(cwd, { providerName, modelId })` / `getToolsForCwd(cwd)` /
parent-pool fallback per the fresh rules) → apply the agent's `tools:`
allowlist narrowing (the existing `validateSubset`) → filter `task` out —
the `task` drop is CANONICAL for both paths (the pre-SA-07 worktree path did
not re-filter; no shipped wiring ever puts `task` in a rebuilt pool; the
helper makes the rule explicit so the executed pool and the recorded
contract stay one projection — implementation review track 2, F1).
Fresh dispatch and resume MUST both call it: rebuilding without the agent
allowlist is a false `tools-drift` for every allowlisted agent, because the
launch record stores the NARROWED array (`task.ts:353–364, 411, 431, 457`)
and SA-06 check 10 compares exact set equality.

Rooted at the recorded cwd; exact call shape (mirrors `task.ts:397–401`),
passing the FIELDS rather than the binding object:
`getToolsForChild(launch.cwd, { providerName: launch.model.providerName,
modelId: launch.model.wireModelId })`.

- worktree child (`launch.worktree !== undefined`): no parent-pool fallback;
  `undefined` from both rebuilders → refusal ("per-directory tool pool
  unavailable — cannot reconstruct the child's tool contract; retry from a
  host that wires it").
- shared-cwd child: the fresh path's parent-pool fallback applies.

The result feeds BOTH the `tools-drift` comparison (SA-06 check 10) and the
execution pool; after a passing verdict the tool contract is provably
identical to launch, and the attempt records the executed pool.

### 5.2 Model immutability and the provider-identity gate

The child continues on the RECORDED binding (`launch.model`) — resume never
re-resolves from the parent's current model (role/model are immutable). The
verdict's `current.binding` is therefore the recorded binding, and SA-06
check 11 is satisfied by construction. The genuinely live fact is the WIRE
ENDPOINT: the provider instance the attempt would run on.

SA-07's own gate: `options.getProvider().name` must equal
`launch.model.providerName` (both are the `ProviderName` vocabulary —
verified: `anthropic`, `openai`, `openai-codex`, `zai`, `deepseek`,
`moonshotai`, `moonshotai-cn`). Mismatch (e.g. the user switched providers
between attempts) → refusal:

`the child ran on <recorded>; the current provider is <live> — resuming
would send this transcript to a different endpoint. Switch back or start a
fresh task.`

Rationale recorded for the reviewer: model CHOICE is frozen history (run on
the recorded binding); endpoint IDENTITY is live environment (must match, or
refuse). These are different questions; the verdict's check 11 answers the
former by construction.

## 6. Transcript repair (continuation boundary only)

Two independent hazards, both repair-only at this boundary; ordinary history
reads keep their lenient rules (SA-06 discipline).

### 6.1 Tool-pairing scan (read-only first)

Scan the effective history's messages: collect required toolCall ids from
assistant messages (`blocks[].type === "toolCall"`) and observed result ids
(`toolResult` messages' `results[].toolCallId`). Let `M` be the missing set.

- `M` empty → nothing to do.
- `M` non-empty → repairable ONLY in the crash-tail shape: all ids in `M`
  belong to the LAST assistant message `A`, and every message after `A` is a
  `toolResult` message (`A` is final in the realistic crash case; a partial
  `toolResult` message may follow it when some results were recorded).
  Anything else → refusal `history-unpairable` ("the transcript is
  inconsistent beyond a crash tail (tool call <id> has no result and is not
  the last assistant turn) — start a new task").
- Compaction sanity: `findCutIndex` snaps the retained tail to a
  user/assistant head (`compaction.ts:212–235`), so a compaction checkpoint
  never starts mid-pair; a mid-history orphan therefore means real damage,
  which is refused rather than guessed about.

### 6.2 Torn final line (structural detection; make append-safe before any append)

The hazard has TWO shapes, and only one was visible to parse-failure
detection:

- a) an UNPARSEABLE fragment (invalid JSON): `open` drops it in memory
  (stderr note), the bytes stay — `appendFileSync` concatenates the next
  entry onto it and the following reopen loses both;
- b) a COMPLETE JSON entry whose trailing newline never landed: it parses
  fine and `open` KEEPS it (existing read semantics), so parse-failure
  detection never fires — and appending after it merges both into one
  unparseable line: both entries gone on the next reopen (reproduced against
  the real store during design review).

Detection is STRUCTURAL and must mirror `open()`'s ACTUAL outcome, not a
parse guess (acceptance round 2, findings 1–2):

- the flag is set when the bytes do not end in `\n` (an append would merge
  into the fragment) OR when `open()` DROPPED a final line for any reason
  (unparseable JSON, invalid entry, invalid model marker) — a dropped line
  is invisible to a byte scan, and an append would bury it as fatal
  interior corruption;
- the repair works in BYTE SPACE on the file Buffer: line boundaries are
  0x0a byte offsets and `truncateSync` receives byte lengths. String offsets
  are UTF-16 code-unit positions — using them as byte lengths silently eats
  the tail of complete multi-byte records (finding 1);
- "is this final line a record open() kept?" is answered by
  `acceptsAsSessionLine()` (position / session_model with a valid payload /
  valid entry — the same parsers open() uses), never by plain JSON.parse
  (finding 2).

Repair is SHAPE-DEPENDENT — truncating both shapes would be wrong:

- an unacceptable final line (what open() dropped, or would drop) →
  TRUNCATE everything from that line's byte start;
- an acceptable final record missing only its newline → TERMINATE (append
  `"\n"`); truncating it would delete a recorded entry AND desync the
  in-memory leaf (a later append would chain to an id whose bytes no longer
  exist — broken parent chain on the following reopen).

API:

- `SessionStore` gains `tornFinalLine: boolean` (set by `open`, the
  `persisted`/`savedModel` pattern) and `repairTornFinalLine(): { action:
  "truncated" | "terminated"; bytes: number } | undefined` — byte offsets
  throughout; clears the flag; `undefined` when the flag is unset, the store
  is not persisted, or nothing needed repair (idempotent).
- Ordering rule (pinned): the repair runs BEFORE any append to the child
  file, only after steps 1–6.1 passed.
- Refusing instead of repairing was rejected deliberately: this is exactly
  the crash-mid-append state that most needs continuation, and the repair
  preserves every byte open() accepted. The action is reported in the result
  (§4.3 item 1).

### 6.3 Crash-tail repair (persisted, honest)

The missing results in the `M`/`A` shape are appended (via
`store.appendMessage`), one result per missing id in `A`'s block order. When
a partial `toolResult` message already follows `A`, the missing results are
merged into a continuation message appended after it — all three adapters
emit one wire message per `toolResult` message either way
(anthropic.ts:75, openai-completions.ts:138, codex-responses.ts:124), and
appending (never editing the existing partial message) keeps append-only
semantics while matching the loop's at-most-one-per-turn shape; otherwise a
single `toolResult` message is appended.

```ts
{ toolCallId, toolName /* from the call block */, isError: true,
  content: "[imp] this tool call was interrupted before a result was recorded — the outcome is unknown; it may have partially executed. Re-inspect or re-run it before relying on its effects." }
```

Decisions (rationale for review):

- PERSISTED, not context-only: the transcript becomes self-consistent
  permanently (no re-derivation on chained resumes, no rule drift; the
  parent reading the transcript sees the honest gap marker). It is new
  history appended after the recorded entries — "persist new history without
  rewriting old entries" is honored (nothing already on disk changes).
- The text never claims completion; `isError: true`; the `[imp]` marker
  distinguishes synthetic provenance.
- Expected real shapes: abort/ctrl-C mid-tools (assistant message recorded,
  results never appended), crash between appends, and the torn-tail case of
  6.2 (after truncation the results are missing → same repair).
- The repair runs as step 6.3, BEFORE the new instruction is pushed (step
  8): the resumed model sees the marker as settled history, never as a
  fresh error caused by its new prompt.

### 6.4 Effective history

One `buildContext()` call provides `messages` (summary message + retained
tail, or the full branch when never compacted) and `compactionBoundary`. The
result is the continuation's initial history — never a replay of raw JSONL
entries (task-list requirement; SA-06 handoff: "reuses the already-opened
store").

## 7. Single-writer lease (intent + verify)

### 7.0 Why the single-file protocol was replaced (owner review, round 3)

The v1 protocol kept the lease in ONE shared path and reclaimed stale leases
by moving/replacing that path. On POSIX there is no compare-and-swap; the
owner demonstrated with three synchronized processes that ANY
move-away-then-recreate reclaim opens a pausable "vacuum" interval during
which a third process's `wx` create succeeds — leaving two live holders
whose qualification cannot be revoked (the mover's own refusal and the
late heartbeat notice are both after the fact). The owner's requirements:
no third-party acquisition window during reclaim; exclusion must not rest
on post-hoc heartbeat discovery; a deterministic three-process regression,
then an independent design review before implementation.

Alternatives considered and rejected (recorded for the review):

- rename-over replacement (never vacate the path): the path is never empty,
  but a stealer acting on a stale read can still atomically REPLACE a fresh
  live lease; the victim learns only from its next heartbeat — precisely
  the post-hoc detection the owner rejected. No CAS exists to make the
  replace conditional.
- a recovery mutex guarding steals: the mutex file needs its own staleness
  rule, the same class of race recurs one level down, and acquirers'
  create path is still outside the mutex.
- OS advisory locks (flock): no Node binding in this codebase's
  dependency set; not an option (and would diverge across platforms).

The chosen protocol removes the shared mutable path entirely: no rename, no
replace, and no unlink of another process's claim is ever needed to
acquire, so the vacuum class of race cannot exist.

### 7.1 Artifact

A DIRECTORY `<childFilePath>.lease/` beside the child session file,
containing one file per acquisition attempt:

    lease-<pid>-<nonce8>-<attemptId>

Content (one JSON line): `{ "pid": <number>, "host": "<os.hostname()>",
"machineId": "<uuid>", "nonce": "<uuid>", "attemptId": "<uuid>",
"startedAt": "<ISO>" }`. Names are unique by construction, so candidate
files never contend on a path. `nonce` is a per-process instance id
(module-load UUID): a same-pid candidate with a different nonce is a
DIFFERENT instance (sibling pid namespace or a recycled pid) and is never
treated as this process's own.

A legacy single-FILE artifact `<childFilePath>.lease` (created by earlier
commits of this unreleased branch) is migrated ON ENCOUNTER, with the same
single-read discipline the round-2 review demanded (design review B3):

- read the file ONCE; classify from THAT read only;
- live or uncertain owner (alive in this namespace, or mtime within the
  grace window, or unparseable and fresh) → refuse `busy`; NO directory is
  created, nothing is unlinked;
- dead+aged or unparseable+aged: unlink THAT artifact (deleting an aged
  dead claim cannot revoke a live holder — the same rule as candidate
  cleanup), then `mkdirSync` and continue. A write landing between the
  deciding read and the unlink is out of scope for an AGED DEAD artifact:
  the unlink can only destroy bytes the deciding read proved stale; a live
  process re-creating a legacy file is impossible (only this code writes
  them, and only under the old protocol).

### 7.2 Protocol (pinned)

In-process registry: `Map<childFilePath, attemptId>` — checked and set
SYNCHRONOUSLY (no await between), so same-process concurrency cannot slip
through even if the directory is mangled.

Acquire (`acquireChildLease(childFilePath, attemptId, opts?)`):

1. Map hit → refuse `busy` ("already running in this process").
2. Map miss → set the entry; all refusal paths delete it.
3. Resolve the machine id (publish-once; §7.4).
4. Migrate a legacy single-FILE artifact first (§7.1): `mkdirSync` on a
   path occupied by a file FAILS (`EEXIST` on every Node version in the CI
   matrix), so the file must be classified and, only when the SAME READ
   says it is dead+aged or unparseable debris, unlinked — a live or
   uncertain legacy owner refuses `busy` and creates NO directory. Then
   `mkdirSync(leaseDir, { recursive: true })`.
5. CREATE own candidate: `writeFileSync(dir + "/" + ownName, payload,
   { flag: "wx" })` — unique name, so this can only fail on real IO errors
   (refuse `io-error`).
6. VERIFY by scan (the load-bearing step): readdir the lease directory and
   inspect every OTHER entry:
   - unparseable content → UNKNOWN while its mtime is within the grace
     window (a torn claim is not proof of absence), else stale debris;
   - `host`/`machineId` differs → refuse `owned-elsewhere` (shared-storage
     across machines is unsupported);
   - parse == own name (impossible by uniqueness) → ignore;
   - owner `pid` alive in MY namespace (injectable; `process.kill(pid, 0)`,
     EPERM = alive) OR mtime within the grace window (`staleGraceMs`,
     default 60s) → ANOTHER ACTIVE OR UNCERTAIN CANDIDATE → **refuse
     `busy`** naming (pid, host, startedAt);
   - owner dead in my namespace AND mtime older than the grace → STALE:
     unlink it opportunistically (cleanup only — this grants nothing) and
     ignore.
7. No other active/uncertain candidate → HOLD. The heartbeat then touches
   OWN candidate mtime every 20s (`utimesSync`, unref'd interval) and
   re-reads it: missing or foreign content → **lease anomaly** (stderr note
   + abort the attempt's AbortController). This is defense in depth only;
   exclusion does NOT depend on heartbeat timing (§7.3).
8. Refusal paths unlink OWN candidate before returning; `release()` unlinks
   OWN candidate (unique name — no foreign-content checks needed) in
   `finally`.

PINNED INVARIANT (load-bearing for §7.3, design review A1): the own
candidate is NEVER unlinked between step 5 and the completion of step 6's
scan-and-decide; the only pre-HOLD unlink is the step-8 refusal cleanup,
which happens after the decision is final. An implementation that cleans up
its candidate early (or lets a crash between 5 and 6 look like a "held"
claim) breaks the exclusion argument; T30b(iv) instruments unlink calls to
pin this.

Bounded fairness: when two acquirers create candidates in the same window,
each may see the other and both refuse. Acquire retries up to 3 rounds with
5–25ms jitter before returning `busy`; the caller surfaces the refusal.

### 7.3 Mutual exclusion (argument, no heartbeat assumption)

Claim: at most one acquire can return `{ ok: true }`.

Let A and B both return ok. A proceeds only after creating C_A and then
scanning; B likewise with C_B. Assume A created first (time t_A). B's scan
happens after its own create, i.e. at s_B > t_B.

- If s_B > t_A: C_A existed when B's scan ran (A never unlinks its own
  candidate while holding), so B's scan saw a fresh, hence at least
  UNCERTAIN, candidate → B refuses. Contradiction.
- If s_B < t_A: then t_A < s_A (A scans after creating) and t_B < s_B <
  t_A < s_A, so B's candidate existed when A's scan ran → A refuses.
  Contradiction.

The only assumptions are: a scan sees every candidate that was created in
the same directory before the scan started (local-filesystem semantics;
NFS-style delayed visibility is an unsupported scenario, §14), and a
proceeding holder never unlinks its own candidate. The heartbeat is not
part of this argument.

Multi-acquire extension (implementation review, finding 1): the single-pair
proof plus three lifetime facts establishes the stronger SEQUENCE claim —
no ordering of creates, refusal cleanups and stale retirements admits a
second holder:

- a proceeding holder's candidate exists from before its scan until its
  release (the pinned invariant) and its owner executes throughout;
- the only unlinks are refusal cleanup (that process does NOT proceed),
  release (that process finished executing) and stale retirement (owner
  dead in this namespace and older than the grace);
- therefore, while any holder executes, its visible fresh candidate blocks
  every later acquirer's scan; a scan that sees no blocker can only mean
  every other candidate belongs to finished or refused attempts.

T30b(i) exercises the sequence directly: B refuses and cleans up, a third
acquirer D joins and is STILL refused (A's candidate remained visible), and
only then does A proceed — exactly one holder.

Owner's round-3 repro maps to: A cannot "move a live lease away" (nothing
is ever moved); a third process's create is never enough by itself (it must
also pass step 6's scan, which sees the live holder). Stale cleanup unlinks
only dead+aged candidates, never a live one.

### 7.4 Machine id: publish-once (owner finding, round 3)

`<childrenDir>/.imp-machine-id` must be immutable once a valid id SEES USE
(leases reference it). Rules:

- existing `valid` id → adopted as-is; **no path ever overwrites a valid
  id**;
- ABSENT → publish with `writeFileSync(tmp, id)` + `linkSync(tmp, file)`
  (atomic no-clobber create). Exactly one publisher wins; every loser gets
  `EEXIST`, re-reads, and adopts the winner's id. A late publisher can
  therefore never replace an id a live lease already uses;
- EMPTY (legacy crash artifact; IMPOSSIBLE to produce with the new
  publication path — the file only appears complete via link) → **refuse
  `io-error` with an actionable message**: "the machine id file is empty
  (interrupted initialization under an earlier build); delete <path> to
  reinitialize". Rationale (design review C1): concurrent EMPTY recovery
  cannot be made non-clobbering without CAS — two recoverers that each
  "replace-if-empty" can both return DIFFERENT ids, which is exactly the
  owner's round-3 finding reproduced on the empty branch, and every
  tombstone/link variant leaves a blind-unlink or blind-restore window.
  A deterministic refusal that never touches the file is the safe rule;
  the manual one-command recovery is the defined recovery procedure. The
  claim-file alternative was assessed and rejected (its own stale-takeover
  race recurses one level down);
- allocation is retried (≤5 rounds) on transient ENOENT/EEXIST races; a
  permanent failure refuses `io-error`.

### 7.5 Residual limits (recorded, not hidden)

- Local-filesystem assumption: directory-scan visibility under NFS-style
  caching is not guaranteed; shared-storage deployments across machines are
  refused via `owned-elsewhere` when observed, and same-machine containers
  sharing a directory are safe (same visibility domain).
- A candidate whose owner died within the grace window keeps acquirers
  `busy` until the window passes (crash recovery latency ≤ ~60s), the price
  of not trusting a dead-looking pid across pid namespaces.
- Crashed or tampered candidates linger until a later scan ages them out;
  they are never read as leases and grant nothing.
- Heartbeat anomaly handling aborts the attempt as defense in depth; it is
  not required for correctness (T28 asserts the abort, never an exclusion
  guarantee; a scan/seam test proves exclusion with the heartbeat disabled).
- A live-but-stalled holder whose event loop is blocked for longer than the
  grace window can be retired as stale on the same machine (its pid looks
  dead only if recycled; cross-namespace holders rely on the mtime). The
  heartbeat interval (20s) makes this require a >60s synchronous stall; it
  is recorded rather than fixed (the alternative — never retiring — breaks
  crash recovery).
- Machine-id tmp debris (`.imp-machine-id.tmp-*`) from crashed publishers
  is inert and never read as an id; no sweeper may ever unlink the id file
  itself or match it as debris (pinned invariant for any future cleanup).
- Fairness: two acquirers creating in the same window may both refuse; the
  bounded jittered retries (≤3 rounds) plus caller-level retry resolve it.
  Sustained contention surfaces `busy` — a liveness cost, never a safety
  cost.
- Cross-machine `machineId` semantics: the id is per DIRECTORY; a directory
  shared across machines is refused on first contact (`owned-elsewhere`).

## 8. Execution

`runSubagent` gains two options (both default-undefined; fresh dispatch
byte-identical):

```ts
/** Resumed children: the effective history to seed the live context with
 *  (summary + retained tail). The new instruction is pushed once by the
 *  loop as usual and persisted via onMessage. */
initialHistory?: AgentMessage[];
/** Estimate floor for the seeded history (store compactionBoundary) —
 *  mirrors the post-splice floor set by child compaction. */
initialFloor?: number;
```

`const history = options.initialHistory ? [...options.initialHistory] : [];`
and `let childFloor = options.initialFloor ?? 0;`. Everything else —
`launchLoop(prompt)` pushing the single new user message and persisting it
via `onMessage` (loop.ts:130–147), the overflow-recovery relaunch with
`userMessage: undefined`, auto-compaction mirroring, the attempt ledger —
is unchanged and therefore shared with fresh dispatch.

Estimator note: `estimateContextTokens(history, initialFloor)` uses the
floor only to bound the usage-anchor search; on a seeded compacted history
the FIRST boundary can therefore sum from index 0 (an over-estimate) when no
assistant with usage sits at/after the floor. The consequence is at worst a
premature no-op compaction attempt (`findCutIndex → 0 → null`), recorded
here rather than fixed.

Pinned behavior on resume:

- Turn budget: fresh `runAgentLoop` → `CHILD_MAX_TURNS` (60) for the new
  attempt (task list: "reset the execution allowance"; no auto-resume loop
  — the call is manual, nothing re-invokes it).
- Timeout precedence: `args.timeoutMs` > the recorded agent's frontmatter
  `timeoutMs` (the body is hash-verified by validation) > mode default
  (`defaultChildTimeoutMs`). autoCompact/settings resolve per attempt
  exactly like fresh dispatch (SA-06 §"SA-07 resets policy per attempt").
- Persistence: the child store is the SAME file (no `createChildSession`);
  `observeSessionWrites` is wired so `transcriptWriteFailed` keeps its SA-03
  meaning. The first new entry's `parentId` is the current leaf (the crash
  repair of §6.3 when present, else the settled leaf).
- Role body: the recorded agent's CURRENT body (hash-verified equal by the
  verdict) is resolved from the live roster and passed as `extraSystem` —
  exactly like fresh dispatch. Resuming without it would silently drop the
  agent profile, a role downgrade the verdict was supposed to prevent.
- Pricing identity (SA-05 integration): the resumed call passes
  `modelReference: launch.model.reference` — the recorded QUALIFIED
  reference (fresh dispatch stamps the binding reference at task.ts:493).
  The resumed attempt's usage is therefore priced at the recorded identity,
  never the parent's current model.
- Result text is attempt-scoped like usage (acceptance round 2, finding 3):
  seeded messages are tracked by identity and excluded from the final-text
  scan, so an immediately-failed or silent resumed attempt can never report
  the previous attempt's answer as its partial result; message identities
  survive a mid-attempt compaction splice (T31/T32).
- Permissions: the LIVE gate (`options.onToolCall`) with
  `{ agent: launch.agent?.name, cwd: launch.cwd }` — never the record (§4.4
  of the SA-06 design). Events: same `onEvent` wiring with a fresh
  `sourceId` and the current `taskToolCallId`.
- Abort wiring: the resume branch wraps the parent signal in an attempt
  `AbortController` (relay listener removed in `finally`); the lease
  heartbeat can abort it on a lease anomaly (§7.2), and the result then
  names that reason ("attempt stopped: its lease was taken over").
- Signals: the parent signal, forwarded as-is; timeout/abort classification
  is `runSubagent`'s existing logic (unchanged).
- Worktree: the attempt runs at `launch.cwd` (validated by the SA-06 probe);
  resume NEVER auto-removes the worktree/branch (it was deliberately kept by
  a previous attempt and is now user-owned). The result says so (§4.3 item
  2); the record's `worktree.disposition` is `kept-unknown` with detail
  `"resume attempt — worktrees are never auto-removed on resume"` (the
  enum is SA-03-frozen; the detail disambiguates).
- Shared-cwd children: run at `launch.cwd` (the `cwd-drift` check proved it
  equals the current parent cwd).

## 9. Accounting and reporting

### 9.1 The attempt record (SA-03 shape, unchanged)

One new record per resume attempt: NEW `attemptId`/`sourceId`, the call's
`taskToolCallId`, the SAME `childId` (logical identity preserved), `agent`,
`binding: launch.model`, `cwd: launch.cwd`, `tools` (executed pool),
`timeoutMs` (effective), terminal facts from the outcome (identical
classification), `transcript` (same file), `worktree` (§8). No field is
added to `TaskRecord` (frozen contract).

### 9.2 Attempt vs lifetime usage

- Attempt usage: the SA-04 attempt ledger is created per `runSubagent`
  invocation — the resumed attempt's trailer counts ONLY this attempt's
  reports. Historical usage living in the seeded history can never leak in
  (the ledger counts at production; nothing recomputes from history — the
  exact property SA-04 built).
- Lifetime line (resume results only):
  `(child lifetime: N attempts, ≥ X in / Y out[ / Z cache])` — N/usage
  summed from the parent's SA-03 records for this `childId` (records only,
  never the transcript) plus this attempt. `≥` appears when any summed
  usage carries `incomplete: true` OR when a launched record has no usage
  field at all — silent skipping would understate N without a marker, and
  absence is "unknown", never zero (SA-05 vocabulary). N counts settled
  records seen plus this attempt; if this attempt's record never lands
  (crash between composition and persistence), the next resume repeats
  N+1 — conservative, recorded.

### 9.3 The fresh-path disclosure line

§3.3 — one additive line in `taskResult`'s handoff block when the child
transcript is persisted. Existing output tests that pin handoff text are
updated; no other fresh-path behavior changes.

## 10. Failure and cancellation semantics

- All refusal paths: `status: "rejected"`, `launched: false`, no childId, no
  mutation, no lease taken (or released before returning).
- Abort/timeout/crash mid-attempt: identical to fresh (`taskResult`
  classification, handoff block, partial-text rules); the lease releases in
  `finally`; the child file keeps whatever was honestly appended.
- Parent cancellation: the child store may hold a crash-tail orphan after an
  abort — the NEXT resume repairs it (§6). Nothing at abort time mutates.
- A crashed imp process leaves the lease file; the next resume steals it via
  the dead-pid rule (§7.2). A failed release in a live process is reclaimed
  by the `pid === process.pid` rule.
- Two concurrent resumes of one child: at most one proceeds (Map or lease);
  the other refuses. Unrelated children and fresh tasks keep normal
  concurrency (the five-call chunking is untouched) — five resumes of ONE
  child in one chunk serialize through §7: one runs, the others refuse
  (no queueing).
- Restoring the same parent session in multiple processes is SUPPORTED
  ownership (the task-list asks for an explicit statement): both copies
  resolve the same children (SA-06's lookup keys on the parent session id),
  and the file lease is the single-writer arbiter — the loser refuses.

## 11. Interfaces (pinned for review)

```ts
// src/core/child-lease.ts (new)
export interface ChildLeaseHandle {
  readonly path: string; readonly attemptId: string;
  release(): void; startHeartbeat(onAnomaly: () => void): void;
}
export type ChildLeaseResult =
  | { ok: true; lease: ChildLeaseHandle }
  | { ok: false; code: "busy" | "owned-elsewhere" | "io-error"; message: string };
// "stale-contended" is retired with the single-file protocol: intent+verify
// has no steal step, so no such outcome exists (design review D1).
export interface ChildLeaseOptions {
  pid?: number; host?: string; machineId?: string; nonce?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  // test seams: deterministic interleavings for the multiprocess regressions
  onAfterCreate?: () => void;
  onBeforeScan?: () => void;
  onBeforeMachineIdPublish?: () => void;
  staleGraceMs?: number;   // default 60_000
  heartbeatMs?: number;    // default 20_000
}
export function acquireChildLease(childFilePath: string, attemptId: string, options?: ChildLeaseOptions): ChildLeaseResult;

// src/core/child-resume.ts (new) — pure helpers; orchestration stays in task.ts
export type ResumeArgCheck = { ok: true; childId: string } | { ok: false; message: string };
export function checkResumeArgs(args: { resume: unknown; agent: unknown; worktree: unknown; prompt: unknown; childSessions: boolean; hasParentSession: boolean }): ResumeArgCheck;
export function assembleCurrentChildEnvironment(sources: {
  launch: ChildLaunchRecord;
  launchEnvironment: LaunchEnvironmentFacts;
  cwd: string;
  agentResolver: (name: string) => { system: string } | undefined;
  childTools: ReadonlyArray<{ name: string; mcpServer?: string }>;
}): CurrentChildEnvironment;
export function providerMismatch(recorded: string, live: string): string | undefined; // refusal text or undefined
export function lifetimeUsageLine(records: readonly TaskRecord[], current: Usage | undefined): string;

// src/core/session/store.ts (changed)
tornFinalLine: boolean;   // set by open(); structural: no trailing newline
repairTornFinalLine(): { action: "truncated" | "terminated"; bytes: number } | undefined;

// src/core/subagent.ts (changed)
initialHistory?: AgentMessage[];
initialFloor?: number;

// src/core/tools/task.ts (changed)
resume schema field; resume branch; taskResult handoff id line; shared
selectChildToolPool helper (fresh + resume); attempt AbortController +
lease heartbeat wiring.
```

## 12. Acceptance mapping (task-list SA-07 bullets)

| Acceptance bullet | Design | Planned tests |
| --- | --- | --- |
| Fresh dispatch unchanged; continuation gets old effective context + exactly one new instruction | §3.3, §8 | T1–T3, T14 |
| Compressed child resumes from summary + retained tail | §6.4 | T13 |
| Completed/capped/aborted/timed-out/crashed continuable only when state+ownership permit | §4.1 steps 2–5, §10 | T4, T4b, T5, T8, T23 |
| Tool pairing valid; side effects not auto-repeated | §6.1–6.3 | T14–T17, T16b, T22 |
| Missing/incompatible role/model/tools/worktree/permissions fail before execution | §5, §7 | T6, T6b, T7, T9–T12 |
| Two concurrent resumes → one writer; unrelated children concurrent | §7 | T18–T21, T24, T28 |
| Parent restart, stale ownership, interrupted persistence recovery | §7.2–7.3, §10 | T19, T20, T25; parent restart = same-parent multi-process restore (supported — §10); the SA-06 partial-launch-write-failure cases are inherited from its suite, not re-tested here |
| New history extends transcript; linkage correct; attempt usage excludes historical calls | §6.3, §9 | T13, T14, T26, T27 |
| Cancellation/timeout/cap/task activity/CJK/cleanup safety preserved | §8, §10 | T23, T27, regression suites |

## 13. Test plan (red evidence first)

New `test/child-lease.test.ts` (clock/pid/host/liveness/seams injectable),
round-3 protocol: T18 in-process double acquire; T19 active/uncertain
candidate rules — live pid refuses, dead pid with fresh mtime refuses with
the recovery hint, dead pid beyond grace is cleaned opportunistically and
acquisition proceeds, same-pid different-nonce refuses; T20
`owned-elsewhere` (host/machineId mismatch); T25 release/refusal unlink the
OWN candidate only, never others; T28 heartbeat touches keep the candidate
mtime fresh and a missing/foreign own candidate aborts via its signal;
T29 production machine-id init; T33a–e machine-id stability: (a) an
established id is never rewritten; (b) two concurrent ABSENT publishers
converge on one id via link (deterministic seam); (c) a late publisher
observing a VALID id adopts it — the owner's repro end-to-end (publish +
acquire + exit + aged reclaim without `owned-elsewhere`); (d) an EMPTY file
refuses `io-error` with the guidance and NEVER touches the file, and after
the file is deleted acquisition works; (e) a lease referencing an id
remains stable while another process initializes concurrently (the
stability requirement: the lease's id still equals the file's id).
T30 the REAL two-process hammer test (candidate semantics, refusal counts
asserted); T30b the DETERMINISTIC three-process regression: (i) A creates
and pauses before scanning while B creates and scans → B refuses; a third
acquirer D joins after B's cleanup and is STILL refused (A's candidate
visible); A then proceeds — exactly one holder, pinning the multi-acquire
sequence claim; (ii) A pauses before scanning a stale candidate, B
creates+scans+proceeds, A resumes and refuses; (iii) B and C create
simultaneously against a stale candidate → both refuse or exactly one
proceeds, and the stale candidate was cleaned without granting anything;
(iv) instrumentation proves neither A's nor B's candidate was unlinked
between its create and its scan decision (the A1 invariant). Add: a
legacy-file migration test (live legacy owner → `busy` and NO directory
created; dead+aged → exactly the deciding read's artifact is unlinked; a
seam-injected write between the deciding read and the unlink proves no live
claim can be destroyed); a fairness/liveness assertion (under sustained
contention: never two holders, and a lone acquirer eventually wins within
the retry budget); and an exclusion test with the heartbeat disabled
(showing exclusion does not depend on it).

New `test/child-resume.test.ts` (fake provider harness like
`test/task-tool.test.ts`):

- T1 argument matrix (§3.2) — each rejection text asserted.
- T2 unknown id → refusal + candidate list; malformed/missing-launch
  passthrough (crafted raw child files).
- T3 happy path: one new instruction; model-visible request = effective
  history + exactly one new user message; result contains the id line.
- T4 no settled record → refusal ("may still be running…").
- T4b per-status continuation: aborted, timed-out and crashed attempts each
  settle with a record and CAN be continued (status parity asserted).
- T5 rejected-record-only child → refusal.
- T6 role drift / missing agent → refusal (agent body edited after launch).
- T6b permissions stay live: the gate denies a previously-allowed tool for
  the resumed attempt → the gate's normal denial surfaces; nothing is
  re-authorized from the record and the denied call does not run.
- T7 system drift → refusal.
- T8 version drift → refusal (VERSION seam).
- T9 provider mismatch gate (record says anthropic, live provider fake
  named zai) → refusal text.
- T10 tools drift (registry changed) → refusal; T11 cwd-missing/drift.
- T12 worktree replaced (probe) → refusal (SA-06 probe is unit-tested;
  this is the resume wiring pin).
- T13 compacted child: effective history = summary + retained tail (assert
  the request's first message is the summary message, not the original
  prompt), one new instruction appended.
- T14 crash-tail orphan: synthetic result persisted BEFORE the new user
  message (file order asserted byte-level: parentId chain, marker text,
  isError), request contains the paired sequence.
- T15 both torn shapes: the invalid-JSON fragment is TRUNCATED at the last
  newline; the complete-entry-without-newline is TERMINATED (newline
  appended, entry kept); after the attempt the file reopens with every entry
  intact; result reports the repair action.
- T16 non-tail orphan → refusal; T17 mid-history mismatch refuses even when
  the tail is clean.
- T16b compacted transcript with a retained-tail orphan (beyond a crash
  tail) → history-unpairable refusal.
- T22 side-effect non-repetition: a tool that would run is NOT invoked
  during resume for calls recorded in history (fake tool with call counter;
  history contains an earlier result → zero invocations before the model's
  new turn).
- T23 statuses: capped child resumes with a fresh 60-turn budget (seam
  count), timeout/abort classification parity.
- T24 two concurrent resumes in one turn (same child) → one refuses; two
  different children resume concurrently.
- T26 record assertions: same childId, new attemptId, cwd/binding/agent from
  the record, worktree disposition kept-unknown + detail.
- T26b prior-disposition threading: the last record kept-work/
  removal-failed → the worktree line names it (never conflated with
  "deliberately kept").
- T27 usage split: history carries large usage; fake provider reports a
  small report → attempt trailer shows only the new numbers; lifetime line
  sums records (≥ marker when a previous record is incomplete).
- T27b the resumed attempt passes the recorded qualified `modelReference`
  (usage priced at the recorded identity, not the parent's current model).
- T27c a launched record with no usage field sets the `≥` marker (absence
  is unknown, never a silent skip).

Store unit tests (`test/session-store` beside existing ones): torn-flag set
on open; repair truncates exactly; `undefined` when clean.

Subagent unit tests: `initialHistory` seeds history and floor without
touching fresh dispatch; fresh dispatch byte-identical (existing suite).

Acceptance round 2 regressions (findings 1–6): R2e byte-accurate repair
(CJK/emoji prefix byte-identical), R2f invalid final line WITH a trailing
newline, R2g session_model line missing its payload; T19d a same-pid
unidentified instance is refused; T29 production machine-id init + the
empty-file repair; T30 the REAL two-process mutual-exclusion test (spawned
vitest workers, S/E markers analyzed for interleaving); T31 resumed-attempt
text isolation (immediate failure + silent completion); T32 mid-attempt
compaction cannot resurrect the seeded answer (unit).

Regression updates: `test/task-tool.test.ts` handoff-text pins learn the
§3.3 line (mechanical, no expectation weakening).

## 14. Known limits / deferred

- Lease residual race (§7.3) — same-machine via machineId, cross-machine
  refused; detection + heartbeat-abort backstop; stale steal waits out the
  grace window after a crash.
- Wire-model catalog gap: `launch.model.wireModelId` is not re-validated
  against the live model catalog — a deprecated model id surfaces as a
  provider error during the attempt, not a refusal (the provider gate
  covers endpoint identity, not the catalog).
- A settled transcript with a crash-tail orphan is repaired on the NEXT
  resume, not at abort time.
- Resuming a compacted child can trigger a NEW summarizer call whose cost
  lands on the attempt's ledger (asserted in T13/T27, not hidden).
- No cross-host resume; no cross-version resume (SA-06 is the authority).
- Resume does not re-verify side effects happened: it preserves the RECORDED
  truth and marks interrupted calls unknown — it never claims completion.
- Files/worktree contents can change between attempts (by design); the
  result says so. Validation is a check, not a lock (TOCTOU recorded).
- No worktree recreation and no fallback: a removed worktree is a refusal.
- Inherited SA-06 limits (extension transitive imports, MCP same-name
  behavior, L6 conservatism) are unchanged.
- A child created before SA-06 (no launch block) is not resumable.
- `listChildLaunches` diagnostics are status-only; deep validation happens
  per-resume, not per-listing.

## 15. Files and ownership

New: `src/core/child-lease.ts`, `src/core/child-resume.ts`,
`docs/sa-07-child-resume-design.md`, `test/child-lease.test.ts`,
`test/child-resume.test.ts`.

Changed: `src/core/tools/task.ts` (schema, resume branch, taskResult line),
`src/core/session/store.ts` (torn-tail fact + repair), `src/core/subagent.ts`
(initialHistory/initialFloor), `test/task-tool.test.ts` (regression pins),
plus store/subagent unit-test files.

Untouched by design: SA-01 cleanup logic, SA-02 resolution logic, SA-03
record shape, SA-04 ledger, SA-05 pricing, SA-06 lookup/validation semantics.

## 16. Review log

Two-track adversarial review (fresh context, read-only, HEAD 8d9534a):
both tracks returned APPROVE WITH CORRECTIONS; all findings folded above.

- Track A (mechanics): B1 torn-tail detection must be STRUCTURAL (a
  complete entry without trailing newline loses two entries on the next
  append+reopen — reproduced against the real store; §6.2); B2 the tool-pool
  rebuild must re-apply the agent allowlist (the record stores the narrowed
  array; a rebuilt superset would falsely refuse every allowlisted agent;
  §5.1); M1 the agent body must be passed as `extraSystem` (§8); M2 the
  try/finally scope is pinned to open immediately after acquire (§4.1);
  M3+M4+F8 the lease protocol was hardened — machineId discriminator,
  no pre-steal deletion, post-rename content comparison, heartbeat +
  anomaly abort, zero-byte-truncate release (§7); m1–m5 folded (partial-
  merge repair, estimator note, N+1 note, 60-turn constant wording, catalog
  gap recorded as a limit).
- Track B (semantics/coverage): F5 pricing identity pinned
  (`modelReference: launch.model.reference`; §8, T27b); F6 absent usage
  feeds `≥` (never a silent skip; §9.2, T27c); F7 prior worktree
  disposition threaded (§4.3, T26b); F9 `worktree` rejection on presence
  (§3.2); F1–F4 coverage additions (T4b, T6b, T16b; inherited-SA-06
  marking in §12); F10–F13 folded (id-line clause, exact call shape,
  multi-process ownership statement, marker-as-history and
  orphan-self-heal notes).

Red evidence (failing tests) precedes implementation; a delta review
follows implementation, then owner acceptance.

Post-review correction (red-evidence phase, while writing T15's test): the
review's fix direction "truncate-at-last-newline handles both shapes" was
wrong for shape b — truncating a complete-but-unterminated entry deletes a
recorded entry and desyncs the in-memory leaf (broken parent chain after
the next append + reopen). §6.2/§11/T15 now pin shape-dependent repair:
shape a truncates, shape b terminates.

### Implementation review (fresh context, two tracks, HEAD c10ef86)

Both tracks returned APPROVE WITH CORRECTIONS; corrections folded:

- Track 1 (lease + repair): F1 — `repairTornFinalLine` could zero a
  header-only no-newline file (`lastNewline === -1` → truncate at 0). The
  completeness probe now recognizes a session header ONLY at position 0
  (whole-file, no newline yet), and an unrecognizable single-line file is
  left untouched instead of truncated; regression R2d pins
  terminate + append + reopen. F2 — the reviewer's scratch fixture
  mis-authored the mid-history orphan; a genuine non-last-assistant
  variant is now T17. F3/F4 (identical-bytes steal window; release
  semantics) are the documented §7.3 residual. Unverified: real
  two-process interleaving (the §7.3 limit stands).
- Track 2 (branch/seeding/handle line/accounting): F1 — the helper's
  `task` drop documented as canonical (§5.1). F2 — the truncation-is-
  irreversible comment added at the repair site. F3 — refusal records keep
  the fresh-path cwd shape (parent cwd) on purpose. The SA-05 tracker
  (`usage-totals.ts`) dedupes by `attemptId` and sums by `childId`:
  resumed attempts cannot double-count (re-verified by the reviewer).
  Unverified: an executed throw-path probe (code-read verdict).

### Acceptance round 2 (owner review of 39ab40d) — fixes

Owner re-verification confirmed 6 findings; all fixed before resubmission:

1. P1 — the repair used string offsets as byte lengths and ate the tail of
   complete multi-byte records. The repair now works on the file Buffer;
   R2e asserts a byte-identical prefix with CJK/emoji content. (§6.2)
2. P1 — the repair disagreed with open()'s acceptance: an invalid final line
   WITH a trailing newline was invisible (append buried it as fatal
   interior corruption), and an invalid session_model line was wrongly
   terminated. `tornFinalLine` now also covers lines open() DROPPED, and
   completeness uses `acceptsAsSessionLine()` shared with open(); R2f/R2g
   pin both cases plus the append+reopen. (§6.2)
3. P2 — a resumed attempt with no output of its own reported the previous
   attempt's answer as its partial text. Result extraction is attempt-scoped
   by message identity; T31 (immediate failure + silent completion) and T32
   (mid-compaction splice) pin it. (§8)
4. P1 — the lease steal had an eligibility-vs-content double read and a
   clobbering restore. One read decides AND is the generation the steal
   moves; steal targets are unique per attempt; restore uses link()
   (EEXIST, never replace). T21b (injection) plus the T30 real two-process
   test. (§7.2)
5. P1 — same-pid leases were treated as own leftovers. A per-process
   `nonce` distinguishes instances; a same-pid lease with a foreign nonce is
   REFUSED, never reclaimed (T19d). (§7.1/§7.2)
6. P2 — an empty machine-id file (crash between create and write) blocked
   the directory forever. Atomic publish (tmp + rename) repairs it; T29
   runs the production initialization path. (§7.1)

Per the owner's instruction, a focused adversarial re-review of the
revised lease protocol (plus the repair and text-isolation changes)
precedes the resubmission.

### Focused adversarial re-review (revised lease + repair + text isolation)

Verdict APPROVE WITH CORRECTIONS; both LOW findings folded:

- F1: `acceptsAsSessionLine` diverged from open() on a `position` marker
  with a bad `leafId` — open() keeps ANY position line (a bad leafId simply
  never moves the write head), while the helper returned false and the
  repair truncated it. The helper now mirrors open() exactly; R2h pins
  terminate-not-truncate.
- F2: the two-process test did not CHECK contention — a temporally
  separated run would also look clean. The workers now log refusal counts
  and the parent asserts `refusals > 0` and at least one tag switch, making
  real overlap a tested precondition (the reviewer measured 38 tag
  switches across 45–56 acquisitions in their probe).

Reviewer probes confirmed: byte-space repair across 14 tail shapes ×
{newline, no-newline} (append + reopen each) with no case where a kept
entry was truncated or a dropped record terminated; text isolation through
both splice paths (session and no-session); lease interleavings (live/
same-pid-foreign-nonce/dead+grace/dead+stale), third-holder restore never
clobbered, identical-bytes recreation proceeds, machine-id convergence
across 6 concurrent processes with no debris. UNVERIFIED by the reviewer:
real-time grace elapse after a hard crash; heartbeat-to-completion against
a killed holder; cross-machine refusal on real shared storage
(seam-verified only).

### Acceptance round 3 (owner review of 34ceee9) — lease protocol revision

Owner findings (both reproduced with synchronized real processes):

1. P1 — the steal moved a LIVE lease away and the resulting vacuum let a
   third process acquire: B and C each held a successful handle while A's
   refusal and the late heartbeat could not revoke either. Root cause: on
   POSIX there is no compare-and-swap, so any move-away-then-recreate
   reclaim has a pausable window. Fixed by replacing the single-file
   protocol with intent + verify (§7.0–§7.3): acquisition writes a uniquely
   named candidate into a lease DIRECTORY, and holds only after a
   post-create scan sees no other active/uncertain candidate. No operation
   ever moves, replaces or unlinks a live claim; exclusion is proven
   without heartbeat timing. A deterministic three-process regression
   (T30b) plus the updated two-process hammer test (T30) are in the plan.
2. P2 — concurrent machine-id initialization rewrote an id already
   referenced by live leases (a late publisher's rename clobbered the
   winner), and the stale lease became permanently `owned-elsewhere`.
   Fixed by publish-once (§7.4): link-based no-clobber publication,
   adopt-on-EEXIST, and a convergence path only for the legacy empty file;
   a valid id is never replaced. T33a–d pin the stability requirement
   ("an id referenced by existing leases stays stable") and the owner's
   end-to-end repro.

Per the owner's instruction, the revised protocol must pass an independent
pre-implementation design review before implementation resumes.

Design review verdict: APPROVE WITH CORRECTIONS; all findings folded:

- A1 (HIGH): §7.3's proof depends on "own candidate is never unlinked
  between create and the HOLD decision" — now a PINNED invariant in §7.2
  (step 8), pinned by T30b(iv).
- B3 (HIGH): the legacy single-FILE migration could `mkdir` over a file
  (EEXIST) and had no single-read discipline — §7.1 now pins classify-from-
  one-read, live→`busy` with NO directory created, dead+aged→unlink that
  artifact; regression added.
- C1 (HIGH): EMPTY machine-id recovery was still a clobbering replace
  (two recoverers could hold different ids — the owner's P2 reproduced on
  that branch). §7.4 now REFUSES on an empty file with an actionable
  message and never touches it (concurrent non-clobbering recovery is
  impossible without CAS; the artifact cannot be produced by the new
  publication path); T33d/e pin the refusal and the stability requirement.
- B2/A2/C2 (MED/LOW): fairness bounded-retry note, stalled-holder retirement
  recorded, tmp debris invariant — all in §7.5.
- M1–M6/D1–D5: the test plan gained the migration, fairness, heartbeat-
  independence and id-stability regressions; `stale-contended` is retired
  from §11/§4.1 (no steal step exists); §11 lists the new seams
  (`onAfterCreate` / `onBeforeScan` / `onBeforeMachineIdPublish`); §14's
  old "stale steal" wording is superseded by "stale cleanup"; the earlier
  round's single-file probe results in this log are SUPERSEDED by the
  round-3 protocol and its regressions.
