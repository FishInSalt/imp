# imp 👹

A small coding agent that runs in your terminal. Built from scratch, inspired by [pi](https://github.com/earendil-works/pi).

> An imp is a little goblin that runs errands for its master — eager, fast, and best kept behind a permission gate.

## Status

A working coding agent, built milestone by milestone (roadmap and history:
`PROJECT_PLAN.md`). At a glance:

- Interactive TUI (streaming, one-line tool status, queued steering and
  follow-up runs) plus print mode (`imp -p "..."`) and piped stdin
- Agent loop: streaming LLM calls + tool execution, with abort, validation,
  error feedback, steering hooks, and a compaction hook
- Sessions: append-only JSONL message trees (`~/.imp/sessions/`), `--continue`
  / `--resume <id>` / `imp sessions`, the `/tree` navigator, `/fork`
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

Requires Node 20 or newer.

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
/login            → Z.AI · Anthropic · OpenAI · OpenAI (ChatGPT plan) ·
                    DeepSeek · Moonshot AI · Moonshot AI CN
/login zai        → straight to the key prompt (Enter saves, Esc cancels);
                    any family name works (deepseek, moonshotai, …)
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

`imp --help` lists every option — sessions (`-c`, `-r`, `--no-session`), model
and thinking (`-m`, `--thinking`), limits (`--max-turns`, `--max-tokens`;
print/piped runs default to 100 turns, interactive TTY sessions are uncapped),
and resource loading (`-e` / `-ne`, `--skill` / `--no-skills`, `-nc`,
`--trust` / `--no-trust`).

## Model catalog (pi.dev)

Model metadata — context windows, cost rates, thinking ladders, vision
capability, family model lists — comes from the public catalog service at
`pi.dev` (the same source the reference project consumes). A disk cache
(`~/.imp/models-catalog.json`) makes it offline-safe: at startup imp loads
the cache synchronously (the bundled static tables are the frozen last-resort
floor) and kicks a non-blocking refresh when the cache is older than 4 hours;
opening `/model` re-checks the same window. No periodic polling. On a
successful fetch the catalog always wins over the bundled tables, so new
models and price changes arrive without an imp release.

```bash
IMP_CATALOG_BASE_URL=https://mirror.example  # redirect the catalog source
IMP_CATALOG_PATH=/path/to/models-catalog.json # relocate the cache (tests)
```

## Interactive mode

Run `imp` with no arguments to start an interactive session (REPL) over one
shared conversation and session:

```bash
imp            # interactive REPL (streaming, one-line tool status)
```

- Plain lines are sent to the model. Lines typed while imp is working are
  queued — each queued row shows its route: `steer:` lines (plain Enter)
  inject into the running turn before the next model call (default mode
  `all`: every queued steer line joins the next boundary at once),
  `follow-up:` lines (alt+enter) are consumed by the SAME run when the
  model would otherwise stop — one queued follow-up per answer (default
  mode `one-at-a-time`), so a queued sequence advances without returning
  to idle and one Ctrl+C interrupts the whole remainder. Both drain modes
  are settings keys: `/settings steeringMode` and `/settings followUpMode`
  (`all` | `one-at-a-time`). The prompt shows `+ ` while a run is active.
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
  one from the filterable list or `/fork <n>`), `/tree` (navigate the
  session TREE: a visual picker over every turn and branch — arrows move,
  Tab cycles the filter (default/no-tools/user-only/labeled-only/all), `f`
  folds a subtree, `L` labels the selected entry (bookmarks: labeled rows
  are searchable and survive every filter as the labeled-only mode), typing
  searches, Enter jumps. The picker opens ON your current position, ←/→/PgUp/
  PgDn page, alt+←/→ folds at branch points or jumps between branch segments,
  ctrl+x copies the selected entry's text, and deep rows pan automatically so
  the selection's text stays readable. An Esc at the summary ask — or a
  cancelled summarization — returns to the picker with the same entry
  preselected. Jumping to any point leaves the branch you left
  summarized into the new position's context (a three-way ask — No summary /
  Summarize / custom prompt; `/settings branchSummary.skipPrompt true` skips
  the ask); jumping to a USER message puts its text back in the input for
  re-editing — `/fork` does exactly this from a user-message list, and seeds
  the editor the same way; disable summaries with `IMP_BRANCH_SUMMARY=0`;
  `/settings treeFilterMode <mode>` remembers your default filter. The
  readline shell renders the same tree as a numbered list — `/tree <n>` jumps
  to row n), `/sessions` (list
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
  older context now). Also `/status` (session, model, context, and trust at a
  glance), `/copy` (copy the last agent message), `/name <name>` (name the
  session), `/trust` (show the trust decision and its records), `/worktrees`
  (worktrees kept for a manual merge), `/login` / `/logout`, `/mcp`, and
  `/settings`. Unknown commands get a hint instead of reaching the
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
- DeepSeek connects through the official API:
  `DEEPSEEK_API_KEY=... imp -m deepseek/deepseek-v4-pro` (or
  `deepseek/deepseek-flash`), or `/login` → DeepSeek. `DEEPSEEK_BASE_URL`
  overrides the endpoint; a stored key wins over the environment variable.
- Moonshot / Kimi connects through the official open platform:
  `MOONSHOT_API_KEY=... imp -m moonshotai-cn/kimi-k3` (China,
  `api.moonshot.cn/v1`) or `moonshotai/kimi-k3` (overseas,
  `api.moonshot.ai/v1`), or `/login` → Moonshot AI / Moonshot AI CN.
  Both read `MOONSHOT_API_KEY` with per-family stored keys;
  `MOONSHOT_BASE_URL` / `MOONSHOT_CN_BASE_URL` override the endpoints.
  Thinking: k2.6 toggles off/on; k2.7-code and k3 always think (k3 takes
  `reasoning_effort` low/high/max — the `medium` startup level maps to
  `high`).
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

## Custom system prompt (SYSTEM.md)

Replace the default system prompt with your own file, or append to it:

- `.imp/SYSTEM.md` (project, requires trust) or `~/.imp/SYSTEM.md` (global) —
  the file's content replaces the default prompt body (identity, core rules,
  tool catalog). The working directory line, project context files
  (AGENTS.md/CLAUDE.md), skills, the agent roster, and extension context
  sections still load — those are routing facts, not persona.
- `.imp/APPEND_SYSTEM.md` / `~/.imp/APPEND_SYSTEM.md` — appended after the
  prompt body in both modes (e.g. "Answer in Chinese").

Project files need the directory trusted (`imp --trust`); the project tier
wins over the global one per file. An empty file disables the custom prompt
for that pair (the default prompt stays).

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

## Images

The `read` tool attaches images to the conversation. When the active model
supports vision (claude, gpt-4o/4.1/4.5/5, o3/o4, glm-5.3-flash/flashx,
glm-5v …), a read of a jpg/png/gif/webp sends the image inline — the model
sees it. Detection is by content (magic bytes), never by file extension.

- Oversized images (>4.5 MB encoded) are resized automatically through the
  photon (Rust/WASM) ladder — 2000×2000 cap, PNG/JPEG candidates, quality
  steps, dimension decay — with a coordinate-mapping note telling the model
  how to map back to original pixels. Set `images.autoResize: false` in
  `~/.imp/settings.json` to ship original bytes (oversize then gets a
  teaching note instead).
- BMP converts to PNG (EXIF orientation baked in); jpg/jpeg mime labels
  normalize.
- Attach files to a print-mode prompt: `imp @shot.png @notes.txt "what is
  this"` — text files embed as `<file>` blocks, images attach to the first
  message through the same processor.
- In the TUI, Ctrl+V pastes a clipboard image as a tmp-file path at the
  cursor (macOS via osascript, Linux via wl-paste/xclip, Windows via
  PowerShell); plain text pastes when no image is found.
- Text-only models still read successfully: the image is replaced by a
  placeholder at request time, and the tool notes the omission.
- z.ai Coding Plan users: `glm-5.3-flash` is the vision model of the plan
  (GLM-5.3 itself is text-only).

Transcript and print show one dim note per attachment
(`▪ image [image/png, 412.3 KB]`); sessions store the full image blocks.

## Subagents

The `task` tool delegates a self-contained job to a fresh subagent with its
own context window: exploration bloat stays out of the main conversation; the
subagent's final message comes back as the tool result (with a usage trailer;
oversized results are tail-truncated to 50KB). Children run in-process with
the parent's tools (minus `task` itself) and the parent's working directory,
under a 60-turn backup wall (a degenerate-loop guard — budget decisions stay
with the parent), and every child transcript is persisted as a session file in
a `children/` directory next to the parent's (opt out with
`IMP_CHILD_SESSIONS=0`). Wall-clock: no clock in the REPL (Ctrl+C is the
backstop), a 60-minute hang guard in print/headless runs; a call's `timeoutMs`
or an agent file's `timeout:` (seconds) always wins. Several `task` calls in
one turn run concurrently (waves of up to 5) with deterministic, call-ordered
output.

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

Registered agents are advertised to the model in the system prompt's
`<advertised_agents>` block (auto-routing hint); `task(agent: "scout", prompt:
…)` runs one. Agent files load at startup — new files need a restart, like
extension changes. A ready-to-copy example lives in
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

## MCP (Model Context Protocol)

imp can consume tools exposed by MCP servers over stdio — the same config
files pi's adapter reads, so an existing setup works unchanged:

```jsonc
// ~/.config/mcp/mcp.json (or ~/.agents/mcp.json, or <project>/.mcp.json)
{
	"mcpServers": {
		"zai-vision": {
			"command": "npx",
			"args": ["-y", "@z_ai/mcp-server"],
			"env": { "Z_AI_API_KEY": "…" }
		}
	}
}
```

Discovery order (later files override earlier ones per server, whole entry):
`~/.config/mcp/mcp.json` → `~/.agents/mcp.json` → `~/.agents/mcp/mcp.json` →
`<project>/.mcp.json` → `<project>/mcp.json`. Values in `command`/`args`/`env`
expand `${VAR}`, `$env:VAR` and `{env:VAR}` placeholders. `"disabled": true`
on a server skips it (visible in `/mcp`).

Every server tool registers flat as `<server>_<tool>` (e.g.
`zai-vision_analyze_image`) and is callable by the model like a built-in tool.
Connections start asynchronously at startup (npx cold starts can take a
while); tools that connect while a run is in flight join at the next run
boundary. A server that dies mid-session reconnects transparently on the next
tool call. `/mcp` shows per-server status; `IMP_MCP=0` or
`"mcp": {"enabled": false}` in settings disables the module entirely
(no config found = zero cost, nothing spawns).

**v1 scope** (stdio + tools only; deliberate, each deferral has a trigger):
no OAuth/HTTP transports, no sampling or elicitation, no resources/prompts
surfaces, no per-call approval gates, no cross-vendor config import
(cursor/claude/windsurf), and no `mcp` proxy tool (flat registration until a
server with ≥10 tools shows up). Design + trigger table:
`docs/m18-mcp-design.md`.

## Extensions

imp loads **extensions** — plain ESM modules (`.mjs`, or `.js` under a
module-typed package) whose default export is a factory receiving one thin
`api` object — from three places, in this order:

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

- Three read-only facts ride along: `cwd` (absolute working directory imp
  started in), `version` (imp version string), and `origin` (`"cli" |
  "project" | "global"` — where the extension was discovered).
- `registerTool` adds an LLM-callable tool; `registerCommand` adds a REPL slash
  command (tagged `[source]` in `/help`); `registerContext(id, text)` appends a
  static section to the system prompt; `on("tool_call" | "tool_end" |
  "message_end" | "run_start" | "run_end")` subscribes to loop/turn events —
  `tool_call`
  handlers run after argument validation and before execution, and a block
  decision becomes the tool result the model sees (teaching-style reason and
  all), so the run adapts instead of dying. Subagent tool calls pass through
  the same gate: those events carry `subagent: true` plus the `agent` profile
  name (if any), so a gate can hold children to stricter rules than the main
  loop. `run_start` fires once when a top-level run begins; its pair `run_end`
  does NOT fire if the run crashes (provider throw) — tolerate an unpaired
  `run_start` (e.g. reset on the next one).
- `setStatus(key, text)` sets a one-line status in the TUI footer
  (`undefined` clears it; keys are namespaced per extension; the host owns
  styling — control sequences are stripped). It works from handlers, timers,
  and command callbacks, and is a safe no-op in print mode and the legacy
  shell. If your extension creates timers, `unref()` them — a leaked,
  referenced timer blocks process exit.
- A bad extension never kills imp: load failures, registration conflicts, and
  handler throws each become one `imp:` teaching line; a throwing `tool_call`
  handler fails **safe** (the call is blocked).
- `--no-extensions` skips both discovery directories (explicit `-e` paths still
  load).

**Security**: extensions are code and run with your full permissions — the same
posture as the agent itself. Check `.imp/extensions/` in repositories you
didn't write, or run with `--no-extensions`. Case studies ship in
`examples/extensions/`: `notes.mjs` (the API tour), `guardian.mjs` (a
rule-based permission gate over destructive bash commands and out-of-project
writes — configurable via `IMP_GUARDIAN_BLOCK`, audited to
`~/.imp/guardian.log`), `notify.mjs` (a macOS completion notification with
sound), `task-timer.mjs` (a live per-run timer in the TUI footer, built on
`run_start`/`run_end` + `setStatus`), and `web-search/` (a bundled multi-file
search tool).

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

MIT — see [LICENSE](LICENSE).
