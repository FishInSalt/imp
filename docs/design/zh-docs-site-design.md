# Chinese docs site: full zh-CN mirror — design

Status: draft — awaiting independent design review (fresh-context, adversarial).
Implementation must not start until the review closes and its findings are folded.

## Goal

Publish a full Simplified-Chinese mirror of the documentation site
(https://fishinsalt.github.io/ink/): home page plus all ten published docs,
page-for-page, with a language switcher on every page.

## Non-goals

- Translating `docs/design/` (internal archive; not published, not shipped).
- Any language beyond zh-CN. The mechanism must not preclude others, but
  only Chinese ships now.
- Changing English docs content or the site's visual design.

## Current state (verified at design time)

- `scripts/build-docs-site.mjs` builds `_site/` from `README.md` + ten
  top-level docs. It hard-codes `lang="en"`, English sidebar labels, and
  English footer strings; rewrites links via a `PUBLISHED` map
  (repo path → site path); generates heading ids with `slugify`; emits
  canonical/og meta, sitemap.xml, robots.txt.
- `README.zh-CN.md` exists at the root; its site link points at the site
  root. Its header carries the language switch convention
  `[English](README.md) | **简体中文**`.
- `scripts/check-docs.mjs`: validates `REQUIRED_DOCS` exist, SELF_DOCS_TOPICS
  in `src/core/self-docs.ts` name existing docs, topic docs are linked from
  `docs/index.md`, and links resolve. Output: "10 docs, 9 topic routes".
- npm package ships `docs/` top level only: `scripts/package-smoke.mjs`
  collects top level and its allowlist regex is `docs\/[a-z0-9-]+\.md`;
  `test/package-tar.test.ts` asserts exact tar entries (and that
  `docs/design/` is absent). `package.json` files: `docs`, `!docs/design`.
- `lint:scripts` syntax-checks the scripts and runs check-docs.

## Design

### Content

- New `docs/zh-CN/` with the same ten file names as the top-level docs
  (`index.md` … `images.md`). `README.zh-CN.md` (root) remains the zh home
  source. Translations are committed files; the site is built at deploy
  time as today. No runtime translation, no external service.
- Translation rule set (binding for every file):
  1. Fenced code blocks are byte-identical to the English source.
  2. Link targets (paths and URLs) are copied from the English source
     unchanged; only anchor text is translated. In-page anchors (`#…`)
     must match the translated heading slugs.
  3. Heading count matches the English source.
  4. The glossary below is binding.
- Glossary: anchored on `README.zh-CN.md` usage (counts from the current
  file). Keep in English: Ink, npm, CLI, TUI, MCP, agent, token, JSON, and
  all command names, flags, and paths. Translate exactly as follows:
  skill = 技能, subagent = 子代理, extension = 扩展, session = 会话,
  provider = 提供商, model = 模型, tool = 工具, context = 上下文,
  settings = 设置, harness = 运行框架 (per the README tagline). Where the
  README already made a choice for a term, the README wins.

### Site structure and URLs

- en (unchanged): `/index.html`, `/docs/<name>.html`
- zh (new): `/zh/index.html`, `/zh/docs/<name>.html`
- Mechanical mapping: zh path = `/zh` + en path (home: `/` ⇄ `/zh/`).

### Page template, per language

- `lang="zh-CN"` on zh pages.
- Switcher in the sidebar under the tagline, following the README
  convention: `English | **简体中文**`, active language bold. Always links
  to the SAME page in the other language (home ⇄ home, cli ⇄ cli).
- zh labels: 首页 / 总览 / CLI 参考 / 提供商与模型 / 会话 / 设置 / 扩展 /
  技能 / MCP / 子代理 / 图片. Sidebar extras: GitHub / npm / 更新日志.
  Footer: 在 GitHub 上编辑此页; Ink 以 MIT 许可证发布; install command
  unchanged.
- zh pages carry a one-line canonicality note in the footer: 中文翻译可能
  滞后于英文版本；如有出入，以英文版本为准。
- "Edit this page" targets: zh pages → the zh source file
  (`docs/zh-CN/<name>.md`, `README.zh-CN.md`).
- Head: translated title (`<中文标题> — Ink`) and description (existing
  `summarize()` over the zh file); per-language canonical URL; hreflang
  alternates both ways plus `x-default` → en.
- sitemap.xml: add the 11 zh URLs.

### Link rewriting inside zh docs

- Translation keeps the English source's link targets; the builder maps
  them per language. For zh pages: `docs/<name>.md` → `/zh/docs/<name>.html`
  and `README.md` → `/zh/index.html` via the zh `PUBLISHED` map. Targets
  outside the published set keep the existing GitHub-blob fallback
  (English originals).
- In-page anchors: heading ids come from the existing `slugify` over
  translated headings; zh in-page links must match. Enforced by CI (below).

### Checks — extend `scripts/check-docs.mjs`

1. Mirror completeness: every `REQUIRED_DOCS` name exists in `docs/zh-CN/`.
2. Existing link checks run over zh docs and `README.zh-CN.md` too.
3. Structural parity per file (en vs zh): equal fenced-code-block count,
   byte-equal blocks, equal set of non-anchor link targets, equal heading
   count. (Heading text and in-page anchors are excluded by design.)
4. Anchor resolution: every in-page `#…` target in a zh file matches a
   heading id the builder would generate for that file. Share `slugify`
   with the builder (export it behind a main-guard, or duplicate it with a
   test pinning the two copies equal).

### npm package

Ship the translations. Update `scripts/package-smoke.mjs` (allowlist
admits `docs\/zh-CN\/[a-z0-9-]+\.md`, collect the subdirectory) and
`test/package-tar.test.ts` (expected entries). `package.json` files needs
no change (`docs` already includes subdirectories). Rationale: the package
already ships the user-facing docs; the mirror adds roughly 40 KB.

### README links

- `README.zh-CN.md`: candidate change — site link becomes
  `https://fishinsalt.github.io/ink/zh/`. On the built zh home this is
  self-referential; acceptable, but keeping the root link is also viable
  (the root has a switcher). Decide at review. `README.md` unchanged.

### Rollout

- Branch `docs/zh-docs-site`; design doc first (this file); implementation
  only after the design review closes; independent code review before
  merge; `--no-ff` merge; Pages redeploy verified; CHANGELOG Unreleased
  entry.
- Translation in batches of 3–4 files, done by fresh-context subagents
  given the glossary and rule set; every batch must pass the structural
  parity checks; full test suite; live spot-checks (switcher both ways,
  anchors, sitemap).

## Open questions for the review

1. Strict mirror policy: CI failing when a translated page is missing —
   too rigid for future English-only pages? (Alternative: explicit
   exemption list.)
2. README.zh-CN self-referential link: root or `/zh/`?
3. Structural checks: is heading-count parity strong enough, or should
   top-level (##) heading counts be compared separately? Cost/benefit.
4. hreflang `x-default` → en: any counter-argument?
5. Anything else in the repo that pins site behavior and is not listed in
   "Checks" or "npm package" (tests, workflows, scripts)?
