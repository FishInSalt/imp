# Changelog

All notable changes to Ink (formerly imp) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Ink is at
0.x, minor releases may include behavior changes. Historical entries retain
their original release identity.

## [Unreleased]

### Added

- **guardian — the config-driven permission gate (#guardian).** The
  shipped gate example is `examples/extensions/guardian.mjs` now: rules are
  plain text with `*` wildcards that span anything including newlines (or
  `regex` for full regular expressions), split into ordered `deny` / `ask`
  lists (`deny` wins), with an optional `reason` shown to the human and
  optional `tool` scoping — `write` / `edit` rules match the resolved file
  path, bash rules match the command. Anything unmatched runs; there is no
  `allow` action. A broken config keeps the last good rules (footer hint,
  `/guardian reload`); every deny/ask outcome is audited to
  `~/.ink/guardian.log`. The ask picker red-highlights the span the rule
  matched (`preview.warnSpans`). An ask question left unanswered can now
  time out (`askTimeoutMs`, a new optional host-side deadline on
  `api.confirm`; the shipped template uses 10 minutes): the timeout counts
  as declined, is audited as `timeout`, grants no session memory, and
  reaches the model with its own wording, distinct from a manual decline.
  While a deadline is set, the picker's question line carries the dim
  countdown in parentheses right next to it (e.g. `allow this bash
  command? (9:59)`, ticking down).
  The template was rebuilt around portable, catastrophe-only rules
  (whole-home and filesystem-root wipes, disk tools, the `.ssh` folder,
  remote-destroying git / gh operations). Start from
  `examples/extensions/guardian.template.json`; design and review log:
  `docs/guardian-design.md`.

- **Tool-name colors via extensions (#tool-name-colors).** Tool names in the
  TUI call header can carry a color now, through a new load-gated extension
  registration `api.registerToolColor(names, color)` — one name, several, or
  `"*"`, with any of the 16 standard-16 tokens, `"none"` (bold-only), or an
  absolute token: `#rrggbb` (truecolor) or `ansi256:N` (0–255). Named
  tokens follow the terminal theme; absolute tokens do not, by design.
  `api.suggestToolColor(names, color)` is the author tier: a tool's own
  extension suggests its default look, and any user registration outranks
  any suggestion (resolution: user exact > user `"*"` > suggested exact >
  suggested `"*"`). Nothing is colored by default; opt-in themes ship as
  extensions (the owner's palette lives in
  `examples/extensions/tool-colors.mjs`, which also doubles as the API
  example). Exact names beat the wildcard, the first registration of a key
  wins within its tier, hex is stored lowercased, and print/replay/legacy
  surfaces are untouched. Colors never affect layout — spans are applied
  after the row plan, so visible widths are unchanged; a colors-only theme
  counts in the startup banner (`— 8 colors`), suggestions as their own
  count (`— 2 tools, 2 suggested colors`). Design + three adversarial
  review rounds + three amendments: `docs/tool-name-colors-design.md`.

### Changed

- **Node support and CI coverage.** The minimum Node version is now 22.19.0,
  matching the pinned TUI dependency. CI checks that exact minimum and Node 24;
  CI and release gates require `rg`/`fd` instead of silently skipping search tests.

- **Ink rename (planned `ink-agent@0.2.0`).** The product is now Ink, an
  open-source AI assistant and agent harness for the terminal. The sole
  executable is `ink`; there is no `imp` alias. Active configuration uses
  `~/.ink`, project `.ink`, and `INK_*`, without automatic migration or
  old-name fallback. `ImpSettings` becomes `InkSettings` for source consumers.
  Ordinary session history can be preserved by a separately approved cutover;
  historical child sessions remain inspectable but are not resumable. Saved
  `impVersion` fields, `.imp-machine-id` leases, historical release records,
  and actual `FishInSalt/imp` URLs are retained. Publication uses new
  `INK_NPM_PUBLISH_ENABLED` / `INK_NPM_PACKAGE` gates; dispatch is always
  dry-run. Historical publishing capability needs separately approved
  retirement, and the first Ink publication needs its own reviewed design.

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
  Design + five adversarial review rounds: `docs/confirm-prompt-design.md`.

- **Confirm prompt surface, Phase 2 (#confirm-prompt).** Extensions can now say
  it in two structured fields instead of prose: `preview` renders the request in
  the transcript's own call-header idiom (`● bash  rm -rf …`, the risky fragment
  alert-highlighted, never a completion suffix — the call has not run), and
  `rememberLabel` names what "don't ask again this session" will cover
  (`Yes, don't ask again this session (this command pattern)`). The host
  sanitizes both, so an extension can never inject terminal control sequences,
  and shows the command exactly once on every surface — in the picker where one
  exists, as one plain note line otherwise. Guardian passes both at its bash
  gate and a memory label at its write gate, dropping the `command: ` prefix
  from its detail. Malformed values render nothing; hosts without a picker
  ignore the styling and stay byte-stable.

- **Confirm prompt surface, Phase 3 (#confirm-prompt).** The approval moment now
  says who is asking and reads as one piece. The host names the caller —
  `▪ confirm: guardian — allow this bash command?` in the transcript, a faint
  `· guardian` after the picker title, and `blocked by extension guardian:` in
  the block result — so extensions stop naming themselves (guardian drops its
  `[guardian] ` prefixes) without any new API surface: the label is host-derived
  and cannot be spoofed. While a picker is open the activity region paints no
  tool rows: `tool_start` precedes the gate, so those rows used to claim
  `running Ns` although nothing was executing, and repeated the gated command a
  third time. Every picker now opens one blank row below the transcript, and the
  line you decide on (the extension's reason) renders at normal weight instead of
  faint — the `(↑/↓ move …)` affordance and the `▪` record lines stay faint.
  Design + three adversarial review rounds + a mutation-verified implementation
  check: `docs/confirm-prompt-design.md` §15.

- **Confirm prompt surface, Phase 4 (#confirm-prompt).** The picker title no
  longer repeats the caller's name (`allow this bash command?` — the transcript's
  `▪ confirm: guardian — …` record line already says who asks), and every picker
  box now opens with a horizontal rule carrying that name in the middle:
  `──────────────── guardian ────────────────`. The rule is host-drawn from the
  same host-held name, so an extension cannot write a different one; the dashes
  are faint and the label sits at normal weight. Unattributed pickers get plain
  dashes, and the login dialog keeps its own frame. Design + two adversarial
  review rounds + a mutation-verified implementation check:
  `docs/confirm-prompt-design.md` §16.

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

- **Tool live view under its own call line (#tool-inline-live-rows).** A
  running top-level tool call's live state (`└─ running 3s`) now renders in
  the transcript, directly under that call's own `● …` row, instead of in the
  bottom activity region — the command no longer appears twice while a call
  runs. The activity region keeps only turn-level rows (`⠋ working…`,
  `compacting context…`) and the existing picker suppression (no `running`
  claim while a gate is pending). A provider-synthesized tool_call id reused
  within one run can no longer paint a running row onto the previous call's
  settled entry. Display-only: the settled transcript, print mode, the legacy
  shell, history, sessions, extensions, and replay are unchanged. Known
  tradeoff (accepted, same as `task`): a long-running call's live row scrolls
  with its header. Superseded before release by #call-closing-status
  (below): the timer now closes the call's info row — `task` calls included —
  and reads as a bare `Ns`.

- **Call closing status: one slot for the running timer and the completion
  marker (#call-closing-status).** A running call's timer (a bare dim `Ns`)
  — including a `task` call's, whose `└─ pending` row no longer carries
  seconds — now renders at the end of the call info, closing the last row of
  wrapped commands, multi-line commands, and long `task` prompts, and turns
  into the completion marker (`✓`/`✗`, plus the time when ≥1s) in that same
  place
  when the call settles; the
  separate non-task live row is gone, so a multi-line command is no longer
  split by a status row and the marker no longer cuts words. Interrupted
  calls and rows below the 8-column slot floor render no status. Display-only:
  a call that settles on a single un-split row renders byte-identical to
  before; print mode, the legacy shell, history, sessions, extensions, and
  replay are unchanged.

### Removed

- **guardian v1 and the host classify seam.** The rule-based example gate
  (`examples/extensions/guardian.mjs`, configurable via `IMP_GUARDIAN_BLOCK`,
  audited to `~/.ink/guardian.log`), its tests (`test/guardian.test.ts`,
  `test/guardian-auto.test.ts`, `test/guardian-auto-host.test.ts`,
  `test/classify-seam.test.ts`, `test/user-input-log.test.ts`), and the
  `#guardian-auto-mode` host machinery (`api.classify` and its types, the
  classify host `src/repl/classify.ts`, the call-context and
  user-input/gate-decision logs, the `verifiedUserContext` event field,
  `LLMRequest.temperature`) are gone; the `ExtensionApi` is back to eleven
  members. guardian needs none of it (`on` + `confirm` + `setStatus` +
  `registerCommand`). The v1 design record stays at
  `docs/guardian-auto-mode-design.md` with a superseded banner.

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
