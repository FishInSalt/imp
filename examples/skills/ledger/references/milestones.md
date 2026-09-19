# Entries and milestones

A milestone (M1…Mn) owns a top-level `## ` section in PROJECT_PLAN.md.
Ledger entries carry the batch id (`#m5-subagents`, `#ci-linux-fix`, …);
the milestone section links to the ids it depends on and states its
acceptance gates.

An entry without a milestone section is fine (ops batches like
`#trust-home-fix`); a milestone without entries means the plan drifted —
flag it in your reply.
