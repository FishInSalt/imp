# SA-03 design: structured task identity and terminal outcomes

Status: APPROVED — independent adversarial design review round 1 (APPROVE with required corrections, 2026-09-27); corrections applied in this revision (see §7).
Branch: `feat/sa-03-task-record`. Baseline: `main` @ `267fdba` (SA-01 + SA-02 merged).
Task list: `docs/subagent-delegation-task-list.md` §SA-03.

## 1. Problem (source-verified)

### 1.1 What exists today

`task.execute` (`src/core/tools/task.ts`) holds every structured fact about a call at
settlement time — `sourceId`, `taskToolCallId`, the SA-02 `ChildModelBinding`, the child
session store, `SubagentOutcome` (status/text/reason/turns/usage), the SA-01
`CleanupOutcome` and `ChildWorktree` — and then reduces all of it to prose + `isError`
via `taskResult()`. The structured part is gone when `execute` returns.

Transport facts (verified in source):

- `ToolExecuteResult` (`src/core/tools/types.ts`) → `runTool` (`src/core/loop.ts:476`)
  projects only `{toolCallId, toolName, content: result.content ?? result.output,
  isError, display}` — any new field is dropped unless explicitly forwarded.
- `persistableResult` (`src/core/loop.ts:425`) strips `display` before the result enters
  history; the `tool_end` event carries the original object. `display` is therefore the
  opposite lifecycle of what SA-03 needs: event-only.
- Nothing in any release (verified against the `v0.1.0` tree) ever reads back child
  session files under `children/`; child transcripts are write-only today.

Consumers blocked by the prose-only result: SA-04 (per-attempt usage), SA-05 (durable
aggregate), SA-06 (launch-state validation), SA-07 (resume), UI/observers. The task list
forbids prose parsing and states that `isError: false` does not imply completion.

### 1.2 Carrier options and verified evidence

Four carriers were evaluated; the owner decided the transport after this evidence (§1.3).

1. **New entry type in the parent session JSONL** — rejected: `parseEntryLine`
   (`src/core/session/store.ts:218`) throws `unknown entry type` on unknown types, in
   current code *and* in the released `v0.1.0` (diffed). The released build would fail to
   open any parent session containing the record; `/sessions` silently drops unreadable
   files, so those sessions would disappear from the list.
2. **New entry type in the child session JSONL** — viable but rejected: old builds never
   open `children/` (verified), so it is downgrade-safe; but there is no durable record at
   all when child sessions are disabled (`IMP_CHILD_SESSIONS=0`) or no parent session
   exists, and every consumer needs a `children/` directory scan plus cross-file crash
   windows.
3. **Separate sidecar file** — rejected: same "no record without a session" gap is
   avoidable here, but it introduces a second file with its own write ordering,
   partial-write failure mode and index-rebuild story for no benefit over (4).
4. **(chosen) A typed field on the tool result, persisted with the message.** Verified:
   - Old readers tolerate it: message entries validate only the envelope + `message.role`;
     unknown fields inside `results[]` are ignored and preserved. Verified with a real
     `SessionStore.open`/`buildContext`/`stats` round-trip on a message carrying the
     field, and `v0.1.0`'s parser is identical in this respect.
   - No provider leak by construction: every wire converter constructs wire objects
     field-by-field (`anthropic.ts`, `openai-completions.ts` — reused by zai/deepseek/
     moonshotai — and `codex-responses.ts`; `v0.1.0`'s converters too). The only spread
     over a result is `shared.ts`'s vision-downgrade preprocessing
     (`{...result, content: replace(...)}`), which *preserves* unknown fields and is
     local-only.
   - Token estimation and compaction change nothing: `estimateTokens` counts text blocks
     and tool-call arguments; the summarizer serializes history via `contentText(...)`
     (`compaction.ts:252-268`). The record never enters either.
   - Crash consistency is the best of all options: text and record share one JSONL line,
     one append — no window where one exists without the other.

### 1.3 Owner decision

The record rides the task tool's result as an explicitly forwarded field and is persisted
with the message (option 4). No new entry types, no new files, no provider changes.

## 2. Contract

### 2.1 Schema — `TaskRecord` v1 (`src/core/task-record.ts`)

```ts
export const TASK_RECORD_VERSION = 1;

export type TaskRecordStatus =
  | "completed"      // the child loop ended normally — NOT verified task success
  | "max_iterations" // hit an explicit turn cap; #loop-health removed the child wall (legacy for old records)
  | "aborted"        // parent signal (Ctrl+C)
  | "timeout"        // the child's own clock fired
  | "crash"          // provider/protocol error; partial text may exist
  | "rejected";      // pre-launch rejection — nothing ran

export type TaskRecordTranscript =
  | { present: true; path: string; writeFailed?: true }
  | { present: false; why: "disabled" | "no-parent-session" | "write-failed" | "no-content" };

export interface TaskRecordWorktree {
  path: string;
  branch: string;
  disposition: "removed" | "kept-work" | "kept-unknown" | "removal-failed";
  detail?: string; // bounded summary of the SA-01 assessment/errors
}

export interface TaskRecordUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** SA-04 reserves this flag for "a usage report is known to be missing".
   *  SA-03 records runtime values and never sets it. */
  incomplete?: true;
}

export interface TaskRecord {
  version: 1;
  timestamp: string;            // ISO, set at finalization
  // identity
  attemptId: string;            // fresh UUID per execute — the record's unique key
  sourceId: string;             // invocation observer identity (same value on events)
  taskToolCallId?: string;      // parent tool-call id (absent for direct callers)
  parentSessionId?: string;     // parent session header id
  childId?: string;             // logical child id = child session UUID
  // launch
  launched: boolean;            // false = rejected before the child loop ran
  agent?: string;               // resolved agent definition name
  binding?: ChildModelBinding;  // SA-02 canonical provider/model reference
  cwd: string;                  // execution cwd (worktree path when isolation was active).
                                // For launched:false records: the cwd the call was
                                // made from — the created-and-removed worktree path
                                // is named by worktree.path only (review LOW, closed)
  tools?: string[];             // final child tool names
  timeoutMs?: number;           // resolved wall-clock budget (absent = no clock)
  // terminal
  status: TaskRecordStatus;
  reason?: string;              // bounded crash/rejection summary
  turns: number;                // 0 when not launched
  textPresent: boolean;         // outcome.text !== undefined — never the text itself
  // references
  transcript?: TaskRecordTranscript; // launched only
  worktree?: TaskRecordWorktree;     // present when a worktree was created this call
  // usage
  usage?: TaskRecordUsage;      // launched only; SA-04 owns the arithmetic
}
```

Presence rules:

- Always: `version`, `timestamp`, `attemptId`, `sourceId`, `cwd`, `launched`, `status`,
  `turns`, `textPresent`.
- `taskToolCallId`: when `execute` received a context (the real loop always passes it).
- `parentSessionId`: when a parent session store exists.
- `binding`: when SA-02 model resolution succeeded.
- `tools`: when the child tool pool was successfully resolved (just before launch).
- `timeoutMs`, `childId`, `transcript`, `usage`: launched attempts only (`childId`
  additionally requires that a child session was created).
- `reason`: `crash` (the outcome's reason) or `rejected` (the error's first line).
- `worktree`: whenever a worktree was created during the call — including the
  worktree-tools-validation rejection whose rollback is itself a cleanup outcome.

### 2.2 Transport and visibility classes

- **Model-visible**: `content` only (unchanged). The record never reaches provider wire
  input; converters construct wire objects field-by-field and must keep doing so.
- **Event-only, stripped before history**: `display` (unchanged).
- **Program-visible, persisted with the message**: `taskRecord` (new) — present on
  `tool_end` events and in the session JSONL; invisible to the model, the UI text
  renderers, token estimation and the summarizer.

Plumbing (all explicit):

1. `ToolExecuteResult.taskRecord?: TaskRecord` (`src/core/tools/types.ts`).
2. `runTool` copies it into the returned `ToolResult`.
3. `persistableResult` keeps it (it strips `display` only) — the persisted message entry
   carries it verbatim; `ToolResult.taskRecord` gets the visibility doc-comment
   (`src/core/messages.ts`).
4. `tool_end` events carry it live (same object as (2)).

### 2.3 Honesty rules (all testable)

- `completed` means "the loop ended normally", not verified task success; no field claims
  verification, and `isError` mapping is unchanged.
- Pre-launch rejection: `launched: false`, `status: "rejected"`, `reason` set; no
  `childId`/`transcript`/`usage`. A rejection is never confused with a run that produced
  nothing.
- `textPresent` reflects `outcome.text !== undefined`; the "(subagent completed with no
  output)" prose sentinel never becomes text presence.
- Transcript facts come from the store: `disabled` (child sessions off),
  `no-parent-session` (no parent store), `write-failed` (a write was observed to fail and
  nothing persisted), `no-content` (nothing persisted and no write was observed to fail —
  e.g. an attempt that produced no writes), and `present:true` with optional
  `writeFailed:true` (a write failure was observed during the attempt, covering message
  appends AND compaction checkpoints). `isPersisted === false` alone never implies an
  error. Nothing in the record advertises resumability — that decision is SA-06's, built
  on these facts.
- Every value originates from runtime objects (`SubagentOutcome`, `CleanupOutcome`,
  session store, SA-02 binding). Child text is never parsed; changing the result prose or
  the child's answer cannot change any field.
- `reason` and `worktree.detail` are bounded to 300 code points (CJK-safe cut with an
  "…" suffix).

## 3. Decisions

### D1 — Module `src/core/task-record.ts` (pure data, no I/O)

Exports `TASK_RECORD_VERSION`, the types above, `buildTaskRecord(input)` (stamps version
+ timestamp, bounds `reason`/`worktree.detail`, assembles presence) and
`collectTaskRecords(entries)` (D4). The module owns the record vocabulary only; `task.ts`
translates its internal `CleanupOutcome`/session states into it. No imports from
`tools/task.ts` or `subagent.ts` (no cycles).

### D2 — Attachment point: `finish()` in `task.execute`

`execute` keeps its current structure but accumulates a `TaskRecordInput` and routes
**every** return path through a `finish(result)` helper that sets
`result.taskRecord = buildTaskRecord(input)`. The helper makes field assembly uniform
(version/timestamp/bounds/presence in one place); it does not remove the need to call it
from each return — the accumulator's fields are set progressively, so early returns
(unknown agent, model rejection) simply carry only what was resolved by then. A
branch-sweep test (T25) asserts a record on every branch. `taskResult()` stays a pure
prose function (its existing `toEqual` tests keep passing; the record is attached at the
result level, not inside prose).

### D3 — Read path: `collectTaskRecords(entries)`, raw entries only

Walks `SessionEntry[]` message entries (`toolResult` results → `taskRecord`).
`retainedTail` inside compaction entries is deliberately **not** scanned: it holds
`AgentMessage[]` copies, not entries, and message entries are the single source (the
session file is append-only, so a compacted-away message entry still exists even when
`buildContext()` no longer returns it). Readers must therefore use raw entries
(`getEntries()`/`getBranch()`), never `buildContext()`. Dedupe by `attemptId` (first
occurrence wins) is kept as a **defensive** measure — it covers hand-edited/copied files
and any future reader that does traverse retained copies; it is not a compaction
correctness dependency.

Validation (a record failing any check is skipped — unknown stays unknown):
`version === 1` (greater versions are skipped), `attemptId` a non-empty string,
`sourceId`/`timestamp` strings, `status` one of the fixed enum, `turns` a finite number,
`textPresent` boolean; present optional fields must be well-shaped (`transcript` with
boolean `present` plus matching `path`/`why` types, `worktree` with string
`path`/`branch`/`disposition`, `usage` with numeric token fields). Optional additive
fields inside v1 are allowed for SA-04/06; any semantic change bumps the version.

### D4 — Terminal mapping (1:1, no invention)

`outcome.status` maps directly to `TaskRecordStatus`; `turns`/`usage` come from
`outcome`; `textPresent` from `outcome.text !== undefined`. `reason` is the existing
`outcome.reason` (crash) or the rejection error's first line — bounded, human-readable,
no machine taxonomy invented. Rejections get `launched: false`, `status: "rejected"`,
`turns: 0`.

### D5 — Worktree disposition mapping

`CleanupOutcome` → `worktree`: `removed` → `{disposition:"removed"}`; `failed` →
`{disposition:"removal-failed", detail: errors}`; `kept` + `work-present` →
`{disposition:"kept-work", detail}`; `kept` + `unknown` → `{disposition:"kept-unknown",
detail}`. `path`/`branch` from `ChildWorktree`. The record never claims a cleanup that
did not happen (SA-01's layered honesty carried into structured form). Invariant:
`worktree` is present iff `wt !== undefined` at `finish()` — covering the
worktree-tools-validation rollback returns and every launched path.

### D6 — Wire safety: no converter changes; regression tests pin the discipline

No provider code changes. New regression tests (one per wire family, using the existing
local-server harnesses in `test/openai-completions.test.ts`, `test/anthropic-*.test.ts`,
`test/codex-responses.test.ts`) send a history containing a `toolResult` with a
`taskRecord` and assert the captured request body contains neither `taskRecord` nor the
attempt id. A doc-comment on `ToolResult.taskRecord` states the rule.

### D7 — Persistence-failure behavior

- Child-session creation throwing (mkdir/open failure) currently makes the whole task
  throw before the child runs; unchanged. Such thrown paths carry **no record** — a
  documented crash window; absence means unknown, never fabricated facts.
- Mid-run write failures: for the attempt's duration, the child session's TWO write
  entry points are wrapped — `appendMessage` (the loop's message persistence) and
  `appendCompaction` (`compactSession` writes solely through it). A throw from either
  sets `transcriptWriteFailed = true` and is re-thrown unchanged, so control flow is
  exactly as today (a message failure crashes the child loop — `loop.ts:125-133` pops the
  user message and rethrows; `runSubagent` maps it to a `crash` outcome; a compaction
  failure is caught by `compactChildHistory` and the child continues un-compacted, with
  the existing retry/limit behavior untouched). The record then reports
  `{present: true, path, writeFailed: true}` when the store had persisted at least once;
  an unpersisted store reports `write-failed` only when a failure was actually observed,
  else `no-content`.
- `disabled` / `no-parent-session` are the two no-session variants, distinguished at the
  point where the child session would have been created.

### D8 — Interface freeze for SA-04 / SA-05 / SA-06

- Identity fields (`attemptId`, `sourceId`, `taskToolCallId`, `parentSessionId`,
  `childId`) and the `TaskRecordStatus` vocabulary are frozen.
- SA-04 owns usage *semantics and values*: it may set `usage.incomplete` and add
  optional additive fields (e.g. a summarizer breakdown) within v1; it must not change
  the meaning of existing fields.
- SA-05 consumes records via `collectTaskRecords` (rebuild) and `tool_end` events
  (incremental); it must not rescan child transcripts for records.
- SA-06 extends the record with launch-state fields (additive within v1 when optional;
  version bump for semantic changes). This design does not freeze SA-06's own additions.
- **SA-06 precondition**: the record is the sole resumability advertisement. An
  execute-throw window (D7) can leave a created child session file with no record;
  SA-06 must treat a missing record as not-resumable/unknown and must never infer
  resumability from the child session file's existence.
- Event consumers dedupe by `attemptId` across live `tool_end` emissions and replay
  re-emissions (`replay.ts` re-emits `tool_end` from persisted messages), exactly as
  record readers do.

### D9 — Non-goals (explicit)

No resume implementation; no usage arithmetic fix (SA-04); no `isError` mapping change;
no UI/rendering changes; no extension API change (`emitToolEnd` keeps its shape); no
provider changes; no child-file or parent-file format additions; no second registry; no
resumability flag; no cleanup policy for `children/`.

## 4. Test plan (labels map to SA-03 acceptance items)

New `test/task-record.test.ts` (unit) plus additions to `test/task-tool.test.ts`,
`test/session-store.test.ts` (or a new persistence test file), and the three provider
wire suites.

Terminal outcomes — **A1**:

- T1 completed with text → `status:"completed"`, `textPresent:true`.
- T2 completed with no text → `textPresent:false` (prose sentinel untouched).
- T3 `max_iterations` with text; T4 `max_iterations` without text (cap-without-text).
- T5 crash with partial text; T6 crash without text → `reason` set, `textPresent` right.
- T7 aborted; T8 timeout.
- T9 rejections: unknown agent, invalid model, unknown agent-listed tools (shared cwd) →
  `launched:false`, `status:"rejected"`, `reason` set, no transcript/usage.

Semantics — **A2**: T10 the JSON of a `completed` record contains no verification claim
(no `verified`/`success` keys); the vocabulary is documented.

Identity — **A3**:

- T11 two concurrent task calls → distinct `attemptId`s; each record's `taskToolCallId`
  matches its call and `sourceId` matches its relayed events.
- T12 no-session mode (child sessions off; and no-parent-store variant) → `childId`
  absent, transcript `disabled` / `no-parent-session`, `attemptId` present.
- T13 sessions on → `childId` equals the child session header id. Note: child
  session file names embed an INDEPENDENT UUID (the header id is generated
  separately — `manager.ts:61` + `SessionStore.create`'s default); identity is
  read from the header, never inferred from the filename.

Persistence — **A4**:

- T14 real session file: run → reopen → `collectTaskRecords` returns the record intact.
- T15 dedupe: (i) a handcrafted session with two message entries carrying the same
  `attemptId` → exactly one record; (ii) a session whose compaction entry's
  `retainedTail` contains a record copy → exactly one record (retained copies are not
  scanned).
- T16 a store-level compaction keeps the record collectible (raw entries).

Persistence disabled/failed — **A5**:

- T17 child sessions off → `{present:false, why:"disabled"}`; no resumability claim.
- T18 parent store null → `{present:false, why:"no-parent-session"}`.
- T19 pre-created read-only `children/` dir (mkdir no-ops, the first append fails) →
  outcome crash with `transcript {present:false, why:"write-failed"}`;
  `collectTaskRecords` finds the record.
- T19b session-creation failure (sessionBaseDir under a non-directory path so mkdir
  throws) → the loop's generic thrown-error result; assert the result and its `tool_end`
  event carry NO `taskRecord` (the documented no-record crash window).

Wire/display separation — **A6**:

- T20 the three provider wire regression tests: assert on the captured request body
  bytes — the body is non-empty and contains neither `taskRecord` nor the attempt id.
- T21 `tool_end` event result carries the record and the persisted history message
  carries it; `display` remains stripped (existing tests).
- T22 bounded CJK-safe truncation of `reason`/`detail` (unit, multi-byte input).

Spoof/prose independence — **A7**:

- T23 child scripted to answer with a forged usage trailer and JSON-looking text →
  record fields equal runtime values; `collectTaskRecords` ignores text.
- T24 prose independence is enforced by the builder's signature (the input type has no
  prose/output field); the unit test pins that every input field maps to the record and
  no other field exists.
- T25 branch sweep: each scenario in T1-T9 also asserts `taskRecord` is present — every
  return path (launch, pure rejection, model rejection, tool validation, worktree
  rollback) carries a record.

Red-before-green: the presence/integration tests (T1-T9, T11-T19, T21, T23) fail on the
pre-change tree because results carry no `taskRecord` — recorded as the regression
evidence in the review ledger.

## 5. Verification protocol

`npm run typecheck`, `npm run lint`, `npm run build`; targeted suites
(`test/task-record.test.ts`, `test/task-tool.test.ts`, `test/session-store.test.ts`, the
three provider suites, `test/runner.test.ts` for event relay); full `npm test`. Existing
prose tests (`taskResult` §3 contract) must stay green unchanged — the record is
additive.

## 6. Deferred / explicit limitations

- Thrown `execute` paths (session-creation failure, unexpected errors) carry no record;
  the crash window is documented and absence stays unknown (D8 makes this an explicit
  SA-06 precondition).
- Old builds (≤ v0.1.0) ignore the field entirely; no format compatibility promise is
  made (consistent with `docs/publishing-design.md` D3), but tolerance was verified.
- The record cannot prove transcript completeness (`writeFailed` reports an observed
  failure; SA-06 owns validation).
- Message entries are the record's single source; a reader that instead walks compaction
  `retainedTail` copies must dedupe by `attemptId` (the shipped collector does not read
  them).
- `reason`/`detail` truncation can cut context (bounded by design).
- The record is readable in the session JSONL like any other content; it contains paths
  and identifiers, no credentials, no message text, no tool arguments.

## 7. Review record

### Round 1 (2026-09-27) — APPROVE with required corrections (3×P1, 3×P2, 3×P3)

- **P1-1 (fixed)**: the dedupe premise misstated `retainedTail` (it holds `AgentMessage[]`
  copies, not entries) and T15 would have passed vacuously — D3 now states that message
  entries are the single source, retained copies are not scanned, and dedupe is
  defensive; T15 tests both a handcrafted duplicate entry and a `retainedTail` copy.
- **P1-2 (fixed)**: the original T19 scenario would have thrown at `createChildSession`
  (no record), not produced `write-failed` — T19 now pre-creates a read-only `children/`
  dir; T19b pins the no-record create-failure window.
- **P1-3 (fixed)**: D8 now states the SA-06 precondition explicitly (a missing record
  means not resumable, even with a child session file on disk).
- **P2-4 (fixed)**: D2 no longer implies the wrapper removes the need to audit returns —
  every return routes through `finish()`, and T25 asserts record presence per branch.
- **P2-5 (fixed)**: D8 requires event consumers to dedupe by `attemptId` across live and
  replay-re-emitted `tool_end` events.
- **P2-6 (fixed)**: D3 now enumerates the collector's validation checks.
- **P3-7/8/9 (fixed)**: D7 states the wrapper only sets the flag (control flow
  unchanged); D5 states the `worktree` presence invariant; T20 asserts on captured body
  bytes and T24 is signature-enforced.
- Corrections applied in the revision commit following round 1; implementation may start.
- **Implementation review (2026-09-27) — APPROVE, 1×LOW closed**: the reviewer
  reproduced the red/positive-control evidence, audited every return path and
  the collector, and proved the REAL runner persistence path keeps the record
  (runner onMessage → appendMessage → reopenable). The LOW finding —
  worktree-rollback rejections reported the removed worktree path as `cwd` —
  is closed: non-launched records report the parent cwd (test T9 asserts it);
  `worktree.path` remains the only field naming the removed path. The one
  informational note (`tools` array is not length-bounded) is accepted: the
  child pool is a small fixed set.

### Owner acceptance review (2026-09-27) — 2×P2, both fixed (`0cf12b9`)

- **P2-1 (fixed)**: compaction checkpoint writes were not observed — the flag was
  only set by the `onMessage` wrapper, while the child's second write path
  (`compactChildHistory → compactSession → session.appendCompaction`) failed into
  the continue-uncompacted catch without a trace. Fix: `observeSessionWrites`
  wraps the child session instance's `appendMessage` AND `appendCompaction` for
  the attempt; a throw sets the flag and is re-thrown unchanged. Regression test:
  one injected `appendCompaction` failure → status `completed`,
  `transcript.writeFailed:true`, with the later ordinary write verified by
  reopening the child file. The continue-uncompacted behavior is unchanged.
- **P2-2 (fixed)**: an unpersisted store without any observed failure (empty
  prompt + pre-aborted signal: zero writes, zero provider calls) was misreported
  as `write-failed`. New `no-content` variant; `isPersisted === false` alone
  never implies an error. Type, collector validation and this document updated;
  the real first-write-failure test (T19) unchanged.
- **Implementation-time correction (round 1, 2026-09-27)**: T13's original premise
  ("the `childId` appears in the transcript path") was wrong — child session file
  names embed an INDEPENDENT UUID chosen at creation (`manager.ts:61`), separate from
  the header id that `SessionStore.create` generates (the manager passes `undefined`
  as the id). The record carries `childId` (header) and `transcript.path` explicitly,
  so nothing depended on the premise; T13 asserts header identity only. Future
  managed-lookup designs must read the header, not infer identity from the name.
