# SA-05 design: durable parent-plus-child work usage

Task list item: SA-05 ("Persist and display total work usage without corrupting
context metrics") — `docs/subagent-delegation-task-list.md` §SA-05.
Branch: `feat/sa-05-usage-totals`. Date: 2026-09-27. Baseline: `8115822`
(SA-04 merged).

Owner decisions taken before this draft (session 2026-09-27, all confirmed in
prose):

- **D1** Work cost scope = whole session (branch-independent); context occupancy
  stays active-branch.
- **D2** The authoritative source for child cost is the persisted managed task
  records (SA-03/04); child session transcripts are never re-read.
- **D3** No new entry types, no sidecar, no aggregate checkpoint: the aggregate
  is a derived view, rebuilt once per session open and maintained incrementally
  from newly appended entries.
- **D4** Pricing is per-producer-model, using the current catalog rates; unknown
  attribution is *unpriced*, never fallback-priced at the parent's or the
  current model's rates. Money is an estimate, not an invoice.
- **D5** Display consumers switch to the aggregate (footer, headless session
  line, `/status` session line); `SessionStore.stats()` semantics are frozen.
- **D6** SA-05 lands before SA-06 (serial; SA-05's store.ts touch is the
  `appendBranchSummary` stamping argument + two additive entry fields).

Design decisions introduced by this document (flagged for review):

- **L1** Legacy-entries rule (§4.6): pre-SA-05 entries are counted as reported
  values and are *not* retroactively flagged incomplete; they are unpriced when
  they carry no model stamp.
- **L2** A failed main-session summarizer call leaves no entry, so its usage is
  not durable (§4.6, limitation).
- **L3** (narrowed by round-1 review) A task tool-result without a parsable
  record is a *visible* incompleteness signal (§4.1.2b). The only remaining
  unobservable window is a SIGKILL between child completion and any parent-side
  write — nothing is persisted at all (§4.6, residual limitation).

## 1. Problem (source-verified)

### 1.1 What exists today

- **Footer** (`src/repl/repl.ts:841`): every render recomputes `↑/↓/R/W/$` by
  summing `runner.history` (the live active context) assistant messages; `$`
  prices each message at `costFor(m.model ?? this.runner.model)`
  (`repl.ts:873`). After a compaction the live history no longer contains the
  compacted-away assistant messages — their usage disappears from the footer.
- **Child usage** is persisted (`TaskRecord.usage`, SA-03/04) but no display or
  aggregate consumes it; it survives only as prose inside task results.
- **Summarizer usage** for main-session compaction is persisted on
  `CompactionEntry.usage` (`store.ts:87`, written by `compaction.ts:688` →
  `store.ts:504`) and consumed by nothing. **Branch summaries drop usage
  entirely**: `BranchSummaryEntry` (`store.ts:82`) has no usage field and
  `appendBranchSummary(summary)` (`store.ts:699`) takes no usage. The call
  site (`runner.ts:794`) receives only the summary string today —
  `summarizeBranchSegment` returns `run.summary.trim()` (`compaction.ts:541`)
  and discards `run.usage` internally, so SA-05 extends its return value
  (§3.3) before the runner can stamp the entry.
- **Headless** `printSessionStats()` (`runner.ts:1241`) and `/status`
  (`src/repl/commands.ts:1762`) print `stats()` (`store.ts:785`) — active-branch
  message entries only. Their "cumulative" figures are branch-scoped and blind
  to children and summarization.
- **Session storage** keeps all entries in memory (`store.ts:231`, `getEntries()`
  at `:447`); the file is append-only and compaction entries never remove
  message entries, so every usage fact that was ever persisted is still
  readable — this is the foundation D3 builds on.

### 1.2 What is wrong

1. **No durable work total.** Any answer to "what did this session cost" is
   branch-scoped, lost across compaction, and blind to children + summaries.
2. **Two scopes conflated.** Context occupancy (active branch, feeds the ctx%
   segment and compaction thresholds) and work expenditure (everything that was
   ever paid for) are different quantities; only the first has a defined home.
3. **Same-class honesty gaps as the SA-04 P1**:
   - `runSummarizer` (`compaction.ts:404`) collects usage into the runtime
     attempt ledger, but when the summarizer never reported usage the persisted
     `CompactionEntry.usage` is initialization `{0,0}` — indistinguishable from
     an explicit zero report;
   - pricing falls back to the *current* model for messages without `model`
     (`repl.ts:873`) — a model switch silently reprices history. The task list
     forbids this ("Unknown pricing is unknown/partial, not zero or silently
     priced at the parent's current model") and the acceptance list forbids it
     for child work specifically;
   - the branch-summary write site discards usage evidence before persistence.

### 1.3 Red evidence target (written first, against baseline `8115822`)

- **R1** After a main-session compaction, the footer loses the pre-compaction
  usage (it recomputes from live history) — red.
- **R2** Child usage is absent from every session-level number (scripted task
  record; footer/session-line path) — red.
- **R3** Module anchor (SA-04 R4 convention): `src/core/usage-totals.js` does
  not exist — type-level red, disclosed as an anchor rather than a behavior
  oracle.

Exact assertions are pinned in the first implementation commit.

## 2. Definitions (scopes, frozen)

| Scope | Definition | Consumed by |
|---|---|---|
| current attempt | one task-tool execution's usage — the SA-04 attempt ledger | runtime only (SA-04); durable via the task record |
| logical child | sum over all task records sharing `childId` (all attempts; SA-07 continuations append new records) | derivable from `childId`; no SA-05 display surface |
| active conversation branch | entries reachable from the current leaf | ctx%, compaction thresholds, CH%, `stats()` — **unchanged** |
| whole session | every entry in the session file, all branches | the durable work-cost aggregate (this design) |

**Rule (D1):** work cost is whole-session and branch-independent — switching
branches must not make already incurred calls disappear. Context metrics remain
active-branch. The two scopes are structurally separate: the aggregate never
feeds `estimateContextTokens`, `shouldCompact`, or `stats()`.

## 3. Contract (frozen by this design)

### 3.1 New module `src/core/usage-totals.ts` (pure)

No runtime dependency on provider modules; pricing is injected as a rate
lookup so unit tests use fake tables and the core stays data-in, data-out.

```ts
export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Contributing calls: assistant messages / task records / summary calls. */
  calls: number;
}

export interface ModelUsage {
  /** Producer reference as stamped (message.model / record.binding.reference /
   *  summary entry .model); null = legacy entry without a stamp. */
  reference: string | null;
  bucket: UsageBucket;
}

export interface UsageTotals {
  parent: UsageBucket;      // assistant message entries (all branches)
  child: UsageBucket;       // task records (all attempts, deduped) — INCLUDES
                            // the child's own summarizer usage: TaskRecord.usage
                            // is the attempt-ledger total (task + summarizer,
                            // subagent.ts:332), so it is counted exactly once
  summarizer: UsageBucket;  // MAIN-session compaction + branchSummary entries
                            // only — child-session compaction entries live in
                            // the child file and are unreachable from the
                            // parent scan (their usage travels in the record)
  total: UsageBucket;       // parent + child + summarizer
  byModel: ModelUsage[];    // first-seen order (cosmetic; deterministic)
  incomplete: { parent: boolean; child: boolean; summarizer: boolean };
}

/** Rate shape taken from ModelCost (type-only import); injected so the module
 *  needs no provider runtime. undefined = unknown rate. */
export interface RateLookup {
  (reference: string): { input: number; output: number; cacheRead: number; cacheWrite: number; subscription?: boolean } | undefined;
}

export interface PricedUsageTotals {
  usd: number;              // known-rate money only
  subscription: boolean;    // any priced usage at a subscription-backed model
  unpriced: UsageBucket;    // counted usage without a resolvable rate
  byModel: Array<ModelUsage & { priced: boolean; subscription: boolean }>;
}

export interface UsageTotalsTracker {
  /** Syncs newly appended entries (cursor) and returns the current view.
   *  Idempotent: repeated calls without new entries return the same value. */
  view(): UsageTotals;
}

/** Builds a tracker over the store's live entry array (in-memory). */
export function usageTotalsTracker(entries: readonly SessionEntry[]): UsageTotalsTracker;

/** Pure price application; callers pass a bound `costFor`. */
export function priceUsageTotals(totals: UsageTotals, rateFor: RateLookup): PricedUsageTotals;
```

Supporting refactor (no behavior change): export a per-entry helper from
`src/core/task-record.ts` — `taskRecordsInEntry(entry: SessionEntry): TaskRecord[]`
over the existing private parser. Contract (pinned, review P2): the helper
returns validated records **in entry order and does not dedupe**;
`collectTaskRecords` keeps the single cross-entry `seen` set (behavior
unchanged); the tracker keeps its own `Set<attemptId>` spanning entries — never
reset per entry, never per sync.

### 3.2 Entry format additions (additive; readers ignore unknown fields)

`parseEntryLine` validates only `summary` for compaction/branchSummary entries
(`store.ts:197-203`) and returns the entry as-is, so additive fields are
tolerated by old readers (the `taskRecord`/header-field precedent).

```
CompactionEntry    + usageMissing?: true  + model?: string   (usage already exists)
BranchSummaryEntry + usage?: Usage        + model?: string  + usageMissing?: true
```

- `model` = the model reference string the summarizer call used (`costFor`-
  compatible canonical or bare; same value passed to the provider).
- `usage` mirrors `AssistantMessage` semantics (SA-04 round 2): the sum of
  arrived reports (zeros when none arrived); `usageMissing: true` iff at least
  one started stream never delivered a report. This is written by the SA-05
  stamping code; legacy entries lack both fields (rule L1).

Store API extension (optional-argument pattern, like `appendCompaction` today):

```ts
appendCompaction(summary, retainedTail, tokensBefore, usage?,
                 stamps?: { model?: string; usageMissing?: true }): string;
appendBranchSummary(summary, usage?,
                    stamps?: { model?: string; usageMissing?: true }): string;
```

`task.ts:209`'s `appendCompaction(...args)` relay keeps compiling (it forwards
the added optional argument).

### 3.3 Summarizer result plumbing

`SummarizerRun` (`compaction.ts:379`) gains `usageMissing: boolean` (per call;
set in the same places that call `recordMissingUsageReport`).
`summarizeWithRetry` combines hops (`usage = addUsage(hopA, hopB)`,
`missing = hopA.missing || hopB.missing` — mirroring the ledger's
accumulate-identically semantics); a test must assert the merged numbers and
the OR'd flag agree on the cap-retry path.

Two public results change shape:

- `CompactHistoryResult` gains `usageMissing` (compaction.ts already returns
  `usage`);
- `summarizeBranchSegment` currently returns `string` (`compaction.ts:541`);
  it will return `{ summary, usage, usageMissing }` (or equivalent) so the
  runner can stamp the branchSummary entry (§4.4). Its caller
  (`runner.ts:794`) is adjusted.

### 3.4 Runner accessor

`runner.usageTotals(): UsageTotals | null` — null when no session
(`--no-session`). Lazily creates a tracker over `session.getEntries()` (the
in-memory array) and recreates it when the session store instance changes
(resume / `/new` / reload). `view()` is O(new entries), no disk I/O, no
transcript rescans.

### 3.5 Display consumers

- `repl.ts::refreshFooter()` — the usage segment reads the priced aggregate
  (§4.5); CH% and the ctx% logic stay live-history/estimate based. **Sync
  point (review P1):** `refreshFooter` keeps its existing `#footer-per-turn`
  cadence (`repl.ts:654-656` on every assistant `message_end`, plus the settle
  sites `:950`/`:967`); the aggregate syncs inside every refresh call
  (O(new entries), no new triggers). A task result therefore becomes visible
  at the next footer refresh, i.e. the next assistant `message_end` or the
  run settle — exactly the cadence the footer already has for ctx%.
- `runner.ts::printSessionStats()` (headless) and `commands.ts` `/status`
  session line — `in/out` switch to the aggregate (`work in X / out Y` +
  money + markers); `N msgs` stays `stats()`-based and labeled as the active
  branch.
- Per-run line (`runner.ts:1232`) unchanged (run-scoped fact).
- `stats()` and all its consumers unchanged.

## 4. Design

### 4.1 Evidence model (what counts, exactly once)

Scan = `session.getEntries()` — all entries, all branches:

1. `message` + `role: "assistant"` → parent bucket: +usage, priced at
   `message.model` (absent → `reference: null` → unpriced, L1).
   `message.usageMissing === true` → parent incomplete (numbers still counted —
   SA-04 round-2 semantics).
2. `message` + `role: "toolResult"` → for each result's validated `taskRecord`
   (deduped by `attemptId`) → child bucket:
   - `launched !== true`: contributes nothing; absent usage is **not**
     incomplete (no call ran);
   - `launched` + `usage` present: +usage, priced at
     `record.binding?.reference ?? null`; `usage.incomplete === true` → child
     incomplete;
   - `launched` + `usage` absent: child incomplete (unknown work), no numbers;
   - **(2b, review P1)** a result with `toolName === "task"`
     (`tools/task.ts:250`) whose `taskRecord` is absent or fails validation:
     **child incomplete** (no numbers). This is the visible form of L3 — it
     covers SA-03's no-record exception paths and the synthetic closers
     `persistMissingToolResults` writes on force quit
     (`runner.ts:1251-1263`, callers `repl.ts:1351`, `cli.ts:871`).
     In-flight task calls (a `toolCall` with no result yet) are deliberately
     **not** flagged: that is the normal state during a live run, and the
     durable signal arrives with the real or synthetic result.
3. `compaction` entry → summarizer bucket (main session only): +`usage` (if
   present), priced at `entry.model`; `entry.usageMissing === true` →
   summarizer incomplete; usage present without `model` → legacy (L1).
4. `branchSummary` entry → same as 3.

**Never counted** (each with its reason):

- child session transcripts (D2 — the record is authoritative; reading both
  would double count);
- `retainedTail` copies inside compaction entries (they duplicate messages that
  already exist as entries — same rationale as the `task-record.ts` header);
- framed user messages (`summaryToMessage` / `branchSummaryToMessage`);
- `display` events and tool-result prose;
- non-source entries (`thinkingLevelChange`, `session_info`, `label`).

### 4.2 Tracker algorithm (rebuild + cursor; idempotence argument)

```
usageTotalsTracker(entries):
  cursor = 0; totals = empty(); seenAttempts = Set()
  view():
    while cursor < entries.length: applyEntry(totals, entries[cursor++])
    return frozen snapshot (cached until the next sync)
```

- **Rebuild** (session open / reload / resume) = a fresh tracker over the same
  entries → identical result (application is pure and additive; only
  `byModel`'s *order* is first-seen and documented as cosmetic).
- **Repeated render**: no new entries → cached snapshot, zero work.
- **Replay safety**: nothing enters the totals outside the entry loop; entries
  are append-only and applied exactly once by the cursor. There is no second
  runtime path that could double count a fact that is also read from
  persistence — this is the SA-05 interpretation of "update from runtime
  records": the records are consumed as they become entries.
- **Cost**: `sync` is O(new entries); the footer's per-render call does no
  rescan of history or files.

### 4.3 Pricing rules (D4)

- `costFor(reference)` (`models.ts:141`) accepts canonical or bare references;
  `undefined` = unknown. Rates come from the shipped catalog/static table —
  *current* rates, not historical snapshots: money is an estimate at current
  rates, explicitly not an invoice (documented in the record/README and the
  footer comment).
- References: parent `message.model`; child `record.binding.reference`;
  summarizer `entry.model`. **No fallback to the parent or current model in
  any case.**
- A reference without a rate (or `null`) contributes to `unpriced` and to the
  `byModel` entry with `priced: false`; `usd` sums priced usage only.
- `subscription: true` iff any priced usage belongs to a subscription-backed
  model (`ModelCost.subscription`); the footer's `( sub)` tag semantics are
  preserved (one tag, as today).
- Money math identical to today's footer (`/ 1_000_000`, three decimals at
  display).

### 4.4 Persistence stamping

- `compactSession` (`compaction.ts:688`): passes `result.usage`,
  `model = args.model`, `usageMissing = result.usageMissing` into
  `appendCompaction`.
- Branch summaries (`runner.ts:794` → `appendBranchSummary`): passes
  `result.usage`, `model = this.model`, `usageMissing = result.usageMissing`.
- The runtime attempt ledger (`recordMissingUsageReport` etc.) is untouched —
  SA-04 semantics are the runtime counterpart of the same facts.
- Failed main-session summarizer calls never produce an entry (a rejected/capped
  summary must not be persisted) — their usage is not durable; see L2.

### 4.5 Display

Footer usage segment (whole-session aggregate; same visual shape as today):

- `↑i ↓o`, `R…`, `W…` from `total` (shown when > 0, as today);
- **segment presence predicate restated (review P1):** the money segment
  renders whenever `usd > 0 || subscription || unpriced nonzero || any
  incomplete flag` — the last two disjuncts are new (the old code gated on
  `cost > 0 || subscription` only, `repl.ts:899`);
- money segment rules:
  | priced sum | unpriced usage | incomplete | segment |
  |---|---|---|---|
  | > 0 or subscription | none | no | `$0.123` / `$0.123 (sub)` |
  | > 0 or subscription | present | — | `~$0.123` (partial pricing) |
  | > 0 or subscription | — | yes | `$0.123!` |
  | > 0 or subscription | present | yes | `~$0.123!` |
  | 0, no subscription | present | no | `$?` (unknown money) |
  | 0, no subscription | present | yes | `$?!` |
  | 0, no subscription | none | yes | `$?!` (incomplete with no known usage) |
  | 0, no subscription | none | no | segment omitted (as today) |

- `~` = partial pricing, `!` = known-missing usage; both defined here so the
  headless line and `/status` reuse the same formatter.
- CH% (last-response cache hit) and the ctx% segment are unchanged — both
  remain live-history/estimate facts (task list: child usage must not affect
  them).

Headless session line / `/status` line: same aggregate + formatter; the message
count stays `stats()`-based and reads "msgs (active branch)" so the two scopes
are labeled, not mixed.

### 4.6 Legacy rule and incompleteness taxonomy

**L1 (legacy provenance).** Pre-SA-05 entries are counted as reported values
and are *not* flagged incomplete. Justification: the pre-SA-05 writers could
not distinguish "no usage report" from "explicit zero" (the SA-04 P1 shape), so
per-entry retroactive incompleteness cannot be established; flagging every
historical entry would make the flag meaningless. Their pricing follows D4:
without a `model` stamp they are rendered unpriced (partial marker), never
repriced at the current model. Approved-by-review state: this is a
*deliberately chosen* conservative-for-display / permissive-for-flag rule, and
the limitation is documented rather than hidden.

| Evidence | Effect |
|---|---|
| assistant `usageMissing: true` | parent incomplete; numbers counted |
| task record `usage.incomplete: true` | child incomplete; numbers counted |
| task record launched, no `usage` | child incomplete (unknown work) |
| task record not launched | nothing (no call ran) |
| summary entry `usageMissing: true` | summarizer incomplete |
| legacy entry (pre-SA-05) | counted as reported (L1); unpriced without `model` |
| reference with no rate | `unpriced` + partial marker (pricing unknown ≠ accounting unknown) |
| task tool-result without a parsable record | child incomplete — visible (rule 2b) |
| SIGKILL between child completion and any parent-side write | nothing in the file → not detectable (narrowed L3 residual; SA-06 registry = future reconciliation source) |
| failed main-session summarizer call | no entry → usage not durable (L2; child-side summarizer failures ARE durable — the SA-04 ledger folds them into the record's totals) |

## 5. Edge cases and threats

1. **Double counting**: transcripts never read; `retainedTail` never scanned;
   `attemptId` dedupe (incremental set); cursor applies each entry once.
2. **Resume/reload**: fresh tracker, identical rebuild; the resume banner
   (`runner.ts:550`) stays context-scoped and is not an accounting surface.
3. **Branch switching**: `getEntries()` spans all branches; totals are
   invariant under leaf moves; ctx is untouched (tested).
4. **`/new`, `--no-session`**: tracker recreated on store swap; accessor null
   without a session.
5. **Hand-edited files**: duplicate `attemptId`s deduped; malformed records
   skipped by the existing validator (`parseTaskRecord` → null → skipped;
   unknown stays unknown).
6. **Scale**: memory = seen-attempt set + models list; sync O(new entries);
   no per-render rescans (task list requirement).
7. **Money precision**: per-model buckets priced with the same formula as
   today; display rounds to 3 decimals; no new currency.
8. **No-record visibility (rule 2b)**: synthetic closers
   (`persistMissingToolResults`) have `toolName === "task"` and no record, so
   the child bucket goes incomplete at the next sync — deliberate; scoped to
   results, so mid-run in-flight calls never flash the marker.
9. **SA-07 precondition** (recorded for the later integration): a continued
   child must append a *new* task record (new `attemptId`) carrying only its
   attempt delta; the aggregate then adds it exactly once with **no SA-05
   change**. SA-07 must not mutate or rewrite earlier records (append-only
   file) and must not re-report lifetime usage.
10. **Ordering**: sums are commutative; `byModel` order is first-seen and
    cosmetic; tests must not depend on catalog rate *values* except where a
    fake `RateLookup` is injected.

## 6. Behavior-change inventory (visible, intended)

1. Footer `↑/↓/R/W/$` become whole-session totals (children + summarization +
   all branches) and no longer shrink at compaction (R1 fix).
2. Child and summarizer usage become visible in the footer and session lines
   (R2 fix).
3. Unstamped legacy usage shows the unpriced marker instead of being repriced
   at the current model (`repl.ts:873` behavior replaced).
4. The `$` segment can carry `~` / `!` / `$?` markers.
5. Headless session line and `/status` switch their `in/out` scope (labeled).

**Pinned tests and docs updated intentionally (review P1):**

- `test/repl-status.test.ts:314-320` ("models outside the cost table omit the
  `$` segment entirely") → the same run now renders `$?` (usage present, rate
  unknown). The test is updated to the new predicate above, not deleted.
- `test/repl-commands.test.ts:786` and `test/runner.test.ts:313` pin the exact
  `cumulative` session-line strings → updated to the new line (work scope +
  markers), with `msgs (active branch)` labeling.
- `docs/m3-repl-design.md:679` documents the old session-stats line → updated
  to the new contract (the line's scope changes are recorded there).

Unchanged: `stats()`, ctx%, compaction triggers, CH%, the per-run line, session
file compatibility (additive fields only), provider request bodies.

## 7. Test plan

### 7.1 Red evidence (first implementation commit, verified red on `8115822`)

- **R1** footer after compaction retains pre-compaction usage.
- **R2** child usage visible in session-level totals.
- **R3** `usage-totals.js` module anchor (capability red, disclosed as such).

### 7.2 New and updated tests

- **`test/usage-totals.test.ts`** (new, unit): exact per-source buckets;
  write→rebuild equality; incremental == batch; repeated `view()` idempotent;
  `attemptId` dedupe; branch independence (abandoned-branch entries counted);
  taxonomy table cases; pricing with fake `RateLookup` (unknown → unpriced,
  subscription flag, **no fallback**: a binding-less record is unpriced even
  when the parent model has rates); `taskRecordsInEntry` refactor pinned by the
  existing `task-record` tests.
- **`test/compaction.test.ts` / `test/child-compaction.test.ts`**: stamps
  written (model + usageMissing: reported / missing / both-hops-capped cases;
  merged usage and the OR'd flag must agree); rejected summaries still persist
  nothing (existing pin); **child-compaction-exactly-once**: a child that runs
  its own compaction contributes its summarizer tokens exactly once — through
  `TaskRecord.usage`, never through a main-session summarizer entry (the
  "compaction does not erase incurred work" acceptance case).
- **`test/session-store*.test.ts`**: additive-field round-trip (parse
  tolerance); `stats()` results unchanged.
- **Runner/repl suites**: `printSessionStats`/`/status` lines show the
  aggregate with markers; resume rebuild equals the pre-resume view.

### 7.3 Acceptance mapping (§SA-05)

| Acceptance item | Test |
|---|---|
| fake parent + children + summaries → exact, non-duplicated totals | unit exact-bucket tests (7.2) |
| compaction does not erase incurred work | R1 |
| reload / repeated events / repeated render idempotent | rebuild==incremental + repeated `view()` |
| branch switching follows the documented cost scope | branch-independence test + ctx unchanged |
| parent model changes do not reprice child work | byModel/unpriced tests (D4) |
| missing pricing/usage/persistence visible | taxonomy + marker-matrix tests |
| child usage does not change ctx% / thresholds | integration: totals never feed estimate/compaction paths |
| SA-07 resumed delta added once | precondition recorded (§5.8); integration test deferred to SA-07 (explicit) |

## 8. Out of scope / deferred (explicit)

- No `/usage` command, dashboard, budget enforcement, or billing integration.
- No child-transcript scanning or reconciliation (L3; SA-06 registry is the
  future source).
- No historical rate snapshots (current-catalog estimates only).
- Failed main-session summarizer usage stays unrecorded (L2).
- No retroactive repair of legacy entries (L1).
- `SessionStore.stats()` semantics and all existing consumers are untouched.

## 9. Verification (gates at implementation)

`npm run typecheck`, `npm run lint`, `npm run build`, full `npm test`; targeted
suites; red evidence captured in the first implementation commit; independent
implementation review; owner acceptance before `--no-ff` merge.

## 10. Design review record

### Round 1 (2026-09-27, fresh context) — APPROVE WITH CORRECTIONS

All corrections closed in this revision.

- **P1-1** summarizer-bucket wording was wrong and hid the child-summarizer
  attribution: child compaction entries are unreachable from the parent scan;
  a child's summarizer usage is already inside `TaskRecord.usage`
  (`subagent.ts:332`) → attributed to the child bucket, counted once. §3.1,
  §4.1 fixed; exactly-once test added (§7.2).
- **P1-2** footer staleness: the sync point was never stated. §3.5 now pins the
  existing `#footer-per-turn` cadence (message_end + settle sites), with the
  aggregate syncing inside every refresh; no new triggers.
- **P1-3** L3 was documentation, not visibility: the acceptance checkbox
  "missing persistence is visible" was mis-satisfied. New rule 2b (§4.1): a
  `task` tool-result without a parsable record → child incomplete; covers
  SA-03's no-record paths and the synthetic closers. Narrowed residual (kill
  before any write) documented in §4.6.
- **P1-4** three pinned tests + one docs promise pin the replaced output.
  Enumerated with intended updates in §6.
- **P2-1** `taskRecordsInEntry` contract (order, no dedupe, cross-entry
  sets) pinned in §3.1.
- **P2-2** cap-retry merge agreement (numbers vs flag) added to §7.2.
- **P2-3** `$?` marker noise for legacy/unpriced sessions: accepted under D4's
  honesty rule (unknown shown as unknown); owner notified at acceptance.
- **P3-1** §1.1 overstated what `runner.ts:794` owns (`summarizeBranchSegment`
  returns the summary string only) — corrected; the signature change is
  explicit in §3.3.
- **P3-2** money drifts with the live catalog between sessions — already
  acknowledged under D4.
- **P3-3** naming: `usage-totals.ts` is a derived view, not a second ledger —
  satisfies "reuse the SA-03 storage contract" (§8 note kept).

### Delta review (2026-09-27, fix `02d2782`) — APPROVE

Closed the implementation review's P2/P3: rule 2b is now exactly-once by
`toolCallId` (only the first sighting of a call without a parsable record
flags; a record-less repeat of an acknowledged call adds no signal), and the
tracker rebuilds on entry-array mutation by identity
(`entries[cursor-1] !== lastApplied`), not by length.

Reviewer notes: the original P2's cited mechanism (`pruneTaskRecord`) does
not exist in `src/` and its inner-entry double-count claim did not reproduce
(probe: a record repeated twice in one entry counts once); the repeat-case
over-flag it described WAS real and is fixed.

Accepted residual (P3, report-flag-only, no numeric corruption): adapters
that synthesize positional tool-call ids (`call_${index}` —
`openai-completions.ts:420`, `codex-responses.ts:267`) could, in a relay
scenario that drops ids, reuse an id for a distinct call and mask that
call's record-less rule-2b signal. Not reproduced in normal use.

## 11. Round 2 (owner acceptance blockers: canonical attribution + provider-aware static rates)

Owner acceptance of `763cfbc` reported two P2 pricing-accuracy blockers with
independent repros (§11.1). Both are confirmed in source. Round-1 review of
this supplement returned APPROVE WITH CORRECTIONS; corrections F1–F5 are
folded in below (the corrections changed R1's stamp format to ALWAYS
fully-qualified and replaced R2's grammar rule with strict unpriced).

### 11.1 Problem (acceptance-verified)

**A. Parent and summary writes persist a bare wire model id, losing the
producer's provider.** Write sites:
- `loop.ts:328` — assistant `model` = `request.model` (the wire id; the
  runner passes `this.model`, which is prefix-stripped for every family
  except anthropic: `runner.modelReference()` = `providerName === "anthropic"
  ? model : provider/model`, `runner.ts:990-992`);
- `compaction.ts:688` (via `compactSession`) — entry `model` = `args.model`
  (wire);
- `runner.ts` branch-summary stamp — `summaryModel` (wire).
`usage-totals.ts` then prices `message.model` / `entry.model` as if they were
references. Repro (owner): two providers publish the same model id at $1
(anthropic) vs $7 (openai); an OpenAI runner makes two parent calls + one
compaction + one branch summary at 1M input tokens each → persisted model
`review-shared-model`; expected $28, actual $4 (`anthropic/review-shared-model`
rates); a reopen still shows $4. The review's F1 showed the same class of
mis-resolution exists even inside the "reference grammar": `anthropic/glm-5.3`
is a supported configuration (`test/session-model-runner.test.ts:262-276`) and
`parseModelRef("glm-5.3")` → zai unconditionally, so a bare glm stamp would be
priced as $0 subscription traffic although the call was metered.

**B. `costFor`'s static fallback ignores the provider.** `models.ts:144-153`
strips the provider prefix after a catalog miss and matches a bare-keyed
static table (`MODEL_COSTS`, `models.ts:77`). Consequences (owner repro):
`openai/claude-sonnet-4-6` (no catalog entry) priced with Anthropic rates
($3.000 instead of unpriced); `openai/gpt-5.4` resolves to the *openai-codex*
section entry (`subscription: true`) and mislabels metered OpenAI traffic as
subscription traffic.

### 11.2 Rules (frozen; review corrections folded in)

**R1 — persisted producer identity is an ALWAYS fully-qualified reference.**
- New helper (e.g. `qualifiedReference(provider, modelId)` in
  `src/provider/resolve.ts`): returns `` `${provider}/${modelId}` `` — always
  prefixed, including anthropic (`anthropic/claude-sonnet-4-5`). This is
  intentionally distinct from the display convention `modelReference()`
  (`runner.ts:990-992`), which keeps its bare-for-anthropic form.
- `AssistantMessage` gains `modelReference?: string` (fully qualified). The
  loop stamps it from a new optional `modelReference` argument to
  `runAgentLoop` (the SA-04 `usageLedger` seam shape); `model` (wire id) stays
  untouched for debugging/compat. Absent argument → field absent.
- `CompactionEntry.model` and `BranchSummaryEntry.model` mean a fully
  qualified reference. Both fields were introduced by SA-05 and are
  unreleased; entries written by the acceptance build degrade to unpriced
  (§11.5).
- **`model` must stay the wire model at every summarizer seam** (it feeds
  `provider.stream({ model: args.model })`, `compaction.ts:420`): the new
  `modelReference` is a SEPARATE optional argument on `compactSession`,
  `compactHistory`, and `summarizeBranchSegment` — never an overload of the
  existing one; likewise a separate param threaded through
  `compactAndSplice`.
- Sources of the qualified reference at the write sites (all verified as the
  only writers):
  - main runner: `runTurnInner` computes it for the run's model
    (`qualifiedReference(this.providerName, model)`); passed to
    `runAgentLoop` and to `compactAndSplice` → `compactSession`; the
    branch-summary path passes it for `summaryModel`.
  - child engine (`subagent.ts`): `childModelMetadata(...).reference` is
    already `` `${providerName}/${wireModelId}` `` (`child-model.ts:34`) —
    fully qualified; thread it to the child `runAgentLoop` (line ~305) and
    the child `compactSession` (line ~227).
- `TaskRecord.binding.reference` is already fully qualified (SA-02) — child
  usage was never affected by A.

**R2 — legacy values without a qualified reference are UNPRICED (no
inference).** Pricing identity is the qualified reference field only
(`message.modelReference`, `record.binding.reference`, `entry.model` when it
is a post-fix entry). A bare `model` value (pre-fix wire stamp, any family)
is **never** resolved to a rate: `parseModelRef`'s bare-id behaviour
(default anthropic, `glm-*` → zai, `resolve.ts:64-91`) is a ROUTING rule, not
an identity claim — F1 showed it misprices `anthropic/glm-5.3`, and the same
argument applies to `openai/<anthropic-id>` repros. Consequences: pre-fix
parent and summary usage shows `$?`/`~$`; pre-fix CHILD usage keeps pricing
(records carry qualified bindings since SA-03).
- Considered and rejected: bare-id grammar pricing (mispricing risk above);
  resolving bare stamps via the session header's `seedModel` provider (records
  only the *current* model; misprices switched sessions).

**R3 — `costFor` accepts fully-qualified references only, provider-scoped end
to end.**
- `MODEL_COSTS` is restructured into provider sections (anthropic / zai /
  deepseek / moonshotai / openai-codex — the current sections; 30 distinct
  ids, zero cross-section collisions, verified).
- Ladder: reference without `/` → `undefined` (legacy); otherwise
  `parseModelRef` → catalog `catalogEntryFor(provider, modelId)`
  (subscription iff provider ∈ `SUBSCRIPTION_FAMILIES`), then the static
  section under `(provider, modelId)` (subscription from the entry as
  authored); otherwise `undefined`. No cross-provider lookup, ever.
- Pinned consequences: `openai/claude-sonnet-4-6` → undefined;
  `openai/gpt-5.4` → undefined (NOT subscription); `anthropic/glm-5.3` →
  undefined (the anthropic section has no glm entry — a documented change
  from today's zai-priced result; the call is metered anthropic-compat, so
  unpriced is the honest outcome); `anthropic/claude-*` → anthropic rates;
  `zai/glm-*` → zai + subscription; `openai-codex/gpt-5.4` → codex rates +
  subscription; bare anything → undefined.

### 11.3 Visible consequences (documented)

- New sessions price every producer at its own provider's rates (A fixed),
  including identical ids under different providers.
- Pre-fix sessions: parent + summary usage becomes **unpriced**
  (`$?`/`~$`) — including anthropic and glm (R2); child usage keeps pricing
  (qualified bindings existed since SA-03). Anthropic-compat `glm-*` configs
  (new sessions included) are unpriced by design (R3).
- No display-format change.

### 11.4 Tests (acceptance-grade regressions)

- **`test/cost-pricing.test.ts` (new, unit)**: the R3 matrix above, including
  both owner repros (cross-provider canonical → unpriced; `openai/gpt-5.4` →
  no subscription mislabel), `anthropic/glm-5.3` → undefined, bare ids →
  undefined.
- **Runner → persistence → reopen → pricing (owner repro A, end to end)**:
  a stubbed catalog (`IMP_CATALOG_PATH` + `vi.resetModules`, the
  `compaction-wiring.test.ts` pattern; catalog entries accept
  `cost: {input,output,cacheRead,cacheWrite}`) with
  `anthropic/review-shared-model` ($1) and `openai/review-shared-model` ($7);
  runner on `openai/review-shared-model`; two scripted parent turns
  reporting 1M input tokens each + `compactNow()` → reopen the session file
  → `usageTotals()` + `priceUsageTotals(totals, costFor)` → **$21** (three
  producer calls at $7). Red on `763cfbc`: the persisted stamps are bare
  `review-shared-model`, which resolve to the anthropic catalog entry → $3.
  Assert the persisted assistant entries and the compaction entry carry
  `openai/review-shared-model`.
- **Branch-summary stamp**: extend a `test/tree-nav.test.ts` navigate case to
  assert the `branchSummary` entry's `model` is the fully qualified reference
  (`anthropic/claude-sonnet-4-5` for its `navEnv` model — discriminating
  against `763cfbc`'s bare value) plus its usage is priced accordingly.
- **Legacy pins**: a bare `claude-sonnet-4-5` or `glm-5.3` stamp (no
  qualified field) is unpriced; `anthropic/claude-sonnet-4-5` is priced;
  `zai/glm-5.3` is priced + subscription; a pre-fix session's child record
  still prices (qualified binding).
- **Existing suites to update (enumerated, review F2/F5)**: costFor callers
  and pricing pins — `test/model-catalog.test.ts` (costFor assertions on
  bare glm/claude ids), `test/repl-status.test.ts` (footer usage segment
  cases: bare `claude-sonnet-4-5` / `glm-5.3` scenarios), `test/runner.test.ts`
  (`test-model` → `$?` line), `test/repl-commands.test.ts` (`/status` line).
  Full-suite run decides the final list; every change must assert the NEW
  semantics, never merely loosen the assertion.

### 11.5 Limitations (explicit)

- Entries written by the pre-fix SA-05 builds (acceptance experiments) carry
  bare `model` values; they show as unpriced rather than being reinterpreted.
- The `modelReference` field is additive and fully qualified by contract; old
  readers ignore it (header-field precedent). The display convention
  `modelReference()` (bare for anthropic) is unrelated to the persisted
  field's encoding.
- Provider-awareness ends at the static table: a provider absent from both
  catalog and static table stays unpriced (never guessed).
