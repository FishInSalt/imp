# Ink — working agreements for repository changes

- After any code change, consciously evaluate whether an independent code
  review is warranted before declaring the work done.
- Before implementing any milestone or batch that has a design document,
  the design document itself must pass an independent review (fresh-context
  reviewer, adversarial). Implementation starts only after the design
  review closes.
- Start EVERY repository change (code, docs, config — no size or type
  threshold) by creating a dedicated branch or worktree, before the first
  edit. Merge to main only via --no-ff.
- A feature change that alters user-visible behavior must update the
  matching page under `docs/` (the published user-facing set — see
  docs/index.md) in the same batch: the model routes questions through
  those pages (self-docs), so stale docs actively mislead. New features
  without a matching page add one and list it in `docs/index.md`.
  `scripts/check-docs.mjs` (via `npm run lint`) guards structure, not
  content.
