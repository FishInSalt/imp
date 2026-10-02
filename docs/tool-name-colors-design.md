# #tool-name-colors — tool-name color differentiation via extensions

Status: draft (design review pending). Owner decisions 2026-10-02:

1. Mechanism is **route B** — a new extension capability, so themes are
   per-user installable modules (owner: "以后可能不同用户有不同审美").
2. Scope is **the tool name only** — result rows (`⎿`), activity rows,
   footers and pickers stay as they are.
3. A shipped default palette (below, §D3); the owner picked the
   category-per-color proposal, `task` on its own slot.

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
  `"none"` (explicit opt-out: the name renders bold-only, overriding the
  default palette entry, §D2).
- `names` is one name or an array; each entry must match `NAME_PATTERN`
  (`core/constants.ts` :48) or be the literal `"*"` (wildcard, §D2). The
  registered name does **not** need to exist as a tool — a theme may style
  tools that load later (extensions, MCP bridges); an unmatched name is
  inert.
- Registration is **load-gated**: valid only while the factory runs —
  the `whileLoading` wrapper in `loader.ts` :204-227 reports post-load
  attempts (`registration only works while the factory runs`), same as
  `registerTool` / `registerCommand` / `registerContext`. No runtime
  mutation ⇒ no re-render plumbing, no lifecycle (§D5).
- Validation never throws (registry culture, `registerTool` :229-232):
  a malformed `color`, an empty/invalid name entry, or a conflict (§D2)
  produces one report line and is skipped; a thrown factory still discards
  the whole section atomically (`discardExtension`).
- Report message shapes (bounded quotes, `firstLine` cap 160 like the
  existing messages):
  - `imp: extension X could not register tool color "<value>" — unknown color (expected one of: <16 + none>)`
  - `imp: extension X could not register tool color for "<name>" — names must match /^[a-z][a-z0-9_-]{0,63}$/ or be "*"`
  - `imp: extension X could not register tool color for "<name>" — already set by Y`

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
  `exact map` → `"*" map` → `undefined`.
- Composed resolver (built once in `repl.ts`):
  `extension exact` ?? `extension "*"` ?? `built-in default` ?? `none`.
  The wildcard **overrides the built-in defaults** — `register("*",
  "blue")` is a theme saying "everything blue unless I say otherwise",
  which is the only reading that makes a wildcard useful; an extension
  that wants the defaults to survive simply doesn't register `"*"`.

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
- Standard-16 tokens, not 256-color absolutes, on purpose: the hues follow
  the user's terminal theme, which is itself part of per-user aesthetics.
  Whites/monochrome terminals degrade gracefully (hue collapses, layout
  and semantics don't).
- `toolColorSgr(token)`: the closed token → SGR map (30-37, 90-97);
  `"none"` → `""`. This is the only place a token becomes bytes.

## D4 — Rendering points (two, both name-span only)

1. **Call header in the fold** (`tool-block.ts` :517-519): the name span
   (`title === name`, or the interrupted variant where the name stays and
   ` · interrupted (no result)` carries RED) becomes
   `BOLD + toolColorSgr(token)`; `undefined`/`"none"` keeps plain `BOLD` —
   byte-identical to today. The dim `●`, the arguments, the closing slot
   (✓ / ✗ / `Ns`), the `⎿` rows: untouched.
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
  shell-bound and not cleared on close — it is set once by `repl.ts` from
  the registry + defaults and never changes: registrations happen before
  the REPL exists, so a late-created fold pulling it at construction sees
  the final value). The fold factory (:91) passes
  `block.kind === "input" ? this.toolColorResolver?.(block.name) : undefined`
  into the extended constructor `new ToolBlockFold(block, nameColor?)`.
- `shell.ts`: public field `toolColorResolver: ((name) => ToolColorName |
  undefined) | null = null`, assigned by `repl.ts` before `start()`; used
  only at :933 for the preview. Nullable, no ownership guard: nothing else
  writes it, and there is no lifecycle.
- `repl.ts`: builds the composed resolver next to the existing
  `toolSink.setResolver` wiring (:1622) — `options.extensions` is in scope
  there — and assigns it to both consumers.
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
- defaults table matches §D3 exactly; every default token maps to a
  non-empty SGR; `"none"` maps to `""`; token set is closed (16 + none).
- every built-in tool name (`BUILTIN_TOOL_NAMES`) is either in the table
  or consciously absent (unknown-by-policy assertion, mirrors §D3).

`test/extensions-registry.test.ts` additions:
- validation: unknown color token, non-string name, invalid name,
  empty array — each one report line, nothing stored;
- conflict: same exact key across sections, same wildcard key, duplicate
  within one section — first wins, later reported;
- `"none"` round-trips; `toolColorFor` precedence exact > wildcard;
- thrown factory discards colors atomically (existing rollback pattern).

`test/extensions-loader.test.ts`: post-load `registerToolColor` reported
by `whileLoading`; a factory calling it normally stores via the API.

`test/builtin-tool-presentation.test.ts` (fold-level, byte-precise):
- with a token → the name span carries `BOLD + SGR`, **plain text
  unchanged** (strip comparison); without a token → legacy bytes exactly;
- interrupted row: name span colored, ` · interrupted (no result)` stays
  RED;
- output blocks / `⎿` rows never colored (resolver ignored);
- narrow widths: colored and uncolored render at identical widths (the
  SGR bytes are zero-width by the existing post-layout application).

`test/repl-tui.test.ts` (end-to-end, real wiring):
- default palette: a `bash` call's header carries yellow on the wire
  (`\x1b[1m\x1b[33m` before the name), a `task` call bright magenta;
- a temp extension registering `bash → brightCyan` overrides the default;
- `"*" → "blue"` colors an otherwise-uncolored tool (e.g. `gated`);
- `"none"` on a defaulted tool strips the hue (bold-only);
- confirm preview shows the colored name.
- All *existing* raw-frame byte pins that assert call headers through the
  real wiring must be updated in the same commit — the default palette
  changes those bytes on purpose. Assertions that strip ANSI stay
  semantically valid; enumerated with red evidence at implementation time
  (the affected-pin count is a deliverable, not a guess).

Red evidence plan: run the new suite against the pre-change tree — unit
and registry tests fail at the missing API (`registerToolColor` undefined);
fold/e2e tests fail on the colored bytes (or the resolver being absent),
not compile errors (vitest strips types; runtime shapes only).

## D8 — Docs & examples deliverables

- `examples/extensions/tool-colors.mjs`: a ~15-line example theme
  (overrides + wildcard) showing the whole API; **not** linked into any
  user's `~/.imp/extensions` by us (owner choice). Loaded by tests the
  same way `task-timer.mjs` is exercised.
- `README.md`: one bullet under the extensions feature — tool names can
  be colored per user via an extension; default palette listed.
- `CHANGELOG.md` entry.
- `docs/m4-extensions-design.md`: an amendment note — one new
  load-gated registration (`registerToolColor`), normative semantics in
  this document.

## D9 — Risks / accepted tradeoffs

- Hue rendering depends on the terminal theme (accepted; see §D3).
- Two extensions styling the same key: load order decides (alphabetical,
  `loader.ts` :142) — deterministic, reported, and consistent with every
  other registration kind. No project-over-global precedence here either,
  same as today.
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
256-color absolutes, theming of non-tool UI.
