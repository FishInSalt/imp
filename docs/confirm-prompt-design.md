# Confirm prompt surface (design)

Status: APPROVED — independent adversarial review closed after five rounds
(NEEDS REVISION → CONFIRMED WITH NOTES → CONFIRMED WITH NOTES → NEEDS REVISION →
CONFIRMED); every fold is recorded in §13. **Phase 1 and Phase 2 are both
implemented** (§7 and §8 record the implementation facts, deviations and gate
results); Phase 2 awaits its independent implementation check.

> **Note (2026-10-04).** The guardian v1 example this document cites as its
> call-site source (and `test/guardian.test.ts`) was removed together with
> guardian v1; the shipped gate example is `examples/extensions/guardian.mjs`
> now. Citations below are kept as the historical design record.

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
| Host: `TtyConfirm.handler` writes `renderer.note` lines, then opens the picker | `src/repl/repl.ts:272-300` (title note `:278`, the picker-conditional detail note `:285`, `select` call `:293`) |
| The notes go to the output stream, so they are the only detail carrier on non-TUI hosts | `src/render.ts` `note()`; `test/repl-confirm.test.ts:67` asserts the detail note for the picker host, `:127` the probe of the no-picker path |
| Options are a host constant, identical for every gate | `src/repl/repl.ts:238-244` (`confirmItems`: `Yes` / `Yes, don't ask again this session` / `No`) |
| Picker primitive: `TuiShell.select` — title, dim detail, `warnSpans`, items, optional type-to-filter | `src/repl/shell.ts:829-979`; `SelectOptions` at `src/repl/line-input.ts:31-51` |
| Warn spans: extension supplies plain offsets, host owns color | `src/repl/shell.ts:863`; `src/format.ts:162-192` (`WARN_START = \x1b[0m\x1b[1;31m`) |
| Theme is the identity map — the picker rows carry no color | `src/repl/shell.ts:81-92` (`tuiEditorTheme`) |
| The editor hint row (and notice row) are blanked while a selector owns focus | `src/repl/shell.ts:1201-1212` (`updatePlaceholder`, `blocked` at `:1205`); hide/restore comments at `:972` and `:889` |
| Picker keys: up/down, Enter, Esc/Ctrl+C only — no digits, no letter hotkeys | `node_modules/@earendil-works/pi-tui/dist/components/select-list.js:67` (up), `:84` (cancel); row marker `"→ "` at `:91` |
| The shell's pre-focus listener runs before the focused component sees a key | `tui.js` `inputListeners` ordering; imp's listener carries `filterKey` at `src/repl/shell.ts:927` |
| `Container.addChild` is append-only; the filter path rebuilds the list by remove+append | `node_modules/@earendil-works/pi-tui/dist/tui.js` (`addChild` push); `src/repl/shell.ts:905` (`applyFilter`) |
| `select` is shared: project-trust ask, `/settings`, `/model`, other command pickers | `src/repl/trust-ask.ts:59`; `src/repl/commands.ts:580,628,1109,1271` |
| Session memory is host-side, keyed by `sessionKey` | `src/repl/repl.ts:264` (set), `:274` (short-circuit), `:301` (remember); `ConfirmOptions` at `src/extensions/types.ts:48-59` |
| Note lines are pinned by tests | `test/repl-confirm.test.ts:66` (title), `:67` (detail — the only detail pin), `:76` and `test/repl-tui.test.ts:2139` (the `— allowed for this session` suffix, unaffected by D1) |
| Picker marker is pinned by tests | `test/repl-tui.test.ts:703,726,778,779,1109,1110,1115,1144,1661,1862` — ten sites; `:726` is an ordering assertion, the other nine are marker assertions |
| Legacy asks must stay byte-identical; no-host hosts decline with one teaching line | `test/repl-confirm.test.ts:166`; `src/extensions/registry.ts:93-94` (written at `:356`) |
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
readline `[y/N]`, and the no-host fallback. Its two notes (`repl.ts:275-278`) run
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
- The session-memory suffix line (`— allowed for this session`, `repl.ts:275`)
  is untouched.

Test impact, corrected after round-1 P2 and round-2 N1: the **only** detail-note
pin is `test/repl-confirm.test.ts:67` (`:66` is the title assertion, `:68` is a
comment); `:76` and `test/repl-tui.test.ts:2139` pin the suffix (unaffected).
New guard: a test asserting the detail note **is** written when `select` is
absent.

Known transient (round-2 N5): a TUI confirm *queued* behind another picker
(`src/repl/shell.ts:838`) writes the title note immediately but its detail
only when the picker actually opens — and if the shell closes before that, the
detail is never shown. This is accepted and documented rather than worked
around: today's duplicate-note behavior is the thing being removed, and no
predicate exists to distinguish "queued" from "no picker".

### D2 — affordance line, inside the picker, on non-filterable pickers only

While a picker owns focus the editor hint row is blanked on purpose
(`src/repl/shell.ts:1201-1212`, M10 review P2#5), so the affordance must live
**inside** the picker box, as a dim line under the items. Copy follows the
existing hint style (lowercase, parenthesized, `·` separated —
`src/repl/shell.ts:175-182`):

```
(↑/↓ move · enter select · esc cancel · 1-3 quick pick)
```

The range shown is computed from the item count (§6 D3): today the confirm
carries three items (`src/repl/repl.ts:238-244`), so it reads `1-3`; a picker
with more items widens the range up to `1-9`.

Rules:

- The line is added **only when the picker is not filterable**. A filterable
  picker keeps its `filter:` row and gets no digit range (a digit there is a
  query character, D3).
- The dim call passes the ANSI flag explicitly — `dim(text, true)` — matching
  the detail block at `src/repl/shell.ts:863`; the `dim()` default probes
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
`src/repl/shell.ts:927-957`) runs before the focused component receives a key
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

- nine marker assertions (`:703,778,779,1109,1110,1115,1144,1661,1862`) become
  `<marker> <n>. <label>`;
- `:726` is a **different** kind of assertion — an ordering check
  (`indexOf("why it matched") < indexOf("→ Yes")`) whose needle must change to
  `"→ 1. Yes"`; it does not follow the prefix rule.

The label prefix is presentation only: the row's identity stays the original
index in `SelectItemOption.value` (`src/repl/shell.ts:848-852`), which is what
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
remove+append (`src/repl/shell.ts:905`), so a hint appended after the list
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

**Amendment (A2.3, §16.15, 2026-09-30)**: the owner took that option and then
some — the **provenance name** alone now carries one host accent (yellow,
`\x1b[33m`), on the picker's section rule. Everything else in this document's
color story is unchanged: hint lines, dashes, record notes and chrome remain dim,
and D12's "decision content normal / chrome faint" split still governs weights.

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
  - text hosts (readline, no-host, print): one plain note (its own newlines
    preserved), so the command
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
  sanitizes the same way (`src/repl/components/tool-block.ts:483,486`), and
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
  `applyWarnSpans` path (the detail block, `src/repl/shell.ts:863`) and is **not**
  consumed by the wrap path. Width follows the existing enforcement pattern
  (`test/repl-tui.test.ts:742`).
- Degradation (D8) applies: hosts without a picker ignore both fields.

### D8 — degradation matrix (must not change)

| Host | Behavior with the new fields | Evidence |
|---|---|---|
| TUI picker | renders them (Phase 2) | n/a |
| Legacy readline ask | ignored; `proceed? [y/N]` byte-identical, the detail note still written (D1), and `preview` printed as one plain note line | `test/repl-confirm.test.ts:166`, new guard |
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
  the two `/model` sites (`test/repl-tui.test.ts:1661,1862`). `/model` is **not**
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
   `test/repl-confirm.test.ts:166` still passes unchanged (D1, non-goal §5),
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
- Red-first evidence: 9 pins red at the time of the red run (5 guardian option pins,
  2 confirm pins, 2 preview pins — the byte-pin file did not exist yet);
  reverting all four source files at the FINAL pin set reds **15** tests
  (`test/confirm-preview.test.ts` 6, `test/guardian.test.ts` 5,
  `test/repl-confirm.test.ts` 2, `test/repl-tui.test.ts` 2 — re-verified by the
  implementation check). 219/219 green in the five focused files after.
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
  legacy ask bytes (`test/repl-confirm.test.ts:166`); no-host teaching line
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
  `args.select === false` — the "no-picker host keeps BOTH notes" test already
  exercises that shape) prints the preview as one plain note line (round-3 R2, located in
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
- Q5 (D6): confirm "dim only, no accent" for this batch. *(Answered: yes for
  Phase 1; amended by A2.3 §16.15, which gives the provenance name one host
  accent.)*
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

**Phase 2 implementation check** (independent, fresh context, commit `56f5e21`) —
verdict **APPROVE WITH CORRECTIONS**, all four items folded on the same branch:

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| D1 | P2 | The "9 pins red" figure was taken before the byte-pin file existed; reverting the FINAL pin set reds 15 | Folded: §8 records both numbers and the reason |
| D2 | P3 | D7's citation for the transcript header's own sanitization was stale (`:409,412`) | Folded: `:483,486` |
| D3 | P3 | "one plain note line" overstates the text-host form for a multi-line command | Folded: this document and the `preview` comment now say "one plain note (newlines preserved)" |
| D4 | P3 | No pin guarded the reset discipline — a mutation dropping the trailing reset went unnoticed (0 pins red) | Folded: a pin asserts that an alert span reaching the end is closed, a mid-line span leaves nothing open, and opens equal closes |

The check also confirmed: the contract is additive with exactly one
`CommandPreview` definition; the span arithmetic always satisfies `styled()`'s
sorted/non-overlapping contract (pathological inputs probed); no path renders the
command twice; four mutations were each caught (3+1+1 pins for three of them, the
fourth now pinned); the gates reproduce at 128 files / 2483 tests; and the
`login-dialog` flake observed once did not reproduce in 13 runs.

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

## 15. Amendment A1 — the approval moment (Phase 3)

Base `000d72c` (main after the Phase 1 acceptance ledger). Phases 1-2 are merged
(`e9e0829`, `0d96f3b`) and the owner accepted them by eye on 2026-09-30
(`07f60fb`, merge `000d72c`). The owner then reported four problems with the
approval moment itself. This amendment is host-side except for one consumer
change in `examples/extensions/guardian.mjs`; it adds no extension-facing field.

### 15.1 Problem (owner-observed, with code evidence)

| # | Observation | Where it comes from |
|---|---|---|
| P1 | "I cannot tell which information the guardian extension shows and which is imp's own" | `ExtensionRegistry.confirm` (`src/extensions/registry.ts:350`) forwards `(message, detail, options)` and never passes the caller's name; the blocked result says `blocked by an extension` in **both** block sites (`src/core/loop.ts:462` on the chunk path, `:603` on the serial `executeToolCall` path — guardian's `bash`/`write` are not concurrency-safe, so they take the serial one). Provenance exists today only if the extension writes it into its own text: guardian's two confirm messages carry `[guardian] ` (`examples/extensions/guardian.mjs:225,247`) but its floor block reason (`:94`, returned at `:242`) does not |
| P2 | The gated command appears three times on one screen | (1) the transcript call header (tool_start), (2) the activity region's live tool rows (`src/repl/shell.ts:682-689`), (3) the Phase 2 preview row (`:868`). `tool_start` is emitted before the gate (`src/core/loop.ts:441-458`), so (1) and (2) already exist while the picker waits — and (2) claims `running Ns` although nothing is executing (Phase 1 gates run before any Phase 2 execution) |
| P3 | The transcript and the activity region have no boundary | The root's children are appended back to back with no `Spacer` (`src/repl/shell.ts:339-347`), and the picker box is a plain `Container` whose first child is its title (`:852-882`) |
| P4 | Decision content is rendered faint | `Renderer.note` wraps every `▪` line in `dim` (`src/render.ts:186`, inside the method declared at `:181`); the activity rows are dim (`ToolActivity.render`); so is the picker's detail (`src/repl/shell.ts:863`). Adjacent lines therefore share one weight. The owner tested `printf 'normal\n\x1b[2mfaint\x1b[0m\n'` in their terminal and *can* see faint — so P4 is a design judgement, not a terminal defect |

### 15.2 Decisions

#### D9 — provenance: the host names the caller, the extension stops naming itself

- `ExtensionRegistry.confirm(message, detail?, options?, source?)`
  (`src/extensions/registry.ts:350`). Its only caller is the per-extension api
  closure (`src/extensions/loader.ts:231`); that closure passes `facts.name`
  (`loader.ts:51-52`) — the same string the load banner and the `setStatus`
  bucket already use.
- The fourth parameter threads through **five** declarations, all host-internal:
  `ExtensionRegistryOptions.confirm` (`registry.ts:89`), the registry's private
  field type (`registry.ts:117-118`), `LoadExtensionsOptions.confirm`
  (`loader.ts:36`), `loadExtensionSetup`'s parameter (`cli.ts:491`), and
  `TtyConfirm.handler` (`repl.ts:272`).
- `ConfirmOptions` is **not** touched: the label is host-derived, so an extension
  cannot set or spoof it, and the extension-facing seam is unchanged.
- Record line (`src/repl/repl.ts:278`, and the remembered variant `:274`):
  `▪ confirm: <source> — <message>` when `source` is present, else today's bytes
  exactly.
- Picker title (`src/repl/shell.ts:855`): when a tag is present that row renders
  `title + dim(" · " + sanitizeDisplay(attribution))`. The tag needs a carrier,
  because `title` is a plain string: `SelectOptions`
  (`src/repl/line-input.ts:32-56`, host-internal) gains an optional
  `attribution?: string`, set **only** by the confirm path (`repl.ts:293-294`).
  The name avoids the existing `sourceId` (`line-input.ts:170`) and the observer
  `source` (`repl.ts:1169`), which mean something else. Other `ctx.select`
  callers (`commands.ts:628,1547,1599`, `trust-ask.ts:59`) pass none, so
  unrelated pickers are unaffected. The value is host-derived and
  pattern-validated but still goes through `sanitizeDisplay`.
- Block path: `ToolCallDecision` (`src/core/loop.ts:101`, declared in core by
  design) gains an optional `source?: string`; `emitToolCall`
  (`registry.ts:368`) attaches `source: stored.source` to **every** decision it
  returns — the extension's own `{ block: true }` (`:378`) and its own
  handler-error decision (`:381`) — and both block strings render
  `Tool "<name>" blocked by extension <source>: <reason>`: `loop.ts:462`
  (chunk path) and `loop.ts:603` (serial `executeToolCall` path). Today's
  `an extension` wording remains the fallback when `source` is absent.
  Attaching the source to *handler-returned* decisions is what makes the floor
  reason's prefix removal safe: `guardian.mjs:94` is returned as a block
  decision at `:242`, so it reaches the user only through this string.
- Consumer: guardian drops its `[guardian] ` prefixes (`guardian.mjs:94,225,247`)
  so the name appears exactly once per surface, host-written.
- Accepted: the name appears on two surfaces at once (record line + picker
  title). Both are independently meaningful: text hosts have only the record
  line; the picker title is the live surface. See O2.

#### D10 — no live tool rows while a picker is open

- Rule: while `this.selector !== null` (`src/repl/shell.ts:240`) the activity
  region paints **no tool rows** — the turn-level spinner (`:661-673`) and the
  transcript-side task live rows are untouched.
- Site: `renderActivity()` (`:644`) clears the container (`:645`), has an idle
  branch (`:646-655`, whose transcript-side clearing loop is `:650-651`), and
  builds tool rows at `:682-689` (the `add` helper ends at `:681`). The change
  skips that tool-row loop only while a selector is open.
- Why narrowed: the false rows are exactly the tool rows; the task live rows are
  genuine progress from another subsystem (transcript-side `setTaskLiveRows`),
  and blanking them on unrelated flows would be over-suppression.
- Triggers: suppression must be *pulled*, because `requestRender()` does not
  rebuild the activity container. Route every selector transition through one
  private method (e.g. `setSelector(next)`) that also calls `renderActivity()`:
  the three assignments (`:967` picker, `:1025` login dialog, `:1103` session
  tree) and the three clears (`:888`, `:1011`, `:1073`). The interrupt paths
  (`:489-498`) reach those clears through `teardown()`; `close()` and the
  `pendingSelects` drain must be verified to as well (implementation pin: a
  picker closed by pick / Esc / Ctrl+C / close restores the rows).
- Rationale (evidence): `src/core/loop.ts:441-458` — Phase 1 runs `tool_start →
  validation → gate` serially *before* Phase 2 executes the approved subset, so
  while a gate's picker waits nothing is running; the tool rows on screen are
  waiting rows and the `running Ns` label is false. Nothing is executing then, so
  skipping the tool rows loses no real progress.
- Scope: keyed on `selector`, which also covers the login dialog and the
  session-tree picker (`:1025`, `:1103`) even though they do not go through
  `select()`. With the narrowed rule the only rows those flows could hide are
  tool rows. One reachable case: `/model` is `allowedDuringRun: true`
  (`src/repl/commands.ts:1459`) and opens a real picker, so invoking it mid-run
  hides genuine live tool rows until the picker closes — an accepted consequence
  of keeping one uniform rule (the picker owns the screen and the rows return on
  close).

#### D11 — one blank line between the transcript and a picker

- Add a leading `new Spacer(1)` to each selector surface's box: the generic
  picker (`Container` at `:854-882`, whose first child is currently the title at
  `:855`), the login dialog (`new LoginDialog` at `:997`, added at `:1027`), and
  the session tree (`new TreeSelectorBox` at `:1086`, added at `:1105`).
- Phase 1 D5's "the list stays the last child" invariant is unaffected: a leading
  spacer precedes the title, not the list.
- Use `Spacer`, not an empty `Text` (`:878-880`: an empty `Text` renders zero
  rows).

#### D12 — weight rule: what you decide is normal weight, chrome is faint

- Rule: inside a picker, the lines that carry the decision (title, reason/detail,
  command preview, items) render at normal weight; chrome — the affordance line,
  transcript notes, the ` · <source>` tag, the preview header's faint `●` — stays
  faint.
- Change: `src/repl/shell.ts:863` drops the outer `dim(...)` around the detail.
- Coupling found while designing: `WARN_END` **restores dim**
  (`src/format.ts:163`), so `applyWarnSpans` is only correct inside a dim
  context. Removing the outer dim therefore needs a reset-only end for the detail
  path. Proposal: optional fourth argument
  `applyWarnSpans(text, spans, ansi, restoreDim = true)` — existing callers'
  bytes are unchanged (`test/format.test.ts:81-110`). See O3.
- Deliberate asymmetry: the same reason text stays faint where it is a transcript
  note on a text host (`repl.ts:281`). A note is history; the picker is the live
  decision. See O4.
- `▪` record lines stay faint everywhere, including on the TUI.

### 15.3 Explicitly not doing

| Not doing | Reason |
|---|---|
| Removing the `● tool` header from the preview row | Cosmetic only — the command body still appears twice |
| One copy of the command (moving the alert span onto the transcript call row) | Technically feasible (`ToolBlockFold.updateBlock`, `tool-block.ts:172-176`), but the picker would stop standing on its own: the record row can scroll out of view, and the owner would answer a prompt whose subject is off-screen |
| Replacing global faint with an explicit colour | 74 `dim(` call sites in `src/`; 54 `\x1b[2m` byte pins across 11 test files. That is imp's whole visual language — separate proposal. *(Unchanged: A2.3 §16.15 accents one element, the provenance name, and leaves faint everywhere else.)* |
| Styling the record note on text hosts more loudly (O4) | Out of scope here; recorded as a question |
| Login-dialog / trust-ask visual redesign beyond D11's spacer | Not part of the reported problem |

### 15.4 Files touched (forecast)

`src/extensions/registry.ts` (confirm signature, emitToolCall source),
`src/extensions/loader.ts` (api closure passes `facts.name`),
`src/core/loop.ts` (decision type, both block strings),
`src/repl/repl.ts` (record lines),
`src/repl/shell.ts` (title tag, detail weight, suppression, spacers),
`src/repl/line-input.ts` (`SelectOptions.attribution`),
`src/format.ts` (`applyWarnSpans` optional argument),
`examples/extensions/guardian.mjs` (three prefixes),
plus `test/` and `CHANGELOG.md`.

### 15.5 Test plan (red-first)

1. **D9**: the confirm handler receives the source (registry/repl test); the
   record line carries `guardian —`; `blocked by extension guardian:` replaces
   `blocked by an extension`; the picker title carries ` · guardian`; guardian's
   three strings lose their prefix.
2. **D10**: a TUI frame rendered with the confirm picker open contains no
   `running` text and no tool row; after the answer the rows return.
3. **D11**: an empty row sits between the last transcript row and the picker
   title, for the generic picker, the login dialog and the session tree.
4. **D12**: the detail row carries no `\x1b[2m`; a detail warn span ends with a
   plain reset; `applyWarnSpans`' four-argument form is pinned, three-argument
   bytes unchanged.

Each pin must be verified RED on the pre-change code before the implementation
lands (the Phase 1/2 discipline).

### 15.6 Re-pin inventory (counts at `000d72c`)

`[guardian]` appears 20 times in `test/`, but 18 of those are test-supplied
literals (`confirm.handler("[guardian] …")`, `select({ title: "[guardian] …" })`)
that D9 leaves alone; only two pins exercise the module and must flip:
`test/guardian.test.ts:134` (the confirm message) and `:198` (the block reason).

`blocked by an extension` appears 17 times; **13 break** —
`test/extensions-repl.test.ts` 11 and `test/loop-hooks.test.ts:187-192,216-219`
(both call `beginExtension`, so the registry attaches a source). Four do **not**:
they call a raw `onToolCall` closure with no registry
(`test/loop-hooks.test.ts:136,175,181`, `test/loop-concurrency.test.ts:205`), so
they keep the `an extension` fallback and stay byte-identical.

Confirm-detail pins `test/repl-tui.test.ts` 5 / `test/repl-confirm.test.ts` 6;
`test/repl-tui.test.ts:755-756` supplies its own `detail` and stays internally
consistent; the byte pin D12 invalidates is `test/repl-tui.test.ts:763`
(`expect(raw).toContain("\x1b[0m\x1b[2m")` — "the dim environment resumes after
 the span"), which becomes a plain-reset assertion. Plus every frame pin that includes
the activity rows or the picker's leading rows.

**Decision-object pins (found only when the full suite ran).** Three pins compare
`emitToolCall`'s returned decision *exactly*, so D9's attached `source` breaks
them: `test/extensions-registry.test.ts:217` (`source: "gate"`), `:238`
(`source: "broken_gate"` — the E9 case registers its own extension), and
`test/extensions-loader.test.ts:356` (`source: "asker"`). The string counts above
were the whole inventory at design time; these three were invisible to a
focused-file run.

### 15.7 Degradation matrix (must not change)

Print / no-host: D9 changes the record-line bytes on every host (intended);
D10/D11/D12 are TUI-only. `NO_CONFIRM_LINE` (`registry.ts:94`) and the plain
preview note (`repl.ts:287-290`) are unchanged. The model-facing block reason
changes only by the inserted source name. `--print` output remains ANSI-free.

### 15.8 Acceptance (manual, owner)

The owner approved these frames in conversation: approval screen before/after,
approved, remembered-by-session, declined, text hosts, an ordinary run
(activity rows unchanged), and another picker (blank line). The implementation
check verifies the rendered frames against them; the owner re-verifies by eye
after the merge.

### 15.9 Open questions for the reviewer

| # | Question |
|---|---|
| O1 | D10 keys on `selector`, which also covers the login dialog and the session-tree picker. Round 1 flagged this as over-suppression; D10 was narrowed to tool rows only, so the flows that could lose real information (transcript-side task live rows) are unaffected. The implementation check found the one reachable case — mid-run `/model` (`allowedDuringRun`) hides live tool rows until the picker closes — accepted and documented in D10's scope |
| O2 | D9 puts the name on both the record line and the picker title. Keep both, or one? |
| O3 | D12 needs a reset-only end for detail spans because `WARN_END` restores dim. Variant argument, or delete detail-level `warnSpans` entirely (no extension passes it; it survives only in tests)? |
| O4 | Text-host record notes stay faint. Confirm the asymmetry, or escalate? |
| O5 | Is the fallback wording `blocked by an extension` still right when `source` is absent, or should it be reworded? |
| O6 | After the picker closes, is an explicit `renderActivity()` repaint needed, or does the next spinner tick suffice (the region would be stale for up to 120 ms)? |

### 15.10 Review log (A1)

**Round 1** (independent adversarial review of `30dbcbe`, base `000d72c`) —
verdict **NEEDS REVISION**. Eight findings, all folded:

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| 1 | P0 | D9 named one block string; the literal exists twice — `loop.ts:462` (chunk path) and `:603` (`executeToolCall`, the serial path guardian's `bash`/`write` take), and the citation pointed at `:459` | Folded: §15.1 P1 and D9 name both sites |
| 2 | P1 | The fourth confirm parameter threads through **five** declarations, not one | Folded: D9 lists all five |
| 3 | P1 | The picker title's faint tag had no carrier, and the title is shared by every `ctx.select` caller — leakage risk | Folded: host-internal `SelectOptions.source`, set only by the confirm path; other callers pass nothing |
| 4 | P2 | D10's site text was mis-scoped (`:647-654` is the idle branch; the transcript loop is `:650-651`; tool rows are `:682-689`) | Folded: D10 rewritten with exact ranges |
| 5 | P2 | §15.6 misattributed the D12 breakage: `repl-tui:755-756` is internally consistent; the invalidated byte pin is `:763` | Folded |
| 6 | P2 | Interrupt/close coverage was imprecise; `close()` and the `pendingSelects` drain omitted | Folded: D10 routes all six transitions through one method and pins row restoration on pick/Esc/Ctrl+C/close |
| 7 | P3 | Keying on `selector` over-suppresses the login dialog and `/tree`, where the false-`running` rationale does not apply | Folded: D10 narrowed to tool rows only — task live rows and the turn spinner are untouched |
| 8 | P3 | Miscites: `render.ts:181` is the `note` declaration (`dim` is `:186`); `guardian.mjs:94` is a block reason returned at `:242`, so its prefix can only be dropped if handler-returned decisions carry the source | Folded: citations corrected; D9 states handler-returned decisions carry `source` |

Round-1 checks that found nothing to change: `confirm`'s single caller and
`facts.name`; `stored.source` on handlers; `WARN_END` restoring dim;
`tool_start` preceding the gate; the counts in §15.6; the selector set/clear
sites; the picker box's first child being the title; the leading-spacer vs D5
invariant; `NO_CONFIRM_LINE` and the plain preview note.

**Round 2** (independent adversarial review of `9a57cfa`, same base) — verdict
**CONFIRMED WITH NOTES**. All eight round-1 dispositions verified in the body of
§15, and every new reference re-derived exactly. Five documentation-level
findings, folded:

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| N1 | P2 | §15.6 counted all 17 `blocked by an extension` sites as re-pins; four call a raw `onToolCall` closure (no registry, so no source) and keep the fallback | Folded: 13 break / 4 do not, with sites |
| N2 | P2 | §15.6 gave no attribution for the 20 `[guardian]` hits — 18 are test-supplied literals that survive | Folded: the two genuine pins named |
| N3 | P3 | D11's "added at" lines were off by one (`:1028`/`:1106` are `setFocus` calls) | Folded: `:1027`/`:1105` |
| N4 | P3 | D9 cited `SelectOptions` as `:32-45` (it runs to `:56`) and left the tag's render site implicit | Folded: range corrected; the render expression written out |
| N5 | P3 | `SelectOptions.source` collided in reading with `sourceId` and the observer `source` | Folded: renamed `attribution` |

Round-2 checks that found nothing to change: both block strings; the five
declarations; handler-returned decisions carrying the source; D10's ranges and
the narrowed rule; that one `setSelector` covers every path (including `close()`
and the `pendingSelects` drain, which re-enters `closed`-guarded entries);
D11's three boxes and the D5 invariant; D12's mechanism; and the absence of new
contradictions with §6-§12.

### 15.12 Implementation check (A1)

Independent adversarial check of `9ae65d0` (fresh context, mutation testing):
verdict **APPROVE WITH CORRECTIONS** — every decision implemented as specified,
four gates green, twelve mutations probed of which five survived. All five plus
the CHANGELOG gap are folded:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | P3 | No pin covered the **chunk-path** block string: reverting `loop.ts:475` to `an extension` left the suite green | Folded: `test/loop-concurrency.test.ts:228` drives a `concurrencySafe` tool through a registry-backed gate; mutation RED |
| F2 | P3 | `setSelector`'s repaint was unpinned — deleting it survived because tests settle past the 120 ms ticker that masks it | Folded: `test/repl-tui.test.ts:4502` asserts no tool row inside the ticker window; mutation RED |
| F3 | P3 | `sanitizeDisplay(attribution)` was unpinned | Folded: `test/repl-tui.test.ts:807` feeds a hostile attribution; mutation RED |
| F4 | P3 | The empty-source guards in `blockSource` and the record label were unpinned | Folded: `test/loop-concurrency.test.ts:250` and `test/repl-confirm.test.ts:53`; both mutations RED |
| F5 | P3 | D10's scope text claimed the login/tree flows run when the turn is idle; `/model` is `allowedDuringRun` and opens a real picker mid-run | Folded: D10's scope rewritten with the reachable case; O1 updated |
| F6 | P3 | `CHANGELOG.md` was not updated although §15.4 forecasts it | Folded: the Phase 3 entry |

Survived-mutation count after the fold: 0. Suite 128 files / 2507 tests.

### 15.13 Process

Branch `feat/confirm-prompt-phase3` from `000d72c` in the confirm worktree; this
amendment goes through an independent adversarial review before implementation;
implementation is red-first; an independent implementation check follows; then
`--no-ff` merge plus a ledger entry. Phases 1-2 remain untouched and revertible.

Implementation was split into two waves (D9; then D10-D12). Wave 1 was verified
with the focused test files only and missed three decision-object pins that the
full suite caught; from Wave 2 on, every wave runs the whole suite (`vitest run`)
before it is called done.

An independent implementation check followed (`§15.12`); its pin gaps were folded
with mutation-verified pins before the merge.

## 16. Amendment A2 — the picker's own rule (Phase 4)

Base `f417fba` (main after the Phase 3 acceptance ledger). Phase 3 merged as
`eb6e064` and the owner accepted it by eye on 2026-09-30 (`2e5a55e`, merge
`f417fba`). The owner then asked for two adjustments; both are owner-approved
with the leanings below.

### 16.1 Problem

| # | Observation | Evidence |
|---|---|---|
| P5 | The picker title's ` · guardian` tag is redundant — the record line above already names the caller | owner, 2026-09-30; the tag renders at `src/repl/shell.ts:881-889` |
| P6 | The transcript and the picker are separated only by a blank row; the owner asked for a horizontal rule, ideally naming the extension | owner, 2026-09-30 |

### 16.2 Decisions

#### D13 — the picker title is the extension's words, nothing appended

- `src/repl/shell.ts:881-889`: the title renders as `options.title` again; the
  ` · <attribution>` tag is removed (bytes exactly as before Phase 3 D9).
- `SelectOptions.attribution` (`src/repl/line-input.ts:41`) stays — the value now
  feeds D14's rule label, and `sanitizeDisplay` moves with it.
- Text hosts are unaffected: they have no title surface, and the transcript
  record line keeps `▪ confirm: guardian — …` (owner decision: the name stays
  there, because that line is the only provenance carrier on readline/no-host/
  print, and it is the transcript's history).

#### D14 — a labeled rule opens every picker (host-drawn, host-labeled)

- The label is the **host-held** attribution from D9, never extension-authored:
  the same value the record line uses. An extension therefore cannot write a
  *different* name into the divider, and no extension-facing API changes.
- New shared component `src/repl/components/section-rule.ts`:
  `export class SectionRule implements Component`, constructed with an optional
  label. It follows the same rendering shape as the private `DialogBorder`
  (`src/repl/login-dialog.ts:40-46`, "pi's DynamicBorder") without folding it in
  (O8).
- Render contract (`render(width)`), and `implements Component` requires
  `invalidate(): void` as well (empty — the rule caches nothing, exactly like
  `DialogBorder`, `src/repl/login-dialog.ts:41`):
  - `const LEAD_DASHES = 4` (A2.2; it was two dashes written inline) and
    `avail = width - LEAD_DASHES - 2`;
  - absent/empty label, or `avail < 2` → `dim("─".repeat(width))` (below that the
    clipped label would be a bare ellipsis, which names nobody);
  - otherwise the label is `sanitizeDisplay`-ed, clipped with
    `truncateToWidth(label, avail)`, and the row is
    `dim("─"×LEAD_DASHES) + " " + label + " " + (right > 0 ? dim("─"×right) : "")`
    with `right = avail - labelWidth` — the label sits left, `LEAD_DASHES + 2`
    columns in, where the eye lands first (owner decisions: left-anchored, then
    nudged right; §16.13/§16.14), and `visibleWidth(row) === width` exactly
    (`right === 0` ends the row after the label's trailing space);
  - dashes faint, label in the host accent (yellow; A2.3 §16.15 — before that,
    normal weight; the accent is the weight signal's replacement, not an
    addition, so D12's split still reads).
- Placement (base `f417fba`): the generic picker box gets the rule **between** its
  leading `Spacer(1)` (`src/repl/shell.ts:879`) and its title (`:880`); the
  session tree gets it inside `boxWrapper` between `:1148` and `:1149`. Both are
  **unconditional**, like D11's blank row: every shell-constructed picker box
  gets the rule, attributed or not (unattributed → plain dashes). Ordinary
  `ctx.select` pickers therefore change bytes too, including titleless ones
  (`test/repl-tui.test.ts:823`); that uniformity is intended, not a confirm-only
  decoration.
- **Not** placed above the login dialog: it already renders `DialogBorder` above
  and below its content (`src/repl/login-dialog.ts:73,97`), so a third rule would
  be decoration. Its D11 blank row stays.
- Layout (owner-approved): record note → blank row → rule → title.
- Phase 1 D5's "list stays the last child" invariant is untouched (the rule
  precedes the title, not the list).

### 16.3 Not doing

- Nothing else from §15 changes: the record line keeps the name, the blank row
  stays, the preview and its alert span stay.
- Not making the rule extension-authored, configurable, or themeable (no API
  change); not retrofitting the login dialog's borders.

### 16.4 Files touched (forecast)

`src/repl/components/section-rule.ts` (new), `src/repl/shell.ts` (title block and
the two box sites), `src/repl/line-input.ts` (the `attribution` doc comment only —
it currently promises a tag after the title, which D13 removes),
`test/repl-tui.test.ts`, `test/repl-confirm.test.ts` (a comment at `:50`), and
`CHANGELOG.md`. `src/repl/repl.ts` is unchanged.

### 16.5 Test plan (red-first; each pin mutation-verified)

1. **D13**: a picker with an attribution renders the bare title (no ` · `, no
   stray space), and the frame's rule carries the label.
2. **D14 order**: with an attribution the generic picker's rows are
   blank → rule → title, in that order; the session tree gets an unlabeled rule
   above its first row; the login dialog gains no host rule (it still shows
   exactly its own two).
3. **D14 bytes**: the labeled rule's exact shape (dim dashes, plain label, dim
   dashes, every run closed); a hostile attribution (`\x1b[31m`) reaching the
   label is sanitized — this replaces the Phase 3 title-tag sanitation pin
   (`test/repl-tui.test.ts:800-810`).
4. **D14 edges**: `width < 5` → plain rule; empty label → plain rule; an
   over-wide label is clipped and `visibleWidth(row) <= width` always holds.

Each pin must be RED against the pre-change code, and the shared-behaviour pins
are additionally proven by reverting the implementation and re-running (the
Phase 3 rule: a pin that survives its own mutation is not a pin).

### 16.6 Re-pin inventory (counts at `f417fba`)

- `test/repl-tui.test.ts:771-798` (the title tag) becomes the rule-label pin.
- `:800-810` must be **rewritten**, not re-pointed: it asserts the visible text
  `· badname` (`:813`), and the rule label carries no `·` separator.
- **Two D11 pins break and §16.2's layout supersedes them**:
  `test/repl-tui.test.ts:4574` and `:4618` assert that the row above the title is
  blank; after D14 that row is the rule, so each must assert blank → rule →
  title.
- `:823` (a titleless, unattributed picker) gains an unlabeled rule row.
- The A2.1 re-anchor (§16.13) changes only the expected bytes of the exact-bytes
  rows above; the pin set is unchanged.
- `test/repl-confirm.test.ts:51,64` assert that `attribution` reaches `select()`
  — unchanged by D13/D14; the comment at `:50` (it describes the title tag) needs
  rewriting.

### 16.7 Degradation matrix (must not change)

Text hosts (readline, no-host, print/`--print`) never construct TUI components,
so D13/D14 are TUI-only; the record line keeps `guardian — ` on every host; the
no-picker teaching line and the plain preview note are untouched; `--print`
output stays ANSI-free.

### 16.8 Acceptance (manual, owner)

Expected frame (approved in conversation): record note → blank row → labeled rule
→ bare title → reason (normal weight) → red-spanned preview → blank row → items →
affordance. A `/resume` (or `/tree`) picker shows an **unlabeled** rule; the
login dialog shows no host-added rule.

### 16.9 Open questions for the reviewer

| # | Question |
|---|---|
| O7 | **Answered in round 1 — no overflow**: for widths 1-200 and label widths up to 500 (ASCII and wide characters) `visibleWidth(row) === width` held for the centred form. **Re-resolved by the owner (2026-09-30, round 3): the label is now left-anchored** — two dashes, then `label`, then the remainder — because a centred label is harder to spot. The identity holds by construction for any lead-in:
`LEAD_DASHES + 2 + labelWidth + right = width` with
`right = avail - labelWidth >= 0` (A2.2 sets `LEAD_DASHES = 4`, §16.14) |
| O8 | **Resolved: leave `DialogBorder` private.** The login dialog's rows are its own frame (top and bottom), not a section boundary; folding them into `SectionRule` would change their bytes for no user-visible gain. Revisit only if a third rule site appears |
| O9 | **Resolved: the label carries the host accent.** It names who asks (information); the dashes are chrome — the same split D12 already draws inside the picker. Initially "normal weight"; A2.3 (§16.15) replaced the weight signal with yellow |
| O10 | **Resolved: keep both.** The owner approved the airier layout (blank row, then rule); the rule carries the name the blank row cannot |

### 16.10 Review log (A2)

**Round 1** (independent adversarial review of `706d0bc`, base `f417fba`) —
verdict **NEEDS REVISION**. The reviewer disproved the overflow risk (O7 answered)
and found seven documentation/test-plan gaps, all folded:

| # | Sev | Finding | Disposition here |
|---|---|---|---|
| 1 | P1 | §16.6 missed two D11 pins that D14 breaks (`test/repl-tui.test.ts:4574`, `:4618` assert the row above the title is blank; it becomes the rule) | Folded: both listed with the new expectation |
| 2 | P2 | §16.4 called `line-input.ts` unchanged, but its doc comment promises the tag D13 removes | Folded: listed as touched (comment only) |
| 3 | P2 | The rule is added unconditionally, so unattributed and titleless pickers gain a row — the doc framed it as confirm-specific | Folded: D14 states the global uniformity and names `:823` |
| 4 | P2 | The hostile-attribution pin asserts `· badname`; the rule label has no `·`, so it must be rewritten rather than re-pointed | Folded: §16.6 says rewritten, with the reason |
| 5 | P3 | §16.6 mischaracterised `repl-confirm.test.ts:50` (a comment, not an assertion) | Folded: `:51,64` are the assertions; `:50` needs a comment rewrite |
| 6 | P3 | `Component` also requires `invalidate()`, absent from the render contract | Folded: added to D14 |
| 7 | P3 | On narrow terminals the clipped label would render as `─ … ─` | Folded: fallback threshold is now `avail < 2` → plain dashes |

**Round 2** (independent adversarial review of `c7ab53e`, same base) — verdict
**CONFIRMED**. All seven round-1 findings verified in the body of §16, the render
contract re-derived exact for widths 1-12 with labels of 1 to 500 characters
(ASCII and CJK), the D11 pin scan complete (`test/repl-tui.test.ts:4574`, `:4618`
break; `:857-858` sit below the list and are unaffected; `repl-confirm.test.ts`
has no frame pins). One P3 wording note — D14 said `SectionRule` "generalises"
`DialogBorder` while O8 keeps it private — folded by rewording to "follows the
same rendering shape … without folding it in".

Round-1 checks that found nothing to change: every line ref at `f417fba`; the
D5 child-order invariant and the `applyFilter` refilter pin; the queued-select
FIFO; the tree box's structure (no attribution exists on `TreeSelectRequest`, so
an unlabeled rule is the only consistent option); the login dialog's two
borders; resize; text-host degradation and `--print` bytes; and the
`sanitizeDisplay` import staying live in `shell.ts`.

### 16.11 Process

Branch `feat/confirm-prompt-phase4` from `f417fba`; this amendment passes an
independent adversarial review before implementation; implementation is
red-first with mutation-verified pins; an independent implementation check
follows; then `--no-ff` merge plus a ledger entry. Phase 3 stays revertible.
Each amendment round (A2.1) gets the same treatment at its own scale.

### 16.12 Implementation check (A2)

Independent adversarial check of the working tree (fresh context, mutation
testing): verdict **APPROVE WITH CORRECTIONS** — the render contract, the wiring
and the byte pins verified, six mutations probed, one survived.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| G1 | P2 | The `avail < 2` threshold was unpinned in both directions: mutating it to `< 3` or `< 1` left the whole suite green | Folded: `test/repl-tui.test.ts` pins the exact rows at width 5 (plain dashes) and width 6 (labelled, `avail = 2`); both mutations now RED |
| G2 | P3 | The width-identity pin never exercised a labelled wide-character label at a narrow width | Folded: a CJK label added to the loop |

The check also ran three adversarial mutations of its own beyond the plan
(restoring the Phase 3 title tag; placing the rule before the spacer; adding
a rule to the login dialog) — all three were caught by existing pins.

### 16.13 Round 3 — the label moves left (A2.1, owner, 2026-09-30)

After the merge the owner looked at the centred form and asked for the label to
sit left ("a centred label is harder to spot"). D13/D14 are otherwise unchanged.

- Contract delta (D14, second bullet): the row is
  `dim("──") + " " + label + " " + (right > 0 ? dim("─"×right) : "")` with
  `right = width - 4 - labelWidth`; the fallback threshold is unchanged at
  `width < 6`. `visibleWidth(row) === width` still holds by construction.
  (A2.2 supersedes the lead-in and the threshold: the `4` in `width - 4` here is
  `LEAD_DASHES + 2`, now 6 — see §16.14.)
- Pin delta (round-3 note N1): the two exact-bytes rows in
  `test/repl-tui.test.ts` — the width-20 `tui` row (`:4685-4687`) and the
  width-6 clipped row (`:4711-4713`) — become the left-anchored shape, and the
  clipped width-20 row (`:4689-4695`) changes too. Row shapes from the contract:
  width 20 `tui` → `dim("──") + " tui " + dim(13 dashes)`; width 20 with a
  clipped 16-wide label and width 6 with a clipped 2-wide label both have
  `right === 0`, so those rows **end after the label's trailing space, with no
  closing dashes**. The width-5 plain row and the `visibleWidth(row) === width`
  loop are unchanged (round-3 note N2: the pin *set* is unchanged, so §16.6's
  inventory still holds; only the expected bytes move).
- Review: round 3 (below) covered the delta before implementation; the bounded
  implementation check returned **APPROVE** — the contract expression matched the
  implementation byte-for-byte, and seven mutations were all caught (`──`→`─` and
  `──`→`───`, `right` off by one in both directions, the `right > 0` guard removed,
  and the threshold flipped to `< 5`/`< 7`); nothing survived the focused file. The
  one doc nit it raised (D14's fallback rationale still described `─ … ─`) is
  folded.

### 16.14 Round 4 — the lead-in widens (A2.2, owner, 2026-09-30)

After the A2.1 merge the owner asked for the label "a little more to the right".
The lead-in becomes a named constant inside `SectionRule` so future nudges are
one number:

- `const LEAD_DASHES = 4` (was two dashes, written inline).
- `avail = width - LEAD_DASHES - 2`; the row is
  `dim("─"×LEAD_DASHES) + " " + label + " " + (right > 0 ? dim("─"×right) : "")`
  with `right = width - LEAD_DASHES - 2 - labelWidth`, so the label starts at
  column `LEAD_DASHES + 2` (6 with the new value) and the row still fills the
  width exactly.
- Plain-dash fallback when the label is absent/empty or `avail < 2` — the same
  semantics as before (below that, a clipped label is a bare ellipsis), which
  moves the threshold from `width < 6` to `width < 8` at `LEAD_DASHES = 4`.
- Pin delta: the width-20 rows (`test/repl-tui.test.ts:4682-4687`,
  `:4689-4695`) become `──── tui ` + 11 dashes and `──── <clipped 14> ` (right
  0); the **threshold test** (`:4708-4715`) must be retitled and re-bodied —
  width 7 plain, width 8 labelled (clipped to 2); the width-80 frame row
  (`:809-812`) becomes `──── guardian ` + 66 dashes; the `avail < 2 (width < 5)`
  test (`:4703-4706`) keeps its assertions and loses its stale name.
- Review: round 4 returned **NEEDS REVISION** — the normative D14 bullet, O7 and
  §16.13 still carried the LEAD=2 literals, and this section's pin delta did not
  name the threshold test that actually breaks. All four folded (D14 now states
  the parameterised contract; O7 states the general identity; §16.13 forward-points
  here; the pin delta names `:4703-4706` and `:4708-4715`).

### 16.15 Round 5 — the name gets the host accent (A2.3, owner, 2026-09-30)

The owner asked whether the extension's name could carry a color and chose
yellow to try first. Color is host-owned (D6 forbids extension-authored ANSI),
so the host colors the name it already holds; no extension API changes.

- **D6 amendment**: "dim only, no accent" becomes "dim for chrome; the
  **provenance name** carries the host's single accent". One accent for every
  extension — per-extension colors would clash and would put color in the
  extension's hands; a future extension uses the same yellow.
- **Accent**: `\x1b[33m`, via a new `yellow(text, ansi = process.stdout.isTTY
  === true)` helper in `src/format.ts`, matching `dim`/`red`/`green`/`bold`.
  `SectionRule` calls it with `true` explicitly, exactly as it already does for
  `dim(..., true)` (`section-rule.ts:42,49`) — the component renders only inside
  the TUI, and the explicit flag is what keeps the byte pins deterministic under
  vitest (whose stdout is not a TTY).
- **Scope A (owner's choice)**: only the `SectionRule` label — `────` stays dim,
  the label is yellow, everything else (record line, picker title, preview)
  keeps today's treatment. Extending the accent to the record line's
  `guardian — ` tag is a follow-up if the owner asks (it needs the renderer's
  `ansi` gate, not the TUI's unconditional styling).
- **Widths**: escape sequences are zero-width, so `visibleWidth(row) === width`
  and the clip/lead arithmetic are unchanged; `truncateToWidth` runs on the
  sanitized **plain** label before the color is applied.
- **Empty label**: still plain dim dashes — no name, no accent.
- **Degradation**: `SectionRule` is constructed only by the TUI shell, so
  print/legacy/no-host output gains nothing (and stays ANSI-free).
- **Pin delta** (review round 5, N4/N5): the exact-byte rows gain
  `\x1b[33m` … `\x1b[0m` around the label — the width-20 `tui` row
  (`:4682-4687`), the width-20 clipped row (`:4689-4695`), the threshold test's
  width-8 row (`:4708-4715`), and the width-80 frame row (`:809-812`, whose
  "faint dashes around a normal-weight label" assertion becomes "dim dashes
  around a yellow label"). The **hostile-label pin** (`:816-830`) must be
  rewritten to the exact shape `──── <\x1b[33mbadname\x1b[0m> ────` (the accent
  wraps the sanitized plain text) while still proving `\x1b[31m`/`\x1b[1m` are
  gone. **Unchanged**: the `avail < 2` fallback (`:4703-4706`, plain dashes,
  no label, no accent) and the width-identity loop (`:4718-4725`, escapes are
  zero-width).
- Review: round 5 returned **NEEDS REVISION** — D6 itself (and Q5, the
  global-faint row) still read as a flat prohibition, D14/O9's "normal weight"
  needed forward pointers, the `yellow()` call-site flag and the pin delta needed
  precision. All five folded.

Implementation facts (two corrections the pins surfaced): the frame extracted by
`terminal.frameSince` is ANSI-stripped, so the *plain-text* row assertions are
unchanged and only the **raw** ones (`render()` return values and
`terminal.writes`) gain the accent; and the clipped-label row carries the accent
reset immediately after the clipped label's own reset, so its expected bytes end
`…\x1b[0m\x1b[0m ` (doubled reset) before the trailing space. Red-first: 5 pins
red, then green; mutations "drop the accent" (6 pins) and "33 → 35" (6 pins) both
caught.

## Amendment — the fresh confirm (#guardian-auto-mode D13/D16, 2026-09-30)

The M10 contract above renders three options for every gate for callers that
pass a `sessionKey`; that stays byte-for-byte. #guardian-auto-mode then required
*fresh* fallbacks — auto/shadow confirmations deliberately pass **no**
`sessionKey` so a remembered approval can never bypass the classifier — and the
constant three-option picker kept offering "Yes, don't ask again this session",
which remembered nothing. An option that promises memory it cannot keep is a
lie the user pays for twice (they grant it, and are asked again). The host now
omits the remember entry when no `sessionKey` is present:

| Caller | Items |
|---|---|
| `sessionKey` present (every pre-existing gate, manual's guardian paths) | `Yes` / `Yes, don't ask again this session (…label)` / `No` — unchanged |
| no `sessionKey` (auto/shadow fallbacks; any extension confirming without memory) | `Yes` / `No` — index 1 declines |

Pinned in `test/repl-confirm.test.ts` ("a fresh confirm has no remember option
— and No is index 1"). The "options are a host constant" fact in §2 above is
history at `06dbfcb`, kept as-is.
