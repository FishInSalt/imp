# Installed Ink real-provider interactive acceptance — 2026-10-05

Status: PASS for the separately approved single-message real-model interaction.
Installed application: `b1deda4da7c4dd524bacde8f0a6070d5d3f11591`.
Independent focused reviewer: `c4d81af1-df79-4536-a41d-1c708fb02108`, APPROVE.
This verdict is not permission for unrestricted startup, command retirement, main
integration, push or release. Earlier local interaction coverage is recorded in
[synthetic PTY acceptance](ink-interaction-acceptance.md).

## Authorization and boundary

The owner explicitly approved one brief test using migrated credentials against
the configured real model, including potential quota/OAuth effects. Read-only
classification found the default **deepseek/deepseek-flash**, using a stored API
key; no OAuth refresh was needed or attempted. Current old imp was not exited or
signaled. No simultaneous OAuth writer was introduced by this API-key test.

Actual registered `/opt/homebrew/bin/ink` ran in a real PTY (42x120), not a dev
build. It read `/Users/z/.ink/auth.json` and `settings.json` to resolve the migrated
credential/default model. HOME, cwd, catalog and potential writable runtime state
were isolated in a new private scratch directory. No real .env, context files,
sessions, user extensions, skills, MCP or notifications were used. Flags included
`--no-context-files --no-session --no-extensions --no-skills --no-trust
--thinking off --max-tokens 96 --max-turns 1`; no model or API-key environment
override, so selection/authentication exercised the migrated resources.

A scratch copy of the reviewed loopback network blocker additionally permitted
only api.deepseek.com. A fetch guard required exactly one POST to the official
`https://api.deepseek.com/chat/completions`, the selected wire model, output cap
and disabled thinking; redirects and any second provider attempt were blocked.
Catalog lookups used a local 404 fixture, not external catalog refresh. The turn
limit prevents tool execution if an unexpected tool call is returned. The prompt
requested only a concatenated marker and 7+5, with no tool calls.

## Observed result

**5 checks passed:**

1. Actual migrated default model/API-key resolution reaches the interactive TUI.
2. **1 real provider request**, HTTP **200**, `text/event-stream`, displays
   **INK_REAL_OK 12**. The marker was split into three fragments in the prompt,
   so the full answer cannot be mistaken for echoed input.
3. `/status` works after the real reply; model is deepseek-flash, no session.
4. `/exit` prints bye, exits **0**, restores canonical/echo terminal flags.
5. All seven selected real configuration signatures remain unchanged; auth and
   settings bytes also remain identical. No credential value/digest/header is
   printed or recorded in this repository. Test output is redacted in scratch.

No blocked network attempt or unexpected request recorded. No retries, model
fallback, OAuth, MCP, normal extension factory, tool execution or real-state write.
Old imp command retained. No exact monetary charge is asserted; the authorized
request can consume the account's model quota.

Evidence retained in `/tmp/ink-real-interaction.pMOdm5`: `result.json`,
`terminal.redacted.txt`, `provider-events.jsonl`; harness/guards remain scratch-only.
Provider evidence contains endpoint/model/status, never authorization headers or
request body. No automatic rerun or cleanup performed.

## Scope not covered

This establishes actual installed Ink interaction with the owner's selected model
and migrated API key. It does not establish every provider/OAuth account, normal
user extension/guardian integration, configured MCP connections, original thinking
level, project-specific .ink resource preservation or unrestricted real HOME
startup. Those are distinct checks, not grounds to deny this observed core result.
The prior synthetic acceptance covers read-tool roundtrip, Esc abort/recovery and
new-session persistence without further paid requests. Remaining global retirement
and Git integration follow the separately approved switching plan.
