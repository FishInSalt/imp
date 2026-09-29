# Per-call settle: accurate concurrent timing and real-time completion display

Batch: `feat/tool-settle`. Base: `main@d244756` (rebased from the pre-`#confirm-prompt` main).

## 1. Problem

When one assistant message contains several concurrent `task` calls (the only
concurrency-safe tool, `src/core/tools/task.ts:348`), two things are wrong on
screen, and they share one root cause.

1. **Every call reports the batch's wall time.** All five rows showed
   `✓ 8.9s`. A call that finished in 3s still prints 8.9s.
2. **Nothing updates until the slowest call finishes.** A finished call keeps
   its `└─ pending #N.n …` row, has no `✓`, and has no `⎿` result block until
   the whole chunk settles.

## 2. Mechanism

`executeChunk` (`src/core/loop.ts:420-466`) runs in three phases: phase 1 emits
`tool_start` for every call in call order; phase 2 is a single
`await Promise.all(plans.map(...))` (`:460`); phase 3 emits every `tool_end` in
call order (`:463-465`). The buffering is deliberate and stays: the *result
order* must not depend on completion timing (history ordering, extension hook
order, and print bytes).

Both symptoms follow from the buffering:

- `createToolSink.start` stamps `entry.startedAt` when the renderer receives
  `tool_start` (`src/repl/tool-presentation.ts:666`), and `end` computes
  `clock() - startedAt` (`:684`). For a chunk, all starts are stamped at the
  same instant and all ends are processed back-to-back after `Promise.all`, so
  every call measures the same interval: phase 1 → end of phase 2.
- The activity row is removed by the *parent* `tool_end`
  (`src/repl/repl.ts:1231-1242`: `activityTools.delete` at `:1232`,
  `closedParents.add` at `:1234`, task-row delete at `:1236`), and the `✓`
  marker and `⎿` result block come from
  `toolSink.end` via `renderer.event(tool_end)`. All are the authoritative,
  buffered event.

The serial path is unaffected (`src/core/loop.ts:386-393`): `tool_start` and
`tool_end` are adjacent, so "start → end" equals the call's own runtime.

## 3. Goal and non-goals

**Goal.** For a concurrent chunk: (a) each call's displayed duration is that
call's own execution time; (b) a call's row disappears, its `✓` appears, and
its `⎿` result block lands under its own header *at the moment that call
settles* — not when the chunk ends.

**Non-goals.**

1. **The loop's emission order does not change.** `tool_end` still fires for
   every call, in call order, after the chunk settles.
2. **No change to print mode or the legacy shell.** Print keeps its
   `tool_end`-driven `⎿` lines and reproducibility; the legacy shell has no
   activity region to update early (§5).
3. **No change to history, the session file, extension hooks, or replay.**
4. **No change to the serial path** — byte-identical by construction (§4.1).
5. No retry/queueing semantics, no changes to which tools are concurrency-safe,
   no change to `MAX_CONCURRENT_TASKS`.

## 4. Design

### 4.1 Measure in the chunk, not in `runTool`

The measurement is taken in `executeChunk`'s phase-2 wrapper, around the moment
each plan settles:

```ts
const settled = await Promise.all(
  plans.map(async (plan) => {
    if (!("run" in plan)) return plan.result;   // validation/gate refusal: nothing ran
    const started = clock();
    const result = await plan.run(signal);
    const measured: ToolResult = { ...result, durationMs: clock() - started };
    onEvent?.({ type: "tool_settled", result: measured });
    return measured;
  }),
);
```

Why here and not in `runTool` (`:524-554`), which is the one place
`tool.execute` is awaited: measuring in `runTool` would *also* cover the serial
path and would silently change serial timings from "gate + execute" to
"execute". Keeping the measurement inside the chunk makes "the serial path is
byte-identical" a structural property rather than a promise. For a chunk,
`plan.run(signal)` *is* `runTool(...)` (`:520`, declared at `:524`), so
nothing is lost.

The clock is injected through `RunAgentLoopOptions.clock` (default `Date.now`,
matching `TranscriptSink`'s default clock) and threaded into `executeToolBatch`
/ `executeChunk` only. Deterministic tests need it; the repo precedent is
`Renderer.clock` and `TranscriptSink({clock})`.

A plan that never ran (schema refusal, blocked by a gate) has no `durationMs`
and emits no settle signal — it is instantaneous, and its `tool_end` still
closes it in phase 3.

### 4.2 The duration travels as a render-only field

`ToolResult.durationMs?: number` (`src/core/messages.ts:81-95`), alongside
`display` (`:86-90`) and with the same lifecycle: carried on the `tool_settled`
**and** `tool_end` **events**, stripped before the result enters history (so it
never reaches the model, a provider converter, the session file, or replay).
`persistableResult` (`:473-477`) currently
short-circuits on `display === undefined`; it becomes a two-field strip:

```ts
function persistableResult(result: ToolResult): ToolResult {
	if (result.display === undefined && result.durationMs === undefined) return result;
	const { display: _display, durationMs: _durationMs, ...rest } = result;
	return rest;
}
```

Phase 3 continues to emit `tool_end` with the *unstripped* result, exactly as
today — it simply carries one more display-only field.

The sink prefers the measured value and keeps its own window as the fallback
(`src/repl/tool-presentation.ts:684`):

```ts
const elapsed = result.durationMs ?? (entry.startedAt === undefined ? undefined : clock() - entry.startedAt);
```

The fallback still serves callers that build a result without a measurement:
serial calls (unchanged), orphan results, and tests that drive the sink
directly. The `!replay` guard stays, so replay remains marker-less.

### 4.3 A display-only settle event

New member of `AgentEvent` (`src/core/loop.ts:18-25`), next to `health`
(`:22-25`, the existing precedent for an event that is not an M4 extension
event):

```ts
| { type: "tool_settled"; result: ToolResult }
```

It is emitted once per executed chunk plan, at settle time, so it arrives in
**completion order**. That is safe because the transcript layer is already
arrival-order independent after `#task-inline-live-rows` (rows addressed by
tool_call key) and `#tool-result-follows-call` (result folds spliced after their
own call's anchor). Emission is unconditional — a subagent that fans out its
own concurrency-safe calls emits it too — and each consumer decides what to do
with a child-sourced one (§4.4).

### 4.4 Consumers

**The REPL tap** (`src/repl/repl.ts:662-689`) handles it like `health`
(`:667-670`) — before `renderer.event`, so the Renderer never sees it:

```ts
if (event.type === "tool_settled") {
	if (info === undefined) {
		this.trackActivity(event, info);
		this.toolSink?.end(event.result);
	}
	return;
}
```

Two deliberate narrowings:

1. **Top-level only.** A child-sourced settle is dropped. `trackActivity`'s
   child arm (`:1190-1193`) calls `prepareResult(calls.get(id), …)`, and
   `prepareResult` falls back to the *current* registry result hook when the
   record is missing (`src/repl/tool-presentation-hooks.ts:320`). Were the
   settle event to consume the record and the authoritative `tool_end` to
   arrive afterwards, that hook could fire twice. Children gain nothing here
   anyway: a child row is updated by its own `tool_start` (already real-time)
   and nothing visible changes on its `tool_end`. So the child arm keeps
   `event.type === "tool_end"`; a child-sourced settle is dropped entirely —
   no `trackActivity` call, so nothing is repainted either. (The snippet above
   is the whole branch; it must sit *before* the generic
   `this.trackActivity(event, info)` at `repl.ts:671`, or a top-level settle
   would run `trackActivity` twice.)
2. **The top-level arm treats both types identically.** `trackActivity`'s
   top-level `tool_end` arm (`:1231-1242`) deletes both the plain
   `activityTools` row and the task-specific state; the settle path must not be
   a half-copy of it. Making the condition
   `event.type === "tool_end" || event.type === "tool_settled"` keeps them
   literally the same body. A version that did only the task block would leave
   a non-task concurrency-safe tool's row until phase 3 — symptom 2 again.

`this.toolSink` is the same object the Renderer holds (`:395` receives
`options.toolSink`, built in `cli.ts` from the `TranscriptSink`; `:1559` hands
`tuiSink.toolSink` to `renderer.setToolSink`), so this is the same call the
Renderer would make for `tool_end`, minus the print/legacy branch.

**Idempotence** then rests on two structural facts:

- `createToolSink.end` returns immediately when `entry.terminal` is set
  (`src/repl/tool-presentation.ts:672`), so the authoritative `tool_end` cannot
  render a second marker or result fold. The result fold's placement is already
  idempotent through the `#tool-result-follows-call` anchor.
- The top-level `tool_end` arm is only `Map.delete`/`Set.add`/delete-loop
  mutations (all idempotent) plus `pushActivity()`, whose snapshot is unchanged
  because the rows are already gone.

**The renderer flush this path skips.** `tool_end` goes through
`renderer.toolEnd`, which runs `flushThinking(); flushMarkdown();
ensureNewline();` before `toolSink.end` (`src/render.ts:598-603`). The settle
path calls the sink directly and skips them. That is safe because phase 1's
`tool_start` already ran both flushes (`src/render.ts:533-535`) and no model
text is streamed during phase 2, so no renderer buffer can be pending when a
settle fires. §6 records the invariant.

### 4.5 Rejected alternatives

1. **Emit `tool_end` eagerly, restore order downstream.** Print mode renders
   the `⎿` line from `tool_end`; emission in completion order would make print
   bytes depend on timing, breaking reproducibility and existing tests. The
   buffering is not just an ordering convenience — it is the contract.
2. **Measure in `runTool`.** Silently changes serial timings (gate time would
   drop out of the window) and needs the clock threaded through two more
   functions. Rejected in favour of §4.1.
3. **Let the tool report its own duration.** Tools are extension/user-provided;
   a new required field would be a breaking contract, and it still would not
   tell the display *when* the call settled.
4. **Reuse `tool_end` with a `settled` flag.** Two distinct event types on one
   consumer path is how the print renderer would end up rendering the same
   result twice; a separate type keeps the "authoritative" and "display-only"
   roles textually distinct, matching `health`.
5. **Emit the settle event for refusal/validation plans too.** Those plans never
   ran, so they carry no duration. Their marker is already an error marker
   (`isError: true` → `✗`, derived by the sink at `tool-presentation.ts:689`),
   so emitting early could not turn it into a `✓` — but it would move a
   *blocked* call's `✗ <batch time>` earlier for no benefit and invent a
   duration for a call that never executed. They keep closing in phase 3
   (§6.8 records the cost).

## 5. Compatibility

| Surface | Why it is unchanged |
|---|---|
| Print stdout | `cli.ts:1052` wires `onEvent: (event) => renderer.event(event)` — the one `onEvent` wiring, with no separate tap. `Renderer.event`'s `default:` case is a no-op (`src/render.ts:173-176`), and `tool_settled` carries no new printable content. |
| Legacy shell | Only `TuiShell` implements `setActivity` (`src/repl/shell.ts:622`); `pushActivity` returns early without it (`repl.ts:1262`). `showResultFold` (`:717`) still runs only on `tool_end`, and the settle event is not routed to it. |
| Session file / history | `durationMs` is stripped by `persistableResult` (§4.2); the loop's `results` array is still filled in phase 3, in call order. |
| Extension hooks | Both dispatch sites gate on `event.type === "tool_end"` (`src/runner.ts:1450` top-level, `:609` child), so `tool_settled` never reaches `emitToolEnd`. |
| `#loop-health` | `observe` handles only `message_end` and `tool_end` (`src/core/health.ts:186-192`); everything else falls through. |
| Replay | `replaySession` feeds stored blocks; `end(result, replay = true)` skips the marker, and stored results carry no `durationMs` (stripped). |
| `#task-inline-live-rows` / `#tool-result-follows-call` | Both are arrival-order independent; this batch relies on that rather than changing it. |

## 6. Risks

1. **Print determinism.** The single biggest claim to prove. Mitigated
   structurally (§5) and by a byte-comparison test over a concurrent batch.
2. **Double rendering.** The sink's `terminal` guard and `trackActivity`'s
   idempotent mutations. Covered by asserting one marker and one result fold
   per call after a full run.
3. **Abort.** `runTool` catches every tool error (`src/core/loop.ts:546-553`),
   so phase 2's `Promise.all` never rejects and phase 3 always runs, pushing a
   result for every plan that settled (`:462-464`); `fillMissingToolResults`
   (`:269`) skips ids already in `results`. A call that emitted a settle signal
   therefore **cannot** be synthesized — it always gets its plain, no-op
   authoritative `tool_end`. Conversely, a call that *is* synthesized (aborted
   in phase 1 `:432`, or in an unstarted later chunk `:403`) never emitted a
   settle signal. The real abort case (input fold with no result) is covered by
   `finalize()`, unchanged.
4. **Nested concurrency** (a subagent fanning out its own `task` calls): the
   child's settle event is ignored by design (§4.4); its authoritative
   `tool_end` runs `prepareResult` exactly once, and child rows were already
   updated in real time by their `tool_start`.
5. **Clock source.** `Date.now()` can jump (system clock changes, suspend). The
   activity rows and the sink already use `Date.now()`; keeping one convention
   is preferred to introducing a second clock. Recorded as a known limitation
   rather than fixed here.
6. **The activity row now disappears before the `⎿` block is guaranteed to be
   in the transcript** — they are driven by two different calls in the tap
   (`trackActivity` then `toolSink.end`). They are synchronous and adjacent, so
   no frame can observe the gap, but the order in the tap is deliberate.
7. **Renderer flush skipped** (§4.4): safe only while phase 1's `tool_start`
   flushes thinking and markdown and no model text streams during phase 2. A
   future change that lets text stream while a chunk runs would break it; the
   invariant is written down here so that change has to notice.
8. **Refusal plans keep the old behaviour** (§4.5 item 5): a schema refusal or
   gate-blocked call in a chunk still shows its marker and keeps its
   `activityTools` row until phase 3, and its duration is still the batch wall
   time. Accepted: it never ran, so there is no per-call runtime to report.
9. **Two duration semantics in one run.** A serial call's duration stays
   `gate + execute` (the sink window), while a chunked call's is `execute`
   alone (§4.1). Accepted, and the reason the split exists: it is what keeps
   the serial path byte-identical.
10. **`onEvent` throwing on the settle path** rejects phase 2's `Promise.all`
    and aborts the chunk. Phase 3's `tool_end` emit has the same exposure today,
    so this is not a new class of failure; the design deliberately matches it
    rather than wrapping the emit in a `try`/`catch` that would silently drop
    display updates.

## 7. Test plan

1. **Per-call duration (red first).** Injected loop clock; two concurrent
   concurrency-safe calls with different runtimes → each `durationMs` is its
   own value and each rendered header shows its own `✓ Xs` (today both show the
   batch time). The loop clock governs chunk durations; the sink's own clock
   governs only the serial/fallback window (§4.2) — the test must not conflate
   them.
2. **Real-time display (red first).** Gated fake tool: call `a` resolves while
   `b` is still pending → assert, before `b` settles, that `a`'s activity row is
   gone, `a`'s header carries `✓`, and `a`'s `⎿` block is rendered under it.
3. **Idempotence.** After the chunk's authoritative `tool_end`s, exactly one
   marker and one result fold per call.
4. **Session bytes.** A concurrent batch's persisted tool-result messages are
   identical before/after (no `durationMs`).
5. **Print bytes.** A concurrent batch's stdout is identical before/after.
6. **Serial regression.** A serial call renders header + result as today; its
   duration still comes from the sink window.
7. **Abort.** Abort a chunk while a call is in flight: the started call renders
   exactly once (settle signal, then a no-op authoritative `tool_end`); a call
   that never started is closed by `fillMissingToolResults` and emits no settle
   signal at all.
8. **Extension and health counts.** `tool_end` handlers fire once per call in
   call order; `health.observe` sees no new signal.
9. **Replay.** No duration markers.
10. **Child-sourced settle is inert.** A subagent fanning out two `task` calls
    emits settle events with `info`; assert the parent's child activity state is
    untouched by them, and that each child `tool_end` still calls the result
    hook exactly once.
11. **Refusal plans unchanged.** A chunk containing a gate-blocked call: its
    row and marker still appear at phase 3, and no settle event is emitted for
    it.

## 8. Review log

**Round 1 — independent adversarial review (fresh context), verdict
PASS-WITH-CHANGES.** Verified correct line-by-line: the three-phase
`executeChunk`; the serial path; `runTool` as the single `tool.execute` await;
`persistableResult`; `createToolSink` stamping and the `terminal` guard; the
top-level activity-row removal; the `health` precedent in the tap;
`Renderer.event`'s no-op default; only `TuiShell` implementing `setActivity`;
both extension dispatch gates; `health.observe`'s type checks; arrival-order
independence for transcript anchors *and* activity ordinals (ordinals are
assigned in phase 1, before any settle); and that `durationMs` cannot reach a
provider converter. Findings folded in:

1. (major) The branch predated a `main` that had moved (another worktree merged
   `#confirm-prompt`); `repl.ts`/`shell.ts` citations were re-derived against the
   post-rebase tree.
2. (major) The child arm's `prepareResult(calls.get(id), …)` falls back to the
   *current* registry result hook when the record is gone, so consuming the
   record in the settle path risked firing a hook twice. Resolved by making the
   settle consumer **top-level only** (§4.4) — which also removes the need to
   touch the child arm at all.
3. (major) §6.3's "settled then synthesized" scenario is unreachable: `runTool`
   catches everything, so `Promise.all` never rejects and phase 3 always emits.
   Rewritten, along with test 7.
4. (minor) The top-level settle must also delete the plain `activityTools` row,
   not just the task state; §4.4 now requires the two events to share one arm.
5. (minor) Refusal plans keep the wrong duration and their row until phase 3 —
   now stated (§4.5 item 5, §6.8).
6. (minor) Two duration semantics for the same tool in one run — now recorded
   as accepted (§6.9).
7. (minor) The skipped renderer flush is safe only by an unstated invariant —
   now stated (§4.4, §6.7).
8. (minor) Line-citation corrections: `runTool` `:524-554`, `plan.run` `:520`,
   `display` `:86-90`, the tap `:662-689`, the health block `:667-670`, the
   child arm `:1190-1193`, the top-level arm `:1231-1242`, `health.observe`
   `:186-192`, `shell.ts:622`.
9. (minor) Two clocks are in play (loop clock for chunk durations, sink clock
   for the fallback) — now called out in §7.1.
10. (nit) `durationMs`'s doc wording: present on `tool_settled` *and*
    `tool_end`, not only `tool_end` (§4.2).
11. (nit) §5's print row described a REPL tap that print mode does not have —
    rewritten.

The reviewer also listed the remaining undecided points it wanted resolved;
those decisions are now §4.5 item 5 (refusal plans), §6.10 (`onEvent`
throwing), §6.7 (flush invariant) and §7.1 (two clocks).
