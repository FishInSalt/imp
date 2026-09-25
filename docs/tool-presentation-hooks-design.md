# Optional tool presentation hooks

Status: APPROVED — independent adversarial design review closed after explicit child source identity and parent execution-context plumbing were specified.

Workspace: `/Users/z/Z/Agent_demo/imp-tool-display`
Branch: `feat/tool-display-previews` (existing isolated worktree).

This is an additive revision to `tool-display-previews-design.md`. That document's
approval does not approve this revision. This document supersedes its literal
Input/Output headers and generic-only extension presentation, not its terminal
safety, lifecycle, body budgets, or ephemeral-display policy.

## 1. Inspected baseline and scope

- `src/core/tools/types.ts` defines `Tool`, used verbatim by
  `ExtensionApi.registerTool` in `src/extensions/types.ts`. Core imports no
  extension or TUI modules. Extension registry currently retains tool objects.
- `Runner.getTool(name)` resolves the effective `runner.tools` array. MCP can
  update that array in place; a separate extension-only registry would diverge.
- `src/repl/tool-presentation.ts` pairs starts/ends, snapshots arguments through
  JSON, and constructs generic blocks. `ToolBlockFold` owns sanitizing, wrapping,
  colors, gutters, expansion and row caps. `TranscriptSink` constructs the sink.
- `ReplMachine.onEvent` separately constructs activity labels with `inputBlock`.
  Renderer and replay already accept an optional tool sink; TUI wiring must
  supply the same resolver to activity, live transcript, and replay.
- `examples/extensions/web-search/index.mjs` formats Tavily results as bounded
  text, not JSON. Its cache stores that same output. It currently has no display
  override. `formatResults` validates sources, filters invalid entries, limits
  entries to the requested maximum, and may omit additional sources to fit 40k
  characters. Titles/snippets/full text can contain newlines and source-like
  delimiters. This text is not an unambiguous serialization of source records.
- `ToolExecuteResult.exitCode` exists but `ToolResult` has no exitCode field.
  This revision must not imply hooks can recover structured historical exits.
- `ToolResult.display` exists only on live events and is stripped before history.
  Even replay within the current process may therefore lose a live override.

Scope: optional semantic presentation on Tool; first consumer is the shipped
web-search extension; TUI-only header cleanup. No model-content, execution,
provider schema, session format, or default print/legacy output changes. No new
network requests, tool re-execution, filesystem reconstruction, or persistence
of presentation data. `url_read` remains generic in this batch.

## 2. Exact public contract and dependency direction

Declare the following types in `src/core/tools/types.ts` (type-only data contract,
no renderer implementation). Re-export them and `Tool` from
`src/extensions/types.ts` for extension authors:

```ts
export type ToolPresentationValue =
  | null | boolean | number | string
  | readonly ToolPresentationValue[]
  | { readonly [key: string]: ToolPresentationValue };

export interface ToolCallPresentationContext {
  readonly toolCallId: string;
  readonly toolName: string;
  // null means an actual null value when argsAvailable is true.
  readonly args: ToolPresentationValue;
  readonly argsAvailable: boolean;
}

export interface ToolResultPresentationContext
  extends ToolCallPresentationContext {
  readonly result: {
    readonly text: string; // contentText(content), never display substituted
    readonly display?: string; // live override, absent in saved history
    readonly isError: boolean;
    readonly images: readonly {
      readonly mimeType: string;
      readonly encodedLength: number; // base64 string length, not byte count
    }[];
  };
  readonly replay: boolean;
}

export interface ToolSemanticPresentation {
  readonly summary: string;
  readonly preview?: readonly string[];
  readonly detail?: readonly string[];
}

export interface ToolPresentationHooks {
  readonly call?: (
    context: ToolCallPresentationContext,
  ) => ToolSemanticPresentation | undefined;
  readonly result?: (
    context: ToolResultPresentationContext,
  ) => ToolSemanticPresentation | undefined;
}

// Add to existing Tool (all existing members unchanged):
// presentation?: ToolPresentationHooks;
```

No Component, ANSI, width, shell, extension registry, callback sink, execute
function, mutable content object, or image bytes cross this interface. Hooks
return plain semantic text only; no status, metadata, omission counts, colors,
links/actions, or replacement raw-data fields. Undefined means generic fallback.
No separate extension registration API is needed. Providers must continue to
explicitly select name/description/parameters; never serialize the Tool object
or presentation functions into model requests.

Internal TUI contract:

```ts
type ToolPresentationResolver =
  (name: string) => ToolPresentationHooks | undefined;
```

This type and safe invocation live in `src/repl/tool-presentation.ts`. Composition
roots inject `(name) => runner.getTool(name)?.presentation` only for TUI. Core
execution never invokes these hooks. Extension registry should validate optional
hook shape without rejecting an otherwise valid executable tool: malformed
presentation is reported and ignored by the display adapter. Runtime validation
remains mandatory for built-ins, MCP tools, direct Tool objects, and JS extensions.

## 3. Snapshot, invocation, validation, fallback

1. At tool start capture a detached JSON-compatible argument snapshot and the
   current hook function references, paired by call id. Never retain mutable
   event arguments as hook inputs. Accept only plain data descriptors, plain
   objects/arrays, finite numbers and the union above. Cycles, getters, toJSON,
   functions, symbols, BigInt and unsupported prototypes make args unavailable;
   do not invoke getters or toJSON to create the semantic snapshot. Catch all
   reflective access failures. A rejected snapshot must not be retraversed by
   generic fallback (including JSON.stringify, toJSON or property reads). Emit a
   fixed host-owned unavailable-arguments/serialization diagnostic instead; use
   only already safely retained text, if any. Never mutate the real call.
2. Recursively freeze the detached context, including nested values and result
   image descriptors. Bound semantic snapshot traversal to depth 64, 100,000
   nodes and 1,000,000 total string code units, including object key lengths as
   well as string values. Charge keys before descending/copying. Exceeding these limits disables
   the affected hook, not raw argument/result retention or tool execution.
   Results are detached strings and image descriptors; never clone base64 data.
3. Run hooks synchronously once per call/result, not during render, resize,
   expansion, or activity ticks. Reuse the call presentation for activity and
   the completed call block. Result hook receives the saved start snapshot;
   orphan results have argsAvailable false. Resolver/property access and the
   invocation itself are inside catch boundaries.
4. Validate the returned value as an own-data plain object containing only
   summary, preview, detail. Summary must be a string <=4096 UTF-16 code units;
   arrays <=1000 strings each; each string <=16,384 code units; total returned
   text <=100,000 code units. Reject unknown keys, accessors, nonstrings,
   promises/thenables and oversized values in their entirety. Copy validated
   strings/arrays; subsequent extension mutation cannot change rendered output.
   Detect native promises with `node:util`'s `types.isPromise`, not instanceof
   or reads of .then/.catch. For rejected native promises, attach a no-throw
   rejection handler using a captured intrinsic Promise.prototype.then through
   a guarded intrinsic call. Never invoke overridden .then/.catch, Promise.resolve,
   or arbitrary thenables; never await. Guard attachment failures too (hostile
   subclass/species behavior can still execute or throw within the intrinsic;
   this is not a sandbox or a guarantee for adversarial native promises).
   Ordinary rejected async hooks must not cause unhandled rejection. Reject
   thenable-shaped data via descriptors without invoking accessors. Async hook
   side effects cannot be undone.
5. Missing hooks, undefined, invalid snapshots, thrown errors, malformed output
   or resolver failures yield the generic block for that phase, not a failed
   tool. No extension exception/stack becomes unrestricted terminal metadata.
   Rate-limit any internal diagnostic per hook/name per run; sanitize it and do
   not include call secrets. Hook failure cannot suppress host failure status.

These are crash/mutation/display guards, not an extension sandbox. An extension
already runs trusted in-process JS. A sync infinite loop cannot be preempted by
catch or a time budget; getters/proxies can themselves execute during reflective
inspection. Document this limit. Require hooks to be pure, bounded, synchronous,
network/filesystem-free functions. Tests enforce that shipped hooks obey it.

## 4. Host-owned display and information preservation

### Headers and status

A completed pair has one call heading: fold marker and tool name only. Both call
and result semantic summaries are budgeted BODY text, never header metadata.
Remove literal `Input` and `Output` and the routine `completed` title.
Call payload retains thin subdued cyan gutters; result uses the existing heavier
neutral gutter; real diffs retain current colors/line numbering. Result has no
redundant tool-name heading on success: its semantic summary, if any, is a
budgeted body row. The fold marker can occupy the first result gutter. This does
not merge the two fold registrations or change Ctrl+O semantics.

Failures/interruption/nonzero exit/partial/limited remain explicit host-owned
text, independently visible and colored, including when the semantic summary
sounds successful. Unavailable call arguments and unavailable historical diff
remain explicit. Success is not inferred from extension text. At width 1 body
content still takes priority over gutters; failure text wraps rather than vanishes.

### Summary, preview, detail and raw body

- Collapsed call/result semantic body is summary followed by preview, or the
  existing generic body if no valid hook. The summary consumes the same budget,
  not an unlimited header exception. Tool name/fold marker is host chrome.
- Expanded bodies show optional semantic detail followed by host-labeled original
  arguments/result text. Use `Arguments`, `Result text`, and, when applicable,
  `Live display` section captions, not repeated Input/Output titles. A hook never
  replaces, filters, or truncates the underlying text available for expansion.
- Keep raw arguments independent of semantic strings. For result overrides,
  retain both the live display and model-content text; image data remain excluded
  with host-generated image annotations. Original content is not reconstructed
  from semantic detail. Diff display retains diff styling only in its own section.
- Preserve ordinary collapsed body <=3 screen rows, diff <=8; expanded <=1000
  wrapped body rows. Original generic result retention remains first 1000 source
  lines per raw text section. Count original and display omissions separately.
  Detail is optional convenience, capped at 100 wrapped rows and must not take
  the entire expanded budget before raw data: allocate raw rows first, then use
  remaining budget for detail, even though detail is displayed before raw sections.
- “No loss on expand” means no new loss caused by summarization/hooks: expansion
  reveals underlying retained data, not merely a longer summary. Existing
  source/row caps can still omit raw material and must be stated honestly. The
  host must not claim all arguments/output are visible when those caps apply.
  Where multiple raw sections compete, explicit per-section row omission counts
  are required; do not falsely claim Ctrl+O restores rows beyond the expanded cap.
- For semantic collapsed views, say `Ctrl+O for details and original text` when
  expansion reveals additional retained content. Do not subtract semantic rows
  from raw rows or invent an omitted-source count from a summary. Crops of the
  semantic text itself may report their actual wrapped-row counts separately.

Preserve the existing fold layout cache and its width/invalidation behavior;
semantic selection is not permission to recompute wrapping on every render.
Cache immutable final presentation data separately from per-call invocation state.
Keep raw-source counts, live-display counts and semantic wrapped-row counts in
separate fields; resizing or toggling folds must not overwrite one with another.

All text, including hook summary/detail, tool names and diagnostics, passes the
existing sanitizer before width measurement. The host owns wrapping at current
width, color application, gutters, budgets, narrow-width defense, omission
notices, always-visible critical diagnostics, and image annotations. Hooks cannot
promote arbitrary payload to uncapped metadata. Host metadata extraction runs on
original content/display before semantic selection. Existing narrow built-in
contracts and their spoofable textual-exit limitation remain unchanged.

## 5. Live, activity, replay and lifecycle

Configure TranscriptSink's resolver before initial replay or event consumption;
provide the same safe presentation service to ReplMachine activity. Do not read a
global registry or construct a new registry on resume. Both start paths use a
per-call cached call presentation rather than invoking the hook twice.

### Explicit ephemeral child source identity

Current `AgentEventInfo` in `src/runner.ts` has only optional `agent` and `cwd`
labels. `src/core/tools/task.ts` produces those labels and `ReplMachine` currently
indexes child activity by agent name. Neither label, nor their combination, is a
unique identity. Do not assume an existing child id or key hooks by these labels.
Keep child hooks, with this explicit observer-only plumbing prerequisite:

- Add an optional third Tool.execute argument, `context?: { toolCallId: string }`, supplied by core/loop.ts from the actual call.id at the execution boundary, for both parallel and sequential execution. Existing two-argument implementations remain compatible. The task implementation accepts this context and copies context?.toolCallId into taskToolCallId. Direct task.execute callers without context omit the parent association; their unique sourceId remains usable, and run-end cleanup is the fallback. Never infer the parent id from labels, arguments, timing, or mutable globals. This execution-interface addition transports invocation metadata only; it does not enter model arguments, schemas, results or stored history. Add a reverse-completion concurrent-task integration test asserting each child's metadata refers to the actual invoking call id.
- The task producer allocates a fresh opaque `sourceId` for each task invocation
  before forwarding child events (for example a UUID), independent of agent,
  cwd, session availability and child tool-call ids. Every event from that
  invocation carries that same id in callback metadata. Include the invoking
  parent's `taskToolCallId` for activity-row association; it is not the source id.
- Extend the task callback metadata contract and runner's `AgentEventInfo` with
  these fields, forwarding them unchanged through runner observer callbacks.
  They are ephemeral observer metadata only: no AgentEvent payload, model
  request, ToolResult, session schema or stored history changes. Top-level
  events retain undefined metadata and use a separate root source namespace.
- REPL consumes the actual sourceId, using `(run identity, sourceId, toolCallId)`
  keys for child presentation state and sourceId-keyed child activity rows.
  Parent task rows are associated by taskToolCallId, not agent/cwd. Labels are
  display-only. Two invocations of the same agent in the same cwd remain distinct.
  Metadata lacking sourceId uses generic child activity without child hook
  caching; never synthesize identity from labels. Child events still never enter
  the parent transcript.
- On a child result, finalize that source/call only. On parent task completion,
  interruption or failure, release its child source state, including unmatched
  starts and activity associations. Clear all invocation/source maps on run end
  (including exceptional completion) and conversation reset; ignore stale events
  from closed runs. Copy only immutable final block data into the transcript.
  Cleanup must not discard fold layout caches belonging to retained blocks.

This is a deliberate scope addition to observer plumbing and an optional execution-context argument, not a change to tool execution behavior or persistence; it must pass the independent design review before coding. Touch points explicitly include core/tools/types.ts, core/loop.ts and core/tools/task.ts, in addition to runner observer metadata and REPL presentation.

Resolve through the actual runner tool registry (the one backing provider tools),
not an extension-name switch. Snapshot hooks at start for live call/result
consistency if registry membership changes while a call runs. Replay resolves
the currently available registered tool at each historical start and uses the
same pair service and budgets; an orphan result resolves at its end. No historical
hook identity is stored, so replay presentation may change with extension version.

Missing/disabled extension, changed name, missing hook or malformed historical
content uses generic presentation. Never load an extension solely to render an
old tool, execute tools, request credentials, read current source files, or fetch
old URLs. Initial TUI replay, resume, tree navigation and live events all use the
same resolver and pairing rules. Received result order, text/thinking boundaries,
Ctrl+O registration and interrupted/orphan handling remain as in the prior design.
Print, legacy shell and replay without the optional TUI sink do not invoke hooks
and retain existing output by default.

## 6. First consumer: web-search extension

Own all search-specific interpretation in `examples/extensions/web-search/`
(prefer a small pure `_lib/presentation.mjs`). There must be no `web_search` name
check, Tavily schema, source regex or web-specific formatting in core/repl.

### Call presentation

Use the existing pure `normalize` logic (or a factored equivalent) without
credential/config access. Summary is the query. Preview contains effective
max-results (default 5), news days when present, include/exclude domains and full
content mode. These are requested filters, not observed result facts. Long lists
remain ordinary budgeted text; expansion includes all original fields and values,
including unknown fields in historical records. On invalid args return undefined
rather than inventing normalized values. Activity uses this summary/preview under
the existing strict 3-total-row activity budget, not raw JSON for every tool.

### Result presentation and parsing decision

Do not change `formatResults`, execute return values, cache entries, or the text
sent to the model merely to support presentation. Do not add structured state to
session records or a process cache keyed by query. The hook parses `result.text`,
not `display`, so saved and live content have the same starting point. It returns
undefined for errors, nonmatching warning/query envelope, malformed layout, or
ambiguous delimiter patterns it can detect. Generic host failure display remains.

A conservative pure parser can identify numbered `[n] title` followed immediately
by a validated `URL: https?://...` line, consecutive numbering from 1, and bounded
source snippets/full-content sections. Preview shows source title and URL;
detail includes identified titles, URLs, snippets and optional full text. Never
fetch or validate availability of a URL. Preserve the original full retained
result text on expansion regardless of parse success.

Important limit: arbitrary title/snippet/raw content can impersonate this textual
format. Strict parsing cannot prove the original API source count. The chosen
conservative policy is to omit source counts entirely, including parsed-entry
counts. Use a nonnumeric summary such as `Search result text` and title/URL
previews; never imply that parsed entries are authoritative API records. A
zero-result message can be presented as `No results reported` only for the exact
empty-result envelope. Any formatter omission marker is quoted as a report from
the result text in budgeted semantic preview/detail; do not invent an omission
count or promote untrusted matches to uncapped metadata. The generic original
text remains accessible even if a marker is outside the collapsed preview.

This batch chooses title/URL previews without counts, rather than leaving the
choice to implementation. An exact original source count would require
unambiguous structured provenance, explicitly out of this batch because it would
change either model content or ephemeral-only/live parity.
No claim of complete full content: it is already bounded to 3000 chars/source,
with snippets 500 and titles 300 and aggregate output 40k. Host view cropping and
upstream/tool text truncation are distinct facts.

## 7. Implementation and test plan (only after review)

Expected touch points: core tool types; extension type exports and optional shape
validation; TUI presentation service/block component; transcript/repl/CLI resolver
wiring; task observer metadata producer and runner forwarding/types; source-keyed
child activity lifecycle; extension-local web-search helper/registration; tests
and extension docs.
Do not change format.ts generic summaries, execution semantics, result persistence
or existing default print/legacy formatting to implement the TUI cleanup.

Deterministic tests, no real APIs, credentials or user settings:

1. Optional hooks/partial hooks/undefined/missing extension use generic fallback;
   unrelated fake extension proves no search-specific core logic. Provider payload
   remains name/description/schema only. Tool result/history/model content are
   deeply unchanged, with display still absent in stored history.
2. Frozen nested snapshots; caller and returned-object later mutation; null vs
   unavailable arguments; cycles/accessors/toJSON/proxies; invalid primitives,
   arrays, depth/node/text limits, thrown resolver/hook, promises and rejected
   async functions, native promises with overridden .then/.catch, and throwing
   then accessors. Verify no arbitrary thenable calls or unsafe fallback traversal,
   no accessor/toJSON invocation, and key-length budget enforcement. No unhandled
   rejection for ordinary rejected async hooks or failure-status suppression.
3. Shared live/activity/replay resolution with invocation counters; same-name
   parallel calls, registry replacement, orphan results,
   two concurrent children with the same agent AND cwd AND identical child
   toolCallIds: assert distinct producer sourceIds, independent snapshots/hook
   counters/activity rows, correct parent association and isolated result cleanup;
   also verify run-end/exception cleanup and legacy missing-sourceId fallback,
   interruption, reset/resume, initial replay and missing extension. No execution
   or network calls when rendering, expanding or replaying.
4. Literal Input/Output/completed headers absent on TUI success; explicit failure
   statuses retained; neutral/thin/diff gutters; ANSI injection, width 1/2, CJK,
   multiline summaries, resize, source/row caps, Ctrl+O and raw-data reachability.
   Semantic text cannot take metadata privileges or starve original expansion.
   Check long call/result summaries consume body budgets, fold layout cache reuse
   across unchanged renders, and separate raw/display/semantic omission counts.
5. Web fixtures: defaults/all filters, valid 0/1/many entries, requested 10 with
   only 2 identifiable entries, invalid entries, omitted marker, title/snippet/
   full-content truncation, malformed/historical formats, delimiters/newlines in
   titles and snippets, source-like text in full content, URLs with controls and
   credential URLs. No parsed-source or API-total counts in result presentation;
   requested max-results remains explicitly a call filter only.
   Cached and uncached execution results remain exactly unchanged.
6. Golden print/legacy and generic fallback tests; pure helper tests import no
   settings/config and mock fetch to throw if invoked. Existing extension harness
   uses temporary HOME/settings and fake fetch only; inspect before reusing it.

After review/implementation run existing worktree-local commands: `npm run
 typecheck`, `npm run lint`, `npm run build`, `npm test`. Inspect scripts/harnesses
before running. Keep dependencies untouched and `.vitest-cache` local per existing
vitest.config.ts; no global installs or shared-cache writes. Report exact counts
and command failures. Independent code review is warranted because hooks span
extension trust boundaries, replay, model/display separation and terminal safety.
No commits, merges, pushes or edits in `../imp`.

## 8. Review gate and explicit questions

Parent must obtain a fresh-context adversarial review before implementation.
Review especially:

- Is the core-owned optional type with extension re-exports correctly layered,
  and can malformed presentation be ignored without changing execution?
- Are reflection/promise handling and snapshot size limits sufficient crash
  guards, with the in-process sync-hook non-sandbox limitation stated clearly?
- Does raw-first expansion budgeting preserve the prior guarantees honestly,
  especially two raw sections for a live display override and semantic detail?
- Do count-free title/URL previews avoid implying provenance that the existing
  ambiguous result text lacks?
- Does task-produced ephemeral sourceId forwarding through runner to REPL,
  including parent association and run-end cleanup, resolve identical-label child
  collisions without persistence changes? Can shared caching/resolution also avoid
  duplicate call hooks, stale registry data and lost initial replay hooks?
- Are metadata/error/omission privileges strictly host-owned, and are print,
  legacy, model payloads, session formats and network behavior unaffected?

Stop after authoring this document. No implementation or self-approval in this
session; existing uncommitted worktree edits are left intact.
