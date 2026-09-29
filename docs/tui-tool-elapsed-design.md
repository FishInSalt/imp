# TUI tool-call duration (design)

- Date: 2026-09-29
- Branch: `feat/tui-tool-elapsed` (this document's review; implementation follows
  on the same branch)
- Baseline: `f1fcc54` (main)
- Status: DRAFT — awaiting independent adversarial design review (round 1).
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
7. **No per-row ✓/✗ markers reintroduced** (the series moved to `⎿`-row
   status; failure stays `⎿ failed`).
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

Dim suffix appended at the end of the call block's **first row**:
`● bash  echo first · 2.3s`.

- Suffix text: `· ` + formatted duration (single leading space, i.e.
  `· 2.3s`). The `·` matches the established dim-metadata separator idiom
  (`· interrupted (no result)`, host notices, agent activity rows) and can
  not be confused with command/argument text the way a bare `2.3s` could
  (`echo first 2.3s` is plausible command content; `· 2.3s` is not).
  Considered alternatives: legacy-literal ` ✓ 2.3s` (reintroduces a marker
  the block style dropped, asymmetric with `⎿ failed`), parenthesized
  `(2.3s)` (fine, but `·` is the codebase idiom).
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
  - I1: the suffix never causes a row to exceed the terminal width.
  - I2: the suffix never wraps to its own row and never truncates other
    content beyond the width-reservation rule below.
  - I3: the first row's other content (path preview / header / first
    command chunk) gets its width budget **after** the suffix width is
    reserved; when the remaining budget would fall below 8 visible
    columns, the suffix is omitted entirely (path keeps today's full
    budget) rather than mangling the row.
  - I4: collapse/expand/raw state never removes an eligible suffix; it
    stays on the first row in every mode.
  - I5: only input blocks (`call` rendering) can carry it; output/diff
    blocks ignore the field.
- Interaction: when the first row already carries a semantic summary
  (`…  summary`), the suffix follows it (last on the row).

### D3 — Measurement

Wall time from the renderer's `start` call to its `end` call, measured
inside `createToolSink` with an injectable clock:

- `createToolSink(append, update?, clock?)`; `clock` defaults to `Date.now`.
- `TranscriptSink` gains an optional `{ clock }` constructor option,
  threaded through (production `cli.ts` passes nothing — default; tests
  inject a controllable clock, precedent `Renderer.clock`,
  `src/render.ts:69-70`).
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
- Interrupted rows: finalize already marks the entry terminal, so a later
  `end` cannot add a duration; an `end` that arrives before finalize adds
  nothing new (no result path shows durations).
- Duplicate `end`/`start` behavior is unchanged (IDs are lifecycle events).

## Files touched (implementation forecast)

- `src/format.ts` — `formatToolElapsed` (pure; unit-tested).
- `src/repl/tool-presentation.ts` — `ToolBlock.elapsedMs`; sink timing,
  gate, and end-time update call.
- `src/repl/components/tool-block.ts` — suffix rendering per D2 invariants.
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
- typical single-row: `● bash  echo first · 2.3s`;
- with semantic summary present: suffix last;
- multi-line command: suffix on the first row, continuation rows unchanged;
- header-only call (no path/body): `● name · 2.3s`;
- narrow terminal: suffix omitted (I3), no oversize row, path not below
  floor; exact boundary of the reservation;
- expanded and raw modes: suffix still on the first row (I4);
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
- append-only consumer (no update callback) → no crash, blocks unchanged;
- duplicate end → no second update.

Integration — TUI harness (`test/repl-tui.test.ts` `startTuiRepl` gains an
optional clock, passed to `TranscriptSink`):
- slow tool (fake clock advanced inside execute) → frame contains the call
  row with `· 2.3s`-style suffix;
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

1. D2 suffix form and format: is `· 2.3s` / minute-hybrid right, or should
   the batch stay closer to legacy parity (`✓ 2.3s`, `X.Ys` always)?
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

## Process

- Independent adversarial design review (fresh context) is required before
  implementation (AGENTS.md). Implementation lands on
  `feat/tui-tool-elapsed`; merge to main is `--no-ff`.
- This document changes no runtime behavior.
