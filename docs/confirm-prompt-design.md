# Confirm prompt surface (design)

Status: APPROVED — independent adversarial review closed after five rounds
(NEEDS REVISION → CONFIRMED WITH NOTES → CONFIRMED WITH NOTES → NEEDS REVISION →
CONFIRMED); every fold is recorded in §13. **Phase 1 and Phase 2 are both
implemented** (§7 and §8 record the implementation facts, deviations and gate
results); Phase 2 awaits its independent implementation check.

Workspace: `/Users/z/Z/Agent_demo/imp-confirm-design` (a dedicated git worktree, so
this design does not disturb the shared checkout; node_modules is symlinked to
the main checkout for the test runs cited below).
Branch: `docs/confirm-prompt-design`, based at `main` = `154aa99` (rebased after the merge of the parallel batches).

Line references below are verified against `154aa99` (`src/repl/shell.ts` refs
were re-derived after the rebase; the `src/repl/shell.ts` constructs shifted by
~17 lines when the parallel batches merged). Review-log entries in §13 keep the
line numbers they were written against — they are a historical record. If `main`
moves again before Phase 2, re-derive before coding.

Scope: the interactive approval prompt (`api.confirm`) as rendered by the TUI
shell — its record policy, layout, keys, and the two additive extension-facing
options planned in Phase 2. One document covers both phases on purpose (§6 D0):
the seam shapes and the layout constrain each other, and imp's own precedent for
phased work is one document with per-phase acceptance criteria
(`docs/m4-extensions-design.md` §15) plus amendment sections when a later phase
changes the contract (`docs/tui-tool-elapsed-design.md` Review log).

## 1. Problem

Owner feedback (2026-09-29): the guardian extension's approval UI is not good
looking; compare with Claude Code's permission approval rendering and judge
whether imp's has room to improve.

Measured — real frames, captured at `06dbfcb` (identical on `0fe1276` and on the
`546a61b` base) by driving the production render path (`TtyConfirm` →
`TuiShell.select`) in a scratch harness; the scratch file was deleted afterwards
and the worktree is clean:

```
▪ confirm: [guardian] allow this bash command?
  command: rm -rf ~/.ssh/old_keys && sudo systemctl restart nginx --now
why it matched: recursive force delete — list the files that would go and ask
first, or delete the specific files one by one
[guardian] allow this bash command?
command: rm -rf ~/.ssh/old_keys && sudo systemctl restart nginx --now
why it matched: recursive force delete — list the files that would go and ask
first, or delete the specific files one by one
→ Yes
  Yes, don't ask again this session
  No
```

Four defects are visible in that single frame:

1. **Duplication.** The title and the whole detail block appear twice: once as
   transcript notes, once as the picker's own title/detail.
2. **No affordance.** The picker offers no key hints, and the editor hint row is
   deliberately blanked while a picker owns focus, so nothing on screen says how
   to answer.
3. **Opaque memory.** "Yes, don't ask again this session" does not say *what* is
   being remembered — `guardian:bash:<pattern>` (this command shape) and
   `guardian:write:<cwd>` (this directory) are very different grants.
4. **Prose-wrapped risk.** The gated command is dim prose wrapped mid-phrase,
   instead of the form the transcript already uses for the same call.

## 2. History (verified, not from memory, at `06dbfcb`)

| Fact | Evidence |
|---|---|
| Entry point: extensions call `api.confirm(message, detail, options)` | `src/extensions/types.ts:105`; guardian call sites `examples/extensions/guardian.mjs:228` (bash gate) and `:243` (write gate) |
| Host: `TtyConfirm.handler` writes `renderer.note` lines, then opens the picker | `src/repl/repl.ts:265-283` (title note `:271`, detail note `:272`, `select` call `:275-280`) |
| The notes go to the output stream, so they are the only detail carrier on non-TUI hosts | `src/render.ts` `note()`; `test/repl-confirm.test.ts:67` asserts the detail note for the picker host, `:127` the probe of the no-picker path |
| Options are a host constant, identical for every gate | `src/repl/repl.ts:234-238` (`Yes` / `Yes, don't ask again this session` / `No`) |
| Picker primitive: `TuiShell.select` — title, dim detail, `warnSpans`, items, optional type-to-filter | `src/repl/shell.ts:827-972`; `SelectOptions` at `src/repl/line-input.ts:31-51` |
| Warn spans: extension supplies plain offsets, host owns color | `src/repl/shell.ts:861`; `src/format.ts:162-192` (`WARN_START = \x1b[0m\x1b[1;31m`) |
| Theme is the identity map — the picker rows carry no color | `src/repl/shell.ts:81-92` (`tuiEditorTheme`) |
| The editor hint row (and notice row) are blanked while a selector owns focus | `src/repl/shell.ts:1194-1205` (`updatePlaceholder`, `blocked` at `:1198`); hide/restore comments at `:965` and `:882` |
| Picker keys: up/down, Enter, Esc/Ctrl+C only — no digits, no letter hotkeys | `node_modules/@earendil-works/pi-tui/dist/components/select-list.js:67` (up), `:84` (cancel); row marker `"→ "` at `:91` |
| The shell's pre-focus listener runs before the focused component sees a key | `tui.js` `inputListeners` ordering; imp's listener carries `filterKey` at `src/repl/shell.ts:920` |
| `Container.addChild` is append-only; the filter path rebuilds the list by remove+append | `node_modules/@earendil-works/pi-tui/dist/tui.js` (`addChild` push); `src/repl/shell.ts:898` (`applyFilter`) |
| `select` is shared: project-trust ask, `/settings`, `/model`, other command pickers | `src/repl/trust-ask.ts:59`; `src/repl/commands.ts:580,628,1109,1271` |
| Session memory is host-side, keyed by `sessionKey` | `src/repl/repl.ts:257` (set), `:267` (short-circuit), `:282` (remember); `ConfirmOptions` at `src/extensions/types.ts:48-59` |
| Note lines are pinned by tests | `test/repl-confirm.test.ts:66` (title), `:67` (detail — the only detail pin), `:76` and `test/repl-tui.test.ts:2068` (the `— allowed for this session` suffix, unaffected by D1) |
| Picker marker is pinned by tests | `test/repl-tui.test.ts:703,726,778,779,1043,1044,1049,1078,1595,1796` — ten sites; `:726` is an ordering assertion, the other nine are marker assertions |
| Legacy asks must stay byte-identical; no-host hosts decline with one teaching line | `test/repl-confirm.test.ts:127`; `src/extensions/registry.ts:93-94` (written at `:356`) |
| Guardian's write gate passes an exact options object | `test/guardian.test.ts:107` (`toEqual({ sessionKey: "guardian:write:/tmp/imp-wt-9" })`) |

## 3. External reference (what pi and Claude Code do)

- **pi's host hands extensions a UI toolkit.** `pi.dev/docs/latest/extensions`:
  `ctx.ui` provides dialogs, notifications, status text, widgets, titles, editor
  access, and `ctx.ui.custom()` for full TUI components with their own input
  handling; the host keeps the lifecycle, execution-mode gates (RPC can forward
  built-in dialogs but not custom components), and the fail-safe block when a
  `tool_call` handler throws. (imp's `TuiShell` is built on
  `@earendil-works/pi-tui` — the same component layer — but imp keeps the
  components to itself, `docs/m4-extensions-design.md` §16.)
- **The community permission package composes its own prompt.**
  `pi.dev/packages/@gotgenes/pi-permission-system`: policy, matching, session
  approvals, subagent forwarding are the extension's; the inline dialog (keys
  `y`/`s`/`n`/`r`, remappable, double-press to confirm, one fact per line, a row
  budget, `Ctrl+O` to expand) is built by the package. It states that
  approve-and-steer, edit diffs, and risk explanations belong to *downstream
  packages* over its decision event and presentation seams. Its docs also note
  why letter hotkeys are remappable: an input method editor swallows letter keys
  during composition, while digits are unaffected.
- **Claude Code ships per-tool approval dialogs in the host**
  (`src/components/permissions/PermissionRequest.tsx`): a top-border-only
  `PermissionDialog`, numeric options, `Tab` to turn the focused option into an
  inline feedback input, a dim `Esc to cancel · Tab to amend` footer, and diffs
  rendered by `StructuredDiff`.
- **imp refuses the toolkit route by design.** `docs/m4-extensions-design.md`
  §1/§16 list "any UI contribution (renderers, autocomplete, dialogs)" as a
  non-goal; §6.2 records the refusal of pi's per-call `ctx`. What imp ships
  instead is *declarative data*: `warnSpans` offsets, `sessionKey`,
  `api.setStatus`, and `ToolPresentationHooks` semantic presentations
  (`src/core/tools/types.ts:54-57`).

Consequence: imp's seam must stay declarative. **Phase 2 adds data fields the
host renders; it does not hand extensions a renderer.**

## 4. Goal

Deliver the owner-visible fix in two merges, with one design:

- **Phase 1 (host-only, no extension API change).** Remove the duplication where
  it is duplication, put a key affordance on screen, make the options answerable
  by number, number the rows, and give the block explicit sectioning.
- **Phase 2 (seam + consumer).** Add two additive `ConfirmOptions` fields — a
  memory-scope label and a command preview — and have guardian pass both, so the
  seam ships with its real consumer (imp's rule: no API without a consumer,
  `docs/m4-extensions-design.md` §16).

## 5. Non-goals (explicit)

- No extension-supplied rendering, components, or host-module imports. No
  `ui.custom` equivalent; that would be an architecture change (loader aliasing,
  trust model, mode gates) and needs its own document.
- No extension-to-extension event bus, and no downstream risk-explainer package.
- No free-text "tell imp what to do instead" feedback return (Claude Code's
  `Tab`): it changes `api.confirm`'s return type and needs its own contract.
- No diff preview inside the confirm (needs a before/after contract the
  extension does not have). Follow-up, §12.
- **No change to the legacy `[y/N]` ask, to plain non-TTY hosts, or to print
  mode** — not even by side effect: D1's note change is conditional on the
  picker precisely to keep this true (round-1 P0).
- No change to the transcript's tool rows.
- No policy change: guardian's rules, thresholds, and `sessionKey` granularity
  stay exactly as they are.
- No packaging/publishing work for guardian.

## 6. Decisions

### D0 — one document, two phases

Layout and seam shapes constrain each other; two documents would duplicate the
shared layout and drift. Precedent: `docs/m4-extensions-design.md` (sub-milestones
M4a-c with per-milestone acceptance) and `docs/tui-tool-elapsed-design.md` (one
document, contract changes folded in as amendment sections with their own review
rounds).

### D1 — record policy: one title line, and the detail note only where no picker carries it

`TtyConfirm.handler` is the single handler for **every** host: TUI picker,
readline `[y/N]`, and the no-host fallback. Its two notes (`repl.ts:271-272`) run
unconditionally today, before the picker check at `:275` and the ask check at
`:284`. On the readline and no-host paths there is no picker, so the detail note
is the **only** place the gated command and its reason reach the user.

Decision: keep the title note always, and write the detail note **only when no
picker is available**:

```ts
this.renderer.note(`▪ confirm: ${message}`);
// The picker carries the detail itself; hosts without one have only this line.
// (Phase 2 adds the plain preview note above it — D7.)
if (this.select === null && detail !== undefined && detail !== "") this.renderer.note(`  ${detail}`);
```

Consequences:

- TUI: title once in the transcript, detail inside the picker (defect 1 fixed).
- readline / no-host / print: byte-identical to today (non-goal kept).
- The session-memory suffix line (`— allowed for this session`, `repl.ts:268`)
  is untouched.

Test impact, corrected after round-1 P2 and round-2 N1: the **only** detail-note
pin is `test/repl-confirm.test.ts:67` (`:66` is the title assertion, `:68` is a
comment); `:76` and `test/repl-tui.test.ts:2068` pin the suffix (unaffected).
New guard: a test asserting the detail note **is** written when `select` is
absent.

Known transient (round-2 N5): a TUI confirm *queued* behind another picker
(`src/repl/shell.ts:836`) writes the title note immediately but its detail
only when the picker actually opens — and if the shell closes before that, the
detail is never shown. This is accepted and documented rather than worked
around: today's duplicate-note behavior is the thing being removed, and no
predicate exists to distinguish "queued" from "no picker".

### D2 — affordance line, inside the picker, on non-filterable pickers only

While a picker owns focus the editor hint row is blanked on purpose
(`src/repl/shell.ts:1194-1205`, M10 review P2#5), so the affordance must live
**inside** the picker box, as a dim line under the items. Copy follows the
existing hint style (lowercase, parenthesized, `·` separated —
`src/repl/shell.ts:175-182`):

```
(↑/↓ move · enter select · esc cancel · 1-3 quick pick)
```

The range shown is computed from the item count (§6 D3): today the confirm
carries three items (`src/repl/repl.ts:234-238`), so it reads `1-3`; a picker
with more items widens the range up to `1-9`.

Rules:

- The line is added **only when the picker is not filterable**. A filterable
  picker keeps its `filter:` row and gets no digit range (a digit there is a
  query character, D3).
- The dim call passes the ANSI flag explicitly — `dim(text, true)` — matching
  the detail block at `src/repl/shell.ts:861`; the `dim()` default probes
  `process.stdout.isTTY` (`src/format.ts:9`) and would make frames non-deterministic
  under the test terminal.
- The numeric range is computed from the item count (D3/D4).

### D3 — number keys, and only where they cannot collide

Digits `1..9` select **item index n-1** (static, not "the n-th visible row"):
numbering is scroll-invariant even when `SelectList` scrolls, because the host
numbers before the list ever scrolls. Consequences to state explicitly:

- Digits above `min(items.length, 9)` are ignored.
- A digit on a filterable picker stays a query character — the confirm picker
  never sets `filterable`, so it is unaffected.
- Letters are not bound (`y`/`n`): the pi package documents that an IME swallows
  letter keys during composition, digits are unaffected, and leaving letters free
  avoids colliding with the type-to-filter habit.

Implementation: the shell's pre-focus listener (which already carries `filterKey`,
`src/repl/shell.ts:920-950`) runs before the focused component receives a key
(pi-tui `inputListeners` ordering, round-1 checked), so digit handling belongs
next to `filterKey`, gated on `selector !== null` and the picker not being
filterable.

### D4 — row numbering on every non-filterable picker

Rows become `→ 1. Yes`. Numbering is applied inside `TuiShell.select` for all
non-filterable pickers (confirm, project trust, `/settings`, `/model`) rather
than only for the confirm: the affordance line advertises digits, and a picker
showing the hint without numbers would be lying.

Blast radius, corrected after round-1 P2 — **ten** sites, all in
`test/repl-tui.test.ts`:

- nine marker assertions (`:703,778,779,1043,1044,1049,1078,1595,1796`) become
  `<marker> <n>. <label>`;
- `:726` is a **different** kind of assertion — an ordering check
  (`indexOf("why it matched") < indexOf("→ Yes")`) whose needle must change to
  `"→ 1. Yes"`; it does not follow the prefix rule.

The label prefix is presentation only: the row's identity stays the original
index in `SelectItemOption.value` (`src/repl/shell.ts:846-850`), which is what
`finish()` resolves. A wider search found no picker-marker assertions outside
that file (round-1 checked).

Open question Q1: if the churn in unrelated pickers is judged too broad, the
fallback is an opt-in `SelectOptions.numbered?: boolean` set only by
`TtyConfirm`; layout and keys stay as specified.

### D5 — block layout, width budget, and child order

Top to bottom, inside the existing ask area (no border; see D6):

```
[title]                       one row, as today
[detail]                      dim block, warn spans applied, wrapped as today
[preview]                     Phase 2 only (§7), transcript header idiom
[blank]                       one blank row, only when the hint row is present
  1. Yes
  2. Yes, don't ask again this session
  3. No
[hint]                        dim affordance line (D2)
```

Rules: exactly one blank row before the items and none between the items and the
hint; the blank row and the hint row are added **only on non-filterable
pickers**, so the item list stays the last child for filterable ones —
`Container.addChild` is append-only and `applyFilter` rebuilds the list by
remove+append (`src/repl/shell.ts:898`), so a hint appended after the list
would leave a refiltered list *below* the hint (round-1 P2). Pin a test that
refiltering keeps the list below nothing else. Every row honors the terminal
width (enforcement pattern: `test/repl-tui.test.ts:732`, `:299`); the item list
keeps its `Math.min(items.length, 8)` window and scroll indicator.

### D6 — color: dim only, no accent

Phase 1 uses dim for the hint line (explicit `dim(..., true)`), leaving the
identity theme (`src/repl/shell.ts:81-92`) untouched. An accent color or a top
border would change the pre-M9 aesthetic the theme encodes and that every other
surface shares; it is not needed to fix the four defects.

Recorded as a droppable, separately decidable item: if the owner wants an accent
later, it lands as its own small change with its own acceptance.

### D7 — Phase 2 contract (additive, both optional)

```
interface ConfirmOptions {
  sessionKey?: string;                  // existing
  warnSpans?: Array<[number, number]>;  // existing
  /** What "don't ask again this session" will remember, in the extension's
   *  own words ("this command pattern", "this directory"). Rendered inside
   *  the second option's label. Absent: current wording. */
  rememberLabel?: string;
  /** The request being decided, rendered in the transcript's call-header
   *  idiom instead of prose. Only "command" exists in Phase 2. */
  preview?: {
    kind: "command";
    tool: string;                       // e.g. "bash"
    text: string;
    warnSpans?: Array<[number, number]>; // offsets into `text`
  };
}
```

- `rememberLabel` renders as `Yes, don't ask again this session (<label>)`. The
  host still owns the memory (`sessionAllowed`, keyed by `sessionKey`); the
  extension supplies only the words. This is the split agreed in review: memory
  is host policy, granularity wording is extension knowledge.
- **Division of labour between `preview` and `detail` (round-3 R2).** `preview`
  is the request being decided; `detail` is the explanation. The extension must
  **not** repeat the command inside `detail` (guardian drops its `command: …`
  prefix and passes `why it matched: …` as the detail). The host guarantees the
  command is shown **exactly once** on every surface:
  - TUI: a styled row under the title, before the items;
  - text hosts (readline, no-host, print): one plain note line, so the command
    is not lost where the styled row does not exist (D8).
- `preview.kind === "command"` renders `● <tool>  <text>` in the transcript's
  call-header idiom: dim `●`, bold tool name, two spaces, then the text;
  continuation rows are indented and do not repeat the header.
  **Corrected after round-1 P1:** this does **not** reuse `ToolBlockFold`.
  Verified: `ToolBlockFold` requires a full `ToolBlock` produced from a
  `PreparedToolCall` (`src/repl/components/tool-block.ts:87,96`;
  `src/repl/tool-presentation.ts:109,170,173`), and its header is built inside
  `render()` entangled with summary-visibility, path cropping and width budgets
  (`src/repl/components/tool-block.ts:392`). Phase 2 therefore adds a **small
  exported helper next to it** — `renderCommandHeader({tool, text, warnSpans,
  width})` in `src/repl/components/tool-block.ts`, which reuses the already
  exported `wrappedRows` (`:73`) — and its acceptance is a **literal pin** on
  the returned rows, not an equality with the transcript's renderer.
  It carries **no completion suffix**: a transcript call row is
  `● bash <cmd> ✓ 1.2s`, which is meaningless for a call that has not run yet
  (#tui-tool-elapsed never applies here).
- Malformed or unknown values (`preview.kind` not `"command"`, non-string
  `tool`/`text`, out-of-range spans) render nothing extra and never throw — the
  defensive stance `applyWarnSpans` already takes (`src/format.ts:168-192`).
- **Both `tool` and `text` pass through `sanitizeDisplay`**
  (`src/repl/tool-presentation.ts:14`) before rendering. The transcript header
  sanitizes the same way (`src/repl/components/tool-block.ts:409,412`), and
  pi-tui's `Text` preserves control bytes instead of stripping them
  (`node_modules/@earendil-works/pi-tui/dist/components/text.js:54-55`), so a
  command string containing ESC sequences would otherwise reach the terminal
  (round-2 N2).
- **Warn styling and wrapping (round-3 R3, wording corrected in round 4).**
  `preview.warnSpans` are plain `[start, end)` offsets into `text` — the
  extension never emits ANSI. The helper maps each tuple to `{start, end, style}`
  (the `StyleSpan` shape the wrap path consumes, `src/repl/components/tool-block.ts:16-27`)
  with the host's alert style, and wraps through `wrappedRows(text, width, spans)`
  (`:73`). Note the mechanism: `styled()` applies `span.style` and appends its own
  `RESET` (`:16-27`) — `WARN_END` (`src/format.ts:163`) belongs to the
  `applyWarnSpans` path (the detail block, `src/repl/shell.ts:861`) and is **not**
  consumed by the wrap path. Width follows the existing enforcement pattern
  (`test/repl-tui.test.ts:742`).
- Degradation (D8) applies: hosts without a picker ignore both fields.

### D8 — degradation matrix (must not change)

| Host | Behavior with the new fields | Evidence |
|---|---|---|
| TUI picker | renders them (Phase 2) | n/a |
| Legacy readline ask | ignored; `proceed? [y/N]` byte-identical, the detail note still written (D1), and `preview` printed as one plain note line | `test/repl-confirm.test.ts:127`, new guard |
| No interactive host (print, tests) | same as readline: the one `imp:` teaching line, resolves false; `preview`/`detail` reach the transcript as plain notes | `src/extensions/registry.ts:93-94` |
| Subagent call in-process | same host, same queue as the parent | `test/repl-tui.test.ts:1031` |

## 7. Phase 1 — host-only: scope, files, acceptance

**Status: IMPLEMENTED** (branch `feat/confirm-prompt-phase1`, on top of this
document's branch). Recorded implementation facts:

- D1 keeps the title note and writes the detail note only when `this.select` is
  null (`src/repl/repl.ts`); the picker host's detail lives in the picker.
- D2-D5 live in `src/repl/shell.ts`: `numbered = options.filterable !== true`,
  labels `"N. <label>"`, a blank row above the items, `pickerAffordance(n)` under
  them, and a `numberKey` hook consulted by the pre-focus listener right after
  `filterKey`.
- Red-first evidence, corrected after the implementation check: with the FINAL
  pin set, reverting `src/repl/repl.ts` and `src/repl/shell.ts` to `2b1c15e^`
  fails **9** tests (the `repl-confirm` picker-host assertion, six `repl-tui`
  marker/affordance pins, and the two `/model` marker sites). The first red run
  showed 7 only because the two `/model` needles were updated afterwards. 164/164
  green in the two focused files after the change.
- **D5's blank row needs `Spacer(1)`, not an empty `Text`** — the check caught the
  first implementation painting nothing: pi-tui's `Text.render()` returns `[]` for
  empty/whitespace-only text (`node_modules/@earendil-works/pi-tui/dist/components/text.js`),
  which the shell's own comment about the placeholder already notes. The pin now
  asserts the blank line above the first item row.
- **The D5 child-order pin was strengthened**: it asserts that no picker chrome
  follows the refiltered list row (the next non-empty line is the editor rule),
  which discriminates the hazard rather than merely ordering two fixed strings.
  Both new pins were mutation-verified (empty `Text` → blank-row pin red;
  unconditional chrome → child-order pin red).
- Marker sites: **all ten** asserted sites needed the numbering form — including
  the two `/model` sites (`test/repl-tui.test.ts:1595,1796`). `/model` is **not**
  filterable (`src/repl/commands.ts:1503-1506`; the `filterable: true` at `:1439`
  belongs to `/resume`), so D4's rule numbers it like the confirm.
- Gates (unmasked): lint 0, typecheck 0, full suite 0 (**127 files / 2466
  tests**), build 0.

Files: `src/repl/repl.ts` (D1), `src/repl/shell.ts` (D2-D5), `CHANGELOG.md`, tests
`test/repl-tui.test.ts`, `test/repl-confirm.test.ts`.

Acceptance criteria (scriptable):

1. **Picker host:** the picker box contains the title once *and* the transcript
   keeps its single `▪ confirm: <title>` record line — the title legitimately
   appears in both regions, and the detail does not (D1).
2. **No-picker host:** the title *and* detail notes are both written
   (byte-identical to today), the readline probe at
   `test/repl-confirm.test.ts:127` still passes unchanged (D1, non-goal §5),
   and a `preview` appears as one plain note line (D7, D8).
3. While a non-filterable picker is open: the affordance line is present, digits
   `1..n` select item `n-1`, Enter selects the highlighted row, ↑/↓ move, Esc
   cancels to a decline, and digits above the item count are ignored (D2-D4).
4. Rows render as `→ <n>. <label>` on non-filterable pickers; all ten
   `test/repl-tui.test.ts` sites pass with the corrections listed in D4 (nine
   prefix updates, one needle change).
5. A filterable picker: digits build the query, no hint row is added, and the
   list remains the last child after refiltering (D2, D3, D5).
6. No rendered line exceeds the terminal width.
7. Gates, unmasked exit codes: lint 0, typecheck 0, full suite 0, build 0.

## 8. Phase 2 — seam + consumer: scope, files, acceptance

**Status: IMPLEMENTED** (branch `feat/confirm-prompt-phase2`). Recorded
implementation facts and the three deviations from the text below:

- The seam is exactly the two optional fields; no extension API signature
  changed. `CommandPreview` lives in `src/extensions/types.ts` (the contract) and
  `SelectOptions.preview` imports that type, so there is one definition.
- **Deviation 1 (mechanism): wrapping is `Text`'s, not `wrappedRows`.**
  `renderCommandHeader(preview)` takes the preview object and returns **one styled
  string**; the `Text` block that carries it wraps it exactly like the detail
  block (the house mechanism for block content). Same user-visible result — width
  honored, header never repeated — with no width plumbing and no span-order risk.
  A second export, `commandPreviewText(preview)`, is the plain (no-ANSI) carrier
  for text hosts.
- **Deviation 2 (sanitization scope): control SEQUENCES are consumed.**
  Sanitization is the shared `sanitizeDisplay`, which consumes ANSI/CSI/OSC
  sequences whole; a bare C0 byte follows the house policy (as on every other
  surface, a lone BEL survives). The acceptance line below is read as "control
  sequences are consumed" — the security-relevant part, pinned.
- **Deviation 3 (pin placement):** the byte-exact pins live in the new
  `test/confirm-preview.test.ts`, not in the TUI test: the TUI writes a styled row
  in fragments, so an exact-byte assertion there is unreliable. The TUI test keeps
  the layout pins (idiom rendered once, no `✓`/elapsed, width honored).
- Guardian: `preview` + `rememberLabel: "this command pattern"` at the bash gate
  (warn spans are now command-relative), `rememberLabel: "this directory"` at the
  write gate, and the `command: …` prefix is gone from the detail — so the command
  appears exactly once.
- Red-first evidence: 9 pins red on the pre-change code (5 guardian option pins,
  2 confirm pins, 2 preview pins); 219/219 green in the five focused files after.
- Gates (unmasked): lint 0, typecheck 0, full suite 0 (**128 files / 2483
  tests**), build 0. One flake observed once under load (an unrelated
  `login-dialog` device-code test); it passes in isolation and on re-run.

Files: `src/extensions/types.ts` (D7), **`src/repl/repl.ts`** (`TtyConfirm`
builds the option labels (`confirmItems`), so `rememberLabel` lands here; the
plain `preview` note on text hosts belongs to the same handler),
`src/repl/components/tool-block.ts` (`renderCommandHeader`, `commandPreviewText`),
`src/repl/shell.ts` (the picker-side preview row), `src/repl/line-input.ts`
(`SelectOptions.preview`), `examples/extensions/guardian.mjs` (pass both at the
bash gate and drop its `command: …` prefix; `rememberLabel` at the write gate),
`test/confirm-preview.test.ts` (new), `test/repl-tui.test.ts`,
`test/repl-confirm.test.ts`, `test/guardian.test.ts`, `CHANGELOG.md`.

Round-4 correction: an earlier draft listed only `shell.ts` for Phase 2. The
shell never runs on text hosts (`TuiShell` exists only when the input implements
`select`; `bindSelect` is then the only setter of `this.select`), and the option
labels are built in `repl.ts`, not in the picker primitive.

Acceptance criteria (scriptable):

1. With `rememberLabel`, the second option reads
   `Yes, don't ask again this session (<label>)`; without it, byte-identical.
2. With `preview`, the confirm shows `● <tool>  <text>` with the preview's own
   `warnSpans` highlight and **no** completion suffix; the rendered text is
   pinned literally in the test.
3. **Combined case (round-3 R2):** when `detail` and `preview` are both present
   — which is what guardian passes — the frame contains the command **exactly
   once** (in the preview) and the detail carries only the explanation; without
   the field, byte-identical.
4. Guardian passes a `rememberLabel` at both gates, a `preview` at the bash
   gate, and drops the `command: …` prefix from that gate's `detail`; its
   decline path (`{block, reason}`) is unchanged, and `test/guardian.test.ts:107`
   (exact-equality options object at the write gate) is updated to include the
   new field (round-1 P3).
5. Both fields are ignored by the readline ask and by no-host hosts, except that
   `preview` is written as a plain note line (D8).
6. An unknown `preview.kind` renders nothing rather than throwing.
7. Gates, unmasked exit codes: lint 0, typecheck 0, full suite 0, build 0.

## 9. Files touched (implementation forecast)

| Phase | File | What changes |
|---|---|---|
| 1 | `src/repl/repl.ts` | detail note becomes picker-conditional (D1) |
| 1 | `src/repl/shell.ts` | numbering, digit handling, affordance line, blank-row sectioning, child order |
| 1 | `test/repl-tui.test.ts` | ten marker sites + new pins |
| 1 | `test/repl-confirm.test.ts` | detail-note guard for the no-picker path |
| 2 | `src/extensions/types.ts` | `rememberLabel`, `preview` |
| 2 | `src/repl/repl.ts` | `rememberLabel` in the option labels; the plain `preview` note on text hosts |
| 2 | `src/repl/components/tool-block.ts` | new exported `renderCommandHeader` helper (sanitize, warn style, wrap) |
| 2 | `src/repl/shell.ts` | render the preview row in the picker; ignore malformed values |
| 2 | `examples/extensions/guardian.mjs` | pass `rememberLabel` + `preview`; drop the `command: …` prefix |
| 2 | `test/repl-tui.test.ts`, `test/repl-confirm.test.ts`, `test/guardian.test.ts` | picker pins, text-host preview note, `:107` update |

No new dependencies. No persistence or session-format changes. No model-visible
change: `api.confirm` still resolves boolean.

## 10. Test plan (red-first)

Every pin is written before the change and observed red on the pre-change code.

Phase 1:

- RED: with the picker, a frame has one title and no duplicated detail (fails
  today: two of each).
- RED: the affordance line is present while a non-filterable picker is open.
- RED: pressing `2` resolves item index 1; `9` is ignored on a 3-item picker.
- RED: `→ 1. Yes` numbering on the confirm picker.
- RED: digits in a filterable picker narrow the query and no hint row is added.
- RED: refiltering keeps the list last (child order, D5).
- GUARD (green before and after): the no-picker path still writes both notes;
  legacy ask bytes (`test/repl-confirm.test.ts:127`); no-host teaching line
  (`:137`, assertion at `:143-144`); Esc/Ctrl+C cancel; queue-not-decline
  (`test/repl-tui.test.ts:1031`); width wraps (`:742`).

Phase 2:

- RED: `rememberLabel` in the second option; absent → unchanged.
- RED: `preview` renders `● bash  <text>` (literal pin) with its own spans and no
  ✓/✗/elapsed; absent → unchanged.
- RED: unknown `preview.kind` renders nothing and does not throw.
- RED: control bytes in `preview.text`/`preview.tool` are stripped, and a long
  command wraps inside the box width (round-2 N2).
- RED: `detail` + `preview` together render the command exactly once, and a text
  host (`test/repl-confirm.test.ts`; `makeConfirmHost` builds one when
  `args.select === false`, and the Phase 1 guard test at `:82` already exercises
  that shape) prints the preview as one plain note line (round-3 R2, located in
  round 4).
- RED: guardian's bash gate passes a preview and a remember label.
- RED/updated: `test/guardian.test.ts:107` includes `rememberLabel` (currently an
  exact-equality assertion — an intentional trap to catch silent option drift).
- GUARD: the D8 rows.

## 11. Verification

Per phase: the four gates with unmasked exit codes (`npm run lint`,
`npm run typecheck`, `npm test`, `npm run build`), focused files first, then a
manual terminal check by the owner: trigger a guardian gate with a risky command,
answer by digit, confirm the record line reads once and the options are legible.

## 12. Open questions for the reviewer

- Q1 (D4): number every non-filterable picker, or only the confirm? Recommended:
  every picker; fallback is an opt-in flag.
- Q2 (D2): is the hint copy right, and should the range text read `1-3` for the
  confirm while the generic case can exceed it?
- Q3 (D5): one blank row above the items — enough separation, or a rule line?
- Q4 (D1): keep the record line before the decision, or move it after so the
  transcript reads as a completed event?
- Q5 (D6): confirm "dim only, no accent" for this batch.
- Q6 (D7, partly answered in round 1): is `preview.kind = "command"` the right
  first shape, given the future diff preview would need `{path, before, after}`
  and a host-side diff? Additive growth is assumed.
- Q7 (D7): should `rememberLabel` be free text, or a structured hint (e.g.
  `{kind: "command-pattern" | "directory", value: string}`) so the host phrases
  it consistently? Recommended: free text — the host cannot know every policy
  granularity.
- Q8 (D7): is `● <tool>  <text>` acceptable as the preview idiom without the
  real header's width/path logic, or should the preview instead be a **block**
  form (indented command, no marker) to avoid implying the transcript row?

## 13. Review log

**Round 1** (independent adversarial review of `25f3ec4`, based at `0fe1276`) —
verdict **NEEDS REVISION**. Findings and dispositions:

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| 1 | P0 | D1 dropped the detail note unconditionally, but that note is the only detail carrier on readline/no-host/print; it contradicted §5 and D8 | Folded: D1 is now picker-conditional (§6 D1), with a new no-picker guard test (§7 #2, §10) |
| 2 | P1 | Phase 2's "reuse the transcript's bash call row" was unsupported — no standalone renderer exists, and a real call row carries ✓/elapsed | Folded: D7 rewritten — dedicated small renderer, literal pin, explicitly no completion suffix; §8 #2 updated |
| 3 | P1 | The "base drift warning" was already satisfied: `main` had advanced to `06dbfcb` and every `shell.ts` ref was stale | Folded: branch rebased onto `06dbfcb`; all refs re-derived; header rewritten |
| 4 | P2 | A hint row appended after the list breaks `applyFilter` (Container is append-only) | Folded: D5 child-order rule + a refilter-order pin |
| 5 | P2 | D1 mis-listed its test impact (`:76` and `repl-tui:1980` are the session suffix, not detail pins) | Folded: §2 row and D1 corrected; the detail pin is `:67` (round 2 corrected the first attempt, which said `:68`) |
| 6 | P2 | "9 assertion sites" was ten, and `:726` is an ordering assertion, not a marker assertion | Folded: D4 lists ten with `:726`'s distinct fix |
| 7 | P3 | Digit range above 9 unspecified; "visible row" vs item index ambiguity once the list scrolls | Folded: D3 — static item index, digits above the count ignored |
| 8 | P3 | Phase 2 breaks `test/guardian.test.ts:107` (exact-equality options object) | Folded: §8 #3, §10 |
| 9 | P3 | Dim hint must pin the ANSI flag for determinism | Folded: D2, D6 |

Round-1 checks that found nothing needed: the preview/enum degradation table,
the no-host teaching line, and the containment of the marker assertions to one
file.

**Round 2** (independent adversarial review of `7f82410`, base `06dbfcb`) —
verdict **CONFIRMED WITH NOTES**. All nine round-1 dispositions verified in
substance (the D1 predicate is correct — `this.select` is set only by
`bindSelect`, `src/repl/repl.ts:299-301`, called from `runRepl` when the shell
implements `select`; the preview retraction matches the code; every re-derived
reference is exact). Five documentation-level findings, folded:

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| N1 | P2 | The detail pin is `test/repl-confirm.test.ts:67`, not `:68` (`:68` is a comment) | Folded: §2 and D1 corrected |
| N2 | P2 | The preview renderer was under-specified on sanitization and width | Folded: D7 requires `sanitizeDisplay` on both fields (pi-tui `Text` preserves control bytes) and `wrappedRows` for width; §10 gains hostile-input and long-command RED tests |
| N3 | P3 | The sample hint copy contradicted its own computed-range rule (`1-4` vs three items) | Folded: sample reads `1-3`, formula stated |
| N4 | P3 | §7 #4 lacked the non-filterable qualifier | Folded |
| N5 | P3 | A queued TUI confirm shows the title without its detail until the picker opens (`src/repl/shell.ts:836`) | Folded: documented as an accepted transient in D1 |

Round-2 checks that found nothing to change: picker height and the 8-row window
(no test asserts row counts; the new rows are separate children), the filterable
carve-out's consistency across D2/D3/D5/§7, §5 non-goal integrity, and the ten
marker sites' continued validity after the merge.

**Round 3** (closing review of `e7bea80`, base `06dbfcb`) — verdict
**CONFIRMED WITH NOTES**. Every round-2 fold verified in substance (citations
correct, helpers already imported by `shell.ts`, the transient wording steers
implementers correctly). Remaining items, folded:

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| R1 | P3 | One stale `:68` survived in §2 | Folded: `:67` |
| R2 | P2 | The combined `detail` + `preview` case was unspecified — and the only consumer passes both, so a literal reading would print the command twice, the very defect this design removes | Folded: D7 states the division of labour (preview = the request, detail = the explanation, command shown exactly once on every surface), §8 gains a combined-case and a text-host acceptance, §10 gains the matching RED pin |
| R3 | P3 | `preview.warnSpans` → `wrappedRows` span mapping unspecified | Folded: the new exported `renderCommandHeader` owns sanitize + warn styling (`WARN_START`/`WARN_END`) + wrap |
| R4 | P3 | Stale "round 2 pending" in §14; the no-host teaching-line pointer named the test declaration | Folded: §14 rewritten; §10 names the assertion lines |

Round-3 statement on readiness: **Phase 1 may start** (no open finding against
D1-D6). **Phase 2** is buildable as written after the R2 rule above; per §14 the
changed section (D7) gets one short confirmation round before Phase 2 coding.

**Round 4** (scoped confirmation of the round-3 fold, `05df60b`) — verdict **NEEDS
REVISION**: one substantive documentation defect, Phase 2 only.

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| R-1 | P2 | The fold put the text-host "plain preview note" in `src/repl/shell.ts`, which never runs on text hosts, and omitted `src/repl/repl.ts` from Phase 2 — yet `rememberLabel` must land there too, because the option labels are built from `CONFIRM_ITEMS` (`src/repl/repl.ts:234-238`, passed at `:279`) | Folded: §8 file list and the §9 Phase 2 rows now name `src/repl/repl.ts` for both duties; the text-host pin is placed in `test/repl-confirm.test.ts` (the `repl-tui` harness always drives a `TuiShell`) |
| R-2 | P3 | "same alert pair (`WARN_START`/`WARN_END`)" mismatched the actual mechanism: the wrap path consumes `span.style` and appends its own `RESET` (`src/repl/components/tool-block.ts:16-27`); `WARN_END` belongs to `applyWarnSpans` | Folded: D7 restates the mapping as `{start, end, style}` and names where `WARN_END` applies |

**Round 5** (final confirmation of the round-4 fold, `e54e99c`) — verdict
**CONFIRMED**. Both R-1 and R-2 verified against the code; the division of labour
was traced on both host kinds (text host: detail note + preview note, each once;
TUI: detail and preview in the picker, each once); no contradiction remains across
D7/D8/§8/§9/§10. One cosmetic note folded: D1's snippet now mentions that Phase 2
adds the preview note above the detail line.

**Phase 1 implementation notes (post-review, `feat/confirm-prompt-phase1`).** No
contract change: the two discoveries are facts about the existing code, recorded
in §7. (a) `/model` is not a filterable picker, so D4's rule numbers it — the ten
marker sites all changed; the document's earlier assumption in prose that only
nine would change was wrong in the other direction and is corrected in §7.
(b) The worktree needed `npm run build` before the suite: sixteen tests spawn
`bin/imp.js` → `dist/cli.js`, which is gitignored and was absent in a fresh
worktree — not a code defect, but worth knowing for any gate run here.

**Phase 1 implementation check** (independent, fresh context, commit `2b1c15e`) —
verdict **APPROVE WITH CORRECTIONS**, all four items folded on the same branch:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| C1 | P2 | D5's blank row was an empty `Text`, which paints zero rows — the specified separation did not render | Folded: `Spacer(1)` (§7), plus a pin asserting the blank line |
| C2 | P2 | The child-order pin passed even under the exact hazard D5 names (mutation-verified by the checker) | Folded: the pin now requires that no picker chrome follows the refiltered list row |
| C3 | P3 | The "7 failing pins" figure undercounted; the final pin set fails 9 on the pre-change source | Folded: §7 records 9 with the reason for the earlier figure |
| C4 | P3 | §7 #1 "the title exactly once" was ambiguous — the picker shows it too, and only the detail must appear in one region | Folded: §7 #1 now names both regions |

The check also confirmed: the ten marker rewrites are semantically equivalent
(none weakened into vacuity), the four new pins are non-vacuous, the filterable
carve-out holds at both `filterable: true` sites (`src/repl/commands.ts:1112,
1439`), the optional `numberKey` hook cannot steal keys from the login dialog or
tree selector (they install bare `{ teardown }` selectors), and the four gates
reproduce at 127 files / 2466 tests.

**Final review status:** APPROVED — Phase 1 may start immediately; Phase 2 follows
its own implementation cycle.

## 14. Process

- Work happens in the `/Users/z/Z/Agent_demo/imp-confirm-design` worktree. The
  shared checkout at `/Users/z/Z/Agent_demo/imp` belongs to another session;
  that session's branch `feat/task-inline-live-rows` merged into `main` as
  `39d3f66` (+ ledger `06dbfcb`) while this document was in review. This design
  touches none of that work.
- One design (this document) → independent adversarial review (rounds 1-4 done;
  round 1 and 4 NEEDS REVISION, rounds 2-3 CONFIRMED WITH NOTES, all folds
  recorded in §13) → Phase 1 implementation on its own branch → gates →
  implementation check → `--no-ff` merge → ledger entry.
- Phase 2 reuses this document; after the round-4 fold its sections are frozen
  unless something changes, in which case the changed section gets a fresh short
  review round before implementation.
- Each phase merges separately and is independently revertible; neither phase
  touches persisted state, so rollback is a revert, not a migration.
