# Task live display: design for independent review

Status: **implemented; independent design and implementation reviews closed**. Preserve parent task display identity independently of provisional activity rows so subsequent sources retain the same prompt and ordinal. Manual terminal acceptance is pending.

Baseline: `ebe8501`, existing `fix/task-live-display` worktree. This document changes no runtime behavior. No new branch, commit, merge, provider request, or deployment is part of this work.

## Scope and observed causes

Fix three TUI presentation problems only:

1. A top-level task's arguments become inspectable only after completion. `createToolSink` in `src/repl/tool-presentation.ts:621–665` currently prepares at start, then appends both input and output at end. `TranscriptSink` creates a fold only when its append callback runs (`src/repl/transcript.ts:58–64`).
2. Pending child activity can read as a generic running task or be dominated by its latest command. `TuiShell.renderActivity` puts tool count and last command before agent/task identity (`src/repl/shell.ts:598–607`); `ToolActivity` has a strict three-row budget, with overflow replacing row three. Parent identity can therefore disappear.
3. Expanded errors repeat the promoted diagnostic and the identical raw result. The metadata suppression in `src/repl/components/tool-block.ts:413–425` is restricted to bash, although generic output blocks already carry exact source evidence.

Task observer identities are already carried correctly through `taskToolCallId` and `sourceId`. No transport, task executor, concurrency, session persistence, child transcript routing, or tool-result content changes are proposed. Print and legacy rendering branches stay byte-for-byte unchanged.

## Existing integration boundaries

- `ReplMachine.submitTurn` first calls `trackActivity`, then sends only top-level events to `Renderer.event`. Child events remain activity-only. An `activeRun` identity rejects events from abandoned runs; `closedParents` rejects late child events.
- `trackActivity` uses `toolSink.prepare` to share one safe argument snapshot and call hook with the renderer. Preparation must remain presentation-only: it must not append or update transcript entries.
- `Renderer.toolStart` and `toolEnd` already flush thinking, flush markdown, and ensure a newline before calling the sink. Keep that ordering. Moving append into `prepare` would bypass these boundaries and is prohibited.
- `Renderer.endRun`, `ReplMachine.clearActivity`, and the error path can all finalize. Finalization must be idempotent. `TranscriptSink.clear` resets the sink and folds for replay/branch switching.
- `replaySession` emits starts while walking stored assistant blocks, then ends from stored result messages, then finalizes. It must use the same sink lifecycle, not an alternate renderer.
- Core serial execution emits start/end per call. Concurrent safe chunks emit starts in call order, await `Promise.all`, then emit ends in call order (`src/core/loop.ts:330–420`). A child that has internally completed may still await the chunk's end emission. Do not change this batching or claim that the UI can detect earlier completion.

## 1. Append input on start, output on end

### Sink state and events

Replace the pending-only bookkeeping with run-local lifecycle entries keyed by tool-call ID. Each entry retains the prepared call, its emitted input block identity if any, and a terminal flag. Completed entries remain until the boundary so duplicate events cannot recreate blocks or rerun hooks. This is bounded by calls in the current run, not the lifetime of the transcript.

| Event | Required behavior |
| --- | --- |
| `prepare(id, ...)` | Snapshot and resolve the call hook once, or return the existing prepared record; no transcript side effect. First arguments win on a duplicate ID. |
| First `start(id, ...)` | Reuse preparation and immediately append exactly one input block. No output block or synthetic result. |
| Duplicate `start` | No append, no hook reexecution, no reset of an existing completed entry. |
| First `end(result)` after start | Append only the output block, with the existing captured result hook, and mark terminal before invoking UI callbacks. |
| `end` after prepare but without start | Append the prepared input, then output. Preparation alone never meant the renderer had emitted a call. |
| Orphan `end` without preparation | Preserve the existing `Arguments unavailable` input fallback, then output; retain terminal identity to reject duplicates. |
| Duplicate `end` | No append and no hook reexecution, even if the duplicate payload differs. IDs identify lifecycle events; this is not payload deduplication. |
| `finalize()` | For emitted, nonterminal inputs, update that input in place to `interrupted (no result)`; never add another input or fabricate output. Discard prepare-only entries without displaying them. Clear lifecycle entries. A second finalize does nothing. |
| `clear()` | Discard lifecycle bookkeeping without interruption updates; transcript clear owns removing its entries. |

IDs may be reused after finalize/clear, as they already can across independent runs and replay. Duplicate suppression is explicitly **within a run**. The sink API has no run token; rejecting an old end after a clear/new run remains the upstream `activeRun` responsibility. Do not add a permanent ID tombstone set that would suppress valid replay. Tests must exercise both layers of this boundary.

Set emitted/terminal state before append/update callbacks, to avoid callback reentrancy duplicating a block. Keep captured call/result hook resolution semantics. The first result remains authoritative; do not silently rebuild arguments from duplicate events.

### In-place interruption updates

Introduce an optional second callback to `createToolSink`, `update(previousBlock, nextBlock)`. Existing append-only test consumers remain valid; production `TranscriptSink` supplies the updater. An append-only consumer sees the immediate input, but cannot project subsequent interruption styling unless it opts into updates; document this limitation on the callback API.

`TranscriptSink` keeps a block-object-to-fold lookup for emitted inputs (not a global call-ID lookup, since IDs may repeat in later runs). On update it replaces that fold's block through an explicit `ToolBlockFold.updateBlock` method, invalidates its render cache, updates the lookup, and requests repaint. Preserve the fold's expansion and raw-argument state, array position, and keyboard selection identity. Clear the lookup with transcript clear. A weak-key lookup avoids retaining extra block histories.

The interruption block preserves arguments, semantic presentation, and metadata; only host lifecycle title/error styling changes. Its visible title must include `interrupted (no result)` even for semantic call headers. Verify this explicitly rather than assuming the current header reads the fallback title. There is no result fold and no session mutation.

### Ordering examples

Notation: `I(A)` is input, `O(A)` is output; letters are IDs, not tool names.

- Serial live: assistant/thinking prefix → start A → `I(A)` → end A → `O(A)` → start B → `I(B)` → end B → `O(B)` → assistant continuation.
- Concurrent live: starts A, B → `I(A), I(B)` immediately; ends A, B after the existing batch settles → `O(A), O(B)`. Sink-only tests may deliberately end B before A and must get `I(A), I(B), O(B), O(A)`.
- Replay: assistant blocks containing A, B → `I(A), I(B)`; saved result message A, B → `O(A), O(B)`. Respect saved block order, including text/thinking between calls. Do not regroup by result or move earlier entries.
- Interrupted A: `I(A)` stays at its original position and is marked interrupted once. A prepare-only activity snapshot creates no fold, including on finalization.

Live serial event order and saved assistant-block/result-message order are not always identical: storage may put several calls in one assistant message before a result batch. This design preserves each source's existing order, not imaginary byte-identical live/replay interleaving.

## 2. Identity-first, bounded activity

Keep the activity region separate from persistent input folds. It reports pending status, not authoritative tool success. Until top-level end arrives, use `pending` for task rows rather than implying a child is still executing. Tool counts mean observed child tool starts, not successful tools or currently active tools. Do not infer failure, completion, or remaining work from child text.

Project each task row into three independent lines, rather than one wrap-prone concatenation:

1. Status/elapsed plus stable short parent discriminator and agent name: for example `└─ pending #2 scout 8s`.
2. Parent task prompt/summary, single-line, width-truncated.
3. Child detail, if present: `3 tool starts · last: bash ...`, single-line, width-truncated.

Use host-assigned run-local ordinal discriminators keyed by `taskToolId` (fall back to `sourceId` only when no parent is available). Do not truncate opaque IDs and assume uniqueness. Keep the ordinal stable when the provisional parent row is replaced by a source row. Reset on idle/clear. Two concurrent calls with the same agent and prompt must still show distinct ordinals. Source and parent IDs remain the removal/map identities; labels never become keys. For multiple sources sharing a parent, retain existing source separation and add a source discriminator if otherwise indistinguishable.

Add an explicit structured task-row mode to `ToolActivity` (or a small sibling component sharing its sanitization helper); preserve existing generic tool activity behavior. Reorder legacy-free TUI task data construction to prefer the safely snapshotted `rawArgs.prompt` and `rawArgs.agent` where present, then the already-prepared semantic label as fallback. Never traverse original event arguments again or rerun presentation hooks for ticks, resize, or expansion. Preserve `lastTool` as descriptive history, not active-tool status.

Activity strings are untrusted terminal input. Bound each raw display field to 2048 UTF-16 code units before sanitizing, sanitize with `sanitizeDisplay`, flatten LF/CR and Unicode line separators, then width-truncate with an ellipsis. Bound the sanitized intermediate to 4096 code units before layout; do not split a surrogate pair at either text cap. Cutting an escape sequence must not allow its remainder to execute: sanitization always follows the raw cap and precedes rendering. Elapsed and counts are host-owned, nonnegative finite integers with bounded display (for example `9999+`). Each row is at most three physical rows at every width, including 1, and every row is at most terminal width. The discriminator precedes long agent text; at extremely narrow widths only a prefix can fit, which is an unavoidable display limitation, not an identity collision in state.

No provider callback, task callback, or network operation is added. All fields come from existing snapshots and safe preparation. Merely calling `setActivity`, ticking, or resizing must never allocate a transcript fold.

## 3. Expanded diagnostic deduplication by exact evidence

Reuse `outputBlock.promotedEvidence` and `ToolBlockFold.evidenceVisible`, rather than introducing string-wide replacement or task-specific regex removal.

Remove only the bash-name restriction on the **promoted diagnostic metadata** suppression. Require all existing predicates: expanded output, metadata equals the sanitized spelling of the promoted raw diagnostic, and a selected source section proves an exact original occurrence was completely rendered. The proof checks source ID, original line index, exact raw equality, non-diff section, all physical fragments present within the 1000-row body budget, and lossless rendering. A merely matching substring, sanitized collision, cropped line, or semantic summary is not proof.

Keep bash-specific exit-title behavior unchanged. Keep collapsed diagnostics, `failed`/`partial`/`limited` status, task recovery transcript notices, host notices, section captions, omissions, and all original payload lines. Do not deduplicate raw sections against one another: if content and display independently contain a line, each remains inspectable. Repeated identical payload lines remain repeated. Distinct error lines remain visible. This change removes redundant host chrome only when raw evidence already exposes it in full.

## Architecture risks and limits

- Pending inputs are now real transcript folds. They participate in expansion/raw toggles and fold navigation before completion. An append-only transcript suffices for normal starts/results, but interruption requires the explicit update path above; appending a second interrupted call is not acceptable.
- Moving the call earlier can change viewport height and scroll anchoring. Existing shell folding/navigation is based on `toolFolds`; verify pending expansion, keyboard selection, completion append, resize, clear, and branch replay with the real shell.
- Results remain separate ordered components, not children inserted beneath their inputs. Concurrent calls can therefore be separated from their results by other inputs. Do not redesign transcript grouping in this fix. Existing IDs and event order remain authoritative; delayed input/result adjacency is no longer a supported test assumption.
- Earlier insertion must occur only through renderer boundaries. Test partial markdown, open semantic thinking, and later assistant output for loss, duplication, or movement.
- Run-local completed records retain snapshots until finalization. Clear all on every existing end/error/interrupt/exit path; no timer or activity component may own them afterward.
- Batched completion can leave a task pending after its internal child finishes. The honest label is pending, not a promise of real-time child lifecycle telemetry. Changing end batching requires a separate design.
- Clearing the transcript cannot on its own reject stale event producers. Maintain the existing upstream run guard and test it; broadening the sink into an event transport is out of scope.

## Regression plan (offline; implementation phase only)

Use existing scripted providers, temporary fixtures, and fake terminals. No paid APIs, real credentials, network callbacks, or external child processes are needed for the new regressions.

1. `test/tool-presentation.test.ts` and `test/tool-presentation-integration.test.ts`: immediate input after start and no output before end; prepare alone yields zero blocks; duplicate prepare/start/end; orphan end; prepare-then-end; input order versus end order; once-only call/result hooks; first snapshot immutability; interrupted in-place update and cache invalidation; repeated finalize; clear; ID reuse in a new lifecycle. Update old completion-pair assertions deliberately, not by bulk snapshot acceptance.
2. `test/repl-tui.test.ts`: extend `startTuiRepl`, `scriptedProvider`, `gate`, and `FakeTerminal`. First request a nonexistent `scout` profile and render its error; next request a generic task whose scripted child is held on a gate. Before releasing it, assert the second task input exists exactly once, its prompt can be expanded, no second result exists, and current activity identifies the second task rather than the failed scout. Have the held child emit a long bash-like tool-start label (a fake registered tool, not a real command) to prove parent identity survives. Release the gate and assert exactly one result, stable input identity, assistant continuation order, and idle cleanup.
3. Use a fresh forced repaint/marked write interval, not `frameSince(0)` alone, for pending/current-screen assertions; old failed text in terminal history is not evidence of current activity. Assert fold state as well as visible screen output. Keep fixtures short enough to fit the fake screen and wait on gate/event state rather than arbitrary sleeps.
4. Concurrent same-agent tasks with identical prompts: distinct stable ordinals, correct source-to-parent replacement, long child details, out-of-order observer events, one parent closing while the other remains, and late-child rejection. No child tool fold may appear. Test shell snapshots separately to prove they allocate zero folds and invoke zero hooks on repaint/resize/tick.
5. Renderer/replay tests: thinking → partial markdown → input → result → assistant tail, calls interspersed with assistant blocks, multiple starts before results, persisted replay, orphan and dangling calls, clear and replay after interruption. Assert stored messages unchanged. Exercise interruption both before and after a call was emitted.
6. Expanded diagnostic tests in `test/tool-display-refinement.test.ts` / `test/tool-presentation.test.ts`: task missing-profile error and generic extension error once when fully visible; collapsed error still visible; repeated raw lines retained; distinct errors retained; separate content/display retained; exact diagnostic absent from selected/reached section; cap boundary at rows 999/1000/1001 and a line wrapping across the cap; narrow wide-glyph loss; control-sequence sanitization collisions; multiline control strings breaking source alignment; resize/expand toggles; task recovery artifact and existing bash exit behavior unchanged.
7. Activity tests: widths 1, 2, 20, 80; long agent/prompt/child labels; LF/CR, CSI/OSC, tabs, Unicode separators, combining/wide glyphs; bounded counts; no more than three rows and no over-width output. Confirm upstream strings and session content are untouched.

After implementation, run focused suites above, existing builtin presentation and render/replay suites, then `npm run typecheck`, `npm test`, and `npm run lint`. Report actual commands and exact results. Investigate all existing fold-index expectations, including pending clear and replay cases in `test/repl-tui.test.ts`, rather than weakening assertions to accept extra folds.

## Review gate

The pre-implementation gate required an independent fresh-context review of lifecycle boundaries, the update callback, duplicate/run semantics, source evidence, narrow-screen identity, batched pending claims, and the offline integration test. That review approved the design before implementation, specifically requiring parent display identity to survive removal of provisional activity rows.

Independent implementation review subsequently approved the change with no blocking findings. The reviewer ran 292 tests across 10 files and additional reentrancy, lifecycle reuse, and control/surrogate-boundary checks. Final verification passed typecheck, lint, build, and 1,918 tests across 97 files. A non-failing process-exit-listener MaxListenersExceededWarning occurred in the TUI tests. Manual terminal acceptance, commit, merge, and push are not claimed by this record.
