# CLI

Read this when you want to run Ink from a shell: installation, print mode,
piping, attachments, sessions, and every flag. Interactive-mode details live
in [sessions.md](sessions.md) (tree, fork) — this page is the command line.

## Install

```bash
npm install -g ink-agent@latest
ink
```

Or without installing: `npm exec -- ink-agent@latest --help`.
Do not use `npx ink` — plain `ink` is an unrelated npm package. There is no
`imp` executable alias.

Requires Node 22.19.0 or newer. From a source checkout:
`npm install` (builds via the prepare script), `npm start` to launch.
The registry package itself runs no install lifecycle scripts (the
`prepare` build script only runs on git clones and local links).

Verify an installation non-interactively:

```bash
ink --version    # prints "Ink <version>"
ink --help       # flag reference, exits 0
```

Uninstall: `npm uninstall -g ink-agent`. If a global install fails with
EACCES, the npm prefix is not user-writable — do not prefix the command
with sudo; point npm at a user-owned prefix (`npm config get prefix`, then
see the npm docs on fixing permissions) and retry. A note for scripted
runs: ink refuses `.ink/` project configuration in an untrusted directory
(safe by default); pre-approve it with `ink --trust` once, per project.

Sign in with `/login` — the provider picker stores an API key in
`~/.ink/auth.json` (0600), where it beats the environment variable; the
ChatGPT plan signs in via OAuth device code. Or set an environment
variable before launching:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Provider-specific setup: [providers.md](providers.md).

## Invocation

```bash
ink -p "<prompt>"        # print mode: stream the response, then exit
ink "<prompt>"           # same as -p
ink @file.png "prompt"   # attach files: text embeds as <file> blocks,
                         # images attach to the first message
ink                      # interactive session (REPL)
echo "fix the typo" | ink   # piped: one turn, exits at EOF (empty pipe: help + exit 1)
```

Print/piped runs default to `--max-turns 100`; interactive TTY sessions are
uncapped (a finite value applies when passed explicitly).

## Options

| Flag | Description |
|---|---|
| `-p`, `--print <prompt>` | Prompt to run, then exit |
| `-m`, `--model <id>` | Model id (default: `$INK_MODEL` or `claude-sonnet-4-5`) |
| `--thinking <level>` | `off` `minimal` `low` `medium` `high` `xhigh` `max` |
| `--max-tokens <n>` | Max output tokens per turn (default: model catalog limit) |
| `--max-turns <n>` | Max agent turns per run |
| `-nc`, `--no-context-files` | Skip AGENTS.md discovery |
| `-c`, `--continue` | Continue the most recent session in this directory |
| `-r`, `--resume <id>` | Resume a session by id (prefix ok) |
| `--no-session` | Do not persist this run (also disables auto-compaction) |
| `-e`, `--extension <path>` | Load an extension (file or dir; repeatable; loads regardless of trust) |
| `-ne`, `--no-extensions` | Skip extension discovery (explicit `-e` still loads) |
| `--skill <path>` | Load a skill (.md file or directory; repeatable; loads regardless of `--no-skills`) |
| `--no-skills` | Skip skill discovery (user + project + settings) |
| `--trust` / `--no-trust` | Record a trust decision for this directory's `.ink/` resources |
| `-h`, `--help` / `-v`, `--version` | Help / version |

## Subcommands

| Command | Description |
|---|---|
| `ink sessions` | List saved sessions for this directory |
| `ink login` | OpenAI (ChatGPT plan) device-code OAuth |
| `ink logout` | Remove the stored ChatGPT-plan credential (keys saved by `/login` stay) |

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Anthropic key / Bearer token |
| `ANTHROPIC_BASE_URL` | Endpoint override for Anthropic-compatible services |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI key / endpoint override (any OpenAI-compatible service) |
| `ZAI_API_KEY` | Z.ai key (GLM Coding Plan) |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `MOONSHOT_API_KEY` | Moonshot/Kimi key (both families) |
| `INK_MODEL` | Default model id |
| `INK_THINKING` | Default thinking level (invalid values: notice + ignore) |
| `INK_CONTEXT_WINDOW` | Context window for auto-compaction (default 131072) |
| `INK_AUTOCOMPACT=0` | Disable auto-compaction |
| `INK_MCP=0` | Disable the MCP module entirely |
| `INK_HEALTH=0` | Disable the loop-health monitor |
| `INK_BRANCH_SUMMARY=0` | Disable branch summaries (hard off) |
| `INK_CHILD_SESSIONS=0` | Do not persist subagent transcripts |
| `INK_CATALOG_BASE_URL` / `INK_CATALOG_PATH` | Redirect / relocate the model catalog |
| `INK_SETTINGS_PATH` | Settings file override |

`INK_*` gating variables use `0` to disable; anything else enables.

## Renamed from imp

Ink reads `~/.ink`, project `.ink/`, and `INK_*` only. It does not migrate
`.imp` state or `IMP_*` settings; old sessions stay in `.imp` and cannot be
resumed. Standard `AGENTS.md`, `.agents/skills`, and MCP config filenames are
unchanged. The old `FishInSalt/imp` GitHub URLs redirect to
`FishInSalt/ink`.
