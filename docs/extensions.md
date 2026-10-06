# Extensions

Read this when you want to add tools, slash commands, system-prompt sections,
event gates, or tool colors to Ink. Skills (markdown packages) →
[skills.md](skills.md); MCP (external servers) → [mcp.md](mcp.md).

## What an extension is

A plain ESM module (`.mjs`, or `.js` under a module-typed package) whose
default export is a factory receiving one thin `api` object. Ink loads them
from three places, in this order:

1. `-e <path>` / `--extension <path>` flags (repeatable; file or directory;
   loads regardless of the trust gate)
2. `<project>/.ink/extensions/` — behind the [trust gate](index.md#project-trust)
3. `~/.ink/extensions/`

`--no-extensions` skips both discovery directories (explicit `-e` paths
still load).

```js
// .ink/extensions/hello.mjs — an extension is a plain ESM module.
/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	api.registerTool({ /* …an Ink Tool — name, description, parameters, execute… */ });
	api.registerCommand({ /* …a /slash command, listed in /help… */ });
	api.registerContext("hello", "…a system-prompt section, appended after AGENTS.md…");
	api.on("tool_call", (event) => {
		// may veto: return { block: true, reason: "…what to do instead…" }
	});
}
```

Three read-only facts ride along: `cwd` (absolute working directory Ink
started in), `version` (Ink version string), and `origin`
(`"cli" | "project" | "global"` — where the extension was discovered).

## The api surface

- **`registerTool(tool)`** — add an LLM-callable tool (same shape as the
  built-in tools: name, description, typebox `parameters`, `execute`).
- **`registerCommand(command)`** — add a REPL slash command (tagged
  `[source]` in `/help`).
- **`registerContext(id, text)`** — append a static section to the system
  prompt, after AGENTS.md context.
- **`on(event, handler)`** — subscribe to `tool_call`, `tool_end`,
  `message_end`, `run_start`, `run_end`.
- **`setStatus(key, text)`** — one line in the TUI footer (`undefined`
  clears; keys namespaced per extension; the host owns styling). Works from
  handlers, timers, and command callbacks; safe no-op in print mode. If you
  create timers, `unref()` them — a leaked referenced timer blocks process
  exit.
- **`registerToolColor(names, color)`** — color tool **names** in the TUI
  call header. `names`: one name, several, or `"*"` (fallback). `color`: a
  standard-16 token (`black` … `bright*`), `"none"` (bold-only), or an
  absolute token — `#rrggbb` or `ansi256:N` (the portable choice). Exact
  names beat `"*"`; the first registration of a name wins within the tier.
  No colors ship by default.
- **`suggestToolColor(names, color)`** — the same API one tier weaker: the
  tool's own extension suggests its default look; **any user registration
  outranks any suggestion** (user exact > user `"*"` > suggested exact >
  suggested `"*"`). Use it in tool-providing extensions;
  `registerToolColor` belongs in themes.
- **`confirm(message, detail?, options?)`** — ask the human a yes/no
  question. Resolves exactly `true` on explicit approval; `false` covers
  declines, empty answers, and hosts without an interactive prompt;
  `"timeout"` when `options.timeoutMs` expires unanswered (compare with
  `=== true`, never a truthy check). `options.sessionKey` enables
  "don't ask again this session" memory; `options.warnSpans` highlights
  character ranges in the detail; `options.preview` renders a
  command-style request.

## Events

- `tool_call` — after argument validation, before execution. Handlers may
  return `{ block: true, reason: "…" }`; the block decision becomes the
  tool result the model sees (reason included), so the run adapts instead
  of dying. Subagent calls pass through the same gate with
  `subagent: true` plus the `agent` profile name — a gate can hold children
  to stricter rules.
- `tool_end` / `message_end` — observers: results and finalized assistant
  messages.
- `run_start` — fires once when a top-level run begins. `run_end` does NOT
  fire if the run crashes (provider throw) — tolerate an unpaired
  `run_start` (e.g. reset state on the next one). Subagent runs emit
  neither.

## Failure behavior

A bad extension never kills Ink: load failures, registration conflicts, and
handler throws each become one `ink:` teaching line. A throwing `tool_call`
handler fails **safe** — the call is blocked.

## Security

Extensions are code and run with your full permissions — the same posture as
the agent itself. Check `.ink/extensions/` in repositories you didn't write,
or run with `--no-extensions`.

## Bundled examples

`examples/extensions/` ships case studies:

- `notes.mjs` — the API tour
- `guardian.mjs` — a config-driven permission gate: wildcard/regex rules
  that deny or ask before a call runs, file-scoped `write`/`edit` rules;
  config at `~/.ink/guardian.json`, audited to `~/.ink/guardian.log`
- `notify.mjs` — a macOS completion notification with sound
- `task-timer.mjs` — a live per-run timer in the TUI footer
  (`run_start`/`run_end` + `setStatus`)
- `tool-colors.mjs` — a name-color theme for the call header (built-ins
  Claude-orange, `task` bright cyan)
- `web-search/` — a bundled multi-file search tool

Copy one into `~/.ink/extensions/` and edit to taste.
