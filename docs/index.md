# Ink

Read this first: it maps every question to the page that answers it.

Ink is an open-source AI assistant and agent harness for the terminal.
The repository is [FishInSalt/ink](https://github.com/FishInSalt/ink);
the npm package is `ink-agent`. See [cli.md](cli.md) for installation and
the full option reference.

## What are you trying to do?

- Get started, sign in, pick a model → [providers.md](providers.md)
- Run Ink, print mode, piping, attach files, every flag → [cli.md](cli.md)
- Understand sessions, resuming, forking, the tree, compaction →
  [sessions.md](sessions.md)
- Configure defaults (startup model, queue modes, images, MCP) →
  [settings.md](settings.md)
- Write an extension (tools, commands, events, gates) →
  [extensions.md](extensions.md)
- Use skills (SKILL.md packages) → [skills.md](skills.md)
- Connect MCP servers (stdio or HTTP) → [mcp.md](mcp.md)
- Delegate work to subagents and worktree isolation →
  [subagents.md](subagents.md)
- Work with images (vision models, paste, resize) → [images.md](images.md)

## Concepts in one paragraph each

- **Session** — an append-only JSONL message tree under `~/.ink/sessions/`,
  organized by working directory. Every turn is preserved; `/tree` navigates
  the whole tree; `/fork` branches it. See [sessions.md](sessions.md).
- **Skill** — a self-contained instruction package (SKILL.md) the model loads
  on demand. Only a one-line catalog entry sits in the system prompt. See
  [skills.md](skills.md).
- **Extension** — a plain ESM module registering tools, slash commands,
  system-prompt sections, event handlers, or tool-name colors. See
  [extensions.md](extensions.md).
- **Subagent** — a fresh agent run inside the `task` tool with its own context
  window; optionally isolated on a git worktree. See
  [subagents.md](subagents.md).
- **MCP** — external tool servers over stdio or Streamable HTTP; tools
  register flat as `<server>_<tool>`. See [mcp.md](mcp.md).
- **Model catalog** — model metadata (context windows, costs, thinking
  ladders, vision) fetched from the public `pi.dev` catalog service with an
  offline-safe disk cache. See [providers.md](providers.md).

## Project trust

Executable or model-influencing project resources — `.ink/extensions/`,
`.ink/agents/`, `.ink/commands/`, `.ink/settings.json`, project skills,
`.ink/SYSTEM.md`, and the project MCP files — load only after you trust the
directory (`ink --trust`, or the ask-once prompt). A cloned repository must
not grow code that talks to the model. `/trust` shows the recorded decision.

## Platform support

macOS (development platform) and Linux (full CI gate). Windows is not
supported yet — use WSL. Optional external tools: `rg` / `fd` back the
`grep` / `find` tools; clipboard image paste uses `osascript` (macOS) or
`wl-paste` / `xclip` (Linux).
