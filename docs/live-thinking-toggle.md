# Live thinking visibility without session replay

Status: proposed design; implementation not started.

## 1. Problem and goals

Ctrl+T currently flips Renderer.hideThinking and persists it. While busy, it returns after a status line; while idle, it clears the transcript and replays the current session context. The busy path cannot retract already emitted thinking; the idle path can lose display-only output and tool-fold state. No-session mode cannot rebuild anything. Hidden thinking is discarded from the presentation stream after its placeholder is emitted.

Make Ctrl+T a reversible presentation operation for every thinking section retained in the current TUI transcript, including a partially streamed section. Switching visibility must not require a model response, a session, or an idle runner. It must not mutate conversation history, session files, tool bookkeeping, the editor, or stream buffers. Existing settings persistence remains.

## 2. Scope and terminal constraint

Implement semantic thinking entries inside the existing transcript and retain the current pi-tui/native-terminal layout. This completes live visibility and content-retention behavior without replacing the terminal UI framework or tool execution.

IMPORTANT: native terminal scrollback position is outside the application's observable state. pi-tui can clear/repaint scrollback when a changed row is above the visible viewport. Changing the height of old content therefore cannot guarantee preservation of the user's native scroll position. The application will not explicitly clear, replay, force-render, or introduce a new scroll-to-bottom operation for Ctrl+T, but ordinary pi-tui rendering can still cause a history redraw/jump. This limitation must be communicated, not claimed fixed by stable entry IDs.

A strict no-jump guarantee would require a separate application-owned history viewport and scroll navigation (and terminal lifecycle/layout decisions). That is NOT a prerequisite for correct thinking visibility and is excluded from this change. Do not silently add an alternate screen or replace native scrollback. If strict scroll preservation is required for acceptance, implementation must pause for a separate viewport design instead.

Non-goals: per-block keyboard selection, hiding tool results, changing model reasoning levels, deleting thinking from sessions, changing print output, provider routing, or broader scrolling redesign. Collapsing is not secure redaction; original content remains in memory, session data, and possibly terminal scrollback.

## 3. Architecture decision

Keep ordinary answer rendering and its Markdown buffering unchanged. Add an optional semantic thinking sink to Renderer for TUI only. Do not infer thinking from ANSI sequences, search displayed text, or reconstruct output from runner.history/session.buildContext.

### 3.1 Ordered transcript entries

Refactor TranscriptSink's storage from parallel line arrays plus line-count child anchors into an ordered list of stable entries:

- line: existing plain, user, or status text and its current style;
- thinking: retained raw thinking chunks, open/closed state, stable identity, presentation cache;
- component: the actual existing tool Fold instance;
- open text tail: represented at its insertion position, rather than always appended after every component.

Keep the existing public feed, feedUser, feedStatus, appendChild, render, and clear surfaces. The byte parser still handles newline and split CR/erase-line sequences. Structural insertions settle preceding ordinary text at a defined boundary; neither visibility changes nor thinking appends invoke that parser. Each entry wraps independently; ordinary completed-line caches survive thinking updates and visibility changes. Do not concatenate/reparse the whole transcript per thinking delta.

Structural-boundary rule: before begin(), appendChild(), feedUser(), or feedStatus(), resolve any incomplete parser carry by appending it literally to the ordinary tail, then commit a nonempty tail as a completed ordinary entry. Discard no received bytes. An empty tail creates no blank row. Reset carry to empty, insert the new structural entry, and allocate subsequent ordinary output after it. A reset marker may span feed() calls but never a structural boundary. Thus feed("answer\\r") -> thinking begin/append/end -> feed("\\x1b[2Knext\\n") retains the first ordinary line and the thinking entry; the latter incomplete marker suffix is literal content in a new line, not a retroactive erase. feed("tail") -> appendChild(fold) -> feed("next\\n") renders tail, fold, next in that order. This follows the existing sink's verbatim treatment of arbitrary model cursor bytes; sanitizing those bytes is separate scope.

The explicit ordering preserves user padding/background, command output, startup notes, fold identity and expanded state, and statuses. Consecutive-status replacement applies only to immediately adjacent status entries; a thinking or fold entry breaks adjacency. A toggle is not a transcript status entry (see section 4).

clear() invalidates every handle, drops entries, parser carry AND the open current text, and all presentation caches. A thinking handle retains only the sink reference plus generation/identity, never a raw entry or chunks; append/end after clear are harmless no-ops, never writes into the next session. Active-stream clearing remains guarded by existing command rules. Visibility preference survives clear.

completedLines() remains an assertion surface for completed ordinary lines (excluding components). It is not the source of truth for visible thinking. Move thinking-visibility assertions to render(width); use explicit entry/handle assertions for retained content where necessary. Existing ordinary-line tests must keep passing. Do not expose retained raw thinking through a visible-output helper.

### 3.2 Semantic output contract

A small shared type module, independent of TranscriptSink and pi-tui, defines a thinking sink and opaque section handle, conceptually:

```ts
interface ThinkingSection {
  append(delta: string): void;
  end(): void;
}
interface ThinkingSink {
  begin(): ThinkingSection;
  setHidden(hidden: boolean): void;
}
```

TranscriptSink supplies this interface; RendererOptions accepts it optionally. One live Renderer owns at most one active handle. Replay renderers create settled entries through the same sink. No thinking bytes are also emitted via Renderer.write when the sink is attached.

The sink stores all raw deltas, even when hidden. A visible active entry displays every received character, including its incomplete paragraph; it does not wait for a blank line. This is a deliberate TUI-only improvement over paragraph-buffered thinking. Presentation uses the existing dim/italic style and ANSI/CJK-safe width utilities. Leading/trailing whitespace-only content must not produce an empty placeholder; retain the raw content and derive the visible body without destructive trimming. Closed sections have the current section spacing; active and closed rendering must not duplicate separators.

Hidden nonempty sections render one dim `Thinking...` placeholder each, regardless of delta count or paragraph count. Reveal is immediate even if no further event arrives. Repeated toggles never consume or append source text. Use chunk storage and dirty wrap caches; hidden appends need not rewrap hidden bodies or request a repaint if the placeholder is already present. Coalesce rendering through existing requestRender scheduling. Expanded-body caches are keyed by content revision, width, and open/closed presentation state. Every append increments revision even while hidden; reveal may never reuse a pre-append expanded cache. Visibility selects between body and placeholder projections, not between raw stores. Whitespace-only -> nonempty triggers the first placeholder repaint. end() is idempotent and invalidates spacing when open/closed presentation changes. Resize while hidden cannot validate a stale body cache.

### 3.3 Renderer lifecycle

Use a semantic path only when ThinkingSink is supplied; preserve the existing byte-only path for print/legacy modes and its golden tests.

- First thinking delta: settle any preceding buffered answer once, establish a thinking section, then append the delta.
- Further thinking deltas: append to the same handle, independent of visibility.
- Answer text, a tool start, or assistant message_end: close the section before subsequent content is rendered.
- Settled thinking(text) in replay: begin, append, end; use the same styling and visibility as live entries.
- End-of-run, abort, and failure: end any active section exactly once, retaining partial thinking already received.
- Other transcript-writing Renderer methods (note, status, user, error, writeLine, raw, tool completion) close an active thinking section before inserting their own output. Subsequent thinking starts a new section. This explicitly preserves arrival order when commands or notices interleave with a model stream; no later thinking is appended above intervening transcript output.
- Ctrl+T itself bypasses those transcript-writing methods: it does not close or split the section, flush Markdown, stop spinners, or clear pending tools.

All new section-closing behavior is semantic-path-only, including message_end and ordinary notice/tool-completion boundaries. A private closeSemanticThinking() only ends/detaches the handle: it never calls public output methods recursively, flushes answer Markdown, or modifies pending tools. Separate ordinary-output preparation settles answer Markdown only where the existing method already requires it. Preserve the REPL event order: renderer.event(tool_end) before showResultFold(), and renderer.event(message_end) before footer refresh/warnings.

Replay requires lifecycle changes in addition to forwarding the sink. Send original untrimmed thinking to the semantic path; retain legacy trimming for the byte-only path. thinking(text) settles preceding answer Markdown before creating its closed semantic entry. Route replay user messages through renderer.user() rather than bypassing lifecycle via userSink. Explicitly settle each assistant-message boundary through a no-spinner Renderer completion method; the semantic path closes any section and settles preceding answer output so a later direct structural insertion cannot overtake it. Consecutive thinking-only assistant messages remain distinct. Any compatibility differences for legacy replay must be prevented by keeping its existing path unchanged.

Keep hideThinking assignment-compatible via an accessor or a single setter called by every current assignment (CLI merged-settings initialization included). Updating it synchronizes the semantic sink's visibility for all entries. Replay must receive the same sink and current preference. Startup, no-session, /new, /resume, and tree replay must all use this path; no second disconnected TranscriptSink may be created.

## 4. Toggle transaction and feedback

For TUI, ReplMachine.toggleThinkingVisibility becomes:

1. Set the new Renderer visibility preference (which updates the shared sink).
2. Persist hideThinkingBlock using the existing settings mechanism.
3. Publish `Thinking blocks: hidden` or `Thinking blocks: visible` through a presentation-only TuiShell notification, not Renderer.status.
4. Request a normal render, coalesced with sink updates.

Add an optional LineInput presentation-notice method and implement it in TuiShell as a separate short-lived notice row within the hint area (two seconds). The notice remains visible with a nonempty editor draft and during an active ask; it does not steal focus or replace the question. Hide it while a selector owns focus, without pausing its expiry; Ctrl+T remains blocked by the existing selector key routing. Preserve the existing hint/interrupt rows independently rather than concatenating/truncating them with the notice. At narrow widths wrap/truncate only the notice using the normal width-safe utilities; do not discard the interrupt instructions to make room. Every placeholder refresh recomposes base hints and notice from state. Newer toggles replace the notice and reset its expiry. close() cancels the timer immediately (not at delayed terminal shutdown), and expiry callbacks check closed state before requesting render. No stale callback may clear a newer notice. Legacy callers without this method may retain status fallback; their byte path is not being given retroactive terminal editing.

Remove clearConversation/replay and the idle/session checks from the TUI toggle path. Session navigation still intentionally clears and replays; visibility toggling does not. The persisted setting is the only durable change; no writes to user settings are allowed in tests (use temporary paths).

## 5. Wiring and compatibility

Expected implementation areas:

- src/render.ts and a shared thinking-sink type module: optional sink and stream lifecycle.
- src/repl/transcript.ts: ordered entries, semantic thinking retention/rendering, cache invalidation and reset.
- src/repl/replay.ts: forward sink into its Renderer.
- src/cli.ts and src/repl/repl.ts: wire the exact shared transcript into live/replay renderers; pure visibility toggle.
- src/repl/line-input.ts and src/repl/shell.ts: presentation-only toggle notice.
- Existing renderer/transcript/replay/fold/status/TUI tests plus focused new coverage.

The component model must retain actual Fold objects; session replay must no longer erase their expanded state on Ctrl+T. /compact and /tree machine guards and activity remain unchanged. Existing selector handling of Ctrl+T is unchanged. Deferred answer Markdown remains deferred; a toggle must not change its eventual byte content or formatting.

No npm dependency, global configuration migration, real model API, or real user session modification is required for the feature. A test-only terminal emulator may be considered if existing fixtures cannot prove redraw correctness; evaluate existing dependencies before adding one.

## 6. Acceptance tests

### Transcript/model

- Several completed thinking paragraphs plus a partial tail: hide/reveal without another provider delta; raw content survives exactly once.
- Initially hidden thinking: reveal before section end, including partial first paragraph.
- Whitespace-only, multi-line, ANSI, CJK, and width-one cases; no rendered row exceeds terminal width.
- Ordinary output, user blocks, statuses and tool folds remain in insertion order; existing fold identity/expanded state survives toggles.
- Clear with ordinary current text, partial reset marker, and an active thinking handle; stale handles cannot affect the new transcript. Cover the exact structural-boundary sequences in section 3.1.
- Hide after creating an expanded-body cache, append while hidden, resize/end while hidden, then reveal: all new content appears exactly once and spacing/cache state is correct.
- Hidden appends do not continually rewrap historical thinking; old ordinary caches remain valid.

### Renderer and integration

- Toggle during gated model streaming, after thinking while the answer is still streaming, and during gated/parallel tools.
- Repeated toggles preserve the unfinished answer Markdown buffer; after completion, answer output matches a no-toggle control run.
- Completed prior thinking collapses during a new run, as does current thinking.
- Exact `Thinking...` placeholder per section; no duplicated thinking bytes through the generic feed path.
- Interleaved /status or other command output has deterministic arrival order and may split a thinking section; Ctrl+T does not split it.
- Normal finish, thinking-only finish, cancellation, and exception retain partial sections with correct visibility.
- Exact-order tests: thinking -> message_end -> footer warning/status -> next thinking; thinking -> tool completion -> Fold insertion -> next thinking; thinking -> error -> endRun.
- Replay text -> thinking -> user, and consecutive thinking-only assistant messages: verify ordering, section boundaries, and untrimmed retained semantic source.
- Idle and no-session toggling work without replay. Assert clearConversation, session replay and model calls are not invoked by the toggle.
- Startup hidden preference, merged project preference, replay of persisted thinking, /new, /resume and /tree share the same sink and flag.
- Editor draft, activity rows, tool result bookkeeping, fold state and temporary notices remain intact.
- Notice expiry/replacement and shell shutdown do not leak timers or repaint closed terminals.
- Existing print/legacy golden output remains unchanged.

### Terminal checks

Test a long transcript exceeding terminal height with collapsed/expanded regions, and resize after toggling. Transcript render-array tests prove retained content and ordering; FakeTerminal.frameSince is a byte log, NOT a terminal emulator, so it cannot prove absence of stale rows or duplicates on screen. Add cursor/erase-aware screen testing or perform a documented PTY/emulator verification for physical redraw behavior. Do not assert that native scrollback is preserved or that pi-tui never emits CSI 3J; section 2 explicitly excludes that guarantee.

Run typecheck, lint, build and the full test suite, then independent implementation review. Do not weaken tests by only asserting status text or final session history.

## 7. Implementation sequence and review boundaries

1. Ordered transcript entries and reset invariants, with ordinary-output/fold/status compatibility tests.
2. Semantic thinking sink and live/replay wiring; keep legacy output tests unchanged.
3. Pure Ctrl+T display transaction and shell notice; remove replay-dependent tests and replace with stronger mid-stream tests.
4. Full terminal/integration verification and independent code review.

All four steps are required for the live-visibility feature; a completion-time-only replay is not an acceptable substitute. The native scrollback limitation is a separate, explicit scope decision rather than unfinished thinking visibility.
