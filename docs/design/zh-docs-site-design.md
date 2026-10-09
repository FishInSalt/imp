# Chinese docs site: full zh-CN mirror — design

Status: draft. Design review rounds 1 and 2 (fresh-context, adversarial)
returned "not ready"; all findings are folded below. Round 3 confirmation
is under way — implementation must not start until round 3 closes with a
ready verdict.

## Goal

Publish a full Simplified-Chinese mirror of the documentation site
(https://fishinsalt.github.io/ink/): home page plus all ten published docs,
page-for-page, with a language switcher on every page.

## Non-goals

- Translating `docs/design/` (internal archive; not published, not shipped).
- Any language beyond zh-CN. The mechanism must not preclude others, but
  only Chinese ships now.
- Changing English docs content or the site's visual design.
- Adding zh paths to `src/core/self-docs.ts` (canonical routing stays
  English; `test/self-docs.test.ts` pins the extraction regex).

## Current state (verified at design time)

- `scripts/build-docs-site.mjs` builds `_site/` from `README.md` + ten
  top-level docs. Hard-codes `lang="en"`, English labels/strings; rewrites
  links via `PUBLISHED`; heading ids come from `slugify` over RENDERED
  heading text (tag-stripped, entity-decoded) via `addHeadingIds`; emits
  canonical/og meta, sitemap.xml, robots.txt. `rewriteTarget` resolves a
  target against the CURRENT SOURCE dir and emits an href relative to the
  SAME dir — for en, source dirs and output dirs coincide (`""`/`docs`);
  for zh they will not.
- `README.md:9` carries `**English** | [简体中文](README.zh-CN.md)`;
  `README.zh-CN.md:9` carries `[English](README.md) | **简体中文**`;
  `README.zh-CN.md:103` links the site root.
- The only anchors in the published set: `docs/settings.md:11` and
  `docs/extensions.md:15` both link `index.md#project-trust` (targets
  `## Project trust` in `docs/index.md`). There are no parent-directory
  links outside code blocks.
- `scripts/check-docs.mjs`: REQUIRED_DOCS exist; SELF_DOCS_TOPICS name
  existing docs; topic docs are linked from `docs/index.md`; links resolve.
  No test in `test/` runs the builder or check-docs; the builder runs only
  in `.github/workflows/pages.yml` and via `npm run docs:site`.
- `pages.yml` `paths`: `README.md`, `docs/**`, `scripts/build-docs-site.mjs`,
  `package.json`, `package-lock.json`, the workflow file —
  `README.zh-CN.md` is missing.
- npm package ships `docs/` top level only: `scripts/package-smoke.mjs`
  collects top level; allowlist regex is `docs\/[a-z0-9-]+\.md`.
  `test/package-tar.test.ts` is a synthetic fixture (representative
  coverage; the real gate is package-smoke's `expectedFiles`).
  `test/package-metadata.test.ts` pins `pkg.files` exactly and pins
  `homepage` to the site root.

## Design

### Content

- New `docs/zh-CN/` with the same ten file names as the top-level docs.
  `README.zh-CN.md` (root) remains the zh home source. Translations are
  committed files; the site is built at deploy time as today.
- Translation rules (binding):
  1. Fenced code blocks are byte-identical to the English source
     (including info strings, order-sensitive).
  2. Link targets are copied unchanged (paths and `#anchors`); only anchor
     text is translated. The builder re-slugs anchors for zh (see Links).
  3. The heading level sequence is identical to the English source, and
     headings keep the English source's order (positional anchor mapping
     relies on it; a same-level section swap is caught only by translation
     review).
  4. The glossary below is binding.
- One-time compliance fix: `README.zh-CN.md`'s two bash blocks (dev /
  contributing section) currently translate the comments; implementation
  restores the English originals so rule 1 holds for all eleven pairs with
  no fence exemption.
- Glossary, anchored on `README.zh-CN.md` usage; the README wins on
  conflict. Keep in English: Ink, npm, CLI, TUI, MCP, agent, token, JSON,
  and all command names, flags, and paths. Translate exactly:
  skill = 技能, subagent = 子代理, extension = 扩展, session = 会话,
  provider = 提供商, model = 模型, tool = 工具, context = 上下文,
  settings = 设置, harness = 运行框架.

### Site structure and URLs

- en (unchanged): `/index.html`, `/docs/<name>.html`
- zh (new): `/zh/index.html`, `/zh/docs/<name>.html`
- Mechanical mapping: zh path = `/zh` + en path (home: `/` ⇄ `/zh/`).

### Link rewriting — contract (round-1 fix)

- Resolution base and output base are separate. A target resolves against
  the file's ACTUAL repo location (`README.zh-CN.md` → `""`;
  `docs/zh-CN/<name>.md` → `docs/zh-CN`); the emitted href is relative to
  the current page's OUTPUT dir (`zh`, `zh/docs`, or `""`/`docs` for en).
  En keeps source == output and is unchanged.
- zh map (source repo path → zh output path):
  - `docs/zh-CN/<name>.md` → `zh/docs/<name>.html` (sibling links in zh docs)
  - `docs/<name>.md` → `zh/docs/<name>.html` (the zh home's doc links,
    copied from the en README)
  - `README.md` → `index.html` (the zh home's English switch; the relative
    computation yields `../index.html`)
- en map gains one entry: `README.zh-CN.md` → `zh/index.html` (README.md's
  简体中文 switch lands on `/zh/`, not a GitHub blob).
- Fallback outside the published set is unchanged: GitHub blob of the
  English original.
- Anchor re-slugging: when a link carries `#anchor` into a file that has a
  zh counterpart, map the en heading slug to the zh heading id BY POSITION:
  find the anchor's index in `headingSlugs(en target)`, emit
  `headingSlugs(zh target)[index]`. Parity (CI) guarantees the same level
  sequence and the rules require the same order; a same-level section swap
  remains a translation-review risk. If the anchor is not found among the
  en target's slugs, keep it unchanged (same as today's en behavior).
  Anchors are emitted as raw UTF-8 (no percent-encoding).
- Concrete cases pinned by the build test: zh settings.html →
  `index.html#<id of the translated "Project trust" heading>`; built zh
  home English switch → `../index.html`; built en home 简体中文 switch →
  `zh/index.html`.
- Bare same-file anchors (`#section`): also re-slugged, against the file's
  own en/zh heading pair, before emission (zero exist today; check 4 covers
  them).
- Future note: if an en doc ever introduces a `../<root file>` link, the
  zh resolution base must be adjusted; check-docs flags the missing target.
  The zh map's `README.md → index.html` means a future zh file copying an
  en `../README.md` link would land on the English home; revisit that
  mapping then (the zh home may be preferred).

### Page template — per-language strings (single source in the builder)

- `html lang`: `en` / `zh-CN`.
- Home title: "Ink — an open-source AI assistant and agent harness for the
  terminal" / "Ink — 开源终端 AI 助手与 agent 运行框架".
- Home description: SITE_DESCRIPTION / "Ink —— 一个开源的终端 AI 助手与
  agent 运行框架：会话、扩展、技能、子代理与 MCP；支持 Anthropic、
  OpenAI、GLM、DeepSeek 和 Kimi。"
- Doc title: `<label> — Ink` / `<中文 label> — Ink`; doc description:
  existing `summarize()` over the file, fallback = that language's home
  description.
- Sidebar tagline: "an AI agent harness for the terminal" /
  "面向终端的 AI agent 运行框架".
- Nav labels (en / zh): Home / 首页; Overview / 总览; CLI reference /
  CLI 参考; Providers & models / 提供商与模型; Sessions / 会话;
  Settings / 设置; Extensions / 扩展; Skills / 技能; MCP / MCP;
  Subagents / 子代理; Images / 图片. Sidebar extras: GitHub, npm,
  Changelog / 更新日志.
- Footer: "Edit this page on GitHub" / 在 GitHub 上编辑此页; "Ink ships
  under the MIT license" / Ink 以 MIT 许可证发布; install command
  unchanged. zh-only note: 中文翻译可能滞后于英文版本；如有出入，以英文
  版本为准。
- Switcher (sidebar, under the tagline): en pages `**English** | 简体中文`,
  zh pages `English | **简体中文**`; always links the SAME page in the
  other language.
- Head: per-language canonical; hreflang alternates both ways plus
  `x-default` → en; sitemap gains the 11 zh URLs.
- "Edit this page" targets: zh pages → `docs/zh-CN/<name>.md`,
  `README.zh-CN.md`.

### Builder refactor (prerequisite)

- Guard the entry point (main-guard) so importing the module never builds.
- Export pure helpers: `slugify`, `headingSlugs(markdown)` (ids in document
  order, reproducing `addHeadingIds` over rendered text), and the rewrite
  functions. check-docs and the build test import these — no duplicated
  slug logic (`slugify` alone is insufficient: ids come from rendered,
  tag-stripped, entity-decoded heading text).

### Checks — extend `scripts/check-docs.mjs`

1. Mirror completeness: every REQUIRED_DOCS name exists in `docs/zh-CN/`.
2. Link checks run over zh files and `README.zh-CN.md`, resolving in the
   files' actual locations.
3. Structural parity per language pair (all eleven: README pair + ten
   docs; fences with no exemption once the README fix lands): equal heading
   level sequences; fenced blocks pairwise byte-equal including info
   strings; link-target path multiset equal. The two language-switch lines
   are the single documented exemption from target equality — they are
   validated instead by the build test (exact hrefs).
4. Anchors: for every anchor link, the anchor must be found among
   `headingSlugs` of the EN counterpart of its resolved target (zh files
   carry copied en anchors — a mappability check); the emitted zh id is the
   same-index entry of the zh counterpart's `headingSlugs`, whose existence
   the parity checks guarantee. Bare `#anchor` links check against the
   file's own en counterpart. The build test pins one concrete case.

### Build-level test (new; round-1 fix)

`test/docs-site.test.ts` runs the builder into a temporary out dir
(builder gains an out-dir override; default stays `_site/`) and asserts
exact hrefs per sample page: zh home English switch `../index.html`; en
home 简体中文 switch `zh/index.html`; switcher hrefs on a sample doc pair
(both directions). It also resolves every emitted href on those sample
pages against the built tree (target exists; no repeated `/zh/` segment),
checks the zh settings→index anchor via `headingSlugs`, `lang`
attributes, hreflang pairs, and the sitemap's 11 zh URLs. Runs in
vitest / CI.

### npm package

Ship the translations. `scripts/package-smoke.mjs`: collect docs top level
PLUS `docs/zh-CN` top level only (not recursively — recursion would pull
`docs/design/` and contradict `!docs/design`); allowlist adds
`docs\/zh-CN\/[a-z0-9-]+\.md`; update `expectedFiles`.
`test/package-tar.test.ts`: extend the fixture entries for representative
coverage. `package.json` unchanged (`docs` includes subdirectories; the
files array is pinned exactly by package-metadata test).

### pages.yml

Add `"README.zh-CN.md"` to `paths` (`docs/**` already covers
`docs/zh-CN/**`).

### README links

- `README.zh-CN.md`: the site link becomes
  `https://fishinsalt.github.io/ink/zh/` (self-reference on the built zh
  home accepted). `README.md` unchanged.

### Rollout

- Branch `docs/zh-docs-site`; this design first; implementation only after
  the design review closes; independent code review before merge; `--no-ff`
  merge; Pages redeploy verified; CHANGELOG Unreleased entry.
- Translation in batches of 3–4 files by fresh-context subagents given the
  glossary, the rules, and the anchor/map notes. Intermediate batches may
  leave mirror-completeness/sitemap checks and the suite red (strict
  completeness only holds once every file exists); per-file parity checks
  run as each file lands, and the full suite plus all checks must be green
  on the final commit before review. Live spot-checks (switchers both ways,
  anchors, sitemap) follow deploy.

## Review history

- Round 1 (fresh-context, adversarial): verdict "not ready — changes
  required", 11 findings. Folded here: (F1) link contract split into
  resolution base vs output base + explicit per-language map; (F2) anchor
  re-slug policy + checks + pinned case; (F3) pages.yml paths; (F4)
  switch-line hrefs specified + pinned by test; (F5) build-level test added;
  (F6) main-guard + shared `headingSlugs`; (F7) smoke collection spelled
  out; (F8) per-language strings table; (F9) parity checks strengthened
  (level sequences, info strings, multisets, README pair); (F10) strict
  mirror kept, cost accepted; (F11) no other pins; package-metadata pins
  recorded.
- Round 2 (same reviewer, confirmation): verdict "not ready — changes
  required", 8 text-level findings: README-pair fence compliance (day-one
  failure), check-4 wording vs rule 2, heading-order rule, a vacuous
  doubled-path assertion, bare-anchor coverage, the README.zh-CN line
  number, batch-red rollout wording, and the README.md-map future note.
  All folded; round 3 confirmation under way.

## Resolved open questions

1. Strict mirror: yes — a missing translation fails CI; no exemption list.
   Cost accepted: a new REQUIRED_DOCS entry forces a translation, consistent
   with the repo's docs rules.
2. README.zh-CN site link: `/zh/`.
3. Parity strength: heading level sequence + fenced blocks (with info
   strings) + link-target multisets + README pair in scope.
4. `x-default` → en: kept; no counter-argument found.
5. Other pins: none beyond `pages.yml` and the new build test;
   package-metadata pins respected (`files` unchanged; `homepage` stays the
   site root).
