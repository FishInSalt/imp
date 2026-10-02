# Call closing status: design for independent review

Status: **rev 2 — round-1 findings folded; round-2 targeted verification
pending**. Baseline: `f7a0a3a` (`main`). This document changes no runtime
behavior. Work happens on branch `feat/call-closing-status`; merge to main
only via `--no-ff`.

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
also splits the command — it splices at `headerEnd` (`tool-block.ts:~573`),
i.e. after `emit(body[0])` but before `body.slice(inline ? 1 : 0)`
(`tool-block.ts:~609`):

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
  replaces it **in place**. "In place" means the same slot on the same
  row identity; the tail may re-wrap when the text width changes (D5) —
  that is accepted, not a violation.
- G2: for multi-row **inline** info the slot closes the last non-empty row
  (fixes P1); fallback layouts keep today's behavior (D2, exception E1).
- G3: the non-task live row is removed (supersedes `#tool-inline-live-rows`
  for non-task tools); the multi-line split disappears with it.

Non-goals (unchanged): the task running block shape (`pending #N …` +
prompt + progress) — default per O1; result blocks (`#tui-tool-elapsed` I5);
print/legacy renderers (byte-for-byte); streaming output; the activity
region; gate/approval behavior (D10 semantics preserved, D3).

This is an owner-directed revision of part of the just-shipped
`#tool-inline-live-rows` behavior; the rule docs are amended in D7.

## 3. Current mechanism inventory (verified anchors, round-1 corrected)

- Completion suffix: `tool-block.ts` call branch (~494-556): `durPlain`/
  `dur` from `block.elapsedMs`/`block.failed`; `reserve` taken from the
  FIRST row's budget before layout (I3); header-only rows measure
  `header + durW <= w` (I4). The sink sets `elapsedMs`/`failed` in its
  end-time update (`#tui-tool-elapsed` D4, `createToolSink`).
- Inline body: collapsed branch calls `emit(body[0], …, dur)` (~:528-534);
  the tail loop `for (const line of … body.slice(inline ? 1 : 0))` (:609)
  emits continuation rows with no slot support and after metadata.
- Narrow fallback: `visibleWidth(prefix) >= w` → `addHeader()` (:521-527)
  while the body still renders at :609 — today the header carries the
  suffix even though info rows continue below. The pathFirst narrow and
  expanded variants behave analogously (`addHeader()` + `add(pathText,
  indent)`).
- Raw-only does NOT disable the inline branch: it gates on `this.expanded`
  only (:556); raw-only collapsed renders inline and is pinned
  (`test/tui-tool-elapsed.test.ts:190`).
- Trailing empty row: a `literalLF` bash excerpt keeps a trailing LF
  (`presentation.ts:212`); `emit` lays it out as a blank indented
  continuation row (`tool-block.ts:~431-460` do/while runs once for `""`).
- Running rows: `shell.ts renderActivity` (:662-755); `runningRow`
  (:677-680); pushes via `setCallLiveRows` (:746-752); resolver wiring
  (:302-303); idle clear (:667-668); D10 picker guard (:705); task block
  built at :728-735, routed through `activityParents` (`repl.ts:1306-1324`),
  never `activityTools`.
- Transcript-side lifecycle a suffix channel must preserve: resolver pull
  for folds created after publication (`transcript.ts:106-110`), displaced-
  fold clear on id reuse (:103-107), terminal-duplicate clear
  (`onTerminalDuplicate`, :180-188), `stopTerminal` resolver ownership
  guard (`shell.ts:1219-1220`).
- Event ordering: `trackActivity` (snapshot drop/clear) precedes
  `renderer.event`/`sink.end` in the same synchronous chain
  (`repl.ts:747-764`).
- Orphan `end` without `start`: the end-time update is skipped
  (`tool-presentation.ts:694-702`), pinned
  (`test/tui-tool-elapsed.test.ts:281-290`).
- Collapsed cap `limit = 3` (:399); omission/`additional` decisions
  (:687-690, :750-751). Replay never runs `renderActivity`.

## 4. Design

### D1 — One slot, render precedence (order fixed)

The call block carries at most one closing status, decided at render time:

0. input block interrupted/finalized (`error`, title `interrupted (no
   result)`) → nothing (guard is part of the precedence, so a still-set
   running text cannot leak onto an interrupted block);
1. `block.elapsedMs !== undefined` → completion suffix (today's exact form:
   ` ✓` / ` ✗`, plus ` X.Ys` when `elapsedMs >= 1000`; mixed-style string);
2. else the running text, when set;
3. else nothing.

The precedence makes the running→done swap independent of event order; on
top of that, today's dispatch is same-chain (`repl.ts:747-764` — activity
snapshot drop/clear precedes `sink.end`), so no frame shows both.

### D2 — Target row

"Call info" = the rows the **inline layout path** produces for the call's
header + summary/body — wrapped chunks (from `emit`) and `body.slice(1)`
continuation rows. Metadata rows and omission notices are not info.

- Multi-row inline body: the slot closes the LAST non-empty info row
  (mechanism in D8). Empty post-wrap rows (trailing-LF artifacts) are
  skipped for targeting and may still render below the slot.
- Single-row info and the collapsed pathFirst row: unchanged from today.
- Collapsed cap: when the info is cut at the 3-row budget, the slot closes
  the last visible info row, before any omission notice.
- Expanded mode: no inline body; the slot closes the header row (today's
  behavior, unchanged).
- Raw-only: NOT an exception — the inline branch depends on `expanded`
  only, so raw-only collapsed follows the multi-row rule above; raw-only
  expanded follows the expanded rule.
- E1 (documented exception): layouts that render info through `add()`
  fallbacks — expanded path continuations, the narrow fallback
  (`visibleWidth(prefix) >= w` with body/path rows below the header) —
  keep today's first-row placement (I4 rules) unchanged. Converting
  `add()` rows to slot-aware layout would need cap/accounting machinery
  `add()` does not have; scoped out of this batch and pinned as-is.

### D3 — Running text and channel

Form: ` └─ running Ns` — the existing `#tool-inline-live-rows` syntax with
one leading space and DIM, appended exactly where the completion suffix
will land. Second-level semantics unchanged: `└─ running` at 0s,
`└─ running Ns` for N ≥ 1 (floored, `9999+` cap). The text is supplied per
tick by `renderActivity` through a suffix channel (e.g.
`transcript.setCallSuffix(id, text|null)` → `ToolBlockFold.setRunningSuffix`)
instead of the live-row channel for non-task tools. The channel must carry
the same lifecycle machinery as live rows, with matching tests: resolver
pull for late-created folds, displaced-fold clear on id reuse,
terminal-duplicate clear, `stopTerminal` ownership guard, D10 suppression
(no running text while a picker is open), idle clear. Task calls set no
running suffix (O1 default).

### D4 — Swap

On settle, the sink's end-time update sets `elapsedMs`/`failed` (unchanged
mechanism); the shell drops the tool from the activity snapshot and clears
the running text. D1's precedence renders the completion suffix in the same
slot. Sub-second calls: `└─ running` → bare ` ✓`. Failed calls: ` ✗ [X.Ys]`.

### D5 — Width reserve, jitter, floors (round-1 corrected)

- Widths (verified): `└─ running` 11 columns; ` └─ running Ns` 14-18;
  completion ` ✓` 2, ` ✓ X.Ys` 7, minute form 8, hour form 9. The largest
  jump within the running text is 0s→1s (11→14).
- Default option (a): exact per-render reserve. The tail re-wraps when the
  text width changes — at digit-count changes (9s→10s, 99s→100s) and at
  the swap (running width vs completion width). Accepted; the target row
  is re-rendered each tick anyway.
- Option (b) (fixed max reserve) is rejected as stated: keeping the max
  reserve through settle wastes up to ~11 columns after the swap, and
  dropping it at settle re-wraps — which is what (b) was meant to prevent.
- One shared floor for both forms: `budget - s >= 8` (s = current text
  width). Consequence to pin: with the wide running text the slot
  disappears below ~26 columns of last-row budget while the completion
  marker may still fit.
- Accepted and pinned: omission/`count` flips at digit changes and at the
  swap (the cap interaction can move the omission notice by one row).
- The slot never wraps to its own row; it is omitted instead.

### D6 — Coverage and edges (round-1 corrected)

- Orphans (`end` without `start`): no slot at all — the end-time update is
  skipped exactly as today; "completion renders normally" was wrong.
- Replay: no running text (activity is not replayed); completion suppressed
  as today.
- Interruption: D1 rule 0.
- Resize: the slot participates in the fold's cache revision key (as
  `setLiveRows` does).
- Duplicate ids/events: unchanged lifecycle rules plus the D3 channel
  counterparts.

### D7 — Task and doc amendments

Task completion closes the last summary row (owner: "including task").
Task running block: unchanged (O1 default). Amended deliverables:

- `docs/tui-tool-elapsed-design.md`: D2 placement ("first row") → closing
  slot for the inline layout; I3 retargeted; I4 and the fallback shapes
  restated as E1; non-goal 1 parenthetical re-pointed.
- `docs/tool-inline-live-rows-design.md`: §4.1/§5.1 — non-task live rows
  superseded by the closing slot; §5.2 task routing stands.
- `docs/task-live-display-design.md` §2 parenthetical: point at this doc.
- `README.md` / `CHANGELOG.md` / `PROJECT_PLAN.md` ledger at merge.

### D8 — Inline-path mechanism (O7, round-1 corrected)

"Reserve on the last row" cannot be computed by a simple pre-pass: reserving
width on the last chunk can split it, and the split interacts with the
3-row cap. Mechanism to implement and pin:

1. Stream info rows as today, but hold the FINAL candidate row in a one-row
   buffer (text, style, prefix, spans) instead of flushing it immediately.
2. When info emission completes (tail loop included) and the cap outcome is
   known, lay out the buffered text with `budget - suffixW`; if it splits,
   its chunks participate in the count/cap accounting as normal rows, and
   the slot attaches to the last emitted chunk.
3. If the cap cut falls before that final chunk, the slot closes the last
   visible chunk instead (consistent with D2).
4. `summaryVisible`/`consumed` accounting mirrors the reduced budget on the
   slot-bearing chunk (the N-B parity rule, extended from first to last).
5. Bounded: the inline info is bounded by the excerpt caps (bash 160 chars
   literal-LF, task ~120) and the collapsed 3-row cap; expanded modes have
   no inline body.

## 5. Test plan (red-first, sketch)

New pins:

- single-row completion byte-identical to today; multi-row completion
  closes the last non-empty row (long single-line command; multi-line
  command; long task summary); trailing-LF command skips the blank row;
- cap-truncated info: slot on the last visible row, before `… more`;
- raw-only collapsed multi-row follows the inline rule;
- E1 pins: expanded path continuation, narrow fallback — first-row
  placement unchanged;
- running text in the slot; precedence pin (`elapsedMs` present + running
  text set → marker only; `error` + running text → nothing);
- omission floor pins for both forms incl. the ~26-column running
  disappearance; notice/`count` flip pins at digit changes;
- D8 pins: buffered final row split, `summaryVisible` parity multi-line +
  `commandExcerpt`;
- channel lifecycle counterparts (resolver pull, displaced fold,
  terminal-duplicate, `stopTerminal` guard, D10, idle clear);
- I1 sweep (`visibleWidth(row) <= w`) across all new paths.

Re-derived pins (round-1 inventory; re-verify anchors at implementation):
`test/tui-tool-elapsed.test.ts:103` (first-row multi-row), `:115` (floor),
`:184`, `:190` (raw-only inline), `:214` (omission parity), `:281-290`
(orphan/replay/duplicate no-update); `test/repl-tui.test.ts:4942`, `:4971`
(running row under header), `:4981`, `:5006`, `:5025`, `:5039`
(`└─ running` trim pins), `:2856`, `:2894`, `:2925`, `:5105-5130`
(resolver guard); `test/repl-fold.test.ts:617`;
`test/task-live-display.test.ts:182` (task rows unchanged), `:267-281`
(duplicate clear).

Integration (`repl-tui`): running→done swap in place at a pinned clock
(same row before/after); multi-line command renders all lines then the slot
(no mid-command row); task completion closes the last summary row.
Regression: full suite.

## 6. Files touched (forecast)

`src/repl/components/tool-block.ts` (slot target, buffered final row,
running text, precedence); `src/repl/shell.ts` (suffix channel, clear
paths, D10, `stopTerminal` counterpart); `src/repl/transcript.ts` (fold API
+ lifecycle counterparts); `src/repl/tool-presentation.ts` (only if the
fold/sink seam needs it); the test files above; the three doc amendments;
CHANGELOG.

## 7. Open questions

Owner (defaults adopted in this draft; veto any time):

- O1: task running block — default: keep, unify only the completion slot.
- O2: running text form — default: keep `└─ running Ns` verbatim inline.

Reviewer (round 2):

- attack the D2 exceptions (E1 fallback shapes, trailing-empty skip,
  raw-only scoping);
- attack D5 (option a, shared floor, accepted flips);
- attack D8 (buffered-final-row mechanics, parity accounting, cap
  interaction);
- check the D3 channel counterpart list and the §5 pins inventory for
  completeness.

## Review log

- Round 1 (independent adversarial, fresh context, 2026-10-02; reviewed the
  uncommitted draft): **NEEDS-FIXES** — P1: trailing-LF blank row breaks
  "last row"; P1: the claimed "header-only" narrow case actually renders
  the body below the header; P1: expanded/raw conflated (raw-only keeps the
  inline branch); P1: the reserve-on-last-row note is circular and the
  bounded justification wrong. P2: orphan claim false; interrupted guard
  missing from the D1 order; the suffix-channel sketch omits the
  transcript-side lifecycle machinery; the pins list is a placeholder;
  option (b) tradeoff inconsistent and (a) vs G1 unstated. P3: width
  arithmetic off (14-18, not 15-19; minute/hour forms), several anchors
  imprecise. All folded in rev 2 (E1 exception, raw-only fix, D8 mechanism,
  corrected claims, concrete pins inventory).
