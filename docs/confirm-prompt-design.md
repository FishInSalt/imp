# Confirm prompt surface (design)

Status: DRAFT — awaiting independent adversarial review (AGENTS.md: a batch with
a design document does not start implementation until the document passes review).

Workspace: `/Users/z/Z/Agent_demo/imp-confirm-design` (a dedicated git worktree, so
this design does not disturb the shared checkout; node_modules is symlinked to
the main checkout for the test runs cited below).
Branch: `docs/confirm-prompt-design`, based at `main` = `0fe1276`.

Line references below are verified against `0fe1276`, not from memory.
**Base drift warning:** another session's unfinished branch
`feat/task-inline-live-rows` (`546a61b`, 8 commits ahead of `main`) touches
`src/repl/shell.ts`, `src/repl/components/tool-block.ts`, `src/repl/transcript.ts`
and `test/repl-tui.test.ts`. If that branch lands before this design is
implemented, every line reference here must be re-derived on the new base.
(Checked while writing this document: on `546a61b` the same constructs sit
~42 lines lower in `shell.ts` — e.g. `updatePlaceholder` at `:1152` vs
`:1110` on `main`.)

Scope: the interactive approval prompt (`api.confirm`) as rendered by the TUI
shell — its record policy, layout, keys, and the two additive extension-facing
options planned in Phase 2. One document covers both phases on purpose (§6 D0):
the seam shapes and the layout constrain each other, and imp's own precedent for
phased work is one document with per-phase acceptance criteria
(`docs/m4-extensions-design.md` §15) plus amendment sections when a later phase
changes the contract (`docs/tui-tool-elapsed-design.md` Review log).

## 1. Problem

Owner feedback (2026-09-29): the guardian extension's approval UI is not good
looking; compare with Claude Code's permission approval rendering
(`/Users/z/Z/claude-code-sourcemap/restored-src/src/components/permissions/`) and
judge whether imp's has room to improve.

Measured on the current build — real frames, captured at `0fe1276` by driving the
production render path (`TtyConfirm` → `TuiShell.select`) in a scratch harness;
the scratch file was deleted afterwards and the worktree is clean. (An earlier
capture on the `546a61b` base produced an identical frame — that batch does not
touch the confirm path.)

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
   transcript notes written by the host, once as the picker's own title/detail.
2. **No affordance.** The picker offers no key hints, and the editor hint row is
   deliberately blanked while a picker owns focus, so nothing on screen says how
   to answer.
3. **Opaque memory.** "Yes, don't ask again this session" does not say *what* is
   being remembered — `guardian:bash:<pattern>` (this command shape) and
   `guardian:write:<cwd>` (this directory) are very different grants.
4. **Prose-wrapped risk.** The gated command is dim prose wrapped mid-phrase,
   instead of the form the transcript already uses for the same call.

## 2. History (verified, not from memory)

| Fact | Evidence (verified at `0fe1276`) |
|---|---|
| Entry point: extensions call `api.confirm(message, detail, options)` | `src/extensions/types.ts:105`; guardian call sites `examples/extensions/guardian.mjs:228` (bash gate) and `:243` (write gate) |
| Host: `TtyConfirm.handler` writes two `renderer.note` lines, then opens the picker | `src/repl/repl.ts:265-283` (notes at `:268` and `:271`, `select` call at `:275-280`) |
| Options are a host constant, identical for every gate | `src/repl/repl.ts:234-238` (`Yes` / `Yes, don't ask again this session` / `No`) |
| Picker primitive: `TuiShell.select` — title, dim detail, `warnSpans`, items, optional type-to-filter | `src/repl/shell.ts:771-890`; `SelectOptions` at `src/repl/line-input.ts:31-51` |
| Warn spans: extension supplies plain offsets, host owns color | `src/repl/shell.ts:799-801`; `src/format.ts:162-190` (`WARN_START = \x1b[0m\x1b[1;31m`) |
| Theme is the identity map — the picker rows carry no color | `src/repl/shell.ts:80-91` (`tuiEditorTheme`, "the pre-M9 plain aesthetic") |
| The editor hint row (and notice row) are blanked while a selector owns focus | `src/repl/shell.ts:1110-1121` (`updatePlaceholder`; `blocked` at `:1114`); hide/restore comments at `:884` and `:814` |
| Picker keys: up/down, Enter, Esc/Ctrl+C only — no digits, no letter hotkeys | `node_modules/@earendil-works/pi-tui/dist/components/select-list.js:67` (up), `:84` (cancel); row marker `"→ "` at `:91` |
| `select` is shared: project-trust ask, `/settings`, `/model`, other command pickers | `src/repl/trust-ask.ts:59`; `src/repl/commands.ts:580,628,1109,1271` |
| Session memory is host-side, keyed by `sessionKey` | `src/repl/repl.ts:257` (set), `:267` (short-circuit), `:282` (remember); `ConfirmOptions` at `src/extensions/types.ts:48-59` |
| Note lines are pinned by tests | `test/repl-confirm.test.ts:66,76`; `test/repl-tui.test.ts:1980` |
| Picker marker is pinned by tests | `test/repl-tui.test.ts:703,726,778,779,968,969,974,1003,1520,1721` (same 9 assertion sites; `:726` orders the detail before the first row) |
| Legacy asks must stay byte-identical; no-host hosts decline with one teaching line | `test/repl-confirm.test.ts:113`; `src/extensions/registry.ts:93-94` (written at `:356`) |

Guardian's own gates for reference: `examples/extensions/guardian.mjs` —
hard floor (never asks), bash rules + `rmForceRecursive`, write/edit outside the
caller's cwd; per-rule `sessionKey`; declines return `{block, reason}` whose
reason text goes to the model.

## 3. External reference (what pi and Claude Code do)

- **pi's host hands extensions a UI toolkit.** `pi.dev/docs/latest/extensions`:
  `ctx.ui` provides dialogs, notifications, status text, widgets, titles, editor
  access, and `ctx.ui.custom()` for full TUI components with their own input
  handling; the host keeps the lifecycle, execution-mode gates (RPC can forward
  built-in dialogs but not custom components), and the fail-safe block when a
  `tool_call` handler throws.
  (Context for the reader: imp's own `TuiShell` is built on
  `@earendil-works/pi-tui` — the same component library layer — but imp keeps
  the components to itself, `docs/m4-extensions-design.md` §16.)
- **The community permission package composes its own prompt.**
  `pi.dev/packages/@gotgenes/pi-permission-system`: policy, matching, session
  approvals, subagent forwarding are the extension's; the inline dialog (keys
  `y`/`s`/`n`/`r`, remappable, double-press to confirm, one fact per line, a row
  budget, `Ctrl+O` to expand) is built by the package. It states that
  approve-and-steer, edit diffs, and risk explanations belong to *downstream
  packages* over its decision event and presentation seams. Its docs also note
  the reason letter hotkeys are remappable: an input method editor swallows
  letter keys during composition, while digits are unaffected.
- **Claude Code ships per-tool approval dialogs in the host**
  (`src/components/permissions/PermissionRequest.tsx` dispatches per tool):
  a top-border-only `PermissionDialog`, bold title, numeric options
  (`1. Yes` / `2. Yes, and don't ask again for <cmd> in <cwd>` / `3. No, and
  tell Claude what to do differently (esc)`), `Tab` to turn the focused option
  into an inline feedback input, a dim `Esc to cancel · Tab to amend` footer,
  and diffs rendered by `StructuredDiff`.
- **imp refuses the toolkit route by design.** `docs/m4-extensions-design.md`
  §1/§16 list "any UI contribution (renderers, autocomplete, dialogs)" as a
  non-goal; §6.2 records the deliberate refusal of pi's per-call `ctx`. What imp
  ships instead is *declarative data*: `warnSpans` offsets, `sessionKey`,
  `api.setStatus`, and `ToolPresentationHooks` semantic presentations
  (`src/core/tools/types.ts:54-57`).

Consequence for this design: imp's seam must stay declarative. **Phase 2 adds
data fields the host renders; it does not hand extensions a renderer.**

## 4. Goal

Deliver the owner-visible fix in two merges, with one design:

- **Phase 1 (host-only, no extension API change).** Remove the duplication, put
  a key affordance on screen, make the options answerable by number, number the
  rows, and give the block explicit sectioning.
- **Phase 2 (seam + consumer).** Add two additive `ConfirmOptions` fields —
  a memory-scope label and a command preview — and have guardian pass both, so
  the seam ships with its real consumer (imp's rule: no API without a consumer,
  `docs/m4-extensions-design.md` §16).

## 5. Non-goals (explicit)

- No extension-supplied rendering, components, or host-module imports. No
  `ui.custom` equivalent; that would be an architecture change (loader aliasing,
  trust model, mode gates) and needs its own document.
- No extension-to-extension event bus, and no downstream risk-explainer package.
  Separate design.
- No free-text "tell imp what to do instead" feedback return (Claude Code's
  `Tab`), because it changes `api.confirm`'s return type; it needs its own
  contract decision.
- No diff preview inside the confirm. It needs a before/after contract that
  Phase 2 does not have (the extension holds arguments, not file contents).
  Recorded as a follow-up in §12.
- No change to the legacy `[y/N]` ask, to plain non-TTY hosts, to print mode, or
  to the transcript's tool rows.
- No policy change: guardian's rules, thresholds, and `sessionKey` granularity
  stay exactly as they are.
- No packaging/publishing work for guardian (it remains an example extension).

## 6. Decisions

### D0 — one document, two phases

The seam shapes (D7) and the layout (D5) constrain each other: a layout chosen
without knowing that a preview section will arrive would be redesigned in Phase 2.
Precedent: `docs/m4-extensions-design.md` (one document, sub-milestones M4a-c,
per-milestone acceptance criteria) and `docs/tui-tool-elapsed-design.md` (one
document, later contract changes folded in as amendment sections with their own
review rounds). Two documents would duplicate the shared layout and drift.

### D1 — record policy: one transcript line, the picker owns the detail

Today both the notes and the picker print the title and the full detail.
Decision: the host keeps **one** record line per ask —

```
▪ confirm: [guardian] allow this bash command?
```

and the picker carries the title and detail (it already does). The session-memory
suffix keeps its current wording — `▪ confirm: <title> — allowed for this session`
— because the short-circuit path has no picker to carry the fact.

Rationale: the record is a durable transcript fact (useful after the screen
scrolls), the detail is an answering aid (useful while answering). Printing both
twice serves neither. Test impact: `test/repl-confirm.test.ts:66,76` and
`test/repl-tui.test.ts:1980` pin these lines and must be re-derived, not deleted:
the assertions become "exactly one `▪ confirm: <title>` per ask, and the detail
text appears only in the picker".

Open question Q4 for the reviewer: should the record line move *after* the
decision so the transcript reads as a completed event with its outcome? The
current pre-decision placement is kept unless review argues otherwise.

### D2 — affordance line, inside the picker

While a picker owns focus the editor hint row is blanked on purpose
(`src/repl/shell.ts:1110-1121`, M10 review P2#5: "you can type" would be a lie),
so the affordance must live **inside** the picker box, as a dim line under the
items. Copy follows the existing hint style (lowercase, parenthesized, `·`
separated — `src/repl/shell.ts:174-181`):

```
(↑/↓ move · enter select · esc cancel · 1-3 quick pick)
```

Variant rules: the numeric range appears only when digits are live (D3); a
filterable picker keeps its existing `filter:` row and gets no digit range. The
line is dim via the host's own `dim()` (`src/format.ts`) — no theme change.

### D3 — number keys, and only where they cannot collide

Digits `1..9` select the corresponding visible row. Two constraints:

- **Not on filterable pickers.** There, printables build the query
  (`src/repl/shell.ts:852-878`); a digit must stay a query character. The confirm
  picker never sets `filterable`, so it is unaffected.
- **Digits over letters.** Claude Code accepts `y`/`n`; the pi package documents
  why letter hotkeys are fragile under an IME (composition swallows them). imp
  takes digits only, which also keeps `y`/`n` free for future edits and avoids
  colliding with type-to-filter habits.

Implementation: the shell already intercepts keys while a selector is open
(the pre-focus listener that carries `filterKey`, `src/repl/shell.ts:852-878`);
digit handling belongs there, next to it, gated on `selector !== null` and the
picker not being filterable.

### D4 — row numbering on every non-filterable picker

Rows become `→ 1. Yes`. Decision: numbering is applied inside `TuiShell.select`
for all non-filterable pickers (confirm, project trust, `/settings`, `/model`)
rather than only for the confirm.

Rationale: the affordance line advertises digits; a picker that shows the hint
without numbers would be lying, and a second code path for "confirm only" costs
more than it saves. Blast radius is contained: the marker is asserted in 9 places,
all in one file (`test/repl-tui.test.ts:703,778,779,968,969,974,1003,1520,1721`),
and each becomes `<marker> <n>. <label>`. The label prefix is presentation only:
the row's identity stays the original index in `SelectItemOption.value`
(`src/repl/shell.ts:786-789`), which is what `finish()` resolves.

Open question Q1 for the reviewer: if the frame churn in unrelated pickers is
judged too broad, the fallback is a `SelectOptions.numbered?: boolean` set only
by `TtyConfirm`; the layout and keys stay as specified here.

### D5 — block layout and width budget

Top to bottom, inside the existing ask area (no box border in Phase 1; see D6):

```
[title]                       one row, as today
[detail]                      dim block, warn spans applied, wrapped as today
[preview]                     Phase 2 only (§8), rendered in transcript form
[blank]                       one blank row between detail/preview and the items
  1. Yes
  2. Yes, don't ask again this session
  3. No
[hint]                        dim affordance line (D2)
```

Rules: exactly one blank row before the items and none between the items and the
hint; every row honors the terminal width (the existing wrap test at
`test/repl-tui.test.ts:732` is the enforcement pattern, as is the viewport-width
sweep at `:299`); the item list keeps its current `Math.min(items.length, 8)`
window and scroll indicator.

### D6 — color: dim only, no accent

Phase 1 uses dim for the hint line (host `dim()`), leaving the identity theme
(`src/repl/shell.ts:80-91`) untouched. Adding an accent color for the selected
row or a top border would change the pre-M9 aesthetic that the theme encodes and
that every other surface shares; it is not needed to fix the four defects in §1.

Recorded as a droppable, separately decidable item: **if the owner wants an
accent later, it lands as its own small change with its own acceptance**, not as
a hidden part of this one. This keeps the phase reviewable and reversible.

### D7 — Phase 2 contract (additive, both optional)

```
interface ConfirmOptions {
  sessionKey?: string;        // existing
  warnSpans?: Array<[number, number]>; // existing
  /** D7a: what "don't ask again this session" will remember, in the
   *  extension's own words (e.g. "this command pattern", "this directory").
   *  Rendered inside the second option's label. Absent: current wording. */
  rememberLabel?: string;
  /** D7b: the request to decide, rendered in the transcript's own form
   *  instead of prose. Only "command" is defined in Phase 2. */
  preview?: { kind: "command"; text: string; warnSpans?: Array<[number, number]> };
}
```

- `rememberLabel` is rendered as `Yes, don't ask again this session (<label>)`.
  The host still owns the memory (`sessionAllowed`, keyed by `sessionKey`); the
  extension only supplies the words. This is the A3 split agreed in review:
  memory is host policy, granularity wording is extension knowledge.
- `preview.kind === "command"` renders through the same presentation the
  transcript uses for a bash call row (`src/repl/components/tool-block.ts`), so
  "what I am approving" and "what the transcript will show" look identical. Its
  own `warnSpans` apply to the preview text (offsets are relative to `text`).
- Unknown `preview.kind` values, or malformed fields, are ignored (the host
  renders nothing extra) — a defensive host never trusts extension math, the
  same stance `applyWarnSpans` already takes (`src/format.ts:168-190`).
- Degradation (D8) applies: hosts without a picker ignore both fields entirely.

### D8 — degradation matrix (must not change)

| Host | Behavior with the new fields | Behavior today |
|---|---|---|
| TUI picker | renders them (Phase 2) | n/a |
| Legacy readline ask | ignored; `proceed? [y/N]` unchanged, byte-identical | `test/repl-confirm.test.ts:113` |
| No interactive host (print, tests) | ignored; one `imp:` teaching line, resolves false | `src/extensions/registry.ts:93-94` |
| Subagent call in-process | same host, same queue as the parent | `test/repl-tui.test.ts:956` (queue, never silently decline) |

## 7. Phase 1 — host-only: scope, files, acceptance

Files: `src/repl/repl.ts` (record policy D1, option labels), `src/repl/shell.ts`
(numbering D4, digits D3, affordance line D2, layout D5), tests
`test/repl-tui.test.ts`, `test/repl-confirm.test.ts`, `test/guardian.test.ts` (if
its frames assert the detail note).

Acceptance criteria (scriptable):

1. A confirm frame contains the title **exactly once** and the detail **only
   inside the picker** (D1), while the `— allowed for this session` record line
   still appears on a remembered key.
2. While a picker is open, the affordance line is present, and no rendered line
   exceeds the terminal width.
3. Digits `1`–`3` select the matching option; Enter selects the highlighted row;
   ↑/↓ move; Esc cancels to a decline (`null`).
4. A filterable picker still treats a digit as a query character (D3).
5. Legacy ask, no-host, print mode, and the transcript tool rows are unchanged.
6. Gates, unmasked exit codes: lint 0, typecheck 0, full suite 0, build 0.

## 8. Phase 2 — seam + consumer: scope, files, acceptance

Files: `src/extensions/types.ts` (`ConfirmOptions`, D7), `src/repl/shell.ts`
(preview rendering, `rememberLabel` in the option label),
`examples/extensions/guardian.mjs` (pass both at the bash gate, `rememberLabel`
at the write gate), `src/format.ts` only if a shared helper is needed, tests.

Acceptance criteria (scriptable):

1. With `rememberLabel`, the second option reads
   `Yes, don't ask again this session (<label>)`; without it, the label is
   byte-identical to Phase 1's.
2. With `preview`, the confirm shows the command in the transcript's bash-row
   form and the preview's own `warnSpans` highlight; without it, byte-identical.
3. Guardian passes a `rememberLabel` for both gates and a `preview` for the bash
   gate; its decline path (`{block, reason}`) is unchanged.
4. Both fields are ignored by the legacy ask and by no-host hosts (D8 table).
5. An unknown `preview.kind` renders nothing rather than throwing.
6. Gates, unmasked exit codes: lint 0, typecheck 0, full suite 0, build 0.

## 9. Files touched (implementation forecast)

| Phase | File | What changes |
|---|---|---|
| 1 | `src/repl/repl.ts` | drop the detail note; option labels |
| 1 | `src/repl/shell.ts` | numbering, digit handling, affordance line, blank-row sectioning |
| 1 | `test/repl-tui.test.ts` | 9 marker assertions + new pins for 1-6 |
| 1 | `test/repl-confirm.test.ts` | record-line assertions re-derived |
| 2 | `src/extensions/types.ts` | `rememberLabel`, `preview` |
| 2 | `src/repl/shell.ts` | render both; ignore malformed |
| 2 | `examples/extensions/guardian.mjs` | pass both fields |
| 2 | `test/repl-tui.test.ts`, `test/guardian.test.ts` | consumer pins |

No new dependencies. No persistence or session-format changes. No model-visible
change: `api.confirm`'s resolution semantics are untouched (still boolean).

## 10. Test plan (red-first)

Every pin is written before the change and observed red on the pre-change code
(the repository's discipline: red evidence first).

Phase 1:

- RED: a frame has one title and no duplicate detail (fails today: two of each).
- RED: the affordance line is present while the picker is open.
- RED: pressing `2` resolves index 1 and the remembered key behaves as before.
- RED: `→ 1. Yes` numbering appears on the confirm picker.
- RED: a digit in a filterable picker narrows the query (guards D3).
- GUARD (green before and after): legacy ask bytes; no-host teaching line;
  Esc/Ctrl+C cancel; the queue-not-decline behavior; 80-column wrap.

Phase 2:

- RED: `rememberLabel` appears in the second option; absent → unchanged.
- RED: `preview` renders the bash-row form; absent → unchanged.
- RED: unknown `preview.kind` renders nothing and does not throw.
- RED: guardian's bash gate passes a preview and a remember label (asserted
  through the extension's `api.confirm` call, as `test/guardian.test.ts` already
  captures it).
- GUARD: legacy/no-host degradation rows from the D8 table.

## 11. Verification

Per phase: the four gates with unmasked exit codes (`npm run lint`,
`npm run typecheck`, `npm test`, `npm run build`), the focused files first, then
a manual terminal check by the owner (the acceptance that closes the batch):
trigger a guardian gate with a risky command, answer by digit, and confirm the
record line reads once.

## 12. Open questions for the reviewer

- Q1 (D4): number every non-filterable picker, or only the confirm? Recommended:
  every picker; fallback is an opt-in flag.
- Q2 (D2): is the exact hint copy right (`↑/↓ move · enter select · esc cancel ·
  1-3 quick pick`), and should the digit range be computed from the item count?
- Q3 (D5): one blank row above the items — enough separation, or should the
  detail block be followed by a rule line instead?
- Q4 (D1): keep the record line before the decision, or move it after so the
  transcript reads as a completed event?
- Q5 (D6): confirm that "dim only, no accent" is acceptable for this batch, with
  the accent recorded as a separate future item.
- Q6 (D7): is `preview.kind = "command"` the right first shape, given that the
  future diff preview (non-goal here) would need `{path, before, after}` and a
  host-side diff? Should the field be shaped now to leave that room, or is
  additive growth acceptable?
- Q7 (D7): should `rememberLabel` be free text from the extension, or a
  structured hint (e.g. `{kind: "command-pattern" | "directory", value: string}`)
  so the host can phrase it consistently? Recommended: free text, because the
  host cannot know every policy granularity.

## 13. Review log

(Filled during the design review; each round records findings and their
disposition. Later contract changes to Phase 2 are folded in as amendment
sections here, with their own review rounds — the `docs/tui-tool-elapsed-design.md`
pattern.)

## 14. Process

- Work happens in the `/Users/z/Z/Agent_demo/imp-confirm-design` worktree. The
  shared checkout at `/Users/z/Z/Agent_demo/imp` belongs to another session
  (`feat/task-inline-live-rows`); this design touches none of its files and its
  branch is left untouched.
- One design (this document) → independent adversarial review → Phase 1
  implementation on its own branch → gates → implementation check → `--no-ff`
  merge → ledger entry.
- Phase 2 reuses this document; if its sections changed since the design review,
  the changed section gets a fresh review round before implementation.
- Each phase merges separately and is independently revertible; neither phase
  touches persisted state, so rollback is a revert, not a migration.
