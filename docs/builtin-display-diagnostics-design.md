# Builtin display diagnostics and field coverage

Status: COMPLETE — independent design and implementation reviews closed; recorded verification and final acceptance are summarized below.

Closeout context: this document retains its original design-stage observations, branch references, requirements and planned verification as historical records. Closeout is on the existing `integration/builtin-display-final` branch. Later reviewed designs supersede earlier requirements where explicitly noted. This documentation-only closeout changes no runtime behavior or policy and does not rerun or newly claim the recorded implementation tests. Final manual acceptance is recorded in `builtin-display-diagnostics-design.md`.

Workspace: `/Users/z/Z/Agent_demo/imp-builtin-display`; existing dedicated branch: `fix/builtin-display-diagnostics`. This change adds only this document. Preserve every preceding uncommitted layout/polish change; no new branch, commit, merge, or main edit.

## Scope and observed cause

Exactly two presentation fixes:

1. Expanded bash results repeat a promoted timeout diagnostic before its raw source line, or repeat `exit 3` and `Exit code: 3`. Remove redundant host copies only when their exact raw evidence is fully visible. Preserve failure status and all raw occurrences.
2. A collapsed trusted builtin read call `{path: "AGENTS.md", limit: 30}` already shows the path and `up to 30 requested`, yet advertises Ctrl+O solely for `Line limit: 30`. Add explicit trusted field coverage based on what the header actually emitted, not on summary text that might have been omitted.

Inspected `src/repl/components/tool-block.ts`, `src/repl/{tool-presentation,tool-presentation-hooks}.ts`, `src/core/tools/presentation.ts`, and existing layout/polish/presentation tests. The renderer already builds a selected-mode physical-row plan with section/line identities, retained spans and line ends. Its `evidenceVisible` proof currently applies only to abbreviated artifact/truncation notices. `promotedDiagnostic` metadata and result titles render earlier without that proof. `outputBlock` drops a sole title-owned exit notice, losing its evidence reference for rendering. Path-first collapsed headers optionally append a summary, but do not record whether that suffix was emitted; ordinary builtin field coverage largely treats those summaries as unassociated prose.

No model-facing changes: execution, tool output/content/display bytes, ToolResult, persisted history, public hook contracts and print output remain unchanged. No edit dual-receipt changes, new word wrapping, third-party summary inference, broader notice parsing, or unrelated presentation enhancements. Preserve bash command source mapping and all existing path proofs unchanged.

## Fix 1: source-proven expanded ownership

Add optional internal presentation evidence for the promoted diagnostic and the sole title-owned bash exit. Each record retains unsanitized raw text and source occurrences `{section: sourceId, index}` from original content/display; keep distinct sections and repeated occurrences. Capture the exit identity even when the collapsed host-notice list omits its redundant copy. Do not infer it later from title spelling or sanitized rows. Do not change the existing anchored parser, status precedence or conflict detection.

Move/reuse the existing complete-evidence predicate before title/metadata emission. An occurrence qualifies only when:

- its selected non-diff section has the same sourceId and `originalLines[index]` equals the exact raw text;
- at least one physical row for that occurrence is retained;
- its final physical row is within the shared 1000-row expanded plan and every row is lossless.

At least one complete occurrence suffices to suppress its host copy; a different occurrence with merely equal sanitized spelling does not. An identity match in a different section must be independently proven there. Evidence beyond source retention, partially wrapped at the row cap, in an unselected section, or defensively clipped at narrow width fails the proof. Source occurrences refer to original indices, never indices in the collapsed projection.

Expanded rendering policy (bash only for this new suppression):

| Evidence | Host presentation | Raw sections |
| --- | --- | --- |
| Promoted diagnostic fully visible | Omit only its promoted metadata copy | Unchanged, including repeated real errors |
| Diagnostic absent/partial/unreachable | Keep promoted metadata | Unchanged |
| Sole title-owned exit fully visible and final title is that exit | Render generic `failed` status instead of `exit N`; raw line owns the numeric code | Unchanged |
| Sole title-owned exit not fully visible | Keep `exit N` title | Unchanged |
| Final status is `failed`, including timeout after an exit-like line, or conflicting codes | Keep `failed`; never infer a sole title owner | Unchanged |

For existing bash exit/diagnostic host notices not owned by the title, use the same full-evidence proof in expanded mode to omit only redundant host copies. If their raw evidence is hidden, retain those notices, so a final `failed` status cannot erase a code. Keep independent failure/partial/limited status facts: never suppress a whole status merely because a diagnostic is visible. Do not mutate `block.title`, `block.error`, sections, metadata or model data to implement per-view selection. Collapsed behavior remains unchanged. Existing truncation/artifact dependency proofs remain unchanged.

Repeated raw errors and repeated exit lines must all remain in expanded sections. This is host-copy suppression, not payload deduplication. Distinct conflicting codes retain their own evidence and any necessary fallback copies. Existing textual spoofing limitations remain; this fix grants no new authenticity to stdout.

## Fix 2: explicit trusted builtin field coverage

Use optional render-local summary ownership records on ToolBlock, not new public hook fields. Restrict initial ownership to scalar request facts already fully described by path-first builtin summaries: read `offset`/`limit`, and ls `limit` when its requested and effective values agree. Other summaries/fields retain existing behavior, especially bash command source spans, write counts, edit replacement counts and all third-party hooks.

Build these records from the existing captured trusted builtin identity (`builtinName` must match the call name), detached arguments and validated full fields. Record the exact field index/key, full value/facts represented, and the corresponding summary fragment/range. Require the field to consume exactly that key and match the trusted expected value. Do not use label-only equality, substring searches, name-only trust or values shared by unrelated fields as proof. A custom hook called `read` gains no ownership. Unknown arguments never acquire ownership.

For read, `from line N` represents the supplied Start line and `up to N requested` represents the supplied Line limit, including requests over the execution cap: these are request facts, not a returned range or effective result count. For ls, an effective-only summary cannot cover an original request with a normalization annotation (e.g. `2.9 (effective: 2)`); keep that field additional. Do not change summaries or normalize requests to make them compare equal. Absent optional fields do not become new arguments.

At render time, record the actual suffix emitted by the path-first collapsed header. Coverage is earned only for complete associated fragments present in that emitted suffix, without crop or loss. The current suffix is all-or-nothing: when path/header/summary will not fit, or the path is cropped, it earns no summary coverage. Do not substitute a calculation at `w - indent.length` for actual header space. Keep existing path-cropped and expanded path accessibility logic authoritative.

For each non-path field, first check its explicit trusted collapsed coverage; otherwise ask whether its value is reachable in the selected expanded readable/raw plan using existing value spans and retained rows. Emit Ctrl+O only for additional reachable value evidence. Thus wide read path+limit alone has no hint in either mode, while a dropped suffix, supplied uncovered field, or reachable unknown value still does. Unknown keys/labels/JSON punctuation alone are not value evidence. Alt+O and resize recompute coverage from the selected plan; no hook reruns. A value wholly beyond that mode's cap cannot justify Ctrl+O. Defaults absent from raw JSON do not create raw-mode evidence.

## Budgets and implementation boundary

Do not change budgets: three collapsed body rows, eight for unstructured edit diffs, 1000 physical expanded rows across selected sections including visible captions, existing 1000 source-line retention for ordinary result sections, and semantic detail capacity `min(100, max(0, 1000 - plannedRows))`. Host status/diagnostic/path/notice chrome stays outside body budgets. Suppressing host chrome must not reclaim rows or change raw planning, omission counts or wrapping. No new unbounded summary scan; reuse captured bounded fields and the existing plan. Existing hook limits remain unchanged.

Expected implementation files after approval: `src/repl/tool-presentation.ts` for optional identity/coverage records, `src/repl/components/tool-block.ts` for view-specific ownership, and focused tests. If needed, a pure private helper beside builtin presentation helpers may produce scalar coverage records; no changes to hooks or execution are authorized. Do not refactor command mapping, path handling, edit receipts, styles or wrapping as part of this work.

## Required tests after approval

Extend `test/builtin-display-layout.test.ts` and `test/builtin-display-polish.test.ts` (or a focused diagnostics test file), retaining current regression assertions:

- Timeout: collapsed promotion remains; expanded complete raw diagnostic appears once for one source occurrence. Two identical real raw errors remain twice, not once or three times. Distinct unsanitized lines that sanitize alike cannot cover each other.
- Exit 3: collapsed `exit 3` remains; expanded complete evidence shows `failed` plus one raw `Exit code: 3`, no numeric title copy. Repeated raw exits remain repeated. Conflicting 2/3 codes retain `failed` and both codes. Exit-like stdout followed by timeout/abort retains final `failed` and code evidence, even when that code lies beyond the cap.
- Content/display equal versus distinct, matching indices in different sections, source occurrence only beyond retained prefix, caption consuming the last row, partial diagnostic wrap, and 999/1000/1001 boundaries. Failed proof retains host fallback. Test widths 1, 2, 20, 80, 120 and a diagnostic with a defensively clipped wide glyph. Assert exact raw arrays and omission counts remain unchanged.
- Read `AGENTS.md`, limit 30: at a width fitting the entire header suffix, no Ctrl+O for readable or raw selected mode; manual expansion still renders Line limit. Read offset+limit each earns only its own coverage. Cropped long path, narrow header and omitted suffix retain Ctrl+O when the extra value is reachable.
- Read requested limit 3000 stays a request, not an effective 2000 claim. Ls unchanged integer request may be covered; fractional/clamped requests still reveal requested/effective distinctions. Invalid arguments and third-party lookalike hooks preserve fallback behavior.
- Supplied unknown fields (including equal values, unusual labels, explicit false/zero/empty values), raw/readable ordering, label-only last row and values beyond the selected cap: hints follow reachable value evidence, not syntax. Resize and Alt+O both directions must invalidate coverage correctly.
- Existing bash literal/escaped command source-span tests, path control/Unicode/raw coverage tests, edit diff/receipt tests, truncation dependency tests, and model/history byte invariants remain unchanged.

Planned verification: `npm run typecheck`; `npx vitest run test/builtin-display-layout.test.ts test/builtin-display-polish.test.ts test/builtin-tool-presentation.test.ts test/tool-presentation.test.ts test/tool-display-refinement.test.ts test/tool-display-colors.test.ts`; then `npm test`, `npm run build`, and Biome checks on changed TypeScript files. Use deterministic fixtures; no paid APIs or external side effects. These are future commands, not completed tests.

## Historical review gate

The planned gate required independent fresh-context adversarial design review before implementation and independent code review afterward. Review focus was raw identity, complete occurrence proof at both caps, failure/code preservation, repeated errors, emitted suffix coverage, normalization, trusted hooks and selected-mode reachability. Both reviews are completed; the original design-stage stop instruction is no longer pending.

## Completed review and closeout

- Independent design and implementation reviews completed; recorded verification: **1899 tests passed across 96 test files**.
- Review found that multiline OSC sanitization could make raw source indices differ from rendered line indices, invalidating a completeness proof. A conservative section guard corrected that mismatch; independent review retested the full suite afterward.
- The user manually accepted the final five cases: read with `limit: 30`, bash exit 3, bash with `timeout: 1`, multiline bash, and find with `limit: 2`. The latest user instruction was to finish. This acceptance does not claim manual verification of every width, cap or boundary case.
