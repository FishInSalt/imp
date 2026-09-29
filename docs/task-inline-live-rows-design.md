# Task inline live rows: design for independent review

Status: **draft — awaiting independent adversarial review**. This document
changes no runtime behavior. No commit to `main`, merge, provider request,
deployment, or release is part of this work.

Baseline: `0fe1276` (`main`). Branch: `docs/task-inline-live-rows`.

## 1. Problem and observed cause

When the main agent launches several `task` calls concurrently, the TUI shows
each task's `● task …` header in the transcript and every running task's live
overview (`└─ pending #N.n …`) grouped at the bottom in the activity region:

```
● task  scout · PROMPT-ONE      ← transcript (persistent, top)
● task  scout · PROMPT-TWO
● task  scout · PROMPT-THREE
└─ pending #2.1 scout  …        ← activity region (transient, bottom)
└─ pending #1.1 scout  …
└─ pending #3.1 scout  …
```

Two distinct causes were reproduced on a throwaway branch (a temporary
`runRepl with shell:tui` case that emitted three concurrent `task` starts and
then child events in a different order):

1. **Structural separation.** The `● task` header is a transcript fold appended
   at `tool_start` (`TranscriptSink`'s tool sink, `src/repl/transcript.ts:65-78`,
   per `docs/task-live-display-design.md` §1). The live overview is a row in the
   activity region (`TuiShell.renderActivity`, `src/repl/shell.ts:652-680`), and
   the activity container is a sibling added *below the whole transcript*
   (`src/repl/shell.ts:309-310`). With one task the header is the last transcript
   line and reads as attached; with N>1 the headers and rows form two groups.
2. **Row order.** The activity rows are not in launch order. When the first child
   event of a source arrives, `ReplMachine.trackActivity` deletes the provisional
   parent row `task:<id>` and inserts the source row `source:<s>` at the end of
   the same `Map` (`src/repl/repl.ts:1156-1170`); `renderActivity` iterates in
   `Map` insertion order, so positions follow first-event arrival while the `#N`
   ordinals follow launch order (`src/repl/shell.ts:653-666`). Reproduced as
   headers `p1,p2,p3` vs rows `#2.1, #1.1, #3.1`.

## 2. Decision

Owner selected **B1**: render each running task's live overview **inline in the
transcript, directly under its own `● task` header**, by extending the existing
tool fold. Task rows leave the activity region; the activity region keeps its
other duties (non-task tool rows, the `thinking`/`compacting` spinner).

Rationale for rejecting the alternatives is in §9. Short version:

- B1 is the only option that both pairs header↔overview and keeps the running
  call's arguments in the transcript (the behavior `task-live-display-design.md`
  §1 was written to guarantee), while leaving the settled transcript
  byte-identical to replay.
- B3 ("keep running task in the region, write the block to the transcript only
  on completion") reverts §1 for tasks, loses the interrupted-task record
  (`createToolSink.finalize` drops prepare-only entries,
  `src/repl/tool-presentation.ts:707-712`), and reorders a call's input in mixed
  concurrent batches relative to replay.
- A dedicated task UI component would be the first violation of imp's
  structured-semantics + host-owned-layout contract (`ToolPresentationHooks`,
  `src/core/tools/types.ts:54`) and would duplicate the fold's sanitization,
  wrapping, expansion, and evidence machinery.

## 3. Current integration boundaries (verified)

- `ReplMachine` is the only producer of the activity snapshot. `trackActivity`
  (`src/repl/repl.ts:1134`) keeps `activityParents` (keyed by parent
  tool_call id) and `activityAgents` (keyed by `task:<id>` / `source:<s>`);
  `pushActivity` (`:1257`) hands `TuiShell.setActivity` a copy: `tools`,
  `agents` (`src/repl/line-input.ts:163-193`).
- Top-level events reach `trackActivity` first, then `renderer.event`
  (`src/repl/repl.ts:667-672`). For a `task` call that means the snapshot is
  updated before the transcript fold is appended at `tool_start`.
- `TuiShell` receives the snapshot in `setActivity` and rebuilds the activity
  container in `renderActivity` (`src/repl/shell.ts:610-680`). It owns the
  ordinal map `taskOrdinals` and the 120ms ticker that refreshes elapsed
  seconds while the phase is not `idle` (`src/repl/shell.ts:591-606`).
- `TranscriptSink` owns the folds. `createToolSink`'s append callback builds a
  `ToolBlockFold` per `ToolBlock` (`src/repl/transcript.ts:65-78`); input blocks
  carry `block.id === toolCallId`. `toolFolds` is the ordered list;
  `inputFolds` is a `WeakMap<ToolBlock, ToolBlockFold>` used for the in-place
  interruption update (`src/repl/transcript.ts:59, 74-79`).
- `ToolBlockFold` renders the call header and body and caches by
  `(width, expanded, raw)` (`src/repl/components/tool-block.ts:87-114`); the
  header chain is `src/repl/components/tool-block.ts:380-455`.
- The task-specific live row shape today is three single-line rows rendered by
  `ToolActivity.setTaskRows` (`src/repl/components/tool-block.ts:661-687`),
  using the `activityText`/`activityCount` sanitizers.

## 4. Goals / non-goals

Goals:

1. A running task's live overview renders immediately under its own `● task`
   header, in the transcript, so header and overview cannot be separated.
2. Elapsed seconds keep ticking while any task runs (TUI only).
3. The settled transcript after a turn is unchanged in structure: the live rows
   disappear and the task fold shows exactly what it shows today (header with
   `✓`/`✗` and elapsed, then the result fold).
4. Print mode and the legacy shell are byte-for-byte unchanged. Replay shows no
   live rows (there are no live child events) and is otherwise identical.

Non-goals:

- Moving non-task tool rows (`bash`, `read`, …) out of the activity region.
  `docs/tui-tool-elapsed-design.md` non-goal 1 ("no live/ticking elapsed in
  transcript rows; transcript rows stay settle-only") is **amended for the task
  live row only**; it remains in force for every other tool row.
- A dedicated task component or a free-form tool-supplied component.
- A `taskRecord`-driven result rendering path (separate batch; §8).
- Changing the concurrency batching in `src/core/loop.ts` or the snapshot
  contract beyond the additions below.
- Any ordering change to transcript entries (calls stay in call order).

## 5. Design

### 5.1 Live-row surface on the fold

`ToolBlockFold` gains a live-row channel:

- `setLiveRows(rows: readonly string[] | null): void` — stores the rows (or
  clears them) and invalidates the render cache. It increments an internal
  `liveRevision` so the cache key can distinguish content.
- The cache key becomes `(width, expanded, raw, liveRevision)`.
- `render(width)` inserts the live rows **immediately after the call header
  row(s)** and before any body/path/metadata rows. The header is emitted by the
  `if (call) { … }` chain (`src/repl/components/tool-block.ts:380-455`); the
  insertion point is the row index captured right after that chain. Each live
  row is one physical line: `DIM` + `ellipsize(activityText(row), w)`, reusing
  the existing helpers so control-character handling matches the activity
  region. Live rows ignore `expanded` (they show whether the fold is collapsed
  or expanded) and never affect the `summaryVisible`/evidence accounting, which
  is computed from the block body only.
- `setLiveRows` is a no-op for output/diff folds (`block.kind !== "input"`), so
  the result fold can never carry live rows.

### 5.2 Routing from the shell to the transcript

`TranscriptSink` gains a small, purpose-built seam:

- An `inputFoldById: Map<string, ToolBlockFold>` populated in the append
  callback when `block.kind === "input"` (id = `block.id`), and cleared in
  `clear()` (`src/repl/transcript.ts:85`). Id reuse across runs is safe because
  `clear()` resets the map; within a run tool_call ids are unique.
- `liveRowsById: Map<string, readonly string[]>` — the latest live rows per
  tool_call id, applied to the fold when it exists and remembered otherwise.
- `setLiveRows(toolCallId: string, rows: readonly string[] | null): void` —
  records `rows` (deleting the entry for `null`) and, when the input fold exists,
  forwards to `ToolBlockFold.setLiveRows`. The append callback checks
  `liveRowsById` when it creates an input fold and applies any recorded rows, so
  a `setLiveRows` that arrives before the fold does is not lost (see §5.4).
  Both maps are cleared in `clear()`. The `ToolBlock`→fold weak map is untouched.

The shell needs no new event channel: it already receives the full per-task
state (`agent`, `task`, `toolCount`, `lastTool`, `sourceId`, `taskToolId`) in
the snapshot. In `renderActivity` it builds each running task's rows exactly as
today and pushes them via `transcript.setLiveRows(agent.taskToolId, rows)`
instead of adding a `ToolActivity` row to the container.

### 5.3 Shell changes

`TuiShell.renderActivity` (`src/repl/shell.ts:610-680`):

- Keep the `thinking`/`compacting` spinner rows and the non-task `tools` loop
  (`activityContainer`/`activityRows`) unchanged.
- In the `agents` loop, replace `row.setTaskRows(...)` + container insertion
  with a call to `this.options.transcript.setLiveRows(agent.taskToolId, rows)`.
  The ordinal/discriminator computation (`taskOrdinals`, `#N`, `#N.n`) and the
  three-row shape (`└─ pending …`, prompt, `N tool starts · last: …`) are
  unchanged; only the destination changes.
- Track the set of task ids written in the previous pass; for any id no longer
  present, call `setLiveRows(id, null)` so a finished/interrupted task sheds its
  live rows. On the `idle` branch, clear every tracked id and reset
  `taskOrdinals` as today (`src/repl/shell.ts:612-616`).

The ticker is unchanged: it still calls `renderActivity` every 120ms while the
phase is not `idle`, so elapsed seconds refresh. To avoid needless transcript
repaints, `renderActivity` compares the freshly built rows with the rows last
set for that id and skips `setLiveRows` when they are identical (the revision
guard means this also avoids cache invalidation).

### 5.4 Lifecycle

- **Task start.** `trackActivity` creates the parent row and pushes the
  snapshot (`src/repl/repl.ts:667`) *before* `renderer.event` appends the
  `● task` fold (`:672`). So the first `setLiveRows` for that id runs with no
  fold present; it is recorded in `liveRowsById` and applied when the append
  callback creates the fold. There is no visible gap, and the pending record
  must never create a second fold. (The 120ms ticker re-syncs anyway, but the
  design must not depend on it for first paint.)
- **Child events.** Each `tool_start`/`tool_end` from a source updates the
  snapshot and re-pushes; the shell refreshes the rows.
- **Task end.** `trackActivity`'s `tool_end` branch deletes the agent rows and
  pushes activity (`src/repl/repl.ts:1227-1239`) — the shell clears the live
  rows — *before* `renderer.event` runs the sink's `end`, which appends the
  result fold and updates the input fold with `elapsedMs` (`✓`/`✗`). The live
  rows are therefore gone before the completion marker lands.
- **Interrupt / turn end.** `clearActivity` (`src/repl/repl.ts:1276-1290`)
  parks the region at `idle`; the shell's idle branch clears all live rows and
  `toolSink.finalize()` marks emitted, nonterminal inputs `interrupted (no
  result)` as today.
- **Replay.** `replaySession` emits starts/ends from stored messages with no
  child events, so `setLiveRows` is never called with rows; replay output is
  unchanged.

### 5.5 Ordinal determinism

The row-position defect from §1.2 disappears by construction: task rows are no
longer listed together, so there is no shared order to scramble. Ordinals are
still assigned on first sync of a `taskToolId`; because `trackActivity` pushes
the snapshot at every event, the parent row is synced in launch order before any
source replaces it, so `#N` follows launch order and stays stable across the
parent→source swap (`taskOrdinals` keys on `taskToolId`, unchanged). No `seq`
field is added; see §8 for the residual risk if a future producer pushes
snapshots in a non-launch order.

## 6. Ordering / lifecycle examples

Notation: `I(A)` = A's input fold (the `● task` header), `R(A)` = A's live
rows, `O(A)` = A's result fold. Launch order A, B; child events for B arrive
first.

- Start: snapshot syncs A then B → `I(A) [R(A)]`, `I(B) [R(B)]` in transcript
  order. Rows sit under their own headers regardless of which child speaks
  first.
- Child event for B: only `R(B)` refreshes; A's rows are unchanged and are not
  re-invalidated.
- End B, then end A (loop emits ends in call order): `R(B)` cleared, then `O(B)`
  appended; `R(A)` cleared, then `O(A)` appended. Settled transcript:
  `I(A) O(A) I(B) O(B)` — call order, identical to replay.
- Abort with A running: `R(A)` cleared, `I(A)` becomes
  `task · interrupted (no result)`; no `O(A)`.

## 7. Tests

New/updated coverage (extend `test/repl-tui.test.ts` and
`test/task-live-display.test.ts`):

1. Concurrent tasks: three `task` starts plus child events in a non-launch
   order; assert each `● task … PROMPT-X` header is immediately followed by its
   own `pending #N …` rows (measured by row adjacency in the frame, not by a
   global string index) and that the ordinal order equals launch order.
2. Ticker: while a task runs, the elapsed seconds in the inline row advance
   across ticks (deterministic clock as in existing elapsed tests).
3. Completion: when a task ends, its inline rows disappear and the fold shows
   the `✓`/result exactly as today; other tasks' rows are untouched.
4. Interrupt: aborted run leaves `interrupted (no result)` and no live rows.
5. Replay: a seeded session with a `task` call renders no live rows and is
   byte-identical to the pre-change replay output.
6. Print/legacy: unchanged output (existing suites must stay green; no edits to
   `src/render.ts`).
7. Fold cache: `setLiveRows` with identical content does not invalidate; with
   changed content it does; output folds ignore it.

Existing assertions that match `pending #N` inside the whole frame keep passing
(the rows still appear in the frame, now inside the fold). Tests that assert
"the live row is gone after the task ends" also keep passing because the rows
are cleared.

## 8. Risks and open points for the reviewer

1. **Transcript re-render cost.** Live rows live in the transcript, which the
   TUI re-lays out on change. Mitigation: fixed three single-line rows of
   constant height, and the identical-content skip in §5.3. The reviewer should
   confirm the ticker does not cause visible jitter or unbounded repaint.
2. **Scroll-away.** A long-running task's header can scroll off the top; its
   live row goes with it. This is the accepted cost of B1 (the activity region
   was always visible). No mitigation in this batch; call it out in the
   changelog.
3. **Snapshot→fold ordering at start.** §5.2/§5.4 require that `liveRowsById`
   never creates a fold and that the append path remains the only fold creator;
   the reviewer should confirm the pending-record path cannot leak rows onto a
   later, unrelated fold that reuses the id within the same run (ids are unique
   per run, and `clear()` resets the map — verify this is airtight).
4. **Ordinal determinism** relies on `trackActivity` pushing the parent snapshot
   before any source replaces it (§5.5). If that invariant is considered too
   implicit, the alternative is a monotonic `seq` on `ActivityAgentLine` used to
   sort before ordinal assignment. This document does not add it.
5. **`ToolActivity.setTaskRows`** becomes unused by production code. Decide in
   review whether to delete it or keep it as a test-only helper.
6. **`taskRecord`-driven result rendering** (the task result is currently
   recognized by regex over text, not from the persisted `ToolResult.taskRecord`)
   is explicitly out of scope; it should be its own batch with its own review.
7. **Non-task live rows in a two-tool batch.** When a `task` and a non-task tool
   (e.g. `bash`) run concurrently, the task's rows are now in the transcript
   while `bash`'s row stays in the activity region, so one batch spans two
   regions. The reviewer should confirm this is coherent (it follows directly
   from the chosen scope) and not a new instance of the reported problem.

## 9. Alternatives considered

- **B2 — keep the region, fix ordering, number the headers.** Smallest change,
  but header and overview stay in two blocks; the owner rejected it as not
  actually attaching the overview.
- **B3 — keep running tasks in the region, write the block on completion.**
  Reverts §1 for tasks (arguments not inspectable/expandable while running),
  drops the interrupted-task record, and reorders inputs in mixed concurrent
  batches relative to replay (§2).
- **Dedicated task component.** Rejected: duplicates fold machinery and breaks
  the host-owned-layout contract.
- **Deferring all tool inputs to end.** Would make live order match nothing and
  revert §1 globally.
