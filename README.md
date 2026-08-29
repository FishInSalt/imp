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
  disk), `/model [id]` (applies from the next turn), `/compact` (summarize
  older context now). Unknown commands get a hint instead of reaching the
  model; prefix a line with a space to send a literal leading `/`.
- `-c`, `-r`, `-m`, `--no-session`, … all work as in print mode.
- Piping works too: `echo "fix the typo in foo.ts" | imp` runs one turn and
  exits at EOF (a zero-line pipe still prints help and exits 1).

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
