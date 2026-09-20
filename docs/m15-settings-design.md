# M15 — Settings Panel (pi settings-manager parity, imp scope)

## 1. Problem

imp's settings are a single-file, single-scope, untyped-ish 81-line module
(`src/core/settings.ts`) with 8 consumer sites each re-reading the file;
several de-facto settings live only in env vars (IMP_MODEL,
IMP_AUTOCOMPACT). pi's answer is a three-layer system: a typed
two-scope SettingsManager (~/.pi global + .pi project, deep-merged,
locked storage) and an interactive /settings selector. This batch ports
the architecture and a lean UI, keyed to settings imp actually has
consumers for.

User decisions (2026-09-20): project scope SHIPS in this batch;
env-var consolidation limited to defaultModel + autoCompact;
**images.blockImages stays deferred (D7)** — updated note: the settings
layer and the egress-gate seam (downgrade layer) now both exist, so a
future port is a one-branch change; deferred as pure capability
reduction with no current consumer.

## 2. pi reference (what we port vs record)

Ported:
- Two scopes: global `~/.imp/settings.json` + project `<cwd>/.imp/settings.json`
- Deep merge (project wins; nested objects merge recursively, not replaced)
- Project scope gated by the M8 trust gate (pi: `projectTrusted` in
  SettingsManagerCreateOptions; imp: the resolveProjectTrust result cli
  already computes)
- A /settings command (pi's selector is 945 lines with submenus; imp's is
  a lean version on the /model TuiShell.select pipeline)
- Unknown keys survive reads and writes (forward compat, pi parity)

Recorded divergences:
- **D16 — no file locking**: pi locks both scope files
  (FileSettingsStorage.withLock); imp writes atomically (tmp+rename,
  catalog.ts precedent) — single-user CLI, last-writer-wins accepted
  (same stance as D14 for the catalog cache).
- **D17 — lean selector**: no theme/model-thinking submenus (no theme
  system, no per-model thinking UI); string keys edit via text prompt,
  not pickers.
- **D18 — writes default to the global scope**: pi can target either
  scope per-setting; imp's /settings asks per write, programmatic
  persistence (thinking default, hideThinkingBlock) stays global
  (existing behavior).

## 3. Design

### 3.1 Settings keys (v1)

| Key | Type | Default | Consumer |
|---|---|---|---|
| defaultModel | string | env IMP_MODEL ?? "claude-sonnet-4-5" | cli startup model |
| defaultThinkingLevel | ThinkingLevel | "medium" | runner thinking chain (existing) |
| hideThinkingBlock | boolean | false | ctrl+t visibility (existing) |
| autoCompact | boolean | true | runner + subagent compaction gate (new: env IMP_AUTOCOMPACT=0 wins) |
| skills | string[] | [] | skills loader (existing) |
| enableSkillCommands | boolean | true | /skill:name registration (existing) |
| images.autoResize | boolean | true | read tool pipeline (existing) |

Precedence: **env var > project settings > global settings > code
default** (env stays the immediate session override — the imp invariant
from every prior batch).

### 3.2 Module shape (`src/core/settings.ts` rewrite)

- `ImpSettings` extended with defaultModel + autoCompact.
- `loadSettings(path?)` — UNCHANGED signature/behavior (global file,
  path override = test seam). Unknown keys preserved.
- `loadProjectSettings(cwd, allowed)` — project file read; `allowed`
  false ⇒ {} without touching the file (trust gate).
- `effectiveSettings({ cwd, projectAllowed, globalPath? })` — deep-merge
  global ← project; returns the merged view. Pure function, injectable
  paths.
- `saveSettings(patch, path?)` — existing global-patch write, now atomic
  (tmp+rename) + mkdir.
- `saveProjectSettings(patch, cwd)` — same, project scope.
- Validation stays forgiving (skills precedent): wrong-typed known keys
  are dropped at parse; unknown keys pass through untouched.

### 3.3 Trust gate

- `trustRequiringResources` gains `.imp/settings.json` presence (a
  cloned repo must not grow settings that redirect the model) — same
  list membership as .imp/agents, .imp/skills.
- Untrusted project ⇒ project settings invisible (reads) and unwritable
  (/settings teaches instead of writing).

### 3.4 /settings command

- **TUI no-arg**: selector over rows grouped by section (model /
  thinking / images / skills / compaction). Row = `key — value
  (source: env|project|global|default)`. Enter on a boolean or enum
  (thinking level) cycles the value; on defaultModel opens a text
  prompt (shell.ask); then a scope picker (global / project) writes it.
  Untrusted project hides the project option. One dim status line per
  write (pi's single-line status form).
- **Legacy/print no-arg**: prints the table (key, value, source) +
  the file paths.
- **`/settings <key>`**: shows value + source + accepted values.
- **`/settings <key> <value>`**: validates (unknown key teaches with
  the key list; bad value teaches the accepted form), writes the
  GLOBAL scope (D18), echoes `key: old → new`.

### 3.5 Consumer rewiring

- cli: `defaultModel()` = IMP_MODEL ?? effective.defaultModel ?? builtin;
  hideThinking from effective; passes `projectAllowed` into Runner.
- runner: `autoCompact` = env override ?? effective.autoCompact ?? true;
  thinking-default and images.autoResize reads switch to effective
  (same call sites, merged view).
- subagent.ts: same autoCompact source.
- Persistence (thinking level default, hideThinkingBlock on ctrl+t):
  unchanged — global writes.

## 4. Test plan

1. Deep merge: project images.autoResize overrides, images.* siblings
   survive; project skills[] replaces (arrays replace, not concat — pi
   semantics).
2. Precedence chain incl. env override for defaultModel + autoCompact.
3. Trust gate: untrusted project file ignored (read), /settings project
   write refuses with teaching line; `.imp/settings.json` presence
   triggers trustRequiringResources.
4. Unknown-key preservation across read/write round-trip.
5. /settings: no-arg table bytes (legacy), key show, key value write +
   old→new echo, unknown key teaching, invalid value teaching; TUI
   cycle + scope picker (machine-level via injected select).
6. Atomic write + mkdir on first save.
7. Consumers: defaultModel from project settings when env absent;
   autoCompact=false from settings stops auto-compaction (existing
   loop test seam).

## 5. Verification notes

- The test suite caught a real saveScope bug (patch-into-patch nested
  merge dropped raw siblings) before commit.
- Dist smoke caught an inverted precedence in defaultModel() (global was
  consulted before project — the design table's env > project > global
  was violated); fixed and re-verified end to end: a trusted project
  file's defaultModel (glm-4.7) wins over the global file's, and the
  user's .env IMP_MODEL beats both (by design — the env var is the
  session override).
- /settings writes go through the RUNNER's settings context
  (runnerCwd + globalSettingsPath()), never process.cwd()/the bare
  global default — the runner test seam path must be what the command
  writes to.
