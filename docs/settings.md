# Settings

Read this when you configure defaults: the settings file, its keys, and what
each one does. Per-flag CLI overrides live in [cli.md](cli.md).

## Files

| File | Scope |
|---|---|
| `~/.ink/settings.json` | Global (all projects) |
| `<project>/.ink/settings.json` | Project — behind the [trust gate](index.md#project-trust); wins over global |

Settings loading is deliberately forgiving: unknown keys are dropped from the
active view (they survive in the file), and a malformed file never blocks
startup. `INK_SETTINGS_PATH` overrides the global path (tests).

In the REPL, `/settings <key> <value>` reads or writes; `/settings` opens the
panel. The env layer always wins: `INK_MODEL` beats `defaultModel`, and the
gating variables (`INK_AUTOCOMPACT=0` etc.) beat their settings keys.

## Keys

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultModel` | string | — | Startup model when `-m`/`INK_MODEL` is absent |
| `defaultThinkingLevel` | string | `medium` | Startup thinking level (model must support a knob) |
| `hideThinkingBlock` | boolean | `false` | Hide reasoning traces behind a `Thinking...` label (Ctrl+T toggles) |
| `autoCompact` | boolean | `true` | Auto-compaction gate (`INK_AUTOCOMPACT=0` wins) |
| `skills` | string[] | — | Extra skill files/directories (a bare string coerces to a one-element array) |
| `enableSkillCommands` | boolean | `true` | Register `/skill:name` commands (the catalog stays) |
| `steeringMode` | `all` \| `one-at-a-time` | `all` | How queued steer lines drain (deliberate divergence from pi's `one-at-a-time`) |
| `followUpMode` | `all` \| `one-at-a-time` | `one-at-a-time` | How queued follow-up lines drain |
| `images.autoResize` | boolean | `true` | Resize oversized images through the photon ladder; `false` ships original bytes |
| `mcp.enabled` | boolean | `true` | MCP master gate (`INK_MCP=0` wins) |
| `treeFilterMode` | `default` \| `no-tools` \| `user-only` \| `labeled-only` \| `all` | `default` | Default filter when the tree selector opens |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the "summarize the left branch?" ask on `/tree` jumps |

## Related files in ~/.ink

| Path | Purpose |
|---|---|
| `~/.ink/auth.json` | Credentials from `/login` (0600); stored keys beat env vars |
| `~/.ink/models-catalog.json` | Model catalog disk cache (4h refresh window) |
| `~/.ink/commands/` | Markdown quick commands (`/<filename>`) |
| `~/.ink/extensions/` | Global extensions |
| `~/.ink/agents/` | Global named agents |
| `~/.ink/skills/` | Global skills |
| `~/.ink/SYSTEM.md` | Custom system prompt (global tier) |
| `~/.ink/APPEND_SYSTEM.md` | Appended prompt section (global tier) |
| `~/.ink/trust.json` | Recorded project-trust decisions |

## Custom system prompt

- `.ink/SYSTEM.md` (project, requires trust) or `~/.ink/SYSTEM.md` — the
  file's content replaces the default prompt body (identity, core rules,
  tool catalog). The working-directory line, project context files
  (AGENTS.md/CLAUDE.md), skills, the agent roster, and extension context
  sections still load — those are routing facts, not persona.
- `.ink/APPEND_SYSTEM.md` / `~/.ink/APPEND_SYSTEM.md` — appended after the
  prompt body in both modes (e.g. "Answer in Chinese").

The project tier wins over the global one per file. An empty file disables
the custom prompt for that pair (the default prompt stays).

## Markdown quick commands

Drop a `.md` file into `~/.ink/commands/` (global) or
`<project>/.ink/commands/` (project — behind the trust gate) and its
filename becomes a slash command:

```markdown
---
description: review the current diff against the plan
allowedDuringRun: false
---
Review the working tree diff against PROJECT_PLAN.md. Focus on contract
drift. $ARGUMENTS
```

`$ARGUMENTS` is replaced by everything after the command name (without the
placeholder, arguments append as a trailing paragraph). Project files
override global ones with the same name; built-in and extension command
names are rejected with a diagnostic. `/help` lists them tagged
`md:global` / `md:project`. Scripted (piped) REPLs load them when the
directory is trusted; print mode (`-p`) never does.
