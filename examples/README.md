# Examples

Example extensions and agents for Ink. The npm package installs this
directory alongside the documentation.

## Usage

Copy an example into your extensions directory (project-local
`.ink/extensions/` when the project is trusted, or user `~/.ink/extensions/`)
and restart Ink:

```bash
mkdir -p ~/.ink/extensions
cp examples/extensions/notify.mjs ~/.ink/extensions/
```

Or load one explicitly for a single session:

```bash
ink -e /absolute/path/to/notify.mjs
```

See [docs/extensions.md](../docs/extensions.md) for the extension API
(tools, commands, event gates, colors) and
[docs/subagents.md](../docs/subagents.md) for named agents.

## Extensions

| Example | Description |
|---------|-------------|
| [`notes.mjs`](extensions/notes.mjs) | The API tour: tools, commands, and events in one file |
| [`guardian.mjs`](extensions/guardian.mjs) | Config-driven permission gate: wildcard/regex rules that deny or ask before a call runs; audits to `~/.ink/guardian.log`. Starter rules in [`guardian.template.json`](extensions/guardian.template.json) — copy to `~/.ink/guardian.json` and edit |
| [`notify.mjs`](extensions/notify.mjs) | macOS sound + popup notification when a run finishes |
| [`task-timer.mjs`](extensions/task-timer.mjs) | Live per-run timer in the TUI footer while a run is in flight |
| [`tool-colors.mjs`](extensions/tool-colors.mjs) | Tool-name color theme via the `#tool-name-colors` hook |
| [`web-search/`](extensions/web-search/) | Full zero-dependency web-search extension: `web_search` (Tavily) + `url_read` page reader |

## Agents

| Example | Description |
|---------|-------------|
| [`scout.md`](agents/scout.md) | Read-only research subagent: explores a codebase to answer questions |

## Agents

| Example | Description |
|---------|-------------|
| [`scout.md`](agents/scout.md) | Read-only research subagent: explores a codebase to answer questions |

The `web-search/` extension has its own detailed README (install, credentials,
tool contracts, troubleshooting):
[extensions/web-search/README.md](extensions/web-search/README.md).
