# Builtin display polish

Status: COMPLETE — independent design and implementation reviews closed; recorded verification and final acceptance are summarized below.

Closeout context: this document retains its original design-stage observations, branch references, requirements and planned verification as historical records. Closeout is on the existing `integration/builtin-display-final` branch. Later reviewed designs supersede earlier requirements where explicitly noted. This documentation-only closeout changes no runtime behavior or policy and does not rerun or newly claim the recorded implementation tests. Final manual acceptance is recorded in `builtin-display-diagnostics-design.md`.

Workspace: `/Users/z/Z/Agent_demo/imp-builtin-display`. Existing dedicated branch: `feat/builtin-display-polish`, clean at inspection, based on `8a029b6` (`feat: add readable builtin tool call presentations`). This task creates only this document: no additional branch, commit, merge, or main edits.

## 1. Scope and observed implementation

Improve terminal presentation only:

- Give paths one explicit display owner per selected view, rather than repeating them in a summary, Path metadata, and expanded argument fields.
- Show a nonzero bash exit once in collapsed presentation; do not spend preview rows or omission notices on its promoted duplicate or host separators.
- Move concise truncation/artifact notifications after the preview; retain complete artifact paths, completeness qualifiers, and recovery facts without repeating model instructions or referring to invisible output “above”.
- Add bash and edit call hooks using the existing argument-field API.
- Reduce absent defaults and verbose labels in the existing six call hooks.
- Preserve edit result diff colors, line numbering, and its eight-row collapsed budget.

Inspected sources: `src/core/tools/{presentation,types,bash,edit}.ts`, `src/core/{messages,loop}.ts`, `src/repl/{tool-presentation,tool-presentation-hooks}.ts`, `src/repl/components/tool-block.ts`; `docs/builtin-tool-presentation-design.md`; `test/builtin-tool-presentation.test.ts` and the relevant presentation test assertions. Regression suites also include the builtin integration, display colors/polish/refinement, hook, tools, output-integrity, search, ls and task tests.

Current facts driving this design:

1. `preparedInputBlock` creates Path metadata independently of validated argument fields; builtin summaries also contain paths. Expanded rendering shows metadata before full fields.
2. `outputBlock` recognizes complete historical notice lines, promotes them into metadata, but normally leaves them in the body. Bash `Exit code: N` produces both a title and metadata. Ordinary body blank rows still consume preview rows.
3. `ToolBlockFold` renders metadata before the body. Its reachability checks use whitespace removal and substring tests, which are insufficient evidence that one field or repeated line has already been shown.
4. Bash has structured `exitCode` in `ToolExecuteResult`, but `loop.ts` does not forward it to `ToolResult`. This design does not assume it is present in history or live UI results.
5. Bash has no default timeout when omitted. Its positive finite timeout is not the search-tools' clamped 1–600 seconds timeout.
6. Edit's model content is a one-line result; its live `display` contains the diff. Those contracts must not change.

## 2. Non-goals and compatibility boundary

No changes to tool parameter schemas, model descriptions, argument execution, output/content/display bytes, provider serialization, sessions, persistence, print/legacy output, tool selection, permissions, external APIs, or user configuration. No executing tools to discover presentation facts. No filesystem path resolution or normalization in hooks. Historical results must remain readable without migration.

Keep `ToolSemanticPresentation`, `ToolArgumentPresentationField`, hook validation and their public contracts unchanged. In particular do not add nested ownership keys to `consumes`, loosen validation, or consume an argument while retaining only an excerpt. Internal `ToolBlock`/layout data may gain optional typed fields; these are render-local, not tool schemas or persisted message fields.

This explicitly supersedes the first-batch design's acceptance of duplicate Path metadata and its choice to print every absent default. It does not authorize general result summarization or new inferred counts.

## 3. Call paths: explicit ownership, not string deduplication

Use the existing full Path field as the semantic owner. Builtin helpers will no longer put paths in their free-form summaries. The host may put a separately owned path beside the call header when space permits; otherwise it is a separate wrapped Path row. It is not rediscovered by searching summary text.

Introduce an internal call-path record on `ToolBlock`, with the original requested string, safe display string, and ownership evidence identifying the full validated field (or the existing generic path metadata fallback). For a supplied path, semantic ownership requires a field consuming exactly `['path']` whose complete value is either the requested string or the exact builtin empty-path annotation. No label-only matching. Never resolve `.` or collapse separators. A field consuming multiple keys, an excerpt, or an unrelated field with the same value does not prove ownership. Missing-path defaults can be represented separately as host-owned effective `.` for grep/find/ls, without pretending a key was supplied.

Per-view policy:

| View | Path owner |
| --- | --- |
| Collapsed builtin call | Host call-path chrome, optionally placed next to tool name; builtin summary contains only non-path information |
| Expanded readable call | Complete Path field; no additional host Path row if that field is actually reachable in the 1000-row budget |
| Expanded raw arguments | JSON `path` value, if the complete value is reachable; otherwise keep the host path row |
| Unstructured/invalid hook fallback | Existing generic Path chrome; no heuristic removal from arbitrary JSON or summaries |

The generic host must not remove paths from third-party hook summaries. It can tolerate repetition there rather than infer meaning. Restrict new builtin summary conventions to the attached builtin hooks, not a name-only replacement presenter.

Chrome paths wrap without ellipsis. If header space only accommodates an excerpt, the full path must also remain in a wrapped Path row; preferably wrap the path directly rather than create that duplication. A summary containing a path excerpt, a path appearing as a substring of another value, whitespace-normalized equality, or ANSI-sanitized equality never proves full-path coverage. Raw path identity is retained before sanitization. Multiline/control-containing paths receive the same terminal escaping as other chrome. Explicit empty path must retain `\"\" (effective: .)` for tools where that is the execution behavior.

This intentionally favors a separate, truthful Path row over a compact but ambiguous path embedded in free-form prose. Summaries for write/read/edit become counts or request information; grep/find retain pattern and supplied filters/type; ls states a requested entry limit only if supplied. No empty summary should consume a blank preview row.

## 4. Call hooks and quieter field policy

All hooks remain synchronous, deterministic, pure, call-only, and attached to actual Tool objects. Existing captured-hook lifecycle and safe detached snapshots remain authoritative. Unknown top-level keys remain under Other arguments. Wrong types or semantic budget overflow fall back for the whole call, without retrying serialization of the original object.

### Existing six hooks

Required supplied fields remain complete. Validate known optional fields even if they will not be displayed. Omit fields for absent optional values except effective Path `.` for grep/find/ls, which has a concrete navigational purpose. Always show explicitly supplied false, zero, empty strings, or values equal to defaults. Retain original numeric requests and effective-value annotations when producers floor/truncate/clamp them.

- write: Path, Content; summary `N lines · B bytes` using the existing exact writer count rules.
- read: Path; supplied `Start line` and `Line limit`. Summary only includes supplied request bounds (otherwise empty). Do not imply a returned range. The actual read cap remains documented by the tool and reported when reached, not repeated in every field label.
- grep: Pattern, Path, then supplied `Glob`, `Ignore case`, `Literal`, `Context lines`, `Line limit`, `Timeout (s)`; summary is the pattern excerpt plus supplied nonempty glob. Do not count matches.
- find: Pattern, Path, then supplied `Type`, `Line limit`, `Timeout (s)`; omit absent “both” from summary. Do not invent unsupported filters.
- ls: Path and supplied `Entry limit`; optional summary says `up to N entries requested`, retaining the effective/requested distinction in the field.
- task: Prompt, then supplied Agent, `Timeout (ms)`, Worktree. Summary retains supplied agent and prompt excerpt; no rows claiming resolved inherited configuration. Omitted agent can still be called `generic subagent` in the summary, as today. Explicit false worktree stays visible.

### bash

Add `bashPresentation` and attach it in `createBashTool`.

- Required string `command`: full literal multiline value in `Command`, consuming only `command`.
- Supplied `timeout`: positive finite number in `Timeout (s)`, consuming only `timeout`; no clamp, rounding, search default, or fabricated absent timeout.
- Summary: bounded command excerpt; all full text remains reachable through Command or raw fallback. Unknown keys remain unconsumed.
- Empty command may display as empty without suggesting success; execution still rejects it. Non-string command or invalid timeout falls back rather than legitimizing execution coercions.

### edit

Add `editPresentation` and attach it in `createEditTool`.

- Required string Path consumes only `path`.
- Required nonempty edits array: every element must be a plain snapshot object containing exactly string `oldText` and string `newText`. Nested unknown keys trigger whole-call generic fallback: the current API cannot retain them in Other arguments once `edits` is consumed.
- One field `Replacements` consumes only `edits`. Its complete value is a deterministic readable sequence: `Replacement 1`, `oldText:`, indented literal old text, `newText:`, indented literal new text, then subsequent replacements in original array order. Indent every payload line, including empty lines, so payload labels cannot be mistaken for structural headings. Empty old/new strings are explicitly shown as an empty value, distinguished from the literal text `\"\"` by an outside-payload annotation.
- Do not allocate one consuming field per edit: duplicate `edits` ownership is invalid. Do not use `edits[0].oldText` as an ownership key.
- Summary: `1 replacement` or `N replacements`, never “applied”. Full Path is host/field-owned as above.
- Preflight all complete formatted values, including indentation and headings. Field length 16384, label 256, 100 fields, summary 4096, total 100000 remain unchanged. Oversized arrays/text fall back to safe generic JSON; no partial semantic array and no silent suffix loss.

Edit output parsing, `content`, `display`, hunk colors, numbering and eight-row preview remain unchanged. Readable replacements are not a synthesized result diff.

## 5. Internal result notices and historical parsing

Replace free-form promoted notice strings internally with optional typed host records. Suggested discriminated kinds: `exit`, `truncation`, `artifact`, `continuation`, `partial-preview`, and `diagnostic`. Each record carries source identity (Result text or Live display, exact original line index/range and raw text), display wording, and recognized facts. Artifact records distinguish full, partial, and unavailable; partial reasons distinguish interrupted, prefix-capped, and both. Unknown/unparsed facts stay in original text rather than becoming guessed structured values.

This is a ToolBlock extension only. Do not change ToolExecuteResult, ToolResult, loop events, sessions or hook contexts in this batch. The existing textual parsing limitation is explicit: command stdout can imitate an entire producer notice. Anchoring reduces false matches but cannot authenticate arbitrary text. A future trusted producer channel needs separate review.

Parse original unsanitized text with the existing exact, anchored contracts, not substring matches or loose `error`, `truncated`, `saved to`, or `Exit code` searches. Sanitize only after identities are recorded. Do not expand critical classification to new unknown messages. Keep current supported historical forms and existing task partial/limited and search interruption handling. Extension result text must not become a critical builtin notice merely because it contains a keyword.

Collapse duplicate notices only when kind and complete recognized facts/raw contract match; associate all matching source occurrences with that one display record. Distinct paths, codes, qualifiers and raw diagnostics remain distinct even if terminal sanitization makes them look equal. If multiple conflicting nonzero exits are present, preserve the conflicting evidence; do not silently pick one. A single recognized exit becomes the existing `exit N` status, with no additional `Exit code: N` chrome or collapsed body occurrence. Expanded raw result sections retain every original line.

For errors, retain the existing first-nonblank raw diagnostic as authoritative identity. Suppress only exact matching raw occurrences in the collapsed body. A line which merely sanitizes to the same visible text is not its duplicate. Keep `isError` and actual interruption/partial/limited facts independent of truncation. No successful-looking semantic summary may override an error or a partial outcome.

## 6. Post-body notifications

Render result order as: status/primary diagnostic; budgeted payload; concise host notices; omission/expansion hints. Image descriptors and task recovery/worktree information remain reachable and must not be discarded as ordinary duplicate prose. Only recognized truncation/artifact contracts receive abbreviated wording in this batch; retain nontruncation recovery text if a faithful concise mapping is unavailable.

Examples of UI-only wording:

- `Output truncated; tail preview. Full output: /tmp/imp-output-….log` (actual complete path, not this illustrative ellipsis).
- `Output truncated; tail preview. Partial output: <full path> (interrupted; all observed bytes retained).`
- `Output truncated; tail preview. Partial output: <full path> (prefix capped; 10485760 bytes per stream).`
- Combined interruption/cap retains both reasons. Saving failure becomes `Output truncated; tail preview. Output artifact unavailable (save failed).`
- A partial stdout/stderr line stays `stdout preview starts within a line` or its stderr equivalent.
- Read continuation keeps line range, total if known, limiting condition and exact next offset. Oversized-line guidance must retain the needed command/path if no concise faithful replacement is available.
- Search truncation keeps shown count, exact total versus lower bound/unknown, collection/byte cap and a short `Narrow the search` instruction. Never turn line counts into match/file counts.
- ls keeps entry/byte cap and the actual next-limit or narrow-path instruction; type-unavailable notices retain their counts.
- Task tail truncation retains `last 50KB` and dropped-byte count. Historical MCP tail notice remains explicitly a tail cap.

Never use “shown above”: the UI may have shown only three rows of the tool's own preview. Distinguish tool truncation from UI fold omission. Artifact paths wrap in full and are never interpreted as links, opened, or normalized. Notices are host chrome outside the body cap, not silently ellipsized to fit it. Original model instructions remain byte-for-byte in expanded raw sections and in model/history data; only collapsed UI wording is shortened.

## 7. Row accounting and truthful hints

Build a shared selected-view layout plan before rendering, rather than separately guessing reachability from rendered strings. Each row carries source/field identity, occurrence index, section identity, raw identity, sanitized text and wrapping information. The plan must model captions, diff number prefixes and indentation at the actual width.

Maintain three distinct categories:

1. Raw retained evidence: original sections, source-line retention/discard counts, and ordered occurrences. No global Set or whitespace normalization.
2. Collapsed presentation: exact promoted notice/diagnostic occurrences removed; blank separator runs at the boundaries of those removed host notices may be removed. Do not remove arbitrary internal payload blank lines or repeated data. In particular duplicate payload rows are real occurrences, not duplicate metadata.
3. Selected expanded mode: readable fields plus Other arguments, or raw JSON; result raw sections unchanged. It has its own 1000 wrapped-row budget including captions.

Track which rows were intentionally represented by host chrome, which host separators were intentionally removed, and which payload rows were omitted by a cap. Promoted duplicates and their removed separators do not generate wrapped-row omissions. Payload blanks and duplicate payload occurrences that are genuinely hidden do count. Never deduplicate all equal strings to make counts smaller.

Caps remain three wrapped body rows collapsed, eight for unstructured edit diff results, and 1000 expanded across sections. Retain the existing source-line retention policy (1000 for ordinary result sections; diff behavior unchanged) separately from wrapped-row caps. Preserve section-specific source discard counts even if notices were discovered after the retained prefix.

Offer Ctrl+O only if the selected expanded mode can reveal a payload occurrence/field value not already represented by collapsed content/chrome within that mode's 1000-row cap. Formatting-only captions, indentation, blank JSON structure and promoted notices do not justify the hint. A reachable hidden blank payload row or repeated data occurrence is real content; equal spelling elsewhere is not coverage. Do not offer expansion solely for suffixes beyond the selected expanded cap. If content is hidden but unreachable, report the actual omission instead.

For fields, compare explicit identity and exact covered value ranges, not `includes`, stripped whitespace or regex searches for a raw key. A command summary excerpt cannot cover the whole Command field. Path coverage follows section 3. Unknown-field reachability derives from the actual JSON/readable layout, not splitting labels on `:` (keys may contain colons/newlines). Reuse the plan for both rendering and hints so width changes and Alt+O select the same cap calculation. Hooks must not run again on resize or toggle.

## 8. Implementation boundaries after approval

Expected files:

- `src/core/tools/presentation.ts`: quieter six hooks; pure bash/edit helpers.
- `src/core/tools/{bash,edit}.ts`: attach hooks only, no execute changes.
- `src/repl/tool-presentation.ts`: internal path/notice identities, exact historical notice mapping and collapsed projection; retain original sections.
- `src/repl/components/tool-block.ts`: per-view ownership, shared layout/coverage calculation and post-body notification order. A private repl layout/notice helper module is acceptable to keep this manageable.
- Existing presentation/display tests plus focused new tests if needed. No public type/schema or persistence changes expected.

Avoid broad renderer cleanup, changes to styling themes, and unrelated tool behavior. If the internal layout cannot express faithful ownership without public hook changes, stop and revise this design rather than add an undocumented API.

## 9. Verification and acceptance cases

Design-only task: inspect and check the documentation diff; do not run external APIs, real task providers, user agents or user configuration. After approval, implementation tests must use workspace/scratch fixtures and scripted providers only.

Required regression/acceptance coverage:

- Real factories attach all eight call hooks; captured resolver behavior, replay, orphan results, replacement tools, reverse-order results, unavailable/unsafe snapshots and one invocation per call remain unchanged.
- All six hooks omit absent optional defaults, preserve explicit default-valued/false/zero/empty arguments, reject invalid known arguments and retain unknown keys. Verify existing floor/clamp/truncation distinctions.
- Path cases: exact short path, long/excerpted path, multiline/control path, Unicode, empty path, absent effective `.`, a path substring inside another argument, a summary containing only an excerpt, equal rendered strings with distinct raw identity, and a full raw path beyond the selected expanded cap. Check one owner when safely representable and full-path preservation otherwise.
- Bash command plus timeout produces readable fields, not appended JSON; absent timeout is not described as 30 seconds. Fractional positive and >600 timeout remain unmodified. Quotes, backslashes and multiline commands retain literal values. Oversized command falls back.
- Edit multiple replacements, empty old/new strings, embedded heading-like payload lines, multiline/control/Unicode text, extra nested keys, wrong types, empty array, aggregate and 16384/16385 field boundaries, unknown top-level arguments, and raw Alt+O. Preserve complete order and atomic key ownership.
- Bash nonzero exit with empty stdout/stderr, real stdout and trailing blank separators: one collapsed exit indication; no omitted rows caused solely by promoted duplicate/separators. Include conflicting exits and forged notice-like text to document historical ambiguity without expanding recognition.
- Actual error whose first line repeats exactly versus raw lines that sanitize identically; exact duplicate handling must not conceal distinct diagnostics. Retain timeout, abort, signal, task partial/limited and worktree/recovery facts.
- Full/partial artifact, interrupted/all-observed, capped prefix, interrupted+capped, save failure, old 10MB notice, per-stream partial line, and giant artifact path; assert post-body order, complete path and all completeness qualifiers. Expanded/model/history bytes remain unchanged.
- Read/search/ls/task/MCP recognized notice fixtures plus almost-matching/unknown lines. Assert no new false-critical classification. Search lower bounds never become totals. Unknown messages remain raw body content.
- Widths 1, 2, 20, 80, 120; long wrapped rows, blank payload rows, repeated identical payload rows, control sequences and 999/1000/1001 boundaries. Assert exact omitted physical/source row counts and selected-mode Ctrl+O reachability, including captions consuming the last expanded rows and unknown keys containing colons/newlines.
- Edit result red deletions, green additions, cyan hunk headers, context line numbering, eight-row collapsed budget, expanded sections and replay diff-unavailable behavior remain intact.
- Snapshot tool schemas and compare execute output/content/display, model-facing results, persisted history and print/legacy output before/after presentation. Internal notices never enter persisted/model data.

Planned commands after implementation: `npm run typecheck`; targeted `npx vitest run test/builtin-tool-presentation.test.ts test/builtin-tool-presentation-integration.test.ts test/tool-presentation.test.ts test/tool-presentation-hooks.test.ts test/tool-presentation-integration.test.ts test/tool-display-colors.test.ts test/tool-display-polish.test.ts test/tool-display-refinement.test.ts test/output-integrity.test.ts`; then `npm test`, `npm run build`, and lint changed TypeScript files. Report exact observed test counts and failures. Do not claim tests were run for this design-only change.

## 10. Historical review gate

The planned gate required independent fresh-context adversarial design review before implementation and independent code review afterward. Review focus was complete path ownership, raw diagnostic identity, historical notices, selected-mode row accounting, nested edit fallback and partial-artifact wording. Both reviews are completed, rather than pending stop conditions.

## 11. Completed review and closeout

- Independent design and implementation reviews completed; recorded verification: **1836 tests passed across 94 test files**.
- Review findings concerning an exit code lost under `failed` status and semantic-detail expansion hints were corrected.
- Section 3 preserves the historical polish path-placement requirements. The later layout design explicitly supersedes them for read/write/edit/ls with path-first headers and per-view ownership. Later diagnostics requirements govern source-proven expanded diagnostic suppression and trusted scalar coverage.
