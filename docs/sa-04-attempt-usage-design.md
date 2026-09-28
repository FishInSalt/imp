# SA-04 design: exactly-once attempt usage for child runs

Status: DRAFT — independent adversarial design review pending.
Branch: `feat/sa-04-attempt-usage`. Baseline: `main` @ `d80519b` (SA-01 + SA-02 + SA-03 merged).
Task list: `docs/subagent-delegation-task-list.md` §SA-04.

## 1. Problem (source-verified)

### 1.1 Where provider usage reports enter the core

- The internal event model has exactly ONE usage-bearing event: `message_end`
  ("Always the last event of a turn", `src/provider/types.ts:9-15`). All three
  adapters attach their wire usage to that message (`anthropic.ts:226-240`,
  `openai-completions.ts:382-486`, `codex-responses.ts`). One provider request
  therefore produces at most one usage report, at the core boundary.
- Usage reports enter the core through exactly two stream seams:
  `loop.ts:298` (`streamAssistant`, the task loop) and `compaction.ts:404`
  (`runSummarizer`, shared by history compaction and branch summaries).
  `logging.ts:17` is a pure pass-through decorator (logs, then yields the
  unchanged events — it neither creates nor alters reports). Inside a child run
  there is no other usage producer — `createChildSession`
  (`src/core/session/manager.ts:58-64`) is pure file I/O, and the child loop
  has no steering/follow-up queues. Branch summaries are wired only from the
  runner (`runner.ts:794`), never from a child.

### 1.2 What is wrong today

**D1 — success/aborted runs lose summarizer usage.** `runSubagent` returns the
loop-local accumulator on the direct paths (`subagent.ts:363-375`): `result.usage`
counts only `message_end` reports of that loop invocation. Every summarizer call
made by between-turn compaction during the run (`compactChildHistory`,
`subagent.ts:235`) is outside it. A child that compacts once and then completes
understates its usage by the full summarizer call.

**D2 — rejected/aborted/capped summaries discard paid usage.** `runSummarizer`
collects usage per stream (`compaction.ts:400-423`), and `summarizeWithRetry`
merges the retry hop into `retry.usage` on the accepted path (`:471`). Every
rejection path throws an error with no usage payload: abort before/after the
retry (`:460`, `:473`), token cap with no lower thinking level (`:468`), both
hops capped (`:476`), and `compactHistory`'s empty-summary throw (`:619`). The
provider was paid for those calls; the cost is discarded at the throw.

**D3 — interrupted requests are silently zero.** `streamAssistant`
(`loop.ts:296-318`) returns `null` on a mid-stream abort and throws on a stream
that ends without `message_end`; neither path produces a report, and nothing
records that a request was started without a usage report. The totals claim
completeness by omission. The task list forbids this: "preserve known totals
and disclose incompleteness. Do not guess a token count or assert that
unreported work was free."

**D4 — the crash/overflow compensation is recomputation, not production
accounting.** The crash and overflow-recovered paths rebuild totals from the
LIVE history plus a splice-compensation accumulator (`statsFromHistory`,
`subagent.ts:354-359`; `summarizedUsage`/`summarizedTurns`/`usageDelta`,
`:124-158`, `:213-215`, `:285-287`). It only counts ACCEPTED compactions
(`compacted.usage`), and a history-based recomputation cannot distinguish
messages produced by this attempt from replayed ones — once SA-06/SA-07 load
prior child history, the delta requirement ("an attempt's delta must not
include usage replayed from prior child history") is violated by construction.

**Facts relied on, not defects:**

- `store.stats()` counts branch MESSAGE entries only — "Compaction entries are
  not messages and never count" (`store.ts:780-810`). The durable cumulative
  per-session view and the per-attempt view are therefore already separate
  sources; the attempt ledger must not be derived from, or feed, cumulative
  stats.
- Adapter-internal HTTP retries (`shared.ts:104` `postJsonWithRetry`) sit below
  the `LLMEvent` seam. A retried attempt that never surfaces a `message_end`
  cannot be observed by the core — documented boundary (§4), not fixable here.
- Child task calls and summarizer calls use the SAME provider and model
  (`compactChildHistory` passes `options.provider`/`options.model`, SA-02's
  `childModelMetadata` keeps the canonical reference single-sourced).

### 1.3 Red evidence (to be written first, against baseline `d80519b`)

- **R1** success + one between-turn compaction → assert exact totals
  (task reports + summarizer report). Today: summarizer usage missing.
- **R2** rejected summary with a real usage report (empty summary; and the
  cap-retry pair) → assert both hops counted, `incomplete: false`. Today: all
  lost at the throw.
- **R3** mid-stream abort after a completed turn → assert totals preserved and
  `incomplete: true`. Today: no disclosure mechanism exists.
- **R4** loop-level delta fixture: preloaded history containing usage-bearing
  assistant messages + one new turn → ledger totals only the new report.
  Capability anchor (the seam does not exist yet); this is the SA-06/SA-07
  precondition.

## 2. Contract (interfaces frozen by this design)

### 2.1 Attempt ledger — `src/core/usage-ledger.ts` (new)

Definitions:

- **report** — one `message_end` usage value observed during the attempt.
- **started stream** — the loop or summarizer entered the provider's stream
  iteration for a request (first `next()` on the async iterable).
- **missing report** — a started stream ended (for any reason: normal end,
  abort, timeout, thrown error, protocol error) without a report.
- **incomplete** — at least one missing report occurred. It says "a report we
  waited for did not arrive"; it never claims the request was billed or not.
- **attribution** — which model produced a report is carried by the surrounding
  contract (the SA-02 `ChildModelBinding` → SA-03 `TaskRecord.binding`), never
  duplicated into the ledger. The ledger distinguishes task-loop vs summarizer
  only; both run on the child's single canonical model reference.

```ts
export type UsageReportKind = "task" | "summarizer";

export interface AttemptUsage {
  /** Reports attributed to task-assistant responses. */
  task: Usage;
  /** Reports attributed to summarizer calls (history compaction). */
  summarizer: Usage;
  /** task + summarizer, maintained incrementally: snapshot invariant. */
  totals: Usage;
  /** Task-assistant reports observed — equals task turns produced. */
  taskReports: number;
  /** Summarizer provider streams started (reported or not). */
  summarizerCalls: number;
  /** At least one started stream produced no usage report. */
  incomplete: boolean;
}

export interface AttemptUsageSnapshot {
  totals: Usage;
  task: Usage;
  summarizer: Usage;
  taskReports: number;
  summarizerCalls: number;
  incomplete: boolean;
}

export function createAttemptUsage(): AttemptUsage;
export function recordSummarizerCall(ledger: AttemptUsage | undefined): void;
export function recordUsageReport(ledger: AttemptUsage | undefined, kind: UsageReportKind, usage: Usage): void;
export function recordMissingUsageReport(ledger: AttemptUsage | undefined): void;
export function attemptUsageSnapshot(ledger: AttemptUsage): AttemptUsageSnapshot;
```

All three usage buckets start as `emptyUsage()` ({inputTokens: 0,
outputTokens: 0}, no cache keys) and are updated with `addUsage` — byte-identical
shapes to today's loop accumulator for every existing fixture. Every recording
function accepts `undefined` (no-op): the seam is optional everywhere.

### 2.2 `SubagentOutcome` (engine-level; `src/core/subagent.ts`)

```ts
export interface SubagentOutcome {
  status: SubagentStatus;
  text: string | undefined;
  reason?: string;
  turns: number;            // task turns produced in THIS attempt (unchanged meaning)
  usage: Usage;             // attempt totals: task + summarizer reports received
  usageDetail: {            // new
    task: Usage;
    summarizer: Usage;
    summarizerCalls: number;
    incomplete: boolean;
  };
}
```

Invariants: `usage` = `usageDetail.task + usageDetail.summarizer` componentwise;
`turns` = ledger `taskReports`; summarizer calls never inflate `turns`.

### 2.3 SA-03 record fill (frozen shape; no SA-03 code change)

`TaskRecordUsage` (`task-record.ts:53-61`) already reserves `incomplete?: true`
for exactly this task, and `isUsage` (`:225-235`) accepts it. Mapping in
`task.ts`:

```ts
usage: outcome.usageDetail.incomplete
  ? { ...outcome.usage, incomplete: true }
  : outcome.usage,
```

Zero-report attempts stay byte-identical to today (no `incomplete` key;
`{inputTokens: 0, outputTokens: 0}`). Attribution is persisted by the record's
existing `binding` (SA-02/SA-03 contract). The trailer
(`childUsageTrailer`, `subagent.ts:452-455`) format is unchanged; its numbers
grow for compacting runs — that is the D1 fix, not a format change.

Note for SA-05: the usage stored on compaction entries
(`appendCompaction(..., result.usage)`, `compaction.ts:661`) is checkpoint data
for the accepted run only. It must never be summed with record totals — the
attempt ledger is the exactly-once source.

### 2.4 Decisions adopted (owner-delegated after source review, 2026-09-27)

- **`incomplete` semantics: conservative (A).** Any started stream without a
  report sets the flag; attempts that never started a stream (pre-abort) stay
  clean zero. Rationale: the requirement forbids asserting unreported work was
  free, the core cannot distinguish "request never left the machine" from
  "answered then truncated", and this mirrors the SA-03 acceptance precedent
  (report observed facts — "a report did not arrive" — never infer more).
  Consequence: connection-class crashes carry `incomplete: true` (disclosure
  of uncertainty, not an error claim).
- **The task/summarizer split is engine-level only** (`SubagentOutcome`). The
  SA-03 record shape stays frozen; extending a merged, accepted contract needs
  a new owner decision, and nothing in SA-04's acceptance requires the split to
  be persisted.
- **Scope is the child path only.** The runner and branch summaries are not
  wired (they keep today's behavior); the optional seam lets SA-05 wire the
  main loop without rework.
- **`turns` keeps its meaning** (task turns; summarizer calls only extend
  `usageDetail`) — an explicit task-list requirement, not a choice.

## 3. Design

### 3.1 Loop seam (`src/core/loop.ts`)

- `RunAgentLoopOptions` gains `usageLedger?: AttemptUsage` (optional; the main
  runner never passes it → zero behavior change there).
- `streamAssistant` gains `ledger?: AttemptUsage` and records atomically with
  its existing accumulator:

```ts
let reported = false;
try {
  for await (const event of provider.stream(request)) {
    if (request.signal?.aborted) return null;         // mid-stream abort
    onEvent?.(event);
    if (event.type === "message_end") {
      reported = true;
      addUsage(usage, event.message.usage);           // existing accumulator
      recordUsageReport(ledger, "task", event.message.usage);
      return { ...event.message, model: request.model };
    }
  }
  if (request.signal?.aborted) return null;
  throw new Error("Provider stream ended without a message_end event");
} finally {
  if (!reported) recordMissingUsageReport(ledger);    // started, no report
}
```

- A request is "started" exactly when the `for await` is entered; the
  top-of-loop `signal?.aborted` return happens before `streamAssistant` and
  therefore never marks.
- `runAgentLoop`'s returned `usage` and all stop reasons are unchanged.

### 3.2 Summarizer seam (`src/core/compaction.ts`)

- `runSummarizer` gains `usageLedger?: AttemptUsage`; at entry
  `recordSummarizerCall(ledger)`; on each `message_end`
  `recordUsageReport(ledger, "summarizer", event.message.usage)`; the same
  `try/finally` + `reported` pattern marks a missing report on every exit
  without one (abort, provider throw, protocol error). Recording happens at
  the stream seam, so it is immune to every downstream rejection.
- `summarizeWithRetry` passes the ledger to BOTH hops; the merged
  `retry.usage` return stays exactly as is — it feeds the compaction entry's
  persisted usage, not the ledger (no double count: the ledger counts
  per-stream, the merge happens only on the return value).
- `compactHistory` and `compactSession` gain optional `usageLedger` and thread
  it down. `summarizeBranchSegment` is NOT wired (branch summaries are not a
  child path; adding a dead parameter is avoided).

### 3.3 Subagent wiring and deletions (`src/core/subagent.ts`)

- `runSubagent` creates `const ledger = createAttemptUsage()` and passes
  `usageLedger: ledger` into `launchLoop` (both the first and the
  overflow-recovery invocation) and into `compactChildHistory`
  (`compactSession`/`compactHistory` options).
- DELETED: `usageDelta`, `addUsageIntoNew`, `historyStats`, `summarizedUsage`,
  `summarizedTurns`, `summarizedAny`, `statsFromHistory`, and the pre/post
  `historyStats` bookkeeping inside `compactChildHistory`. The unused-import
  fallout is handled at implementation.
- All outcome returns become uniform:

```ts
const snapshot = attemptUsageSnapshot(ledger);
const settled = (status: SubagentStatus, reason?: string): SubagentOutcome => ({
  status,
  reason,
  text: finalAssistantText(history),
  turns: snapshot.taskReports,
  usage: snapshot.totals,
  usageDetail: {
    task: snapshot.task,
    summarizer: snapshot.summarizer,
    summarizerCalls: snapshot.summarizerCalls,
    incomplete: snapshot.incomplete,
  },
});
```

### 3.4 Equivalence argument (why no pinned value changes)

`turns` — 1:1 with `message_end` production on every path: the loop increments
`turns` iff a message was returned, which is iff its report was recorded
(`loop.ts:171-173`); the crash path's `historyStats` counted exactly the
assistant messages in history, all produced by this attempt; compaction splices
never remove the loop's counter and the ledger never decrements. Therefore
`turns == snapshot.taskReports` on every path, including overflow recovery.

`usage` — for every fixture whose compaction calls were accepted and whose
requests were not interrupted, totals equal today's numbers: direct paths gain
exactly the missing summarizer reports (D1/D2 fix), crash/overflow paths
reproduce the recomputation's value plus previously discarded rejected-call
usage. Pinned tests to verify byte-for-byte: `test/subagent.test.ts:157`
(crash 100/7), `:260-270` (overflow 160/17), `test/child-compaction.test.ts:534`
(crash-after-compaction 1500+500+3). Any mismatch is a bug in the ledger
wiring, not an acceptable change.

### 3.5 `task.ts` mapping

One expression (§2.3) at the terminal construction (`task.ts:495`). No other
task-tool change; the trailer call (`:603`) is untouched.

## 4. Edge cases and threats

- **Abort racing a buffered `message_end`**: `streamAssistant` checks
  `signal?.aborted` BEFORE the event, so an event already buffered is dropped
  by the existing "abort wins" rule. The ledger then reports a missing report
  (`incomplete: true`) rather than counting a report the attempt discarded —
  conservative, honest, and it does not touch the pinned abort semantics.
- **Pre-aborted attempts / empty prompt**: no stream is started → clean
  `{0,0}`, `incomplete: false`. Matches SA-03 acceptance case P2-2 today.
- **Multiple `message_end` in one stream** (contract violation): recorded
  per event exactly as the existing accumulators do (`loop.ts:302`,
  `compaction.ts:415`) — no divergence between the two.
- **Overflow recovery**: the retry loop shares the ledger; no message is
  replayed through `streamAssistant`, so no double count.
- **Cap-retry**: first hop's report + retry hop's report are both recorded;
  the entry's merged usage is a separate artifact and is not re-recorded.
- **Empty-summary rejection**: the report is recorded before the throw; the
  child continues un-compacted (behavior unchanged).
- **Connection-class crash**: a started stream throws before any event →
  `incomplete: true` (§2.4 A; documented consequence).
- **Adapter-internal retries** (`postJsonWithRetry`): invisible below the
  seam. A retried-then-failed sequence ends without a report → the LAST
  started stream marks incomplete; usage of earlier retried attempts (if any
  was billed) is not countable. Explicit boundary; the flag is the honest
  signal that totals may understate.
- **Ledger lifetime**: created per `runSubagent` call; snapshots are deep
  copies; nothing is persisted or statically shared, so resume attempts
  (SA-06/07) start from zero by construction.

## 5. Behavior-change inventory (documented, intended)

1. Success/aborted runs with compaction: usage totals and the model-visible
   trailer now include summarizer reports (D1 fix).
2. Rejected/capped/aborted/empty summaries: usage is retained (D2 fix).
3. Interrupted requests: `incomplete: true` (new honest signal, D3 fix).
4. Crash/overflow paths: totals unchanged except the newly retained rejected
   calls; turns unchanged.
5. Zero-start attempts: unchanged (clean zero, no `incomplete` key in records).
6. Main runner and branch summaries: unchanged (no ledger passed).
7. `compactHistory`/`compactSession`/`summarizeWithRetry` return values:
   unchanged shapes and semantics.

## 6. Test plan

### 6.1 Red evidence (first implementation commit, verified red on `d80519b`)

R1-R4 as §1.3. R4 is anchored as a capability test (disclosed, like SA-03's
T19b). Red verification uses a `/tmp` worktree of `main` plus the new tests.

### 6.2 New and updated tests

- `test/usage-ledger.test.ts` (new): recording semantics; totals invariant
  (`totals` == `task` + `summarizer` componentwise after arbitrary
  interleavings); started-call counting; missing-report flagging; snapshot
  copies (mutating the ledger afterwards does not change the snapshot).
- `test/loop.test.ts`: ledger delta fixture (R4) — preloaded history with
  usage-bearing assistant messages, one new turn via `message_end` → ledger
  totals equal the new report only; plus a missing-report case (stream ends
  without `message_end`: abort-safe provider) → flag set, accumulator
  unchanged.
- `test/subagent.test.ts`: existing crash/overflow/trailer tests keep their
  exact numbers; add `usageDetail` assertions; mid-stream abort-after-turn →
  totals preserved + `incomplete: true`; timeout mid-stream → same;
  no-compaction success → `usageDetail.summarizer` = 0 and
  `summarizerCalls` = 0.
- `test/child-compaction.test.ts`: R1 exact totals (success + one compaction);
  multiple compactions summed exactly; R2 (empty-summary rejection counted;
  cap-retry both hops counted); abort during summarizer → report missing →
  `incomplete: true` with prior totals intact; crash-after-compaction keeps
  `1500 + 500 + 3` and gains `usageDetail.summarizer == 3`.
- `test/task-tool.test.ts` (SA-03 integration): a mid-stream-interrupted
  attempt persists `usage.incomplete: true`; a clean attempt's record has no
  `incomplete` key; a compacting attempt's record usage equals the engine
  totals (task + summarizer) and still carries `binding.reference`
  (attribution).

### 6.3 Acceptance mapping (task list §SA-04)

| Acceptance item | Covered by |
| --- | --- |
| Exact token assertions: success without compression; with one/multiple compactions | subagent + child-compaction R1 tests |
| Retained tails and removed messages neither lost nor double counted | crash-after-compaction exact fixture; multi-compaction sums |
| Overflow / compact-and-retry / retry failure / cap / abort / timeout / crash use one rule | existing M7 describe kept + new `incomplete` variants |
| Retries/rejected summaries count available reports; missing report → marker, never guessed | R2, R3, thinking-retry tests, ledger unit tests |
| Input/output/cache components and producer attribution preserved | per-component asserts on totals and split; record test asserting `binding.reference` alongside usage |
| Historical-usage fixture yields only the new attempt delta | loop-level R4 |

## 7. Out of scope / deferred (explicit)

- Main runner loop and branch-summary ledger wiring, and any main-session
  accounting (SA-05, "total work usage"). `store.stats()` including summarizer
  usage is SA-05's presentation decision; compaction entries stay
  checkpoint-only.
- Persisting the task/summarizer split (record shape frozen by SA-03).
- Pricing/cost arithmetic (SA-05).
- Visibility of adapter-internal retry usage (§4 boundary).
- Child turn/timeout/budget policy — untouched by this task.

## 8. Verification

Gates on the branch: `npm run typecheck`, `npm run lint`, `npm run build`,
full `npm test` (baseline 110 files / 2122 tests). Red evidence recorded before
implementation; independent adversarial implementation review after; ledger
entry `#sa-04-attempt-usage` appended to `PROJECT_PLAN.md`; merge to `main`
only via `--no-ff` after owner acceptance.
