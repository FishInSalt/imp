# Per-call settle: accurate concurrent timing and real-time completion display

Batch: `feat/tool-settle`. Base: `main@154aa99`.

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
  (`src/repl/repl.ts:1226-1239`: `closedParents.add` at `:1230`, row delete at
  `:1232`), and the `✓` marker and `⎿` result block come from
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

Why here and not in `runTool` (`:519-555`), which is the one place
`tool.execute` is awaited: measuring in `runTool` would *also* cover the serial
path and would silently change serial timings from "gate + execute" to
"execute". Keeping the measurement inside the chunk makes "the serial path is
byte-identical" a structural property rather than a promise. For a chunk,
`plan.run(signal)` *is* `runTool(...)` (`:513`), so nothing is lost.

The clock is injected through `RunAgentLoopOptions.clock` (default `Date.now`,
matching `TranscriptSink`'s default clock) and threaded into `executeToolBatch`
/ `executeChunk` only. Deterministic tests need it; the repo precedent is
`Renderer.clock` and `TranscriptSink({clock})`.

A plan that never ran (schema refusal, blocked by a gate) has no `durationMs`
and emits no settle signal — it is instantaneous, and its `tool_end` still
closes it in phase 3.

### 4.2 The duration travels as a render-only field

`ToolResult.durationMs?: number` (`src/core/messages.ts:81-95`), documented with
the same lifecycle as `display` (`:87-90`): present on the event, stripped
before the result enters history. `persistableResult` (`:473-477`) currently
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
own call's anchor).

### 4.4 Consumers

**The REPL tap** (`src/repl/repl.ts:659-687`) handles it like `health`
(`:661-665`) — before `renderer.event`, so the Renderer never sees it:

```ts
if (event.type === "tool_settled") {
	this.trackActivity(event, info);
	if (info === undefined) this.toolSink?.end(event.result);
	return;
}
```

`this.toolSink` is the same object the Renderer holds (`:391` receives
`options.toolSink`, which `cli.ts` built from the `TranscriptSink`; `:1555`
hands `tuiSink.toolSink` to `renderer.setToolSink`), so this is the same call
the Renderer would make for `tool_end`, minus the print/legacy branch.

`trackActivity` gains one case: for a top-level `tool_settled` it performs the
parent-close half of the `tool_end` arm (`closedParents.add` + delete the
`pending #N.n` row, `:1226-1239`); for a child-sourced one it does the child
half (`calls.delete`, `:1186-1189`). The later authoritative `tool_end` then
repeats those mutations harmlessly:

- `Map.delete` on a missing key is a no-op; `Set.add` is idempotent.
- `prepareResult(calls.get(id), ...)` already tolerates a missing record (the
  same call is made today for orphan results).

**The sink** closes the entry on the first `end` it sees: `createToolSink.end`
returns immediately when `entry.terminal` is set (`tool-presentation.ts:672`),
so the authoritative `tool_end` cannot render the marker or the result block a
second time. The result fold's own placement is already idempotent through the
`#tool-result-follows-call` anchor.

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

## 5. Compatibility

| Surface | Why it is unchanged |
|---|---|
| Print stdout | `cli.ts:1052` wires `onEvent: (event) => renderer.event(event)`; `Renderer.event`'s `default:` case is a no-op (`src/render.ts:173-176`). Additionally the settle event is not forwarded to it from the REPL tap. |
| Legacy shell | Only `TuiShell` implements `setActivity` (`src/repl/shell.ts:605`); `pushActivity` returns early without it (`repl.ts:1258`). `showResultFold` (`:711-714`) still runs only on `tool_end`, and the settle event is not routed to it. |
| Session file / history | `durationMs` is stripped by `persistableResult` (§4.2); the loop's `results` array is still filled in phase 3, in call order. |
| Extension hooks | Both dispatch sites gate on `event.type === "tool_end"` (`src/runner.ts:1447-1460` top-level, `:606-620` child), so `tool_settled` never reaches `emitToolEnd`. |
| `#loop-health` | `observe` handles only `message_end` and `tool_end` (`src/core/health.ts:183-197`); everything else falls through. |
| Replay | `replaySession` feeds stored blocks; `end(result, replay = true)` skips the marker, and stored results carry no `durationMs` (stripped). |
| `#task-inline-live-rows` / `#tool-result-follows-call` | Both are arrival-order independent; this batch relies on that rather than changing it. |

## 6. Risks

1. **Print determinism.** The single biggest claim to prove. Mitigated
   structurally (§5) and by a byte-comparison test over a concurrent batch.
2. **Double rendering.** The sink's `terminal` guard and `trackActivity`'s
   idempotent mutations. Covered by asserting one marker and one result fold
   per call after a full run.
3. **Abort and `fillMissingToolResults`** (`src/core/loop.ts:269`): a call can
   settle (display signal sent) and then have its result synthesized during
   abort. The synthesized result closes an already-terminal entry → no-op.
   Tested.
4. **Nested concurrency** (a subagent that itself fans out `task` calls): the
   child's settle event arrives with `info`, so `trackActivity`'s child arm
   handles it; the authoritative child `tool_end` then finds no call record.
   Tested.
5. **Clock source.** `Date.now()` can jump (system clock changes, suspend). The
   activity rows and the sink already use `Date.now()`; keeping one convention
   is preferred to introducing a second clock. Recorded as a known limitation
   rather than fixed here.
6. **The activity row now disappears before the `⎿` block is guaranteed to be
   in the transcript** — they are driven by two different calls in the tap
   (`trackActivity` then `toolSink.end`). They are synchronous and adjacent, so
   no frame can observe the gap, but the order in the tap is deliberate.

## 7. Test plan

1. **Per-call duration (red first).** Injected clock; two concurrent
   concurrency-safe calls with different runtimes → each `durationMs` is its
   own value and each rendered header shows its own `✓ Xs` (today both show the
   batch time).
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
7. **Orphan/abort.** Abort mid-chunk: the settled call shows once, the
   synthesized result does not re-render.
8. **Extension and health counts.** `tool_end` handlers fire once per call in
   call order; `health.observe` sees no new signal.
9. **Replay.** No duration markers.
10. **Nested concurrency.** A subagent fanning out two `task` calls updates both
    child rows at their own settle times.

## 8. Review log

(to be filled in)
