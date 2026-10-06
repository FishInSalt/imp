# Sessions

Read this when you resume or fork a conversation, navigate history, or want
to know how compaction works. Model/provider questions →
[providers.md](providers.md).

## Where sessions live

Sessions are append-only JSONL message trees saved under `~/.ink/sessions/`,
organized by working directory. Every turn — user messages, assistant
messages, tool calls and results, model changes, compaction checkpoints — is
preserved on disk; nothing is ever rewritten.

```bash
ink -c                  # continue the most recent session in this directory
ink -r                  # ink sessions lists them; -r <id> resumes (prefix ok)
ink --no-session        # ephemeral run; nothing persisted
```

In the REPL: `/sessions` lists, `/resume <id>` switches (history replays on
screen), `/new` starts a fresh session (the old one stays on disk), `/name
<name>` names the session for the picker, `/status` shows session, model,
context, and trust at a glance. The exit line always shows how to resume:
`ink -r <id>`.

## The tree

Every session's messages form a tree, not a line. Forking or jumping creates
a branch; the active branch supplies history for the next model request.

- `/fork` — branch the conversation before an earlier message. Pick one from
  the filterable user-message list, or `/fork <n>`. Jumping to a user
  message puts its text back in the input for re-editing.
- `/tree` — a visual picker over every turn and branch. Arrows move; Tab
  cycles the filter (default / no-tools / user-only / labeled-only / all);
  `f` folds a subtree; `L` labels the selected entry (labels are searchable
  bookmarks that survive every filter); typing searches; Enter jumps.
  ←/→/PgUp/PgDn page; alt+←/→ fold at branch points; ctrl+x copies the
  selected entry's text; deep rows pan automatically. The picker opens on
  your current position.
- Jumping away from a branch optionally summarizes the branch you left into
  the new position's context (a three-way ask: No summary / Summarize /
  custom prompt). `INK_BRANCH_SUMMARY=0` disables summaries entirely;
  `/settings branchSummary.skipPrompt true` skips the ask (straight to
  no-summary). `/settings treeFilterMode <mode>` remembers your default
  filter.
- The readline (non-TUI) shell renders the tree as a numbered list;
  `/tree <n>` jumps to row n.

## Compaction

Near the context window, older turns are LLM-summarized into a checkpoint:
subsequent model requests use the summary plus recent turns, while the full
history stays on disk. `/compact` triggers it manually (optionally with
custom instructions). `--no-session` also disables auto-compaction;
`INK_AUTOCOMPACT=0` or `"autoCompact": false` in settings turns it off.
`INK_CONTEXT_WINDOW` overrides the window estimate (default 131072).

Branch summaries (from `/tree` jumps) are separate: they record an abandoned
branch in one entry. Both preserve the original entries — the tree is never
pruned.

## Steering and follow-ups (interactive)

Lines typed while Ink is working are queued, never dropped:

- **Enter** → a `steer:` line, injected into the running turn before the
  next model call. Default drain mode `all`: every queued steer joins the
  next boundary at once.
- **Alt+Enter** → a `follow-up:` line, consumed by the same run when the
  model would otherwise stop. Default `one-at-a-time`: one follow-up per
  answer, so a queued sequence advances without returning to idle.
- **Alt+Up / Esc+P** pulls every queued line back into the editor (draft
  preserved); Ctrl+C abort hands them back the same way.
- Modes are settings keys: `/settings steeringMode` and
  `/settings followUpMode` (`all` | `one-at-a-time`).

Terminal notes: WezTerm binds Option+Enter to fullscreen and Alacritty may
send plain Return — map both to `\x1b[13;3u`, or use Esc+P (dequeue has a
fallback; Alt+Enter does not).

## Known limits

- The `/resume` picker's type-to-filter consumes committed text only — IME
  composition windows emit no keys mid-composition (kitty protocol), so CJK
  input filters once committed. A pasted block takes its first line.
