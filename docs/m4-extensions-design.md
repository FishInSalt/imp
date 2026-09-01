# M4 — Extension System — Design

Branch `m4-extensions`. Stage M4 per PROJECT_PLAN.md, re-scoped into three sub-milestones
(M4a tools, M4b commands, M4c hooks + context injection). This document is the implementation
contract: module layout, signatures, exact diagnostics strings, conflict policy, trust decision,
test plan, and per-sub-milestone acceptance criteria.

Reference: pi's extension system was studied via two research reports. Every pi citation and
every imp `file:line` seam below was spot-checked against the actual sources
(`/Users/z/Z/Agent_demo/pi`, this repo at `main`); corrections in Appendix B — nothing
material was wrong.

Where imp deliberately diverges from pi, the divergence is called out and justified
(Appendix A summarizes).

---

## 1. Goals

- imp loads **extensions**: plain ESM modules (`.mjs`, or `.js` under a module-typed package)
  whose default export is a factory function `function (api)`. Through the `api` object an
  extension can:
  - **M4a** — register custom **tools** the model can call (`registerTool`);
  - **M4b** — register REPL **slash commands** (`registerCommand`);
  - **M4c** — subscribe to **loop/turn events** (`on("tool_call" | "tool_end" | "message_end" |
    "run_end")`, where `tool_call` can **block** execution) and inject **system-prompt context**
    (`registerContext`).
- One bad extension must **never** kill imp: load failures, registration conflicts, and handler
  errors are isolated per extension and surfaced as teaching-style diagnostics.
- Two validating case studies ship in `examples/extensions/`: **guardian** (rule-based
  permission gate over `bash`/`write` — the M0 "bash safety" debt, paid with an extension,
  not core) and **notes** (a tour of all three contribution points).
- Zero new npm dependencies. Loading is plain `await import(path)` — no jiti, no bundler, no
  watcher. Extensions restart with imp (no hot reload in M4).

### Non-goals (explicitly deferred, §16)

MCP support, custom providers, subagents-as-API, any UI contribution (renderers, autocomplete,
dialogs), hot reload, npm/git extension packages, settings manifests, trust prompts,
per-handler `ctx` objects, parallel-safe event fan-out. Each deferral has a rationale in §16.

### Headline constraints

- **Zero new dependencies.** pi needs jiti because its extensions are TypeScript that import
  host modules (`@earendil-works/pi-coding-agent`, `typebox`, `pi-tui`) — the loader must alias
  those to the host's own instances (pi `loader.ts:411-416`). imp extensions receive everything
  through the `api` argument and import nothing from imp, so the entire alias/virtual-module
  layer is unnecessary. Plain `import()` suffices.
- **Hooks, not framework.** The API is one thin object with three registration methods, one
  subscribe method, and three read-only facts. No lifecycle container, no per-extension classes,
  no dispose. (PROJECT_PLAN §1: "克制是特性".)
- **Errors as data.** Extension-caused failures become `imp:` teaching lines and (for blocked
  tools) `isError` tool results fed back to the model — never process crashes, never silent.
- TypeScript NodeNext — relative imports end in `.js`. Biome: tabs, double quotes,
  lineWidth 110, no `any`. typebox v1 for tool schemas (extensions build their own — §5.2).

---

## 2. What imp borrows from pi (and what it refuses)

Spot-checked pi sources: `packages/coding-agent/src/core/extensions/{types,loader,runner,wrapper}.ts`,
`core/resource-loader.ts`, `core/package-manager.ts`, `core/trust-manager.ts`,
`packages/agent/src/agent-loop.ts`, `docs/extensions.md`. Borrowed, verbatim in spirit:

1. **Registration writes into a plain data record.** pi's `createExtension` builds an `Extension`
   of empty `Map`s that the host later iterates (`loader.ts:434-450`). imp's registry is the
   same shape: the factory mutates data; the host consumes data, never closures it didn't create.
2. **Fail-safe error isolation at three layers**: per-extension try/catch at load (pi
   `loadExtension` returns `{extension: null, error}`, `loader.ts:454-478`), per-handler
   try/catch at emit (pi `runner.ts:930-1000`), and — emergent in pi, explicit in imp — a
   throwing `tool_call` handler blocks the tool (pi's agent-loop wraps the prepare path in a
   catch that converts throws into error tool results, `agent-loop.ts:619-660`; imp makes it
   a rule, §12).
3. **The `tool_call` block contract**: handlers return `{block?: boolean; reason?: string}`
   (pi `types.ts:1058-1063`); a block short-circuits remaining handlers (pi `runner.ts:918-938`)
   and becomes an `isError` tool result (`agent-loop.ts:634-640`).
4. **Eager factory activation** — pi awaits `factory(api)` during load (`loader.ts:464-466`);
   imp awaits it before the runner is created.
5. **Deterministic ordering with explicit precedence**: pi ranks CLI `-e` paths above
   configured/discovered sources (`resource-loader.ts:497-502`, `package-manager.ts:178-187`),
   and its `no-extensions` mode keeps CLI paths while dropping discovered ones. imp adopts
   exactly this.
6. **Discovery shape**: direct files + `dir/index.*` entries, no deep recursion (pi
   `loader.ts:568-610`).

Refused, with reasons (Appendix A): jiti/TS loading and module aliasing (unnecessary — §1);
the ~26-event zoo (4 events; the other 22 have no consumer today); trust prompts +
`trust.json` (§11); name-collision semantics (pi overrides built-ins and suffixes duplicate
commands `:1`/`:2`; imp reserves built-ins and rejects duplicates — §10); reload/
session-replacement lifecycle (imp has no session tree or RPC mode to protect); packages
(npm:/git:), settings manifests, resource discovery (no distribution story yet).

---

## 3. Discovery and configuration

### 3.1 Decision

Extension sources, in load order:

| # | Source | Origin tag | Notes |
|---|--------|-----------|-------|
| 1 | `-e <path>` / `--extension <path>` CLI flags, repeatable, in flag order | `cli` | A path may be a file or a directory (directories use the same entry rules as discovery dirs) |
| 2 | `<cwd>/.imp/extensions/` | `project` | Created by the user; never auto-created by imp |
| 3 | `~/.imp/extensions/` | `global` | Sits beside the existing `~/.imp/{logs,sessions,AGENTS.md}` |

`-ne` / `--no-extensions` skips sources 2 and 3 but **keeps** source 1 — explicit paths are
explicit intent. This mirrors pi exactly (its `noExtensions` mode still merges CLI paths,
`resource-loader.ts:497-502`) and gives users a guaranteed escape hatch from a bad discovered
extension.

No `settings.json`, no `packages` keys, no manifests, no path env vars — two directories plus
a flag is the entire configuration surface (richer waits for distribution, §16).

### 3.2 Entry resolution per directory

For each discovery directory (and for `-e <dir>`), in deterministic (code-point-sorted) order:

1. every direct child matching `*.mjs` or `*.js` — skipping dotfiles and `_`-prefixed files;
2. every direct child **directory** containing `index.mjs` or `index.js`.

No deeper recursion, no `package.json` manifest reading (pi additionally supports a `pi`
manifest — `loader.ts:568-610`; imp's `index.*` rule covers the subdirectory-package layout
that matters locally). Entries are deduplicated by `realpath` across all sources (a `-e` path
that also sits in a discovery dir loads once, keeping its first origin).

Justification vs pi: pi's discovery feeds a package manager with enable/disable state,
git/npm sources, and settings precedence — imp has none of that machinery, so pi's three-way
merge collapses to "flag, then project, then global, dedup by realpath".

### 3.3 Why `.mjs` is the canonical extension suffix

`~/.imp/extensions/` and `<project>/.imp/extensions/` usually have no `package.json` above
them declaring `"type": "module"`, so Node treats a bare `.js` there as CommonJS and
`export default` fails with a syntax error. `.mjs` is unambiguous everywhere. `.js` is still
accepted (it works when a module-typed `package.json` sits above the file — the common
monorepo case); when a `.js` load fails, the diagnostic appends a rename hint (§12, E2).
Examples and docs use `.mjs` throughout.

---

## 4. Module layout

```
src/
  extensions/
    types.ts       extension contract: factory, api, events, registry types (~120 lines)
    registry.ts    ExtensionRegistry: the data record + validation + isolated emits (~150)
    loader.ts      discovery + dynamic import + factory invocation + diagnostics (~170)
  core/loop.ts     +1 option (onToolCall), +6 lines in executeToolCall            (+~18)
  runner.ts        RunnerOptions.extensions; tool merge; system append; emit wiring (+~28)
  repl/
    commands.ts    dispatchCommand extra-commands param; /help extension listing  (+~30)
    repl.ts        pass extension commands through to dispatchCommand             (+~8)
  cli.ts           -e/-ne flags; loadExtensions; diagnostics; plumbing            (+~35)
examples/extensions/
  notes.mjs        case study: tool + command + context (the documented tour)     (~70)
  guardian.mjs     case study: rule-based permission gate                        (~90)
```

Layering statement, same logic as M3's `src/repl/` decision: `src/core/` keeps zero extension
knowledge — the loop gains one generic hook (`onToolCall`) that is a peer of `onMessage` /
`onBeforeTurn` / `getSteeringMessages` (loop.ts:31-37). Everything extension-shaped lives in
`src/extensions/`, and only `cli.ts` (the composition root) and `runner.ts` (the engine that
owns tools/system/history) touch it. `runRepl` receives already-registered commands as data.

Import graph (all edges `.js`-suffixed, no cycles): `cli.ts → extensions/loader.ts →
extensions/registry.ts → extensions/types.ts`; `cli.ts → runner.ts` (which consumes
`extensions/registry.js` as a type and passes `core/loop.js` its `onToolCall`); `cli.ts →
repl/repl.ts → repl/commands.js`. Notably `repl/commands.ts` imports only **types** from
`extensions/types.js` (`RegisteredExtensionCommand`) — no runtime edge from `src/repl/`
into `src/extensions/`.

---

## 5. The extension contract

### 5.1 Module shape

```js
// ~/.imp/extensions/guardian.mjs — an extension is a plain ESM module.
/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	api.registerTool({ /* …imp Tool… */ });
	api.on("tool_call", (event) => {
		if (event.name === "bash" && /rm\s+-rf/.test(String(event.args.command ?? ""))) {
			return { block: true, reason: "destructive delete — ask the user first" };
		}
	});
}
```

- Default export: a function (sync or async). Called exactly once, awaited, before the runner
  starts. The factory may register nothing (a pure observer extension is valid).
- The module may have other exports (ignored). Top-level side effects execute at import —
  unavoidable in any dynamic-import design, pi included; §11 covers why we accept this.
- Extension **name**: basename without extension (`guardian.mjs` → `guardian`,
  `notes/index.mjs` → `notes`); used in diagnostics, `/help` source labels, context
  attribution. Same-name files are legal; their registrations collide per §10 and surface there.

### 5.2 TypeScript story for extension authors (zero-dep)

imp is not published, so extensions cannot `import type { ExtensionApi } from "imp"`. M4
authors use JSDoc with a relative type import (as above; editors resolve it against the local
checkout) or write untyped JS — the api object is plain. A documented limitation, not a flaw:
it costs nothing in core and disappears when imp is published (M5).

### 5.3 Reusing imp's own types — deliberately

`registerTool` accepts imp's existing `Tool` (core/tools/types.ts:13-19) **verbatim**, and
`registerCommand` accepts `SlashCommand` (repl/commands.ts:14-21) **verbatim**. Extensions get
the same data shapes the core uses; there is no `ToolDefinition` wrapper layer, no
`renderCall`/`renderResult` slots (no UI to render into), no `prepareArguments` shim (imp has
no legacy stored args to upgrade — pi needed it for pre-1.0 sessions, docs/extensions.md).

---

## 6. The ExtensionApi — complete surface

Seven members total: three read-only facts, three registration methods, one subscriber.
This is the **entire** API; anything an extension cannot do with this, it cannot do in M4.

```ts
// src/extensions/types.ts
export interface ExtensionApi {
	/** Absolute working directory imp was started in. */
	readonly cwd: string;
	/** imp version string (format.ts VERSION). */
	readonly version: string;
	/** Where this extension was discovered: explicit flag, project dir, or global dir. */
	readonly origin: "cli" | "project" | "global";

	/** Register a tool the model can call. Reuses core Tool verbatim (M4a). */
	registerTool(tool: Tool): void;
	/** Register a REPL slash command. Reuses SlashCommand verbatim (M4b). */
	registerCommand(command: SlashCommand): void;
	/** Append a titled section to the system prompt, after AGENTS.md context (M4c). */
	registerContext(id: string, text: string): void;

	/** Subscribe to a loop/turn event. "tool_call" handlers may block (M4c). */
	on(event: "tool_call", handler: ToolCallHandler): void;
	on(event: "tool_end", handler: (event: ToolEndEvent) => void): void;
	on(event: "message_end", handler: (event: MessageEndEvent) => void): void;
	on(event: "run_end", handler: (event: RunEndEvent) => void): void;
}
```

One-line purposes:

| Member | Purpose |
|---|---|
| `cwd` | Let gates/examples key behavior on the project without `process.cwd()` guessing |
| `version` | Feature-detect imp capabilities from one extension file across versions |
| `origin` | Let a shared extension behave differently when loaded explicitly vs discovered |
| `registerTool(tool)` | Add an LLM-callable tool to the run's tool set |
| `registerCommand(command)` | Add a REPL slash command (`/help` lists it automatically) |
| `registerContext(id, text)` | Contribute a system-prompt section — per-extension context injection |
| `on("tool_call", h)` | Observe/intercept tool calls; return `{block, reason}` to veto |
| `on("tool_end", h)` | Observe completed tool results (audit, stats) |
| `on("message_end", h)` | Observe each finalized assistant message |
| `on("run_end", h)` | Observe run completion (`stopReason`, `turns`, `usage`) |

### 6.1 Event payloads

```ts
export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	name: string;
	/** Schema-validated arguments (the same object execute() will receive). */
	args: Record<string, unknown>;
}

/** Returned (sync or async) by a "tool_call" handler. */
export interface ToolCallDecision {
	/** Block execution. true is the only meaningful value; omit/void = allow. */
	block: boolean;
	/** Fed back to the model as the (isError) tool result — make it teaching-style. */
	reason?: string;
}

export type ToolCallHandler = (
	event: ToolCallEvent,
) => ToolCallDecision | void | undefined | Promise<ToolCallDecision | void | undefined>;

export interface ToolEndEvent {
	type: "tool_end";
	toolCallId: string;
	name: string;
	output: string;
	isError: boolean;
}

export interface MessageEndEvent {
	type: "message_end";
	/** The assistant message just appended to history (blocks + usage included). */
	message: AssistantMessage;
}

export interface RunEndEvent {
	type: "run_end";
	stopReason: "completed" | "max_iterations" | "aborted";
	turns: number;
	usage: Usage;
}
```

Semantics:

- `tool_call` fires **after** TypeBox validation, **before** `tool.execute` — handlers see
  exactly what the tool will see (pi validates first too: `agent-loop.ts:619-625`). Unknown
  tools and schema failures never reach extensions; they are already error results by then
  (loop.ts:231-253).
- Handlers chain in **load order** (§3.1). The first `{block: true}` short-circuits the chain
  and the tool does not run; everything else (void, `{block: false}`) continues the chain.
  Non-blocking results do not accumulate — M4 has no result rewriting (pi's `tool_result`
  middleware chain is consciously not ported; §16).
- `tool_end` / `message_end` / `run_end` are observability only, invoked **without blocking
  the loop** (fire-and-forget with internal isolation); handlers must not rely on running
  before the next LLM call. `tool_call` is the only awaited event — it must be, to block.

### 6.2 What handlers do NOT get (deliberate)

No per-call `ctx` object. pi hands every handler an `ExtensionContext` with `ui`, `model`,
`sessionManager`, `abort()`, `compact()`, … (types.ts:337-390) because pi extensions build
UIs and steer sessions. Every imp M4 use case (gate, audit, notes) needs only event data plus
`api.cwd`; when a real consumer appears (M5+ interactive gates need `ui.confirm`), a second
handler parameter is added — additive, non-breaking.

---

## 7. Loading — dynamic ESM import with per-extension isolation

### 7.1 Loader algorithm

```ts
// src/extensions/loader.ts
export interface LoadExtensionsOptions {
	cwd: string;
	/** Paths from repeatable -e/--extension flags, in flag order. */
	cliPaths: readonly string[];
	/** Receives teaching-style diagnostic lines as they are discovered (renderer-backed). */
	onDiagnostic?: (line: string) => void;
}

export interface LoadedExtensions {
	/** The runtime the runner/repl consume (tools, commands, context, emits). */
	readonly runtime: ExtensionRegistry;
	/** Per-extension summaries for the startup banner, in load order. */
	readonly summaries: readonly ExtensionSummary[];
	/** Extensions that failed to load (already reported via onDiagnostic). */
	readonly failures: readonly { path: string; error: string }[];
}

export async function loadExtensions(options: LoadExtensionsOptions): Promise<LoadedExtensions>;
```

Per candidate path, in order:

1. `const mod = await import(pathToFileURL(resolved).href)` — try/catch. Failure →
   diagnostic E1 (+E2 hint for `.js`), record failure, continue.
2. `const factory = mod.default`. Not a function → diagnostic E3, record failure, continue.
3. `await factory(api)` where `api` writes into a fresh per-extension section of the registry.
   A throw here fails the **whole extension atomically**: its section (everything registered
   before the throw) is discarded, diagnostic E4, continue with the next path. This matches
   pi (`loadExtension` returns `{extension: null, error}` — loader.ts:478-481) and keeps
   half-configured extensions out of the run.
4. Registration-time problems (conflicts, bad names — §10) do **not** fail the extension: the
   offending registration is skipped with a diagnostic, the rest stands. Divergence from pi,
   where the api methods throw and therefore kill the extension via step 3 — imp prefers
   "one bad registration ≠ one dead extension" and shows why (teaching-error convention).

There is **no module cache management**: Node caches by resolved URL for the process lifetime,
which is exactly right when nothing reloads. Hot reload (pi's `/reload` + jiti
`moduleCache: false`, loader.ts:411-416) is M5+ (§16); tests use fresh temp dirs per case so
the cache is never observed.

---

### 7.2 Isolation guarantees

| Failure | Effect on imp | Effect on other extensions |
|---|---|---|
| Import throws (syntax, missing file) | Diagnostic E1; run continues | None |
| No/invalid default export | Diagnostic E3; run continues | None |
| Factory throws | Registrations discarded, diagnostic E4; run continues | None |
| Registration conflict/invalid | That registration skipped, diagnostic E5-E8; rest of extension live | First registration stands |
| `tool_call` handler throws | **Fail-safe: tool blocked**, reason carries the error (E9) | None |
| Other handler throws/rejects | Diagnostic E10; run continues | None |

The fail-safe direction for `tool_call` is chosen because a broken *gate* failing open would
be the one extension error that changes what code executes. pi reaches the same outcome by
accident of layering (agent-loop's catch converts the throw into an error tool result); imp
writes it down as the contract.

### 7.3 Startup diagnostics — exact formats

Printed once at startup, after the `▪ context:` banner (if any), before the REPL banner.
Loaded extensions print one dim `▪` line each (counts omit zero categories, pluralized):

```
▪ extension guardian [project] — 1 tool, 2 hooks
▪ extension notes [global] — 1 tool, 1 command, 1 context
▪ extension deploy [cli] — 1 tool
```

Zero extensions anywhere → **silence** (the 99% no-extension run stays byte-identical to
today). Failures and rejections print `imp:` red lines (renderer.error):

```
imp: extension broken failed to load — SyntaxError: Unexpected token '}' (broken.mjs:3:1)
imp: extension legacy failed to load — Cannot use import statement outside a module. hint: bare ".js" files without a module-typed package.json are CommonJS to Node — rename to ".mjs" or add package.json {"type":"module"}
imp: extension notes failed to load — default export must be a function, got undefined
imp: extension clash could not register tool "deploy" — already registered by guardian
imp: extension meta could not register command "model" — reserved by imp (known: help exit new model compact)
imp: extension weird could not register tool "Bad_Name" — tool names must match /^[a-z][a-z0-9_-]{0,63}$/ (got "Bad_Name")
```

Error text is `firstLine(err.message, 160)` per the house convention; the full error + stack
goes to the run log via the existing `RunLogger` (`run_error` extended with
`{ source: "extension", path }`) — one line on screen, debuggable on disk.

---

## 8. Contribution points

### 8.1 M4a — custom tools

Wiring (the seam REPORT-B identified, verified):

- `createRunner`'s `tools` option is today a "test seam" replacing the fixed six
  (runner.ts:63-64, merge at runner.ts:134-142). It generalizes: effective set =
  `[...(options.tools ?? sixBuiltins), ...(extensions?.tools ?? [])]`. Tests that pass `tools`
  explicitly keep their hermetic set; extension tools append.
- The loop already validates (`Value.Check`, loop.ts:255), executes with the signal, and
  converts throws to `isError` results (loop.ts:262-276). **Zero loop changes for M4a.**
- Registration-time sanity (in `registry.ts`, cheap, teaching-style): name matches
  `/^[a-z][a-z0-9_-]{0,63}$/`, `description` is a non-empty string, `parameters` passes a
  smoke `Value.Check(parameters, {})` inside try/catch (a malformed schema throws in Value —
  better to reject at registration than mid-run; this closes the one validation gap the loop
  does not guard).
- Extension tools are full peers: model-visible, abortable, error-isolated. There is no
  sandbox and no permission model at the tool layer — same posture as built-ins (pi docs:
  extensions "run with your full system permissions"). Gating is an extension's job
  (guardian, §13).

### 8.2 M4b — slash commands

Wiring:

- `dispatchCommand` gains an optional third parameter (commands.ts:123):

```ts
export async function dispatchCommand(
	line: string,
	ctx: CommandContext,
	extraCommands?: readonly RegisteredExtensionCommand[],
): Promise<CommandOutcome>;
```

- Lookup order: built-in `COMMANDS` first, then `extraCommands` (commands.ts:123). Built-in
  names are reserved anyway (§10), so the order is cosmetic — but it keeps the diff inside
  the existing guard structure (unknown-command and allowedDuringRun branches,
  commands.ts:126-141, untouched).
- `RegisteredExtensionCommand = { command: SlashCommand; source: string }` (the extension
  name) lives in `extensions/types.ts`; `src/repl/` imports it as a type only.
- `repl.ts` passes the list at its single dispatch call site (repl.ts:164) — the commands come
  from `runRepl` options:

```ts
export interface ReplOptions {
	runner: Runner;
	commands?: readonly RegisteredExtensionCommand[]; // from cli.ts: loadExtensions → runRepl
	// … unchanged …
}
```

- `/help` is generated from the table it is handed (commands.ts:38-48) so extension commands
  appear automatically and cannot drift. Extension rows get a dim source suffix:

```
Commands:
  /help              show this help
  /exit              exit (Ctrl+D works too)
  /new               start a fresh session (the old one stays on disk)
  /model [id]        show the current model, or switch (applies next turn)
  /compact           summarize older context now
  /notes <text>      remember something across turns              [notes]
```

- The unknown-command teaching error lists **all** known names (built-ins + extensions),
  generated the same way it is today (commands.ts:130-133) — no drift by construction.
- Extension `command.run` throwing gets exactly the treatment built-ins get: `runCommand`'s
  try/catch → `imp: <msg>` → REPL continues (repl.ts:155-170). Free isolation, no new code.
- **Print mode has no slash dispatch** (it never had); extension commands are REPL-only —
  documented in the README section and in the `registerCommand` JSDoc.
- `allowedDuringRun` is the author's responsibility, enforced by the same guard as built-ins
  (identical rejection message, name interpolated).

### 8.3 M4c — loop/turn event hooks + per-extension context injection

**The one loop change** (this is the whole of `src/core/`'s involvement in M4):

```ts
// src/core/loop.ts — RunAgentLoopOptions gains a peer of onMessage/onBeforeTurn:
	/**
	 * Permission/observation gate: called after argument validation, before
	 * tool execution. Return { block: true, reason } to veto — the model
	 * receives an isError tool result carrying the reason.
	 */
	onToolCall?: (
		call: { toolCallId: string; name: string; args: Record<string, unknown> },
	) => ToolCallDecision | void | undefined | Promise<ToolCallDecision | void | undefined>;
```

Inserted in `executeToolCall` after the `Value.Check` branch, before `tool.execute`
(loop.ts:255 → 262):

```ts
	const decision = await onToolCall?.({ toolCallId: id, name, args: record });
	if (decision?.block) {
		return {
			toolCallId: id,
			toolName: name,
			content: `Tool "${name}" blocked by an extension: ${decision.reason ?? "no reason given"}`,
			isError: true,
		};
	}
```

Placement rationale: `tool_start` has already fired at loop.ts:135 (the UI shows the attempt,
then its `✗` line) — the same visibility aborts get today. The block result flows through the
normal `results.push` → `onMessage` → session persistence, so a blocked call is resumable
history like any error result. `onToolCall` is threaded from `runTurnInner` as
`this.extensions?.emitToolCall(call)` — when no extension registered a `tool_call` handler,
the registry's emit is a no-op fast path and the loop pays one function call.

**Runner-side emissions** (all inside `runTurnInner`, runner.ts:224-260):

- `onMessage` wrapper gains: `if (message.role === "assistant") extensions?.emitMessageEnd(message);`
- `onEvent` wrapper (currently passed straight through, runner.ts:237): wrap once —
  forward to `options.onEvent` (renderer), and on `tool_end` also
  `extensions?.emitToolEnd(event.result)` (fire-and-forget).
- After `runAgentLoop` resolves: `extensions?.emitRunEnd(result)` before returning. A loop
  throw (provider failure) emits nothing — `run_end` means a run that ended, not one that
  crashed; the error path already has its own reporting.
- Handler errors inside any emit are caught by the registry and reported as E10; they never
  propagate into the loop.

**Context injection** (runner.ts:184-196, `assembleSystem`): after the AGENTS.md block, each
registered section is appended in load order:

```ts
		for (const section of this.extensions?.contextSections ?? []) {
			system += `\n\n# Extension context: ${section.id}\n\n${section.text}`;
		}
```

`/new` re-runs `assembleSystem` (runner.ts:208) and therefore re-appends the same registered
sections — registration data outlives sessions. This is the entire "per-extension context
injection" mechanism: no events, no re-evaluation per turn (a section wanting fresh data
re-registers… nothing — M4 sections are static strings; dynamic context is M5, §16).

---

## 9. Conflict and name policy

| Registration | Rule on conflict | Diagnostic |
|---|---|---|
| Tool name ∈ built-in six (`bash read edit write grep find`) | **Reserved** — rejected | E7 shape: `reserved by imp (built-in tools: bash read edit write grep find)` |
| Tool name already registered by an earlier extension | **First wins** — later rejected, both named | `imp: extension X could not register tool "t" — already registered by Y` |
| Command name ∈ built-in five (`help exit new model compact`) | Reserved — rejected | E7 |
| Command name already registered | First wins — rejected | same shape |
| Context section `id` already registered | First wins — rejected | same shape |
| Tool/command name fails `/^[a-z][a-z0-9_-]{0,63}$/` | Rejected | E8 |
| Same file reached via two sources | Deduped by realpath, first origin kept | none |

"First wins" follows load order (§3.1): `-e` flags → project → global. Global-then-project
would put the *less* specific extension first; project-local overriding a global default is
the nearest-wins convention imp already uses for AGENTS.md (context-files.ts:14-30).

**Divergence from pi** (stated, not accidental): pi lets a later extension **override built-in
tools by name** (docs/extensions.md:~2062) and suffixes colliding command names `:1`/`:2`.
imp refuses both — silent shadowing of `bash` is what a permission-gate user *thinks* they
installed but rarely what they got (a wrapper that forgets to delegate DoSes the agent), and
`/deploy:1` is untypeable from memory after reading `/help`. imp's guardian pattern (§13)
wraps behavior through `tool_call` *observation*, leaving the built-in intact and auditable.
If real wrapping demand appears, M5 can add an explicit `registerToolWrapper` — opt-in and
typed for delegation — rather than reopening name shadowing.

---

## 10. Lifecycle and ordering

Startup sequence (both modes): `cli.main()` → `parseArgs` (`-e` collect, `-ne` flag) → create
`Renderer` (exists today, cli.ts:190-196/240-246) → **`loadExtensions({cwd, cliPaths,
onDiagnostic: renderer.error})`** → **print `▪` banner lines** (via the shared helper, §14) →
`createRunner({…, extensions: runtime})` → print mode runs `runTurn` (extensions active,
commands inert); repl mode runs `runRepl({runner, commands: runtime.commands})`.

- Factories ran **before** `createRunner`: registered tools exist when the tool array is
  built, context sections exist when `assembleSystem` first runs in `warmup()`. Deferred init
  (`deferInit`, scripted mode) is unaffected — the registry is already populated; only
  `assembleSystem`'s *consumption* is deferred, exactly like AGENTS.md today.
- `/new`: same registry, fresh session, sections re-appended (§8.3). Compaction is untouched —
  extension context lives in the system prompt, not in history; the summarizer never sees or
  loses it.
- **No dispose, no session_shutdown.** pi tears runtimes down on `quit|reload|new|resume|fork`
  (types.ts:609-616) because pi has reload and a session tree. imp's extensions hold no
  imp-owned resources in M4 (a fact `examples/` keeps true), the process exit cleans up, and
  there is nothing to reload. When reload lands (M5+), a `shutdown` event is the first thing
  added to the event set — the `on()` shape already accommodates it.
- Extensions and `--no-session`: orthogonal. A notes extension without imp sessions persists
  its own file wherever it wants (`api.cwd`-relative); imp offers no session API to extensions
  in M4 (REPORT-B's D2 warning: sessions are keyed by raw cwd until M5 re-keys by repo root —
  exposing session creation now would bake the wrong namespace into third-party code).

---

## 11. Trust model — decision: none in M4, documented instead

**imp loads project-local and global extensions with no first-use prompt, no `trust.json`,
and no per-project decision state.** Three reasons:

1. **Consistency with imp's actual security posture.** The model already executes arbitrary
   `bash` with the user's full permissions (M0 design decision, PROJECT_PLAN §6.6), and
   project-controlled `AGENTS.md` content is already injected into the system prompt from
   every ancestor directory with no gate (context-files.ts:14-30). A malicious checkout can
   already instruct the agent harmfully via AGENTS.md or just via the code it asks the agent
   to read. Gating `.imp/extensions/` while blessing those would be security theater — and a
   trust prompt that only protects one of three equal vectors trains users to click through.
2. **No distribution surface yet.** pi needs trust because `cd`-into-a-repo auto-executes code
   for every pi user on earth; the threat is *other people's* repositories. imp is a local,
   single-user, unpublished dev tool (M5 plans `npm install -g`). The realistic M4 user put
   the extensions there themselves.
3. **The M4 case study is the real permission layer.** Users who want gates install guardian
   (which can gate `bash` itself). A one-time "trust this project?" forever-answer is a worse
   outcome than a rule-based gate evaluating every call.

Mitigations shipped instead — **visibility** (every loaded extension prints name + origin at
startup, §7.3, including the `project` tag for checkout-provided ones), **escape hatch**
(`-ne`/`--no-extensions`, with `-e` still honored), and **a recorded trigger**: the M5
distribution milestone must revisit this decision — pi's `trust.json` + nearest-ancestor +
`project_trust` design (trust-manager.ts:22-30, 35-50) is the reference to port. This is
written into PROJECT_PLAN's M5 section.

README documents in plain words: *extensions are code and run with your permissions; check
`.imp/extensions/` in repositories you didn't write, or run with `--no-extensions`.*

---

## 12. Error catalog (teaching-style, exact strings)

Every diagnostic states what failed, why, and how to fix it — the project convention (M3 §6.2,
loop.ts:218-253). One line each, `firstLine(msg, 160)`.

| ID | Situation | Exact text (interpolations in `<>`) |
|---|---|---|
| E1 | import failed | `imp: extension <name> failed to load — <firstLine(err,160)>` |
| E2 | E1 && path ends `.js` | append ` hint: bare ".js" files without a module-typed package.json are CommonJS to Node — rename to ".mjs" or add package.json {"type":"module"}` |
| E3 | default export not a function | `imp: extension <name> failed to load — default export must be a function, got <typeof>` |
| E4 | factory threw | E1 shape (registrations discarded) |
| E5 | tool name taken by extension | `imp: extension <ext> could not register tool "<n>" — already registered by <other>` |
| E6 | command/context id taken | same shape (`register command` / `register context`) |
| E7 | reserved name | `imp: extension <ext> could not register <kind> "<n>" — reserved by imp (known: <list>)` |
| E8 | invalid name | `imp: extension <ext> could not register tool "<n>" — tool names must match /^[a-z][a-z0-9_-]{0,63}$/ (got "<n>")` |
| E9 | tool_call handler threw → fail-safe block | tool result content: `Tool "<n>" blocked by an extension: handler error — <firstLine(err,160)>` |
| E10 | other handler threw/rejected | `imp: extension <name> handler error (<event>) — <firstLine(err,160)>` |
| — | blocked tool result (normal path) | `Tool "<n>" blocked by an extension: <reason ?? "no reason given">` |

E9/E10 are rate-unlimited by design (a handler that throws every turn should be visible
every turn); the run log carries the full stacks.

---

## 13. Case studies (`examples/extensions/`)

### 13.1 `guardian.mjs` — rule-based permission gate (~90 lines)

The M0 deferred risk ("模型可能执行破坏性命令… 正式做权限门放在 M4 扩展", PROJECT_PLAN §6.6)
paid off the way pi pays it: as an extension, not core.

- `on("tool_call")` inspects `bash.command` / `write.path` / `edit.path` against a pattern
  list; a match returns `{ block: true, reason: "…" }` where the reason is teaching-style —
  it tells the *model* what to do instead (`rm -rf src/` → "destructive delete — list the
  files and ask, or delete them one by one with confirmation").
- Patterns come from `IMP_GUARDIAN_BLOCK` (comma-separated regex sources) over defaults:
  `rm -rf`, `git push --force`, fork bombs, `curl … | sh` shapes, `sudo`.
- `on("tool_end")` appends one audit line per blocked/error result to `~/.imp/guardian.log`.
- **Non-interactive by design.** M4 has no `ui.confirm`; interactive gating is the motivating
  case for M5's UI contribution point (§16). Stated in the file header so nobody "fixes" it
  into reading stdin (which would fight the REPL's readline — §17 risk 5).

### 13.2 `notes.mjs` — the API tour (~70 lines)

- `registerTool` `notes` (`get`/`set` enum arg, TypeBox-shaped plain object) persisting to
  `.imp/notes.json` under `api.cwd`;
- `registerCommand` `/notes <text>` (`allowedDuringRun: true` — it only writes the file and
  prints a `▪` line via `ctx.renderer.note`);
- `registerContext("notes", "A notes tool exists; prefer it over creating files for reminders")`;
- doubles as the fixture generator for tests (§14) and the README's copy-paste example.

---

## 14. Testing strategy (honoring the M3 lesson)

M3's recorded lesson (PROJECT_PLAN, 3a): the two P1s lived in the gap between unit tests
calling internals (`dispatchCommand` directly) and the real state machine — the fix was
**full-path tests from the entry point** (`startRepl` harness, test/repl.test.ts:46-94, drives
`handleLine` through a real `runRepl` with `makeConsole` PassThrough stdio). M4 applies it at
two levels:

1. **The extension loading path must be exercised as cli.ts exercises it.** The harness gains
   `writeExtensionFiles(cwd, files)` (test/helpers/fakes.ts): real `.mjs` files in a temp
   `<cwd>/.imp/extensions/`. `startRepl` then calls the **real** `loadExtensions` with the
   same arguments cli.ts uses, prints via the shared `printExtensionDiagnostics` helper
   (loader.ts export; cli and harness cannot drift), and passes `runtime` into `createRunner`
   + `runtime.commands` into `runRepl` — the exact cli wiring minus `parseArgs`/`process.exit`.
   Real dynamic `import()` of real files happens in every test.
2. **Command behavior is asserted through `fake.send("/notes hi\n")`, never by calling
   `dispatchCommand` with a hand-built ctx** — the M3 regression class, verbatim.

Hermetic hook tests reuse the existing seams REPORT-B catalogued (all verified):
`scriptedProvider(scripts, sink)` (fakes.ts:110) drives a scripted `toolCall` to an extension
tool and records the LLM request (assert extension tool visible to the model, blocked-content
round-trip); `gatedTool` (fakes.ts:170) + `gate()` under a `tool_call` block proves the tool
never executed; `IMP_LOG=0` via `vi.stubEnv` and `sessionBaseDir` mkdtemp keep runs hermetic,
exactly as runner tests do today.

Print-mode coverage: `createRunner` + `runTurn` **is** the print path's engine (cli.ts:239-287
is a 10-line wrapper); runner-level integration tests cover it without importing the
side-effectful `cli.ts` (same trade-off M3 made). The real CLI binary is covered by the
manual/real-GLM acceptance scripts below.

### Test case mapping (new files)

| # | Behavior | File / case |
|---|---|---|
| 1 | Discovery: direct `.mjs`, `_`-skip, `dir/index.mjs`, code-point sort determinism | extensions-loader.test.ts |
| 2 | Dedup by realpath across `-e` + dirs; origin label correctness | extensions-loader.test.ts |
| 3 | E1/E2/E3/E4 exact strings; failed extension discarded atomically (registrations gone) | extensions-loader.test.ts |
| 4 | E5-E8 reserved/invalid/taken names; remaining registrations of the same extension live | extensions-registry.test.ts |
| 5 | emit isolation: throwing `tool_end` handler → E10 line, run continues | extensions-registry.test.ts |
| 6 | `on("tool_call")` block short-circuits chain; allow chains | loop-hooks.test.ts (extended) |
| 7 | Block → model receives exact `Tool "x" blocked by an extension: <reason>` `isError` result; session JSONL has the pair | loop-hooks.test.ts |
| 8 | Handler throw → fail-safe block, E9 content | loop-hooks.test.ts |
| 9 | Full-path: extension tool called by scripted model through `startRepl` + fixture file; result persisted | extensions-repl.test.ts |
| 10 | Full-path: `/notes save hi` via `fake.send`; output asserted; command listed in `/help` with `[notes]` | extensions-repl.test.ts |
| 11 | Unknown-command error lists extension commands (generated) | extensions-repl.test.ts |
| 12 | `allowedDuringRun: false` extension command mid-run → standard rejection line | extensions-repl.test.ts |
| 13 | Context section in provider-sink `system` (exact `# Extension context:` header) | extensions-repl.test.ts |
| 14 | `message_end`/`run_end` observed with correct payloads after a scripted 2-turn run | extensions-repl.test.ts |
| 15 | `--no-extensions`: dirs skipped, `-e` honored (loader unit) | extensions-loader.test.ts |
| 16 | Broken extension beside good one: banner + E1 line, good extension fully functional, exit path unaffected (echo-pipe script — M3's scripted-pipe lesson applied) | extensions-repl.test.ts |

---

## 15. Acceptance criteria (scriptable, per sub-milestone)

All hermetic criteria are `npm test` cases (§14 mapping). Real-GLM budgets are hard caps —
each is a scripted dogfood run recorded in the PR description, in the spirit of M2/M3
acceptance (PROJECT_PLAN M2/M3 验收结果 style).

### M4a — loader + api + registerTool (est. 1-2 evenings)

- [ ] Cases 1-5, 9, 16 green; `typecheck` + `lint` clean; existing 142 tests untouched-green.
- [ ] `examples/notes.mjs` loads from a dogfood repo's `.imp/extensions/`, banner line exact.
- [ ] **GLM (≤2 calls)**: `imp -p "Use the notes tool to save 'ship it', then tell me what
      you saved"` → the model calls `notes`, answers from the tool result. Then with a broken
      `.mjs` beside it: imp completes the task; the `imp:` diagnostic is on screen. (M1 lesson:
      verify via behavior, not by the model reading files.)

### M4b — registerCommand (est. 0.5-1 evening)

- [ ] Cases 10-12 green (full-path via `fake.send`).
- [ ] `/help` shows extension commands with `[source]`; reserved-name fixture rejected E7.
- [ ] **GLM (0 required)**: commands don't touch the model; one optional REPL smoke turn
      confirms the interactive path is unchanged.

### M4c — on() hooks + registerContext + case studies (est. 1-2 evenings + 1 for polish)

- [ ] Cases 6-8, 13-15 green.
- [ ] `guardian.mjs` in the dogfood repo: **GLM (≤4 calls)** — (a) a scripted cleanup task
      that tempts `rm -rf`: the model receives the teaching block result and adapts without
      human help; (b) `imp -p "What extension context do you have?"` → answer reflects the
      injected section (M1 暗号 pattern: knowable only through injection).
- [ ] README gains an "Extensions" section (locations, `.mjs` contract, `--no-extensions`,
      security note, pointer to `examples/`).

Definition of done: zero new deps (`package.json` diff empty), no changes under
`src/provider/`, loop diff limited to `onToolCall`, and the AGENTS.md review-discipline check
performed (this design is the input to that review).

---

## 16. Deferred to M5+ — with rationale

| Deferred | Rationale |
|---|---|
| **MCP** | A client is 500+ LOC with its own lifecycle; pi ships it as an adapter package, not core. imp has zero consumers. |
| **Providers** (`registerProvider`) | The `provider` seam (runner.ts:61-62) + logging decorator cover the one-provider world; M5 multi-provider must design model registries first — registering providers before models exist builds API on sand. |
| **Subagents** | A nested `runAgentLoop` needs provider/tool injection from inside an extension — impossible via M4's api (by design: it exposes no engine). The loop is a pure function of its options (loop.ts:58), so M5 is a small `api.runSubagent(...)`-shaped addition, not a rework. Doing it now would entangle D1 (shared cwd vs worktree) and D2 (session namespace keyed by raw cwd until M5's repo-root rekey). |
| **UI contribution** (renderers, `ui.confirm`, autocomplete) | imp has no TUI; `Renderer` is a line printer. Guardian is rule-based precisely because there is no dialog API. Adding `ctx.ui` after the M5+ TUI decision follows pi's mode-agnostic pattern (types.ts:148-151) without pre-committing to a widget set. |
| **Hot reload / dispose** | Requires cache-busting import + stale-object invalidation (pi: jiti `moduleCache:false` + runtime `assertActive`). Restarting imp costs ~1s; nobody has asked for more. |
| **Packages (npm:/git:), manifests, settings** | No distribution channel exists; `-e` + two dirs covers the local user. Lands with the npm publish milestone, which also owns the trust-model revisit (§11). |
| **Dynamic/intercepting context** (message rewriting, `tool_result` middleware) | pi's `context`/`tool_result` chains are powerful and dangerous; imp's only current need (static sections) is served by `registerContext`. Message mutation stays in typed loop options, not events. |
| **Handler `ctx`, timeouts, parallel fan-out** | Tools run sequentially (loop.ts:133-139); no ctx consumer exists (§6.2). A hung extension tool is indistinguishable from a hung built-in (Ctrl+C + force-quit already handle both) — pi has no handler timeouts either. |

---

## 17. Risks & mitigations

1. **Extension code runs in-process** (a hung factory blocks startup). Same trust class as
   tool executes: OS-level Ctrl+C kills it, `-ne`/removal recovers. No sandbox is claimable
   without deps; the README security note says so plainly.
2. **Node module cache surprises in tests** — a rewritten fixture would not re-import at the
   same URL. Mitigation: fresh `mkdtemp` cwd per case (already the `startRepl` pattern).
3. **`readdirSync` order is platform-dependent** — nondeterministic order would make
   conflicts flaky. Mitigation: explicit code-point sort (§3.2), locked by test case 1.
4. **`CommandContext` exposure**: a buggy command can call `ctx.runner.runTurn` mid-run and
   fight the state machine. Mitigation: M4 contract (README + JSDoc) forbids it; the
   single-controller design makes the failure loud (doubled stats lines); M5 can add a
   dev-mode assertion if dogfooding shows real confusion.
5. **Extensions reading stdin directly** would corrupt the REPL's readline. Mitigation: the
   contract forbids direct terminal I/O; guardian's header comment states why; M5's `ctx.ui`
   is the sanctioned path.
6. **Blocked-tool prompt debt**: a wrong-headed gate can make the model flail (block, retry,
   block). Mitigation: teaching-style reasons are the contract (§12, §13.1) — the model gets
   an actionable alternative, mirroring how invalid-args errors steer it today
   (loop.ts:255-263). Watch in the M4c GLM acceptance; iterate guardian reasons, not core.
7. **Scope creep via "just one more event"** — every pi event looks useful in isolation.
   Mitigation: the four-event set is normative here; additions require a named consumer (M5+).
8. **`.js` CommonJS confusion** is the likeliest first-hour user failure even with E2.
   Mitigation: every example is `.mjs`; the README lead sentence says `.mjs`.

---

## 18. Implementation scope checklist (M4 total)

1. `src/extensions/types.ts` — factory/api/event/registry types (§5, §6).
2. `src/extensions/registry.ts` — per-extension sections, validation (name regex, smoke
   schema check), conflict policy (§9), isolated emits with fast-path no-op (§7.2).
3. `src/extensions/loader.ts` — discovery (§3), realpath dedup, `import()` + factory with
   atomic discard (§7.1), diagnostics E1-E8 (§12), `printExtensionDiagnostics` shared helper.
4. `src/core/loop.ts` — `onToolCall` option + block branch in `executeToolCall` (§8.3).
5. `src/runner.ts` — `RunnerOptions.extensions`, tool merge (§8.1), system append (§8.3),
   emit wiring in `runTurnInner` (§8.3).
6. `src/repl/commands.ts` — `dispatchCommand` third param, `/help` + unknown-command merged
   listing (§8.2).
7. `src/repl/repl.ts` — `ReplOptions.commands`, pass-through at the dispatch site (§8.2).
8. `src/cli.ts` — `-e`/`--extension` (repeatable), `-ne`/`--no-extensions`, HELP lines,
   load + diagnostics + plumbing (§10).
9. `examples/extensions/{notes,guardian}.mjs` (§13).
10. Tests: `test/extensions-{loader,registry,repl}.test.ts`, `test/helpers/fakes.ts` addition
    (§14); existing suites untouched.
11. README "Extensions" section.

Estimated core diff: ~530 lines across items 1-8 (REPORT-B's "~300 LOC" was optimistic once
diagnostics, conflict policy, and shared helpers are counted), plus ~140 example + ~450 test lines.

---

## Appendix A — pi vs imp divergence table

| Dimension | pi | imp M4 | Why |
|---|---|---|---|
| Module loading | jiti, TS allowed, host-module aliases (loader.ts:411-416) | plain `await import()`, `.mjs` only | Extensions get everything via `api`; nothing to alias; zero deps |
| Events | ~26-event union (types.ts:1028-1054) | 4 events | Each imp event has a named consumer; the rest have none |
| Event results | block/rewrite/replace for many events (types.ts:1058-1110) | block only (`tool_call`) | No rewriter use case; message mutation stays in typed loop options |
| Trust | `trust.json`, nearest ancestor, `project_trust` event, first-answer-wins | none; visibility + `-ne` + documented trigger | §11 (posture consistency, no distribution surface, guardian is the real gate) |
| Name conflicts | override built-ins; suffix duplicates `:1`/`:2` | built-ins reserved; first-wins + teaching rejection | §9 (silent shadowing footgun; suffixes untypeable) |
| Factory failure | whole extension dead (throw) | same (atomic discard) | parity |
| Registration failure | throw → extension dead | skip + diagnostic, extension alive | errors-as-data; one bad registration ≠ one dead extension |
| `tool_call` handler error | fail-safe block (emergent via agent-loop catch) | fail-safe block (explicit contract) | §7.2 — same outcome, written down |
| Ordering | package-manager precedence ranks (package-manager.ts:178-187) | `-e` → project → global, realpath dedup | No package manager to rank |
| Reload | `/reload`, stale-context errors | restart | No reload machinery; ~1s startup |
| Context injection | `resources_discover` (skills/prompts/themes paths) + `promptSnippet` | `registerContext(id, text)` static sections | imp has no resource-type registry; sections are the 90% case |
| Session lifecycle | `session_shutdown(quit\|reload\|new\|resume\|fork)` (types.ts:609-616) | none | No session tree/reload in imp M4 |
| UI reach | mode-agnostic `ctx.ui`, per-mode impls (types.ts:148-151) | none | imp has one line-printing Renderer; TUI is an M5+ decision |

## Appendix B — citation spot-check notes

All file:line seams in REPORT-B verified against `main` (loop.ts hooks 31-37, tool execution
133-139, `executeToolCall` 228+, `Value.Check` 255; runner.ts 61-64, 109-110, 134-142,
184-196, 224-260; commands.ts 4-10/14-21/38-48/54/123-150; repl.ts dispatch 164; fakes.ts
23/110/138/161/170; repl.test.ts 46-94; manager.ts 13-27). One drift: REPORT-B's loop.ts:39-47
is the options-interface region — `runAgentLoop` itself is at loop.ts:58. Immaterial.

From REPORT-A, verified against the pi checkout: ExtensionEvent union + `ToolCallEventResult`
(types.ts:1028-1063), ExtensionAPI surface (types.ts:1225-1310+), ExtensionContext family
(types.ts:330-395), jiti/aliases (loader.ts:47-72, 411-416), per-extension load isolation
(loader.ts:454-530), emit try/catch isolation (runner.ts:930-1000), discovery rules
(loader.ts:568-610), trust gating list (trust-manager.ts:22-30 — note: the file lives at
`core/trust-manager.ts`, not `core/extensions/`), docs locations table (docs/extensions.md
~113-150), agent-loop block enforcement (agent-loop.ts:619-660), wrapper `addedToolNames`
(wrapper.ts:16-38), `mergePaths` CLI-first ordering (resource-loader.ts:497-502). Two
corrections: `SessionShutdownEvent` is at types.ts:609-616 (not 795-801); REPORT-A's
"tool_call handler error → tool blocked" is real but **emergent** — `emitToolCall` itself has
no try/catch; the block comes from agent-loop's surrounding catch. imp makes it an explicit
contract (§7.2).
