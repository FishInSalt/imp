# M5 Design: Subagents for imp

## 1. Problem, goals, non-goals

**Problem.** One context window doing everything: exploration bloats the transcript; independent
subtasks run serially. M4 recorded a minimal delegation scope; M5 delivers it.

**Goals** (the M4-recorded scope): a `task` tool where the parent describes a job, a **child agent
with fresh context** runs it to completion, and the child's **final assistant message** becomes the
parent's tool result; a **small concurrency cap** so several `task` calls in one turn overlap;
**shared cwd** by default, same trust model as the parent's tools.

**Non-goals** (each deferred deliberately): worktree isolation (M4 said "later"; no git machinery in
core); steering a running child; background children, receipts, `wait` tool,
missions/schedules/fleet ([B] "skippable bloat"); fork-context children (fork-context.ts:68-98 —
pays off only with prompt caches); recursive subagents (child pool excludes `task`, same rule as [D]
constants/tools.ts:36-50).

**Headline constraints** (unchanged from M4): zero new runtime deps (only `typebox`); primitives in
core, product features in extensions where possible; append-only session files; teaching-style
errors; print-mode byte-stability (ANSI only in interactive TTY); CJK-safe rendering (no width
math).

## 2. Reference architecture

- **pi core has no subagent machinery** ([A]): `packages/agent/src/index.ts:1-49` exports only
  generic primitives (Agent, loop, tool contract, sessions). Delegation exists solely as an example
  extension that **shells out to the pi CLI** (`--mode json -p --no-session`,
  packages/coding-agent/examples/extensions/subagent/index.ts:294), injects agent definitions via `--append-system-prompt`
  (index.ts:324-327), returns the child's last assistant text (index.ts:170-180), keeps children
  in-memory via exit-code sentinels (subagent/index.ts:604-617), and caps concurrency at `MAX_CONCURRENCY = 4` with
  `MAX_PARALLEL_TASKS = 8` (index.ts:33-34, 219-237).
- **pi-subagents (product layer)** ([B]) adds the usability surface: agents as markdown+frontmatter
  across 5 scopes (src/agents/agents.ts:647), `systemPromptMode: append|replace`,
  `defaultContext: fresh|fork`. Verdict: copy the markdown registry; skip
  missions/schedules/retention.
- **Claude Code** ([D]) calibrates the contract: fresh context is
  `promptMessages = [userMessage(prompt)]` (AgentTool.tsx:514-516); result = last assistant text
  with a backward fallback scan (agentToolUtils.ts:295-311) plus a `<usage>` trailer and an explicit
  "(no output)" marker (AgentTool.tsx:1343); parallelism = consecutive concurrency-safe calls
  batched under a cap of 10 (toolOrchestration.ts:84-116); oversized results persisted, not
  truncated (toolResultStorage.ts:55-77).
- **imp integration map** ([C]) decides: `runAgentLoop` is stateless over options (loop.ts:80-96)
  and re-entrant as-is; `Tool` already threads `AbortSignal` (tools/types.ts:13-19); cwd arrives via
  factory closures (read.ts:15-20); one `SessionStore` per file is safe, but two writers on one file
  corrupt the tree walk (store.ts:115-118, 246-252); `ExtensionApi` exposes no provider/model/tools
  (extensions/types.ts:26-43), so an extension-hosted child is impossible today.

**Conclusion / deviation.** imp runs children **in-process as nested `runAgentLoop` calls**, not as
CLI subprocesses like pi. Defense: imp owns its loop and has no `--mode json` surface to shell into;
nested calls reuse the existing abort plumbing (no SIGTERM/SIGKILL ladder), share the provider
(stateless `stream()`, provider/types.ts:25-27), and test with the same fakes — the child is a plain
function call.

## 3. Feature spec: the task tool

New core module `src/core/tools/task.ts`, wired into the runner's default set after the base six
(runner.ts:162-172); factory closure per [C] §1.

**Schema** (typebox, like read.ts:12-16):

```ts
const taskSchema = Type.Object({
  prompt: Type.String({ description: "Complete, self-contained task for a fresh subagent. It sees nothing of this conversation; include all needed context (paths, what to return)." }),
});
// M5c adds: agent: Type.Optional(Type.String({ description: "Agent name from the registry (see tool description)" }))
```

No `description`, `cwd`, `model`, or `tasks[]`/`chain` fields: the renderer already summarizes args
(`summarizeArgs`, render.ts:8); cwd-isolation is a non-goal; parallelism comes from multiple
tool-call blocks in one turn ([D] prompt.ts:271); chaining ([A] `{previous}`) is a workflow engine.

**Result contract.**
- Success: child's last assistant **text**; if the final message has none, scan backwards for the
  most recent assistant text ([A] index.ts:170-180, [D] agentToolUtils.ts:295-311). Empty → literal
  `(subagent completed with no output)` — never a blank result.
- Trailer (byte-pinned, §10): `(child: 7 turns, 12.3k in / 1.4k out / 9.8k cache)` — turns + `usage`
  from `RunAgentLoopResult` (loop.ts:49-55), counts via `formatTokens` (format.ts:34); a budget
  signal mirroring [D]'s `<usage>` trailer. An absent `cacheReadTokens` omits the cache segment
  (never `/ 0 cache`). Child tokens do **not** fold into parent usage (the parent loop never sees
  the child's provider calls).
- **Truncation**: tail-truncate to the last 50KB (`MAX_BYTES`, exported from a new shared
  `src/core/constants.ts` — bash.ts:9's const is module-private) with a teaching header:
  `[task] result truncated to its last 50KB (dropped N bytes). For large output, have the subagent write a file and report its path instead.`
  Deviation from [D]'s persist-to-disk + 2KB preview (toolResultStorage.ts:55-77): the full text
  lives in the child session file (§5 — ON from M5a). With `IMP_CHILD_SESSIONS=0` the bytes are
  gone; the notice still teaches the durable fix.

**Error teaching lines** (exact strings, error-catalog style):
- Abort:
  `task aborted before completion (N turns ran). Partial transcript: <child-session-id or "not persisted">.`
  — `isError: true`.
- Timeout:
  `task timed out after 1800s (N turns ran). Partial transcript: <child-session-id or "not persisted">.`
  — `isError: true`; same partial-recovery path as abort (§6).
- Child crash (provider/protocol error): partial recovery ([D] AgentTool.tsx:1225-1240) — return any
  assistant text with a trailer
  `[task] child failed after N turns: <reason>; partial result above.`; only a zero-turn crash
  returns `isError`.
- Unknown agent (M5c):
  `unknown agent "X". Available agents: a, b, c (defined in .imp/agents/ and ~/.imp/agents/).` —
  mirrors [D]'s list-the-agents error (AgentTool.tsx:353).
- `max_iterations`: return last assistant text as a success-shaped result plus trailer
  `[task] hit the 40-turn cap; result may be incomplete.` — the cap is a valve, not an error.

## 4. Child agent + context semantics

**Fresh context, always** (M4-recorded; [A] index.ts:6-8, [D] AgentTool.tsx:514-516):

```ts
runSubagent({ provider, model, system, tools, prompt, signal, timeoutMs }) => {
  const history: AgentMessage[] = [];      // bare array, no store ([C] §3)
  const childSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const result = await runAgentLoop({ provider, model,
    system: system + CHILD_SUFFIX, tools, history,
    userMessage: prompt,                   // verbatim, no wrapper
    maxIterations: 40, signal: childSignal });
  // → extract final text / map errors per §3
}
```

- **System prompt** = the parent's current system string (env facts, AGENTS.md, extension contexts)
  **+ `CHILD_SUFFIX`**: "you are a one-shot subagent; your final message is returned verbatim to the
  calling agent; finish the task and answer — do not ask questions. You do not have the task tool;
  complete the job yourself." The last sentence is load-bearing: M5a adds a `task` line to the
  parent's §Tools list (system-prompt.ts hardcodes the six, lines 22-28) while the child pool
  excludes `task` — without it the child prompt advertises a tool it lacks (asserted in §10).
  Reusing the parent's built system over a fresh `buildSystemPrompt()` keeps AGENTS.md awareness in
  children ([D] runAgent.ts:389-397 passes CLAUDE.md down) and avoids a second prompt-assembly path.
  M5c appends the agent file's body after it (append-only; `replace` rejected — one mode is
  testable, append keeps imp's rules).
- **Tools subset** = the parent's tool array **minus `task` itself** (no recursion; [D]
  agentToolUtils.ts:128-225); same cwd factories, so shared cwd for free. M5c intersects with
  frontmatter `tools:` (unknown names are a teaching error listing valid names, not a silent drop).
- **Model** = parent's current model (read at spawn via a getter closure; `runner.model` is
  mutable). M5c: optional frontmatter `model` override — same precedence idea as [D]
  model/agent.ts:37-92, minus the env-var layer.
- **maxIterations = 40** (parent parity — the valve guards runaway spin, not honest work; the real
  ceiling for heavy tool jobs is child **context exhaustion** (no child compaction in M5), which
  degrades through the §3 crash path). **`timeoutMs` = `CHILD_TIMEOUT_MS` = 30 min** default (§6),
  injectable for tests. **Invariant: the clock must scale with the turn budget** — at ~45s/turn
  average with slow tools, 40 turns need ~30 min; raise one, re-derive the other. Child messages never enter
  parent history or fire parent `onMessage` / extension events ([C] §4's contamination rule) —
  deliberate and documented.

## 5. Session semantics

**Decision: one JSONL child session file per child, written with the existing store, in a
`children/` subdirectory, linked by one additive header field. Default ON; `IMP_CHILD_SESSIONS=0`
disables** (the `IMP_AUTOCOMPACT` env convention, runner.ts). **Ships in M5a** (review CORRECTION,
§12).

Mechanics: `createChildSession(parentStore)` in session/manager.ts — `createSession`
(manager.ts:43-47) already yields collision-free `<timestamp>-<uuid>.jsonl` names; the child variant
targets `<sessionsDir>/children/` and adds one optional header field `parent: <parent session id>`
(format stays version 1; readers ignore unknown header fields, store.ts:91-110). A draft
`role: "child"` field was dropped in review — `parent`'s presence already identifies children (§8's
wait-for-a-second-consumer rule applied to the format). The task tool appends every child message
via `onMessage` → its own store — one store per file is the supported shape ([C] §3).

**Defended against the alternatives:**
- *In-memory only* (pi, [A] §4 — `--no-session`): rejected as default. imp's identity is inspectable
  append-only sessions; a failed 40-turn delegation with no trace is un-teachable (~30 lines to
  reuse existing machinery).
- *Child entries inside the parent file* (Claude's sidechain shape, [D] runAgent.ts:733-743):
  rejected — two writers on one file corrupt the leaf/parentId tree walk (store.ts:115-118,
  246-252), and concurrent children interleave entries.
- *Subprocess + `--no-session`* ([A]): moot — no subprocess in imp (§2). Child sessions are **not
  resumable** via `--resume` in M5: the `children/` subdir keeps the listing clean without filtering
  logic (flat dir scan, manager.ts listSessions). Resume stays parent-only.

## 6. Concurrency, abort, steering

**Concurrency (M5b).** Today the loop executes tool calls strictly in order (awaited one by one,
loop.ts:148-158). Change: `Tool` gains an optional `concurrencySafe?: boolean` (types.ts); `task`
sets it. The loop groups **maximal runs of consecutive** concurrency-safe calls and runs each group
with `Promise.all` in chunks of **`MAX_CONCURRENT_TASKS = 5`** (constant, no env knob).
Consecutive-only batching is exactly [D]'s rule (toolOrchestration.ts:84-116); 5 sits between
pi's 4/8 ([A] index.ts:33-34) and Claude's 10. The cap never drops work — tasks beyond it queue
into waves — it only trades turn latency for endpoint pressure (10 concurrent SSE streams turn
transient endpoint failures into retry storms) and for worst-case deterministic-`tool_end` wait
(a fast task waits behind at most cap-1 slow siblings, each bounded by the clock). All other tools stay serial.

**Gates before parallelism.** A chunk's `onToolCall` gates evaluate serially in call order *before*
any execution; only the approved subset then runs concurrently. Gates are cheap, execution is slow —
confirmation/dedup extension state sees a deterministic, non-interleaved sequence instead of racing
under `Promise.all` (tested in §10).

**Event ordering under concurrency:** `tool_start` fires in call order for the chunk before
awaiting; **`tool_end` is emitted in call order**, buffering early finishers until their
predecessors report — deterministic event order regardless of completion timing keeps print output
byte-stable run-to-run; the renderer never correlates `⎿` lines by identity. A finished task waits
at most until its slowest predecessor completes or times out. On abort mid-chunk,
buffered-but-unemitted `tool_end`s for tools that did complete are **flushed** before the chunk
unwinds — a killed chunk never drops computed events (tested in §10).

**Result order:** `ToolResult[]` is assembled in call order (await the chunk, then map) — matching
[D]'s normalize-by-tool_use_id (toolOrchestration.ts:160-176).

**Abort.** The parent loop already passes its `AbortSignal` into every `execute` (types.ts:18,
loop.ts:148-158); the task tool passes it straight through to the child loop — no extra controller.
On abort the child loop returns `stopReason: "aborted"` with synthesized results for dangling tool
ids (loop.ts:130-136, 155-158, 171-200), so the child session stays resumable-shaped; the task tool
returns the §3 abort error. One Ctrl+C, both loops stop cleanly.

**Timeout.** Every child runs under
`AbortSignal.any([parentSignal, AbortSignal.timeout(CHILD_TIMEOUT_MS)])` (node builtin, engines ≥
20; zero deps); `CHILD_TIMEOUT_MS = 30 min`, one test-injectable constant (scales with maxIterations — see §4 invariant). The loop's abort check
only runs between stream events (loop.ts:221-228), so a child hung on a stalled stream is otherwise
unkillable — it would hold siblings' computed results in the event buffer forever, and print mode
has no Ctrl+C. The timeout bounds that wait, fires the §3 timeout error via the abort recovery path,
and keeps the child session complete.

**Steering.** No steering of children — non-goal; both references lack it (steering is same-agent in
pi, [A] §5). The parent's steering queue keeps working between parent turns; a child finishes, times
out, or is aborted — abort-and-retask costs zero code.

## 7. REPL rendering + print-mode stability

**M5a needs zero renderer changes.** The task tool surfaces only through existing
`tool_start`/`tool_end` `AgentEvent`s (loop.ts:11-12) — the [C] §7 rule: no new direct writes. In
print mode (`toolStyle: "two-line"`, no liveTools) a task is `\n● task {…}\n` all-dim + `⎿` summary,
byte-identical to every other tool (render.ts:277-281). **Decision: child text deltas are never
forwarded to the parent renderer** — they would interleave with parent text and break byte-stability
and readability; the `⎿` summary is the only visible progress. Long child runs still animate via the
existing pending-tool spinner (`● task … ⠹ 37s`, render.ts:33-35) — no child telemetry.

**M5b (concurrent tasks) — one renderer change, interactive only.** The single-`PendingTool` slot
(render.ts:28-33, 65) becomes a small array:
- Exactly one pending tool: today's behavior, byte-for-byte (snapshot tests guard this).
- N > 1 pending: collapse to **one aggregate spinner line** `⠏ 2 tasks running 12s`, and print each
  `⎿ …` summary as its `tool_end` arrives (in call order, §6). No per-task stacked rewrites, no
  width math — the CJK-safe rule (render.ts:239-240, format.ts:50) holds: aggregate lines are never
  column-aligned or padded.
- Print mode: untouched — `liveTools` is false there, so tool lines are pure appends and the
  byte-stable corpus (repl-render tests, render.ts:13) must not move.

## 8. Extension API interplay

**What stays core now:** the task tool, `runSubagent`, child session creation. Reason: the M4
`ExtensionApi` (extensions/types.ts:26-43) exposes no provider, model, parent tools, or system
prompt ([C] §5) — an extension-hosted child is impossible without API growth, and M4 §16 deferred
sub-agents to M5 *because* they need the engine: primitives in core, product on top.

**What this deliberately does NOT add:** no `api.spawnAgent`, no `registerAgent`, no child-event
subscriptions — every candidate surface waits for a second consumer.

**Migration path (M6+, not M5):** export `runSubagent(options)` from core and add one capability —
`api.spawn({ prompt, system?, tools?, model? })` — and the task tool could move to an example
extension, mirroring pi's shape ([A]). The M5c registry stays **file-based data only** (no
`registerAgent` code path) so it works for any future host.

**Known gap, accepted:** extension `tool_call` gates do not see the child's tool calls
(`runSubagent` takes no `onToolCall`). Documented; §11 Q3.

> **Post-review revision (2026-09-04, M6a):** gap closed. `runSubagent`
> forwards the parent gate into the child loop; `tool_call` events from
> children carry `subagent: true` and the agent profile name. Blocked child
> calls return the teaching-style error result to the child, which can adapt
> and continue. Existing stateless gates (guardian) gained child coverage
> with zero changes.

## 9. Milestones

Each milestone ships independently: tests green, no new deps.

**M5a — sequential task tool + child sessions (the M4-recorded core scope).**
- `runSubagent` + `createTaskTool` (factory
  `{ cwd, provider, getModel, getSystem, tools, timeoutMs? }`; getters: `system` finalizes in
  warmup, `model` is mutable — runner.ts:139-148); fresh child context; final-message contract;
  truncation; teaching errors incl. timeout; abort chaining; child pool excludes `task`;
  system-prompt §Tools gains one `task` line while `CHILD_SUFFIX` says the child lacks it (§4).
  Child sessions ship **here** (review CORRECTION, §12): `createChildSession`, `children/` subdir,
  `parent` header, `IMP_CHILD_SESSIONS=0` opt-out — §3 strings carry the child id from day one;
  `MAX_BYTES` moves to `src/core/constants.ts`.
- **Gates (test-first):** `test/subagent.test.ts` + `test/task-tool.test.ts` (~24 tests, §10); all
  220 existing tests green; renderer byte-snapshot corpus unchanged **and** the system-prompt tool
  list gains exactly one `task` line (asserted — the corpus alone cannot catch its reversion);
  `npm ls --production` still lists only typebox.

**M5b — concurrency + renderer (one mechanism pair, alone).**
- Loop: `concurrencySafe` flag, consecutive-run batching, chunk cap 5, serial gate evaluation then
  parallel execution, call-order `tool_end` with abort flush, call-order results (§6). Renderer:
  pending array + aggregate spinner, interactive only (§7). Sessions and error strings unchanged
  from M5a — M5b touches exactly the loop+renderer pair, so regressions bisect cleanly.
- **Gates:** batching/order tests incl. out-of-order completion, an order-recording gate, and abort
  mid-chunk incl. buffered-event flush; renderer tests incl. CJK task labels and single-pending
  byte-identity; existing corpus green.

**M5c — agent registry (data-driven agents).**
- Markdown + frontmatter files (`name`, `description`, optional `tools`, `model`, `timeout`) from
  `.imp/agents/` and `~/.imp/agents/`; **project wins on name collision; no builtin agents** (imp
  ships no persona opinions; a hand-rolled parser is ~40 lines — zero deps, same call as [B]
  frontmatter.ts:75). `task` gains optional `agent`; the tool **description** enumerates agents with
  their `description` (auto-routing hint per [D] prompt.ts:172-178). Append-only `systemPromptMode`;
  unknown agent/tools → teaching errors (§3).
- **Gates:** parser tests (frontmatter edge cases, no YAML dep), precedence tests,
  subset-intersection tests, unknown-agent error test; end-to-end discovery via a hermetic `mkdtemp`
  project dir.

## 10. Test plan

Reuse `test/helpers/fakes.ts` throughout ([C] §6); child-loop tests share the loop tests' shape:

- **Two scripted providers, one per role**: parent loop gets a provider scripted to emit a `task`
  call then read the result; the task factory takes a *second* `scriptedProvider` playing the child
  (its `sink` captures the child request — assert fresh context: one user message, no parent
  history, `task` absent from tools, system contains `CHILD_SUFFIX` + the no-task-tool sentence +
  AGENTS.md text). Pattern: loop.test.ts:17-30.
- **Abort**: `gate()`/`gatedTool` to hold the *child* mid-tool; abort the parent signal; assert
  child returned `aborted` with synthesized results, parent got the §3 isError line, and the child
  session file is complete (tool_use→tool_result pairs intact).
- **Timeout**: gated child + tiny injected `timeoutMs` → parent gets the §3 isError line naming the
  timeout; child session file complete; parent signal NOT aborted (only the child's composite signal
  fired).
- **Contract branches**: 40 scripted tool-calling turns → success-shaped result +
  `[task] hit the 40-turn cap` trailer; text-less final message → backward scan picks earlier
  assistant text; no assistant text anywhere → `(subagent completed with no output)`.
- **Partial failure**: child provider thunk that throws after 2 scripted turns → partial result +
  failure trailer; zero-throw → isError.
- **Truncation + trailer**: >50KB final text → tail kept, header byte-exact incl. dropped-bytes
  count; usage trailer byte-exact in both shapes — with and without the cache segment
  (`cacheReadTokens` absent).
- **Concurrency (M5b)**: three gated task calls released in shuffled order; assert `tool_end` and
  result-array order = call order, and the 6th call waits (cap 5, observed via `tool_start` timing).
  An order-recording `onToolCall` gate asserts gates ran serially in call order. Abort mid-chunk →
  buffered-but-unemitted `tool_end`s still flushed.
- **Renderer**: `makeRenderer()` (ansi-free collector, fakes.ts:63-82) with injected `clock` and
  manual spinner ticks; assert aggregate-line format, `⎿` order, CJK labels (no padding), and
  `two-line` byte snapshots for one and two tasks matching the corpus.
- **Runner/hermetic**: `mkdtemp` cwd + `sessionBaseDir` + `IMP_LOG=0` (runner.test.ts:20-23
  pattern): header `parent` link, `children/` list-exclusion, both abort-string variants (session
  id; `not persisted` under `IMP_CHILD_SESSIONS=0`), and two concurrent children → both files parse
  with complete tool_use→tool_result pairs, correct parent links, distinct ids.
- **Registry (M5c)**: fixture `.imp/agents/*.md` trees for parse/precedence/subset cases;
  unknown-agent teaching errors asserted exactly.

## 11. Risks & open questions for the human

Risks (with mitigations):
- **Cost amplification**: 5 children × 40 turns spend fast (owner accepts: completion over cost). Mitigation: usage trailer in every
  result; one constant to lower. Residual: no dollar figures (no price table yet).
- **Fresh-context prompt bloat**: parents paste huge context into `prompt`. Mitigation: the tool
  description teaches self-contained-but-minimal prompts.
- **Child invisible to extension gates** (§8): a blocking `tool_call` extension cannot veto a
  child's bash. Documented; see Q3.
- **Deterministic `tool_end` reordering** delays a fast task's report behind a slow sibling —
  bounded by the 30-min clock (§6); accepted for byte-stability.

Open questions (post-review defaults — say the word to flip any):
1. **Child session files default ON?** Yes — inspectability is imp's identity; calibration endorsed
   the shift (file churn is the cost).
2. **Concurrency cap?** 5 (owner decision, post-review): the cap queues rather than drops work,
   so it costs latency, not completion; 5 balances that against single-endpoint pressure. pi uses
   `MAX_CONCURRENCY = 4` / `MAX_PARALLEL_TASKS = 8`; Claude Code caps at 10. One constant.
3. **Extension gates on child tool calls?** No in M5 — children would be permission-gated by
   extensions they never see loaded. (Parent-side gate *ordering* is fixed regardless, §6.)
4. **Wall-clock timeout for children?** **Yes — 30 min** (adversarial review flipped this to
   10 min; owner raised it to 30 to match the 40-turn budget — see the §4 scaling invariant):
   print mode has no rescuer; a stalled stream is unkillable between events
   (loop.ts:221-228). `AbortSignal.any` is free; one injectable constant; per-agent override
   arrives with the M5c registry (`timeout:` frontmatter).
5. **Ship builtin agents in M5c?** None — the registry is user/project-owned from day one.

## 12. Review verdicts (adversarial + calibration)

**Adversarial: 0 blockers, 4 MAJOR, 6 MINOR — all merged except #8 (rejected).**
- #1 timeout (MAJOR): Q4 flipped to a 10-min cap — `AbortSignal.any` spec (§4/§6), error string
  (§3), tests (§10); the draft's "waits seconds at most" claim is now true.
- #2 child prompt advertised `task` (MAJOR): `CHILD_SUFFIX` gains the no-task-tool sentence (§4,
  asserted §10).
- #3 gates race under `Promise.all` (MAJOR): serial gate evaluation in call order, then parallel
  execution (§6); order-recording gate test (§10).
- #4 M5b bundled three subsystems (MAJOR): resolved with calibration #3 — child sessions moved into
  M5a; M5b is concurrency + renderer alone (§9), bisectable.
- #5-#7, #9, #10 (MINOR): byte-pinned usage trailer incl. omitted-cache case (§3/§10);
  contract-branch tests — 25-turn cap, text-less final, no-output (§10); concurrent-child
  session-integrity test (§10); `role` header dropped, `parent` only (§5); M5a gate asserts the
  system-prompt `task` line (§9).
- #8 (emit `tool_end` on completion) **rejected**: call-order buffering is what makes print output
  byte-stable *across runs* with real providers, and costs a small index-keyed buffer. Its real gap
  — abort must flush buffered events — is now specced (§6) and tested (§10).

**Calibration: 1 CORRECTION and 2 nits merged; 1 boundary shift endorsed.**
- CORRECTION #3: §3 claimed truncation recoverability via child sessions while M5a shipped in-memory
  children — sessions now land in M5a (§5/§9); §3 states the `IMP_CHILD_SESSIONS=0` loss case.
- Nit #1: both pi constants cited (`MAX_CONCURRENCY = 4`, `MAX_PARALLEL_TASKS = 8`; §2/Q2). Nit #6:
  "`MAX_BYTES` shared with bash" was false (bash.ts:9 is module-private) — exported from
  `src/core/constants.ts` (§3/§9).
- Endorsed as-is: sessions default ON (a shift beyond both references, justified by imp's
  inspectable-sessions identity), task tool in core with the M6+ `api.spawn` migration,
  parent-system reuse, no reinvention.
- For the record: ~12 [B]/[D] citations were not re-verifiable in review; internally consistent, and
  every checkable [A]/[C] citation held.

**§11 defaults:** Q1 ON, Q2 = 3, Q3 no (ordering fixed), Q4 = 10-min timeout (flipped), Q5 none.

**Post-review revision (owner decision, 2026-09-04):** limits re-tuned for completion over cost —
maxIterations 25 → 40, CHILD_TIMEOUT_MS 10 → 30 min (coupled by the §4 scaling invariant),
MAX_CONCURRENT_TASKS 3 → 5 (10 considered and declined: the cap queues work rather than dropping
it, so raising it buys latency at the price of endpoint pressure and worst-case `tool_end` wait).
M5c registry gains a per-agent `timeout:` override. All changes above are already reflected in
§3–§11.
