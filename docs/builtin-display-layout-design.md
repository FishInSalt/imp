# Builtin display layout: four follow-up improvements

Status: COMPLETE — independent design and implementation reviews closed; recorded verification and final acceptance are summarized below.

Closeout context: this document retains its original design-stage observations, branch references, requirements and planned verification as historical records. Closeout is on the existing `integration/builtin-display-final` branch. Later reviewed designs supersede earlier requirements where explicitly noted. This documentation-only closeout changes no runtime behavior or policy and does not rerun or newly claim the recorded implementation tests. Final manual acceptance is recorded in `builtin-display-diagnostics-design.md`.

Workspace: `/Users/z/Z/Agent_demo/imp-builtin-display`.
Branch: `feat/builtin-display-layout`, based at `8a029b6`.

## 1. Starting state and change boundary

Inspection found the requested dedicated branch already checked out. Its reflog records the checkout from `feat/builtin-display-polish`; HEAD remains `8a029b6`. An attempt to create the same branch failed because it already exists; no branch replacement or reset occurred. All existing uncommitted polish changes are the starting implementation, not changes to discard. This task adds only this design document: no code edits, commit, merge, main modification, or edits to the preceding polish design.

The four approved improvements are:

1. In expanded results, omit a shortened host truncation notice only when its complete original notice and all contributing completeness facts are actually visible in raw result sections.
2. Omit the generic `Arguments` / `Result text` caption only in a single-section normal view. Keep `Raw arguments` distinguishable and preserve captions for multiple result sections.
3. Put the path first after the tool name for builtin read/write/edit/ls calls, with exact ownership, safe cropping, full-path accessibility, and no redundant complete Path row.
4. Preserve actual newlines in collapsed builtin bash command previews; render multiline argument fields with a separate label and indented body, preserving payload whitespace and edit old/new content.

These are presentation-only changes. Do not alter edit's dual result receipts (`Result text` versus live diff), deduplicate its result sections, implement prose word wrapping, change third-party hooks, add public hook capabilities, modify execution/output/history/serialization, or run tools to infer facts. Existing polish behavior not explicitly superseded here remains the base contract.

## 2. Inspected implementation and gaps

Inspected `src/core/tools/presentation.ts`, `src/repl/tool-presentation.ts`, `src/repl/components/tool-block.ts`, `test/builtin-display-polish.test.ts`, and `docs/builtin-display-polish-design.md`, together with git status/diff statistics.

Current facts:

- `HostNotice` has `kind`, original `raw`, shortened `text`, optional artifact completeness/interruption/prefix-cap facts, and `sources: { section: string; index: number }[]`. Sources are discovered from unsanitized content and display text. The renderer currently appends every host notice even in expanded mode.
- `RawSection` has caption, retained sanitized lines, optional original lines, discarded source-line count and optional diff flag. Identical content/display produces only `Result text`; differing display produces a second `Live display` section. Notice discovery still scans both logical sources, even if display is absent or equal to content.
- Ordinary raw sections retain at most 1000 source lines; physical expanded rendering has a separate shared 1000-row cap. Captions currently occupy that cap, including an empty caption. Semantic detail is additive, at most 100 rows and at most the remaining capacity after the raw plan. Host notices are outside that body budget.
- The expanded plan records section object, source line, wrap part, text, prefix and style. Its `lineEnds` map is keyed by line number alone, so equal indices across sections collide. `rangeReached` does not restrict by section; partial coverage checks also count label-only rows. These shortcuts cannot decide notice suppression or new field coverage safely.
- `ArgumentCoverage` records readable and raw line ranges, individual `rawRanges`, value and path ownership. Readable lines are currently built with `Label: value`; multiline content therefore begins on the label line. Unknown arguments are appended separately and use the same inline-first-row format. Coverage is manually calculated in parallel with formatting.
- Paths already have host `callPath` data with exact requested/display values and a validated field index. Complete expanded path fields can suppress the host Path row. Collapsed paths are separate rows after a summary-first header.
- The header's first summary row uses the complete header as its prefix; wrapped continuation rows inherit its full width in spaces. This leaves unnecessarily little width and must not become the multiline command continuation rule.
- Builtin `excerpt` converts LF into literal `\\n`. Bash currently uses it for the summary. Full Command remains literal in the readable field. Edit Replacements already has deterministic oldText/newText headings and nested indentation; that value must not be reformatted internally.

## 3. Shared layout and coverage contract

Use one selected-view physical-row plan for rendering, completeness decisions, omission counts and expansion hints. Extend private render-local data only. The following identities and rules are required; exact type names may differ after review.

### 3.1 Stable identities and raw source mapping

- Assign each selected section an internal stable ID distinct from its caption and array position after caption filtering. Example roles are arguments-readable, arguments-raw, result-content and result-display; occurrence indices distinguish repeated sections if needed.
- Identify a source occurrence as `(source ID, original line index)`, and a source span as that occurrence plus a half-open raw character range. Preserve UTF-16 indices consistently with existing string operations. Preserve raw identity before sanitizing.
- Each physical row records its section ID and source/value span(s), plus whether it is caption, label, structure, payload, or host chrome. Wrapped continuation segments have explicit start/end offsets; a wrap-part number alone is not a completeness proof when prefixes differ between views.
- Key completion data by section/source identity AND index, never by index alone, displayed text, or caption. Keep repeated identical lines as separate occurrences. Never compare trimmed text, whitespace-normalized strings or sanitized strings to prove ownership.
- Result sections reference their original content/display source spans. An absent/equal display is an explicit alias to the content source actually rendered, not an invented second visible section. If content and display differ, keep separate identities even when one individual line has equal spelling.
- Any existing diff transformation that cannot supply an exact original-span map is not eligible as proof for dropping a host notice. Do not infer offsets from transformed line numbers. This batch need not redesign edit result sections to obtain such proof.

Sanitization remains mandatory. Coverage means the entire safe rendering of an exact raw span was emitted, not that terminal escape bytes were executed or displayed literally. A sanitizer collision cannot make a different raw occurrence cover the target. Glyphs defensively clipped at extremely narrow widths do not prove lossless full-value display; keep accessibility/fallback evidence rather than claiming complete coverage.

### 3.2 Budgets and captions

Retain three collapsed body rows (eight for existing unstructured edit diffs), 1000 expanded body rows shared across selected sections, ordinary raw source retention of 1000 lines, and semantic detail `min(100, max(0, 1000 - raw planned rows))`. Keep all existing validation budgets: field value 16384, label 256, fields 100, summary 4096 and total 100000. Do not silently truncate semantic fields to meet them.

Only emitted captions consume rows. A hidden caption contributes zero rows, not a blank row; source indices remain unchanged when a caption disappears. Omission messages retain internal section names even if captions are visually omitted. Raw retention loss and physical wrap loss remain separate counts. Host notices/header/path accessibility chrome remain outside the body budget and do not generate body omissions.

Plan the actual widths and prefixes. The call's first inline payload can use the remaining header width. Subsequent body lines and wraps use the fixed four-column body indentation, not spaces equal to the entire header's width. A multiline field body adds two layout spaces beneath its label; continuation rows use that field-body indentation. At widths that cannot accommodate a prefix, remove/reduce presentation indentation according to the existing narrow-width safeguard; never trim payload whitespace. Path/header chrome wrapping is a distinct layout operation, not a reason to apply header-width continuation indentation to all body text. Preserve diff numbering prefixes unchanged.

### 3.3 Field/value coverage and serialization safety

Generate readable rows and their coverage together in one formatter, rather than updating offsets with independent string-length formulas. Preserve validated field index, consumed top-level key identity, raw ranges for each consumed key, and readable value spans. A default field with no consumed key has readable identity but no raw JSON range; do not manufacture Infinity-based coverage. Keep multiple consumed-key ranges distinct rather than treating their bounding interval as ownership of intervening keys.

Use only the existing safe detached prepared snapshot and `rawArgsText`. Any raw-key range calculation must agree exactly with that serialization, including escaped keys and multiline JSON values. Do not stringify the original arbitrary call object, invoke getters/toJSON, re-run hooks, or add arbitrary `String(value)`/JSON conversion to the renderer. Unknown fields may use the existing safe snapshot serialization path, but layout/coverage must derive from that same generated representation. Unavailable/invalid snapshots keep current generic fallback.

## 4. Improvement 1: suppress only proven expanded notice duplicates

Scope suppression to recognized shortened host truncation/artifact notices; do not opportunistically remove exit status, diagnostics, image descriptors, task recovery/worktree facts or unrelated metadata. Collapsed behavior remains unchanged.

For each candidate notice, construct required raw evidence spans from its recorded source occurrences and any additional lines that contributed to its displayed facts. After choosing the normal expanded sections and applying retention, caption policy and the 1000-row cap:

1. Find an exact recorded source occurrence in a section actually selected for rendering (or its explicit identical-source alias).
2. Require all wrapped segments of the complete original notice line/span to be emitted. The first half of a line, a same-looking line at another index, or a span lost to source retention is not sufficient.
3. Require complete reachable source evidence for every qualifier in the shortened notice. If all required facts are covered, omit only the added shortened chrome. Otherwise retain its full existing concise wording and all qualifiers outside the cap.

A historical `Full output saved ...` line plus separate `[full output itself capped at 10MB]` illustrates the dependency: the artifact is partial only because of the second source line. Seeing the first line alone must not suppress the qualified partial-output notice. Record that cap dependency explicitly when building typed notices, rather than treating a global boolean as proof of visibility. If both lines are visible, raw evidence is complete and the shortened duplicate may be omitted. The standalone cap notice is separately eligible only when its own complete source evidence is visible.

Keep full/partial/unavailable, interrupted/all-observed, per-stream 10485760-byte prefix cap, historical 10MB cap, save failure, partial-line and continuation/search cap distinctions. Unknown contracts stay raw and are not newly parsed. Distinct raw paths that sanitize alike remain distinct notices.

If a notice occurs identically in both differing content and display, one complete recorded occurrence suffices for its main raw wording; additional contributing facts still need complete recorded evidence. Do not deduplicate either raw result section. If only an unrelated equal string is visible, it proves nothing. Notices after retained line 1000 or partly wrapped across physical row 1000 must remain as chrome.

Suppression does not itself create a Ctrl+O reason: a promoted notice already visible as collapsed chrome is not new payload. Recompute after resize/expand/raw selection; cache keys and invalidation must agree with the selected plan.

## 5. Improvement 2: minimal captions without lost identity

- Single normal readable argument section: omit visual `Arguments`.
- Single normal generic argument section: omit visual `Arguments`; do not pretend it is a structured raw-toggle view.
- Single normal result section whose generic caption is `Result text`: omit that caption.
- Structured raw-argument selection: retain `Raw arguments`, even with one section.
- Multiple result sections: retain their `Result text` and `Live display` captions, including edit's existing dual receipts. Do not eliminate a section because it has equal-looking rows or is empty.
- Keep meaningful nongeneric captions and `Other arguments` grouping. Unknown third-party sections are not renamed or suppressed through heuristic text matching.

Use an explicit caption-visibility decision in the plan. Do not mutate section lines, notice source indices or logical captions. A hidden caption can make the next payload row reachable at the cap; hints and omission counts must reflect that actual extra capacity. Existing tests that manufacture oversized generic captions should be adjusted to use a genuinely retained caption when testing cap exhaustion, not deleted wholesale.

## 6. Improvement 3: path-first builtin headers

Apply only to the actual captured builtin read/write/edit/ls presenters, not any replacement hook that happens to use those names. Use a private trusted builtin association through preparation if needed, without modifying public hook types or trusting a public summary string. Generic fallback and third-party output retain current behavior when ownership is not established.

Normal header order: marker, tool name, path, then optional non-path request/count summary if it fits. The path takes priority over summary space. Examples at sufficient width:

```text
● read  src/repl/tool-presentation.ts
● write  src/example.ts  3 lines · 42 bytes
● edit  src/example.ts  2 replacements
● ls  .  up to 20 entries requested
```

These numbers describe call requests/content, not successful execution.

Ownership proof remains exact: requested string and full validated field consuming only `path`; no label-only or substring inference. The ls missing-path default `.` is explicitly host-owned effective default; explicit empty ls path keeps `"" (effective: .)`. Empty read/write/edit paths must be visibly empty (for example `""`), not misrepresented as effective `.`. Preserve raw identity independently of these display annotations. Never normalize/resolve paths or use a summary occurrence as a path owner.

Per-view policy:

- Collapsed: header owns the path preview. If the complete safe path fits, emit no Path row or duplicate path field. If cropped, show an ellipsis and keep the complete path accessible in expanded normal and raw views. Expansion is warranted by the hidden path suffix only if that suffix is genuinely reachable in the selected expanded plan.
- Expanded normal: show a complete path in header chrome, wrapping with a bounded header continuation prefix when needed, and suppress exactly the owned readable Path field. Do not suppress other fields sharing the same text. Layout spans for remaining fields are regenerated; no stale row offsets.
- Expanded raw: raw JSON is not edited. If the complete raw `path` value is reachable under the cap, it owns the full value; use tool-only header chrome rather than another full path. If not reachable, keep the complete host path in wrapped header chrome. A partial JSON prefix at the cap remains raw evidence, not an additional claimed complete owner. Default effective `.` absent from JSON stays host-owned.

Never rely on cropped header text as full-path coverage. If no structured expansion exists or a safe full expanded path cannot be guaranteed, retain a complete wrapped host path instead of cropping irrecoverably. Multiline/control-containing paths must be escaped safely for header display, not allowed to inject header lines; their original exact value stays available in the normal/raw representation. Header sanitization is not identity normalization.

Do not place a full wrapped Path row beside an already complete header path. In raw mode, completeness evidence—not key order assumptions—decides whether host fallback is needed. Recalculate when width or Alt+O changes. Grep/find path presentation stays outside this path-first change.

## 7. Improvement 4: literal line layout for bash and multiline fields

### Bash collapsed preview

Add a builtin bash-specific bounded excerpt policy that preserves actual LF characters while retaining the existing summary bound and explicit truncation marker. Do not globally change grep/find/task excerpts and do not decode literal backslash-n into a newline. CR, tabs, ANSI/OSC sequences, bidi/format controls and other unsafe characters retain the existing safe escape/sanitization policy. A safe literal LF is the only new line-boundary permission.

The first command line may begin after the bash name. Subsequent logical lines and wraps start at the four-column body prefix, never at the full header width. Blank command lines consume preview rows as real payload. The three-row cap is a physical-row cap after wrapping, not three logical source lines. A command excerpt alone does not cover an omitted command suffix. Normal expanded Command or raw JSON must supply the selected-mode reachability evidence.

### Multiline argument fields

For a field value containing LF, emit its label on a separate line, then indent every value line by two extra layout spaces beneath the normal four-column body indentation:

```text
    Command:
      printf '%s\\n' 'hello'
      printf '%s\\n' 'done'
    Content:
      first line
        already indented line
```

For single-line values retain `Label: value`. Retain the `(default)` annotation on the label. Use exact `split("\n")` semantics so leading/trailing empty lines, repeated blanks and all original spaces survive; do not use the result `lines()` helper that removes a trailing empty entry. Empty strings remain distinguishable under the existing field conventions. Sanitization may escape unsafe controls but must not trim content or prose-wrap it.

Do not reconstruct edit replacements. Treat the validated Replacements value as an opaque multiline field; add only outer layout indentation. Its `Replacement N`, `oldText`, `newText`, payload indentation and explicit empty-string annotations remain byte-for-byte the same semantic value. No dual receipt/result diff change is included.

Apply the multiline formatter to builtin readable fields and builtin `Other arguments` values consistently. Keep exact unknown-key identity separate from its rendered label, including keys containing colons/newlines; never split a label at `:` to recover ownership. Multiline labels, if present, get their own safe label rows and are not value evidence. Preserve unknown values and explicitly supplied default-valued, false, zero or empty arguments. Absent optional fields stay absent per polish. Third-party hook field layout is not changed in this batch; route this formatting through the same trusted builtin association rather than name-only detection.

Coverage must now distinguish label rows from value rows. A label at physical row 1000 with its body beyond the cap does not make the value reachable. An emitted empty value line is a real occurrence; a default field with no raw counterpart is not reachable in Alt+O merely because its normal label is visible. Raw mode remains the unchanged serialized JSON with `Raw arguments` caption, not the readable indentation layout.

## 8. Hint consistency and implementation outline

Compare actual collapsed covered value/source spans to reachable selected expanded spans. Header path previews, command excerpts and promoted notices have explicit identities. A hidden repeated payload occurrence, blank line or value suffix is real additional evidence; a caption, label, indentation change or an already represented notice is not. Do not use equal sanitized spelling or regex-stripped JSON as a substitute for identity in the new paths.

Keep Ctrl+O truthful for both normal and Alt+O-selected expansion, including cropped paths, command lines, unknown fields and cap boundaries. Toggle/resize must reuse prepared semantics without invoking hooks again. Normal-only default fields cannot advertise raw expansion. If a suffix is beyond selected-mode retention/cap, report omission rather than claiming expansion can reveal it. Preserve existing generic/third-party behavior outside the scoped builtin branches.

Expected implementation files after approval:

- `src/core/tools/presentation.ts`: only bash LF-preserving summary policy; no replacement content changes.
- `src/repl/tool-presentation.ts`: private builtin association as necessary; exact source dependencies/section identities; shared readable formatting and field coverage generation.
- `src/repl/components/tool-block.ts`: selected caption policy, exact capped coverage, notice suppression, path-first chrome, fixed body continuation indentation and truthful hints.
- A small private layout helper is acceptable if it keeps formatting and coverage in one place. No public tool schema or hook API extension.
- Existing presentation/polish tests plus `test/builtin-display-layout.test.ts` (new) for focused cases.

## 9. Verification plan: fixtures only

Tests must use captured sample strings, real builtin presentation helpers/factories with mocked execution, safe prepared calls, and scripted in-memory providers. Do not invoke external APIs, actual agents, paid services or user tools/configuration. Any file fixtures belong inside this workspace or designated scratch paths; never read/write actual user example paths.

Required sample/assertion matrix:

1. Bash full/partial/interrupted/capped/unavailable artifact samples from the actual producer contracts already used in `test/builtin-display-polish.test.ts`; expanded raw notice visible means no shortened duplicate. Collapsed concise notices remain. Historical separate cap line visible/hidden, each qualifier dependency hidden, source notice after retention, and long notice partly beyond row 1000 must retain qualified chrome.
2. Result/content equal alias, absent display, differing display, duplicate notices at different indices, conflicting raw paths and sanitizer collisions. A notice at line index 2 of one section cannot be covered by index 2 of another. Do not alter edit's two result sections.
3. Single readable/generic Arguments and Result text caption omitted without blank rows; Raw arguments retained; multiple result captions and meaningful captions retained. Assert exact 999/1000/1001 physical-row boundaries and separate retained-source omissions. Preserve semantic-detail 0/1/100 remaining-capacity cases with retained captions.
4. Read/write/edit/ls path-first sample headers; long paths, requested/empty/default ls, empty required paths, Unicode, controls, multiline path, path substring in unrelated field, identical sanitized/different raw paths, and path key before/after a large unknown/content value in raw JSON. Exactly one complete owner in each view; cropped collapsed suffix accessible; third-party replacement named read unaffected.
5. Bash sample with real newlines versus literal `\\n`, blank lines, trailing LF, long first line, quotes/backslashes, ANSI/OSC/CR/tab/bidi controls, and 16384/16385 fallback boundary. Assert four-column continuation instead of header-sized continuation, exact three-row preview and selected-mode hint.
6. Multiline Content, Prompt and Command; Replacements with indentation, empty old/new text and heading-like payload. Preserve semantic values exactly. Test leading/trailing blank lines, whitespace-only payload, label-only cap boundary, a single partially visible value row, unknown keys with colons/newlines, multiline unknown JSON values and explicit defaults. Check regenerated coverage starts/ends after path removal and caption hiding.
7. Widths 1, 2, 4, 5, 20, 80, 120; visible width never exceeds available columns. Compare actual render plan and hint under repeated expand/raw/resize sequences. Hook invocation counts remain unchanged. No prose wordwrap or modified diff colors/numbers/eight-row budget.
8. Assert rawArgsText, content, display and persisted/model-facing fixtures remain identical before/after layout. Schema and captured resolver regressions remain covered.

Planned commands after implementation and review approval: `npm run typecheck`; `npx vitest run test/builtin-display-layout.test.ts test/builtin-display-polish.test.ts test/builtin-tool-presentation.test.ts test/builtin-visual-verification.test.ts test/tool-display-refinement.test.ts test/tool-presentation.test.ts test/tool-presentation-hooks.test.ts test/tool-presentation-integration.test.ts`; then appropriate full `npm test`, `npm run build`, and changed-file lint. Inspect test setup first to ensure no API/user-file side effects. Report actual counts and failures, not assumed success.

For this design-only task, verify documentation existence/whitespace and that the prior tracked diff and untracked polish files are unchanged. No code/test execution is required or claimed.

## 10. Historical review gate

The planned gate required independent adversarial design review before code and independent implementation review afterward. Review focus included section/index identity, aliases, qualifier dependencies, cap completeness, captions, path ownership, trusted builtin scoping, multiline coverage and selected-mode hints. These reviews have closed; the original design-stage stop condition is historical.

## 11. Completed review and closeout

- Independent design and implementation reviews completed; recorded verification: **1863 tests passed across 95 test files**.
- Review corrections covered raw control-containing path coverage, the `漢` path at width 1, and bash excerpt source spans. Independent review also identified clipped-glyph coverage of independent ASCII content; this was fixed.
- This design supersedes the preceding polish path-placement requirements for read/write/edit/ls. The later diagnostics design refines expanded diagnostic ownership and trusted scalar field coverage without reverting these layout requirements.
