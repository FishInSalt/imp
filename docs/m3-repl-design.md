# M3-3a — Interactive REPL (readline) — Design

Branch `m3-repl`. Stage 3a per PROJECT_PLAN.md. This document is the implementation
contract: module layout, signatures, state machines, exact output formats, and the test
plan. Stage 3b (real TUI) is explicitly out of scope and listed at the end.

Reference: pi's interactive mode was studied in `../pi-interactive-mode-report.md`.
Where imp deliberately diverges from pi, the divergence is called out and justified.

---

## 1. Goals

- `imp` with no `-p` starts an interactive REPL built on `node:readline` (NOT a TUI).
  `-p`/positional prompt keeps today's print mode, byte-for-byte.
- Multi-turn conversation over one shared `history` array; persistence through the
  existing session manager (`onMessage → session.appendMessage`); auto-compaction
  stays wired exactly as in print mode.
- Streaming assistant output. Tool calls render as **one line**: name + argument
  summary + result status. The existing `▪` status lines are reused verbatim.
- Slash commands: `/help` `/exit` `/new` `/model` `/compact`. Unknown commands get a
  teaching-style error (project convention), never sent to the model.
- Ctrl+C during a run aborts the current turn and returns to the prompt; no
  `tool_use` is ever orphaned in persisted history (loop.ts already guarantees this —
  we rely on it, we do not re-implement it).
- Steering: lines typed while a run is active are queued and injected at turn
  boundaries through the existing `getSteeringMessages` hook; queued and injected
  lines are displayed.
- Print mode and REPL share one runner extracted from `cli.ts`.

### Headline constraints

- **Zero changes to `src/core/` and `src/provider/`.** Every hook the REPL needs
  already exists (`onMessage`, `onBeforeTurn`, `getSteeringMessages`, `signal`) and
  every abort path already synthesizes tool results (loop.ts:115–145).
- **Zero new dependencies.** `node:readline` is builtin.
- TypeScript NodeNext — all relative imports end in `.js`. Biome: tabs, double
  quotes, lineWidth 110, no `any`. typebox v1 only if a schema is needed (none is —
  slash commands are plain string parsing; no new tools are introduced). vitest only.

---

## 2. Mode dispatch and non-TTY policy

### 2.1 Decision function

`cli.ts` currently exits 1 with HELP when no prompt is given. New behavior:

```ts
// src/runner.ts
export type RunMode = "print" | "repl";

/** promptDefined = a -p/positional prompt was given. */
export function resolveRunMode(args: { promptDefined: boolean; stdinIsTty: boolean }): RunMode;
```

| Invocation | Mode | Notes |
|---|---|---|
| `imp -p "..."`, `imp "..."` | print | unchanged code path |
| `imp` (no prompt), stdin is TTY | **interactive REPL** | prompts, ANSI, live tool lines |
| `imp` (no prompt), stdin is a pipe/file | **scripted REPL** | same engine, no prompts, no ANSI, no live redraw |
| `imp` (no prompt), stdin already at EOF with **zero** lines read | HELP + `exit 1` | preserves today's "forgot `-p`" guard; detected as `close` before any `line` event (test #38) |
| `imp sessions`, `-h`, `-v` | as today | handled before mode dispatch |

`-c`/`-r`/`-nc`/`-m`/`--max-*`/`--no-session` all apply before the REPL starts and
work identically in both modes (banner lines print as today).

**Divergence from pi:** pi demotes interactive→print when stdin is not a TTY because
its interactive mode requires a TUI. imp's readline REPL degrades naturally, so piped
input becomes a feature: `echo "fix the typo in foo.ts" | imp` runs one turn and
exits at EOF; a heredoc feeds several turns. `interactive` is defined as
`stdin.isTTY && stdout.isTTY` — with a pipe it is false, which suppresses prompt
strings, queued-line display, and the pending-tool-line redraw, while keeping ANSI
gating on `stdout.isTTY` separately (piped stdout never gets ANSI regardless).

### 2.2 HELP text change (in scope)

One usage line added near the top of `HELP`:

```
  imp                     Start an interactive session (REPL)
```

Nothing else in HELP changes.

---

## 3. Module layout

```
src/
  cli.ts            entry: parseArgs, sessions subcommand, mode dispatch, print path (~200 lines, down from 388)
  format.ts         shared output helpers: dim, red, firstLine, summarizeArgs, formatTokens (~60)
  runner.ts         createRunner(): shared env + runTurn + compactNow + stats printers; resolveRunMode (~230)
  repl/
    repl.ts         runRepl(): state machine, steering queue, interrupt routing, exit paths (~260)
    input.ts        ReplInput: readline wrapper (prompts, line routing, SIGINT/EOF, history) (~140)
    commands.ts     slash-command table, parser, help text (~200)
    render.ts       Renderer: newline-state tracking + event→line mapping, both tool styles (~180)
```

### 3.1 Why `src/repl/` and not `src/core/repl.ts`

1. **Layering.** `src/core/` today has zero UI dependencies: loop, messages,
   compaction, tools, sessions are all testable with fake providers and temp dirs —
   that is what keeps the agent core embeddable (PROJECT_PLAN L2 vs L4). A REPL is
   pure L4: it imports `node:readline`, mutates terminal state, and writes ANSI. A
   `core/repl.ts` would be the only core file importing node:readline and would
   permanently blur that boundary.
2. **Size and test seams.** The REPL is ~800 lines across four concerns. As one file
   it would be the largest in the repo with four unrelated test surfaces. As four
   files, each has a focused unit-test seam (input routing, command table, rendering,
   orchestration) and each stays under ~260 lines.
3. **Precedent.** Multi-file subsystems already live in directories
   (`core/tools/`, `core/session/`). The difference — `repl/` sits at `src/` level,
   next to `cli.ts`, not under `core/` — is the layering statement itself.

### 3.2 Why not `src/cli/` (directory)

`bin/imp.js` imports `../dist/cli.js` and `package.json`/tsc wiring expects
`src/cli.ts` as the entry. Converting `cli.ts` into a `cli/` directory would churn
bin, tsconfig roots, and docs for zero functional gain. The REPL is not "more CLI";
it is a peer interaction mode. `src/repl/` + a slimmer `cli.ts` dispatcher is the
smaller diff.

### 3.3 Import graph (all edges `.js`-suffixed, no cycles)

```
cli.ts ──► runner.ts ──► core/{loop,compaction,session/*,system-prompt,context-files,logger}.js
  │              │
  │              ├──► provider/{anthropic,logging,types}.js
  │              └──► format.ts, repl/render.ts (Renderer)
  ├──► repl/repl.ts ──► repl/{input,commands,render}.ts, runner.ts, format.ts
  └──► format.ts (sessions listing)
```

`cli.ts` remains the only side-effectful module (top-level `await main()`); that is
also why `resolveRunMode` lives in `runner.ts` — importing `cli.ts` from a test would
execute `main()`, so anything testable must live elsewhere. `runner.ts`, `format.ts`,
and `repl/*` are import-safe (no top-level side effects).

---

## 4. Shared runner extraction (`src/runner.ts`)

### 4.1 What moves out of `cli.ts`

| Block (current cli.ts lines) | Destination |
|---|---|
| `isTty/dim/red/firstLine/summarizeArgs/formatTokens` (141–199) | `format.ts` (CLI keeps only what it still uses) |
| provider/logger/tools/session setup incl. `▪ resumed` / `▪ no previous session` banners (236–281) | `createRunner` |
| system prompt assembly + `▪ context:` banner (283–291) | `createRunner` |
| `onMessage` persistence + `onBeforeTurn` auto-compaction hook (316–343) | `Runner.runTurn` |
| run stats + session stats lines (360–376) | `Runner.printRunStats` / `Runner.printSessionStats` |

What **stays** in `cli.ts`: HELP, `parseArgs`, `imp sessions`, print-mode SIGINT
wrapper (abort-once / exit-130 — semantics unchanged), print-mode error handling and
exit codes, mode dispatch. The print path becomes: `createRunner` → one `runTurn` →
stats → `close`. Output is byte-identical to today (see §8.4 for the one accepted
micro-divergence).

### 4.2 Signatures

```ts
// src/format.ts
export function dim(text: string, ansi = process.stdout.isTTY === true): string;
export function red(text: string, ansi = process.stdout.isTTY === true): string;
export function firstLine(text: string, max?: number): string;
export function summarizeArgs(name: string, args: unknown): string;
export function formatTokens(n: number): string;
```

```ts
// src/runner.ts
import type { AgentEvent } from "./core/loop.js";
import type { RunAgentLoopResult } from "./core/loop.js";
import type { AgentMessage } from "./core/messages.js";
import type { SessionStore } from "./core/session/store.js";
import type { Renderer } from "./repl/render.js";

export interface RunnerOptions {
	cwd: string;
	argv: string[];              // for the run logger
	model: string;
	maxTokens: number;
	maxTurns: number;
	noContextFiles: boolean;
	noSession: boolean;
	resume?: string;
	continueRecent?: boolean;
	sessionBaseDir?: string;     // hermetic tests (passed through to session manager)
	renderer: Renderer;          // ALL status output flows through this
}

export interface RunTurnOptions {
	userMessage?: string;        // omit ⇒ continue existing history (not used by 3a UI)
	signal?: AbortSignal;
	onEvent?: (event: AgentEvent) => void;
}

export type CompactOutcome = "compacted" | "nothing-to-compact" | "no-session";

export interface Runner {
	readonly session: SessionStore | null;
	/** The live conversation array — REPL holds this across turns. Identity is stable. */
	readonly history: AgentMessage[];
	/** Per-run model. Mutable: `/model` writes it; runTurn/compaction read it at call time. */
	model: string;
	runTurn(options: RunTurnOptions): Promise<RunAgentLoopResult>;
	/** Manual compaction for /compact (same code path as the auto hook, minus the gate). */
	compactNow(signal?: AbortSignal): Promise<CompactOutcome>;
	printRunStats(result: RunAgentLoopResult): void;
	printSessionStats(): void;
	close(): void;               // logger.close()
}

export async function createRunner(options: RunnerOptions): Promise<Runner>;
```

Semantics:

- `createRunner` does everything up to (but not including) the first LLM call:
  `createRunLogger`, `createAnthropicProvider`, the fixed six-tool array, session
  `resolveSession`/`createSession` (rethrowing `SessionNotFoundError` for the caller
  to report), `history` seeding from `buildContext()`, banners via
  `renderer.note(...)`, system-prompt assembly (`buildSystemPrompt` +
  `loadContextFiles`, exactly as cli.ts:283–291). `IMP_AUTOCOMPACT` and
  `DEFAULT_COMPACTION_SETTINGS` are read once here, as today (cli.ts:307–308).
- `runTurn` calls `runAgentLoop` with the shared `history`, `onMessage:
  (m) => session?.appendMessage(m)`, and the `onBeforeTurn` auto-compaction hook
  (see §9.2). The model is captured at call entry so `/model` mid-run affects only
  subsequent turns — including the stats line, which shows the run's model.
- The provider is wrapped with `withLogging(provider, logger)` once in
  `createRunner` and reused for both the agent loop and compaction (equivalent to
  today's two identical wrappings).
- `compactNow` and the auto hook share a private `compactAndSplice(signal)`:
  `compactSession(...)` → `history.splice(0, history.length,
  ...session.buildContext().messages)` → banner lines (§8.3).
- **Signals are NOT forwarded to compaction** — deliberate, see §7.4.
- `Runner` never catches loop errors; throw-handling policy belongs to the mode
  (print: `imp:` + exit 1; REPL: `imp:` + continue).

---

## 5. REPL architecture

### 5.1 States

```
                    ┌──────────────────────────────────────────────┐
                    │                    idle                      │
                    │  readline prompt "> " shown, awaiting input  │
                    └──────┬───────────────────────────┬───────────┘
             plain line    │              /new /compact│ /exit /help /model
              (submitTurn) │                           │ (see §6 table)
                           ▼                           ▼
                    ┌──────────────┐            ┌──────────────┐
     Ctrl+C 1st:    │   running    │            │  compacting  │
     abort(); 2nd:  │ runAgentLoop │            │ compactNow() │
     force exit 130 │ in flight    │            │ await        │
                    └──────┬───────┘            └──────┬───────┘
        settle (completed/ │                           │
        aborted/max_iters) │        settle             │
              ┌────────────┘                           │
              │  leftover steering? → auto-submit      │
              └────────────────────────► idle ◄────────┘

  Any state: Ctrl+C twice in a row (no intervening accepted line or settled run)
  → exit 130 — at idle a graceful exit (with resume line); while active a force
  exit via exit(). EOF (Ctrl+D / pipe end) in idle → graceful exit 0.
```

A single mutable field in `repl.ts`:

```ts
type ReplState = "idle" | "running" | "compacting" | "exited";
```

`compacting` exists only so Ctrl+C during a manual `/compact` does not abort a
half-finished checkpoint (§7.4) and so `/new`/`/compact` can refuse politely while
one is in flight.

### 5.2 Transition table

| State | Event | Action | Next |
|---|---|---|---|
| idle | line (non-empty, not `/`) | `submitTurn(line)` | running |
| idle | line starting with `/` | command dispatch | idle (or exit/compact) |
| idle | empty/whitespace line | refresh prompt | idle |
| idle | Ctrl+C, buffer non-empty | clear buffer, redraw | idle |
| idle | Ctrl+C, buffer empty (1st) | hint line `(press Ctrl+C again to quit — /exit or Ctrl+D also work)` | idle |
| idle | Ctrl+C, buffer empty (2nd) | graceful exit 130 + resume line | exited |
| idle | EOF | graceful exit 0 + resume line | exited |
| running | line (non-empty, not `/`) | push steering queue, `▪ queued:` | running |
| running | line starting with `/` | dispatch with mid-run policy (§6) | running |
| running | Ctrl+C (1st) | `controller.abort()` + `(interrupt — press Ctrl+C again to force quit)` | running |
| running | Ctrl+C (2nd) | force exit 130 | exited |
| running | run settles | stats lines; discard steering **only if aborted**; else flush leftover queue (§5.4); EOF pending? exit : prompt | idle |
| compacting | Ctrl+C (1st) | `(compacting — press Ctrl+C again to force quit)` | compacting |
| compacting | Ctrl+C (2nd) | force exit 130 (nothing appended yet — append-only file stays valid) | exited |
| compacting | settles | banners; flush queue as in running | idle |

The "double Ctrl+C" counter resets whenever a line is accepted or a run/compaction
settles. Consequence (accepted): abort→settle→Ctrl+C again is treated as the *idle*
first press, not a force quit. Safer default; one extra keypress to actually die.

### 5.3 Input layer (`src/repl/input.ts`)

readline wrapper; the only module that touches `node:readline`.

```ts
import type { Readable } from "node:stream";

export interface ReplOutput {
	write(text: string): void;
	isTTY?: boolean;
	columns?: number;
}

export interface ReplInputOptions {
	input: Readable;                 // default process.stdin
	output: ReplOutput;              // default process.stdout
	interactive: boolean;            // stdin && stdout are TTYs
	onLine(line: string): void;
	onInterrupt(): void;
	onEof(): void;
}

export class ReplInput {
	constructor(options: ReplInputOptions);
	start(): void;                   // createInterface + initial prompt
	setActive(active: boolean): void // prompt becomes "+ " while a run is active
	refresh(): void;                 // rl.prompt(true)
	clearPending(): void;            // wipe typed-but-unsubmitted text (rl.line = "", redraw)
	close(): void;                   // remove listeners, rl.close()
}
```

Details:

- `createInterface({ input, output, terminal: interactive, prompt: "> " })`. With
  `interactive === false` we never call `rl.prompt()`, so piped output stays clean.
- **One persistent `rl.on("line")` handler routes by state** (§5.1) — there is no
  `await nextLine()` polling; the REPL is event-driven and `runRepl()` resolves a
  promise when the loop exits. This avoids two competing consumers of `line` events
  (a classic readline bug class).
- Prompts: `"> "` when idle, `"+ "` while a run/compaction is active (`setActive`) —
  the `+` is the visible affordance that typed lines become steering. After each
  `▪ queued:` line, `refresh()` re-displays `+ ` so the user can keep typing.
- **Ctrl+C plumbing (both paths feed one `onInterrupt`):** with `terminal: true`
  readline captures `\x03` and emits `SIGINT` on the interface — we listen there. A
  process-level `process.on("SIGINT")` is also installed for the non-TTY/`kill -INT`
  case and removed on close. Both are idempotent through the state machine.
- EOF: readline `close` event → `onEof()`. If lines are still buffered they are
  delivered first (readline guarantees this).
- History (interactive only): skip empty lines, skip consecutive duplicates, cap at
  100 by trimming `rl.history`. No disk persistence (3b).

### 5.4 Steering lifecycle

The queue is a plain `string[]` in `repl.ts`, drained exactly like the proven
pattern in `test/loop-hooks.test.ts`:

```ts
getSteeringMessages: () => {
	const [next, ...rest] = queue;
	queue = rest;
	if (next === undefined) return [];
	renderer.note(`▪ steering: ${shorten(next)}`);   // displayed at injection time
	return [{ role: "user", content: next }];
}
```

- **Queued** (input layer, immediately): `▪ queued: <text>` — the user's receipt.
- **Injected** (from the hook, when the loop actually polls it — every turn boundary
  including run start, loop.ts:88–92): `▪ steering: <text>`. Both lines are dim;
  `shorten` truncates to 80 chars with `…`.
- **Leftover after a completed run**: lines that arrived after the final poll are
  not lost. After stats print, if the queue is non-empty the REPL auto-submits the
  first line: `▪ continuing with queued: <text>` → `submitTurn(line)`, repeating
  while the queue drains. (Matches pi's "follow-up when the agent would otherwise
  stop" semantics without new loop machinery.)
- **On abort**: the queue is discarded with `▪ discarded N queued line(s)` — the
  user pressed Ctrl+C to take control; auto-running queued text against their
  intent would be wrong. (pi restores queued text to the editor; restoring into a
  readline buffer is fiddly — 3b.)
- Empty lines are never queued.

### 5.5 Entry point and exit codes

```ts
// src/repl/repl.ts
export interface ReplOptions {
	runner: Runner;
	input?: Readable;               // default process.stdin
	output?: ReplOutput;            // default process.stdout
	interactive?: boolean;          // default: stdin && stdout TTY
	exit?: (code: number) => never; // default process.exit; injected in tests
}

/** Resolves with the exit code on graceful exit; force-exit goes through `exit`. */
export async function runRepl(options: ReplOptions): Promise<number>;
```

| Exit path | Code |
|---|---|
| `/exit`, Ctrl+D, pipe EOF after ≥1 line | 0 |
| Ctrl+C twice at empty prompt (graceful) | 130 |
| Ctrl+C twice during run/compaction (force) | 130 via `exit()` |
| zero-line piped stdin | HELP + 1 |
| startup error thrown out of `createRunner` | 1 (handled in cli.ts as today) |
| per-turn errors (provider/protocol) | none — REPL prints `imp: <msg>` and continues |

Force exit cannot `await` the run promise (a hung tool would trap the user), so the
double-Ctrl+C path calls `exit(130)` directly; the injected test `exit` records the
code and throws a private sentinel that unwinds the loop. Graceful exits resolve
`runRepl`'s promise; `cli.ts` does `process.exit(code)`.

Startup banner (interactive only, after the runner's own `▪` banners):

```
imp 0.1.0 — /help for commands · Ctrl+D exits
▪ session <id8> · model <model>
```

Scripted mode prints only the runner banners (resumed/context), keeping piped output
machine-clean. `--no-session` omits the session banner line.

---

## 6. Slash commands (`src/repl/commands.ts`)

```ts
export interface CommandContext {
	runner: Runner;
	renderer: Renderer;
	isActive: () => boolean;              // running || compacting
	requestExit(code: number): void;      // graceful path
	abortActive(): boolean;               // abort controller if active
}

export type CommandOutcome = "handled" | "exit-requested";

export interface SlashCommand {
	readonly name: string;
	readonly summary: string;             // one line, shown by /help
	readonly allowedDuringRun: boolean;
	run(args: string, ctx: CommandContext): CommandOutcome | Promise<CommandOutcome>;
}

export const COMMANDS: readonly SlashCommand[];   // /help /exit /new /model /compact

/** "/model glm-4.6 extra" → { name: "model", args: "glm-4.6 extra" }; non-slash → null. */
export function parseCommand(line: string): { name: string; args: string } | null;

export function dispatchCommand(line: string, ctx: CommandContext): Promise<CommandOutcome>;
```

### 6.1 Semantics table

| Command | Args | Idle | During run | Effect |
|---|---|---|---|---|
| `/help` | – | ✓ | ✓ | prints help text (§6.2) |
| `/exit` | – | ✓ | abort-then-exit | graceful exit 0 + resume line. During a run: abort, await settle, then exit |
| `/new` | – | ✓ | ✗ rejected | swap to a fresh `SessionStore`, `history.length = 0`, re-run system-prompt assembly (date is day-granular; context files may have changed), banner. Old session stays on disk |
| `/model` | none | ✓ | ✓ | prints current model + switch usage + example ids |
| `/model` | `<id>` | ✓ | ✓ | sets `runner.model`; affects the **next** `runTurn` and its compaction; in-flight run keeps its captured model |
| `/compact` | – | ✓ | ✗ rejected | `runner.compactNow()`; prints the standard compaction banners. Works even with `IMP_AUTOCOMPACT=0` (the env gates the *auto* hook only) |
| unknown `/x` | – | ✗ error | ✗ error | teaching-style error (§6.2); **never** sent to the model |
| bare `/` | – | ✗ error | ✗ error | same teaching error with name `""` |

Mid-run `/new` and `/compact` are rejected because both rewrite the shared history
or session that the in-flight loop is mutating — race by construction. `/help`,
`/model`, and `/exit` are safe mid-run (read-only, next-run config, or sequenced
abort-then-exit).

### 6.2 Exact output text

All `▪` lines dim; `imp:` lines red on stdout (REPL keeps the conversation stream on
one stream; stderr stays reserved for startup errors, as in print mode).

```
/help →
Commands:
  /help              show this help
  /exit              exit (Ctrl+D works too)
  /new               start a fresh session (the old one stays on disk)
  /model [id]        show the current model, or switch (applies next turn)
  /compact           summarize older context now

Keys:
  Ctrl+C             abort the running turn (press twice to force quit);
                     at an empty prompt: press twice to exit
  Ctrl+D             exit

Lines typed while imp is working are queued and injected when the current turn ends.

/exit (with session) →
▪ session 3f2a1b9c saved — resume with: imp -r 3f2a1b9c
/exit (--no-session) →
▪ bye

/new →
▪ new session 4d7e2f0a — previous 3f2a1b9c saved (imp -r 3f2a1b9c)
/new (--no-session) →
▪ new conversation (sessions disabled)
/new while active →
imp: /new waits for the running turn — press Ctrl+C to abort it first, then /new

/model (no args) →
model: claude-sonnet-4-5
switch with: /model <id> — e.g. claude-sonnet-4-5, glm-4.6 (any id your endpoint accepts)
/model glm-4.6 →
▪ model: claude-sonnet-4-5 → glm-4.6 (applies from the next turn)

/compact →
▪ compacting…
▪ compacted: ~118.2k → ~21.4k tokens (14 msgs kept verbatim)      (success)
▪ nothing safe to compact yet — continuing                        (cut <= 0)
/compact while active →
imp: /compact waits for the running turn — press Ctrl+C to abort it first, then /compact
/compact with --no-session →
imp: /compact needs a session — restart without --no-session

unknown command →
imp: unknown command "/foo"
known: /help /exit /new /model /compact — /help shows what they do
```

The known-command list in the error line is generated from `COMMANDS` so it cannot
drift. **Divergence from pi:** pi sends unknown `/x` to the LLM; imp teaches instead
(project convention — errors tell you how to fix them). Escape hatch for sending a
literal leading slash to the model: prefix the line with a space (` /foo`) —
`parseCommand` tests `line[0] === "/"`, so a leading space makes it plain text
(whitespace is preserved in the sent message).

---

## 7. Interrupt design

### 7.1 One AbortController per active phase

`repl.ts` creates a controller when entering `running`/`compacting` and drops it on
settle. `runTurn` passes `controller.signal` to `runAgentLoop`, which threads it to
the provider stream and every `tool.execute`, and checks it at loop top and before
each tool (loop.ts:84, 131).

### 7.2 Abort never orphans `tool_use` — loop guarantee, relied upon

loop.ts already handles every interrupt path:

- abort before a tool runs → `fillMissingToolResults(..., "(interrupted before this
  tool ran)")` (loop.ts:140–145),
- max turns → `"(not executed: reached max turns)"` (loop.ts:115–127),
- mid-stream abort → provider returns without `message_end` → `streamAssistant`
  returns `null` → `stopReason: "aborted"` (loop.ts:99).

Because every synthesized result flows through `onMessage` → `appendMessage`, the
persisted JSONL always contains complete tool_use→tool_result pairs and the session
stays resumable. The REPL adds nothing here; tests only *verify* it (test #35).

### 7.3 After an abort

`runTurn` resolves with `stopReason: "aborted"`; REPL prints `(aborted)` + stats
(turns/usage accumulated so far), discards the steering queue, returns to `> `.
No retry, no re-prompt echo — the user is back in control.

### 7.4 Ctrl+C during compaction — signals are NOT forwarded (deliberate)

`compactSession` accepts `signal`, but forwarding an abort there is actively
harmful today: on mid-stream abort the accumulated partial `summary` text is
**non-empty**, so `compactSession` would persist a truncated checkpoint
(compaction.ts:277–283 appends whatever text arrived); aborting before any text
throws `Error("compaction: summarizer returned an empty summary")` — misleading,
and the run would report it as a failure. Therefore:

- **Auto-compaction (inside a run):** unchanged from print mode — no signal passed.
  Ctrl+C during it aborts the *surrounding turn*: the checkpoint finishes and is
  appended atomically, then the loop's next signal check ends the run as `aborted`
  (the provider fetch never fires — anthropic.ts returns immediately on an aborted
  signal). Finishing the checkpoint is the safer outcome; it is small and
  self-contained.
- **Manual `/compact`:** runs in `compacting` state with no controller; first Ctrl+C
  prints the hint, second force-exits 130 before `appendCompaction` runs (the
  append-only file is never corrupted mid-append; worst case is wasted summarizer
  tokens).

Revisit in 3b+ only if compactions grow long enough for this to matter.

---

## 8. Rendering (`src/repl/render.ts`)

> **Revision (2026-09-04):** Renderer later moved to `src/render.ts` —
> presentation is shared by print mode and REPL, not REPL-specific (first M5
> dogfood finding). This section's design otherwise stands; only the path
> changed.

### 8.1 Newline-state model

Streaming text does not end at a line boundary, and `▪`/stats lines must never start
mid-line. The Renderer owns ALL conversation output and tracks one bit:

```ts
export type ToolStyle = "two-line" | "one-line";

export interface RendererOptions {
	write: (text: string) => void;   // default: process.stdout.write bound
	ansi: boolean;                   // default: stdout.isTTY
	liveTools: boolean;              // in-place pending line; interactive only
	toolStyle: ToolStyle;            // "two-line" reproduces print mode exactly
	clock?: () => number;            // default Date.now; injectable for tests
}

export class Renderer {
	constructor(options: RendererOptions);
	event(event: AgentEvent): void;   // streaming + tool lines
	note(text: string): void;         // ensureNewline + dim(text) + "\n"   (▪ lines)
	error(text: string): void;        // ensureNewline + red(text) + "\n"
	writeLine(text: string): void;    // ensureNewline + text + "\n"
	raw(text: string): void;          // streaming text; updates newline state
	ensureNewline(): void;
	endRun(always?: boolean): void;   // print mode passes always=true (today's unconditional "\n")
}
```

State: `needsNewline: boolean` (true ⇒ cursor is not at column 0) and
`pendingTool: { id: string; text: string; startedAt: number } | null`.

- `text_delta` → `raw(text)`; `needsNewline = !text.endsWith("\n")`.
- `tool_start` → `ensureNewline()`; build `text = "● " + name + " " +
  summarizeArgs(name, args)`. If `liveTools`: write `"\r\x1b[2K" + dim(text + " …")`
  **without newline** and stash `pendingTool`. (Safe: `tool_start` is always followed
  by its `tool_end` before any other event type can arrive — tools run sequentially
  and text precedes tool calls within a message.)
- `tool_end` → `liveTools` ⇒ `"\r\x1b[2K"`; take `text` from `pendingTool` (fallback
  `"● " + result.toolName`). Then one line (see §8.2), `"\n"`, `needsNewline=false`.
- `tool_call_start` / `tool_call_delta` / `message_end` → ignored (deltas are
  already streamed; the assembled message is not re-printed — same folding as
  today's renderEvent).
- `note`/`error`/`writeLine` → `ensureNewline()` first. This is what keeps `▪`
  banners correct when they fire mid-stream (compaction) — and it replaces print
  mode's hand-written leading `"\n"` on the compaction banner.

### 8.2 Exact tool-line formats

`one-line` (REPL):

```
pending (interactive only):   ● bash $ npm test …                ← rewritten in place
success:                      ● bash $ npm test ✓ 12.4s          ← duration only when ≥ 1s
error:                        ● bash $ npm test ✗ npm ERR! missing script: tast
```

- pending: dim, ends with ` …`, no newline, `\r\x1b[2K` prefix.
- success: dim(`● {name} {args} ✓`) + (` {d}s`, one decimal, iff `d ≥ 1`) + `\n`.
- error: dim(`● {name} {args} ✗ `) + red(`firstLine(result.content, 120)`) + `\n`.
- `{args}` = `summarizeArgs(name, args)` — bash renders `$ {command}`, others
  JSON truncated to 120 chars (moved verbatim from cli.ts).
- non-interactive (`liveTools=false`): the pending phase is skipped entirely; only
  the final line is printed, and never with `\r`.

`two-line` (print mode, unchanged): `● {name} {args}` at `tool_start`, then
`  → {firstLine(content,160)}` or `  ✗ {…}` in red at `tool_end` — byte-identical
to today's renderEvent.

### 8.3 Status line formats (both modes, via `note`)

Reused verbatim from print mode:

```
▪ resumed <id8> · <n> msgs · ~<t> tokens[ (compacted)]
▪ no previous session, starting fresh
▪ context: <relative files>
▪ context ~<t> tokens — compacting…
▪ compacted: ~<a> → ~<b> tokens (<n> msgs kept verbatim)
▪ nothing safe to compact yet — continuing
— <model> · <n> turns · in <i> / out <o> tokens[ · cache↓<c>]      (run stats)
— session <id8> · <n> msgs total · in <i> / out <o> cumulative     (session stats)
(aborted)                                                          (dim)
(stopped: reached max turns (<n>))                                 (red)
```

REPL-only additions (all dim):

```
▪ queued: <≤80 chars, … if truncated>
▪ steering: <≤80 chars>
▪ continuing with queued: <≤80 chars>
▪ discarded <n> queued line(s)
▪ new session <id8> — previous <old8> saved (imp -r <old8>)
▪ model: <old> → <new> (applies from the next turn)
▪ compacting…                     (manual /compact only; auto uses the ~tokens variant)
(interrupt — press Ctrl+C again to force quit)
(press Ctrl+C again to quit — /exit or Ctrl+D also work)
(compacting — press Ctrl+C again to force quit)
```

The three Ctrl+C hint strings above are normative; the REPL tests assert them
literally (case #32).

### 8.4 Print-mode output: byte-identical, one accepted micro-divergence

Both modes construct a `Renderer`; print mode uses
`{ toolStyle: "two-line", liveTools: false, ansi: stdout.isTTY }`. Every status line
keeps its today-form because `ensureNewline()` reproduces exactly the places where
cli.ts currently hand-writes a leading `"\n"` (only the mid-stream compaction
banner). **Accepted divergence:** if auto-compaction fires on the very first turn
before any output, today prints a leading blank line (`"\n▪ context …"`); the
Renderer correctly starts at column 0 and omits it. One blank line, strictly an
improvement, asserted in tests.

---

## 9. Session & compaction lifecycle

### 9.1 Multi-turn and persistence

The REPL holds `runner.history` (one array identity for the whole process). Each
turn is one `runAgentLoop` call with `userMessage: line` — including
steering-flush continues, which go through the same `submitTurn`. (`userMessage`
omitted is only the resume-continue-at-startup case, handled inside the loop by
seeding from the session.) Persistence rides the
existing `onMessage → appendMessage` hook; `appendFileSync` is immediate and
crash-safe, unchanged. Compaction splices the same array in place — identity never
changes, so the REPL never re-binds anything.

### 9.2 Auto-compaction (unchanged wiring)

Inside `runTurn`'s `onBeforeTurn`, byte-for-byte the logic of cli.ts:317–343: gate on
`IMP_AUTOCOMPACT !== "0"` → `estimateContextTokens` → `shouldCompact` → banner →
`compactSession` → splice from `session.buildContext()` → banner. Null result prints
`▪ nothing safe to compact yet — continuing`. Requires a session (with
`--no-session` the hook is absent entirely — same as print mode).

### 9.3 `/new`

`createSession(cwd, baseDir)` → old store simply dropped (file stays on disk,
append-only) → `history.length = 0` → system prompt re-assembled
(`buildSystemPrompt(defaultSystemPromptContext())` + context files, honoring
`-nc`) → banner. Model/maxTokens/maxTurns and the logger persist across `/new`.

### 9.4 `/compact`

`runner.compactNow()` = same `compactAndSplice` as the auto hook minus the
`shouldCompact` gate. `cut <= 0` → `"nothing-to-compact"` → the standard
`▪ nothing safe to compact yet — continuing` line (a manual compact of an already
tight context is a no-op, not an error). Empty-summary throw surfaces as
`imp: compaction: summarizer returned an empty summary` and the REPL continues.

---

## 10. Test strategy

### 10.1 Fakes (new shared helpers: `test/helpers/fakes.ts`)

- **Streams via `node:stream` `PassThrough`** — real stream semantics, no custom
  EventEmitter guesswork about readline internals:

  ```ts
  export interface FakeConsole {
	  stdin: PassThrough & { isTTY?: boolean; setRawMode?: (m: boolean) => void };
	  stdout: { chunks: string[]; isTTY?: boolean; write(s: string): void };
	  send(text: string): void;      // stdin.write(text)
	  interrupt(): void;             // send("\x03") — readline translates to SIGINT in terminal mode
	  eof(): void;                   // stdin.end()
	  output(): string;              // chunks.join("")
  }
  export function makeConsole(options?: { tty?: boolean }): FakeConsole;
  ```

  TTY mode attaches `{ isTTY: true, setRawMode(){} }` so readline enables
  `terminal: true` and `\x03`/`\x04` behave exactly as on a real terminal.
- **Providers/tools**: reuse the `scriptedProvider` / `assistant` / `user` builder
  pattern from `test/loop.test.ts` (copied into helpers, unchanged semantics); a
  gated tool (execute resolves when a test-controlled promise resolves) for
  steering/interrupt timing, mirroring `test/loop-hooks.test.ts`.
- **Hermetic runner tests**: `sessionBaseDir` → `mkdtemp` (existing session-manager
  pattern); `IMP_LOG=0` via `vi.stubEnv` so `createRunLogger` stays silent; the
  module-load-time `DEFAULT_COMPACTION_SETTINGS` needs `vi.resetModules()` +
  dynamic `import()` when testing small-window auto-compaction (existing pattern in
  `compaction.test.ts:38–45`).
- **Exit**: inject `exit` that records the code and throws a private
  `ForceExitError`; `runRepl` tests assert either the resolved code or the sentinel.

### 10.2 Behavior → test case mapping

New files: `test/runner.test.ts`, `test/repl.test.ts`, `test/repl-commands.test.ts`,
`test/repl-input.test.ts`, `test/repl-render.test.ts`, plus `test/helpers/fakes.ts`
(not matched by vitest's `test/**/*.test.ts` include). Existing suite must stay
green untouched.

| # | Behavior | File / case |
|---|---|---|
| 1 | `-p` → print; no prompt + TTY → interactive; no prompt + pipe → scripted | runner.test.ts "resolveRunMode" |
| 2 | createRunner banners on resume: `▪ resumed <id8> · n msgs · ~t tokens` (pre-seeded store, tmp baseDir) | runner.test.ts |
| 3 | `-c` with no prior session → `▪ no previous session, starting fresh` | runner.test.ts |
| 4 | `resolveSession` failure rethrows (`SessionNotFoundError`) for cli to report | runner.test.ts |
| 5 | runTurn persists every message to JSONL; history identity stable across turns | runner.test.ts |
| 6 | `runner.model = x` → next provider request carries `x`; stats line shows run-time model | runner.test.ts |
| 7 | printRunStats/printSessionStats exact strings (incl. cache↓ only when truthy) | runner.test.ts |
| 8 | auto-compaction inside runTurn (stubbed tiny window, resetModules): banners + splice | runner.test.ts |
| 9 | `--no-session`: no onBeforeTurn hook; `compactNow` → `"no-session"` | runner.test.ts |
| 10 | line routing: idle → onLine; during run → onLine too (same handler, state decides) | repl-input.test.ts |
| 11 | prompt switches `"> "` ↔ `"+ "`; refresh after queue; non-interactive writes no prompt bytes | repl-input.test.ts |
| 12 | `send("\x03")` → onInterrupt; `send("\x04")`/`eof()` → onEof after buffered lines | repl-input.test.ts |
| 13 | history: dup-consecutive dropped, cap 100, empties skipped | repl-input.test.ts |
| 14 | text deltas concatenated in order; tool line forced onto fresh line after partial text | repl-render.test.ts |
| 15 | one-line tool formats exact: pending (`\r\x1b[2K…`), `✓`, `✓ 12.4s` (injected clock), `✗ msg` (red, 120-char cut) | repl-render.test.ts |
| 16 | two-line style byte-identical to legacy renderEvent output (golden string) | repl-render.test.ts |
| 17 | non-TTY: no `\r`, no pending line, no ANSI; note/error/writeLine newline state | repl-render.test.ts |
| 18 | note mid-stream inserts correctly (compaction-banner scenario) | repl-render.test.ts |
| 19 | parseCommand: `/model glm` / bare `/` / non-slash → null | repl-commands.test.ts |
| 20 | /help lists all five (generated, can't drift) | repl-commands.test.ts |
| 21 | /model no-arg output; /model <id> note + next-run effect | repl-commands.test.ts |
| 22 | /new: fresh store, empty history, old file intact, banner; during run rejected | repl-commands.test.ts |
| 23 | /compact: compacts (fake summarizer), `▪ compacted: ~a → ~b tokens (n msgs kept verbatim)`; history = [summary, tail]; nothing-to-compact path; during-run & no-session rejections | repl-commands.test.ts |
| 24 | unknown `/foo`: exact 2-line teaching output; provider never called | repl-commands.test.ts |
| 25 | happy path: "hi" → streamed text → stats → prompt redrawn; provider saw system+user | repl.test.ts |
| 26 | multi-turn: second request contains first exchange; same history array | repl.test.ts |
| 27 | steering: line during gated tool → `▪ queued:` … `▪ steering:`; second LLM request roles include injected user | repl.test.ts |
| 28 | leftover queue auto-continues: `▪ continuing with queued:` starts next turn | repl.test.ts |
| 29 | abort mid-tool-batch: `(aborted)`, prompt returns, session file has no orphaned tool_use (walk JSONL, pair every id) | repl.test.ts |
| 30 | abort discards queue: `▪ discarded n queued line(s)` | repl.test.ts |
| 31 | Ctrl+C during run twice → force exit 130 | repl.test.ts |
| 32 | Ctrl+C at empty prompt: hint, then graceful 130 + resume line | repl.test.ts |
| 33 | Ctrl+C with typed buffer: cleared, still alive | repl.test.ts |
| 34 | Ctrl+D → graceful 0 + resume line; `--no-session` → `▪ bye` | repl.test.ts |
| 35 | /exit during run: aborts, settles, exits 0 | repl.test.ts |
| 36 | provider throw mid-run: `imp: <msg>`, REPL survives (next input works) | repl.test.ts |
| 37 | scripted pipe: `"hi\n/exit\n"` → one turn, exit 0, output has no `> ` and no ANSI | repl.test.ts |
| 38 | zero-line pipe (`eof()` immediately) → HELP + exit 1 | repl.test.ts |
| 39 | empty line ignored: no provider call, prompt redrawn | repl.test.ts |
| 40 | auto-compaction across REPL turns (tiny window): `▪ context ~… — compacting…` appears, conversation continues | repl.test.ts |

Manual acceptance (per PROJECT_PLAN 3a): a 30-minute real coding session
(`npm run dev`), plus one real Ctrl+C mid-tool-run and one real piped run — recorded
in the PR description.

### 10.3 Quality gates

`npm run typecheck` (NodeNext `.js` imports, `noUncheckedIndexedAccess`),
`npm run lint` (Biome: tabs, double quotes, 110), `npm test` (vitest) — all green;
no `any` (Biome's `noExplicitAny` is off in this repo *by config*, but the design
uses structural types everywhere and forbids `any` in new code); no new deps.

---

## 11. Scope: implement now (3a)

Everything above, concretely:

1. `src/format.ts` — dim/red/firstLine/summarizeArgs/formatTokens extracted from cli.ts.
2. `src/repl/render.ts` — `Renderer` (newline state, one-line + two-line tool styles,
   note/error lines).
3. `src/runner.ts` — `resolveRunMode`, `createRunner`, `Runner` (session setup,
   banners, `runTurn` with persistence + auto-compaction hook, `compactNow`,
   stats printers).
4. `src/repl/input.ts` — `ReplInput` (readline wrapper, prompt modes, line/SIGINT/EOF
   routing, history).
5. `src/repl/commands.ts` — `COMMANDS`, `parseCommand`, `dispatchCommand`, help text.
6. `src/repl/repl.ts` — `runRepl` state machine (steering queue, interrupt, exits).
7. `src/cli.ts` — refactor print path onto `createRunner` (byte-identical output),
   mode dispatch, HELP usage line.
8. Tests: `test/helpers/fakes.ts` + the five test files (40 cases above).
9. README: short "Interactive mode" section (commands, Ctrl+C, steering, piped usage).

Explicit non-items: no changes to `src/core/**`, `src/provider/**`, `bin/`,
`package.json`, `tsconfig.json`, `biome.json`.

## 12. Out of scope (3b)

- Real TUI (ink vs custom, per PROJECT_PLAN): multi-line editor, `@` file completion,
  markdown rendering, collapsible tool output, status bar (cwd/model/tokens/cost),
  session tree browser (`/tree`), themes.
- Slash autocomplete via readline completer (cheap later — table already exists).
- Persistent command history on disk; cross-session history search.
- `/sessions` picker, `/resume`, `/fork`; mid-REPL session switching beyond `/new`.
- Restoring discarded steering back into the input buffer after an abort.
- Escape as interrupt key (imp 3a is Ctrl+C-only; documented divergence from pi).
- Overflow-retry compaction, compaction abort-safety rework (§7.4 stays as designed).
- Model catalog / pricing table; `/model` stays free-text.
- RPC/JSON mode, prompt templates, skills, extensions (M4+).
- Fixing the cosmetic interleaving of user echo and streamed output while steering
  (inherent to plain readline; accepted for 3a).

---

## 13. Risks & open questions

1. **readline internals for buffer clearing** — `clearPending()` sets `rl.line = ""`
   and redraws; `line` is a public property on the interface but not a documented
   API. Locked by test #33; if a Node upgrade breaks it, fall back to writing a
   teaching line instead. Low blast radius.
2. **Echo/stream interleaving while steering** — user keystrokes echo while assistant
   text streams; lines can visually tangle. Cosmetic; TUI is the real fix (3b).
3. **Abort-during-compaction semantics** (§7.4) — the checkpoint always completes.
   Deliberate, but if summarizer latency grows (bigger contexts), revisit by making
   `compactSession` abort-aware with a *clean* aborted return value rather than
   persisting partial text.
4. **Scripted-REPL surprise** — `someCmd | imp` (no `-p`) previously printed HELP and
   exited 1; now it runs the piped text as a prompt. This is the intended feature
   (and the zero-line guard keeps CI-style invocations safe), but it is a behavior
   change to document in the README and release notes.
5. **Double-Ctrl+C counter reset** — after an aborted run settles, a follow-up
   Ctrl+C is treated as idle-first-press (hint, not exit). Safer but one keypress
   slower to force-quit; if dogfooding hates it, reset only on accepted lines.
6. **`DEFAULT_COMPACTION_SETTINGS` module-load timing** — auto-compact tests need
   `vi.resetModules()` + dynamic imports; implementation must not capture settings
   at import time inside `repl/*` (only `runner.ts` reads them, once per
   `createRunner`, same as today's cli.ts).
