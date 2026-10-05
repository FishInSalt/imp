# Local Ink command switch and recovery

Status: independently reviewed instructions for separately authorized operations,
not permission to run them. Reviewer `1c8816f5-6e8c-4128-8c7e-50f7fec466e7`
APPROVE; document review only, no startup/link/main/push authority.
Installed application: `b1deda4da7c4dd524bacde8f0a6070d5d3f11591`.
See [installation/configuration result](ink-local-install.md).

## Fixed installation paths

- New application: `/Users/z/Z/Agent_demo/ink-runtime-0.2.0`.
- New selected configuration: `/Users/z/.ink`.
- Old application: `/Users/z/Z/Agent_demo/imp`; leave all source/dist/dependencies
  and example bytes unchanged. Old selected configuration: `/Users/z/.imp`.
- Current old command link: `/opt/homebrew/bin/imp -> ../lib/node_modules/imp/bin/imp.js`.
- Current old module link: `/opt/homebrew/lib/node_modules/imp -> ../../../../Users/z/Z/Agent_demo/imp`.
- Intended new module link: `/opt/homebrew/lib/node_modules/ink-agent -> /Users/z/Z/Agent_demo/ink-runtime-0.2.0`.
- Intended new command link: `/opt/homebrew/bin/ink -> ../lib/node_modules/ink-agent/bin/ink.js`.

Create each new symlink only after displaying its exact path/text and separate
owner approval. A symlink API with exclusive creation must fail on any existing
entry, including a dangling link. Do not use ln -f, npm link, npm uninstall, sudo,
recursive removal, or overwrite/retarget any existing link. Verify exact link text,
identity, resolved executable and isolated help/version before asking for startup.
No command registration itself starts an application.

## Registration result — 2026-10-05

The owner separately approved both creations. The module link and command link
were exclusively created and verified against the exact texts above; parent
identity/postchecks and directory synchronization passed. `command -v ink`
resolves `/opt/homebrew/bin/ink`, and its real executable is the independent
runtime's `bin/ink.js`. No application was started by registration. Old imp command
and module links remain unchanged for current-session operation and recovery.
Subsequent registered-command isolated help/version passed with fake HOME and
zero recorded network attempts, evidence `/tmp/ink-registered-check.7wXuxu`.
Subsequent PTY interactive acceptance also passed; see the separate
[interaction record](ink-interaction-acceptance.md). Real-provider authentication,
normal user extension execution and real HOME startup remain unverified.

## Order

1. Complete selected private-copy byte/mode/link checks. Current copies are not a
   promise of continued freshness while imp can still change auth/settings/catalog.
2. Individually approve and exclusively create the new module link, then approve
   and exclusively create the new command link. Leave both old links intact during
   isolated acceptance. This temporary coexistence is not an imp alias to Ink.
3. Run the new command only with fresh temporary HOME/auth/settings/catalog,
   sanitized environment, reviewed network blocker and neutral cwd. Require exact
   Ink 0.2.0 and Usage: ink. Do not import user extensions or connect MCP/providers.
4. Before exiting the current imp, open an ordinary terminal and retain these fixed
   paths/instructions. Do not run normal Ink concurrently. Owner normally exits
   current imp with /exit and waits for its tracked children to settle. Confirm no
   old harness/MCP writer remains; if uncertain, do not signal unrelated processes
   or proceed by age alone. Read-only fresh process inspection is separately scoped.
5. Compare the seven copied resources and old originals again without printing
   credentials/private bytes. If changed, do not overwrite the copies blindly:
   obtain exact refresh approval. Guardian/extensions/root modes must remain valid.
   Unknown shared configuration/overrides or source project requirements are
   identified and resolved before real startup, not silently treated as migrated.
6. Individually approve retirement of the verified old command symlink only. Check
   exact type/text/identity immediately before removal and absence after removal.
   Keep the old module link and all old files for recovery. No old module/package
   uninstall is required for this cutover. Clear the terminal's command-location
   cache with `hash -r` (bash) or `rehash` (zsh) if needed.
7. Owner separately approves normal Ink startup. This can refresh catalog/OAuth,
   connect configured MCP servers, load extensions/notifications and create new
   history/logs. Do not assume fake help/version proved all those side effects.
   Start a new session, not resume old imp history. Validate chosen model, settings,
   guardian rules and five installed extensions without exposing credentials.
8. After owner accepts Ink, integrate the pinned rename commit into main using
   --no-ff in a different worktree. Separately approve push, tags/publication.
   This never automatically replaces the independent installed runtime.

## Recovery before normal Ink startup

Stop on failure, preserve both configuration roots and runtime directories. New
command/module registrations may exist after a partial step; inspect actual names
instead of assuming a failed operation did nothing. Foreign/changed entries block
removal or replacement.

If only new registrations were added and the old command remains, leave the old
installation available and do not start Ink. Each verified new-link retirement
requires its own approval; remove command exposure before retiring a module link.
Keep all new files. If old command retirement succeeded, restoration is one
separately approved exclusive symlink creation:

```
/opt/homebrew/bin/imp -> ../lib/node_modules/imp/bin/imp.js
```

Before restoration verify that the retained old module link still resolves to the
unchanged old application and that no imp entry exists. No reset/rebuild/history
repair/data-copy-back is needed. Verify with isolated quick-exit before allowing
normal old startup. Never overwrite an existing or foreign entry.

## Recovery after normal Ink startup

Do not automatically start old imp or copy old auth/config over new data. Exit Ink,
confirm relevant processes stopped, retain new history/config and assess OAuth
rotation and shared external changes. A separately approved data/credential
reconciliation may be necessary. Restoring a command link cannot undo these
external effects. No automatic merge, deletion or guarantee of reversible login.

## Remaining resource decisions

The copied safety instructions retain old-name examples without weakening their
workspace/external-write approval rules. Any wording adaptation is a separate
new-file edit, not a hidden global replacement. Project-specific .imp settings are
not automatically loaded by Ink; approved additive .ink settings are needed only
for the explicitly selected working directories, not every repository on the host.
Shared MCP filenames/locations stay unchanged; do not discover/execute arbitrary
external dependencies or copy them into .ink without a scoped owner decision.
