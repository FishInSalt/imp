# imp — working agreements for coding agents

- After any code change, consciously evaluate whether an independent code
  review is warranted before declaring the work done.
- Before implementing any milestone or batch that has a design document,
  the design document itself must pass an independent review (fresh-context
  reviewer, adversarial). Implementation starts only after the design
  review closes.
- Start EVERY repository change (code, docs, config — no size or type
  threshold) by creating a dedicated branch or worktree, before the first
  edit. Merge to main only via --no-ff.
