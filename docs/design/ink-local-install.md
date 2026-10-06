# Ink local installation and acceptance

Status: **OWNER ACCEPTED**, 2026-10-05. Installed application commit:
`b1deda4da7c4dd524bacde8f0a6070d5d3f11591`, **ink-agent@0.2.0**.
This is one local installation record, not a general migration tool or permission
to modify another installation. The earlier full-state migration/source-linked
activation proposal was abandoned; its historical documents remain in Git.

> **Update 2026-10-06 (owner-directed):** see the update section at the end of
> this file — the independent runtime was retired, the global `ink-agent`
> module now points at the source checkout, and the old `imp` entries were
> removed. The layout and recovery statements in this file describe the
> 2026-10-05 snapshot and are superseded where they conflict.

## Installed layout

- Independent runtime: `<workspace>/ink-runtime-0.2.0`, containing package/lock,
  bin/dist, its own production node_modules and public extension assets.
- Selected private configuration: `~/.ink`; old `~/.imp` remains unchanged.
- Global module: `/opt/homebrew/lib/node_modules/ink-agent` points to the independent
  runtime; command `/opt/homebrew/bin/ink` points to
  `../lib/node_modules/ink-agent/bin/ink.js`. Both were separately approved,
  exclusively created and verified. Existing entries were never overwritten.
- Old `/opt/homebrew/bin/imp` and its module registration remain for recovery.
  No imp alias redirects to Ink. The old source/runtime/dependencies were not
  changed, rebuilt or moved. Git main integration does not replace installed files.

Installation used the reviewed local tarball, a matching lockfile and standard
`npm ci --offline --ignore-scripts --omit=dev --no-audit --no-fund` in a fresh root
with isolated npm configuration/cache. The unfinished custom installer was not used.
**340 application files**, **6 locked production packages**, **13 public extension
assets** and **2 internal dependency bin links** were checked. Isolated help/version,
TUI import and synthetic Photon image processing passed with no network attempts.

## Selected configuration

Copied byte-for-byte with separate approval: `auth.json`, `settings.json`,
`guardian.json`, `trust.json`, `models-catalog.json`, `AGENTS.md` and
`web-search/config.json`. New root/extensions/web-search directories are **0700**;
both credential files are **0600**. File owner/group/modes and copied bytes were
verified; preservation of old timestamps/macOS provenance was not promised.
No private values, credential digests or headers are stored in this repository.

Guardian, notify, task-timer, tool-colors and web-search links point to independent
Ink assets, not the old source. Model settings needed no old-path adaptation.
Guardian's **10 deny/2 ask** entries needed no regex modification; original rule
bytes and safety instructions were retained. Credential bytes were opaque during
copying; the later separately approved API-key test used the migrated auth file.

No old sessions, child sessions, logs or history were copied or deleted. Ink starts
new sessions; old child history is not supported for cross-version resumption.
Project .imp settings are not automatically loaded. Any needed project .ink
configuration or instruction wording adjustment is a separate approved change;
never silently omit safety resources. Standard AGENTS/skills/MCP filenames stay
unchanged. Unknown extension dependencies/data need explicit classification, not
an assumption that they are disposable history.

## Acceptance

- Registered-command help/version with fake HOME: exact **Ink 0.2.0**, no recorded
  network attempts.
- Real terminal (PTY) with a local synthetic provider: **7 checks passed** — TUI
  startup, Chinese input/reply, actual read-tool result roundtrip, /status, Esc
  interruption and next turn, exit code **0** with terminal restoration, and new
  synthetic session persistence. **5 local provider requests**, no nonlocal attempts.
- Separately authorized real-model PTY test: migrated default
  **deepseek/deepseek-flash** and API key, **1 request**, HTTP **200**, expected
  reply **INK_REAL_OK 12**, /status, exit **0**, terminal restored and selected
  configuration unchanged. Thinking off, 96-output-token cap, one turn; no OAuth,
  tools, user extensions, context files, MCP, notifications or real-state writes.
- Focused independent reviews approved the installation, switching instructions
  and both interaction results. The owner then reported independent acceptance
  without apparent problems. That report is not additional automated coverage of
  all providers, normal extensions/MCP or unrestricted startup.

No further paid request is needed for this acceptance. Node 25.5.0/Darwin arm64 was
observed; this is not proof of Node 20/24 or Linux support. The reviewed application
was integrated locally using --no-ff. The unfinished installer and experimental
preparation/activation branches were excluded. Early full-state runbook/test helpers
had entered main with the rename; this cleanup removes them and the redundant
history-copy test. Push, repository rename, tags, npm publication and account changes are
separately authorized operations.

## Remaining switching and recovery boundaries

Use an ordinary terminal for final session switching. Exit old imp normally with
`/exit`, wait for tracked children and verify no relevant writer remains before
normal Ink startup or any OAuth refresh. Do not signal uncertain processes. While
old imp remains running, copied auth/settings/catalog may change; compare without
printing secrets, and request exact refresh approval if necessary. Do not start
both real environments concurrently against rotating OAuth or shared data.

Old-command retirement requires a separate approval for the verified
`/opt/homebrew/bin/imp` symlink only. Keep old module/runtime/configuration for
recovery; no npm uninstall or forced overwrite is needed. After any separately
approved command change, clear the terminal command cache if needed.

On a failure, preserve both configuration/runtime roots. Before normal Ink startup,
the retained old command still works; if retired, separately approve its exclusive
restoration with text `../lib/node_modules/imp/bin/imp.js` only after checking the
retained module target and destination absence. Existing/foreign entries block
replacement; partial registration failure is not evidence that nothing changed.

After Ink has run, stop it before considering old startup. Preserve new data and
assess OAuth rotation/shared external effects. Do not copy old credentials over new
ones or automatically merge/delete history. Restoring a link cannot undo those
external changes. HOME cleanup, global-link removal and snapshot deletion require
specific approval; none is part of repository cleanup.

## Update — 2026-10-06 (owner-directed)

The local arrangement changed after the 2026-10-05 snapshot; the changes are
owner-directed (confirmed 2026-10-06):

- The independent runtime `<workspace>/ink-runtime-0.2.0` was retired.
- The global module `/opt/homebrew/lib/node_modules/ink-agent` now points at
  the source checkout `/Users/z/Z/Agent_demo/ink` (the directory renamed from
  `.../imp`); `/opt/homebrew/bin/ink` resolves through it as before, so the
  command is source-linked. `dist` must be rebuilt (`npm run build`) after
  source changes for the command to reflect them.
- Old `/opt/homebrew/bin/imp` and its module registration were removed; the
  recovery path described under "Remaining switching and recovery boundaries"
  no longer exists.
- `~/.ink` (selected configuration) and the untouched `~/.imp` state remain as
  recorded.

The "Installed layout" statements above ("points to the independent runtime",
"remain for recovery", "not changed, rebuilt or moved") describe the
2026-10-05 snapshot only.
