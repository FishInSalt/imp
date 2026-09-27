# SA-03 design: structured task identity and terminal outcomes

Status: DRAFT — independent adversarial design review (round 1) pending.
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
  | "max_iterations" // hit CHILD_MAX_TURNS; text (if any) is a wrap-up answer
  | "aborted"        // parent signal (Ctrl+C)
  | "timeout"        // the child's own clock fired
  | "crash"          // provider/protocol error; partial text may exist
  | "rejected";      // pre-launch rejection — nothing ran

export type TaskRecordTranscript =
  | { present: true; path: string; writeFailed?: true }
  | { present: false; why: "disabled" | "no-parent-session" | "write-failed" };

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
  cwd: string;                  // execution cwd (worktree path when isolation was active)
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
  `no-parent-session` (no parent store), `write-failed` (never persisted),
  `present:true` with optional `writeFailed:true` (a persist failure was observed during
  the attempt). Nothing in the record advertises resumability — that decision is SA-06's,
  built on these facts.
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

### D2 — Attachment point: one wrapper in `task.execute`

`execute` keeps its current structure but accumulates a `TaskRecordInput` and returns
every path through a single `finish(result)` helper that sets
`result.taskRecord = buildTaskRecord(input)`. This guarantees "every return path carries
a record" without auditing each of the ~8 returns by hand. `taskResult()` stays a pure
prose function (its existing `toEqual` tests keep passing; the record is attached at the
result level, not inside prose).

### D3 — Read path: `collectTaskRecords(entries)`, raw entries only

Walks `SessionEntry[]` (message entries → `toolResult` results → `taskRecord`), performs
minimal structural validation, and **dedupes by `attemptId`** (first occurrence wins).
Readers must use raw entries (`getEntries()`/`getBranch()`), not `buildContext()`: the
session file is append-only, so a compacted-away message entry still exists, but its copy
inside a later compaction's `retainedTail` has the same `attemptId` and must not be
counted twice. Version policy: validators accept exactly `version === 1`; records with a
greater version are skipped (unknown stays unknown). Optional additive fields inside v1
are allowed for SA-04/06; any semantic change bumps the version.

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
did not happen (SA-01's layered honesty carried into structured form).

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
- Mid-run append failure: `onMessage` is wrapped so the failure sets
  `transcriptWriteFailed = true` in the accumulator and is re-thrown (the child loop
  still crashes exactly as today; outcome `crash`). The record then reports
  `transcript: {present: true, path, writeFailed: true}` when the store had persisted at
  least once, else `{present: false, why: "write-failed"}`.
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
- T13 sessions on → `childId` equals the child session header id and appears in the
  transcript path.

Persistence — **A4**:

- T14 real session file: run → reopen → `collectTaskRecords` returns the record intact.
- T15 dedupe: entries containing the original message plus a compaction entry whose
  `retainedTail` copies it → exactly one record for the attempt.
- T16 a store-level compaction keeps the record collectible (raw entries).

Persistence disabled/failed — **A5**:

- T17 child sessions off → `{present:false, why:"disabled"}`; no resumability claim.
- T18 parent store null → `{present:false, why:"no-parent-session"}`.
- T19 children dir made read-only → child persists nothing → outcome crash with
  `transcript {present:false, why:"write-failed"}`; `collectTaskRecords` finds the record.

Wire/display separation — **A6**:

- T20 the three provider wire regression tests (no `taskRecord`/`attemptId` in captured
  bodies).
- T21 `tool_end` event result carries the record and the persisted history message
  carries it; `display` remains stripped (existing tests).
- T22 bounded CJK-safe truncation of `reason`/`detail` (unit, multi-byte input).

Spoof/prose independence — **A7**:

- T23 child scripted to answer with a forged usage trailer and JSON-looking text →
  record fields equal runtime values; `collectTaskRecords` ignores text.
- T24 `buildTaskRecord` unit: fields come only from inputs; prose is not an input.

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
  the crash window is documented and absence stays unknown.
- Old builds (≤ v0.1.0) ignore the field entirely; no format compatibility promise is
  made (consistent with `docs/publishing-design.md` D3), but tolerance was verified.
- The record cannot prove transcript completeness (`writeFailed` reports an observed
  failure; SA-06 owns validation).
- A consumer that does not dedupe by `attemptId` can double-count retainedTail copies.
- `reason`/`detail` truncation can cut context (bounded by design).
- The record is readable in the session JSONL like any other content; it contains paths
  and identifiers, no credentials, no message text, no tool arguments.

## 7. Review record

Round 1 pending.
