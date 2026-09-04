# imp 👹

A small coding agent that runs in your terminal. Built from scratch, inspired by [pi](https://github.com/earendil-works/pi-mono).

> An imp is a little goblin that runs errands for its master — eager, fast, and best kept behind a permission gate.

## Status: M0 (minimal viable agent)

- Agent loop: streaming LLM calls + tool execution, with abort, validation, error feedback, steering hooks, and a compaction hook
- Sessions: append-only JSONL message trees (`~/.imp/sessions/`), `--continue` / `--resume <id>` / `imp sessions`
- Auto-compaction: near the context window, older turns are LLM-summarized into a checkpoint; recent turns and the full history on disk are preserved
- Tools: `bash` (timeout, truncation), `read` (offset/limit), `edit` (exact-match multi-edit), `write`, `grep` (ripgrep), `find` (fd) — search tools respect .gitignore
- Provider: Anthropic (streaming)
- CLI: print mode (`imp -p "..."`)

## Setup

```bash
npm install
npm run build
export ANTHROPIC_API_KEY=sk-ant-...
```

### Using Z.ai GLM Coding Plan (or any Anthropic-compatible service)

```bash
export ANTHROPIC_AUTH_TOKEN=<your z.ai api key>
export ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
export IMP_MODEL=glm-4.6   # or glm-4.5, glm-4.7, ... per your plan
```

## Usage

```bash
# dev (no build)
npm run dev -- -p "List the .ts files here and count their total lines"

# installed bin
./bin/imp.js -p "Read src/cli.ts and summarize what it does"

# options
imp -p "..." -m claude-sonnet-4-5 --max-turns 20
```

## Interactive mode

Run `imp` with no arguments to start an interactive session (REPL) over one
shared conversation and session:

```bash
imp            # interactive REPL (streaming, one-line tool status)
```

- Plain lines are sent to the model. Lines typed while imp is working are
  queued and injected when the current turn ends ("steering") — the prompt
  shows `+ ` while a run is active.
- `Ctrl+C` aborts the running turn (press twice to force quit; at an empty
  prompt, press twice to exit). `Ctrl+D` exits. The exit line shows how to
  resume: `imp -r <id>`.
- Slash commands: `/help`, `/exit`, `/new` (fresh session, old one stays on
  disk), `/sessions` (list saved sessions for this directory),
  `/resume <id>` (switch to one — history replays on screen),
  `/model [id]` (applies from the next turn), `/compact` (summarize
  older context now). Unknown commands get a hint instead of reaching the
  model; prefix a line with a space to send a literal leading `/`.
- `-c`, `-r`, `-m`, `--no-session`, … all work as in print mode.
- Piping works too: `echo "fix the typo in foo.ts" | imp` runs one turn and
  exits at EOF (a zero-line pipe still prints help and exits 1).

## Subagents

The `task` tool delegates a self-contained job to a fresh subagent with its
own context window: exploration bloat stays out of the main conversation; the
subagent's final message comes back as the tool result (with a usage trailer;
oversized results are tail-truncated to 50KB). Children run in-process with
the parent's tools (minus `task` itself) and the parent's working directory,
under a 40-turn / 30-minute budget, and every child transcript is persisted as
a session file in a `children/` directory next to the parent's (opt out with
`IMP_CHILD_SESSIONS=0`). Several `task` calls in one turn run concurrently
(waves of up to 5) with deterministic, call-ordered output.

Named agents live as markdown files with hand-parsed frontmatter — no YAML
dependency, no builtins; the project directory wins on name collisions:

```
.imp/agents/scout.md        # or ~/.imp/agents/ for user-global agents
---
name: scout
description: Explores a codebase to answer research questions
tools: read, grep, find     # optional subset of the parent pool
model: glm-5.3              # optional spawn-time override
timeout: 300                # optional wall clock, seconds
---

You are a code scout. Go broad before deep.
```

The task tool's description enumerates registered agents (auto-routing hint);
`task(agent: "scout", prompt: …)` runs one. Agent files load at startup — new
files need a restart, like extension changes. A ready-to-copy example lives in
`examples/agents/scout.md` (a read-only code scout: `tools: read, grep, find`).

## Extensions

imp loads **extensions** — plain ESM modules (`.mjs`) whose default export is a
factory receiving one thin `api` object — from three places, in this order:

1. `-e <path>` / `--extension <path>` flags (repeatable; file or directory)
2. `<project>/.imp/extensions/`
3. `~/.imp/extensions/`

```js
// .imp/extensions/hello.mjs — an extension is a plain ESM module.
/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	api.registerTool({ /* …an imp Tool — name, description, parameters, execute… */ });
	api.registerCommand({ /* …a /slash command, listed in /help… */ });
	api.registerContext("hello", "…a system-prompt section, appended after AGENTS.md…");
	api.on("tool_call", (event) => {
		// may veto: return { block: true, reason: "…what to do instead…" }
	});
}
```

- `registerTool` adds an LLM-callable tool; `registerCommand` adds a REPL slash
  command (tagged `[source]` in `/help`); `registerContext(id, text)` appends a
  static section to the system prompt; `on("tool_call" | "tool_end" |
  "message_end" | "run_end")` subscribes to loop/turn events — `tool_call`
  handlers run after argument validation and before execution, and a block
  decision becomes the tool result the model sees (teaching-style reason and
  all), so the run adapts instead of dying.
- A bad extension never kills imp: load failures, registration conflicts, and
  handler throws each become one `imp:` teaching line; a throwing `tool_call`
  handler fails **safe** (the call is blocked).
- `--no-extensions` skips both discovery directories (explicit `-e` paths still
  load).

**Security**: extensions are code and run with your full permissions — the same
posture as the agent itself. Check `.imp/extensions/` in repositories you
didn't write, or run with `--no-extensions`. Two case studies ship in
`examples/extensions/`: `notes.mjs` (the API tour) and `guardian.mjs` (a
rule-based permission gate over destructive bash commands and out-of-project
writes — configurable via `IMP_GUARDIAN_BLOCK`, audited to
`~/.imp/guardian.log`).

## Development

```bash
npm test          # vitest (no API key needed; search-tool tests skip if rg/fd missing)
npm run lint      # biome check (lint + format)
npm run lint:fix  # biome check --write
npm run typecheck # tsc --noEmit
npm run dev       # run CLI from source via tsx
```

See `PROJECT_PLAN.md` for the roadmap.

## License

MIT
