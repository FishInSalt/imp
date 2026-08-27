# imp — working agreements for coding agents

## Code review discipline

After any code change that alters behavior, consciously evaluate whether an
independent review is warranted — BEFORE declaring the work done and before
running paid acceptance tests. "All tests green" is not sufficient: M2 merged
with 83/83 green, yet a review found a major bug (dangling tool_use made
killed sessions permanently unresumable) in paths the tests never covered.

Run an independent review when any of these hold:
- agent loop, provider, session storage, compaction, or tool semantics changed
- an on-disk format or cross-process contract changed (session JSONL, resume)
- a new module >150 lines landed, or a milestone's worth of work is closing
- abort, timing, or concurrency paths were touched

The reviewer must be independent of the author's assumptions: a reviewer
subagent (once imp supports one), the human, or a checklist-driven adversarial
self-review. Findings must state a concrete failure scenario (inputs → wrong
behavior), not style opinions.

Skip for: docs-only, test-only, formatting, config tweaks, renames.

Triage honestly: major → fix before proceeding; minors → fix or record in
PROJECT_PLAN as known issues. Convert every accepted finding into a regression
test when feasible — that is how the review pays rent.

## Conventions

- Code, comments, and AGENTS.md itself: English. Conversation with the user: Chinese.
- Every tool execute() must remain abortable (AbortSignal passed through).
- Errors feed back to the model as isError tool results; never crash the process
  on tool failures. Session file I/O errors may fail fast.
- On-disk formats are append-only; compaction never deletes history.
