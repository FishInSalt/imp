# Per-session model restoration

## User contract

Each session remembers its current provider and model, independently of defaults
and other sessions. Startup `--resume` / `--continue` and interactive `/resume`
restore this selection before restoring thinking. `/fork` and `/tree` change
history, not the session-wide model. A real `/model` change persists immediately,
even before a message. An unchanged selection is a no-op.

An explicit startup `-m` / `--model` overrides the selected session on startup and
persists that choice. This is a one-time startup override, not a permanent override
of later interactive `/resume` calls. Environment/settings defaults do not override
recorded models. Old sessions without metadata use the original startup model,
not the previous live session's model. No model discovery or credential-driven
fallback occurs; provider request errors remain visible. There is no API request
at restoration time to validate model availability.

## Persistence

Use file-level `session_model` records (not tree entries):
`{"type":"session_model","provider":"zai","modelId":"glm-5.3","explicit":true}`.
Legacy staged seeds use `explicit:false`; both restore models, only true makes
otherwise message-free files discoverable. Validate explicit as a required boolean.
Store provider explicitly; display references omit the anthropic prefix and can
misroute an explicit anthropic/glm-* reference if reused for persistence.

Store APIs:
- `getModel(): {provider: string; modelId: string} | undefined` returns a copy.
- `seedModel(model)` stages initial metadata without writing, only if no saved or
  pending model exists. The next meaningful entry writes this seed as an optional
  `model` field in the header for new files, or an explicit:false `session_model` line for legacy
  files. A seed alone must not make a pristine session discoverable or create it.
- `setModel(model)` writes a session_model record immediately only when it differs
  from the effective model (including pending seed). A first selection writes the
  header plus final selection, not a stale pending seed. Returns after successful
  write; in-memory model changes only after persistence succeeds.
- `hasModelSelection` indicates an explicit session_model record, not header seed.
  Default listing includes files with messages OR explicit model selection. Thus
  changing model before talking is recoverable through -c and the picker, while
  untouched, header-only, name-only, and thinking-only sessions stay hidden.
  For model-only sessions show `(model: provider/modelId)` instead of empty title.

Latest model record in file order wins regardless of branch. Model records never
enter getEntries/tree/context/stats and never modify lastEntryIndex or leaf; a
model change after a position marker must preserve the position on reopen.
Validate provider against supported families and nonblank modelId; malformed model
metadata errors are surfaced (skip unreadable sessions in listings). Existing torn
final entry handling remains; malformed final model records may follow that policy.
Unknown provider is not coerced to anthropic. File version stays 1; old readers
are not guaranteed to understand new metadata. No bulk migration.

Factor existing exclusive lazy writer for both entry and file-level writes. Keep
its fail-closed first-write handling. A failed write must not update model/entries.
For legacy files seeded metadata and the next entry are appended in one write.
Existing subsequent-append crash atomicity limitations are not widened or claimed
fixed. New sessions and /new stage the live model; startup/exit with no data still
creates no file. Metadata writes such as /name capture the initial model too.

## Runner / CLI

Add `modelExplicit` boolean to CLI parsing and optional RunnerOptions field.
Only -m/--model sets it. Preserve provider injection in tests and same-family reuse.
Separate prepare/apply model operations from persistence:
1. Parse and validate reference, prepare replacement provider before mutations.
2. Persist user selection/explicit startup override if needed.
3. Apply provider, model, context-window settings and thinking clamp.
A failed provider preparation or write leaves live state unchanged.

Warmup and resume resolve/build target context before swapping live state. Choose
model using explicit startup override (warmup only), saved model, startup model.
Prepare provider, persist override or stage missing seed, then install model,
history and store. Restore thinking against the restored model. On startup reset
thinking from the original requested/settings/default level before clamping, so a
knob-less startup default does not erase it before a thinking-capable restore.
Mark initialized only after successful warmup. /new keeps the current model.
Restore is not a new model change and normally does not append records.
Print the effective model in resume status so restoration is observable.
No new login or model API discovery requests. Missing credentials do not select a
different model; errors occur through existing provider handling.

## Tests / scope

- Store seed remains lazy; initial metadata writes capture model; explicit change
  creates a file; same selection no duplicate; latest wins across branches;
  model record after position keeps leaf; context/stats unchanged; malformed data;
  provider-qualified IDs; first-write failures leave model unchanged.
- Listing model-only selections vs other metadata-only files and initial seeds.
  Legacy header-only + /name or thinking writes explicit:false seed, restores it,
  but stays hidden until a real model change. Same explicit -m as saved selection
  must not append or change mtime; different -m must persist.
- Runner startup resume/continue/interactive resume, per-session independence,
  initial default captured before any switch, explicit CLI override and subsequent
  interactive resume, old-file fallback after another live selection, /new,
  deferred warmup, provider family restore, thinking clamp order, write failure.
- Actual CLI test distinguishes explicit flags from environment default selection.
- Run existing persistence/replay/REPL tests, full suite, typecheck and build.
- No real API requests or user/global configuration edits. Design and final code
  require independent review. Adjacent provider credential fallback defects and
  unrelated thinking branch semantics are separate work unless restoration
  introduces a new regression.
