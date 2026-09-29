# Loop health monitoring + uncapped children (design)

- Date: 2026-09-29
- Branch: `docs/loop-health-design` (design only); implementation branch to be
  created after review (`feat/loop-health` proposed)
- Baseline: `faf4b55` (main)
- Status: DRAFT rev 1 — awaiting the two-track adversarial review (§9) and the
  owner's sign-off on decisions A/B (§3). Not implementable yet. No code, test,
  or runtime change is authorized by this document.
- Supersedes: `docs/subagent-softlanding-design.md` rev 4 §2.1 (the 60-turn
  backup wall) and the cap-related entries in its §5; amends the "existing
  behavior to preserve" bullet in `docs/subagent-delegation-task-list.md`
  ("The child turn cap is 60 per loop invocation…").
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
  (`src/runs/shared/subagent-control.ts`, defaults `needsAttentionAfterMs` 60s,
  `activeNoticeAfterMs` 240s, `failedToolAttemptsBeforeAttention` 3), and the
  review-style watchdog (`src/watchdog/`, `loop-risk` warning category).
- Claude Code 2.1.88 restored source (`/Users/z/Z/claude-code-sourcemap/restored-src`):
  built-in agents set no `maxTurns` (explore/general-purpose/plan); the fork
  subagent is the lone wall (`forkSubagent.ts:65`, `maxTurns: 200`);
  `maxTurns` gates the query loop only when the caller supplies it
  (`query.ts:1705-1717`, `max_turns_reached` attachment); termination is
  user-driven (Ctrl+C / TaskStop). No anomaly detection exists on either side.
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
5. This batch answers rev 4's rationale head-on: it builds the missing
   observation channel (detection + surfacing) and removes the count wall. The
   owner-approved scope refinement: detection is **observation-only in this
   batch**; auto-abort is a separate decision; whether any last-resort valve
   remains is an explicit owner decision (§3).

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
  (rev 4 §2.1: "wall arrived before the clock exactly in the cheap-turn honest
  scenarios") and detects the latter only after N turns *and* only silently.
- pi-subagents built a turn budget (soft wrap-up + hard termination + grace
  turns), then removed the whole mechanism in 0.59.0 — the strongest available
  evidence that count-based termination was the wrong shape even with an
  escape hatch.
- CC built-ins are uncapped; the fork wall (200) is a sanity fence, not a
  budget.
- The wall cannot see hung tools at all; imp's own rev 4 recorded this gap.

### 1.3 The gap this batch fills

After the wall is removed, children have no degenerate-loop *visibility* and
the main loop has none either (interactive is uncapped — `src/cli.ts:472`;
print defaults to 100 — `src/cli.ts:237`; neither has any detector). The
replacement is a shared monitor that identifies the three concrete degenerate
patterns both references guard against — repeated identical calls, repeated
failed mutations, and a tool left open too long — plus surfacing the child's
existing compaction-failure state honestly.

## 2. Goals / non-goals

Goals:

1. Remove the child turn cap: no `CHILD_MAX_TURNS`; loop launches uncapped.
2. One shared monitor (`src/core/health.ts`) consumed by the child engine and
   the main runner; identical signal definitions and thresholds, per-context
   surfacing.
3. Signals (v1): `repeat-loop` and `mutation-failure-streak` and `tool-open`
   (both loops) + `compaction-disabled` (child-engine fact).
4. Detection is observation-only: no prompts, no aborts, no new terminal
   statuses, `isError` semantics unchanged. (Owner decision B.)
5. Child facts reach the parent honestly: task-result lines, a TaskRecord
   field, and interactive live notes; the main loop gets interactive live
   notes. Print stdout stays byte-identical.
6. Tests and docs updated; the old pins are replaced by explicit new contracts.

Non-goals (with reason):

- No auto-abort / token valve in this batch. Whether any last-resort valve
  exists is owner decision A (§3).
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
detectors do not catch burns tokens until the user notices. Alternatives, both
deferred and both fed by the same monitor facts if later wanted: (i) opt-in
`task.maxTurns` argument (caller decides per dispatch); (ii) token-budget abort
(default off). Rationale for the proposal: count valves are the demonstrated
wrong shape (§1.2); the references keep termination time-based or user-based;
the guard worth building first is visibility.

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
  | "repeat-loop" | "mutation-failure-streak" | "tool-open" | "compaction-disabled";

export interface HealthSignal {
  code: HealthCode;
  count: number;  // peak observed run length for the condition (1 for tool-open)
  turn: number;   // cumulative assistant turns observed when first fired
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
  enabled?: boolean;                          // IMP_HEALTH=0 disables creation upstream
}): LoopHealthMonitor;
```

- The monitor observes the existing `AgentEvent` stream at the two call
  sites; `runAgentLoop` gains **no** new options and is behavior-unchanged
  when no monitor exists:
  - `runner.runTurnInner` (`src/runner.ts:1356-1421`): create one monitor per
    run; call `observe(event)` first in the existing `onEvent` wrapper; relay
    via `emit → options.onEvent({ type: "health", signal })`; `dispose()` in
    the existing `finally` (`src/runner.ts:1445`).
  - `subagent.runSubagent` (`src/core/subagent.ts:315-355`): create one
    monitor per attempt (fresh on resume; the overflow retry shares the same
    monitor — counts span both launches, documented); wrap `launchLoop`'s
    `onEvent`; relay via `emit → options.onEvent({ type: "health", signal })`
    (the task tool already attaches `{agent, cwd, sourceId,
    taskToolCallId}` — `src/core/tools/task.ts:877-884`); `dispose()` in the
    outer `finally`.
- `AgentEvent` (`src/core/loop.ts:17-20`) gains
  `| { type: "health"; signal: HealthSignal }` (type-only import; no loop
  behavior change). The variant is emitted by the callers, never by the loop.
  It flows through the existing relays: child → task tool → `turnEventTap` →
  REPL (`src/runner.ts:602-616`); main → `RunTurnOptions.onEvent` → REPL
  (`src/repl/repl.ts:653-680`). Extensions do not see it: their only relaying
  points forward `tool_end` (`src/runner.ts:617-631, 1413-1427`).
- Thresholds: exported constants + env overrides read once at monitor
  creation; malformed values fall back to the default silently (matching the
  repo's existing numeric-env style):
  `IMP_HEALTH=0` disables the monitor entirely (no facts, no emits);
  `IMP_HEALTH_REPEAT_TURNS` (default 5);
  `IMP_HEALTH_MUTATION_FAILURES` (default 3);
  `IMP_HEALTH_TOOL_OPEN_MS` (default 600_000).
- Lifecycle contract: the caller MUST `dispose()` after the loop settles
  (normal, abort, timeout, crash, throw). `dispose()` clears all pending
  timers; timers are `unref()`d (repo precedent: `src/repl/shell.ts:604-606`);
  a timer callback checks the disposed flag before emitting. Facts already
  recorded survive disposal.
- Concurrency: one monitor instance per child attempt; no shared mutable
  state; each child's events carry its own `sourceId`, which is also the REPL
  dedup key.

### 4.2 Signal catalog (v1)

| Code | Condition (all on the observed event stream) | Default | Fires |
|---|---|---|---|
| `repeat-loop` | R consecutive assistant turns whose tool-call signature is byte-identical: ordered `(toolName, sha256(canonicalJson(args)))` list | R=5 | once; `count` = peak run length; resets on any differing turn |
| `mutation-failure-streak` | K failed (`isError`) `edit`/`write` results since the last successful `edit`/`write` (non-mutating results do not reset the counter; a mutation success does) | K=3 | once; `count` = peak streak; `detail` carries tool + path when ≥2 share a path |
| `tool-open` | a single tool call still open (no `tool_end`) T ms after `tool_start` | T=600_000 | once per call; `detail` carries tool + preview + elapsed |
| `compaction-disabled` | child compaction disabled after 3 consecutive summarizer failures (existing path, `src/core/subagent.ts:295-299`) | 3 | once; fact-only via `note()` |

Notes:

- Signature canonicalization: extract the existing `canonicalJson` helper from
  `src/core/tools/task.ts:207-216` into `src/core/canonical.ts` and share it
  (`task.ts` keeps its launch-comparison use; health.ts uses the same helper —
  no second serializer). Fingerprints are computed over raw `tool_start` args
  (pre-validation), matching what the model actually sent.
- `detail` previews are single-line, ≤80 chars: `bash "` + first line of
  `command` + `"`, `edit <path>`, `write <path>`, otherwise the first line of
  canonical JSON. No REPL/presentation imports — a local minimal formatter.
- Threshold reasoning (to be challenged by review, tunable by env):
  R=5 — two or three identical retries occur legitimately during debugging;
  five byte-identical tool batches in a row is not a productive pattern; the
  signal is a note, so the threshold trades noise, not safety.
  K=3 — matches pi's `failedToolAttemptsBeforeAttention` default.
  T=10 min — long builds are legitimate; ten minutes without a tool returning
  is unusual enough to look at; far below the print-mode 60-minute clock.
- Documented limitations (accepted v1): rotating cycles (A,B,A,B…), same-tool
  different-arg loops, and semantic no-progress (e.g. repeated reads of the
  same file with different offsets) are not detected; pi's same-path-window
  variant of the mutation streak is approximated by the shared-path detail.

### 4.3 Facts and surfacing

**SubagentOutcome** gains `health: readonly HealthSignal[]` (possibly empty;
`settled()` snapshots `monitor.signals()`).

**TaskRecord** (`src/core/task-record.ts`) gains an optional additive field:

```ts
health?: ReadonlyArray<{ code: HealthCode; count: number; turn: number; detail?: string }>;
```

- Absent when no signal fired (clean runs keep the old record shape);
  `TASK_RECORD_VERSION` stays 1 (additive optional field); `parseTaskRecord`
  validates the field when present and keeps accepting old records.
- Bounded: deduped by code, ≤4 entries, first-fire order (producer-enforced).

**Task result text** (proposed strings, pinned by goldens at implementation;
≤4 lines, appended after all existing lines, `isError` unchanged; present in
every terminal shape when facts exist — completed, crash-with-partial,
abort/timeout handoff — never on `rejected`):

- `[task] health: repeated identical tool calls ×5 (last: bash "npm test") — the child may be looping; verify the result before relying on it.`
- `[task] health: 3 consecutive failed edits (last: edit src/a.ts) — the child may be stuck; verify the result before relying on it.`
- `[task] health: bash "npm run build" was still open after 10m05s — a single tool call held the child for that long.`
- `[task] health: child compaction disabled after 3 summarizer failures — later turns ran without context compression.`

**Interactive notes** (REPL only; the TUI/legacy REPL renders `▪` dim notes —
`src/repl/repl.ts:653-680` handles the event, then skips
`renderer.event`/`showResultFold` for it; the renderer's default switch case
already ignores unknown types, `src/render.ts:186-192`):

- once per `(sourceId ?? "main", code)` per run (dedup map cleared at run
  start); proposal: `▪ health: <agent>: repeated identical tool calls ×5 (last:
  bash "npm test")` for children, `▪ health: …` for main.
- The note fires on first signal occurrence; later growth updates the record
  and result line, not the note.

**Print mode**: no new stdout bytes (byte contract) and no new stderr writes;
child facts still reach the parent model through the task result, and the
record still lands in the parent session JSONL. Main-loop print anomalies get
no live surface in v1 (recorded as an open question, §7 Q3).

**Extensions**: unchanged (no new events; the health `AgentEvent` is not
forwarded to `emitToolEnd`/`emitMessageEnd`/`emitRunEnd`).

**Model-context statement**: the only model-visible addition anywhere is the
child's own task-result lines — the parent's decision input, deliberately in
the same family as the existing cap/timeout/transcript lines. No child context
is ever written; no main-agent context is ever written.

### 4.4 Cap removal specifics

- `src/core/constants.ts`: delete `CHILD_MAX_TURNS` (and its stale coupling
  comment about the clock derivation).
- `src/core/subagent.ts:339`: pass `maxIterations: Number.POSITIVE_INFINITY`
  with a comment naming this design; update the 2×60 overflow comment
  (`:201-203`) and the "bounded by CHILD_MAX_TURNS" remarks (`:290`).
- `max_iterations` remains in `SubagentStatus` (`src/core/subagent.ts:97-102`)
  and `TaskRecordStatus` (`src/core/task-record.ts:28-33`) as a legacy value:
  old records keep parsing; the main loop's explicit `--max-turns` still
  produces it; uncapped children can no longer produce it. The `taskResult`
  cap branch (`src/core/tools/task.ts:1014-1019`) stays (defensive; reachable
  only if a future explicit cap returns) and is documented as unreachable for
  children in this batch.
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
  `src/core/subagent.ts:376,406,414`): untouched — the monitor never touches
  signals/abort.
- Overflow retry: monitor spans both launches; repeat/streak counts continue
  across the boundary; `outcome.health` merges (one monitor).
- Resume (SA-07): each attempt has its own monitor and its own record; a
  resumed attempt's result lines reflect only that attempt.
- Compaction: `compactChildHistory` failure bookkeeping is unchanged; only the
  third-consecutive-failure point additionally calls
  `monitor.note("compaction-disabled", 3, …)`.
- Print byte contract: no new writes in print paths (runner wires no note
  surface; `emit` goes only to `RunTurnOptions.onEvent`, whose print caller
  is absent).
- M4 extension events: untouched; a repo-wide grep for the new variant in
  `src/extensions/` must stay empty (test item).

## 5. Change list

| File | Change | Est. lines |
|---|---|---|
| `src/core/health.ts` | NEW: codes, signals, monitor, thresholds, preview, signing | ~230 |
| `src/core/canonical.ts` | NEW: `canonicalJson` moved from task.ts, shared | ~30 |
| `src/core/loop.ts` | `AgentEvent` gains the `health` variant (type only) | ~5 |
| `src/core/subagent.ts` | monitor create/wire/dispose; `outcome.health`; compaction note; `Infinity` cap; comment fixes | ~60 |
| `src/core/constants.ts` | delete `CHILD_MAX_TURNS` + stale comment | ~-8 |
| `src/core/tools/task.ts` | result health lines; record wiring; import shared `canonicalJson` | ~45 |
| `src/core/task-record.ts` | optional `health` field + validation | ~35 |
| `src/runner.ts` | main monitor create/wire/dispose | ~25 |
| `src/repl/repl.ts` | health event handling + per-run dedup notes | ~35 |
| `test/health.test.ts` | NEW unit suite (incl. fake timers) | ~300 |
| `test/subagent.test.ts` | replace the 60-turn pin; uncapped + health facts + dispose | ~80 |
| `test/task-tool.test.ts` | result lines, record field, resume scoping | ~70 |
| `test/child-compaction.test.ts` | comment/assertion touch (`:184`) | ~5 |
| runner/REPL tests | event emission + note rendering (whichever suite owns them) | ~50 |
| docs | this file; softlanding supersede pointer; task-list bullet; CHANGELOG `Unreleased` | ~30 |

## 6. Test plan

1. Health unit — repeat-loop: exactly R identical turns fires; R-1 does not;
   peak count tracks growth; a differing turn resets; key-order-insensitive
   arg equality; preview is single-line ≤80 chars.
2. Health unit — mutation streak: 3 failed edit/write results fire (with
   non-mutating results allowed in between); a mutation success resets; other
   tools' failures are ignored; path detail present when ≥2 share a path.
3. Health unit — tool-open with fake timers: fires at T; `tool_end` before T
   cancels; `dispose()` cancels; fires once per call; timer callback after
   dispose is a no-op; timers are unref'd.
4. Health unit — facts contract: deduped by code, first-fire order, ≤4
   entries; `emit` called once per code (first fire); `IMP_HEALTH=0` disables.
5. Subagent — uncapped: a scripted child runs >60 tool turns then answers;
   `status` completed, `turns` = actual count.
6. Subagent — health facts: repeated identical tool turns produce
   `outcome.health` with `repeat-loop`, and the live relay delivers a `health`
   event through `options.onEvent`.
7. Subagent — dispose on abort/timeout/crash: fake-timer assertion that no
   monitor timer remains pending after settle.
8. Subagent — overflow retry: a repeat crossing the retry boundary counts on
   the same monitor; one merged facts array.
9. Subagent — compaction: 3 consecutive summarizer failures still disable
   compaction and now yield the `compaction-disabled` fact.
10. Task tool — result rendering: each code's line, exact strings, ≤4 lines,
    appended after existing lines; `isError` unchanged; `rejected` has none.
11. Task tool — record: `health` present only when fired; `parseTaskRecord`
    accepts/validates it; records without the field still parse (compat).
12. Task tool — resume: second attempt's record/result carry only its own
    facts; the first attempt's record is unchanged.
13. Runner — main loop emits `health` via `RunTurnOptions.onEvent`; history
    (main) receives no health writes; extensions receive nothing.
14. REPL — note rendering: one note per `(sourceId|main, code)` per run; child
    notes carry the agent label; dedup map resets per run; `renderer.event`
    and `showResultFold` are not invoked for health events.
15. Print mode — byte contract: a scripted print run with a looping child
    produces identical stdout to the baseline wiring apart from the model's
    own final text (no notes); stderr unchanged.
16. Grep tests: no `src/extensions/` reference to the health variant; no
    remaining `CHILD_MAX_TURNS` reference outside docs/history.
17. Update the old pins: `test/subagent.test.ts:99-113` (60-wall) replaced;
    `test/child-compaction.test.ts:184` comment updated (the append-only
    semantics assertion it guards — compaction buys no extra turns — stays).
18. Concurrency: two fake children with independent loops produce independent
    facts and per-source events (no shared state).

## 7. Risks and open questions

- **Detection quality.** False positives (noise) are bounded by dedup and the
  env escape hatch; false negatives (rotating loops, semantic no-progress)
  are documented limitations. The remedy is dogfood data, not more v1
  heuristics.
- **Cost after cap removal.** Unbounded TTY burn for undetected degenerate
  loops; estimate and the owner decision are recorded in §3-A/§4.4. The
  monitor facts are the future valve's data source.
- **Timer lifecycle.** The dispose contract plus unref plus fake-timer tests
  are the mitigation; missed dispose would leak a timer per tool call.
- **Signature limits.** Whitespace-only arg changes defeat repeat detection;
  accepted (the model re-sends what it sent; canonical JSON catches key order,
  not semantic equivalence).
- **Record growth.** Bounded (≤4 entries, detail ≤120 chars) and validated.
- **Text churn.** Result strings and note strings are goldens; print-mode
  stdout is untouched (test 15).
- **Open Q1**: threshold defaults (5 / 3 / 10 min) — tune by dogfood; env
  overrides exist from day one.
- **Open Q2**: extend `mutation-failure-streak` to bash mutation commands
  (pi's regex approach) in a later batch if dogfood shows missed cases.
- **Open Q3**: main-loop print-mode live visibility (stderr diagnostic line)
  — deferred; revisit only if a real print incident is recorded.
- **Open Q4**: result-line placement (appended last vs before the usage
  trailer) — implementation pins one; review may choose.
- **Open Q5**: whether main-loop facts should also reach the diagnostics
  logger — deferred (no consumer yet).

## 8. Implementation/rollout sketch (after review closes and A/B are signed off)

1. `health.ts` + `canonical.ts` + unit tests (pure, no wiring).
2. `loop.ts` variant + runner/subagent wiring + REPL notes.
3. Cap removal + task tool/record/result + test updates.
4. Docs (supersede pointers, task-list bullet, CHANGELOG) + full suite,
   typecheck, lint; independent implementation review per repo agreements;
   merge to main via `--no-ff` only after both.

## 9. Review record

- Round 1 (two-track adversarial, fresh context): PENDING.
