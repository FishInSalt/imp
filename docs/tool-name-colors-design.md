# #tool-name-colors — tool-name color differentiation via extensions

Status: implemented and merged (merge 70821d4); Amendment 1 (no shipped
defaults, palette to the example theme) implemented and merged (merge
b4db87b); Amendment 2 (absolute color tokens `ansi256:N` / `#rrggbb`,
owner-approved) implemented and merged (merge 6b3d2fb; design review
NEEDS-FIXES → CONFIRMED, implementation review APPROVE WITH CORRECTIONS →
CONFIRMED). Design review
closed after 3 rounds; implementation review APPROVE WITH CORRECTIONS →
CONFIRMED (stale-wording P3s fixed). Design review closed after 3 rounds (NEEDS-FIXES
→ NEEDS-FIXES → CONFIRMED); implementation review APPROVE WITH CORRECTIONS →
CONFIRMED (the P2 was a real prototype-chain lookup bug for names like
`constructor` — fixed at the time via an own-property `defaultToolColor`
lookup and a fail-closed SGR Map; A1 later deleted that lookup with the
defaults). Owner decisions 2026-10-02:

1. Mechanism is **route B** — a new extension capability, so themes are
   per-user installable modules (owner: "以后可能不同用户有不同审美").
2. Scope is **the tool name only** — result rows (`⎿`), activity rows,
   footers and pickers stay as they are.
3. A category-per-color palette, `task` on its own slot — **as the owner's
   theme, not a shipped default** (Amendment 1 removed the factory palette;
   check-in colors are opt-in).

## Context

Every call header today renders the same way: dim `●`, **bold tool name**,
two spaces, then the call's arguments (`src/repl/components/tool-block.ts`
:511-519 for the fold; `renderCommandHeader` :129-152 for the confirm
preview — the same idiom, host-owned `StyleSpan`s applied *after* the
physical-row layout by `styled()` :12-27). Nothing distinguishes `bash`
from `read` or `edit` at a glance, and there is deliberately no user-facing
way to change it: the extension API (`src/extensions/types.ts` :132-190)
exposes registrations, events, `setStatus`, `confirm` and `classify` —
**no rendering surface** ("The host owns styling", setStatus TSDoc).

This batch adds exactly one narrow capability: an extension may map tool
names to one of 16 terminal colors (plus `none`). The host keeps ownership
of how the color is applied and validated; the extension only supplies a
token. Raw SGR strings, bold/italic knobs and per-argument logic are out
of scope (§D10).

## D1 — API: `api.registerToolColor(names, color)`

```ts
registerToolColor(names: string | readonly string[], color: ToolColorName): void;
```

- `ToolColorName` is a closed union of 16 standard-16 tokens — `black red
  green yellow blue magenta cyan white gray brightRed brightGreen
  brightYellow brightBlue brightMagenta brightCyan brightWhite` — plus
  `"none"` (explicit opt-out: the name renders bold-only, overriding
  another registration for the same name, §D2).
- `names` is one name or an array; each entry must match `NAME_PATTERN`
  (`core/constants.ts` :50) or be the literal `"*"` (wildcard, §D2). The
  registered name does **not** need to exist as a tool — a theme may style
  tools that load later (extensions, MCP bridges); an unmatched name is
  inert.
- Registration is **load-gated**: valid only while the factory runs —
  the `whileLoading` wrapper in `loader.ts` :204-227 reports post-load
  attempts (`registration only works while the factory runs`), same as
  `registerTool` / `registerCommand` / `registerContext`. No runtime
  mutation ⇒ no re-render plumbing, no lifecycle (§D5).
- Validation never throws (registry culture, `registerTool` :229-232),
  and is **total** — every malformed shape has a defined path and one
  report line, values quoted bounded (`firstLine(String(v), 160)`, the
  existing `(got "…")` idiom):
  - `names` is neither a string nor an array →
    `imp: extension X could not register tool color — expected a name or an array of names, got <type>`;
  - an invalid entry (non-string, empty, bad pattern) →
    `imp: extension X could not register tool color for "<name>" — names must match /^[a-z][a-z0-9_-]{0,63}$/ or be "*" (got "<value>")`;
  - `color` not a member of the closed set →
    `imp: extension X could not register tool color — unknown color (expected one of: <16 + none>, got "<value>")`;
  - a conflict (§D2) →
    `imp: extension X could not register tool color for "<name>" — already registered by Y`;
  - a duplicate entry within one call (`["bash", "bash"]`) → the same
    conflict report; the whole call is rejected (all-or-nothing, below).
  A thrown factory still discards the whole section atomically
  (`discardExtension`). A valid entry inside an otherwise malformed call
  is not partially applied: one call registers all of its names or none.

## D2 — Registry storage, conflicts, resolution

- Per-section storage (`{ name, color }[]`), merged on
  `commitExtension()` into `toolColors: Map<string, ToolColorName>` plus
  `colorOwners: Map<string, string>`; first registration **wins**, later
  ones for the same key are rejected with the report above — exactly the
  `conflictOwner` shape used for tools/commands/contexts (:251/:301/:327).
  A duplicate *within* one section is rejected the same way.
- Keys: exact tool name; plus at most one `"*"` per registry (the wildcard
  slot has its own conflicting owner).
- Resolution `registry.toolColorFor(name)`:
  `exact map` → `"*" map` → `undefined`. *(Superseded by Amendment 3:
  two tiers — user exact → user `*` → suggested exact → suggested `*` →
  `undefined`.)*
- **Specificity across keys, load order only within a key** (normative;
  within one tier — Amendment 3 adds the author-suggestion tier below the
  user tier):
  an exact registration always beats a wildcard one regardless of which
  extension loaded first — extension A (`"*" → blue`) plus extension B
  (`"bash" → green`) resolves `bash` to green, and that is *not* a
  conflict (no report line). Load order (alphabetical, `loader.ts` :142)
  arbitrates only two registrations of the *same* key. Corollary: a later
  exact `"none"` silently disables an earlier wildcard color for that
  name — by specificity, not as an error. A two-section registry test
  pins this (§D7).
- Composed resolver (built once in `repl.ts`; Amendment 1):
  `extension exact` ?? `extension "*"` ?? `none` — extensions are the only
  source. `register("*", "blue")` is a theme saying "everything blue
  unless I say otherwise"; with no extension nothing is colored.

## D3 — Default palette

New module `src/repl/tool-colors.ts` (importable by both `extensions/`
and `repl/` — precedent: registry already imports `repl/commands.js`):

```ts
export const DEFAULT_TOOL_COLORS: Record<string, ToolColorName> = {
  bash: "yellow", read: "blue", ls: "blue", edit: "magenta", write: "magenta",
  grep: "cyan", find: "cyan", task: "brightMagenta",
};
```

- Category slots: exec / read / mutate / search / subagent. Same-category
  tools share a hue; a new built-in lands in the table in one line.
- Red and green are deliberately absent from the defaults — they belong to
  `✓` / `✗`. The API still allows them (user freedom); themes own that
  choice.
- `task` gets the only bright slot: it is an agent call, not a tool, its
  row is the longest, and a unique hue keeps it recognizable.
- Unknown tools (MCP-bridged, extension-registered, future built-ins)
  render **bold-only**, i.e. today's bytes — the host does not guess.
- Standard-16 tokens as the default, on purpose: the hues follow the
  user's terminal theme, which is itself part of per-user aesthetics.
  Whites/monochrome terminals degrade gracefully (hue collapses, layout
  and semantics don't). *Superseded in part by Amendment 2:* absolute
  `ansi256:N` / `#rrggbb` tokens exist for users who need exact colors;
  named tokens remain the theme-relative default.
- `toolColorSgr(token)`: the closed token → SGR map (30-37, 90-97);
  `"none"` → `""`. This is the only place a token becomes bytes.

## D4 — Rendering points (two, both name-span only)

1. **Call header in the fold** (`tool-block.ts` :515-519): the name span
   (`title === name`, or the interrupted variant where the name stays and
   ` · interrupted (no result)` carries RED) becomes
   `BOLD + toolColorSgr(token)`; `undefined`/`"none"` keeps plain `BOLD` —
   byte-identical to today. The dim `●`, the arguments, the closing slot
   (✓ / ✗ / `Ns`), the `⎿` rows: untouched.

   Invariant recorded for the reviewer: every input-block producer sets
   `title = sanitizeDisplay(name)` (`tool-presentation.ts` :330), the
   interrupted suffix (:730) is the only title mutation, and
   `ToolPresentationHooks` (`core/tools/types.ts` :54-58) cannot change
   the title — so the guard never silently drops the color for a custom
   presentation today. A future producer that rewrites `title` would
   disable the color for its blocks; that is the acceptance of the guard,
   not an accident.
2. **Confirm preview** (`renderCommandHeader`, `tool-block.ts` :136-152):
   same span treatment for the preview's name. Signature gains an optional
   resolver: `renderCommandHeader(preview, colorFor?)`; the caller
   (`shell.ts` :933) passes the shell's resolver (§D5). Hosts that don't
   pass one (unit tests) keep today's bytes.

Width/layout: zero impact by construction — spans are applied after the
row plan and `styled()` closes each span with RESET, so the SGR bytes
never enter `visibleWidth` / truncation / the closing-slot reservation.
Differential rendering is stable: the style string is a session constant
(load-gated registration), so identical rows still diff as identical.

## D5 — Wiring and lifecycle

- `transcript.ts`: new public field
  `toolColorResolver: ((name: string) => ToolColorName | undefined) | null`
  (same public-field pattern as `callSuffixResolver` :80-83, but **not**
  shell-bound and not cleared on close — it is set once by `repl.ts`
  from the registry (Amendment 1: no defaults) and never changes: registrations happen
  before the REPL exists, so a late-created fold pulling it at
  construction sees the final value). Assigning at the existing :1622
  site is sound: `runRepl` assigns unconditionally on every invocation,
  and the trust-ask shell (`trust-ask.ts` :43) renders neither folds nor
  previews. The fold factory (:91) passes
  `block.kind === "input" ? this.toolColorResolver?.(block.name) : undefined`
  into the extended constructor `new ToolBlockFold(block, nameColor?)`.
- `shell.ts`: **`TuiShellOptions` gains an optional
  `toolColorResolver`** — the shell is constructed inline in a ternary at
  `repl.ts:1669` (typed `LineInput`), so a post-construction assignment at
  :1622 is not available; the resolver rides the options object there,
  `start()` follows at :1715. The shell stores it and uses it only at
  :933 for the preview. Optional and immutable: nothing else writes it,
  and there is no lifecycle.
- `repl.ts`: builds the composed resolver next to the existing
  `toolSink.setResolver` wiring (:1622) — `options.extensions` is in
  scope there — assigns it to the transcript, and passes it in the
  `TuiShell` options at :1669.
- `ToolBlockFold` gains an optional second constructor parameter. All
  existing call sites and byte-level fold tests stay valid (unset =
  legacy bytes); only tests exercising the new resolver change.

## D6 — Mode matrix

| Host | Effect |
|---|---|
| TUI (the only consumer) | colored names per resolver/defaults |
| print / plain (`-p`), legacy non-TUI | untouched (different renderer, no transcript) |
| replay (`replay.ts` `● … no result` line) | untouched (own dim line) |
| activity region / footer / pickers / task tree | untouched |
| `⎿` result rows, closing slot, notices | untouched |

## D7 — Tests (red-first)

New `test/tool-colors.test.ts` (unit):
- token set is closed (16 + none); every token maps to a non-empty SGR
  (`"none"` → `""`); out-of-contract tokens fail closed to `""` (A1).
- composition (A1): no registry — and a registry answering `undefined` —
  yields `undefined` for every name; extensions are the only source.

`test/extensions-registry.test.ts` additions:
- validation: unknown color token, non-string name, invalid name,
  empty array — each one report line, nothing stored;
- conflict: same exact key across sections, same wildcard key, duplicate
  within one section — including two identical entries in one call —
  first wins, later reported;
- `"none"` round-trips; `toolColorFor` precedence exact > wildcard;
- thrown factory discards colors atomically (existing rollback pattern).

`test/extensions-loader.test.ts`: post-load `registerToolColor` reported
by `whileLoading`; a factory calling it normally stores via the API.

`test/tui-tool-elapsed.test.ts` / `test/tool-display-colors.test.ts`
(direct-`ToolBlockFold` byte pins — `builtin-tool-presentation.test.ts`
is `preparedInputBlock`-level and has no fold rendering):
- with a token → the name span carries `BOLD + SGR`, **plain text
  unchanged** (strip comparison); without a token → legacy bytes exactly;
- interrupted row: name span colored, ` · interrupted (no result)` stays
  RED;
- output blocks / `⎿` rows never colored (resolver ignored);
- narrow widths: colored and uncolored render at identical widths (the
  SGR bytes are zero-width by the existing post-layout application).

`test/repl-tui.test.ts` (end-to-end, real wiring; A1):
- no extension: the exact legacy header bytes, no hue on any name;
- the shipped example theme (loaded through the real loader) paints the
  `task` call bright magenta;
- a temp extension registering `bash → brightCyan` / `gated → brightCyan`;
- `"*" → "blue"` colors an otherwise-uncolored tool (e.g. `gated`);
- `"none"` strips a hue another registration had set (bold-only);
- confirm preview shows the colored name.
**Affected existing tests — surveyed, expected count 0.** The textual
escape pattern `\x1b[` (five spelled characters) appears 62 times in
`test/repl-tui.test.ts` and 0 times in `test/extensions-repl.test.ts`;
the 62 sites touch raw escape bytes (write assertions for warn colors
(`:767`, `:828`), the guardian label, injection guards, queue, footer,
OSC title and dim rules, plus paste/CSI input fixtures like `:407`,
`:491`, `:521`) — none targets header-name bytes. Frames are read through `frameSince`
(`:126-135`, ANSI-stripped per write) where text assertions live; the few
raw `terminal.writes.join("")` reads are exactly the classified color
pins above. The remaining name-byte pins are out of the color path:
`render.test.ts` :59-266 (legacy one-line renderer, §D6-untouched),
`tool-display-colors.test.ts` :38 and `tui-tool-elapsed.test.ts` :56-63
(direct folds, resolver unset), `confirm-preview.test.ts` :22 (unit,
optional argument). The implementation re-runs this survey and keeps the
count at 0; every new assertion lives in the new tests above. New e2e runs
go through `runRepl` (`repl-tui.test.ts` harness) so the real wiring is
exercised.

Red evidence plan: the new unit file importing the not-yet-existing
`src/repl/tool-colors.ts` fails at transform (module resolution) on the
pre-change tree; the registry tests fail at runtime (`registerToolColor`
is `undefined` — vitest strips types, so this is a TypeError, not a
compile error); the fold byte tests fail by missing bytes; the e2e
colored-frame tests fail on the uncolored frames.

## D8 — Docs & examples deliverables

- `examples/extensions/tool-colors.mjs`: a ~15-line example theme
  (overrides + wildcard) showing the whole API; **not** linked into any
  user's `~/.imp/extensions` by us (owner choice). Loaded by tests the
  same way `task-timer.mjs` is exercised.
- `README.md`: one bullet under the extensions feature — tool names can
  be colored per user via an extension; no colors by default, opt-in via
  the example theme (A1).
- `CHANGELOG.md` entry.
- `docs/m4-extensions-design.md`: an amendment note — one new
  load-gated registration (`registerToolColor`), normative semantics in
  this document.
- `src/extensions/types.ts`: the `ExtensionApi` TSDoc's “ten members”
  note becomes eleven, and `registerToolColor` gets the load-gating
  comment (factory-window only, like the other registrations).

## D9 — Risks / accepted tradeoffs

- Hue rendering depends on the terminal theme (accepted; see §D3).
- Two extensions styling the same key: first registration wins (report
  line); across different keys, specificity decides — exact beats
  wildcard regardless of load order (§D2), which is deterministic,
  tested, and documented rather than silent.
- Defaults change production bytes of call headers — every downstream
  byte-level expectation must be updated consciously (§D7); no visual
  width change.
- A theme can style a name that never appears (typo, unloaded tool) —
  inert, not diagnosed further (matching the "does not need to exist"
  rule).
- `setStatus`/`confirm` remain the only *runtime* extension surfaces; if
  a future knob (bold, per-argument) is wanted it must extend this
  contract through its own design review.

## D10 — Explicitly out of scope

Result-row (`⎿`) coloring, closing-slot coloring, activity/footer rows,
selector/tree rows, print/replay/legacy rendering, raw SGR strings,
bold/italic/underline knobs, per-argument or per-run dynamic styles,
256-color absolutes *as defaults* (Amendment 2 added them as opt-in
tokens; the shipped behavior still uses named, theme-relative colors),
theming of non-tool UI.

## Amendment 1 — no shipped defaults; the palette moves to an example theme (owner directive, 2026-10-02)

Owner, after the batch merged: "出厂默认不调色" — the shipped default
palette is removed, and the previously approved hue table becomes the
owner's preference theme in `examples/extensions/tool-colors.mjs`.

- **D3 revised.** `DEFAULT_TOOL_COLORS` and `defaultToolColor` are deleted
  (no src importer besides the module itself — dead-code check done);
  `composeToolColorResolver(registry)` resolves extension registrations only
  (`registry.toolColorFor`), so with no extension every call header renders
  exactly the pre-batch bytes (bold name, no hue). The own-property-guard
  class of bug (implementation review P2-1) disappears with the lookup that
  hosted it; the registry's Map lookups and the fail-closed SGR Map stay.
- **The palette**: `examples/extensions/tool-colors.mjs` now registers the
  approved table verbatim — bash yellow, read/ls blue, edit/write magenta,
  grep/find cyan, task brightMagenta. That is **five calls / eight names**
  (colors are stored per name), so the example's banner reads `— 8 colors`;
  the loader smoke asserts all eight lookups **and** that banner line.
  Users opt in by linking or copying the file into `~/.imp/extensions/`
  (nothing loads it automatically). The file remains the API's living
  example, now owned by the owner's taste.
- **Banner gap (found while amending).** A colors-only extension used to
  banner as `— no registrations` (the summary counted tools/commands/
  contexts/hooks only). `ExtensionSummary` gains a required `colorCount`
  (only `commitExtension` builds summaries — no test literal constructs the
  type); the banner appends the segment after `hookCount` and only when
  positive (`1 color`, `8 colors`), so every existing banner line stays
  byte-identical when no colors are registered (existing pins at
  `extensions-loader.test.ts:275-278`, `extensions-repl.test.ts:204/259/307/878`,
  `extensions-contrib.test.ts:153/221` are safe).
- **Tests revised** (red evidence: inverted pins fail on the pre-amendment
  tree while the defaults still answer):
  - unit: the defaults test is replaced by "no registry → undefined for
    every name" and the compose pin `composeToolColorResolver()("task")`
    flips from `"brightMagenta"` to `undefined` (also for a registry whose
    `toolColorFor` always returns undefined);
  - `repl-tui` default-palette e2e inverted: no extension → **exact legacy
    header bytes** (`\x1b[2m●\x1b[0m \x1b[1mbash\x1b[0m  echo painted`),
    not merely "no yellow";
  - the task e2e drives its colors by loading the shipped example file
    through the real loader (keeps the example under test);
  - stale titles/comments at `repl-tui.test.ts:3374/3406` rewritten with
    their pins.
- **Removal inventory (complete — the implementation commit updates each
  in place):** this doc's owner decision 3 (:15), D2 composition
  (:96-102), D5 provenance (:164-166), D7 unit/e2e entries (:199,
  :231-232), D8 README deliverable (:269); source wording
  `src/extensions/types.ts:151` ("overriding a default palette entry"),
  `src/repl/transcript.ts:87`, `src/repl/repl.ts:1667-1668`,
  `src/repl/tool-colors.ts:2/9`; the example's own comments
  (`examples/extensions/tool-colors.mjs:3-6`); README :590/:592-597; CHANGELOG :11-21;
  `docs/m4-extensions-design.md` Amendment A. `PROJECT_PLAN.md:744` is the
  merged batch's history and is **not** rewritten — this amendment lands its
  own ledger bullet (same precedent as #call-closing-status A1). No
  interaction with the `tui-tool-elapsed` / `call-closing-status` docs:
  colors stay post-layout, zero width.
- **Docs**: README, CHANGELOG and m4 Amendment A wording drops "shipped
  defaults" and describes opt-in themes.

Implementation on `feat/tool-name-colors-a1`; short adversarial review
round before implementation, per the working agreements.

## Amendment 2 — absolute color tokens: `ansi256:N` and `#rrggbb` (owner-approved, 2026-10-02)

Context: the owner wants a "dark orange like Claude Code's brand color" for
the built-in tools (Claude's accent is the truecolor hex `#d97757` — it is
not an ANSI color; the 16 standard slots have no orange) and a warm beige for
the two web-search tools. Neither is expressible in the current token set.
Owner-approved direction: **keep the 16 named tokens, add absolute-color
tokens** — additive, default behavior unchanged, zero migration for existing
themes.

- **Grammar** (new accepted values, alongside the 16 names + `none`),
  anchored full matches, no trimming:
  - `ansi256:N` — `^ansi256:(0|[1-9][0-9]{0,2})$` plus a value ≤ 255 check
    (canonical: `ansi256:0`..`ansi256:255`; `00`, `+8`, ` 8`, `0x8`, `8e0`
    all rejected). Renders `ESC[38;5;Nm`.
  - `#rrggbb` — `^#[0-9a-fA-F]{6}$`; hex case is **accepted** and
    `registerToolColor` stores the lowercased form after the check
    (`canonicalToolColor`; `isToolColor` itself only predicates). No
    `#rgb`/`rgb()` shorthand. Renders `ESC[38;2;R;G;Bm`.
  - Prefix `ansi256:` is lowercase-only (`ANSI256:5` → unknown color).
- **`toolColorSgr(token: ToolColor)` contract**: named tokens keep the exact
  Map lookup (bytes unchanged); absolute tokens are re-validated (via the
  absolute half of `isToolColor`) before parsing, and the hex parse is
  case-insensitive regardless of stored form (defense in depth for callers
  that bypass validation, e.g. unit tests) — `#D97757` and `#d97757` render
  identical bytes (`ESC[38;2;217;119;87m`). Anything out of contract still
  fails closed to `""` (bold-only), pinned.
- **Unchanged**: validation never-throws; per-key first-wins conflicts;
  `"*"` wildcard; `"none"`; per-name storage; exact-over-wildcard; the
  loader's factory-window gate; `ExtensionSummary.colorCount`.
- **Documented pitfall**: `ansi256:0..15` *usually* alias the theme's first
  16 slots (identical or near-identical bytes, emulator-dependent — aliasing
  is common, not guaranteed); indices 16–255 are the standard fixed
  cube/grays (a few themes remap those too). "Exact orange" means
  `ansi256:208` or `#d97757`, never `ansi256:3`.
- **Accepted tradeoffs** (owner's point of the request): absolute tokens do
  not follow the terminal theme; truecolor hex additionally depends on
  terminal support (256 is the portable choice; named tokens remain the
  theme-relative default).
- **Types**: `ToolColor = ToolColorName | \`ansi256:${number}\` | \`#${string}\``
  — template forms are DX-only (verified with tsc: `ansi256:007`, `-1`,
  `1.5`, `1e3`, `#gggggg`, `#` all satisfy the template types);
  `isToolColor` gates every boundary, no casts. `isToolColorName` is kept (the named-only check; still imported by
  the token-set test). Widened signatures (verified complete):
  `registry.ts:8/83/149/366/395/401`, `types.ts:15/156`,
  `tool-block.ts:3/141/195`, `transcript.ts:4/91`, `shell.ts:36/77`,
  `repl.ts:48/1673-74/1690`, `tool-colors.ts:33-76`; `loader.ts:227` is
  inferred. No wiring changes. `test/repl-tui.test.ts:214`'s inline
  annotation widens too.
- **Report line** (exact interpolation; `TOOL_COLOR_NAMES.join(" ")`
  already ends in `none`): `unknown color (expected one of:
  ${TOOL_COLOR_NAMES.join(" ")}, ansi256:N (0-255), or #rrggbb, got
  "${firstLine(String(color), 160)}")` — i.e. for the pinned test input:
  `unknown color (expected one of: black red green yellow blue magenta cyan
  white gray brightRed brightGreen brightYellow brightBlue brightMagenta
  brightCyan brightWhite none, ansi256:N (0-255), or #rrggbb, got
  "orange")`. The 160-char bound is kept. Two
  existing pins update: `test/extensions-registry.test.ts:498` and `:501`.
  `TOOL_COLOR_NAMES` stays 17 entries (its own pin at
  `test/tool-colors.test.ts:11-27` is untouched).
- **The owner's theme** (`examples/extensions/tool-colors.mjs`): task →
  `brightCyan`; bash/read/edit/write/grep/find/ls → `#d97757`;
  web_search/url_read → `#e6dcc3`. Ten names total. Required re-pins:
  `test/repl-tui.test.ts:3444` (`\u001b[1m\u001b[95mtask` →
  `\u001b[1m\u001b[96mtask` — the task e2e now loads the brightCyan
  theme), `test/extensions-loader.test.ts:456` title ("eight registrations"
  → ten), the smoke asserts all ten lookups plus banner `— 10 colors`, and
  the example file's own comments.
- **Docs deliverables** (all asserting the 16-token closure today):
  `README.md:588-597`, `CHANGELOG.md:15`, `docs/m4-extensions-design.md:967-970`,
  `src/extensions/types.ts:147-153` TSDoc, the example comments, and this
  doc's D3 (:127) / D10 (:305) get supersede notes pointing here.
- **Tests (red-first)**:
  - unit — boundary validation (`ansi256:0`/`255` accepted; `256`, `-1`,
    `007`, `ansi256:`, `+8`, `ANSI256:5`, `#rgb`, `#gggggg`, five-digit hex
    rejected; `#D97757` accepted and stored lowercase); SGR bytes for both
    forms (`#d97757` and `#D97757` → `ESC[38;2;217;119;87m`, `ansi256:0` →
    `ESC[38;5;0m`, `ansi256:255` → `ESC[38;5;255m`), fail-closed junk;
  - registry — new tokens round-trip (exact and wildcard), `"none"`
    overrides an absolute token, message pin ×2 updated;
  - repl-tui e2e — an extension registering `#d97757` and `ansi256:173`
    paints the exact wire bytes; the example-file smoke re-pinned to the
    owner's palette (task brightCyan, built-ins hex orange, web-search
    beige);
  - confirm-preview — absolute token renders byte-exactly.
  Existing 16-token tests and all other pins are untouched.

## Amendment 3 — source tiers: the tool's extension suggests, the user decides (owner direction, 2026-10-02)

Context: owner principle — "扩展注册的工具，应该由扩展来决定其颜色"
(the tool's own extension owns its default appearance), while keeping the
original motivation, "不同用户有不同审美" (the user has the final say).
Precedent: Claude Code subagent definitions carry `color:` while the host's
`<color>_FOR_SUBAGENTS_ONLY` tokens let a theme remap what each color looks
like; opencode agents carry `color:`. The flat model cannot express
"author default + user override": one key has exactly one winner, decided
by extension-name load order — whether a theme can override an extension's
color (or vice versa) is name-luck, not contract.

Owner-approved direction ("开 Amendment 3" in response to this proposal):
add a weak **author tier**; the existing method becomes the **user tier**;
**layer beats specificity**.

- **API**: new `api.suggestToolColor(names, color)` — same signature; same
  validation (`isToolColor`, the `NAME_PATTERN` / `"*"` check, hex
  canonicalized lowercased); same per-call atomicity (any bad name or
  in-tier conflict drops the whole call with one report); same load-gating
  and never-throws contract. `api.registerToolColor(names, color)` is
  unchanged and becomes the user tier by semantics only.
- **Two tiers**:
  - *user tier* — `registerToolColor`; report prefix `could not register
    tool color`, duplicate reads `already registered by X` (both
    unchanged);
  - *author tier* — `suggestToolColor`; report prefix `could not suggest
    tool color`, duplicate reads `already suggested by X`; first
    suggestion of a key wins (the same first-wins policy, inside the
    tier).
  - Cross-tier is **never** a conflict: the same key may be both
    registered and suggested (no report); resolution favors the user side.
- **Resolution order** (`registry.toolColorFor`; the render lookup and
  everything downstream is unchanged):
  1. user exact name → 2. user `*` → 3. suggested exact name →
  4. suggested `*` → 5. `undefined` (bold-only).
  Layer beats specificity (owner-approved): any user registration outranks
  any suggestion, including the user `*` over an author's exact
  suggestion. Documented tradeoff: a user cannot combine "author
  defaults" with a global wildcard — the wildcard claims unclaimed *and*
  suggested tools. Enforcing a user color for a suggested tool and
  silencing a suggestion (`registerToolColor("web_search", "none")`) are
  both always possible.
  Rejected alternative: specificity-first (author exact over user `*`) —
  rejected because installing an extension would silently punch holes in
  an existing user theme; "the user layer is entirely above the author
  layer" is the simpler contract. `"none"` and `"*"` are legal in both
  tiers and participate in the order (a suggested exact `none` beats a
  suggested wildcard color).
- **Storage**: `OpenSection.suggestedColors: { name; color: ToolColor }[]`
  (both section literals get the empty array), committed
  `suggestedToolColors` Map + `suggestedColorOwners` (mirroring the user
  tier); existing user-tier storage and `colorOwners` untouched.
  `discardExtension` drops both tiers (same open section).
- **Summary/banner**: `ExtensionSummary.suggestedColorCount`; the banner
  appends `N suggested color(s)` after the existing counts — web-search
  reads `— 2 tools, 2 suggested colors`; a suggestions-only extension
  reads `— 2 suggested colors`; both zero keeps every pre-existing byte
  (the colors-only theme now reads `— 8 colors`).
- **Examples**:
  - `examples/extensions/web-search/index.mjs` gains
    `api.suggestToolColor(["web_search", "url_read"], "#e6dcc3")` — the
    author default, overridable by any user registration.
  - `examples/extensions/tool-colors.mjs` drops the two web lines (those
    tools' look now belongs to web-search); the theme keeps the owner's
    built-in palette: 7 × `#d97757` + `task` brightCyan = 8 user
    registrations. The header comment teaches the two tiers.
- **Compat**: with no suggestions anywhere, lookup is byte-identical to
  Amendment 2; no existing theme or extension changes behavior.
- **Re-pin inventory** (verified 2026-10-02):
  - `test/extensions-loader.test.ts:455-474` tool-colors smoke → eight
    lookups, `web_search`/`url_read` now `undefined` (that file alone no
    longer colors them), `colorCount === 8`, banner `— 8 colors`, title
    wording;
  - `test/extensions-contrib.test.ts:221` web-search banner `— 2 tools` →
    `— 2 tools, 2 suggested colors`, plus a `toolColorFor("web_search")
    === "#e6dcc3"` assertion via the suggestion;
  - `test/tool-display-refinement.test.ts:262/295` minimal `register({…})`
    stubs gain a `suggestToolColor` member (the example now calls it);
  - docs: `src/extensions/types.ts` (ExtensionApi TSDoc sibling +
    `ExtensionSummary.suggestedColorCount`), `README.md` API bullet,
    `CHANGELOG.md`, `docs/m4-extensions-design.md`, and the two D1/D2
    supersede pointers above.
- **Tests (red-first)**:
  - registry — a lone suggestion lands; full resolution matrix (user
    exact > user `*` > suggested exact > suggested `*`); same key in both
    tiers (no report, user side wins); in-tier duplicate pin (`already
    suggested by X`); validation pins ×2 with the suggest prefix;
    per-call atomicity; hex canonicalized in the suggested tier;
  - loader — banner pins (tools + suggestions; suggestions-only);
  - repl-tui — an extension file calling `suggestToolColor` paints the
    wire bytes; a user registration for the same name overrides it;
  - contrib — the real web-search load asserts the suggestion + banner.
  Existing 16-token / A2 pins and confirm-preview stay untouched.
