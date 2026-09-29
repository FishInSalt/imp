# Loop health monitoring + uncapped children (design)

- Date: 2026-09-29
- Branch: `docs/loop-health-design` (design only); implementation branch TBD
  (`feat/loop-health` proposed)
- Baseline: `faf4b55` (main)
- Status: DRAFT rev 2 — all round-1 adversarial findings folded (§9). Awaiting
  round-2 confirmation and the owner's sign-off on decisions A/B (§3). Not
  implementable yet. No code, test, or runtime change is authorized by this
  document.
- Supersedes: `docs/subagent-softlanding-design.md` rev 4 §2.1 (the 60-turn
  backup wall) and the cap-related entries in its §5; amends the "existing
  behavior to preserve" bullet in `docs/subagent-delegation-task-list.md`
  ("The child turn cap is 60 per loop invocation…"). Stale-reference sweep
  (implemented in this batch, §5): `docs/sa-07-child-resume-design.md:690`
  (pinned resume behavior becomes false), `docs/sa-03-task-record-design.md:80`,
  `docs/overflow-pagination-design.md:62,121`, `docs/m5-subagents-design.md:341`,
  `PROJECT_PLAN.md` if it repeats the wall value.
- Owner requirement (2026-09-29): children no longer carry the 60-turn cap;
  abnormal states are identified by other means; the main loop shares the same
  identification mechanism. Owner approved this draft + adversarial review as
  the next step.

## References read for this design (2026-09-29)

- `pi-subagents` v0.69.0 (`~/.pi/agent/npm/node_modules/pi-subagents`):
  turn budgets removed in 0.59.0 ("Remove assistant turn budgets, including
  hard termination, wrap-up prompt injection, and launch configuration",
  CHANGELOG); current replacements are `timeoutMs` + `checkpointBeforeDeadlineMs`
  (0.68.0), the long-running guard (`src/runs/shared/long-running-guard.ts`),
  control events `active_long_running` / `needs_attention`
  (`src/runs/shared/subagent-control.ts`; defaults `needsAttentionAfterMs` 60s,
  `activeNoticeAfterMs` 240s, `failedToolAttemptsBeforeAttention` 3, mutating
  failure window 5 min), and the review-style watchdog (`src/watchdog/`,
  `loop-risk` warning category).
- Claude Code 2.1.88 restored source
  (`/Users/z/Z/claude-code-sourcemap/restored-src`): built-in agents set no
  `maxTurns` (explore/general-purpose/plan); the fork subagent is the lone wall
  (`forkSubagent.ts:65`, `maxTurns: 200`); `maxTurns` gates the query loop only
  when the caller supplies it (`query.ts:1705-1717`, `max_turns_reached`
  attachment); termination is user-driven (Ctrl+C / TaskStop). No anomaly
  detection exists on either side.
- imp source at the baseline; paths cited inline.

## 0. Decision chain (why this batch exists)

1. Incident A (2026-09-23): a review child spent 40 turns / ~44.9k tokens with
   zero final text; the parent was misled by "(completed with no output)".
2. `#subagent-softlanding` rev 4 fixed the *reporting* side (honest cap/timeout
   handoff, transcript path, resume guidance), kept zero prompt injection into
   children, and raised the wall 40 → 60 as a "backup" — explicitly NOT a
   budget. The design recorded why a wall stayed at all: "imp 无子代理
   观测/steer 通道——结构上裸奔面更大" (`subagent-softlanding-design.md` §2.1).
3. Both reference projects then moved further: pi-subagents **removed turn
   budgets entirely**; CC built-ins never had them. Neither replaced them with
   another count — pi uses a hard time deadline plus *notice* signals; CC uses
   user termination.
4. Owner requirement 2026-09-29: drop the 60-turn cap; identify abnormal
   states instead; give the main loop the same identification mechanism.
5. This batch builds the detection/visibility layer rev 4 lacked and removes
   the count wall. **It does not yet add an acting channel**: v1's live notes
   inform the user; the parent model learns at settle; nothing terminates
   automatically beyond the pre-existing surfaces (§3-A). The owner-approved
   scope refinement: detection is observation-only in this batch; auto-abort
   is a separate decision; whether any last-resort valve remains is an
   explicit owner decision (§3).

## 1. Problem definition

### 1.1 What the 60-turn wall does today (verified facts)

- `CHILD_MAX_TURNS = 60` (`src/core/constants.ts:13`) is passed as
  `maxIterations` by `runSubagent` (`src/core/subagent.ts:339`); the loop stops
  a tool-calling turn when `turns >= maxIterations` (`src/core/loop.ts:229-241`)
  and reports `max_iterations`.
- The overflow-recovery path starts a **second** loop, so one attempt can run
  up to 2×60 turns (`src/core/subagent.ts:201-203`).
- The wall counts completed tool-calling turns only. A single hung tool call
  never advances it; the only clock in play is `defaultChildTimeoutMs()`
  (TTY: none; print/headless: 60 min — `src/core/constants.ts:24`).
- Interactive children therefore rely on exactly two termination surfaces: the
  60-turn wall and Ctrl+C. Print children: the wall + the 60-minute clock.

### 1.2 Why turn count is the wrong abnormal-state signal

- Turn count conflates two unrelated conditions: honest long work (measured in
  turns by nothing meaningful) and degenerate loops. It truncates the former
  (rev 4 §2.1: the wall arrived before the clock exactly in cheap-turn honest
  scenarios) and detects the latter only after N turns *and* only silently.
- pi-subagents built a turn budget (soft wrap-up + hard termination + grace
  turns), then removed the whole mechanism in 0.59.0 — the strongest available
  evidence that count-based termination was the wrong shape even with an
  escape hatch.
- CC built-ins are uncapped; the fork wall (200) is a sanity fence, not a
  budget.
- The wall cannot see hung tools at all; imp's own rev 4 recorded this gap.

### 1.3 The gap this batch fills — stated precisely

What v1 adds: detection of the three concrete degenerate patterns both
references guard against (repeated identical calls, repeated failed mutations,
a tool left open too long), honest surfacing of the child's existing
compaction-failure state, and live user-visible notes for both loops. What v1
does **not** add: any acting channel. Child facts reach the parent model only
at settle (task results are built after `runSubagent` returns —
`src/core/tools/task.ts:910,941`); during an undetected degenerate loop the
live note informs the user, and the user decides (Ctrl+C). The main loop has
no detector at all today (interactive is uncapped — `src/cli.ts:472`; print
defaults to 100 — `src/cli.ts:237`). The residual runaway window after this
batch equals the window before it; what changes is that the window is visible
and the evidence is recorded. Whether that visibility is sufficient — or a
valve must remain — is owner decision A.

## 2. Goals / non-goals

Goals:

1. Remove the child turn cap: no `CHILD_MAX_TURNS`; loop launches uncapped.
2. One shared monitor (`src/core/health.ts`) consumed by the child engine and
   the main runner; identical signal definitions and thresholds, per-context
   surfacing.
3. Signals (v1): `repeat-loop`, `mutation-failure-streak`, `tool-open` (both
   loops) + `compaction-failures` (child-engine fact).
4. Detection is observation-only: no prompts, no aborts, no new terminal
   statuses, `isError` semantics unchanged. (Owner decision B.)
5. Child facts reach the parent honestly: task-result lines, a TaskRecord
   field, and interactive live notes; the main loop gets interactive live
   notes. Print stdout stays byte-identical.
6. Tests and docs updated; the old pins are replaced by explicit new contracts.

Non-goals (with reason):

- No auto-abort / token valve in this batch. Whether any last-resort valve
  exists is owner decision A (§3). v1 does not reduce the runaway window
  (§1.3) and this is recorded, not hidden.
- No prompt injection into children (zero-injection stands, rev 4 §2.5);
  pi's `checkpointBeforeDeadlineMs` is an injected instruction and is
  deliberately not adopted here.
- No steer / wait / asynchronous delegation (previously deferred; unchanged).
- No print-mode stdout/stderr additions (byte contract; see §4.3).
- No extension API or M4 event-set additions (normative set; no named
  consumer).
- No changes to timeout precedence, abort propagation, overflow recovery,
  compaction mechanics, resume/launch validation, worktrees, or child model
  binding.
- Main-agent caps unchanged (interactive unlimited; print 100).

## 3. Owner decisions (proposed; explicit sign-off required before implementation)

**A. Last-resort valve after the cap is removed.** Proposed: **none** — no new
numeric valve. Remaining termination surfaces: Ctrl+C (TTY); per-call
`timeoutMs` / agent frontmatter (unchanged); print-mode 60-minute default
clock (unchanged). Recorded risk: a TTY child in a degenerate loop the
detectors do not catch burns tokens until the user notices; v1 makes this
window *visible* (live note + recorded facts) but does not shorten it (§1.3).
Alternatives, both deferred and both fed by the same monitor facts if later
wanted: (i) opt-in `task.maxTurns` argument (caller decides per dispatch);
(ii) token-budget abort (default off). Rationale for the proposal: count
valves are the demonstrated wrong shape (§1.2); the references keep
termination time-based or user-based; the guard worth building first is
visibility.

**B. Injection.** Proposed: **none** — detection never writes into a child's
context (rev 4 zero-injection). All output is parent-/user-facing.

**C. Main-agent scope.** The main loop gets the same monitor with the same
signal definitions (S1/S2/S3; S4 is child-engine-only). Surfacing is
interactive-only; print stays silent live; main caps are untouched.

**D. Surfacing inventory.** Child: task-result lines (model-visible by design —
the parent's decision input, same family as the existing cap/timeout lines),
TaskRecord field (persisted, program-visible), interactive REPL note (once per
attempt+code). Main: interactive REPL note (once per run+code). Extensions:
nothing. History: nothing beyond the child's own result text.

## 4. Design

### 4.1 Architecture

**A monitor that consumes the existing event stream — not a new loop
subsystem.**

- New `src/core/health.ts` exports:

```ts
export type HealthCode =
  | "repeat-loop" | "mutation-failure-streak" | "tool-open" | "compaction-failures";

export interface HealthSignal {
  code: HealthCode;
  count: number;  // peak observed run length for the condition (1 for tool-open)
  turn: number;   // assistant message_end events observed since monitor creation at first fire
  detail?: string; // bounded single-line evidence (no newlines, ≤120 chars)
}

export interface LoopHealthMonitor {
  observe(event: AgentEvent): void;          // message_end / tool_start / tool_end
  note(code: HealthCode, count: number, detail?: string): void; // engine-level facts
  signals(): readonly HealthSignal[];        // deduped by code, first-fire order, ≤4
  dispose(): void;                           // clears timers; idempotent
}

export function createLoopHealth(options: {
  thresholds?: Partial<HealthThresholds>;
  emit?: (signal: HealthSignal) => void;     // live relay; first fire per code only
}): LoopHealthMonitor;
```

- The monitor observes the existing `AgentEvent` stream at the two call
  sites; `runAgentLoop` gains **no** new options and is behavior-unchanged
  when no monitor exists:
  - `runner.runTurnInner` (`src/runner.ts:1344-1446`; `onEvent` wrapper at
    `:1415-1428`): create one monitor per run; call `observe(event)` first in
    the wrapper; relay via `emit → options.onEvent({ type: "health", signal })`;
    `dispose()` in the existing `finally` (`:1444-1446`).
  - `subagent.runSubagent` (`src/core/subagent.ts:167-429`; the `launchLoop`
    seam is `:327-346`): create one monitor per attempt (a resume is a fresh
    `runSubagent` call → fresh monitor; the overflow retry shares the same
    monitor — counts span both launches, documented); wrap `launchLoop`'s
    `onEvent`; relay via `emit → options.onEvent({ type: "health", signal })`
    (the task tool already attaches `{agent, cwd, sourceId, taskToolCallId}`
    — `src/core/tools/task.ts:877-884`); `dispose()` in the outer `finally`
    (`src/core/subagent.ts:426-429`).
- `AgentEvent` (`src/core/loop.ts:17-20`) gains
  `| { type: "health"; signal: HealthSignal }` (type-only import; no loop
  behavior change). The variant is emitted by the callers, never by the loop.
  It flows through the existing relays: child → task tool → `turnEventTap` →
  REPL (`src/runner.ts:606-620`); main → `RunTurnOptions.onEvent` → REPL
  (`src/repl/repl.ts:653-680`). Extensions do not see it: their only relaying
  points forward `tool_end` (`src/runner.ts:608-619` child, `:1417` main).
- Thresholds: exported constants + env overrides read once at monitor
  creation. Validation reuses the repo's existing numeric-env style —
  `envInt` (`src/core/compaction.ts:42-50`), which writes a stderr warning and
  falls back to the default on malformed values. Env surface:
  `IMP_HEALTH=0` disables the monitor entirely (no facts, no emits; see §7 for
  the recorded observability caveat); `IMP_HEALTH_REPEAT_TURNS` (default 5);
  `IMP_HEALTH_MUTATION_FAILURES` (default 3); `IMP_HEALTH_TOOL_OPEN_MS`
  (default 600_000).
- Lifecycle contract: the caller MUST `dispose()` after the loop settles
  (normal, abort, timeout, crash, throw). `dispose()` clears all pending
  timers; timers are `unref()`d (repo precedent: `src/repl/shell.ts:604`);
  a timer callback checks the disposed flag before emitting and never throws.
  Facts already recorded survive disposal. `note()` is valid before any
  `observe()` call (the compaction backstop can fire early). Pre-launch
  rejection paths create no monitor (nothing ran).
- Abort edge (fold of round-1 findings): the loop returns early on abort
  without emitting `tool_end` for in-flight calls (`src/core/loop.ts`
  `executeToolBatch` early returns). `tool-open` therefore counts only calls
  whose `tool_start` was observed and that are still open at observation time;
  an abandoned call's timer is cancelled by the outer `dispose()`. The
  observable contract: after the attempt settles, advancing the clock
  arbitrarily produces no further signals or emits (test 3/test 7).
- Concurrency: one monitor instance per child attempt; no shared mutable
  state; each child's events carry its own `sourceId`, which is also the REPL
  dedup key.

### 4.2 Signal catalog (v1)

| Code | Condition (all on the observed event stream) | Default | Fires |
|---|---|---|---|
| `repeat-loop` | R consecutive assistant turns whose tool-call signature is byte-identical: ordered list of `(toolName, sha256(canonicalJson(arguments)))` taken from the assembled assistant message at `message_end` | R=5 | once; `count` = peak run length; resets on any differing turn |
| `mutation-failure-streak` | K failed (`isError`) `edit`/`write` results without an intervening successful `edit`/`write`, and with each consecutive pair ≤5 minutes apart (window resets the streak; non-mutating results do not) | K=3 | once; `count` = peak streak; `detail` carries tool + path |
| `tool-open` | a single tool call still open (no `tool_end`) T ms after `tool_start` | T=600_000 | once per call; `detail` carries tool + preview + elapsed |
| `compaction-failures` | child compaction disabled after 3 consecutive summarizer failures (existing path, `src/core/subagent.ts:295-299`) | 3 | once; fact-only via `note()` |

Notes:

- **Signature source (fold of round-1 P1-1).** `message_end` is emitted before
  that turn's `tool_start` events (`src/core/loop.ts`, `streamAssistant` →
  `executeToolBatch`), so the signature is computed from the assembled
  assistant message's tool-call blocks — one event, unambiguous turn
  boundary, and what imp's history actually records. `tool_start` supplies only
  the open-tool timer start and call identity (previews are read from the
  block data captured at `message_end`, keyed by `toolCallId`); `tool_end`
  supplies `isError`/`toolName` for the mutation streak. A unit test feeds
  only `message_end` events and asserts detection — pinning the source.
- Signature canonicalization: extract the existing `canonicalJson` helper from
  `src/core/tools/task.ts:207-216` into `src/core/canonical.ts` and share it
  (`task.ts` keeps its launch-comparison use at `:585-586`; health.ts uses the
  same helper — no second serializer). Key-order insensitivity is intentional
  for both uses (round-1 P3-1).
- `detail` previews: single-line, ≤80 chars: `bash "` + first line of
  `command` + `"`, `edit <path>`, `write <path>`, otherwise the first line of
  canonical JSON. No REPL/presentation imports — a local minimal formatter.
  The `detail` field bound is 120 chars (one producer-side bound; the
  preview's 80 is a sub-bound of it; the record's generic `bound()` never
  triggers on health details).
- Threshold reasoning (tunable by env; review may adjust):
  R=5 — two or three identical retries occur legitimately during debugging;
  five byte-identical tool batches in a row is not a productive pattern; the
  signal is a note, so the threshold trades noise, not safety.
  K=3 — the integer matches pi's `failedToolAttemptsBeforeAttention` default;
  the *semantics* are imp-specific (isError-based, 5-minute window,
  mutation-success reset) and deliberately do **not** adopt pi's text-hint
  failure test or its repeated-path OR-escalation (recorded as §7 Q2).
  T=10 min — long builds are legitimate; ten minutes without a tool returning
  is unusual enough to look at; far below the print-mode 60-minute clock.
- Documented limitations (accepted v1): rotating cycles (A,B,A,B…), same-tool
  different-arg loops, and semantic no-progress (e.g. repeated reads of the
  same file with different offsets) are not detected; pi's repeated-path
  variant is not adopted (Q2); multi-call turns are compared in order
  (order-sensitive by design; pinned by a multi-call test).
- `turn` semantics (fold of round-1 P2-4): the number of assistant
  `message_end` events observed since monitor creation, cumulative across the
  overflow retry; test 8 asserts the value across the retry boundary.
- `compaction-failures` is event-shaped on purpose (round-1 P2-3): it reports
  3 consecutive summarizer failures that disabled compaction for the run; a
  run with `IMP_AUTOCOMPACT=0` never fires it (no compaction was attempted —
  not a failure).

### 4.3 Facts and surfacing

**SubagentOutcome** gains `health: readonly HealthSignal[]` (possibly empty;
`settled()` snapshots `monitor.signals()`).

**TaskRecord** (`src/core/task-record.ts`) gains an optional additive field:

```ts
health?: ReadonlyArray<{ code: HealthCode; count: number; turn: number; detail?: string }>;
```

- Absent when no signal fired (clean runs keep the old record shape — this
  keeps the exact-field-set golden in `test/task-record.test.ts:68-78` green;
  that test file is part of this batch's change list). `TASK_RECORD_VERSION`
  stays 1 (additive optional field).
- Parser behavior (fold of round-1 P1-5/F6): `parseTaskRecord` currently
  passes unknown fields through. This batch adds an `isHealth` validator as a
  deliberate step, with the rule: **a malformed `health` is dropped (treated
  as absent); it must never null the record** — advisory fields cannot
  invalidate identity/usage/transcript facts. Old records (no field) keep
  parsing. `TaskRecordInput`/`buildTaskRecord` gain the field as optional;
  the "no prose input" doc-comment is reconciled (health.detail is bounded
  prose, produced only by the monitor).
- Bounded: deduped by code, ≤4 entries, first-fire order (producer-enforced).

**Task result text**: `taskResult` (`src/core/tools/task.ts:941-1026`) has
**four** terminal return shapes (fold of round-1 P1-3/F4): aborted/timeout
(`:975-984`), crash-without-text (`:986-991`), no-text success (`:999-1005`),
and the assembled `parts` path (`:1007-1025`). The health block is appended
as its own `\n\n`-separated block at the very end of the composed output in
ALL four shapes when facts exist (never on `rejected`); the two no-text shapes
and the abort/timeout shape get their goldens updated accordingly. Proposed
strings (pinned by goldens at implementation; ≤4 lines; `isError` unchanged):

- `[task] health: repeated identical tool calls ×5 (last: bash "npm test") — the child may be looping; verify the result before relying on it.`
- `[task] health: 3 consecutive failed edits (last: edit src/a.ts) — the child may be stuck; verify the result before relying on it.`
- `[task] health: bash "npm run build" was still open after 10m05s — a single tool call held the child for that long.`
- `[task] health: child compaction disabled after 3 summarizer failures — later turns ran without context compression.`

**Interactive notes** (REPL only):

- Mechanism (fold of round-1 P0-1/P0-3): the health branch is added at the top
  of the REPL's `onEvent` tap (`src/repl/repl.ts:653-680`), **before**
  `trackActivity`/`renderer.event`: on `event.type === "health"` it calls
  `this.renderer.note(...)` explicitly and returns (no `renderer.event`, no
  `showResultFold`). The note is deduped once per `(sourceId ?? "main", code)`
  per run (dedup map reset at run start, `submitTurn`); child notes carry the
  agent label from `info?.agent` (fallback "task"); main notes are plain.
  Proposed: `▪ health: <agent>: repeated identical tool calls ×5 (last: bash
  "npm test")`; `▪ health: …` for main.
- `Renderer.event`'s `default:` case (`src/render.ts:173-177`) already ignores
  unknown event types — but print safety does **not** rely on that
  incidentally (round-1 P0-1): print mode wires
  `onEvent: (event) => renderer.event(event)` (`src/cli.ts:1048-1053`), so
  health events DO reach the print renderer and are swallowed by the default
  case. The design therefore (a) states the mechanism explicitly, (b) never
  calls `renderer.note` from any shared path reachable in print, and (c) adds
  a unit test asserting `Renderer.event({type:"health", …})` writes zero bytes
  and changes no spinner state.
- Once per `(sourceId ?? "main", code)` per run; later growth updates the
  record and result line, not the note.

**Print mode**: no new stdout bytes (mechanism above + test) and no new stderr
writes; child facts still reach the parent model through the task result, and
the record still lands in the parent session JSONL. Main-loop print anomalies
get no live surface in v1 (recorded as §7 Q3).

**Extensions**: unchanged (no new events; the health `AgentEvent` is not
forwarded to the extension emit points). Exhaustiveness evidence (round-1
F9): every other consumer switches on specific types or guards before use
(`src/repl/repl.ts:659,671,701,1147,1161,1168,1202`; `src/core/compaction.ts:425-426`;
`src/provider/logging.ts:18`); a grep test keeps `src/extensions/` clean.

**Model-context statement**: the only model-visible addition anywhere is the
child's own task-result lines — the parent's decision input, deliberately in
the same family as the existing cap/timeout/transcript lines. No child context
is ever written; no main-agent context is ever written.

### 4.4 Cap removal specifics

- `src/core/constants.ts`: delete `CHILD_MAX_TURNS` (and its stale coupling
  comment about the clock derivation).
- `src/core/subagent.ts:339`: pass `maxIterations: Number.POSITIVE_INFINITY`
  with a comment naming this design (a child caller that omits the option
  would silently get the loop's 100-turn floor — `src/core/loop.ts:119`; the
  explicit Infinity is load-bearing). Update the 2×60 overflow comment
  (`:201-203`) and the "bounded by CHILD_MAX_TURNS" remarks (`:289-290`).
- `max_iterations` remains in `SubagentStatus` (`src/core/subagent.ts:97-102`)
  and `TaskRecordStatus` (`src/core/task-record.ts:28-33`) as a legacy value:
  old records keep parsing; the main loop's explicit `--max-turns` still
  produces it; uncapped children can no longer produce it. The `taskResult`
  cap branch (`src/core/tools/task.ts:1014-1019`) stays (defensive; reachable
  only if a future explicit cap returns) and is documented as unreachable for
  children in this batch. Its rendering coverage moves to a direct
  `taskResult` unit test (no live child can produce the shape anymore) —
  round-1 F1.
- Guards after removal (unchanged unless §3-A decides otherwise): Ctrl+C
  (TTY); per-call `timeoutMs` / agent frontmatter / mode default clock
  (`defaultChildTimeoutMs`); the new detectors (visibility only); SA-07 resume
  with a narrowed prompt as the recovery path.
- Token-cost record (replaces the old 2×60 bound): child per-turn output is
  bounded by the loop's `maxTokens` default 8192 (`src/core/loop.ts:117`;
  `runSubagent` passes none), but with no turn wall the per-attempt total is
  unbounded in TTY. Accepted per §3-A; the monitor facts are the data source
  if a token valve is later added.

### 4.5 Interaction checks (explicitly verified against source)

- Timeout classification (`timeout` vs `aborted`,
  `src/core/subagent.ts:375-376,405-406,413-414`): untouched — the monitor
  never touches signals/abort.
- Overflow retry: monitor spans both launches; repeat/streak counts continue
  across the boundary; `outcome.health` merges (one monitor); `turn` is
  cumulative (test 8).
- Resume (SA-07): each attempt has its own monitor and its own record; a
  resumed attempt's result lines reflect only that attempt.
- Compaction: `compactChildHistory` failure bookkeeping is unchanged; only the
  third-consecutive-failure point additionally calls
  `monitor.note("compaction-failures", 3, …)`.
- Print byte contract: mechanism and test in §4.3; no new writes in print
  paths.
- M4 extension events: untouched; a repo-wide grep for the new variant in
  `src/extensions/` must stay empty (test item).
- Abort with an open tool: `tool_start` without `tool_end` is a legal stream
  shape; dispose in the outer finally cancels the pending timer; the
  post-settle contract is "no further signals or emits" (tests 3/7).
- Rejected paths: no monitor exists (nothing ran) — no facts, no notes.

## 5. Change list

| File | Change | Est. lines |
|---|---|---|
| `src/core/health.ts` | NEW: codes, signals, monitor, thresholds, preview, signing | ~240 |
| `src/core/canonical.ts` | NEW: `canonicalJson` moved from task.ts (`:207-216`), shared; update the `task.ts:585-586` call site | ~30 |
| `src/core/loop.ts` | `AgentEvent` gains the `health` variant (type only) | ~5 |
| `src/core/subagent.ts` | monitor create/wire/dispose; `outcome.health`; compaction note; `Infinity` cap; comment fixes | ~65 |
| `src/core/constants.ts` | delete `CHILD_MAX_TURNS` + stale comment | ~-8 |
| `src/core/tools/task.ts` | result health lines in four shapes; record wiring; import shared `canonicalJson` | ~60 |
| `src/core/task-record.ts` | optional `health` field, `isHealth` validator with drop-not-reject semantics; `buildTaskRecord`; comment reconciliation | ~40 |
| `src/runner.ts` | main monitor create/wire/dispose | ~25 |
| `src/repl/repl.ts` | health branch at top of the onEvent tap + per-run dedup notes | ~35 |
| `test/health.test.ts` | NEW unit suite (incl. fake timers) | ~320 |
| `test/subagent.test.ts` | replace the 60-turn pin (`:99-113`); uncapped run; health facts; dispose; turn across retry | ~90 |
| `test/task-tool.test.ts` | health lines in four shapes; record field; resume scoping; **rewrite the cap tests at `:1996-2010`** (finite scripts; cap-shape rendering moves to a direct `taskResult` unit test) | ~100 |
| `test/child-resume.test.ts` | **rewrite the cap-loop test at `:922-945`** (finite script; `max_iterations` assertion re-scoped to the direct unit test) | ~30 |
| `test/task-record.test.ts` | exact-field-set golden (`:68-78`) stays green via omission on clean runs; add health present/malformed-dropped cases | ~30 |
| `test/child-compaction.test.ts` | comment/assertion touch (`:184`); compaction-failures fact | ~10 |
| runner/REPL tests | event emission + note rendering + print-silence unit test | ~60 |
| docs | this file; supersede pointers (softlanding §2.1/§5, task-list bullet, sa-07 `:690`, sa-03 `:80`, overflow-pagination `:62,121`, m5 `:341`); CHANGELOG `Unreleased` | ~40 |

## 6. Test plan

1. Health unit — repeat-loop: exactly R identical turns fires; R-1 does not;
   peak count tracks growth; a differing turn resets; key-order-insensitive
   arg equality; signature detected from `message_end` alone (source pin);
   multi-call turn order sensitivity; preview single-line ≤80 chars.
2. Health unit — mutation streak: 3 failed edit/write results fire;
   non-mutating results in between do not reset; a mutation success resets; a
   >5-minute gap resets (fake timers); other tools' failures are ignored;
   path detail present.
3. Health unit — tool-open with fake timers: fires at T; `tool_end` before T
   cancels; `dispose()` cancels; fires once per call; a timer callback after
   dispose is a no-op and never throws; timers are unref'd.
4. Health unit — facts contract: deduped by code, first-fire order, ≤4
   entries; `emit` called once per code (first fire); env overrides parsed
   with `envInt` semantics (stderr warning + default on malformed);
   `IMP_HEALTH=0` disables.
5. Subagent — uncapped: a scripted child runs >60 tool turns then answers;
   `status` completed, `turns` = actual count.
6. Subagent — health facts: repeated identical tool turns produce
   `outcome.health` with `repeat-loop`, and the live relay delivers a `health`
   event through `options.onEvent`.
7. Subagent — abort with an open tool: settle (abort path), then advance fake
   timers arbitrarily — no further signals/emits; no pending timers remain.
8. Subagent — overflow retry: a repeat crossing the retry boundary counts on
   the same monitor; one merged facts array; `turn` value asserted across the
   boundary.
9. Subagent — compaction: 3 consecutive summarizer failures still disable
   compaction and now yield the `compaction-failures` fact; `note()` works
   before any `observe()`.
10. Task tool — result rendering: each code's line, exact strings, ≤4 lines,
    appended last in ALL four terminal shapes (aborted/timeout, crash-no-text,
    no-text, success); `isError` unchanged; `rejected` has none.
11. Task tool — record: `health` present only when fired; malformed `health`
    is dropped and the record still parses (identity/usage/transcript intact);
    records without the field still parse; exact-field-set golden unaffected
    on clean runs.
12. Task tool — resume: second attempt's record/result carry only its own
    facts; the first attempt's record is unchanged.
13. Runner — main loop emits `health` via `RunTurnOptions.onEvent`; main
    history receives no health writes; extensions receive nothing.
14. REPL — note rendering: one note per `(sourceId|main, code)` per run; child
    notes carry the agent label; dedup map resets per run; `renderer.event`
    and `showResultFold` are not invoked for health events.
15. Print mode — silence: `Renderer.event({type:"health", …})` writes zero
    bytes (unit); a scripted print run with a looping child produces identical
    stdout to the baseline apart from the model's own final text; stderr
    unchanged.
16. Grep tests: no `src/extensions/` reference to the health variant; no
    remaining `CHILD_MAX_TURNS` reference outside docs/history.
17. Update the old pins: `test/subagent.test.ts:99-113` (60-wall) replaced;
    `test/task-tool.test.ts:1996-2010` and `test/child-resume.test.ts:922-945`
    rewritten to finite scripts (would otherwise spin past `vitest` timeouts
    once uncapped); `test/child-compaction.test.ts:184` comment updated (the
    append-only semantics assertion it guards — compaction buys no extra
    turns — stays).
18. Concurrency: two fake children with independent loops produce independent
    facts and per-source events (no shared state).

## 7. Risks and open questions

- **Detection quality.** False positives (noise) are bounded by dedup and the
  env escape hatch; false negatives (rotating loops, semantic no-progress)
  are documented limitations. The remedy is dogfood data, not more v1
  heuristics.
- **Cost after cap removal.** Unbounded TTY burn for undetected degenerate
  loops; estimate and the owner decision are recorded in §3-A/§4.4. v1 does
  not shorten the window, only makes it visible (§1.3).
- **`IMP_HEALTH=0` observability hole (accepted, round-1 P2-2):** a disabled
  monitor is indistinguishable from "no signals" in records and results. This
  is an operator-chosen state; recorded here rather than adding a marker field
  in v1.
- **Timer lifecycle.** The dispose contract plus unref plus fake-timer tests
  are the mitigation; a missed dispose would leak one timer per open tool call
  (unbounded turns ⇒ unbounded potential leaks; covered by a long-run test).
- **Signature limits.** Whitespace-only arg changes defeat repeat detection;
  accepted (canonical JSON catches key order, not semantic equivalence).
- **Record growth.** Bounded (≤4 entries, detail ≤120 chars) and validated;
  malformed health is dropped, never record-nulling.
- **Text churn.** Result strings and note strings are goldens; print-mode
  stdout is untouched (test 15); four result shapes enumerated in §4.3.
- **Open Q1**: threshold defaults (5 / 3 / 10 min) — tune by dogfood; env
  overrides exist from day one.
- **Open Q2**: extend `mutation-failure-streak` to bash mutation commands
  and/or adopt pi's repeated-path OR-escalation in a later batch if dogfood
  shows missed cases.
- **Open Q3**: main-loop print-mode live visibility (stderr diagnostic line)
  — deferred; revisit only if a real print incident is recorded.
- **Open Q4**: result-line placement — this rev pins "appended last in all
  four shapes"; review may choose otherwise before implementation.
- **Open Q5**: whether main-loop facts should also reach the diagnostics
  logger — deferred (no consumer yet).
- **Open Q6** (round-1 P0-2): a minimal acting surface (e.g. an interactive
  confirm prompt on `tool-open`/`repeat-loop`) — deliberately out of scope;
  revisit with dogfood data or as part of decision A.

## 8. Implementation/rollout sketch (after review closes and A/B are signed off)

1. `health.ts` + `canonical.ts` + unit tests (pure, no wiring).
2. `loop.ts` variant + runner/subagent wiring + REPL notes + print-silence
   test.
3. Cap removal + task tool/record/result (four shapes) + test rewrites
   (`subagent`, `task-tool`, `child-resume`, `task-record`, `child-compaction`).
4. Docs (supersede sweep, task-list bullet, CHANGELOG) + full suite,
   typecheck, lint; independent implementation review per repo agreements;
   merge to main via `--no-ff` only after both.

## 9. Review record

- Round 1 (2026-09-29, two-track adversarial, fresh context; both reviewed
  `b653b2d`):
  - Track A (design decisions): NEEDS-FIXES — P0-1 (print-silence mechanism
    claim false; real mechanism is the renderer default case + absent `note`
    calls), P0-2 (v1 "fills the gap" overstated: no acting channel during the
    run), P1-1 (repeat-loop signature source underspecified), P1-2
    (mutation-streak "matches pi" only in the integer), P1-3 (health lines in
    four terminal shapes), P1-4 (supersession incomplete — sa-07 pinned
    behavior becomes false), P1-5 (malformed advisory field must not null the
    record), P1-6 (abort/dispose ordering for `tool-open`), plus P2/P3
    precision items.
  - Track B (implementation surface): APPROVE WITH CORRECTIONS — F1
    (`test/task-tool.test.ts:1996-2010` and `test/child-resume.test.ts:922-945`
    would spin forever once uncapped and were missing from the pin
    inventory), F2/F3 (same print/REPL mechanics as A-P0-1/P0-3; citations
    corrected), F4 (four return shapes), F5 (`task-record` exact-field-set
    golden), F6 (parser passes unknown fields through; the new validator is a
    deliberate step), F7 (detail bound), F8 (citation drift), F9
    (exhaustiveness), F10-F14 (verified-correct list incl. timer lifecycle,
    canonicalJson move safety, extension isolation).
  - Disposition: all findings folded into this rev 2 (§1.3, §3-A, §4.1-4.5,
    §5-§7 above). Round-2 confirmation requested from both tracks.
- Round 2 (two-track confirmation): PENDING.
