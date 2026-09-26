# Changelog

All notable changes to imp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While imp is at
0.x, minor releases may include behavior changes.

## [Unreleased]

## [0.1.0] - 2026-09-26

Initial public release: imp is a small coding agent that runs in your
terminal.

- Interactive TUI (streaming, one-line tool status, queued steering and
  follow-up runs) plus print mode (`imp -p "..."`) and piped stdin
- Agent loop with tool execution: abort, validation, error feedback,
  steering hooks, and a compaction hook
- Sessions: append-only JSONL message trees (`~/.imp/sessions/`),
  `--continue` / `--resume <id>` / `imp sessions`, the `/tree` navigator,
  `/fork`
- Auto-compaction: older turns are summarized into a checkpoint near the
  context limit; the full history on disk is preserved
- Tools: `bash`, `read` (offset/limit, images), `edit`, `write`, `grep`,
  `find`, `ls`, `task` (subagents); the search tools respect .gitignore
- Providers: Anthropic, Z.AI (GLM), DeepSeek, Moonshot/Kimi, and OpenAI
  (API key or ChatGPT-plan OAuth); credentials from environment variables
  or `/login`
- Extensions, skills, named subagents, MCP servers, markdown quick commands,
  and custom system prompts (SYSTEM.md)

See the README's Status section for the full current capability list.
