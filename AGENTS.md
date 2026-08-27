# imp — working agreements for coding agents

## Code review discipline

Before declaring behavior-changing work done — and before paid acceptance
runs — evaluate whether an independent review is needed. Trigger on any of:
core paths changed (agent loop, provider, session storage, compaction, tool
semantics); on-disk or cross-process formats changed (session JSONL, resume);
a >150-line new module; a milestone closing; abort/concurrency paths touched.
Skip: docs-only, test-only, formatting, config tweaks, renames.

- Reviewer independent of the author (subagent, human, or adversarial
  self-review); findings must state inputs → wrong behavior, not style.
- Major findings block completion; minors are fixed or recorded in PROJECT_PLAN.
- Turn every accepted finding into a regression test when feasible.

Tests alone are not sufficient: M2 merged 83/83-green with a resume-bricking
bug (details in PROJECT_PLAN, M2 notes).
