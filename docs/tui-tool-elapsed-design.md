# TUI tool-call duration (design)

- Date: 2026-09-29
- Branch: `feat/tui-tool-elapsed` (this document's review; implementation follows
  on the same branch)
- Baseline: `f1fcc54` (main)
- Status: IMPLEMENTED + REVIEWED — design review CONFIRMED (round 4,
  2026-09-29); implementation review APPROVE WITH CORRECTIONS (P3 folds
  applied). Manual terminal acceptance pending. Implementation commits:
  dc4f068 (code + tests), 0e41b95 (CHANGELOG), 252a345 (review folds).
- **Amendment 1 (owner decision, 2026-09-29): the suffix form becomes the
  legacy-literal ` ✓ 2.3s` (green check + dim time) instead of the original
  ` · 2.3s`.** Glyph width is identical (`✓` = 1 column, suffix = 7
  columns), so every I1-I6 budget, floor, and boundary stands numerically
  unchanged. Branch: `fix/tui-tool-elapsed-check-glyph`; targeted design
  review round recorded in the review log.
- Backlog source: `PROJECT_PLAN.md` 【Backlog｜TUI 工具调用耗时显示】(recorded
  2026-09-29, owner request).

## Problem

The TUI transcript's completed tool rows carry no timing information: a call
renders as `● bash  echo first` (input block) with the result below (`⎿ …` /
fold). The only live timing is the transient activity region (`⠏ running 12s`
+ label; `src/repl/shell.ts:648-651`). After `#loop-health` Amendment 1
removed the `tool-open` signal, "stuck vs slow" visibility was deliberately
left to pure UI display (`docs/loop-health-design.md` §7) — the completed-row
duration is the piece this backlog item restores.

## History (verified, not from memory)

- **Pre-`#tool-display` TUI**: the renderer's byte stream fed the transcript
  sink (no `toolSink`; `ffd643d^:src/cli.ts:482` runs the renderer with
  `liveTools:false` + `toolStyle:"one-line"`). The completion line was
  `● bash $ ls ✓ 2.3s` — `src/render.ts:637-640`: green `✓` plus a dim
  duration, shown only when the call took ≥ 1s, one decimal (`seconds >= 1 ?
  \` ${dim(seconds.toFixed(1)+"s")}\` : ""`). `startedAt` is recorded
  unconditionally (`src/render.ts:556-558`), so the duration reached the
  transcript even with `liveTools:false`. Error lines show `✗` and no
  duration (`src/render.ts:635`).
- **`#tool-display` series (2026-09-25)**: `ffd643d` moved TUI tool rendering
  to typed `ToolBlock` components via `createToolSink`
  (`src/repl/tool-presentation.ts`, delegated from `src/render.ts:532-536`
  and `:599-604`); the new input/output blocks have no duration concept, so
  `✓`+duration silently stopped appearing in the TUI. The series' four
  design docs (`docs/tool-display-*.md`, `docs/builtin-*.md`) contain no
  mention of removing it — the drop was incidental to the mechanism swap,
  not a reasoned decision. (The `● ✗` references in `fold.ts:32`,
  `repl.ts:710`, `repl.ts:713` are stale renderer-era comments; the TUI
  failure surface today is the red `⎿ failed` row + red fold.)
- **Current split**: legacy shell keeps `✓ 2.3s` (`src/render.ts`); print
  mode never had it (two-line style); TUI lost it.

## Goal

A completed top-level tool call in the TUI transcript shows how long the call
took, in the current block visual language, for calls ≥ 1s.

## Non-goals (explicit)

1. **No live/ticking elapsed in transcript rows** — the activity region owns
   in-flight state and is unchanged. Transcript rows stay settle-only.
2. **Legacy shell and print mode byte-for-byte unchanged** — no edits to
   `src/render.ts` rendering paths; the legacy completion format stays as is.
3. **No duration on errors, interruptions, or aborts** — parity with the
   pre-series line (errors carried `✗`, never a duration). A timed-out
   command's own error text already states its timeout.
4. **No replay/resume backfill** — stored sessions have no timing data;
   replayed blocks must render exactly as they do today.
5. **No session/model/extension impact** — `ToolBlock` is presentation-only
   (never persisted, never sent to the model); no schema, context, or print
   output change.
6. **No configuration knob** — no env var or setting; display-only, always
   on in TUI.
7. **No per-row ✗ marker** — failure status stays the `⎿ failed` row.
   The completion **✓ is restored as the duration suffix** (Amendment 1,
   owner decision); the ✗ prohibition stands.
8. **No child-tool rows** — child tool calls never reach the transcript
   (activity only); the `task` tool row is a normal top-level tool and does
   get a duration.

## Decisions

### D1 — Surface

TUI transcript, input (call) block of top-level tools. This is the row the
user remembers (`● bash $ ls ✓ 2.3s` → today's `● bash  echo first`), it is
stable (the output block varies by result kind), and it is where the legacy
split always put it. Alternative placements considered and rejected:
duration on the `⎿` result row (the result row is not always present as a
simple row; muddles result-summary semantics), separate dedicated row (costs
a row of the call block's 3-row collapsed budget; noisier).

### D2 — Form

Suffix appended at the end of the call block's **first row** (Amendment 1,
owner decision 2026-09-29 — the legacy-literal form):
`● bash  echo first ✓ 2.3s`.

- Suffix text: ` ✓ ` + formatted duration — one leading space, **green
  `✓`**, one space, **dim duration** (`src/render.ts`'s pre-series
  completion line rendered exactly `green("✓")` + ` ` + `dim(X.Ys)`; the
  owner elected to restore that marker form). Glyph width is identical to
  the original `·` choice (`✓` = 1 column, suffix = 7 columns), so every
  I1-I6 budget, floor, and boundary is numerically unchanged. Original
  choice and alternatives considered: `· ` + dim (matches the dim-metadata
  separator idiom, but reads as metadata rather than a completion marker —
  overridden by the owner), bare ` 2.3s` (reads as command text),
  parenthesized `(2.3s)`.
- Implementation plumbing (amendment review round 1): the suffix is a
  **mixed-style string** — green `✓` + `" "` + dim duration — so the
  render sites must **not** wrap it in an additional `DIM` (unlike the
  original all-dim ` · ` form); `durW`/`reserve` continue to measure the
  plain `" ✓ X.Ys"` text (7 columns; `visibleWidth` strips ANSI), and
  `emit`'s `firstSuffix` parameter receives the pre-styled text.
  `tool-block.ts` gains a local green escape (`src/format.ts`'s `green()`
  is not currently imported there).
- Format (new pure helper, proposed `src/format.ts` `formatToolElapsed(ms)`):
  - `ms < 60_000`: tenths **floored** — `Math.floor(ms/100)/10` with one
    decimal (`2.3s`, `1.0s`; 59.999s → `59.9s`, never `60.0s`).
  - `ms >= 60_000`: `XmYYs` with `YY` two-digit padded (`1m03s`, `10m00s`),
    the minute idiom already used by `src/render.ts:83-87` `formatElapsed`.
  - Sub-minute keeps the remembered `2.3s` shape; minute form avoids
    `847.3s` on long `task`/build rows. (Pure legacy parity — always
    `X.Ys` — is the noted alternative; rejected as unreadable for
    multi-minute subagent runs.)
- Gate: shown only when the measured wall time ≥ 1000ms (parity with the
  pre-series line; sub-second calls stay clean).
- Placement invariants (pinned by tests; implementation must satisfy these,
  not a specific code path):
  - I1: no row emitted by `ToolBlockFold.render` may exceed the
    terminal width — pi-tui **throws** on oversize lines
    (`@earendil-works/pi-tui` render check), so unit pins assert
    `visibleWidth(row) <= w` for every row of that component's output
    (scoped to `ToolBlockFold`; `ToolActivity`'s own clamps are out of
    scope).
  - I2: the suffix never wraps to its own row; it is omitted instead.
  - I3: the suffix width is reserved **from the first row's existing
    budget before that row's content is laid out** — never appended on
    top of an already-spent budget (the collapsed path-preview row
    currently fills exactly `w - visibleWidth(prefix)`, so a post-hoc
    append would overflow and trip the I1 throw). Concretely:
    `budget = w - visibleWidth(prefix)`; with a suffix of width `s`, if
    `budget - s >= 8`, the first row's content (path preview `ellipsize`,
    wrapped first chunk, and the expanded/raw pathFirst first row) is
    laid out within `budget - s`, and the suffix closes the row;
    otherwise the suffix is omitted and the full budget stands. Boundary
    pins: `budget - s == 8` shows, `== 7` omits. The inline command body
    path threads the reduction into `emit` for its **first row only**
    (`w - visibleWidth(current) - s`); continuation rows keep
    `w - visibleWidth(current)`; the reduction applies to the first
    row's wrap width **and** to `emit`'s first-row
    `consumed`/`summaryVisible` scan — otherwise the occurrence silently
    drops out of `summaryVisible` and the omission/`… more` accounting
    desyncs. Continuation rows' indentation and grapheme `consumed`
    accounting stay unchanged.
  - I4: collapse/expand/raw state never removes an eligible suffix —
    **I3 width omission is its only non-gating absence**. In the
    header-only fallback branches (`visibleWidth(prefix) >= w`), the row
    is `header` alone with no suffix — `header + suffix` cannot fit
    there (`prefix = header + "  "` and `s >= 6 > 2` by construction) —
    and the two-space separator is never rendered in these branches.
  - I5: only input blocks (`call` rendering) can carry it; output/diff
    blocks ignore the field.
  - I6: `finalize()`'s interruption update is constructed with
    `elapsedMs: undefined` explicitly (defense in depth over D4's
    ordering argument: `end` sets the terminal flag before any update,
    and finalize only touches non-terminal entries, so a post-`end`
    entry never reaches it). Pinned by a unit where the appended input
    block is mutated to carry `elapsedMs`, then finalize runs: the
    update callback receives a block with `elapsedMs === undefined` and
    the interrupted row renders no suffix.
- Interaction: when the first row already carries a semantic summary
  (`…  summary`), the suffix follows it (last on the row) and the
  summary's fit check includes the suffix width.

### D3 — Measurement

Wall time from the renderer's `start` call to its `end` call, measured
inside `createToolSink` with an injectable clock:

- `createToolSink(append, update?, clock?)`; `clock` defaults to `Date.now`.
- `TranscriptSink` gains an optional `{ clock }` constructor option,
  threaded through to `createToolSink` (precedent `Renderer.clock`,
  `src/render.ts:69-70`). The option exists for test injection only:
  production constructs `new TranscriptSink()` at `src/cli.ts:519` with
  the default — no production call site changes.
- Semantics are honest wall time of the call as observed by the renderer —
  it includes approval-gate waits and other stalls. No attribution claims;
  the display is a fact, not a diagnosis.

### D4 — Mechanism (input-block update at end)

- New optional field on `ToolBlock`: `elapsedMs?: number` (host-owned,
  presentation-only, never in `sections`/`metadata`/raw payload).
- Sink lifecycle: `start()` records `startedAt` in the entry; at
  `end(result, replay)` — **after** the terminal flag is set, **before**
  the output block is appended — the sink calls `update(entry.input,
  { ...entry.input, elapsedMs })` when ALL of:
  - `replay !== true` (no resume backfill);
  - `result.isError !== true`;
  - the entry saw a `start` and an emitted input block (orphan `end`
    without `start` shows no duration);
  - elapsed ≥ 1000ms.
- Reuse of the existing update callback (`createToolSink` signature
  already exposes it; current sole use is the finalize interruption
  update, `src/repl/tool-presentation.ts:649-668`). The
  `TranscriptSink` update callback already re-keys the fold lookup and
  repaints (`src/repl/transcript.ts:64-72`), and `ToolBlockFold.updateBlock`
  invalidates its render cache (`src/repl/components/tool-block.ts:89-92`),
  so no new transcript-side plumbing is required beyond what finalize
  already uses. Append-only consumers (no `update` callback) silently show
  no duration — same documented limitation as interruption styling.
- Replay suppression rides the `replay` flag the Renderer hands to
  `end(result, replay)` (`src/repl/replay.ts:50` sets `replayTools:
  true` on the replay Renderer). It is a Renderer-option property, not a
  sink lifecycle property: the sink cannot independently distinguish
  replayed from live events beyond that flag, so a future caller that
  spawns a Renderer with `replayTools: true` alongside live tool events
  would suppress legitimate durations — noted as a coupling, not solved
  here.
- Interrupted rows: finalize already marks the entry terminal, so a later
  `end` cannot add a duration; an `end` that arrives before finalize adds
  nothing new (no result path shows durations). I6 additionally clears
  the field structurally in finalize's update.
- Duplicate `end`/`start` behavior is unchanged (IDs are lifecycle events).

## Files touched (implementation forecast)

- `src/format.ts` — `formatToolElapsed` (pure; unit-tested).
- `src/repl/tool-presentation.ts` — `ToolBlock.elapsedMs`; sink timing,
  gate, and end-time update call.
- `src/repl/components/tool-block.ts` — suffix rendering per D2
  invariants (Amendment 1: mixed-style green-✓ + dim-time string; local
  green escape).
- `src/repl/transcript.ts` — optional clock option passthrough only.
- `src/cli.ts` — no change expected (defaults).
- Docs: this file; `CHANGELOG.md` Unreleased entry; `PROJECT_PLAN.md`
  ledger + backlog close at merge; README only if a display section
  exists (none found).

## Test plan (red-first)

Every behavioral pin is written before the implementation and demonstrated
red on the baseline, then green. Structural red (missing field / option /
helper) is acceptable red evidence per repo precedent.

Unit — `formatToolElapsed` table:
`1000→1.0s`, `2350→2.3s`, `59_949→59.9s`, `59_999→59.9s`, `60_000→1m00s`,
`61_200→1m01s`, `3_600_000→60m00s`.

Unit — `ToolBlockFold` render (`elapsedMs` set/unset):
- typical single-row: `● bash  echo first ✓ 2.3s`;
- with semantic summary present: suffix last;
- multi-line command: suffix on the first row, continuation rows unchanged;
- header-only call (no path/body): `● name ✓ 2.3s`;
- narrow terminal: suffix omitted (I3) with the boundary pins
  (`budget - s == 8` shows / `== 7` omits); the assertion is
  `rows.every((r) => visibleWidth(r) <= w)` — the pi-tui throw contract,
  stronger than "no visible overflow";
- expanded and raw modes: suffix still on the first row (I4);
- multi-row inline command body with a suffix: first row carries the
  suffix within width; continuation rows' indentation and consumption
  accounting unchanged;
- omission-notice parity: a collapsed pathFirst row carrying a suffix
  emits the same omission/`… more` marker as the identical block without
  the suffix, and the same holds for a multi-row inline command body
  (first-row wrap width and the `consumed`/`summaryVisible` scan both
  reduced by `s`);
- output/diff blocks with the field set: no suffix (I5);
- `updateBlock` re-render reflects a newly set/removed `elapsedMs`.

Unit — `createToolSink` with injected clock:
- end ≥1s after start → exactly one update with `elapsedMs`, before the
  output append, input block identity preserved through the WeakMap rekey
  contract;
- <1s → no update; error result → no update;
- `end(result, true)` (replay) → no update even if slow;
- orphan end without start → no update;
- finalize-then-end and end-then-finalize → no duration either way;
- mutated-input finalize pin (I6): an appended input block that carries
  `elapsedMs` (mutated by the test) yields a finalize update whose
  block has `elapsedMs === undefined`, and the interrupted row renders
  no suffix;
- append-only consumer (no update callback) → no crash, blocks unchanged;
- duplicate end → no second update.

Integration — TUI harness: `startTuiRepl`
(`test/repl-tui.test.ts:1341`) gains an optional `clock` passed to
`new TranscriptSink({ clock })` (`:1365`), and a scratch tool whose
`execute` advances that clock synchronously (e.g. `now += 2300`) before
returning — no real waits:
- clock-advanced tool → the frame contains the call row with the
  `✓ 2.3s` suffix;
- fast tool → no suffix (existing frames unchanged);
- error tool → no suffix;
- resume/replay frames → no suffix.

Regression:
- full existing suite green; legacy/print byte pins untouched by
  construction (no renderer edits); the pre-existing
  `repl-tui` activity assertions unaffected (activity untouched).

## Verification

Unmasked gate commands (lint exit code read directly — pipeline masking is
a recorded incident): `npm run lint; echo $?`; typecheck (both tsconfigs);
full test suite (expected: 126 files / 2412 tests baseline + new pins);
`npm run build`. Manual terminal acceptance of the TUI rendering is
owner-facing and will be listed as pending until the owner confirms.

## Open questions for the reviewer

1. ~~D2 suffix form~~ Resolved (owner, Amendment 1): the legacy-literal
   ` ✓ 2.3s` glyph form (green check + dim time); the format stays the
   minute-hybrid (`X.Ys` below 60s).
2. D2 invariants: any render path (pathFirst expanded, wrapped first row,
   CJK widths, `… omitted` replacement rows) that can violate I1/I2/I3?
3. D4 update-callback reuse: any consumer or reentrancy hazard in calling
   `update` at `end` time in addition to finalize (order, WeakMap rekey,
   duplicate events, `clear()` mid-run)?
4. D3 clock seam: is the sink the right measurement point (vs. the
   component or the repl layer), and is the `TranscriptSink` option the
   right injection surface for tests?
5. Test plan gaps: which edge above is most likely to hide a real defect
   if left unpinned?

## Review log

- Round 1 (independent adversarial, fresh context, 2026-09-29):
  **NEEDS-FIXES** — P0: D2's reserve rule overshoots when the collapsed
  first-row budget is already spent (`ellipsize(pathText, w - prefix)`
  fills exactly `w`; a post-hoc append exceeds width and pi-tui throws),
  and I2/I3 were self-contradictory for that case; P1: I4 violated on
  the header-only fallback rows, and the integration clock-injection
  sketch was not realizable in `startTuiRepl`; P2: replay suppression is
  a Renderer-option property (unstated coupling), and finalize's block
  spread could carry a stale field; P3: width pins should assert the
  throw contract, omission-notice parity unpinned. All folded in
  revision 2 (I3 rewritten budget-first, I4 exception narrowed, I6
  added, integration sketch corrected, pins added). Reviewer verified
  correct: history claims (pre-series TUI displayed `✓ 2.3s`; drop
  incidental), D4 lifecycle mechanics (duplicate/orphan/finalize/
  clear), `ToolBlock` non-persistence, separator idiom.

- Round 2 (same reviewer, targeted, 2026-09-29): **NEEDS-FIXES** —
  findings 1/3/4/6/7 FIXED; finding 2 PARTIALLY FIXED (header-only
  fallback wording left the header-fits/prefix-doesn't sliver open —
  now closed with an explicit `visibleWidth(header) + s` rule); finding
  5 NOT FIXED (I6 was an unpinned restatement — rewritten as defense
  in depth with a mutated-input unit pin); new N1 (I3 boundary wording
  vs `emit`'s first-row reserve mechanics — restated with the
  continuation-row constraint and a pin), N2 (I1 pin scoped to
  `ToolBlockFold.render`). All folded in revision 3.

- Round 3 (same reviewer, targeted, 2026-09-29): **CONFIRMED WITH
  NOTES** — finding 2, finding 5, N1, N2 all FIXED (verified against
  `tool-block.ts:300-339`/`:381-396` and `tool-presentation.ts:640-695`;
  the I6 pin shown red-able on the baseline). N-A (P3): I4's
  "emit `header + suffix`" clause is arithmetically dead in those
  branches — reworded unconditionally. N-B (P2): the first-row `-s`
  reduction must also reach `emit`'s `consumed`/`summaryVisible` scan —
  folded into I3, and the omission-parity pin extended to the multi-row
  inline-body case. Both folded in revision 4 (implementation may
  proceed; N-B folded before implementation so the parity pin is not
  self-defeating).

- Round 4 (same reviewer, closure check, 2026-09-29): **CONFIRMED** —
  N-A/N-B FIXED; zero new findings; design review closed.

- Implementation review (same reviewer, on the committed diff,
  2026-09-29): **APPROVE WITH CORRECTIONS** — no live defect; falsification
  sweeps over I1-I6 (widths 1-80, CJK/emoji paths, all modes) and every D4
  lifecycle path found none. P3 folds: addHeader's dead `\n` guard removed
  (latent I4 hole, unreachable in production), positive header-only width
  pins added (w=13 shows / w=12 omits), reserve-vs-addHeader width bases
  documented. Red evidence: 19/25 unit pins red pre-implementation;
  integration slow-pin red against baseline src (20 failed / 8 passed /
  145 skipped). Gates (unmasked): lint 0, typecheck 0, 127 files / 2440
  tests 0, build 0.

- Amendment 1 (owner-directed glyph change, 2026-09-29): the suffix form
  ` · 2.3s` → ` ✓ 2.3s` (green check + dim time), overriding D2's
  separator-idiom choice in favor of the legacy-literal form. Width
  identity verified before drafting (`visibleWidth("✓") = visibleWidth("·")
  = 1`, suffix 7 columns both) — I1-I6 budgets/boundaries stand unchanged.
  Round 1: **NEEDS-FIXES** — Non-goal 7 still banned per-row ✓ markers
  (fixed: ✗ prohibition kept, ✓ restored explicitly), mixed-style
  (green-✓ + dim-time) plumbing unspecified against the single-DIM render
  sites (fixed: D2 plumbing note + local green escape), stale `· 2.3s` in
  CHANGELOG/ledger to update with the implementation, placeholder/ordering
  bookkeeping (fixed on close). All folded in revision 2; round 2:
  **CONFIRMED** (clean scan, zero new findings).

- Amendment 1 implementation check (same reviewer, on the committed
  diff, 2026-09-29): **APPROVE WITH CORRECTIONS** — 2×P3 folded: the
  space after ✓ moved outside the DIM span (byte order now identical to
  the legacy `render.ts` completion line), and the three absence pins
  assert the `● bash` line is present before checking it.

## Process

- Independent adversarial design review (fresh context) is required before
  implementation (AGENTS.md). Implementation lands on
  `feat/tui-tool-elapsed`; merge to main is `--no-ff`.
- This document changes no runtime behavior.
