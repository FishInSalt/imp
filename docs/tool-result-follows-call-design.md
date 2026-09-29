# Tool result follows its own call

Batch: `fix/result-fold-follows-its-call`. Base: `main@06dbfcb`.

## 1. Problem

When one assistant message contains several concurrent `task` calls, the TUI
transcript renders all `● task …` headers first and all `⎿ …` result blocks
afterwards, detached from their calls:

```
● task  generic subagent · <prompt A> ✓ 6.1s
    … more · Ctrl+O
● task  generic subagent · <prompt B> ✓ 6.1s
    … more · Ctrl+O
  ⎿ <result A>
  ⎿ <result B>
```

Reported by the owner while reviewing `#task-inline-live-rows`. The live rows
now sit under their own header (§4.3), which makes the detached result blocks
more conspicuous: the header/result pairing has to be reconstructed by counting
positions, and with five calls it is not obvious which `⎿` belongs to which
`●`.

## 2. Mechanism

Two independent facts combine.

1. **`task` is the only concurrency-safe tool** (`src/core/tools/task.ts:348`;
   `concurrencySafe` is read at `src/core/loop.ts:382`). `executeChunk`
   (`src/core/loop.ts:420-466`) runs in three phases: phase 1 emits
   `tool_start` for **every** call in the chunk, in call order; phase 3 emits
   `tool_end` for **every** call, in call order, after all have settled. The
   ordering is deliberate (`loop.ts:369-372`: byte-stable output regardless of
   completion timing) and is not part of this change.
2. **A tool call is two transcript entries.** `createToolSink.start` appends an
   input block (`src/repl/tool-presentation.ts:663-669`); `createToolSink.end`
   appends a *separate* output block (`:702-705`). `TranscriptSink`'s append
   callback (`src/repl/transcript.ts:85-111`) wraps each block in its own
   `ToolBlockFold` and `appendChild`s it, i.e. appends at the end of `entries`.

For a single call, and for every serial call, start and end arrive adjacently,
so "append at the end" is indistinguishable from "attach to the call". Only a
concurrent chunk separates them: entries become
`a:input, b:input, …, a:output, b:output, …`.

## 3. Goal and non-goals

**Goal.** In the TUI transcript, a result block renders immediately after the
input fold of the same tool call, for every tool, without changing any other
ordering. After the change the example in §1 renders as:

```
● task  generic subagent · <prompt A> ✓ 6.1s
    … more · Ctrl+O
  ⎿ <result A>
● task  generic subagent · <prompt B> ✓ 6.1s
    … more · Ctrl+O
  ⎿ <result B>
```

**Non-goals.**

1. The agent loop's event order, and therefore print mode and the legacy
   shell, are untouched (`src/render.ts`, `src/format.ts`). The `⎿` line in
   print mode is written by the renderer, not by this transcript.
2. No chunk buffering, no new event type, no change to `MAX_CONCURRENT_TASKS`
   or to which tools are concurrency-safe.
3. Print/legacy byte-for-byte output is unchanged: both paths never construct a
   `TranscriptSink`.
4. Task result *content* (the `taskRecord`-driven rendering) stays out of scope,
   as in `#task-inline-live-rows`.

## 4. Design

### 4.1 Attach, do not reorder

`TranscriptSink` already knows the input fold for a tool_call id — the
`#task-inline-live-rows` batch added `inputFoldById: Map<string, ToolBlockFold>`
(`src/repl/transcript.ts:85`) for exactly this kind of addressing. Extend that
bookkeeping with the *entry* of that fold, and change the append callback:

- block kind `input`: append the fold as today, and record its entry in a new
  `inputEntryById: Map<string, Entry>`. `appendChild` returns `void` today
  (`transcript.ts:126-130`), so it gains a private sibling that still calls
  `settleBoundary()` first and returns the pushed entry; the public
  `appendChild` keeps its signature for its `shell.ts:792` caller.
- any other kind (`output`, `diff`): if `inputEntryById` has the block's id,
  insert the new fold's entry **immediately after** the anchor entry instead of
  appending at the end; otherwise append (unknown/orphan result — unchanged).

The insertion runs `settleBoundary()` first (the same boundary the append path
establishes, `transcript.ts:126-130`), then
`entries.splice(entries.indexOf(anchor) + 1, 0, entry)`. `indexOf` compares by
reference, so it is exact even after `settleBoundary` completed or removed a
pending line. **An `indexOf` result of `-1` falls back to append** — an anchor
can only go stale through `clear()`, and the fallback keeps a stale map entry
from splicing at position 0 (`/new`, then an orphan output for a reused
`call_${index}` id).

`inputEntryById` **must** be cleared in `clear()` alongside `inputFolds` and
`inputFoldById` (`transcript.ts:109-118`). This is a correctness requirement,
not hygiene: see the `-1` case above.

`ToolBlockFold.block.id` is the tool_call id for both kinds:
`preparedInputBlock` sets `id` from the record (`tool-presentation.ts:327`) and
`outputBlock` sets `id: result.toolCallId` (`:584`). The keys match.

### 4.2 Why "attach" and not "merge the result into the input fold"

Merging would give `ToolBlockFold` two blocks (header + result) and would
redefine `updateBlock`, which today replaces the single block (`:104-108`) and
drives the `#tui-tool-elapsed` marker and the interruption styling. Attaching
keeps both blocks, both `update` paths, and both `render` paths exactly as they
are; only the *position* of the appended entry changes. It is also the same
shape as `#task-inline-live-rows`: address the call, do not introduce a new
component.

### 4.3 Interaction with the live rows (`#task-inline-live-rows`)

The live rows are rendered *inside* the input fold, between the header and the
body. The result fold is inserted after the input fold, so the vertical order
is header → live rows (while running) → body → result. `setTaskLiveRows(key,
null)` at tool_end clears the rows and the result appears in the slot below the
header. No change to `setLiveRows`, the resolver, or the ownership guard.

### 4.4 Edge cases

| Case | Behaviour |
|---|---|
| Serial tool (all non-task tools, and `task` called alone) | The input fold is the last entry when the result arrives, so splice == append. Byte-identical transcript. |
| Chunk larger than `MAX_CONCURRENT_TASKS` (5) | Chunks run sequentially (`loop.ts:402-412`); each chunk's results attach within the chunk. Final order is `a ra b rb … f rf …`, monotonic. |
| Orphan result (no start; e.g. `end` for an unknown id) | `createToolSink.end` appends an "Arguments unavailable" input block first (`tool-presentation.ts:691-700`), which is then the anchor — result lands after it, i.e. at the end. Unchanged. |
| Reused tool_call id across messages (`call_${index}`) | `inputEntryById` is re-pointed to the newest fold, mirroring `inputFoldById` (§5.2 of `task-inline-live-rows-design.md`); the settled fold keeps the result already attached to it. |
| Gate-blocked call in a chunk | Phase 3 still emits `tool_end` in call order; identical handling. |
| Interleaved non-tool entries (thinking, status lines) | Phase 1→3 emits no lines, and the model does not stream while tools run, so nothing is appended between a chunk's starts and ends. A thinking section *can* already sit after the call's input fold (the previous model call streamed it), but the result is emitted before the next model call exists, so the insert is invisible (§6.2). |
| Interrupt (`finalize`) | Emits `update` only (`tool-presentation.ts:711-731`), never an append. Unchanged. |

### 4.5 Not affected

`addFold` (`src/repl/shell.ts:789-794`, the only other `appendChild` caller)
appends extension folds and is never the tool-result path in TUI mode
(`showResultFold` early-returns when `renderer.hasToolSink`, `repl.ts:712-714`).
The `Ctrl+O` toggle (`shell.ts:458`) walks `toolFolds` order-independently, and
`components/tool-block.ts` renders one block with no positional dependency.

### 4.6 Contract changed

`test/repl-tui.test.ts:1837` ("semantic tools: reverse execution completion
retains call order live and on replay") pins the *fold array* order
`["a","b","a","b"]` via `env.transcript.toolFolds`. That array is push-ordered
by block arrival and is **not** changed by this design. The test's intent — call
order is retained, not completion order — still holds. This batch extends that
test (or adds a sibling) with a **rendered-order** assertion, which is what was
never pinned: the ids must read `a, a, b, b` in `render()` output.

`test/tool-presentation.test.ts:326-347` also drives a concurrent start/end
sequence (`a,b` started; `b,a`, then an orphan, ended) through a real
`TranscriptSink`. It asserts the `toolFolds` array and indices plus a weak
render presence check — none of which this change moves. It is the second
place that exercises the path, and the natural home for the rendered-position
assertion if the new test goes there instead.

## 5. Compatibility

- Print mode and the legacy shell: untouched (§3.3).
- Replay: `replaySession` feeds the same `TranscriptSink` tool sink in stored
  order (assistant `tool_calls`, then tool results), so replay reproduces the
  same grouping as the live run — which is the requirement ("replay shows what
  you saw").
- Extensions: `api` surface unchanged; `tool_call`/`tool_end` events unchanged.

## 6. Risks

1. **Cost.** `indexOf` is O(n) per result, O(n²) per session in the worst case.
   Entries are object references and n is in the hundreds; measured cost is
   negligible. Mitigation if ever needed: store the index hint alongside the
   entry.
2. **Transcript semantics.** `entries` stops being purely append-ordered. Four
   methods read it: `render` (`transcript.ts:222-235`, order-sensitive by
   design), `settleBoundary` (`indexOf` on the pending line, never a component
   entry), `feedStatus` (`:154`, inspects only `entries.at(-1)`), and
   `completedLines` (`:242-243`, `flatMap` over completed line entries). The
   splice moves one *component* entry earlier and never touches line entries or
   the tail — but it *can* land ahead of a non-line entry when the call's input
   fold is not the last entry (a thinking section from the next model call, in
   principle). That reordering is invisible today (the result is emitted before
   any later section exists), and it never touches line entries, so
   `feedStatus`'s adjacency rule and `completedLines`' order are unaffected.
3. **A result that arrives before its input fold.** Impossible for a real call
   (`start` precedes `end`); the orphan path above covers the rest.

## 7. Test plan

1. Unit (`test/repl-tui.test.ts` or `test/tool-presentation.test.ts`): two
   concurrent calls; assert **rendered position**, not array order — the index
   of the `id: a` header row, the `a result` row, the `id: b` header row and the
   `b result` row in `render(80)` must satisfy `aHeader < aResult < bHeader <
   bResult`. A `toolFolds.map` assertion cannot observe this change (that array
   is push-ordered and unchanged, §4.6). Red before the change.
2. The existing reverse-completion test: add the rendered-order assertion; keep
   its `toolFolds` array assertion.
3. Replay: replay a session with two results, assert the same rendered order.
4. Serial regression: a single tool call renders header then result, unchanged
   (byte-compare the rendered rows against the pre-change output).
5. `#task-inline-live-rows` interaction: a running task shows header + live row;
   on `end` the live row disappears and the result fold is the next entry.
6. Orphan result: `end` without `start` still renders (at the end).
7. Full suite + lint + typecheck + build.

## 8. Review log

**Round 1 — independent adversarial review (fresh context), verdict
PASS-WITH-CHANGES.** Verified against source: only `task` is concurrency-safe
(`task.ts:348`); the three-phase `executeChunk`; the separate output append;
the splice simulation (concurrent, reverse completion, streamed text before the
chunk, empty pending line, orphan) all produce the claimed order; the
`test/repl-tui.test.ts:1837` pin is on the `toolFolds` array and survives; print
mode and the legacy shell never build a `TranscriptSink` (`cli.ts:519`).
Findings folded in:

1. (major) `inputEntryById` must be cleared in `clear()`, and `indexOf === -1`
   must fall back to append — otherwise an orphan output for a reused id after
   `/new` splices at position 0. Now §4.1.
2. (minor) §6.2 wrongly claimed only `settleBoundary` and `render` walk
   `entries`; `feedStatus` and `completedLines` do too. Rewritten to name them
   and argue their safety.
3. (minor) `appendChild` returns `void`, so "record the entry" needs a small
   refactor. Now stated in §4.1.
4. (minor) line citations corrected: `executeChunk` `:420-466`, append callback
   `:79-98`, orphan input block `:691-700`.
5. (minor) `test/tool-presentation.test.ts:326-347` also exercises the path;
   now noted in §4.6.
6. (nit) `addFold`/`showResultFold` do not interact with the change; now §4.5.
7. (nit) the test mechanism (rendered positions, not array order) is now
   specified in §7.1.

**Round 2 — confirmation (same reviewer, resumed), verdict CONFIRMED.** All
seven folds re-verified against source; the corrected citations re-checked
line-for-line; the splice simulation re-run (both completion orders plus the
`/new` orphan). Two nits, both non-blocking: the private sibling must still
call `settleBoundary()` (now stated in §4.1), and the `-1` fallback and the
mandatory `clear()` overlap as defense in depth (kept deliberately; §4.1's
parenthetical reconciles them).

## 9. Implementation notes

- `src/repl/transcript.ts`: `inputEntryById`, `appendEntry` (returns the pushed
  entry), `insertEntryAfter` (returns false when the anchor is gone),
  `clear()` clears the new map.
- Tests: `test/repl-fold.test.ts` gains a `TranscriptSink tool result
  placement` block (6 cases: interleaved starts/ends, reverse end order, serial
  unchanged, orphan, cleared transcript, live-row-over-result); the
  reverse-completion test in `test/repl-tui.test.ts:1837` gains rendered-order
  assertions for both the live run and the replay. Three of the new cases are
  red before the change (verified by reverting `transcript.ts`).
- Gate: 127 files / 2468 tests, lint 0, typecheck (both configs) 0, build 0.
- Independent adversarial code review (fresh context): CLEAN, 0 blocking/major.
  It reproduced the red baseline three ways (dev tree revert, a pristine
  `main` worktree, and the orphan scenario) and confirmed the serial path is a
  provable splice-at-length no-op. Four carry-forwards folded in: §6.2's
  "never touches line entries or the tail" reworded (a result can land ahead of
  a later non-line entry), §4.4's "truncated replay" label corrected (replay
  feeds calls before results, so it cannot produce an orphan), the sink's two
  appends now both go through `appendEntry`, and the duplicated reused-id
  comment removed. The fifth (no test guards
  `test/tool-presentation.test.ts:326-347`) is left as-is: that path is already
  covered by the new `test/repl-fold.test.ts` block and stayed green.
