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
then child events in a different order; that test is not committed, but both
causes are independently confirmable in the source cited below):

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

B1 also requires explicit amendments to two settled design docs (recorded in
§4.1): `docs/tui-tool-elapsed-design.md` non-goal 1 (settle-only transcript rows)
and `docs/task-live-display-design.md` §2 ("Keep the activity region separate
from persistent input folds") — the latter is the rule that created the separate
`pending #N` rows this batch moves into the fold.

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
   live rows (it renders through a byte-stream `Renderer` and never calls
   `setActivity`, §5.4) and is otherwise identical.

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

### 4.1 Amendments to existing design docs

- `docs/tui-tool-elapsed-design.md` non-goal 1 ("No live/ticking elapsed in
transcript rows — the activity region owns in-flight state and is unchanged.
Transcript rows stay settle-only") is superseded **for the task live row only**.
Non-task tool rows remain settle-only and keep their elapsed only at settle.
- `docs/task-live-display-design.md` §2 ("Keep the activity region separate from
persistent input folds") is superseded for the running-task overview, which now
lives in the input fold. §2's other constraints (identity-first content, the
three-line shape, `pending` wording, tool counts mean observed child tool starts)
stand unchanged.

## 5. Design

### 5.1 Live-row surface on the fold

`ToolBlockFold` gains a live-row channel:

- `setLiveRows(rows: readonly string[] | null): void` — stores the rows (or
  clears them) and invalidates the render cache. It increments an internal
  `liveRevision` so the cache key can distinguish content.
- The cache key becomes `(width, expanded, raw, liveRevision)`.
- `render(width)` inserts the live rows **immediately after the call's header
  row(s)** and before any body/path/metadata rows. The header is not emitted at
  one site: the header chain (`src/repl/components/tool-block.ts:380-455`) emits
  it from `addHeader()` (`419-425`, the plain and the deep-path case), the
  combined header+path row for `pathFirst` (`432`, `443-445`), or — the case
  that applies to `task`, which has no `callPath` so `pathFirst` is false
  (`:157-161`) and the collapsed branch runs — the first body row emitted with
  the header prefix (`emit(body[0], …, prefix, spans, …)`, `:449-452`). Specify
  the anchor as: capture `const headerEnd = rows.length` immediately after the
  whole `if (call) { … } else if (block.title) …` chain (i.e. just before the
  `if (block.callPath …)` metadata block at `:467`), and splice the live rows in
  at `headerEnd` once at the end of `render`, before the cache store. A pinned
  test must assert the collapsed `task` fold is exactly: header row, live rows,
  body.
- Each live row is one physical line: `DIM` + `ellipsize(activityText(row), w)`,
  reusing the existing helpers so control-character handling matches the
  activity region. Live rows ignore `expanded` and never affect the
  `summaryVisible`/evidence accounting, which is computed from the block body
  only.
- `setLiveRows` is a no-op for output/diff folds (`block.kind !== "input"`), so
  the result fold can never carry live rows.

### 5.2 Routing from the shell to the transcript

`TranscriptSink` gains a small, purpose-built seam:

- `inputFoldById: Map<string, ToolBlockFold>` — the input fold for a tool_call
  id, populated in the append callback when `block.kind === "input"`. Used by
  the push path only.
- `setTaskLiveRows(key: string, rows: readonly string[] | null): void` —
  forwards to the input fold when it is known; a no-op when it is not. (Named
  distinctly from `ToolBlockFold.setLiveRows` in §5.1 to avoid two same-named
  methods on the two layers.)
- `setTaskLiveRowsResolver(fn: (key: string) => readonly string[] | null)` —
  called by the append callback when it creates an input fold, so a fold created
  *after* the shell already published rows still gets them at creation time. The
  shell's resolver reads its own current per-task row map, which the snapshot
  push has already populated (`trackActivity` precedes `renderer.event`,
  §5.4).
- `inputFoldById` is cleared in `clear()` (`src/repl/transcript.ts:85`). No
  `finalize()` hook is needed and none is added: the resolver retains no per-id
  payload, and the map only ever holds the newest input fold for an id — exactly
  the fold a currently running task owns. (`createToolSink.finalize` is invoked
  on the sink object directly — `src/repl/repl.ts:699, 1277`,
  `src/render.ts:259` — and the transcript's `createToolSink` seam
  (`src/repl/transcript.ts:65-82`) exposes no finalize callback, so a
  finalize-clearing requirement would not be implementable; it is also
  unnecessary for the reason above.)

Resolver wiring, teardown, and purity:

- `TuiShell.start()` installs the resolver, mirroring `transcript.onUpdate`
  (`src/repl/shell.ts:270`), so it is set before the first fold is ever created —
  in the live and the replay paths alike. `stopTerminal()` unbinds it behind the
  same ownership guard as `boundOnUpdate` (`src/repl/shell.ts:1080-1082`): the
  **same `TranscriptSink` is handed from the one-shot trust-ask shell to the real
  REPL shell** (`src/repl/shell.ts:1076-1079`), so a successor shell's resolver
  must not be clobbered by the predecessor's teardown (and vice versa).
- The append callback calls the resolver optionally —
  `this.taskLiveRowsResolver?.(block.id) ?? null` — so bare-sink paths that have
  no shell (tests construct `new TranscriptSink()` and call
  `transcript.toolSink.start(...)`, e.g. `test/repl-tui.test.ts:239`,
  `test/task-live-display.test.ts:53`) and any fold created before `start()`
  never throw. This optionality is required, not defensive.
- The resolver is a **pure read** of the shell's already-computed row map: it
  must not call `setActivity`/`renderActivity`, mutate the transcript, or create
  a fold. It runs inside the append closure (`src/repl/transcript.ts:66-72`),
  which then calls `appendChild` and `onUpdate`; re-entering the render path
  there would corrupt the append.

Tool_call ids are **not** unique within a run: `src/provider/openai-completions.ts:431`
synthesizes `call_${tc.index}` when the provider omits ids, and one `runTurn`
can stream several assistant messages (`src/core/loop.ts:164`). The id map is
consequently "latest writer wins", which is correct here because the shell only
ever addresses currently running tasks, whose fold is the newest for that id,
and it clears a task's rows when the task ends — before the next message's calls
are created. There is no long-lived per-id payload: the resolver pulls the
shell's live state, so a stale id can never carry rows into a later fold.

The shell needs no new event channel: it already receives the full per-task
state (`agent`, `task`, `toolCount`, `lastTool`, `sourceId`, `taskToolId`) in
the snapshot. In `renderActivity` it builds each running task's rows exactly as
today and pushes them via `transcript.setTaskLiveRows(key, rows)` instead of
adding a `ToolActivity` row to the container.

### 5.3 Shell changes

`TuiShell.renderActivity` (`src/repl/shell.ts:610-680`):

- Keep the `thinking`/`compacting` spinner rows and the non-task `tools` loop
  (`activityContainer`/`activityRows`) unchanged.
- In the `agents` loop, replace `row.setTaskRows(...)` + container insertion
  with a call to `this.options.transcript.setTaskLiveRows(key, rows)`, where `key`
  is the existing `parentKey` (`agent.taskToolId || agent.sourceId || ""`,
  `src/repl/shell.ts:654`) rather than the raw `agent.taskToolId` — the latter
  can be `""` (`src/repl/repl.ts:1163` falls back to `""`). The
  ordinal/discriminator computation (`taskOrdinals`, `#N`, `#N.n`) and the
  three-row shape (`└─ pending …`, prompt, `N tool starts · last: …`) are
  unchanged; only the destination changes.
- Track the set of task keys written in the previous pass; for any key no
  longer present, call `setTaskLiveRows(key, null)` so a finished/interrupted
  task sheds its live rows. On the `idle` branch, clear every tracked id and reset
  `taskOrdinals` as today (`src/repl/shell.ts:612-616`).

The ticker is unchanged: it still calls `renderActivity` every 120ms while the
phase is not `idle`, so elapsed seconds refresh. To avoid needless transcript
repaints, `renderActivity` compares the freshly built rows with the rows last
set for that key and skips `setTaskLiveRows` when they are identical (the
revision guard means this also avoids cache invalidation).

### 5.4 Lifecycle

- **Task start.** `trackActivity` creates the parent row and pushes the
  snapshot (`src/repl/repl.ts:667`) *before* `renderer.event` appends the
  `● task` fold (`:672`). By the time the append callback creates the input
  fold, `renderActivity` has already computed and stored that task's rows, so
  the resolver returns them and they are painted at creation — no gap, no second
  push required, and the resolver never creates a fold (the append callback is
  the only fold creator). The 120ms ticker re-syncs afterwards. This holds on the
  normal event path only: `fillMissingToolResults` (`src/core/loop.ts:269-281`)
  synthesizes results without emitting `tool_end`, so an aborted task's rows
  persist until the turn-end idle push — pre-existing behavior, covered by the
  abort case in §6.
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
- **Replay.** `replaySession` renders through a `Renderer` byte stream
  (`src/repl/replay.ts:38-56`) and never calls `TuiShell.setActivity`, so no
  rows are ever published. It does reuse the transcript's `toolSink`
  (`src/repl/repl.ts:1538`), so input folds are created and the resolver runs —
  it reads the shell's row map, which is empty outside a live run, and returns
  `null`. Replay output is unchanged.

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
8. Bare sink: creating an input fold with no resolver installed (a plain
   `new TranscriptSink()` + `transcript.toolSink.start(...)`, and replay) must
   not throw and must render without live rows.
9. Shared-sink ownership: the trust-ask shell's teardown must not clobber the
   real shell's resolver (mirror the existing `onUpdate` guard test), and the
   resolver must be installed before the first fold is created.
10. Resolver purity: a resolver that is a pure read does not re-enter the render
    path (assert no `setActivity`/`renderActivity` recursion).

Assertion impact is **not** a blanket "existing tests keep passing". Two tests
drive `shell.setActivity` on a fold-less sink (`makeShell`) and read the rows
straight off the activity container, so under B1 they must be rewritten, not
expected to pass:

- `test/repl-tui.test.ts:4065-4101` ("task snapshots retain ordinal epochs …")
  asserts `pending #1.2 same`, `pending #1 same`, and
  `transcript.toolFolds).toEqual([])` — there is no fold to carry the rows.
- `test/repl-tui.test.ts:4104-4130` ("working rows render pending tools and
  subagent tree lines") asserts `pending #1 scout` with no fold present.

The rewrite drives a real `task` tape (so an input fold exists) or moves the
row-shape assertions onto the fold. Also add a width-fit assertion (rendered rows
≤ width at 1/2/20/80) over a fold carrying live rows, since the fold's existing
width sweep does not know the new field.

## 8. Risks and open points for the reviewer

1. **Transcript re-render cost.** Live rows live in the transcript, which the
   TUI re-lays out on change; the activity region only re-rendered a small
   container. Mitigation: fixed three single-line rows of constant height, the
   identical-content skip in §5.3, and a coarse elapsed cadence (the seconds
   string drives the only expected per-tick change). Acceptance: pin the number
   of `requestRender` calls over a fixed number of ticks in a test, so the cost
   is per-second, not per-120ms.
2. **Scroll-away.** A long-running task's header can scroll off the top; its
   live row goes with it. This is the accepted cost of B1 (the activity region
   was always visible). No mitigation in this batch; call it out in the
   changelog.
3. **Snapshot→fold ordering at start.** §5.2/§5.4 use a pull resolver, so the
   transcript keeps no per-id row payload and a reused id cannot carry rows into
   a later fold. The resolver is installed in `TuiShell.start()`, is called
   optionally by the append callback, and is a pure read (§5.2); the append
   callback stays the only fold creator.
4. **Ordinal determinism** relies on `trackActivity` pushing the parent snapshot
   before any source replaces it (§5.5). If that invariant is considered too
   implicit, the alternative is a monotonic `seq` on `ActivityAgentLine` used to
   sort before ordinal assignment. This document does not add it.
5. **Id reuse within a run** is real (`src/provider/openai-completions.ts:431`).
   §5.2 relies on "latest writer wins" plus the shell clearing a task's rows
   before the next message's calls exist. The reviewer should confirm no path
   leaves a task running across an assistant-message boundary.
6. **`ToolActivity.setTaskRows`** becomes unused by production code, and
   `test/task-live-display.test.ts:94-100` still drives it. Decision for this
   batch: keep the component's task-row mode as the row-**shape** unit (it is
   pure formatting), and additionally own the shipped row shape with a fold-level
   test (§7). Delete it only if the fold-level test fully covers the shape.
7. **`taskRecord`-driven result rendering** (the task result is currently
   recognized by regex over text, not from the persisted `ToolResult.taskRecord`)
   is explicitly out of scope; it should be its own batch with its own review.
8. **Non-task live rows in a two-tool batch.** When a `task` and a non-task tool
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
