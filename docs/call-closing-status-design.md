# Call closing status: design for independent review

Status: **draft — independent adversarial design review pending**. Baseline:
`f7a0a3a` (`main`). This document changes no runtime behavior. Work happens
on branch `feat/call-closing-status`; merge to main only via `--no-ff`.

Owner request (2026-10-02): the completion marker `✓`/`✗` + elapsed time
must render at the **end of the tool call's info** rather than pinned to its
first row (including the `task` tool); and the running timer must render in
**the same closing slot**, so that a call going from running to done turns
the appended timer rendering into the completion rendering in place.

## 1. Observed causes (rendered frames from the baseline build)

Frames below were rendered from the current build with `width = 44` to
exhibit wrapping; the same shapes occur at any width once the call info
exceeds one row.

P1 — completion marker pinned to the first visible row. The suffix closes
the call block's first row (`#tui-tool-elapsed` D2/I3); wrapped continuation
chunks and multi-line command bodies carry no marker, so the marker splits
content mid-word or mid-command:

```
● bash  rg -n pattern src/ --glob '*. ✓ 2.3s
    ts' --hidden --no-ignore -g '!node_modul
    es' | head -100
```

```
● task  scout · explore the reposito ✓ 12.3s
    ry tree and report the main modules and
    their responsibilities in detail
```

P2 — the running timer and the completion marker are in different places.
The `└─ running Ns` row (`#tool-inline-live-rows` §5.1) renders as its own
live row and disappears when the call settles, while the marker appears on
the first row: a position jump. For multi-line bash commands the live row
also splits the command — it splices at `headerEnd`, i.e. after
`emit(body[0])` but before `body.slice(1)` (`tool-block.ts:~569`, `:~609`):

```
● bash  cd /tmp
└─ running 3s
    ls -la
    echo done
```

Owner target, one closing slot at the end of the call info:

```
● bash  sleep 15  └─ running 12s     →     ● bash  sleep 15  ✓ 15.0s
```

## 2. Goals and non-goals

Goals:

- G1: one closing slot per call block; while the call runs the shell
  supplies the timer text, after the call settles the marker + gated time
  replaces it **in place** (same row, same position).
- G2: for multi-row info the slot closes the **last** row (fixes P1).
- G3: the non-task live row is removed (supersedes `#tool-inline-live-rows`
  for non-task tools); the multi-line split disappears with it.

Non-goals (unchanged): the task running block shape (`pending #N …` +
prompt + progress) unless the owner decides otherwise (O1); result blocks
(`#tui-tool-elapsed` I5 — only input blocks carry the slot); print/legacy
renderers (byte-for-byte); streaming output as it arrives; the activity
region; gate/approval behavior (D10 semantics are preserved, see D3).

This is an owner-directed revision of part of the just-shipped
`#tool-inline-live-rows` behavior; the rule docs are amended in §4.7.

## 3. Current mechanism inventory (verified anchors)

- Completion suffix: `tool-block.ts` call branch (~494-556): `durPlain`/
  `dur` built from `block.elapsedMs`/`block.failed`; `reserve` is taken from
  the FIRST row's budget before layout (I3); header-only rows measure
  `header + durW <= w` (I4). The sink sets `elapsedMs`/`failed` in its
  end-time update (`#tui-tool-elapsed` D4, `createToolSink`).
- Running rows: `shell.ts renderActivity` (~700-753) builds
  `nextLiveRows`; non-task `runningRow` (~677-680) returns
  `└─ running` / `└─ running Ns` (floored, capped `9999+`); pushed through
  `transcript.setCallLiveRows` (`shell.ts:302-303`, `:747-753`) →
  `ToolBlockFold.setLiveRows` → spliced at `headerEnd` when rendering
  (`tool-block.ts:~573`, `:~767`). D10: no rows while a picker is open
  (`shell.ts:~700-708`); idle clears all keys (`:~667-668`).
- Task rows: `shell.ts:~735-753` (`pending #N …` block), routed to the
  task's own fold; unchanged by this design except the completion slot
  (D7).
- Collapsed cap: `limit = 3` (`tool-block.ts:399`); omission notices follow
  the info rows.
- Replay never runs `renderActivity`, so no running text exists on replay;
  the completion suffix is replay-suppressed today (D4) and stays so.

## 4. Design

### D1 — One closing slot, render-layer precedence

The call block's info carries at most one closing status, at the end of its
target row (D2). Content precedence, decided at render time from block
state:

1. `block.elapsedMs !== undefined` → completion suffix (today's exact form:
   ` ✓` / ` ✗`, plus ` X.Ys` when `elapsedMs >= 1000`; mixed-style string);
2. else the running text, when set;
3. else nothing.

Interrupted/finalized input blocks (`error`, title `interrupted (no
result)`) render no slot. The precedence makes the running→done swap
**order-independent**: no frame can show both even if the sink's end-time
update and the shell's clear land in either order.

### D2 — Target row

"Call info" = the call block's header + summary/body rows, including
wrapped chunks (`emit` continuations) and multi-line command continuation
rows (`body.slice(1)`). Metadata rows and omission notices are not info.

- Single-row info: unchanged from today for the completion form.
- Multi-row info: the slot closes the last row of the info as laid out
  with the slot's width reserved from that row's budget.
- Collapsed cap: when the info is cut at the 3-row budget, the slot closes
  the last **visible** info row (before any omission notice).
- Header-only rows: the slot closes the header row under an I4-analog fit
  rule.
- Expanded/raw: the inline body is not rendered in these modes; the slot
  closes the header row (today's expanded behavior for the completion).

Implementation note: the collapsed inline info is bounded (bash command
excerpt ≤160 chars, task summary ≤~120; ≤3 rows), so computing the row plan
(and thereby which row is last) before laying out the slot's width is
bounded. The expanded path renders no wrapped info. The exact mechanism
must not regress the omission-parity/`summaryVisible` accounting
(reviewer question O7).

### D3 — Running text

Form: ` └─ running Ns` — the existing `#tool-inline-live-rows` syntax with
one leading space and DIM, appended exactly where the completion suffix
will land. Second-level semantics unchanged: `└─ running` at 0s,
`└─ running Ns` for N ≥ 1 (floored, `9999+` cap). The text is supplied per
tick by `renderActivity` through a new suffix payload channel (e.g.
`transcript.setCallSuffix(id, text|null)` → `ToolBlockFold.setRunningSuffix`)
instead of the live-row channel for non-task tools. D10 stands: while a
picker is open no running text is set (a `running` claim during a gate is
as wrong inline as it was as a row). Task calls set no running suffix
(O1). Narrow-terminal omission is D5.

### D4 — Swap

On settle, the sink's end-time update sets `elapsedMs`/`failed` (unchanged
mechanism); the shell drops the tool from the activity snapshot and clears
the running text. D1's precedence renders the completion suffix in the same
slot. Sub-second calls: `└─ running` → bare ` ✓`. Failed calls: ` ✗ [X.Ys]`.

### D5 — Width reserve and jitter

The slot's width is reserved from the target row's wrap budget before
layout (I3 mechanics retargeted). The running text's width varies with
digits (` └─ running 3s` = 15 columns … ` └─ running 9999+s` = 19).
Options:

(a) exact reserve per render (default): the info re-wraps when the text
width changes — at digit-count changes (9s→10s, 99s→100s) and at the
running→done swap (widths 15 vs 7/2). Accepted; the target row is
re-rendered each tick anyway.
(b) fixed reserve (max active width) for a stable wrap at the cost of
up to ~4 wasted columns and more omission cases.

Omission: the slot never wraps to its own row; below the existing I3 floor
(`budget - s >= 8`) it is omitted entirely, for both running and completion
forms. Whether the floors need to differ per form is O3.

### D6 — Coverage and edges

All input blocks (built-ins, extensions, header-only calls). Orphan
`end`-without-`start`: no running text ever existed; completion renders
normally. Replay: no running text; completion suppressed as today.
Interruption: no slot (D1). Duplicate events: unchanged lifecycle rules.

### D7 — Task and doc amendments

Task completion closes the last summary row (owner: "including task").
Task running block: default unchanged (O1). Amended deliverables:

- `docs/tui-tool-elapsed-design.md`: D2 placement ("first row") → closing
  slot; I3/I4 retargeted; non-goal 1 parenthetical re-pointed.
- `docs/tool-inline-live-rows-design.md`: §4.1/§5.1 — non-task live rows
  superseded by the closing slot; §5.2 task routing stands.
- `docs/task-live-display-design.md` §2 parenthetical: point at this doc.
- `README.md` / `CHANGELOG.md` / `PROJECT_PLAN.md` ledger at merge.

## 5. Test plan (red-first, sketch)

Unit (`tool-block`):

- single-row completion renders byte-identical to today;
- multi-row completion closes the LAST row (long single-line command;
  multi-line command; long task summary);
- cap-truncated info: slot closes the last visible row, before `… more`;
- expanded/raw: slot on the header row;
- header-only: I4-analog boundaries for both forms;
- running text renders in the slot; precedence pin (`elapsedMs` present +
  running text set → marker only); interrupted → no slot;
- omission floor pins for both forms; I1 sweep (`visibleWidth(row) <= w`
  for every row) across all new paths;
- existing native-text/legacy pins unchanged.

Shell/transcript: suffix channel set/clear on tick, settle, idle, and
picker open (D10); no double display in either event order.

Integration (`repl-tui`): running→done swap in place at a pinned clock
(same row before/after); multi-line command renders all lines then the
slot (no mid-command row); task completion closes the last summary row.

Regression: full suite; the re-derived pins from `#tui-tool-elapsed` and
`#tool-inline-live-rows` (which currently pin the first-row/no-slot shapes)
are listed and updated as part of the implementation batch.

## 6. Files touched (forecast)

`src/repl/components/tool-block.ts` (slot target, running text, precedence);
`src/repl/shell.ts` (suffix channel, clear paths, D10); `src/repl/transcript.ts`
(fold API); `src/repl/tool-presentation.ts` (only if the fold/sink seam
needs it); the test files above; the three doc amendments; CHANGELOG.

## 7. Open questions

Owner:

- O1: task running state — keep the approved 3-row block and unify only
  the completion slot (default), or also move task's timer into the
  closing slot?
- O2: running text form — keep `└─ running Ns` verbatim inline (default)
  or adjust the connector for an inline position?

Reviewer:

- O3: reserve option (a) vs (b) and the omission floor(s).
- O4: slot target vs metadata/omission edge rows — any case where "last
  info row" is ambiguous or wrong.
- O5: hidden consumers/assumptions of the non-task live-row channel
  (tests, repl wiring, differential render anchors) that this breaks.
- O6: event-order, replay, orphan, interrupt, and resize edge cases.
- O7: implementability of "reserve on the last row" without regressing the
  streaming emit, the 3-row cap, and the omission-parity/`summaryVisible`
  accounting.
