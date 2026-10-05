# Installed Ink interactive acceptance — 2026-10-05

Status: PASS for installed-application interaction with an isolated local provider.
Application commit: `b1deda4da7c4dd524bacde8f0a6070d5d3f11591`.
Independent focused reviewer: `551a6243-2075-4048-8386-b7b55864ecb3`, APPROVE.
This does not approve real credentials/network, normal user extensions, command
retirement, main integration or push.

## Observed acceptance

Launched the actual registered `/opt/homebrew/bin/ink`, not a source/dev build,
inside a Python-created PTY (42 rows, 120 columns) with `INK_REPL=tui`. Fake HOME,
auth/settings/catalog and working directory; `--no-extensions --no-skills
--no-trust --thinking off -m openai/gpt-5.2`, `INK_MCP=0`. The installed root has
no .env. Session persistence enabled only in scratch. Allowlisted environment and
reviewed `test/helpers/network-blocker.cjs` prevent nonlocal Node requests.

A local HTTP server uses an invented API key and deterministic OpenAI-compatible
SSE responses. It issues one real read-tool call on a synthetic scratch file and
verifies its result on the follow-up model request. No real provider credentials,
user configuration/history, system commands, MCP or notifications are used.

**7 checks passed:**

1. Real PTY startup displays Ink 0.2.0/welcome and enters raw/bracketed-paste mode.
2. UTF-8 Chinese input submits; local streamed response displays the expected text.
3. Actual read tool runs on note.txt; the resulting synthetic value appears in the
   terminal and is returned as the correctly identified tool message to the server.
4. `/status` shows the live model/session/context information without a model call.
5. Esc during a long local response produces an interrupt note and `(aborted)`;
   another input receives a new response. Reviewer checked the explicit abort
   output, not merely the test server's later cleanup event.
6. `/exit` completes with exit code **0**, restores canonical/echo terminal flags
   and disables bracketed paste.
7. Exactly one new synthetic session is saved in scratch, containing earlier and
   post-interruption answers; no old session is resumed or copied.

**5 local provider POSTs**, **7 local catalog GETs** (404 synthetic fallback),
**0 server assertion errors**, **0 recorded nonlocal attempts**. Old imp command
link remains unchanged. No repository/application code, real HOME/global links or
active old runtime files were edited for this acceptance.

Evidence retained: `/tmp/ink-interaction-accept.G1f6pi/{result.json,terminal.raw,
terminal.txt,requests.json}`; harness `/tmp/ink-interaction-accept.JzkvtK/accept.py`.
These are synthetic-only scratch artifacts, not an installed general test tool.

## Failed preliminary harness attempts

No application defect was established by the two earlier failures:

- `/tmp/ink-interaction-accept.JzkvtK`: startup predicate incorrectly expected
  the fresh-session welcome while --no-session selects the compact banner. Zero
  provider POSTs. Corrected harness to create a synthetic session.
- `/tmp/ink-interaction-accept.633lib`: four earlier interaction checks passed;
  timeout awaited an incomplete synthetic answer paragraph. The REPL renderer
  buffers unfinished markdown paragraphs; the harness added a paragraph boundary
  before testing interruption. Four provider POSTs. Test-owned children were
  terminated on these failures; current imp was never signaled.

The final fresh run above, not those partial attempts, supports the PASS result.

## Remaining limitation

This synthetic run establishes installed CLI/TUI and agent interaction, not real
account authentication or normal copied extension configuration. A later separately
approved [real-provider run](ink-real-interaction-acceptance.md) establishes one
DeepSeek interaction with migrated auth/settings. Do not describe the synthetic
run, or either scoped run, as unrestricted-default-environment acceptance.
