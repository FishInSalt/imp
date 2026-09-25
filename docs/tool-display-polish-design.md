# Tool display polish: compact calls and readable arguments

Status: APPROVED — independent fresh-context adversarial design review closed. Implementation must preserve the contracts and pass independent code review.

Workspace: `/Users/z/Z/Agent_demo/imp-tool-display`
Existing dedicated branch: `feat/tool-display-previews`.
Do not create branches, commit, merge, or edit the other worktree for this revision.

This revision supersedes the visual grammar and expanded-call presentation in
`tool-display-previews-design.md` and `tool-presentation-hooks-design.md` only
where stated below. Their safety, pairing, source identity, model/display
separation, retention, lifecycle and print/legacy guarantees remain in force.

## 1. Inspected baseline and decision

Inspected the two prior designs, `src/repl/tool-presentation.ts`,
`tool-presentation-hooks.ts`, `components/tool-block.ts`, `shell.ts`,
`transcript.ts`, `src/tui.ts`, core/extension presentation types, and the shipped
web-search presentation and normalization helpers. The current component still
uses triangles and vertical gutters, always adds a semantic expansion hint,
and expands calls to JSON. Web search always previews default max and full-off,
and its result summary consumes a row before source previews. Errors can repeat
an identical first result line in metadata and body.

Recommendation: retain the existing two independently registered folds; use
`●` for a call and `⎿` for its result, provide a small optional structured-call
field list in the existing hook return type, and add **Alt+O** as a separate
raw-arguments display toggle. Keep Ctrl+O's existing expand/collapse-all behavior.
No new rendering framework, tool-name dispatch in core, command palette, focus
model, nested field registry, or persistence format.

## 2. Visual contract

Illustrative collapsed view (requested max is not an observed result count):

```text
● web_search  terminal rendering
    days: 7 · max: 3
  ⎿ Terminal rendering guide — example.org
    Terminal reference — docs.example.net
    Ctrl+O to expand
```

- Call marker and tool name are host chrome. Call summary begins on the same
  physical row when it fits; wrap under the summary's content column, not under
  the marker. The summary portion of that row counts as one of the three body
  rows. If the name leaves no content width, put summary below with the standard
  body indent; never squeeze payload to zero width.
- Result marker occurs once, on the first body row (or failure/status row).
  Subsequent logical lines and wrapped continuations align at the result content
  column. No per-line vertical bars, triangles, duplicate arrows, redundant tool
  name, `Input`, `Output`, routine `completed`, or `Search result text` caption.
- Success needs no status label. Failure, interruption, nonzero exit, partial,
  limited, unavailable arguments, historical missing diff, images and existing
  critical notices remain explicit host-owned text. Hooks cannot hide these.
- Ordinary collapsed call/result: at most 3 wrapped body rows. Actual edit diff:
  at most 8. Preserve diff colors and meaningful line numbers, without adding a
  second ornamental gutter. Semantic summaries do not create an exemption.
- Expanded body: at most 1000 wrapped rows per fold. Generic result retains the
  first 1000 source lines per raw section, independently of wrapping. Calls keep
  the safely retained snapshot; no new call source-line cap. Existing diff
  retention and optional detail cap (100 rows, raw-first allocation) remain.
- Critical metadata and the single host footer are outside body budgets, as in
  prior approval; ordinary hook content cannot become critical metadata. Running
  activity retains its strict 3-total-row budget and existing status/elapsed row.
- Host sanitizes every string before measurement. At widths 1/2 omit decoration
  before content; do not indent away all available columns. CJK/graphemes,
  multiline names, fields and resizes must stay within actual screen width.

For successful web results, use the first source preview as `summary` and the
remaining sources as `preview`: no new result-style API is necessary. Source
labels are ordinary budgeted semantic content styled by the host, never trusted
metadata or terminal escape sequences from the extension.

### Minimal color adjustment (independently approved)

Arguments and result bodies use the terminal's default foreground. Only the tool
name is bold; `●` and `⎿`, metadata notices and omission footers use neutral ANSI
dim. Known failed/exit/partial/limited titles and the interrupted suffix use red,
not the diagnostic or error payload. No inferred success color, fixed RGB palette
or theme setting is introduced. Diff colors and line numbers remain unchanged;
styles are applied after sanitization and width layout with isolated ANSI scopes.
Activity, layout budgets, source counters and caches are unchanged.

## 3. Small optional public contract amendment

Keep existing call/result hooks and existing summary/preview/detail fields. Add
one optional property, supported on call presentations only:

```ts
export interface ToolArgumentPresentationField {
  readonly label: string;
  readonly value: string;
  readonly consumes: readonly string[];
  readonly default?: true;
}

export interface ToolSemanticPresentation {
  readonly summary: string;
  readonly preview?: readonly string[];
  readonly detail?: readonly string[];
  readonly argumentFields?: readonly ToolArgumentPresentationField[];
}
```

Declare alongside the existing core data-only types and re-export the new field
interface from `src/extensions/types.ts`. This is semantic data, not a Component,
ANSI, callbacks, widths, status, omission counts or replacement raw data.

### Ownership, defaults and completeness

- A field's `consumes` explicitly names the top-level argument keys it presents.
  Each listed key must exist as an own key in the detached argument object.
  A key may have exactly one field owner; duplicates within or across fields
  invalidate the structured presentation. Nested paths are not supported.
- A non-default field consumes at least one key. A default field has
  `default: true` and an empty consumes list. These are effective values supplied
  by the extension, not claims that the model sent those keys. Host appends
  `(default)` to its label. The extension must not also render an explicit key's
  effective value as a default; host checks structural ownership, not semantics.
- Host automatically appends all unconsumed own keys in snapshot order under
  `Other arguments`, displaying the actual key and retained value. Unknown keys
  are never silently dropped, even when future extension versions add options.
- Extension field order is display order. The host owns label punctuation,
  wrapping, sanitizing and styling; values may be multiline. Field labels/values
  cannot insert host metadata or suppress errors. The extension owns normalized
  interpretation, including many keys contributing to one effective value.
- The formatted value is not a reversible serialization. Normalized domain
  lists can differ from original order/spelling; query trimming can remove
  whitespace. **Raw access below is mandatory**, not replaced by a completeness
  claim based on consumes. Do not display an “all data shown” badge.
- No `hidden`, `omit`, `lossless`, `complete`, per-field raw override or extension
  omission flags. Host produces all display-crop notices from actual layout.

### Safe validation, without another validator framework

Extend the existing descriptor-based validator and invocation context with a
call/result phase and the existing safe argument snapshot. For `argumentFields`:

1. Allow only on call phase with an available, plain non-array argument object.
   On result phase reject a return containing this property. Old hooks work
   unchanged. Empty field list is valid and leaves every actual key host-owned.
2. Require an ordinary dense array, max 100 fields; each element an own-data plain
   object with exactly `label`, `value`, `consumes`, optional `default`. Reject
   unknown keys, getters, symbols, unsupported prototypes, decorated/sparse
   arrays, and a default value other than literal true.
3. Label: nonempty string <=256 UTF-16 units. Value: string <=16,384 units.
   Consumes: ordinary dense array, <=1000 strings, each <=4096 units; validate
   exact own-key membership and uniqueness with a Set (including `__proto__`).
   Default/non-default ownership rules above are mandatory.
4. Charge labels, values and consumes key strings against the existing combined
   100,000-unit returned-text budget, together with summary/preview/detail.
   Copy and recursively freeze accepted arrays/records. Catch reflective errors.
5. An invalid field rejects the entire call presentation and uses the existing
   generic raw call fallback; do not accept a partially hiding field list.
   Preserve existing rejected-promise handling and snapshot limits. Never
   retraverse original event arguments to repair a rejected presentation.

Synchronous hooks remain trusted in-process code, not a sandbox. Field validation
cannot establish that a normalized value is truthful. Raw snapshot access is the
inspection mechanism; hook errors do not change execution or model messages.

## 4. Expanded readable calls and separate raw diagnostics

Default expanded calls with valid fields show a host `Arguments` caption and
labeled values, not a JSON object or repeated query summary:

```text
● web_search
    Arguments
    Query: terminal rendering
    News days: 7
    Max results: 3
    Include domains (default): none
    Exclude domains (default): none
    Full content (default): off
    Alt+O: raw arguments
```

Fields replace the ordinary call JSON section only in readable mode. Do not
prepend the same summary/detail again for these calls. Render unknown scalar
strings as quoted JSON strings to preserve whitespace/type distinctions; nested
unknown objects/arrays use JSON beneath their key. This limited JSON fallback is
intentional and preferable to inventing a recursive UI. Unknown/null/false/empty
values must remain distinguishable. Calls without valid fields keep their
existing generic presentation and raw expansion.

### Key choice grounded in current support

The actual shell handler expands **all** ordinary and tool folds if any are
collapsed, otherwise collapses all. Its older class comment saying newest-only
is stale; implementation, not that comment, defines the invariant.

Inspected `@earendil-works/pi-tui` 0.82.0 `dist/keybindings.js` and `dist/keys.js`:
no shipped editor or selector binding uses Alt+O. Repository search found no
Alt+O handler. A read-only `matchesKey` probe verified legacy ESC+o matches
`alt+o`, legacy control-O matches only `ctrl+o`, and Kitty `ESC[111;6u` matches
`ctrl+shift+o` but not `ctrl+o`. Ctrl+Shift+O is not reliably distinct from Ctrl+O
on legacy terminals, so do not use it. Ctrl+R also appears unassigned in the
current TUI defaults, but is conventionally history search; avoid claiming it.

**Alt+O toggles one transcript-local boolean `rawToolArguments`, initially false.**
It affects all tool call folds that have valid structured arguments, not generic
text/thinking folds and not result folds. It does not change any expansion bit.
Collapsed content remains compact in both modes. Expanded eligible calls switch
between labeled fields and the independently retained original argument JSON
captioned `Raw arguments`. A footer says `Alt+O: readable arguments` in raw mode.
The same 1000-wrapped-row cap and truthful omission footer apply in both modes.

Use the transcript's existing tool-fold list to propagate the flag; newly
appended/replayed folds inherit it. Cache key includes width, expanded and raw
mode. Setters invalidate only affected layout; no hook is reinvoked by toggling.
Conversation clear resets the boolean; replay after clear starts readable. No
session/settings persistence or new per-tool interaction state.

Handle the key only when no selector or pending ask owns input and at least one
eligible tool call exists. Otherwise pass through without changing state. Respect
existing key-release/paste handling. Alt+O works as Escape then o when the terminal
sends them as one alt sequence; separately dispatched Escape remains the existing
interrupt/cancel action. Do not add timing heuristics or delay Escape. This input
transport limitation must be documented rather than claiming universal keyboard
availability. A collapsed eligible call's one footer advertises both actions:
`Ctrl+O to expand · Alt+O: raw arguments on expand` (or readable when selected).

Results do not need a second raw mode: Ctrl+O still reveals original `Result text`
and any distinct `Live display`, including warnings, URLs and original formatting.
Raw means the retained safe diagnostic representation, not original transport
bytes, unescaped ANSI or unlimited output. Unavailable snapshot diagnostics and
existing caps remain honest and visible.

## 5. Web-search extension changes, not host special cases

Only `_lib/presentation.mjs` interprets web-search arguments and response text.
No search-name check, Tavily parser, domain extraction, or search-specific labels
in core/repl. Keep `normalize`, execution, `formatResults`, cache entries, tool
return content, model messages and stored history unchanged.

### Calls

Summary is the normalized query. Compact preview shows `days: N` when present and
`max: N` when non-default (5 omitted even when explicitly requested). Omit full
when false; show `full: requested (bounded)` when true. Show nonempty include and
exclude filters as budgeted preview text. Combine short days/max options onto
one line before domain lists. Expansion presents every effective option:
Query, News days (when absent, `not requested`), Max results, Include domains,
Exclude domains, Full content. Mark absent options as defaults using the contract
above, not by comparing values to defaults. Explicit false, explicit 5 and empty
lists are explicit values, not defaults. Each present known key is consumed
exactly once; unknowns are automatically displayed by the host.

Invalid normalization returns undefined, giving generic original arguments. No
credential/config access or new I/O in any hook.

### Results

Keep the conservative current envelope/parser validation. On accepted nonempty
text use one source per semantic line: `Title — hostname` (URL.hostname, including
subdomains; do not pretend to compute registrable domains). Original full URLs
remain on expansion. Host wraps/styles these ordinary semantic rows. No API-total,
parsed-entry or returned-source count; requested max belongs only to the call.

On rejected/ambiguous successful text return the honest neutral summary
`Search response`, without extracting partial source facts. This is extension-local
fallback; missing hook/extension or invalid return still uses host generic text.
Errors and image-bearing responses return undefined so host generic diagnostics
remain primary. Exact recognized empty envelope may say `No results reported`.
Never claim a parser rejection means no sources or a failed tool execution.

Original result expansion retains the untrusted-evidence warning, query envelope,
source URLs, snippets, full-content markers and formatter omissions, regardless
of parser acceptance. Avoid redundant semantic detail duplicating the whole raw
response: shipped search hook can omit detail and let original result expansion
supply it. An accepted formatter omission marker can remain budgeted quoted text
(`Result text reports: ...`), not a host source count or critical notice. The one
host footer must not promise complete API content; tool/formatter limits and host
view limits are different.

## 6. One footer and exact collapsed-error deduplication

Build a single host-owned footer per fold from independently tracked facts:
semantic view cropped rows, retained raw-section source omissions, expanded-view
wrapped omissions, expansion availability, and raw-mode action. Join facts once
with separators; wrap the footer at terminal width. One footer may span physical
rows and may contain per-section counts; it must not erase those counts just to
force a single line. Eliminate the current unconditional second semantic hint.

Only advertise Ctrl+O when expansion exposes additional retained content or a
useful alternate readable/raw section, never as a remedy for discarded source
lines or rows beyond the expanded cap. Do not subtract semantic row counts from
raw rows or invent a count for summarized sources. Expanded raw/display sections
keep distinct omission counts; optional detail cannot starve original results.

For collapsed errors only, suppress a body line when it is exactly equal to the
host-promoted error diagnostic line **before display sanitization**, with no
trimming, case folding, prefix matching or fuzzy matching. Retain original raw
line identity alongside the safe display representation for this comparison;
never re-read mutable event content. Compare only the promoted error line, not
arbitrary status/notice metadata, and preserve every distinct line. Differences
that sanitizer would erase must not cause deduplication. Keep explicit `failed`
status even when the repeated diagnostic is removed. Apply budget/counting after
this intentional duplication removal, not as a crop. Do not display `(no output)`
when all error body lines were duplicates. Expanded original text retains all
lines, including duplicates. No execution/result mutation.

## 7. Implementation boundary and verification plan (after review only)

Expected code touch points: core presentation type and extension re-export;
safe hook validator and invocation phase; immutable call block fields/raw data;
ToolBlockFold layout and footer; transcript-local raw mode and shell Alt+O;
extension-local web-search presentation; tests and web-search documentation.
Do not change task source identity plumbing, core execution, provider schemas,
result text, session format, print/legacy renderer or generic `format.ts`.

Deterministic tests (no credentials/network):

1. Validator: existing hooks unchanged; valid fields, multi-key ownership,
   defaults, unknown keys automatically shown; duplicate/nonexistent consumed
   keys, bad defaults, result-phase fields, primitive/array args, limits, nested
   accessors, proxies, promises, symbols, sparse/decorated arrays. Original
   snapshots and returned values remain detached/frozen. Rejected presentation
   falls back without invoking getters/toJSON or suppressing failures.
2. Web calls: defaults, explicit default values, all options, long filters,
   unknown historical keys, whitespace query, domain normalization/order,
   invalid args. Expanded readable fields plus raw mode demonstrate original
   values still reachable. Compact off/default options omitted, defaults labeled
   only when absent. Pure helpers must perform no I/O.
3. Web results: zero/one/many, fewer entries than requested maximum, malformed
   envelope, delimiter ambiguity, truncation, source-like snippets/full content,
   invalid URLs/credentials/controls, parse rejection and errors. Title/domain
   previews have no counts or redundant caption. Search response fallback does
   not imply source facts. Original warnings and URLs remain expanded.
4. Golden layout: call/result markers once, continuation columns, combined first
   call row budget, ordinary 3/edit 8/expanded 1000, source cap 1000, width 1/2,
   CJK, ANSI, multiline fields, diff colors/line numbers, images and all failure
   statuses. Single footer with truthful per-section omissions and no duplicate
   hint; raw/display retention counts separate from semantic screen rows.
5. Error dedupe: exact repeated line removed only collapsed; near match,
   whitespace difference, sanitizer-colliding strings and distinct details kept;
   expanded text byte-equivalent before terminal sanitization; status retained.
6. Fake terminal: Ctrl+O any-collapsed/all-expanded policy unchanged for mixed
   thinking/tool folds; Alt+O changes no expansion bit, affects all eligible
   calls, passes through when ineligible, cannot steal selector/ask/paste input;
   legacy ESC+o and enhanced protocol inputs, key releases, unchanged Escape
   interruption. New folds inherit mode, clear resets, replay/live agree.
7. Hook invocation counts stable across render/resize/raw/fold toggles; layout
   cache hits when unchanged, invalidation on all mode/width transitions. Existing
   child source identity, orphan/interrupted lifecycle, print/legacy, provider
   request and model/session invariants remain covered by their regression tests.

After implementation and independent code review run the inspected project
scripts: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, plus
focused presentation/TUI tests during development. Keep existing local caches;
no installs or external side effects. Report exact test totals and failures.
Design-only verification is inspection and documentation checks, not a claim that
future behavior has passed tests.

## 8. Review gate and risks

Stop at this document. Require independent fresh-context adversarial review of
this revision before code. Independent code review is also warranted later due
to public API validation, raw-data reachability and shell interaction changes.

Review especially: consumed-key ownership without a false losslessness claim;
default provenance and unknown fields; malformed return whole-phase fallback;
separate raw access with unchanged Ctrl+O and input precedence; legacy Alt sequence
limitations; the shared first-row body budget; exact pre-sanitization error
deduplication; one footer without lost per-section omission information; count-free
source parsing that cannot prove provenance. Accept that extension text may still
misdescribe values, raw display is capped/sanitized, and old history uses current
hooks. None warrants changing model content or adding a framework in this batch.
