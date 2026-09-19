---
name: ledger
description: Ledger-style bookkeeping for PROJECT_PLAN.md — append dated work entries, never rewrite history, keep one line per batch with ids and test counts
---

# Ledger skill

Maintain the project's PROJECT_PLAN.md as an append-only ledger.

Rules:

1. Entries append ABOVE the anchor comment, newest first — never reorder,
   edit, or delete existing entries.
2. One entry per batch: `**#id date — summary**` followed by indented
   detail lines (paths, test counts, review outcomes).
3. Always quote exact numbers: test totals, file paths, commit ids.
4. When a lesson generalizes (a tool quirk, a platform divergence), end
   the entry with `lesson:` and one sentence.

For the entry templates and worked examples, read
references/templates.md. For how entries map to milestones, read
references/milestones.md.
