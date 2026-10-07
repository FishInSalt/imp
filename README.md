<p align="center">
  <a href="https://www.npmjs.com/package/ink-agent"><img alt="npm" src="https://img.shields.io/npm/v/ink-agent?style=flat-square" /></a>
  <a href="https://github.com/FishInSalt/ink/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://github.com/FishInSalt/ink/releases"><img alt="releases" src="https://img.shields.io/github/v/release/FishInSalt/ink?style=flat-square" /></a>
</p>

# Ink

**English** | [简体中文](README.zh-CN.md)

An open-source AI assistant and agent harness for the terminal. Use Ink for
research, writing, analysis, software development, and other tool-assisted
tasks. Built from scratch, inspired by [pi](https://github.com/earendil-works/pi).

Adapt Ink to your workflows, not the other way around: extend it with
[extensions](docs/extensions.md), [skills](docs/skills.md), [named
subagents](docs/subagents.md), and [MCP servers](docs/mcp.md) — the bundled
[examples](examples/README.md) (extensions, a subagent, a skill) show how.

## Getting started

Install and run in the directory where you want it to work:

```bash
npm install -g ink-agent@latest
cd /path/to/project
ink
```

Verify a non-interactive install with `ink --version` (prints `Ink <version>`)
or `ink --help`; for scripted one-shot use `ink -p "question"` prints the
answer and exits. The registry package runs no install lifecycle scripts.
Uninstall with `npm uninstall -g ink-agent`.

Or let npm infer the single `ink` executable from the explicit package:

```bash
npm exec -- ink-agent@latest --help
```

Sign in with `/login` inside a session (ChatGPT-plan OAuth included), or
set an environment variable before launching (e.g.
`export ANTHROPIC_API_KEY=sk-ant-...`; all providers and credential
methods are in [providers.md](docs/providers.md)). Give Ink a task.
For a full walkthrough, start at the [documentation](docs/index.md) topic
map.

Working from a source checkout instead:

```bash
npm install   # installs dependencies and builds (prepare script)
npm start     # launches the interactive REPL
```

Do not copy credentials, migrate state, or publish when updating a source
checkout; for a normal install use the npm package above. Ink reads
`~/.ink` and `INK_*` configuration only and never touches historical
`.imp` state — see [docs/cli.md](docs/cli.md).

## What's inside

A working assistant with an interactive terminal interface, persistent
sessions, and extensible tools:

- Interactive TUI (streaming, one-line tool status, queued steering and
  follow-up runs) plus print mode (`ink -p "..."`) and piped stdin
- Agent loop: streaming LLM calls + tool execution, with abort, validation,
  error feedback, steering hooks, and a compaction hook
- Sessions: append-only JSONL message trees (`~/.ink/sessions/`), `--continue`
  / `--resume <id>` / `ink sessions`, the `/tree` navigator, `/fork`
- Auto-compaction: near the context window, older turns are LLM-summarized
  into a checkpoint; recent turns and the full history on disk are preserved
- Tools: `bash` (timeout, truncation), `read` (offset/limit, images), `edit`
  (exact-match multi-edit), `write`, `grep` (ripgrep), `find` (fd), `ls`,
  `task` (subagents) — search tools respect .gitignore
- Providers: Anthropic, OpenAI (API key or ChatGPT-plan OAuth), Z.AI (GLM),
  DeepSeek, Moonshot/Kimi (international and CN endpoints) — credentials
  from environment variables or `/login`
- Extensions, skills, named subagents, MCP servers, markdown quick commands,
  and custom system prompts (SYSTEM.md)

Roadmap and the historical implementation ledger live in `PROJECT_PLAN.md`;
every feature's design documents and review records live in
[docs/design/](docs/design/) (not shipped in the npm package).

## Interactive mode in one screen

Run `ink` with no arguments for an interactive session over one shared
conversation and session. Plain lines go to the model; lines typed while Ink
is working are queued (`steer:` on Enter, `follow-up:` on alt+enter —
alt+up pulls them back). Ctrl+C aborts the running turn (twice to exit);
Ctrl+D exits; Ctrl+O expands every fold; Ctrl+L opens the model picker;
Shift+Tab cycles thinking; Ctrl+T hides reasoning traces.

Slash commands: `/help`, `/exit`, `/new`, `/fork <n>`, `/tree`, `/sessions`,
`/resume <id>`, `/model [id]`, `/think [level]`, `/compact`, `/status`,
`/copy`, `/name`, `/trust`, `/worktrees`, `/login`, `/logout`, `/mcp`,
`/settings`. Unknown commands get a hint instead of reaching the model;
prefix a line with a space to send a literal leading `/`. Details:
[sessions.md](docs/sessions.md).

Terminal notes for the alt keys: iTerm2, Ghostty, Kitty, and recent VS Code
terminals work out of the box. WezTerm binds Option+Enter to fullscreen by
default and Alacritty may send a plain Return — map both to `\x1b[13;3u`,
or use esc+p.

## Documentation

Full documentation lives in [docs/index.md](docs/index.md) — start there for
a topic map:

- [CLI reference](docs/cli.md) — install, print mode, piping, every flag and
  env var
- [Providers and models](docs/providers.md) — sign-in, families, `/model`,
  the pi.dev model catalog
- [Sessions](docs/sessions.md) — the JSONL tree, `/tree`, `/fork`,
  compaction, steering and follow-ups
- [Settings](docs/settings.md) — settings.json keys, SYSTEM.md, markdown
  quick commands
- [Extensions](docs/extensions.md) — tools, commands, event gates, colors,
  the bundled examples
- [Skills](docs/skills.md) — SKILL.md packages, discovery tiers
- [MCP](docs/mcp.md) — stdio and Streamable HTTP servers, config discovery
- [Subagents](docs/subagents.md) — the `task` tool, named agents, worktree
  isolation
- [Images](docs/images.md) — vision models, paste, the resize ladder

The npm package ships this documentation; the agent routes its own questions
through it. The bundled [examples](examples/README.md) — extensions, a named
subagent, a skill — install alongside.

## Platform support

- **macOS** — the development platform; features are exercised here first.
- **Linux** — supported: CI runs the full gate (typecheck, lint, build,
  tests) on `ubuntu-latest` with the exact Node 22.19.0 minimum and Node 24.
  CI requires `rg` and `fd` so search-tool tests cannot silently skip.
- **Windows** — not supported yet. Native Windows has known blockers (the
  `bash` tool spawns `/bin/bash`, and MCP servers spawn without `.cmd` /
  shell resolution) and no CI coverage. WSL does work — inside it Ink is
  plain Linux.

External tools are optional and platform-dependent: `rg` / `fd` back the
`grep` / `find` tools (missing binaries are reported with install hints; the
rest of Ink works without them), and clipboard image paste uses `osascript`
on macOS and `wl-paste` / `xclip` on Linux.

## Development

```bash
npm run build          # tsc
npm run dev            # tsx src/cli.ts (no build)
npm run typecheck      # tsc --noEmit (both configs)
npm run lint           # biome + script syntax checks
npm test               # vitest run
```

Design archive: every feature's design document and review record lives in
[docs/design/](docs/design/) (not shipped in the npm package).
[RELEASING.md](RELEASING.md) documents the release process. The repository
was renamed from `FishInSalt/imp`; GitHub redirects the old URLs, and
historical release and design records keep their original names.

## License

[MIT](LICENSE)
