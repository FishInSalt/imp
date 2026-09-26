# Task Timer — `run_start` event + extension status line — Design

Branch `feat/task-timer`. Feature batch, not a plan milestone. Motivating consumer
(ship in the same batch): `examples/extensions/task-timer.mjs`, a port of pi's
`task-timer` extension — a live per-run timer in the TUI footer.

User story: while a run is in flight the footer shows `running M:SS`, ticking once
a second; when the run settles the line becomes `done in M:SS` and stays until the
next run starts. Print and legacy-shell modes are unaffected.

Reference implementation studied: `~/.pi/agent/extensions/task-timer.ts` running on
pi's extension API. pi mechanisms cited below with paths under
`pi/packages/coding-agent/`.

---

## 1. Why the core must change (named-consumer argument)

The pi extension needs four capabilities: a run-start event (`before_agent_start`),
a run-settled event (`agent_settled`), a footer status channel
(`ctx.ui.setStatus(key, text)`), and a mode query (`ctx.mode`/`ctx.hasUI`). imp has
only the middle one's rough analog (`run_end`) and nothing else.

Two M4 normative constraints gate this work; this document is the discharge of both:

- **"The four-event set is normative; additions require a named consumer (M5+)"**
  (`docs/m4-extensions-design.md` §17 risk 7, echoed at `src/extensions/types.ts:135`).
  The named consumer is the task-timer extension above — a real user request, ported
  from a real pi extension in daily use.
- **UI contribution was deferred** (`m4-extensions-design.md` §16) with the rationale
  "imp has no TUI; `Renderer` is a line printer." That premise is stale: the TUI
  landed in M9 with a footer, an activity region, and a capability-gated `LineInput`
  seam. The deferral's own escape hatch — "adding `ctx.ui` after the TUI decision,
  without pre-committing to a widget set" — is what this batch exercises, reduced to
  the single widget the consumer needs (one status line).

## 2. Goals / non-goals

Goals:

1. A `run_start` extension event, fired exactly once per top-level run.
2. An extension status channel: `api.setStatus(key, text | undefined)`, rendered as
   one host-styled line in the TUI footer area; safe no-op in print mode and under
   the legacy shell.
3. `examples/extensions/task-timer.mjs` implementing the pi behavior on top of 1+2.
4. Tests for all three, plus the existing suite staying green.

Non-goals (each returns in §6 Alternatives):

- A per-call handler `ctx` object (pi's pattern). M4 §6.2 still stands.
- Subagent run timing (`run_start`/`run_end` with `subagent: true`).
- Session-lifecycle events (`session_start`/`session_shutdown`).
- Changing `run_end`'s crash semantics.
- Extension-controlled colors, multi-line statuses, or a theme API.
- RPC/JSON modes — imp has none (`RunMode = "print" | "repl"`, `src/runner.ts:75`).

## 3. Current state (verified facts)

### 3.1 Run lifecycle and events

- All extension-facing emissions live in `src/runner.ts`; `src/core/loop.ts` emits
  none — it exposes typed hooks the runner wraps.
- `run_end` fires at `runner.ts:1106-1112`, after `runAgentLoop` returns, with
  `stopReason: "completed" | "max_iterations" | "aborted"`. The site comment is
  explicit: a provider throw **skips** the emit ("run_end means a run that ended —
  including an aborted one — not one that crashed"). Ctrl+C is a normal `"aborted"`
  return, so it does fire.
- `RunnerImpl.runTurn` (`runner.ts:944`) is the single method both shells call per
  run: print mode at `src/cli.ts:885`, REPL at `src/repl/repl.ts:608`. It delegates
  to `runTurnOrRecoverFromOverflow` (`:964`) → `runTurnInner` (`:1021`), so anything
  emitted at `runTurn` entry fires exactly once even when the overflow retry
  re-enters `runTurnInner`.
- Follow-up/steering messages extend the same run inside the loop — one
  `run_start`/`run_end` pair covers them, matching pi's "round" semantics.
- Subagent runs never go through `runTurn` (the task tool calls `runSubagent` →
  `runAgentLoop` directly) and today emit only `tool_call`/`tool_end` to extensions —
  no `message_end`, no `run_end`. The symmetric choice for `run_start` is therefore
  top-level-only.
- Observer events (`tool_end`, `message_end`, `run_end`) are fire-and-forget:
  invoked synchronously in load order, never awaited, errors isolated per handler
  and reported as one diagnostic line (`registry.ts:340-353`, `fireObservers`).
- Event registration surface: `on()` overloads at `types.ts:61-64`,
  `ExtensionEventName` at `types.ts:136`, `ExtensionEventHandlerMap` at
  `types.ts:140-144`, `KNOWN_EVENTS` at `registry.ts:30`, one `emit*` method per
  event at `registry.ts:326-336`.
- The `ExtensionApi` object is assembled once per extension in
  `extensionApi()` (`loader.ts:186-224`) and passed to the factory
  (`loader.ts:257-269`). Registration methods are guarded by `whileLoading`;
  `confirm` is a runtime method with no window guard — the precedent `setStatus`
  follows.

### 3.2 Footer and UI plumbing

- The TUI footer is one dim `Text` below the editor, created at
  `src/repl/shell.ts:307-309`. Its whole content is computed by the private
  `ReplMachine.refreshFooter()` (`src/repl/repl.ts:802-895`) from runner state
  (model · think level · session id · usage · cost · context fill) and pushed via
  `this.input.setFooter(parts.join(" · "))` (`repl.ts:894`).
- `setFooter` is an optional `LineInput` method (`src/repl/line-input.ts:89-91`);
  the legacy readline shell does not implement it, and callers capability-gate on
  `this.input.setFooter !== undefined`. `TuiShell.setFooter`
  (`shell.ts:486-495`) buffers the text (pre-start pushes must not be dropped —
  the `footerText` field, `shell.ts:225-228`), applies host-side `dim(...)`, and
  calls `tui.requestRender()`.
- Empty `Text` renders zero rows (`shell.ts:489` comment) — an absent status costs
  no layout.
- pi-tui's renderer **throws on component lines wider than the terminal**
  (`src/tui.ts` export-block comment). `truncateToWidth` and `visibleWidth` are
  re-exported through the same boundary.
- `sanitizeDisplay(text)` (`src/repl/tool-presentation.ts:14`) is the repo's
  existing control-sequence stripper (CSI/OSC/C1 consumed, controls escaped) —
  the policy task-live-display-design.md §81 states: "activity strings are
  untrusted terminal input."
- Extension *slash commands* already receive the full `CommandContext` including
  `refreshFooter` — but `refreshFooter()` regenerates from runner state only, so
  extensions can trigger a repaint yet cannot contribute content. No extension
  UI surface exists for event handlers or background callbacks.
- How pi does it (reference): statuses live in a `Map<string, string>` keyed by an
  extension-chosen key (`core/footer-data-provider.ts:103,146-152`); the footer
  renders all entries sorted by key, space-joined, sanitized, truncated to width,
  as **one extra line** below the stats line
  (`modes/interactive/components/footer.ts:232-242`); each `setStatus` call ends
  in `ui.requestRender()` (`interactive-mode.ts:2090-2093`) — push, not poll, with
  pi-tui's 16 ms render throttle absorbing frequency. In print/json modes
  `setStatus` is a no-op (`core/extensions/runner.ts:242`).

### 3.3 Where pi's semantics genuinely differ

pi's `agent_settled` fires in a `finally` (`core/agent-session.ts:1108-1113`) — it
covers aborts **and** provider failures. imp's `run_end` deliberately does not fire
on a provider crash (§3.1). A timer built on `run_start` + `run_end` must therefore
tolerate an unpaired `run_start`. `notify.mjs` already ships with the same
asymmetry ("runs that die before any assistant message never notify"), so this is
consistent with the ecosystem's existing taste — see §5.3 for the extension-side
handling.

## 4. Design

### 4.1 `run_start` event

**Payload** — minimal, because the named consumer needs only the time point:

```ts
export interface RunStartEvent {
  type: "run_start";
}
```

**Emission** — at the top of `RunnerImpl.runTurn` (`runner.ts:944`), before the
delegation at `:954`. This is the only site that is (a) reached by both shells,
(b) outside the overflow-retry path, so it fires exactly once per run, and
(c) symmetric with `run_end`'s top-level-only coverage (subagents emit neither).

**Dispatch kind** — observer, fire-and-forget, via `fireObservers` (same class as
`run_end`; never awaited, per-handler isolation). A `run_start` handler must not
be able to delay or block the run.

**Contract wording** (goes into `types.ts` JSDoc): "`run_start` fires once when a
top-level run begins. Its pair is `run_end`, which does NOT fire if the run
crashes (provider throw) — consumers must tolerate an unpaired `run_start`
(e.g. reset state on the next one). Subagent runs emit neither event."

**Registration surface** — additive, mechanical: one `on()` overload, one
`ExtensionEventName` member, one `ExtensionEventHandlerMap` row, one
`KNOWN_EVENTS` entry, one `emitRunStart` on the registry.

### 4.2 Extension status channel

**API shape** — a ninth `ExtensionApi` member, not a per-call handler ctx:

```ts
/** Set this extension's status text for the TUI footer; undefined clears.
 *  Runtime method (like confirm): valid from event handlers, timers, and
 *  command callbacks, not gated to load time. Host owns styling; control
 *  sequences in text are stripped. No-op when nothing renders statuses
 *  (print mode, legacy shell). */
setStatus(key: string, text: string | undefined): void;
```

Rationale for api-member over per-call ctx: M4 §6.2 deferred ctx "until a real
consumer appears" — but when one did appear (interactive gating, M10), imp added
`api.confirm`, not `ctx.ui.confirm`. The api-member route is now the established
one. It also fits the consumer better: task-timer calls `setStatus` from its own
`setInterval`, where no handler ctx exists. pi supports exactly that call pattern
by capturing a ctx and guarding it with stale-ctx invalidation machinery — an
api member needs none of that.

**Key namespacing** — the registry prefixes keys with the extension's source name
(`source:key` in storage: `Map<string source, Map<string key, string text>>`).
Two extensions picking the same key cannot clobber each other — an improvement
over pi's single flat namespace, at zero cost to the extension author (the api
closure knows its source, exactly like `subscribe` does, `loader.ts:217-219`).

**Validation & bounds** (in the registry, at write time):

- `key`: must be a non-empty string after trim; invalid key → one teaching-style
  diagnostic line via the existing `report()` channel, write dropped.
- `text`: non-string (other than `undefined`) → same treatment. Strings are stored
  verbatim up to a defensive cap of 500 UTF-16 code units (silently truncated);
  `undefined` deletes the entry.
- Styling stays with the host (tool-display-polish-design.md: "styled by the host,
  never trusted metadata or terminal escape sequences from the extension").
  Sanitization happens at render time (§4.3), not write time, so the stored value
  remains faithful for future non-TUI consumers.

**Storage & notification** — the registry owns the map plus a single optional
*status sink* (one process renders at most one shell):

```ts
// ExtensionRegistry additions (shell-facing, not part of ExtensionApi):
setExtensionStatus(source: string, key: string, text: string | undefined): void;
getExtensionStatusEntries(): readonly { source: string; key: string; text: string }[]; // sorted by source:key
setStatusSink(sink: ((line: string) => void) | null): void;
```

`setExtensionStatus` updates the map, then — if a sink is bound — recomposes the
line and pushes it. No sink (print mode, tests): storage only, zero side effects.
Recomposition joins entries as `text` values sorted by `source:key`, space-joined
(pi parity: one line, alphabetical). The shell owns sanitize/dim/truncate (§4.3);
the registry's composed line is raw text joined with spaces.

**Sink binding path** — follows the `mcp` precedent (an optional capability
threaded from `cli.ts` through `runRepl` into the machine):

1. `ReplOptions` and `ReplMachineOptions` gain `extensions?: ExtensionRegistry`.
   `runInteractive` already holds the registry from `loadExtensionSetup`
   (`cli.ts:571`) and passes it to the runner — it now also passes it to `runRepl`.
2. `ReplMachine` constructor: if `options.extensions` exists **and**
   `this.input.setExtensionStatus !== undefined` (capability gate — the legacy
   shell has none), it renders the current entries, pushes the initial line
   (extensions loaded before the machine may already hold statuses), and calls
   `registry.setStatusSink(line => this.pushExtensionStatus(line))`.
   `pushExtensionStatus` applies shell policy and calls
   `this.input.setExtensionStatus(line)`.
3. `LineInput` gains the optional method, mirroring `setFooter`'s contract:

```ts
/** TUI shell only: extension-owned status line below the footer. Empty
 *  string hides it (zero rows). The legacy shell has no such line and
 *  never implements this. */
setExtensionStatus?(text: string): void;
```

There is no unbind path: the machine lives as long as the process's single REPL;
`/exit` tears down the process. (If a future reload exists, rebinding overwrites
the same slot.)

### 4.3 `TuiShell` rendering

- A second `Text` component, `extensionFooter`, added to the layout **below** the
  existing footer (`shell.ts:307-309` area). Buffered in an
  `extensionFooterText` field for pre-start pushes — the `footerText`
  pattern (`shell.ts:225-228`) verbatim. Empty string renders zero rows.
- `setExtensionStatus(text)` pipeline per push:
  1. `sanitizeDisplay(text)` — strip CSI/OSC/C1, escape controls
     (tool-presentation.ts:14; the task-live-display "untrusted input" rule);
  2. collapse any surviving `\r\n\t` to single spaces (the line must stay one
     line; `sanitizeDisplay` preserves `\n`, so this is a deliberate second step);
  3. `truncateToWidth(text, terminal.columns - 1, dim ellipsis)` — the pi-tui
     width-throw guard, mirroring pi's footer treatment;
  4. wrap in host `dim(...)`, store to the buffer, `setText`, `requestRender()`.
- Colors: the host dims the whole line. Extensions cannot color segments (no theme
  API — non-goal; pi's pre-colorized ANSI would not survive step 1 anyway).
- Render cost: one `setText` + one `requestRender` per push; pi-tui coalesces and
  throttles renders (16 ms), so the consumer's 1 Hz tick is far below any risk
  threshold. This is push-driven; nothing polls.

### 4.4 Print mode and the legacy shell

- Print mode loads extensions (`cli.ts:827`) but never constructs a `ReplMachine`,
  so no sink is ever bound: `setStatus` writes storage and returns. `run_start` /
  `run_end` fire normally (they already do for `notify.mjs`).
- The legacy shell constructs a `ReplMachine` whose `input` lacks
  `setExtensionStatus`; the capability gate in §4.2 step 2 skips binding. Same
  no-op outcome. Extensions therefore need no mode query — the channel itself is
  mode-agnostic, matching pi's "no-op context in headless modes"
  (`core/extensions/runner.ts:237-271`).

### 4.5 The shipped consumer: `examples/extensions/task-timer.mjs`

Behavior, ported from pi's extension with imp's event semantics:

- `run_start`: if a previous round is still open (unpaired `run_start` from a
  crashed run — §3.3), discard it. Record `Date.now()`, clear any old interval,
  paint immediately, then `setInterval(1000)` repainting
  `setStatus("task-timer", "running " + fmt(elapsed))`.
- `run_end`: clear the interval; `setStatus("task-timer", "done in " + fmt(elapsed))`;
  the line persists until the next `run_start`.
- `fmt` matches pi's `formatDuration`: `M:SS` under an hour, `H:MM:SS` above.
- The file header follows `notify.mjs`'s convention: install instructions
  (copy into `.imp/extensions/` or `~/.imp/extensions/`, restart), behavior
  summary, and the known-limitation list:
  - a crashed run (provider throw) leaves `running …` on screen until the next
    run starts — `run_end` never arrives by design (§3.3);
  - after `/new` or `/resume`, a stale `done in …` persists until the next run
    (imp has no session-lifecycle events yet — non-goal §2).

### 4.6 Tests

Registry unit tests (`test/extensions-registry.test.ts` or its successor layout):

- `run_start` accepted by `subscribe` (KNOWN_EVENTS), unknown events still
  rejected with the teaching diagnostic;
- `setExtensionStatus`: store/clear/overwrite; source-namespacing (two sources,
  same key, both kept); invalid key/text diagnostics; 500-unit cap; composed line
  ordering sorted by `source:key`; sink push on write, none when unbound.

Runner tests (`test/runner*.test.ts`):

- `run_start` fires exactly once per `runTurn`, before `message_end`/`run_end`
  (order assertion), including on the overflow-recovery path (one `run_start`,
  one `run_end`);
- fires in print mode (`runPrint` path) and REPL path alike;
- does not fire for subagent runs (task tool child emits `tool_call` only);
- provider crash ⇒ `run_start` emitted, `run_end` not (locks §3.3 so a future
  change is a conscious contract decision).

Shell/TUI tests:

- `TuiShell.setExtensionStatus`: renders the line, empty string collapses to zero
  rows, pre-start push is buffered and painted by `start()`, ANSI/control
  sequences stripped, over-width text truncated (fake terminal, narrow columns);
- `ReplMachine` binding: statuses set before machine construction appear after it;
  capability gate — a `LineInput` without `setExtensionStatus` binds nothing.

Extension test (new, e.g. `test/task-timer-extension.test.ts`):

- drive `examples/extensions/task-timer.mjs` with a fake api + fake timers:
  start → tick text (`running 0:03`), end → `done in 0:03`, hour rollover format,
  unpaired-`run_start` reset, interval cleared on `run_end`.

Existing suite must pass unchanged (no edits expected; assertions on the
four-event KNOWN_EVENTS list get the new member added).

### 4.7 Documentation

- This file.
- `types.ts` JSDoc for the new API (contract wording in §4.1/§4.2).
- `task-timer.mjs` header comment (install + limitations).
- `examples/extensions/README` or top-level README extension section: one row
  added to the example list, if such a list exists (check at implementation time;
  keep the diff doc-minimal otherwise).

## 5. Semantics decisions (the short list a reviewer should attack)

### 5.1 Exactly-once and pairing

`run_start` fires once per top-level run at `runTurn` entry. It pairs with
`run_end` only on runs that end; a provider crash breaks the pair. Chosen over
emitting in `runTurnInner` (would double-fire on overflow retry) and over wrapping
`runTurn` in try/finally to synthesize a crash-time `run_end` (would rewrite the
existing, documented `run_end` contract and force every observer — `notify.mjs`
included — to reason about a new stop reason).

### 5.2 Top-level only

Subagents emit neither `run_start` nor `run_end`, preserving today's symmetry. A
child-aware timer would need the child `run_end` question answered first (the
child's overflow retry double-launches its loop — `subagent.ts:286,395` — so even
the emission site is non-obvious). The activity region already shows live subagent
progress; footer timing of children is a future named-consumer decision.

### 5.3 Crash residue in the consumer

task-timer resets on the next `run_start`; between crash and next run the footer
shows a stale `running …`. Accepted: crashes are rare, the transcript shows the
error prominently, and pi's ecosystem treats `session_*` cleanup as the proper
hook — which imp deliberately does not add in this batch (non-goal §2).

## 6. Alternatives considered

1. **Per-call handler `ctx` with `ctx.ui.setStatus` (pi's pattern).** Rejected:
   M4 §6.2's deferral was resolved in practice by `api.confirm` (M10) — api members
   are imp's established shape; and the consumer calls `setStatus` from a
   `setInterval`, where no per-call ctx exists. pi solves that with captured-ctx
   staleness guards (`assertActive`); an api member needs no such machinery.
2. **Synthesize `run_end` on crash (new stop reason or `finally` emit).**
   Rejected: rewrites a documented contract (`runner.ts:1103-1105`) and perturbs
   shipped observers for one consumer's edge case; the consumer tolerates the
   asymmetry cheaply (§5.3). `notify.mjs` already lives with the same gap.
3. **Append the status to the existing footer line instead of a second line.**
   Rejected: that line is already dense (7 segments, `repl.ts:805-880`), has no
   width management today, and pi-tui throws on overflow; a second `Text` is zero
   rows when empty and gets an independent width budget.
4. **`run_start` payload carrying `model`, `prompt`, etc.** Rejected for now
   (YAGNI): the named consumer needs only the time point; payload fields are
   additive later without breaking the event.
5. **Expose theme/color to extensions (pi's `ctx.ui.theme.fg`).** Rejected:
   host-owns-styling is the tool-display-polish principle; one dim line is
   visually consistent with the existing footer.
6. **Add `session_start`/`session_shutdown` now for status cleanup.** Deferred:
   the only consumer's need is met by the `run_start` reset; two more normative
   events need their own consumers.
7. **Poll instead of push (shell re-reads statuses on its own tick).** Rejected:
   imp's footer is push-driven end to end (`setFooter`, `setQueue`,
   `showNotice`); a poller would be the only one.

## 7. Risks & mitigations

1. **Width overflow crashing pi-tui.** Mitigation: `truncateToWidth` on every
   push (§4.3 step 3) + a shell test with a narrow fake terminal.
2. **Control-sequence injection from extension text.** Mitigation:
   `sanitizeDisplay` + newline collapse at render time (§4.3); stored values stay
   raw but only the TUI pipeline renders them.
3. **Unpaired `run_start` leaving stale `running …`.** Accepted and documented
   (§5.3); consumer resets on next `run_start`.
4. **Status surviving `/new`—stale `done in …`.** Accepted, documented in the
   extension header; the next run replaces it.
5. **Binding-order race: extension sets status before the machine exists.**
   Mitigation: storage-first in the registry + initial push at bind time
   (§4.2 step 2).
6. **`setStatus` mistaken for a load-time-gated method.** Mitigation: JSDoc
   wording in §4.2 contrasts it with the `whileLoading`-guarded registrations.
7. **1 Hz repaints stealing frame budget.** Non-issue by construction
   (`requestRender` coalescing + 16 ms throttle, same path the 120 ms activity
   spinner already uses); dogfood watch item.
8. **Scope creep toward pi's full `ctx.ui`.** Mitigation: this batch adds exactly
   one channel for one consumer; the non-goals in §2 are written down.

## 8. Implementation checklist

1. `src/extensions/types.ts`: `RunStartEvent`; `on("run_start")` overload;
   `ExtensionEventName`; `ExtensionEventHandlerMap`; `ExtensionApi.setStatus`
   signature + JSDoc (contract wording §4.1/§4.2).
2. `src/extensions/registry.ts`: `KNOWN_EVENTS += "run_start"`; `emitRunStart`;
   status map + validation + `setExtensionStatus`/`getExtensionStatusEntries`/
   `setStatusSink`; composition helper (sorted `source:key` join).
3. `src/extensions/loader.ts`: `setStatus` member in `extensionApi()` closing
   over the extension's source name (runtime method — no `whileLoading`).
4. `src/runner.ts`: `emitRunStart` at `runTurn` entry.
5. `src/repl/line-input.ts`: optional `setExtensionStatus`.
6. `src/repl/shell.ts`: `extensionFooter` component + buffer + pipeline
   (sanitize → collapse → truncate → dim → render).
7. `src/repl/repl.ts`: `ReplOptions`/`ReplMachineOptions.extensions`; machine
   binding (initial push + `setStatusSink`).
8. `src/cli.ts`: pass the registry into `runRepl`.
9. `examples/extensions/task-timer.mjs`.
10. Tests per §4.6; run the full suite.
11. Dogfood: install into `~/.imp/extensions/`, run a few real tasks (including a
    Ctrl+C abort and, if feasible, a forced provider error) and record findings.
