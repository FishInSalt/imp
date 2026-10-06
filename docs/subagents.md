# Subagents

Read this when you delegate work with the `task` tool, define named agent
profiles, or need worktree isolation.

## The task tool

`task` delegates a self-contained job to a fresh subagent with its own
context window: exploration bloat stays out of the main conversation, and
the subagent's final message comes back as the tool result (with a usage
trailer; oversized results are tail-truncated to 50KB).

Children run in-process with the parent's tools (minus `task` itself) and
the parent's working directory, uncapped — budget decisions stay with the
parent. Several `task` calls in one turn run concurrently (waves of up to
5); results keep a deterministic, call-ordered place in the conversation,
and on screen each call owns its own entry: a live overview under its own
`● task` header while running, its result landing under that header the
moment it settles, with its own duration.

## Loop health

A shared loop-health monitor (same signals for the main loop and children)
reports degenerate patterns — repeated identical tool calls, repeated failed
edits — as honest task-result lines, a task-record field, and one dim REPL
note per signal (`INK_HEALTH=0` disables it). It never injects anything into
a child.

## Persistence and timing

- Every child transcript is persisted as a session file in a `children/`
  directory next to the parent's (`INK_CHILD_SESSIONS=0` opts out).
- Wall-clock: no clock in the REPL (Ctrl+C is the backstop); a 60-minute
  hang guard in print/headless runs. A call's `timeoutMs` or an agent
  file's `timeout:` (seconds) always wins.

## Named agents

Agent profiles are markdown files with hand-parsed frontmatter — no YAML
dependency, no builtins. Locations: `<project>/.ink/agents/` (behind the
trust gate) and `~/.ink/agents/`; the project directory wins on name
collisions. Agent files load at startup — new files need a restart, like
extension changes.

```
.ink/agents/scout.md
---
name: scout
description: Explores a codebase to answer research questions
tools: read, grep, find     # optional subset of the parent pool
model: glm-5.3              # optional: same-provider override only
timeout: 300                # optional wall clock, seconds
thinking: high              # optional: off|minimal|low|medium|high|xhigh|max
worktree: true              # optional: run on an isolated git worktree
---

You are a code scout. Go broad before deep.
```

- `model:` overrides which model that agent's children run — on the
  **current provider only**: a bare id, or a `provider/id` prefix naming
  the same provider (the prefix is stripped). A cross-provider reference is
  rejected before the child starts, with an error that names the
  workaround. Omit to inherit the session's model; a blank `model:` is a
  configuration error (rejected the same way).
- `thinking:` sets the level for that agent's children. Omit to inherit the
  session's current level at spawn; a blank value is a configuration error
  (the file is skipped with a startup warning). The level is clamped to
  what the child's model supports.
- Registered agents are advertised to the model in the system prompt's
  `<advertised_agents>` block; `task(agent: "scout", prompt: …)` runs one.

A ready-to-copy example lives in `examples/agents/scout.md` (a read-only
code scout: `tools: read, grep, find`).

## Worktree isolation

A `task` call may set `worktree: true` (or an agent file may declare
`worktree:`): the child runs on its own git worktree — a separate checkout
of the committed state under the system temp dir — with the builtin tools
rebuilt at that path, so it physically cannot touch the parent's files. The
child prompt is told to translate paths and to commit its work; the result
names the branch and change summary, and the parent merges with
`git merge --no-ff <branch>` after review. A worktree with no changes is
removed (branch and all); preserved work is never discarded. `/worktrees`
lists worktrees kept for a manual merge.

Extension tools are excluded from worktree children (their registered cwd
cannot move). Isolation is by default working directory — a child's `bash`
could still reference absolute paths outside it.

## Concurrency boundary

Concurrent subagents share the parent's working directory. `edit`/`write`
mutations to the same file serialize through a process-wide file lock, and
a failed `oldText` match degrades into a teaching error (re-read, retry) —
but `bash` mutations bypass the lock entirely, and a whole-file `write`
silently clobbers an earlier one. So: delegate independent subtasks in
parallel; same-file modifications sequentially (the task tool description
tells the model the same). Read-only agent profiles (`tools:` without
edit/write/bash) make that structural — and `worktree: true` removes the
shared surface entirely.
