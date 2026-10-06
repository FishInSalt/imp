# Builtin tool presentation — first batch

Status: COMPLETE — independent design and implementation reviews closed; recorded verification and final acceptance are summarized below.

Closeout context: this document retains its original design-stage observations, branch references, requirements and planned verification as historical records. Closeout is on the existing `integration/builtin-display-final` branch. Later reviewed designs supersede earlier requirements where explicitly noted. This documentation-only closeout changes no runtime behavior or policy and does not rerun or newly claim the recorded implementation tests. Final manual acceptance is recorded in `builtin-display-diagnostics-design.md`.

Workspace: `/Users/z/Z/Agent_demo/imp-builtin-display`.
Branch: existing dedicated `feat/builtin-tool-presentation`, based on main `f9eb33b` (`Merge branch 'integration/tool-display-output'`). This design task does not change branches, commit, merge, or edit main.

## 1. Scope and inspected contracts

Add optional presentation hooks to the actual `write`, `read`, `grep`, `find`, `ls`, and `task` tool objects. Keep execution, parameter schemas, descriptions, result bytes, image content, model requests, sessions, replay records, and print/legacy output unchanged. Do not touch bash or edit/diff presentation. No new tool execution metadata or persistence format.

Inspected: `src/core/tools/{types,write,read,grep,find,ls,task,output-text}.ts`, `src/repl/{tool-presentation-hooks,tool-presentation,repl}.ts`, `src/repl/components/tool-block.ts`, existing presentation/integrity/task tests, and the approved optional-hooks design. The concrete producers below are the post-integrity-fix contracts, not older examples.

The existing interface supplies detached, frozen arguments and text/image descriptors; result hooks have no structured entry counts, file line count, process status, task outcome, agent configuration, or effective timeout. `result.text` is model-side text; optional `display` is ephemeral. Neither is a trusted serialization of file contents or child answers. Do not invent missing facts.

## 2. Architecture and lifecycle

Create `src/core/tools/presentation.ts` with named hook exports (`writePresentation`, `readPresentation`, `grepPresentation`, `findPresentation`, `lsPresentation`, `taskPresentation`) and private pure helpers. A small set of named pure modules is acceptable if size warrants it. Imports are core types and, if useful, a pure text helper only; no core-to-repl dependency. Do not import `grep.ts` merely to reuse `clampInt` (that brings process execution dependencies into presentation).

Attach the appropriate export as `presentation` in each factory's returned tool object. Existing resolver wiring, `(name) => runner.getTool(name)?.presentation`, already serves activity, live transcript and replay. Add no builtin-name switch to the renderer, registry, runner, or generic presentation host. Replacement tools retain their own hooks. Captured hooks remain associated with their original call, including out-of-order results.

Hooks are synchronous, deterministic and bounded. No filesystem, network, process, configuration lookup, registry enumeration, model API, clock, environment inspection, or tool re-execution. Never resolve a supplied path: show the requested path, not an alleged canonical path. Never mutate context or return promises. Safe snapshot/validation, exceptions, unavailable arguments, absent hooks and replay/orphan handling remain host-owned. Re-rendering, resizing and toggling must not call hooks again.

## 3. Host budgets, ownership and graceful fallback

Unchanged host behavior:

- Collapsed body: three wrapped terminal rows, not three unlimited source lines. Header, diagnostics and existing metadata are host-owned chrome.
- Expanded body: 1000 wrapped rows across sections, including captions. It is not a guarantee of showing an entire arbitrarily large value.
- Structured call expansion renders `argumentFields`, then unconsumed own keys under `Other arguments`. `Alt+O` selects raw JSON arguments for structured calls; `Ctrl+O` expands. Existing reachability logic alone decides whether to offer more content. Hooks must not emit their own keyboard hints, omission counts or truncation promises.
- Expanded results remain original `Result text` and optional `Live display`; semantic detail cannot replace raw sections. This batch does not need `detail` or `sources`.
- Host sanitization, wrapping, colors, diagnostic promotion, image descriptors, truncation notices and partial/limited states remain authoritative.

Every rendered supplied field owns exactly its original key via `consumes: [key]`. No key may be owned twice. Preserve complete supplied values in readable fields; never consume a value while only presenting an excerpt. Unknown keys stay unowned. Defaults use `default: true, consumes: []` and are emitted only when that key is absent, not when it is explicitly null, empty or invalid. Do not manufacture a second default field for a present invalid value.

Guard each call: arguments must be an available non-array object; required string fields must be strings; supplied known optional fields must have their expected types and accepted ranges below. If not, return `undefined` for the whole call, retaining generic safe raw display instead of normalizing an invalid call into a valid-looking one. Unknown fields alone do not reject the call.

Validator limits are UTF-16 string lengths: summary 4096; at most 100 fields; label 256; field value 16384; total semantic text (including ownership keys) 100000; preview/detail at most 1000 entries of at most 16384 each. Snapshot eligibility additionally has depth 64, 100000 nodes and 1000000 string/key units. Respect these existing limits, do not enlarge them for builtins.

Construct fields first and preflight their complete size. If any field cannot fit, return `undefined`; do not split one owned string among duplicate ownership fields or silently discard its suffix. Large `content`/`prompt` therefore deliberately falls back to generic JSON, with existing row omission notices. This is a documented first-batch limitation: ordinary representable code/prompt strings get readable expansion; arbitrary-size strings cannot have lossless readable expansion through this interface. Extending the interface for those strings requires a separately reviewed design.

Summary excerpts are allowed only because complete values remain in fields/raw arguments. Use a small bounded code-point-safe excerpt (for example at most 160 code points per path/pattern, 120 for prompt), visibly suffixed with `…` when shortened. Keep multiline/control content out of the summary by representing line breaks explicitly; field values remain unchanged and host-sanitized. Do not attach ANSI styling or infer a language from an extension.

## 4. Concrete call semantics

Field order below is also expanded display order. Optional absent fields use the listed defaults, so default values are visibly distinguished from supplied ones. Fixed hard caps may appear in labels/summary prose but must not be described as user parameters.

### write

Required fields: `Path` owns `path`; `Content` owns `content`. Content is the original string, with literal newlines, quotes and backslashes — not JSON serialization or fenced Markdown. Empty content renders an empty Content value, not missing content.

Collapsed summary: `<path excerpt> · <N> lines · <B> bytes`. N uses the writer's exact rule: empty string is zero; otherwise count LF delimiters plus one, subtracting one for a terminal LF. B is UTF-8 byte length, matching `Buffer.byteLength(content)`, not JS string length. Do not say created/overwritten before execution. Do not include a code preview: the summary stays concise and complete content belongs in expansion. Count only after rejecting values beyond semantic field limits, avoiding unnecessary traversal of enormous payloads.

### read

Required `Path`; optional `Start line` (`offset`, positive safe integer, default 1); optional `Requested line limit` (`limit`, positive safe integer). Absent limit is a default field saying `not specified; hard cap 2000 lines / 50KB`, not a claim that 2000 lines will be returned. A supplied limit may exceed 2000; retain it verbatim and distinguish the hard cap.

Summary: `<path excerpt> · from line <offset>`, adding `· up to <limit> requested` when explicitly supplied. For offset/limit fields use original numbers, not a calculated ending line. The same request fields apply even if the path ultimately resolves to an image; do not predict file type from suffix.

### grep

Required `Pattern`. Remaining fields: `Path` default `.`, `File glob` default `none`, `Ignore case` default `false`, `Literal` default `false`, `Context lines` default `0`, `Output line limit` default `100`, `Timeout (seconds)` default `30`.

Summary: `<pattern excerpt> · path <path excerpt>`, plus `· glob <glob excerpt>` when a nonempty glob is supplied. Include literal/case flags only if space permits; fields always retain them. `glob` is a path filter, never another search pattern or a match count.

Accept finite numeric context/limit/timeout values, preserving the requested number and adding its effective value if different: floor then clamp context 0–10, limit 1–1000, timeout 1–600. For example `2000 (effective: 1000)` owns the supplied limit and is not a default. Explicit empty path is displayed as `"" (effective: .)` and empty glob as `"" (no filter)`; nonempty strings are unchanged. Reject null/wrong-type known fields to generic display rather than reproducing execution coercions. Output limit means output lines, including context and separators, never number of matches.

### find

Required `Name glob` owns `pattern`. Remaining fields: `Path` default `.`, `Type` default `both`, `Output line limit` default `200`, `Timeout (seconds)` default `30`. Actual schema has no `glob`, `hidden`, `ignoreCase`, `exclude`, or `maxDepth`; those keys remain under Other arguments if supplied.

Summary: `<pattern excerpt> · path <path excerpt> · type <file/directory/both>` for accepted values. Explicit type must be `file` or `directory`; any other supplied type falls back to generic display (execution silently ignores unsupported strings, but semantic display must not bless them). Numeric limit/timeout and empty path handling follow grep. Calling this an output-line limit is deliberately conservative: fd paths containing newlines cannot be counted as entries from text.

### ls

Only `Path` (default `.`) and `Entry limit` (default `500`) are known. Summary: `<path excerpt> · up to <effective limit> entries requested`. Preserve supplied finite numeric limit and annotate truncation toward zero, clamped 1–5000, when different. Empty path follows grep. No invented recursive/filter/type/timeout fields. Never claim the requested maximum is the number returned.

### task

Required `Prompt`; then `Agent`, `Timeout (ms)`, `Worktree`. Prompt is the complete original multiline string, not JSON, subject to the shared field fallback rule. Summary: `<agent excerpt or generic subagent> · <prompt excerpt>`.

- Supplied agent: preserve the string (empty string falls back to generic presentation). Absent: `generic subagent` default.
- Supplied `timeoutMs`: integer >=1000, displayed in milliseconds without unit conversion. There is no `timeout` parameter; unknown `timeout` stays visible under Other arguments.
- Absent timeout: default text `inherited from agent/host`; do not assert no limit or 60 minutes. Execution precedence is argument, agent, tool option, then host-dependent default.
- Supplied worktree: preserve explicit true/false, including false overriding an agent default. Absent: default text `inherited from agent; otherwise false`. A hook cannot resolve named-agent settings or claim isolation actually happened.

Do not display unprovided model, tool list, max-turns or agent descriptions. Do not append internal worktree notice text to the prompt; the call is the user's original argument.

## 5. Result policy: original evidence, not fragile reverse parsing

For this batch all six hooks are call-only (`result` omitted). The generic output already shows a three-row preview of actual text, original expanded result sections, image descriptors, failures, notices and task partial/limited status. Adding a generic word such as “Read” ahead of those rows would spend the scarce preview budget without new reliable information. Hook omission is intentional use of the optional interface, not a renderer special case.

Specifically:

- Write already produces `Created/Overwrote <requested> (N lines, B bytes)`. Display that raw result; do not parse a path that may itself contain newlines or parentheses. Errors remain actual errors.
- Read has unnumbered text, not a structured line range. Empty file and a single blank line can both yield empty output after producer logical-line handling. Terminal LF is removed; CRLF records, literal notice-shaped file content, optional blank separators, oversized-first-line notices, image notes and attached images make reverse counting unreliable. Therefore report requested start/limit in the call, and retain actual continuation/range notices in the result. Do not claim an actual returned range or count where the contract cannot prove it. Do not strip a matching suffix from file text or infer image identity from its text note. Attachments are identified only by host image descriptors; omission/resize/non-vision notes remain raw text.
- Grep/find share `runSearch`. Current notices distinguish exact collected output line counts from `at least N complete lines observed; total unknown; 1048576-byte collection limit`. Byte caps retain whole lines; stderr has a separate 2000-byte diagnostic cap. Zero stdout emits `No matches for <label>`. Context separators, stderr, path newlines and literal sentinel-like data prevent reliable result-entry counts. Retain producer notices verbatim. Never relabel their line counts as matches/files or turn a lower bound into a total. No independent count is computed.
- ls includes dotfiles, sorts case-insensitively, and follows stat for directory suffixes. Dangling/inaccessible entries are retained without `/` and may have a directory-type-unavailable notice. Results end with LF and may include entry/50KB notices or `(empty directory)`. Names can contain newlines or resemble notices, so do not compute an entry total from `split("\n")` or treat every slashless entry as a file.
- task result has answer text and usage trailer; timeout/abort/crash may hand off a saved transcript or explicitly say none was persisted. Turn cap without text is `isError: false` but host status is limited; crash with partial text is also success-shaped but host status is partial. Tail truncation keeps the last 50KB, not the beginning. Worktree/cleanup trailers must remain visible. Never summarize these as “completed” solely because `isError` is false, extract arbitrary paths as artifacts, or count turns/tokens by parsing a child answer. Existing diagnostic promotion is unchanged, including its textual-contract limitations.

Future semantic result counts need trustworthy, separately reviewed structured producer metadata. Do not modify producer output or add undocumented parsers in this batch to get them.

## 6. Risks and explicit tradeoffs

1. Large strings fall back as a whole. This preserves evidence but loses readable code expansion for content above 16384 UTF-16 units. Tests must make the boundary visible; no hidden truncation or bogus full-content promise.
2. Unknown parameters may be large/nested lists. They remain generic under Other arguments and raw JSON, with host row budgets. Do not traverse them in builtin helpers, infer their meaning, consume them, or render object values as `[object Object]`.
3. Number normalization must match each producer (grep/find floor versus ls truncation); preserve the original requested number. Invalid types fall back instead of implying successful validation/execution.
4. Defaults that depend on runtime state are descriptions of inheritance, not resolved values. In particular agent/worktree/timeout cannot be reconstructed during replay.
5. Renderer metadata may repeat a path already in a concise summary. Accept existing behavior; do not refactor global chrome or widen scope to remove it.
6. Control sequences, tabs, unusual Unicode, multiline paths and strings looking like tool diagnostics remain untrusted text. Host sanitization must apply in both readable and raw modes. Hooks do not certify data as diagnostics.
7. This batch improves calls much more than results. That is the honest limit of the current contract; review must explicitly accept it rather than silently expecting invented result totals.

## 7. Verification plan after design approval

Add `test/builtin-tool-presentation.test.ts` (pure hooks and field ownership) and `test/builtin-tool-presentation-integration.test.ts` (actual factories, sink and folds). Reuse existing presentation tests rather than changing their global invariants.

Required coverage:

- Each real factory exposes its intended hook; resolver is built from actual Tool objects, not a name-only synthetic presenter. Exercise call preparation, sink pairing and fold rendering at widths 1, 20, 80 and 120. Confirm hooks run once despite resize/expand/raw toggles and reverse-order completion.
- All documented fields/defaults, unknown keys, explicit false/zero/empty, numeric clamping, invalid types, null, arrays, missing required strings, unsafe/unavailable snapshots and replay/orphan results. Verify exact ownership and that every supplied value is reachable in readable or raw fallback. Defaults must not consume keys or duplicate present arguments.
- Write empty/LF/CRLF/multibyte content: actual temp file bytes, actual writer counts, concise summary, expanded literal code (quotes/backslashes/newlines, not JSON), raw Alt+O, content boundary 16384/16385 and total-budget fallback. Include a long single line, a 1000-row boundary and content beyond snapshot eligibility.
- Read actual temp text files: empty versus blank line, offset/limit, final LF, invalid integer, 2000-line cap, 50KB whole-line cap, oversized line, literal notice-shaped text. Confirm no fabricated count/range. Small local image fixture and actual image read exercise descriptors; mock image processing only for deterministic omission cases, not external services.
- grep/find actual producer output via temporary fake `rg`/`fd` executables and isolated PATH/detection state: normal results, context separators, no output, exact cap, 50KB cap, >1MB collection guard, stderr cap, nonzero/signal/timeout. Follow existing search test isolation; do not depend on installed system tools. Assert result text byte-for-byte and retain exact total-unknown notices.
- ls actual temporary directory: dotfiles, directory and symlink, dangling stat, entry/byte caps, empty directory, newline and notice-like names. No fabricated file/entry count.
- task factory call fields using a fake/scripted provider, in-memory agent definitions and injected options; no actual model requests. Produce outcome output through actual `taskResult` for completed/no-text, timeout, abort, crash, partial, turn cap and tail cap. Use a scratch-root SessionStore only where persisted handoff is needed; use existing worktree trailer producer with scratch git fixture if testing actual worktree execution. No user agent/config/session lookup, credential loading, external APIs or user repository worktree creation. Verify partial/limited/error metadata survives call hooks unchanged.
- Compare ToolExecuteResult and ToolResult content, display, schemas and stored session entries with presentation enabled/disabled. Live/replay rendering can differ only where the existing display contract permits. Run print/legacy, edit/diff, bash and extension presentation regression tests unchanged.
- Assert actual three/1000 wrapped-body budgets, retained omissions, no false Ctrl+O solely for formatting, and truthful expansion hints when Content/Prompt/Other arguments add reachable information. Do not assert that chrome is included in the body cap.

Planned commands: `npm run typecheck`, targeted `npx vitest run test/builtin-tool-presentation.test.ts test/builtin-tool-presentation-integration.test.ts test/tool-presentation-hooks.test.ts test/tool-presentation-integration.test.ts test/tool-presentation.test.ts test/output-integrity.test.ts test/task-tool.test.ts`, then `npm test`, `npm run build`, and lint of changed TypeScript files. Report exact test counts and any skipped fixtures or unavailable prerequisites, not assumed success.

## 8. Historical review and implementation gate

The planned gate required independent fresh-context adversarial design review before implementation, followed by implementation verification and independent code review. Review focus was call-only result policy, large-field fallback, ownership/default correctness, numeric values, task settings, output integrity and isolated fixtures. These gates are closed; they are not outstanding implementation instructions.

## 9. Completed review and closeout

- First batch implemented in `8a029b6`; independent design and implementation reviews completed.
- Recorded verification: **1790 tests passed across 93 test files**.
- Later polish superseded absent-default and duplicate-path presentation choices. Layout subsequently superseded path placement for read/write/edit/ls; diagnostics refined evidence-based diagnostic suppression and scalar field coverage. The preceding requirements remain the historical first-batch contract, not instructions to revert those reviewed follow-ups.
