# Tool display previews

Status: APPROVED — independent adversarial review closed after event-order and sanitization clarifications; implementation pending.

Workspace: `/Users/z/Z/Agent_demo/imp-tool-display`
Branch: `feat/tool-display-previews`, based on `a8746aa`.
Scope: interactive TUI presentation only. No tool semantics, session-format,
print-mode, or legacy-shell changes. No commits, merges, pushes, or global installs.

## 1. Findings from the current implementation

- `src/repl/components/fold.ts`: collapsed folds render only a truncated title;
  expanded bodies truncate each source line rather than wrap it. Existing diff
  decoration supplies colors and new-file line numbers.
- `src/repl/repl.ts`: `showResultFold` handles top-level results only, keeps the
  first 2000 generic source lines, and extracts a live edit diff from `display`.
  Generic error results also fold. Its cap notice incorrectly promises full
  output in the session when the omitted content came from ephemeral `display`.
- `src/render.ts`: pending calls retain only a formatted `base`, not raw arguments.
  The completed call line is still printed even with `foldedResults`. Errors get
  a first-line summary; nonzero bash exits can appear successful because the tool
  deliberately returns `isError: false` for a completed process.
- `src/format.ts`: `summarizeArgs("bash", ...)` emits the entire command, including
  embedded newlines. Other summaries discard information. Changing this shared
  function would also change print/legacy output, so do not use it as the fix.
- `src/repl/shell.ts`: running tools and agent last-tool labels use `Text`, which
  wraps without a row limit. Ctrl+O expands all folds if any are collapsed and
  otherwise collapses all. Newly added folds start collapsed. Clearing the
  conversation clears the fold registry.
- `src/repl/replay.ts`: history goes through a non-live Renderer with no result
  folds. Stored assistant tool-call blocks preserve full arguments. Dangling
  calls are reported after replay, currently with unbounded argument summaries.
- `src/core/messages.ts` and `src/core/loop.ts`: `ToolResult.display` is explicitly
  ephemeral and stripped before history/session persistence. Do not change this.
  Replay cannot reconstruct a historical edit diff from a successful one-line
  edit result, nor by reading the current filesystem.
- `src/core/tools/bash.ts`: stdout and stderr have existing tool-level caps;
  nonzero exits are encoded as `Exit code: N` in text. Timeout and abort are
  explicit error prefixes. Tail truncation can append a temporary output-file
  path. These facts must survive presentation cropping.
- `src/tui.ts` exposes ANSI-aware wrapping/width helpers; `src/repl/transcript.ts`
  demonstrates wrapping followed by a defensive width clamp for very narrow
  terminals. Reuse this approach instead of character-count clipping.

## 2. Presentation contract and explicit budget interpretation

Each settled top-level call has an **Input** block and an **Output** block.
Labels and separate visual gutters distinguish the blocks without relying on
color. Input uses a subdued accent; ordinary output stays neutral; real edit
hunks retain red/green/cyan decoration; failure status is red plus explicit text.
Avoid duplicate old call lines or `⎿` summaries in this TUI path.

### Body budgets

- Collapsed Input body: at most **3 screen rows**.
- Collapsed ordinary Output body: at most **3 screen rows**.
- Collapsed edit diff body: at most **8 screen rows**.
- Expanded bodies wrap automatically at the current terminal width.
- Generic Output retains the first **1000 source lines**, then renders at most
  **1000 wrapped body screen rows** when expanded. These are independent limits.
- Apply the same expanded 1000-row rendering safeguard to Input and diff bodies
  to avoid unrestricted terminal expansion. Input arguments remain available in
  memory and in the existing assistant message; no input source-line retention
  cap is needed. Live edit diff data remain in memory until transcript clearing.

**Budget interpretation for review:** these numbers limit the content body,
not the Input/Output header, omission notice, or critical metadata. Those are
separate always-visible rows. Long critical paths wrap outside the body budget.
It is impossible to guarantee a complete arbitrary-length path or diagnostic
and a three-row total block at width 1 simultaneously. Critical visibility takes
precedence; ordinary payloads must never exploit this exception. Running-call
activity, in contrast, has a strict three-row total per call, with a compact
status label and a visible omission marker within those three rows.

### Omission notices

- Every display crop is explicit. A collapsed notice reports omitted wrapped
  body rows and says `Ctrl+O to expand` when additional retained rows can be shown.
- A source retention notice says `N source lines omitted from this view`.
- An expanded row-limit notice says `N wrapped rows omitted from this view`.
  Counts refer to retained body text only; do not double-count discarded source
  lines as wrapped rows. Compute counts from current width, not source length.
- Display retention and tool truncation are different. Preserve tool truncation
  notices even when they lie after source line 1000. Never claim that a session
  or file contains the full raw output unless the actual tool contract says so.
- If all retained output fits when collapsed but source lines were discarded,
  show the retention notice without promising Ctrl+O will restore those lines.
- Empty output has an explicit `(no output)` body. Image-only results keep the
  existing image count/type suffix rather than exposing base64 data.

## 3. Shared presentation model

Introduce a TUI-only presentation module, for example
`src/repl/tool-presentation.ts`, and a small sink interface analogous to the
existing semantic thinking sink. This keeps argument/result interpretation
identical for live rendering and replay without adding TUI imports to tools.

The pure presentation model contains:

- call id, tool name, phase/status, and raw argument text for Input;
- title/context, body source lines, body kind (`input`, `output`, `diff`);
- retained/discarded source-line counts;
- critical diagnostic and path rows, separate from ordinary payload;
- error presentation flag and existing image annotation.

Input serialization is lossless for ordinary JSON argument values:

- Bash: actual command text, followed by other argument fields such as timeout;
  no `summarizeArgs` truncation. Invalid/missing command values use JSON fallback.
- Other tools: formatted JSON with all arguments, including write content and
  edit replacements. Known `path`/scope fields are also extracted as context.
- Handle null and primitive argument values honestly; guard serialization
  failure for extension events (cyclic/non-JSON data) with an explicit display
  diagnostic rather than crashing. No tool arguments are mutated.

Copy or serialize raw arguments at tool start so later external mutations cannot
change the displayed call. Store them in an in-memory pending map keyed by id,
not by tool name. Clear pending state at run end and transcript/session reset.
Do not store image bytes in presentation objects.

### Critical metadata extraction

Scan the full available result text **before** taking its first 1000 source
lines. Prefer `display` for visible body, but inspect `contentText(content)` too
for diagnostics when an override omits them. Extract only narrow, documented
built-in diagnostic contracts, not every line containing `error` or `path`:

- `isError` always yields an explicit failure status and the first nonempty
  diagnostic line. For an unusually long diagnostic, wrap it rather than silently
  crop it; remaining error payload stays subject to the ordinary body budget.
- For built-in bash results, recognize standalone `Exit code: N` (including
  negative codes), timeout and abort prefixes, and existing truncation notices.
  A nonzero code yields `exit N`, not a success checkmark, without changing
  `isError`, event payloads, or session contents. Text matching is best-effort:
  a command can itself print a lookalike status line, since ToolResult does not
  persist structured exit metadata. Document/test this limitation.
- Retain existing built-in read/find/grep/ls/bash/task and MCP truncation notices
  and their recovery paths. During implementation, inventory their exact strings
  and add fixtures. Do not use a broad keyword heuristic that promotes arbitrary
  file contents into unrestricted metadata rows.
- Always show known call target/scope paths (read/write/edit/grep/find/ls), plus
  output artifact paths explicitly supplied by tool truncation notices. File
  paths merely occurring in arbitrary output remain ordinary payload: extracting
  all paths from file contents would defeat the preview contract.
- Interruption/missing result is explicit and does not invent an Output body.
  An unmatched result gets `Input unavailable` rather than fabricated arguments.

Deduplicate promoted metadata within each block while preserving order. Metadata
may also appear in the raw body; retaining that duplicate there is preferable to
rewriting raw output or making source/row omission counts ambiguous.

## 4. Integration and lifecycle

### Renderer / live events

Add an optional tool presentation sink to `Renderer` options. Only TUI wiring
supplies it. With the sink present, `tool_start` and `tool_end` take the semantic
path rather than emit old call/summary text; non-tool text and thinking behavior
remain unchanged. Existing `toolStyle`, spinner behavior, and `foldedResults`
continue to serve callers without the sink unchanged.

The semantic path owns start/end pairing and flushes text/thinking boundaries
before appending components. At completion, append Input then Output together,
in received tool_end event order, without changing core execution, emission, or persistence. The existing parallel tool batch uses Promise.all and emits results in call order, even if execution completes in reverse order; retain that behavior live and in replay. Synthetic out-of-order events must still pair correctly by id. Running
calls remain in the activity region, so a very long command never first leaks
through a transcript text line. Interleaved/parallel tools must pair by id.

End-of-run pending calls receive an interrupted Input block once, not once from
Renderer and again from replay. Remove entries on completion. Live cancellation,
provider failure, and dangling replay calls use the same explicit finalizer.
Preserve any tool completion arriving before finalization.

Remove or delegate `ReplMachine.showResultFold` in this path; do not leave both
sink and old fold tap active. Keep top-level-only transcript visibility;
subagent-sourced tool events continue to affect activity only.

### Shell / Fold

Extend or replace the positional Fold arguments with typed presentation options.
Keep diff decoration separate from generic text even when generic output begins
with `+`, `-`, or `@@`. Retain current gutter line-number semantics; continuation
rows must not invent new source line numbers. Wrap at `render(width)`, after
accounting for any gutter, then clamp defensively with ANSI-aware utilities.
Handle tabs, blank lines, CRLF, CJK, emoji, long unbroken tokens, and width 1.

Do not precompute wrapping once at creation: resize must change previews,
expanded row counts, and omission notices. Cache only if keyed by width/state;
never concatenate unrestricted text into a `Text` component as a shortcut.
Apply component-owned styling after sanitization/layout so payload escape codes cannot terminate or override Input/Output styles. A shared pure sanitizer applies to ALL untrusted visible fields: names, arguments, body, headers, paths, promoted diagnostics, and activity labels. Normalize CRLF to LF; render remaining CR as a visible \\r escape, tabs as four spaces, and other C0/C1/DEL controls as visible escaped code points (except LF, which remains a line boundary). Remove complete ANSI control sequences, including incoming SGR styles, cursor/erase CSI, OSC (BEL/ST terminated), and other ESC sequences; incomplete/unsupported control bytes must be escaped, never passed through. The parser must consume sequences before escaping individual controls, and be linear-time. Only component-generated ANSI styling may reach the terminal. Preserve raw arguments/results unchanged, and sanitize display text before width measurement and diagnostic presentation. Add tests for CSI erase/movement, OSC links/title/clipboard, SGR reset, CR, tabs and malformed escapes in arguments, output, metadata and paths. This is a presentation-local policy, not an assertion that the existing generic transcript sanitizes arbitrary model text.

Register Input and Output folds in the same shell collection. Ctrl+O remains:
**any collapsed => expand all; otherwise => collapse all**. New folds start
collapsed even if previous folds are expanded, so the next Ctrl+O expands the new
ones rather than unexpectedly collapsing older ones. Pending activity is always
bounded and is not expanded by Ctrl+O. `/new`, `/resume`, branch navigation, and
conversation clearing remove obsolete components/registrations.

Replace running tool `Text` children and agent last-tool rows with width-aware,
bounded components. At most three rows per tool/agent activity entry, including
spinner/tool/status/elapsed and any omission marker; the marker replaces the last
content row if necessary. Reuse body wrapping/cropping utilities, not raw string
length. No new child-tool transcript history is introduced.

### Replay

Add the optional tool sink to ReplayOptions and pass it to Renderer. The TUI
replay closure wires the same shell-backed sink used live, including replay on
startup, resume, and tree navigation. Legacy replay without that sink remains
byte-compatible. Only the current branch context is replayed as before.

Stored assistant arguments provide full Input. Stored generic result content
provides Output under the same preview and cap rules. A successful historical
edit with no persisted diff renders its stored summary and an explicit
`Diff unavailable in saved history` note. Never manufacture a diff from requested
edits (they may not have applied) or read files during replay. Historical records
which actually contain diff text may render it when the existing contract matches.

This design deliberately does not persist ephemeral display or add a cross-session
cache. A replay of the current session may therefore lose the live edit diff too;
state this limitation plainly rather than changing the session format.

## 5. Verification plan

Tests must be deterministic, use fake providers/tools and injected clocks where
needed, isolate HOME/settings/session files under temporary directories, and
make no network or paid API calls. Reuse existing test harnesses only after
checking their settings isolation; do not execute the user's configured agent.

Add/extend tests around `test/repl-fold.test.ts`, `test/replay.test.ts`, Renderer
and shell integration suites, plus pure presentation tests:

1. Multiline/long one-line bash calls; write/edit arguments and unknown tool JSON
   survive expansion, with collapsed body at most 3 rows at multiple widths.
2. Ordinary Output <=3 rows; actual edit diff <=8 rows; expanded wrapping does
   not horizontally lose content. Diff gutters/colors survive continuation rows.
3. Exact 999/1000/1001 source-line and 999/1000/1001 screen-row boundaries;
   trailing newline, empty output, source retention + wrapping omission together,
   and metadata beyond line 1000. No false full-session promise for `display`.
4. Widths 1, 2, narrow and wide; CJK/emoji, ANSI styles, tabs, CRLF, unbroken
   tokens. Every rendered row's visible width <= requested width. Resize rerenders
   with correct row counts. Hostile cursor escapes do not move the terminal.
5. Errors, nonzero bash exit (`isError: false`), timeout, aborted command, tool
   truncation notice, long path, image-only and mixed results remain explicit.
6. Generic text resembling a diff remains undecorated. Edit override yields live
   diff; replay without override yields honest unavailable note and stored summary.
7. Parallel identical tool names with different ids, out-of-order synthetic events,
   orphan result, interruption and duplicate-finalization prevention. Separately
   gate real fake-tool executions to complete in reverse order and verify received
   event/call order is preserved in both live display and replay.
8. Ctrl+O live and replay folds; new fold after expansion; conversation reset
   removes stale folds and pending state. No transcript duplication.
9. Activity snapshots: huge multiline bash command and child last-tool labels are
   <=3 rows per entry; elapsed/status remain visible; child events remain absent
   from top-level transcript. Ctrl+O does not unbound running activity.
10. Print and legacy snapshot expectations remain unchanged, including two-line
    mode, non-TUI replay, and original result/image summaries. Session/model
    objects remain deeply equal before/after rendering; no persisted `display`.

After independent design approval and implementation, run in this worktree only:

```
npm run typecheck
npm run lint
npm run build
npm test
```

If dependencies are absent, an approved workspace-local symlink to
`../imp/node_modules` is allowed; never modify the shared dependency tree or its
caches. Build only this worktree's `dist`. Audit scripts/harnesses before running
for external side effects. Record exact test counts, failures, and command exit
statuses. Obtain an independent code review before declaring implementation done.

## 6. Required independent review / known limitations

No implementation may start until a fresh-context adversarial reviewer closes
this design. In this authoring session there is no subagent/recursion tool, so
this document must be returned to the parent for that review, not self-approved.

Review especially:

- Are body budgets plus separate critical metadata acceptable, including long
  paths on narrow terminals? Is the additional expanded Input/diff row cap clear?
- Are status text parsers sufficiently narrow, and are all built-in truncation
  contracts represented without allowing arbitrary output to bypass limits?
- Does received-event-order insertion preserve thinking/text boundaries and replay
  parity, without dropping interrupted calls or duplicating historical ones?
- Does Ctrl+O keep all old and new Input/Output folds reachable?
- Are transient edit-diff loss and text-only exit-status ambiguity stated honestly?
- Are controls sanitized and wrapping bounded without freezing on huge input?
  The render output cap does not itself cap the CPU used to count wrapped rows;
  use incremental wrapping/counting and avoid retaining all wrapped rows beyond
  the needed render prefix. Retained raw input is intentionally not tool-truncated.

Independent review approved this design after closing the event-order and sanitization findings. This approval is not evidence of completed implementation or passing code tests.
