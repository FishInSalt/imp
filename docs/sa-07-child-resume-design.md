# SA-07 — Synchronous continuation of settled children (design)

- Date: 2026-09-29
- Branch: `feat/sa-07-child-resume`
- Baseline: `bae428e` (main; SA-06 merged)
- Status: DRAFT — pending independent adversarial design review (two tracks).
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
| `resume` + `worktree` | rejection: the worktree decision is immutable; continuation runs in the recorded cwd/worktree |
| `resume` + `timeoutMs` | ALLOWED — the explicit new attempt's clock |
| `resume` + empty/whitespace-only `prompt` | rejection: a resume needs a non-empty instruction |
| `resume` with `IMP_CHILD_SESSIONS=0` (or `childSessions: false`) | rejection: child sessions are disabled |
| `resume` with no parent session (`getSession() === null`) | rejection: no parent session to resolve children against |

The `agent` rejection deliberately ignores whether the given agent EQUALS the
recorded one: immutable fields are not passed at all; the record is the only
authority. (Fresh-dispatch validation for `agent`/`worktree` is unchanged.)

### 3.3 ID disclosure (how the parent learns eligible ids)

When a child session is persisted, the task result's handoff block gains one
line (fresh and resume results alike):

```
child session id: <id> — continue it later with task({resume: "<id>", prompt: "…"})
```

This is a handle, not a promise: resumability is decided at resume time.
Refusals print the reasons (§4.2); a `not-found` refusal additionally lists
this parent's child ids from `listChildLaunches(parent)` (id + status only;
no per-child validation, no fleet subsystem).

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
   `host-mismatch` / `io-error`).
6. Transcript repair (§6): 6.1 read-only pairing scan (may refuse
   `history-unpairable`); 6.2 truncate a torn final fragment; 6.3 append
   synthetic results for the crash-tail orphan. Nothing before 6.2 mutates
   the child file.
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
   <n>-byte torn tail].`
2. worktree retention line when the launch record has a worktree:
   `worktree kept at <path> (branch <branch>) — resume attempts do not
   remove it; merge <branch> when done.`
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

### 5.1 Tool pool reconstruction

Mirrors the fresh path's selection rules, rooted at the recorded cwd:

- worktree child (`launch.worktree !== undefined`):
  `getToolsForChild(launch.cwd, {providerName: launch.model.providerName,
  modelId: launch.model.wireModelId}) ?? getToolsForCwd(launch.cwd)`;
  `undefined` → refusal ("per-directory tool pool unavailable — cannot
  reconstruct the child's tool contract; retry from a host that wires it").
  This mirrors the fresh-path rule that a worktree child without a per-cwd
  pool FAILS rather than inheriting parent-cwd tools.
- shared-cwd child: same call chain with the fresh path's fallback to the
  parent pool (`getToolsForChild?.(cwd, binding) ?? parentPool`).

Then `task` is filtered out, and the result feeds BOTH the `tools-drift`
comparison (SA-06 check 10, exact set equality against `launch.tools`) and
the execution pool. After a passing verdict the TOOL CONTRACT is therefore
provably identical to launch; the executed attempt records the current pool
(names + mcpServer), which the verdict has proven equal-as-a-set.

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

### 6.2 Torn final fragment (truncate before any append)

`SessionStore.open` drops an unparseable FINAL line in memory only (stderr
note) and leaves the bytes; `appendFileSync` would concatenate the next entry
onto the fragment and lose it on the following reopen. Resume therefore
exposes and repairs the fact:

- `SessionStore` gains `tornFinalLineDropped: boolean` (set by `open`, the
  same pattern as `persisted`/`savedModel`) and
  `repairTornFinalLine(): { removedBytes } | undefined` — truncates the file
  at the last newline (`truncateSync`), returns bytes removed, clears the
  flag. `undefined` when the flag is unset or the store is not persisted.
- Ordering rule (pinned): truncate BEFORE any append to the child file. The
  repair runs only after steps 1–6.1 passed.
- Refusing instead of truncating was rejected deliberately: the torn tail is
  exactly the crash-mid-append state that most needs continuation, and the
  fragment is unparseable bytes that no reader can interpret as an entry.
  The removal is reported in the result (§4.3 item 1).

### 6.3 Crash-tail repair (persisted, honest)

The missing results in the `M`/`A` shape are appended (via
`store.appendMessage`) as ONE `toolResult` message, one result per missing
id in `A`'s block order:

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

### 6.4 Effective history

One `buildContext()` call provides `messages` (summary message + retained
tail, or the full branch when never compacted) and `compactionBoundary`. The
result is the continuation's initial history — never a replay of raw JSONL
entries (task-list requirement; SA-06 handoff: "reuses the already-opened
store").

## 7. Single-writer lease

One active execution per child, enforced in-process and across processes on
the same host. New module `src/core/child-lease.ts`; no existing lock
mechanism exists anywhere in the codebase (verified).

### 7.1 Artifact

`<childFilePath>.lease` beside the child session file. Content (one JSON
line): `{ "pid": <number>, "host": "<os.hostname()>", "attemptId": "<uuid>",
"startedAt": "<ISO>" }`. The lease exists only while an attempt runs
(created after validation, released in `finally`).

### 7.2 Protocol (pinned)

In-process registry: `Map<childFilePath, attemptId>` — checked and set
SYNCHRONOUSLY (no await between check and set), so same-process concurrency
(two `task` calls in one turn targeting one child) cannot slip through even
if the file is mangled.

Acquire (`acquireChildLease(childFilePath, attemptId, opts?)`):

1. Map hit → refuse `busy` ("already running in this process").
2. Map miss → set the entry. All later failures delete it.
3. Best-effort `rmSync(<lease>.stale, {force: true})` (debris from a crashed
   steal; safe by construction, §7.3).
4. `writeFileSync(leasePath, payload, { flag: "wx" })`:
   - success → READ BACK and verify (`attemptId === mine` and payload parses);
     mismatch/EIO → refuse `io-error` (do not proceed on an unverified lease).
   - `EEXIST` → read the existing lease, then:
     - unreadable / unparseable → treat as debris: rename to
       `<lease>.stale` (ENOENT → retry step 4, max 3 rounds) → remove → retry.
     - `host !== os.hostname()` → refuse `host-mismatch` ("held on host X —
       cross-host sessions are not supported").
     - `pid === process.pid` → stale self (a previous release failed) →
       steal path.
     - `isAlive(pid)` (injectable; default `process.kill(pid, 0)`, EPERM
       counts as alive) → refuse `busy` with pid/host/startedAt.
     - dead → steal path.
5. Steal path: read the lease bytes, then `renameSync(leasePath,
   <lease>.stale)`; ENOENT → retry step 4 (someone else won). After a
   successful rename, RE-READ the renamed payload: if it differs from the
   bytes read before the rename, someone re-created the lease in the race
   window — restore by `renameSync(<lease>.stale, leasePath)` best-effort,
   then refuse `stale-contended`. Matching → best-effort remove the stale
   file, retry step 4. Bounded at 3 rounds → refuse `stale-contended`.
6. Success returns `{ ok: true, lease }`.

Release (`lease.release()`, `finally`): if the Map still holds my
`attemptId`, delete it; read the lease back; unlink ONLY if it parses and
`attemptId === mine` (a foreign or corrupt lease is left alone, stderr
note); unlink failure → stderr note (stale self is stealable on the next
acquire via the `pid === process.pid` rule).

### 7.3 Residual races (recorded, not hidden)

- The stale-steal read→rename window is not atomic. The rename is atomic for
  ONE winner; the remaining exposure is "B re-created a live lease after A
  read the stale one, before A's rename". The post-rename re-read converts
  this into a refusal for A (and best-effort restore for B); the residual
  failure mode is a missing lease file for a live B, which only a THIRD
  concurrent resume could exploit. Documented as a known limit: single-host,
  tiny-window, detection-not-prevention.
- Cross-host leases are unsupported and refused, not guessed about.
- The lease protects WRITERS (attempt-vs-attempt). It does not freeze the
  filesystem: external edits during an attempt are outside any promise
  (TOCTOU note, §12).

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
- Permissions: the LIVE gate (`options.onToolCall`) with
  `{ agent: launch.agent?.name, cwd: launch.cwd }` — never the record (§4.4
  of the SA-06 design). Events: same `onEvent` wiring with a fresh
  `sourceId` and the current `taskToolCallId`.
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
  usage carries `incomplete: true`. A record's usage is skipped when
  absent (never invented as zero).

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
  concurrency (the five-call chunking is untouched).

## 11. Interfaces (pinned for review)

```ts
// src/core/child-lease.ts (new)
export interface ChildLeaseHandle { readonly path: string; readonly attemptId: string; release(): void; }
export type ChildLeaseResult =
  | { ok: true; lease: ChildLeaseHandle }
  | { ok: false; code: "busy" | "stale-contended" | "host-mismatch" | "io-error"; message: string };
export interface ChildLeaseOptions {
  pid?: number; host?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
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
readonly? tornFinalLineDropped: boolean;                       // set by open()
repairTornFinalLine(): { removedBytes: number } | undefined;   // truncate at last newline

// src/core/subagent.ts (changed)
initialHistory?: AgentMessage[];
initialFloor?: number;

// src/core/tools/task.ts (changed)
resume schema field; resume branch; taskResult handoff id line.
```

## 12. Acceptance mapping (task-list SA-07 bullets)

| Acceptance bullet | Design | Planned tests |
| --- | --- | --- |
| Fresh dispatch unchanged; continuation gets old effective context + exactly one new instruction | §3.3, §8 | T1–T3, T14 |
| Compressed child resumes from summary + retained tail | §6.4 | T13 |
| Completed/capped/aborted/timed-out/crashed continuable only when state+ownership permit | §4.1 steps 2–5, §10 | T4, T5, T8, T23 |
| Tool pairing valid; side effects not auto-repeated | §6.1–6.3 | T14–T17, T22 |
| Missing/incompatible role/model/tools/worktree/permissions fail before execution | §5, §7 | T6, T7, T9–T12 |
| Two concurrent resumes → one writer; unrelated children concurrent | §7 | T18–T21, T24 |
| Parent restart, stale ownership, interrupted persistence recovery | §7.2–7.3, §10 | T19, T20, T25 |
| New history extends transcript; linkage correct; attempt usage excludes historical calls | §6.3, §9 | T13, T14, T26, T27 |
| Cancellation/timeout/cap/task activity/CJK/cleanup safety preserved | §8, §10 | T23, T27, regression suites |

## 13. Test plan (red evidence first)

New `test/child-lease.test.ts`: T18 in-process double acquire; T19 stale
self (pid === process.pid, no Map entry) steal; T20 live foreign pid refuse
+ host mismatch refuse + failed-release leftover reclaim; T21 stale debris
(parse-fail file) recovery; T25 release semantics (foreign lease left
alone; unlink failure noted).

New `test/child-resume.test.ts` (fake provider harness like
`test/task-tool.test.ts`):

- T1 argument matrix (§3.2) — each rejection text asserted.
- T2 unknown id → refusal + candidate list; malformed/missing-launch
  passthrough (crafted raw child files).
- T3 happy path: one new instruction; model-visible request = effective
  history + exactly one new user message; result contains the id line.
- T4 no settled record → refusal ("may still be running…").
- T5 rejected-record-only child → refusal.
- T6 role drift / missing agent → refusal (agent body edited after launch).
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
- T15 torn final fragment: file truncated at last newline, fragment bytes
  gone, attempt proceeds; result reports the repair.
- T16 non-tail orphan → refusal; T17 mid-history mismatch refuses even when
  the tail is clean.
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
- T27 usage split: history carries large usage; fake provider reports a
  small report → attempt trailer shows only the new numbers; lifetime line
  sums records (≥ marker when a previous record is incomplete).

Store unit tests (`test/session-store` beside existing ones): torn-flag set
on open; repair truncates exactly; `undefined` when clean.

Subagent unit tests: `initialHistory` seeds history and floor without
touching fresh dispatch; fresh dispatch byte-identical (existing suite).

Regression updates: `test/task-tool.test.ts` handoff-text pins learn the
§3.3 line (mechanical, no expectation weakening).

## 14. Known limits / deferred

- Lease residual race (§7.3) — single-host, detection-based, documented.
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

(pending — two-track adversarial review to be recorded here, corrections
folded before implementation; red evidence before code.)
