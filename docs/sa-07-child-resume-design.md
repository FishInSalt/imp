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
5. Lease acquisition (§7) → refusal (`busy` / `stale-contended` /
   `owned-elsewhere` / `io-error`). The attempt's try/finally opens the
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
allowlist narrowing (the existing `validateSubset`) → filter `task` out.
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

Detection is therefore STRUCTURAL, not parse-based: `SessionStore.open`
records `tornFinalLine: boolean` when a persisted non-empty file's bytes do
not end in `\n`.

Repair is SHAPE-DEPENDENT — truncating both shapes would be wrong:

- shape a → `truncateSync` at the last newline (the fragment is bytes no
  reader can interpret as an entry);
- shape b → append the missing `"\n"` (the entry is complete and `open`
  kept it in memory; TRUNCATING it would delete a recorded entry AND desync
  the in-memory leaf — the next appended entry would chain to an id whose
  bytes no longer exist, producing a broken parent chain on the following
  reopen. Correction found while writing the red tests; folded here.)

API:

- `SessionStore` gains `tornFinalLine: boolean` (set by `open`, the
  `persisted`/`savedModel` pattern) and `repairTornFinalLine(): { action:
  "truncated" | "terminated"; bytes: number } | undefined` — truncates or
  terminates per the shape above, clears the flag; `undefined` when the flag
  is unset or the store is not persisted; idempotent (a second call is a
  no-op).
- Ordering rule (pinned): the repair runs BEFORE any append to the child
  file, only after steps 1–6.1 passed.
- Refusing instead of repairing was rejected deliberately: this is exactly
  the crash-mid-append state that most needs continuation, and both repairs
  preserve every entry that parses. The action is reported in the result
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

## 7. Single-writer lease

One active execution per child, enforced in-process and across processes on
one machine. New module `src/core/child-lease.ts`; no existing lock mechanism
exists anywhere in the codebase (verified).

### 7.1 Artifact

`<childFilePath>.lease` beside the child session file. Content (one JSON
line): `{ "pid": <number>, "host": "<os.hostname()>", "machineId":
"<uuid>", "attemptId": "<uuid>", "startedAt": "<ISO>" }`. The lease exists
only while an attempt runs (created after validation, released in `finally`).

`machineId` is read-or-created at `<childrenDir>/.imp-machine-id` (a random
UUID, `wx` + ENOENT-retry). It exists because `os.hostname()` collides
routinely across containers sharing a mounted sessions directory, and pid
namespaces make cross-container pids meaningless — hostname + pid alone can
neither detect the collision nor prove liveness.

### 7.2 Protocol (pinned)

In-process registry: `Map<childFilePath, attemptId>` — checked and set
SYNCHRONOUSLY (no await between check and set), so same-process concurrency
(two `task` calls in one turn targeting one child) cannot slip through even
if the file is mangled.

Acquire (`acquireChildLease(childFilePath, attemptId, opts?)`):

1. Map hit → refuse `busy` ("already running in this process").
2. Map miss → set the entry. All later failures delete it.
3. `writeFileSync(leasePath, payload, { flag: "wx" })`:
   - success → READ BACK and verify (`attemptId === mine`, payload parses);
     mismatch/IO error → refuse `io-error` (never proceed on an unverified
     lease).
   - `EEXIST` → read the existing lease, then:
     - `host` or `machineId` differs from mine → refuse `owned-elsewhere`
       ("held on host X / by a different machine — shared-storage sessions
       across machines are not supported").
     - unreadable / unparseable content → debris: steal path.
     - `pid === process.pid` and the Map has NO entry → own leftover (a
       previous release failed): steal path.
     - `isAlive(pid)` in MY namespace (injectable; default
       `process.kill(pid, 0)`, EPERM = alive) → refuse `busy` with
       pid/host/startedAt in the message.
     - pid dead in my namespace AND lease mtime younger than the grace
       window (`staleGraceMs`, default 60s) → refuse `busy` with a recovery
       hint ("that process looks dead here but may be live in another pid
       namespace; if it really crashed, retry in ~N s").
     - pid dead AND mtime older than the grace → steal path.
4. Steal path: re-read the bytes; `renameSync(leasePath, <lease>.steal)`
   (fixed target — rename is atomic, exactly one winner per generation);
   `ENOENT` → retry from step 3 (someone else won). After the rename,
   compare the moved content against the bytes read before it:
   - mismatch (someone re-created the lease in the window — the moved file
     is NEWER than what we decided about) → best-effort restore
     (`renameSync(<lease>.steal, leasePath)`; EEXIST = a third process
     already re-created it → leave it) → refuse `stale-contended`.
   - match → best-effort remove the `<lease>.steal` artifact; retry from
     step 3.
   Bounded at 3 rounds → refuse `stale-contended`.
5. Success returns `{ ok: true, lease }`.

Heartbeat: after acquire, the attempt touches the lease mtime every 20s
(`utimesSync`; `setInterval(...).unref()` — the #task-timer liveness lesson;
interval and grace are injectable seams). At each touch the holder re-reads
the lease: content mine → touched, continue; content missing or foreign →
**lease anomaly** — stderr note and ABORT the attempt (§8's attempt
AbortController). Aborting is what makes the invariant "at most one attempt
CONTINUES" hold even inside the residual race windows of §7.3.

Release (`lease.release()`, `finally`): clear the Map entry when it maps to
my attemptId; read the lease back; unlink ONLY when it parses and
`attemptId === mine`. Unlink failure → truncate the lease to zero bytes
(best effort) + stderr note: an empty lease is debris, immediately
stealable by the next acquire; a foreign or corrupt lease is left alone
(stderr note).

### 7.3 Residual races (recorded, not hidden)

- The read→rename window in the steal path is not atomic. The rename is
  atomic per generation, the post-rename comparison converts "I moved a
  fresh live lease" into a refusal for the stealer, and the heartbeat
  anomaly check converts "my live lease disappeared under me" into an abort
  for the holder — so no interleaving leaves TWO attempts continuing; the
  worst outcome is that both stop and the winner of the next attempt
  proceeds.
- Grace delay: after a hard crash the next resume refuses `busy` until the
  lease mtime is older than `staleGraceMs` (~60s; three missed heartbeats).
  That delay is the price of not trusting a dead-looking pid across pid
  namespaces; it is documented, hint-texted, and seam-injectable in tests.
- Sharing a sessions directory across machines is refused
  (`owned-elsewhere`), not guessed about.
- The lease protects WRITERS (attempt-vs-attempt). It does not freeze the
  filesystem: external edits during an attempt are outside any promise
  (TOCTOU note, §14).

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
  | { ok: false; code: "busy" | "stale-contended" | "owned-elsewhere" | "io-error"; message: string };
export interface ChildLeaseOptions {
  pid?: number; host?: string; machineId?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  onBeforeStealRename?: () => void;  // test seam: inject the steal-window race
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

New `test/child-lease.test.ts` (clock/pid/host/liveness injectable): T18
in-process double acquire; T19 stale rules — pid dead + mtime fresh refuses
with the recovery hint, pid dead + mtime older than grace steals, own
leftover (pid === self, no Map entry) steals; T20 live foreign pid refuses;
`owned-elsewhere` (host/machineId mismatch) refuses; failed-release leftover
(zero-byte lease) is debris-stealable; T21 unparseable debris recovery and
`stale-contended` when the post-rename comparison finds a newer lease
(injected interleaving); T25 release leaves foreign leases alone and notes
failures; T28 heartbeat touches keep mtime fresh and a foreign/missing
lease at a beat aborts the attempt via its signal.

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
