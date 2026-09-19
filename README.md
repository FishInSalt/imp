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

### Signing in (/login)

`/login` in the REPL stores credentials in `~/.imp/auth.json` (0600) — a
stored key beats the environment variable, and a bare `glm-*` model id
routes to the zai family (pi parity: zai is the one official GLM path;
a missing credential gets a sign-in pointer, never a silent fallback):

```
/login            → Z.AI · Anthropic · OpenAI · OpenAI (ChatGPT plan)
/login zai        → straight to the key prompt (Enter saves, Esc cancels)
/logout           → remove a stored credential (environment variables stay)
```

The OpenAI (ChatGPT plan) row runs the device-code OAuth flow in the
REPL: imp prints the verification URL and code, polls in the background,
and Ctrl+C cancels (the prompt stays usable — no force quit). Rows show
each provider's status (`signed in — stored key`, `env: ZAI_API_KEY`,
`not signed in`), and after a login from a different family imp points
at the matching `/model` switch. `imp logout` (CLI) removes only the
ChatGPT-plan credential; `/logout` (REPL) removes any stored one.

### Using Z.ai GLM Coding Plan

The official path is the zai family — `/login` in the REPL (pick Z.AI)
or:

```bash
export ZAI_API_KEY=<your z.ai api key>
export IMP_MODEL=glm-5.3   # or glm-5.2, glm-4.7, ... per your plan
```

The pre-zai anthropic-compat setup (`ANTHROPIC_BASE_URL` pointing at
z.ai) still works when forced explicitly (`imp -m anthropic/glm-5.3`),
but bare `glm-*` ids no longer fall back to it. Prefer `/login` — the
compat endpoint carries the binary thinking knob only.

### Using any Anthropic-compatible service

```bash
export ANTHROPIC_AUTH_TOKEN=<token>          # or ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=<your endpoint>
export IMP_MODEL=<id the endpoint serves>
```

Note: `/login anthropic` stores a key that overrides `ANTHROPIC_AUTH_TOKEN`
(and sends `x-api-key` style instead of `Bearer`) — on a compat endpoint,
prefer the env pair above.

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
  queued — each queued row shows its route: `steer:` lines (plain Enter)
  inject into the running turn before the next model call, `follow-up:`
  lines (alt+enter) wait for the run to settle and then run as their own
  turn. The prompt shows `+ ` while a run is active.
- alt+up (or esc+p — works on terminals without the Kitty keyboard
  protocol) pulls every queued line back into the editor for editing;
  your in-progress draft is preserved below them. Ctrl+C abort hand the
  queued lines back the same way — user input is never silently dropped.
- Terminal notes for the alt keys: iTerm2, Ghostty, Kitty, and recent VS
  Code terminals work out of the box. WezTerm binds Option+Enter to
  fullscreen by default and Alacritty may send a plain Return — map both
  to `\x1b[13;3u`, or use esc+p (dequeue has a fallback; alt+enter does
  not, absent terminal support).
- `Ctrl+C` aborts the running turn (press twice to force quit; at an empty
  prompt, press twice to exit). `Ctrl+D` exits. The exit line shows how to
  resume: `imp -r <id>`.
- Slash commands: `/help`, `/exit`, `/new` (fresh session, old one stays on
  disk), `/fork` (branch the conversation before an earlier message — pick
  one from the filterable list or `/fork <n>`), `/tree` (switch between the
  branches `/fork` created; the branch you leave is summarized into the new
  one's context — disable with `IMP_BRANCH_SUMMARY=0`), `/sessions` (list
  saved sessions for this directory),
  `/resume <id>` (switch to one — history replays on screen),
  `/model [id]` (applies from the next turn),
  `/think [level]` (thinking intensity; bare `/think` or **Shift+Tab**
  cycles; models without a thinking knob say so; the footer shows
  `think:<level>`). Available levels follow each model's catalog entry
  (pi parity): some models cannot turn thinking off (gpt-5 base, o3,
  gpt-6), newer ones expose `xhigh`/`max`, zai GLM 5.2+ maps
  low/medium/high to `high` effort. Switching model or level prints one
  dim status line (`Model: x` / `Thinking level: x`) — consecutive
  switches merge into a single line. `/compact` (summarize
  older context now). Unknown commands get a hint instead of reaching the
  model; prefix a line with a space to send a literal leading `/`.
- Thinking levels can also start a session: `imp --thinking medium` or
  `IMP_THINKING=medium` (invalid env values are ignored with a notice).
  The default is pi's `medium` on models with a thinking knob, and the
  level you choose persists in `~/.imp/settings.json` as the next
  session's default. **Ctrl+T** hides/shows reasoning traces (replaced by
  a dim `Thinking...` label; also persisted); on Anthropic traces are
  kept in context as the API requires.
- Z.ai GLM connects the way pi does — the coding endpoint over the
  OpenAI protocol is the ONE official GLM path:
  `ZAI_API_KEY=... imp -m zai/glm-5.3`, or `/login` → Z.AI in the REPL
  (`ZAI_BASE_URL` overrides, e.g. the CN mirror
  `https://open.bigmodel.cn/api/coding/paas/v4`). A bare `glm-*` id
  routes there unconditionally; without a credential imp prints a
  one-line sign-in pointer instead of silently connecting elsewhere.
  glm-5.2 = off/high/max; glm-5.3 = low/high/max (thinking cannot be
  disabled on that model). The old env-only anthropic-compat fallback
  is retired — `anthropic/glm-…` still forces that endpoint explicitly
  (generic compat passthrough, binary thinking knob only), and the
  footer and `/model` always show `zai/glm-…` for the coding path.
- `-c`, `-r`, `-m`, `--no-session`, … all work as in print mode.
- Piping works too: `echo "fix the typo in foo.ts" | imp` runs one turn and
  exits at EOF (a zero-line pipe still prints help and exits 1).

Known limits (declared, not bugs):

- The `/resume` picker's type-to-filter consumes committed text only — IME
  composition windows emit no keys mid-composition (kitty protocol), so
  CJK input filters once committed. A pasted block takes its first line.


## Markdown quick commands

Drop a `.md` file into `~/.imp/commands/` (global) or `<project>/.imp/commands/`
(project — behind the same trust gate as extensions and agents: a cloned repo
must not grow commands that talk to the model) and its filename becomes a
slash command:

```bash
mkdir -p ~/.imp/commands
cat > ~/.imp/commands/review.md <<'EOF'
---
description: review the current diff against the plan
allowedDuringRun: false
---
Review the working tree diff against PROJECT_PLAN.md. Focus on contract
drift. $ARGUMENTS
EOF
```

- `/review focus on tests` spends a real model turn with the file body
  (`$ARGUMENTS` is replaced by everything after the command name; without
  the placeholder the arguments append as a trailing paragraph).
- Project files override global ones with the same name; built-in names and
  already-loaded extension command names are rejected with a diagnostic.
- `/help` lists them with `md:global` / `md:project` tags.
- Scripted (piped) REPLs load them too when the directory is trusted — the
  same rule extension commands follow; print mode (`-p`) never loads them.

## Skills

A skill is a self-contained instruction package ([Agent Skills](https://agentskills.io)
standard — same shape as Claude Code and pi skills). Only a one-line catalog
entry enters the system prompt; the model reads the full body with the `read`
tool when a task matches — zero context cost until then:

```bash
mkdir -p .imp/skills/ledger
cat > .imp/skills/ledger/SKILL.md <<'EOF'
---
description: keep PROJECT_PLAN.md as an append-only ledger
---
Append dated entries above the anchor, newest first…
EOF
```

- Discovery: `<project>/.imp/skills` + `.agents/skills` (project tiers,
  trust-gated; the ancestor walk goes up to the git root), `~/.imp/skills` +
  `~/.agents/skills` (user tiers), plus `--skill <path>` / settings
  `"skills"` (explicit, always load; `--no-skills` skips discovery).
- `/skill:ledger <args>` force-loads: expands to the full body as the user
  message (one-line `▪ skill: ledger` echo; session keeps the full text).
- `/help` lists skills tagged `[skill]`; `"enableSkillCommands": false`
  disables command registration (the catalog stays).

See [docs/skills.md](docs/skills.md) for the full rules and
[examples/skills/ledger](examples/skills/ledger) for a worked example with a
`references/` directory.

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

**Worktree isolation.** A `task` call may set `worktree: true` (or an agent
file may declare `worktree:`): the child runs on its own git worktree — a
separate checkout of the committed state under the system temp dir — with the
builtin tools rebuilt at that path, so it physically cannot touch the parent's
files. The child prompt is told to translate paths and to commit its work; the
result names the branch and change summary, and the parent merges with
`git merge <branch>` when it wants the work. A worktree with no changes is
removed (branch and all); preserved work is never discarded. Extension tools
are excluded from worktree children (their registered cwd cannot move).
Isolation is by default working directory — a child's `bash` could still
reference absolute paths outside it, same as the reference implementations.

**Concurrency boundary.** Concurrent subagents share the parent's working
directory. `edit`/`write` mutations to the same file serialize through a
process-wide file lock, and a failed `oldText` match degrades into a teaching
error (re-read, retry) — but `bash` mutations bypass the lock entirely, and a
whole-file `write` silently clobbers an earlier one. So: delegate independent
subtasks in parallel; same-file modifications sequentially (the task tool
description tells the model the same). Read-only agent profiles (`tools:`
without edit/write/bash) make that structural — and `worktree: true` removes
the shared surface entirely (see above).

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
  all), so the run adapts instead of dying. Subagent tool calls pass through
  the same gate: those events carry `subagent: true` plus the `agent` profile
  name (if any), so a gate can hold children to stricter rules than the main
  loop.
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
