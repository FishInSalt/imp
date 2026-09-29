# Changelog

All notable changes to imp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While imp is at
0.x, minor releases may include behavior changes.

## [Unreleased]

### Changed

- **Task live view in its own header (#task-inline-live-rows).** A running
  `task` call's live overview (the `└─ pending #N …` line with the agent and
  the elapsed time, plus its `N tool starts · last: …` row) moved out of the
  bottom activity region and into the transcript, directly under that call's
  own `● task` header. Concurrent subagents therefore read top to bottom in launch order —
  header, its own live line, its own result — instead of all headers stacked
  above all overview rows.

- **Confirm prompt surface, Phase 1 (#confirm-prompt).** The guardian-style
  approval ask is legible now: the transcript keeps one `▪ confirm:` record line
  (the dim detail note is written only where no picker exists — readline,
  no-host and print paths are byte-identical), the picker numbers its rows
  (`→ 1. Yes`) on non-filterable pickers, digits `1`–`9` answer directly, and a
  dim affordance line sits under the items
  (`(↑/↓ move · enter select · esc cancel · 1-3 quick pick)`). Filterable
  pickers are untouched: digits stay query characters and no hint row is added.
  Design + five adversarial review rounds: `docs/confirm-prompt-design.md`
  (Phase 2, the extension-facing seam, follows separately).

- **TUI tool-call duration (#tui-tool-elapsed).** Completed tool calls in the
  TUI transcript carry a marker — green `✓` for successes, red `✗` for
  failures — with a dim wall-time suffix when the call took ≥1s
  (`● bash  npm test ✓ 2.3s`; `1m03s` minute form); sub-second calls show
  the bare marker (amendments 2-3). Interruptions and replayed history carry
  none; legacy and print rendering are unchanged. Design + adversarial
  review: `docs/tui-tool-elapsed-design.md`.

- **Loop health monitoring + uncapped children (#loop-health).** Subagents no
  longer stop at a 60-turn wall (`CHILD_MAX_TURNS` removed; owner decisions
  2026-09-29: no numeric valve, no prompt injection). A shared,
  observation-only loop-health monitor now runs in both the subagent engine
  and the main loop and detects three conditions from the existing event
  stream: repeated identical tool-call turns, repeated failed `edit`/`write`
  attempts, and the child's
  compaction-failure backstop. Child facts surface honestly (task-result
  lines + a `health` field on the TaskRecord); first fires render one dim
  REPL note (`▪ health: …`; `IMP_HEALTH=0` disables; thresholds overridable
  via `IMP_HEALTH_*` env). Nothing is injected into any model context; print
  mode gains no health output of its own (a fired signal's task-result text
  change shows there only in the tool row's line count). Design + two-track
  adversarial review (plus two folded post-merge review rounds):
  `docs/loop-health-design.md`.

- **Startup model resolution (#startup-model-resolution).** A machine whose
  only credential belongs to a non-anthropic family no longer demands a
  manual `/model` in every new session:
  - when the builtin startup default is unusable and exactly ONE credential
    source exists (the shared-`MOONSHOT_API_KEY` pair counts once), imp
    resolves that family's curated `switchHint` (`zai/glm-5.3`, …) — one
    `▪` note, never written to settings, seeded as a non-explicit session
    model, print mode resolves silently;
  - `/login` auto-selects the family's switchHint when no usable model
    exists (a usable model is never replaced);
  - an explicit `/model` switch prints a one-time pointer:
    `/settings defaultModel <id>` keeps it for new sessions;
  - `imp -c`/`-r` re-resolves a stale restored model the same way (the
    recorded `session_model` row is intentionally left as-is);
  - copy: with a configured provider present, `no model available — run
    /login` becomes `no model selected — /model` on the banner/footer/title,
    the runner note lists the configured families, and print-mode failure
    text names `-m <hint>` / the env-var family instead of the dead default.

- **Fresh-install model honesty (#fresh-install-hint).** On a machine
  with no credentials anywhere, imp 0.1.0 displayed the hardcoded startup
  default (`claude-sonnet-4-5`) as if it were in use — banner, footer, and
  session seed — and only failed on the first message. Now:
  - the banner identity line, footer, and resumed-session lines render
    `no model available — run /login to connect one` / `no model — /login`
    instead of the unusable model id (the think segment is dropped while
    unusable);
  - one startup `▪` note teaches `/login` (all seven families listed) or
    the env var — a configured-elsewhere machine gets the targeted
    `run /login <family>` form;
  - print mode (`imp -p …`) fails fast BEFORE any session/log write with a
    family-targeted error (`@file` argument errors still win the exit);
  - the dead default is never persisted: all three `seedModel` sites
    (startup, `/new`, resume restore) are gated on live usability, so
    `imp -c` can no longer resurrect it; sessions written by 0.1.0 resume
    unchanged (no migration, nothing rewritten);
  - `/login` and `/logout` repaint the footer, so the model segment flips
    immediately after a credential change;
  - the anthropic "No API key found" error now also teaches
    `/login anthropic`.

### Fixed

- **A tool's result stays under its own call (#tool-result-follows-call).** A
  concurrency-safe chunk emits every `tool_start` before any `tool_end` (for
  deterministic result ordering), so a result block used to be appended after
  all headers — five parallel `task` calls rendered as five headers followed by
  five detached `⎿` blocks. Each result fold is now placed directly after its
  own call's header, while the loop's emission order is untouched. Print mode
  and the legacy shell are byte-identical.

- **Per-call settle: real durations, live completion (#tool-settle).** Every
  call in a concurrent chunk used to report the batch's wall time (five tasks
  all showing `✓ 8.9s`) and nothing updated until the slowest finished. Each
  call is now measured at its own settle point, so its row shows its own
  runtime, and its activity row, `✓`/`✗` marker and `⎿` result land as soon as
  that call finishes — not when the chunk drains. The emitted
  `tool_settled` event is display-only: history, the session file, extension
  hooks, print output and replay are unchanged.

## [0.1.0] - 2026-09-27

Initial public release: imp is a small coding agent that runs in your
terminal.

- Interactive TUI (streaming, one-line tool status, queued steering and
  follow-up runs) plus print mode (`imp -p "..."`) and piped stdin
- Agent loop with tool execution: abort, validation, error feedback,
  steering hooks, and a compaction hook
- Sessions: append-only JSONL message trees (`~/.imp/sessions/`),
  `--continue` / `--resume <id>` / `imp sessions`, the `/tree` navigator,
  `/fork`
- Auto-compaction: older turns are summarized into a checkpoint near the
  context limit; the full history on disk is preserved
- Tools: `bash`, `read` (offset/limit, images), `edit`, `write`, `grep`,
  `find`, `ls`, `task` (subagents); the search tools respect .gitignore
- Providers: Anthropic, Z.AI (GLM), DeepSeek, Moonshot/Kimi, and OpenAI
  (API key or ChatGPT-plan OAuth); credentials from environment variables
  or `/login`
- Extensions, skills, named subagents, MCP servers, markdown quick commands,
  and custom system prompts (SYSTEM.md)

See the README's Status section for the full current capability list.
