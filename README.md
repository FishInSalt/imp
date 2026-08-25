# imp 👹

A small coding agent that runs in your terminal. Built from scratch, inspired by [pi](https://github.com/earendil-works/pi-mono).

> An imp is a little goblin that runs errands for its master — eager, fast, and best kept behind a permission gate.

## Status: M0 (minimal viable agent)

- Agent loop: streaming LLM calls + tool execution, with abort, validation, and error feedback to the model
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

## Development

```bash
npm test          # vitest (no API key needed)
npm run typecheck # tsc --noEmit
npm run dev       # run CLI from source via tsx
```

See `PROJECT_PLAN.md` for the roadmap.

## License

MIT
