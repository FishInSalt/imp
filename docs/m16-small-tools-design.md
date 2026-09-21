# M16 — small tools batch: `ls` tool, `/copy`, `/name`

Three independent, low-risk additions from the pi-parity backlog
(#small-tools). Each is self-contained; none touches the loop, providers,
or settings.

## 1. `ls` tool — pi `core/tools/ls.ts` ported slim

- Schema `{ path?, limit? }`; resolves through the SAME `resolveReadPath`
  seam read uses (tilde, Unicode-space normalization, macOS screenshot
  fallbacks come along for free).
- Behavior (pi parity): entries sorted case-insensitively, dotfiles
  included, directories get a trailing `/`, unstattable entries are
  skipped, empty directory renders `(empty directory)`.
- Limits: entry cap default 500 (clamp 1–5000) and a 50KB byte cap on the
  joined output (pi's DEFAULT_MAX_BYTES); each adds an actionable notice
  (`[500 entries limit reached. Use limit=1000 for more]`,
  `[50KB limit reached]`) instead of silently dropping data.
- Registered in both tool lists (main session + subagent), system prompt
  gains one line. `find` keeps its "prefer over bash find/ls pipelines"
  guidance — ls answers "what's in THIS directory", find answers "where is
  X" (pi keeps the same distinction).

## 2. `/copy` — last agent message to clipboard

- pi parity wording: no agent messages yet → "No agent messages to copy
  yet."; success → "Copied last agent message to clipboard".
- Source of truth: `runner.history` walked in reverse for the last
  assistant message with non-empty text (live array — never stale, works
  after compaction).
- Writer: `src/repl/clipboard-write.ts` `copyToClipboard(text, opts?)` —
  platform commands through the existing `runClipboardCommand` (pbcopy;
  clip; termux-clipboard-set; wl-copy; xclip -selection clipboard;
  xsel --clipboard --input), then an OSC 52 escape as the final fallback
  (SSH sessions; capped at 100k encoded chars like pi). No native
  bindings — same D8 divergence as the image clipboard.
- `write` and `env` are injectable seams (tests fake them; no spawn).

## 3. `/name` — session naming

- pi parity: a `session_info` entry appended to the session tree. Tree
  metadata exactly like `thinkingLevelChange`: participates in the
  parent/leaf structure, never in buildContext, stats, or compaction
  walks. Name sanitization `[\r\n]+ → " "` + trim; pi's normalization
  warning ported.
- `/name` shows the current name; `/name <text>` sets it; empty after
  sanitization clears it.
- `inspectSessionFile` titles a named session by its name (the current
  branch's latest `session_info`), so `/sessions` and `--resume` previews
  show it. `/status` gains a `· name` segment.

## Tests

- `test/ls-tool.test.ts`: sort+dotfiles+dir suffix; entry limit notice;
  byte cap notice; not-a-directory; missing path; empty dir; abort.
- `test/repl-commands` additions: /copy (no message / success via injected
  writer), /name set→show→clear→sanitize warning, /sessions title,
  /status name segment.
- store test: session_info round-trips, clears, survives unknown-field
  forward compat.
