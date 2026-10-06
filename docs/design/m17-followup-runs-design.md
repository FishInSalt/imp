# M17 — follow-up runs: same-run continuation + queue drain modes

Closes the #queue-parity leftover: "follow-up 为独立 REPL turn（各带回显+
统计），非 pi 的同 run 内连续推进（需 loop 级 getFollowUpMessages）".

pi mechanics (packages/agent/src/agent-loop.ts:171-272, verified 2026-09-22):

- The outer `while (true)` is ONE run. The inner loop processes tool calls
  and steering. When the model would stop (no tool calls, steering pool
  empty), the loop polls the follow-up queue; non-empty → the messages
  become the next `pendingMessages` and the inner loop continues — same
  abort scope, one `agent_start`/`agent_end` pair, one aggregated usage.
- Both pools drain through `PendingMessageQueue.drain()` with a per-pool
  `QueueMode`: `"one-at-a-time"` (drain returns the head only) or `"all"`
  (drain returns everything). Settings keys `steeringMode`/`followUpMode`.

## 1. Loop seam: `getFollowUpMessages`

`RunAgentLoopOptions.getFollowUpMessages?: () => AgentMessage[] | Promise<AgentMessage[]>`
(mirrors `getSteeringMessages`). In `runAgentLoop`, the
"no tool calls → return completed" branch becomes:

1. poll follow-ups; if non-empty, push each into history (+ `onMessage`,
   same as steering injection) and `continue` the loop — the next
   `streamAssistant` call answers them in the SAME run;
2. only an empty poll returns `{ stopReason: "completed" }`.

The steering poll stays where it is (top of each iteration, before
`streamAssistant`), so steering messages queued while a follow-up turn
streams are consumed before the next follow-up — pi's steer-priority rule
falls out of the loop shape: the inner steering poll runs before the outer
follow-up poll is ever consulted.

`turns`/`usage` aggregation, `run_end` emission (runner.ts, once per
`runTurn`), and the abort scope (one `AbortController` per run) need no
changes — the continuation reuses the same run.

Safety valve: `maxIterations` still only guards tool-call turns. Follow-up
turns are bounded by queue length (each consumes one queued entry), so no
runaway path is introduced.

## 2. Drain modes — imp defaults deviate for steering

imp defaults: **`steeringMode: "all"`, `followUpMode: "one-at-a-time"`**
(pi defaults both to one-at-a-time; both keys exposed either way).

Rationale (design discussion 2026-09-22, user decision):

- Steering injects at every turn boundary — "timely supplementary info".
  Batched drain delivers the complete correction set at the earliest
  boundary; with a backlog, one-at-a-time spends turns draining it and so
  DELAYS newer messages (measurable: queue [S1,S2], S3 arrives during the
  first response — `all` delivers S3 one turn earlier). Consecutive
  corrections are a revision sequence the user typed without seeing any
  response in between; "last wins" is the natural reading.
- Follow-ups are consumed after the model would stop — "independent next
  tasks". One per boundary keeps the revision window (esc+p to pull back
  F2/F3 after reading F1's answer) and matches the queue-structure-as-task-
  decomposition signal.

The deviation is a default VALUE only; `steeringMode`/`followUpMode` are
ordinary settings keys (global ← project, env does not shadow them), so
pi's exact behavior is one `/settings` write away. Recorded here as a
deliberate divergence.

Wire shape note: `all` steering produces consecutive user-role messages in
history. All four adapters (anthropic, zai — Anthropic-format,
openai-completions, codex-responses) already pass consecutive user
messages through unmerged; the Anthropic Messages API combines consecutive
same-role turns server-side, OpenAI families accept them natively. A wire
pin test locks the pass-through shape.

## 3. REPL queue changes

- `steeringMessages()` becomes mode-aware: `all` drains EVERY steer-mode
  typed non-bang entry in queue order; `one-at-a-time` drains the first
  (today's behavior). Bang lines, follow-up lines, and `{ prompt }` entries
  still never steer.
- New `followUpMessages()` drains followUp-mode entries the same way, but
  is wired through `runner.runTurn({ getFollowUpMessages })` so the LOOP
  consumes them at would-stop boundaries. Echo: each drained follow-up is
  rendered as a user block (`renderer.user`) — it starts a new exchange;
  steering keeps its `▪ steering:` note (mid-turn injection).
- Modes are snapshotted once per run (in `submitTurn`): `/settings` writes
  take effect next run, consistent with the panel's "(next session)"
  teaching for scope writes.
- Flush semantics for the remaining entry types are unchanged: bang lines
  (shell), `{ prompt }` entries (md content, M11 #6 semantics), and
  race-window leftovers (steer/follow-up lines submitted after the last
  poll) still drain one-per-turn through `flushQueue`. The loop only exits
  on an empty follow-up poll, so flushQueue seeing follow-up entries is the
  exception, not the rule.
- Abort: unchanged — an interrupt aborts the current turn (follow-up or
  not); unconsumed queue entries are restored to the editor
  (`restoreQueueToEditor`, #queue-parity ③).

## 4. Settings

`ImpSettings` grows `steeringMode?: "all" | "one-at-a-time"` and
`followUpMode?: "all" | "one-at-a-time"`; `coerceSettings` validates the
two-value enum (anything else reads as unset → defaults). `/settings`
lists both rows (kind `mode`, Enter cycles, source column as for other
keys); `/settings <key> <value> [scope]` accepts the two literals.

## 5. Tests

- loop: follow-up continuation in the same run (usage aggregated across
  follow-up turns, single result), empty poll → completed, abort during a
  follow-up turn → `aborted` with unconsumed follow-ups never drained.
- REPL machine (TUI): two queued follow-ups consumed inside ONE run
  (footer never returns to idle between them; single settle); steering
  `all` default — two steer lines injected in one poll as consecutive
  user messages; esc+p revision window preserved between one-at-a-time
  follow-ups; abort mid-follow-up restores the rest.
- Settings: coerce accepts/rejects; panel rows + source column; parse/
  write round-trip.
- Wire pin: batched steering history (two consecutive user messages) →
  two user wire entries in anthropic and openai-completions adapters.
