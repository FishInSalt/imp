# Ink

An open-source AI assistant and agent harness for the terminal. Use Ink for
research, writing, analysis, software development, and other tool-assisted
tasks. Built from scratch, inspired by [pi](https://github.com/earendil-works/pi).

The repository is [FishInSalt/ink](https://github.com/FishInSalt/ink),
renamed from `FishInSalt/imp`; GitHub redirects the old URLs. Ink is the current
product name; historical release and design records keep their original names.

## Status

A working assistant with an interactive terminal interface, persistent
sessions, and extensible tools. Roadmap and historical implementation ledger:
`PROJECT_PLAN.md`. At a glance:

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
- Providers: Anthropic, Z.AI (GLM), DeepSeek, Moonshot/Kimi, OpenAI (API key
  or ChatGPT-plan OAuth) — credentials come from environment variables or
  `/login`
- Extensions, skills, named subagents, MCP servers, markdown quick commands,
  and custom system prompts (SYSTEM.md)

## Setup

Requires Node 22.19.0 or newer, matching the pinned TUI dependency.
The package is published on npm as `ink-agent`. Install it to provide the
`ink` command:

```bash
npm install -g ink-agent@latest
ink
```

Or let npm infer the single `ink` executable from the explicit package:

```bash
npm exec -- ink-agent@latest --help
```

Do not use `npx ink`: plain `ink` is an unrelated npm package. There is no
`imp` executable alias.

Then sign in with an API key (or `/login` inside a session):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Working from a source checkout instead:

```bash
npm install   # installs dependencies and builds (prepare script)
npm start     # launches the interactive REPL
```

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

### Rename from imp

Ink reads `~/.ink`, project `.ink`, and `INK_*` configuration only. It does
not discover, merge, or automatically migrate `.imp` state or `IMP_*`
settings. Standard `AGENTS.md`, `.agents/skills`, and MCP configuration
filenames are unchanged. This cutover uses an independent installation and
selected configuration only; old sessions, logs and history stay in `.imp`
and are not migrated. Start new Ink sessions. Historical child sessions
cannot resume across the version change.
The public source type `ImpSettings` is now `InkSettings`, a breaking change
for deep imports. Historical records stay readable but are never rewritten
or migrated: legacy launch records (`impVersion`) stay readable through a
normalization arm, and old `.imp-machine-id` files are left untouched (never
read, adopted or deleted). New records and leases use Ink names
(`inkVersion`, `.ink-machine-id`), and new task worktrees use
`ink-worktree-*` / `ink/task-*` while historical `imp-worktree-*`
directories stay listed. Codex plan requests now carry `originator: "ink"`.

See the [local installation and acceptance record](docs/design/ink-local-install.md)
and [release instructions](RELEASING.md). The original
[rename design](docs/design/ink-rename-design.md) is historical; its full-state
migration and source-linked activation proposal was superseded.
Do not copy credentials, migrate state, or publish when updating a source
checkout; for a normal install use the npm package above.

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
[RELEASING.md](RELEASING.md) documents the release process.

## License

[MIT](LICENSE)
