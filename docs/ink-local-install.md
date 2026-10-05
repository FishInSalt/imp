# Local independent Ink installation

Status: INSTALLED AND ISOLATED ACCEPTANCE PASSED; configuration and global command
switching not performed. Independent reviewer
`64e1e447-c51b-4cab-822b-92d9f2ecb99e` approved this bounded procedure; private
configuration, normal startup and command switching remain separately gated.
Application: `b1deda4da7c4dd524bacde8f0a6070d5d3f11591`.

The owner requested direct progress on installation, not completion of a general
installer. Use standard npm and the existing reviewed package parser. Do not run
the unfinished ink-runtime scripts. This short operation replaces their proposed
nested output layout for the local install; it does not change application code.

## Workspace operation

1. Verify a clean pinned application checkout and its already-tested local tarball.
   Parse the whole gzip/tar with the reviewed `parseTar`; require 340 exact members,
   compare their bytes/modes with that checkout's package/bin/README/LICENSE/dist,
   verify the package is ESM ink-agent@0.2.0 with sole ink bin.
2. Exclusively create `/Users/z/Z/Agent_demo/ink-runtime-0.2.0` (existing entry blocks).
   Copy those approved tar bytes to this directory, preserving public package
   modes, plus the pinned package-lock.json. New app root contains bin/dist/package
   and its own node_modules; it is not a source/worktree/dependency symlink.
3. Use a fresh private scratch HOME/cache/neutral cwd/npmrc. Seed cache by copying
   only the already-sanitized scratch cache from the previous successful artifact
   smoke, not the user's actual cache/config. Run the existing installed Node/npm
   with an allowlisted environment and reviewed network blocker, npm ci --offline
   --ignore-scripts --omit=dev --no-audit --no-fund. Target only the new runtime;
   never install into active/shared dependencies. No network fallback/scripts.
4. Verify six exact production dependencies against frozen lock placements and
   versions; approved YAML/marked bins allowed. Check npm result, no outward links,
   no dotenv, Photon WASM and Darwin arm64 TUI addon resources. Copy 13 exact
   committed public example/support files to assets/examples/extensions. Do not
   execute these extensions or substitute their template/example configuration.
5. Run help/version in a neutral cwd with fake auth/settings/catalog paths and
   network blocker. Require Ink 0.2.0 and Usage: ink. Recompare application bytes,
   public assets, lockfile, old checkout HEAD/status and global link metadata.
   This establishes local installation only, not real-user startup readiness.

Failure retains the new directory and scratch; no overwrite, delete, retry in a
partial destination or automatic rollback. All filesystem writes are inside the
workspace or scratch directories. npm diagnostics are private scratch logs.

## Installation result — 2026-10-05

- Runtime: `/Users/z/Z/Agent_demo/ink-runtime-0.2.0`, owned private root, independent
  application files and dependencies; no link to active/shared dependency tree.
- Reviewed local package: **340 application files**, byte/mode comparisons passed.
- `npm ci --offline --ignore-scripts --omit=dev --no-audit --no-fund`: **6 packages
  installed**; exact six hidden-lock records match the frozen application lock.
- **13 public extension/support files** copied and compared; none executed.
- Help/version with fake HOME/auth/settings/catalog and neutral cwd: passed,
  exact **Ink 0.2.0**. Direct pinned TUI module import and one synthetic Photon
  pixel (1x1) passed. This is not interactive TUI or user configuration acceptance.
- Closed installed links: **2**, YAML/marked, both internal. No installation dotenv,
  no imp alias, **0 recorded network attempts**.
- Old public source/runtime dist/bin/examples/package/lock byte/mode/link graphs,
  old HEAD/clean status and both global imp link identities/text remained unchanged.
  Real HOME credentials/config/history were not read or copied.
- Private scratch evidence retained at `/tmp/ink-local-install.l63ySo`:
  `baseline.json`, `npm-ci.log`, `acceptance.json`; no cleanup performed.

The failed/unfinished custom runtime builder is not involved in this installation.
The installed runtime stays unregistered and must not be started with real HOME
until selected private configuration and startup effects receive separate approval.

## Separate approvals / remaining steps

No credential/session/configuration content is read, copied or modified here.
No HOME/global registration, old source/dist/examples/node_modules, main or remote
change is authorized. Runtime tests use fake configuration and do not start REPL,
providers, MCP, notifications or extension factories.

After isolated installation succeeds, request a specific private resource scope
for config inventory/copy. Keep old state/history intact, migrate necessary
credentials/model/extension/guardian configuration only. Additive project .ink
resources require specific approval. Final session exit and command-link switch
need complete bounded terminal instructions and recovery steps. Normal Ink startup
requires side-effect approval; OAuth/shared data effects can prevent automatic
old-runtime restart. Acceptance precedes main --no-ff integration and separately
approved push. Local install does not prove the unfinished general tools correct.
