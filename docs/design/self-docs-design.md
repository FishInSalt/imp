# Self-Docs — 功能文档目录、随包发布与系统提示路由

Status: rev 3（评审 closed：rev 2 关闭全部 4 blocker，rev 3 落实复核的 3 条一行级编辑；评审 session b8c54e23 结论"关闭后无需再次全量评审，可直接进入实施"）
Branch/worktree: `self-docs`（`../ink-self-docs`）
Scope: 文档重组 + 功能文档补齐 + 发布物 + 系统提示注入。**不含** bash env 运行时事实注入、tool-search/codemode、read 表现层（均推迟，见 §0）。

## 0. 问题与结论

**问题**：用户问"ink 怎么配置 MCP / 怎么写扩展 / sessions 存在哪"时，模型只能靠训练记忆或现场翻源码回答——npm 发布的 ink 里没有可读文档（`files: ["bin", "dist", "README.md", "LICENSE"]`），系统提示里也没有指向自身文档的任何路径。

**参照**：pi v1.0.4 的自查机制（§1）。核心 = 文档随包发布 + 系统提示注入"主题→文件路由表" + 渐进披露守卫。没有专用检索工具、没有向量库。

**结论**：三层落地——

1. docs/ 重组：设计档案迁至 `docs/design/`（不发布），功能文档留顶层；
2. 补齐功能文档（读者 = 终端用户 + 模型，二写合一），README 瘦身为概览；
3. `package.json` files 增补（`"docs"`, `"!docs/design"`, `"examples"`, `"CHANGELOG.md"`）+ smoke 白名单放宽 + 系统提示 docs 路由段（注入 `buildSystemPrompt`）。

**明确推迟**（非目标）：bash env 注入（INK_* 变量）；read 工具 docs 紧凑标签（评审 N3：与自查主目标正交，独立分支做）；docs.json 导航文件（评审 N2：pi 的 docs.json 运行时零引用，ink 无消费者，砍掉）。

## 1. pi 机制摘要（参照基线，含量级修正）

- `packages/coding-agent/package.json` `files` 含 `docs`、`examples`、`CHANGELOG.md`；`src/config.ts` `findNodePackageDir()` **自下而上查找最近 package.json**（支持 `PI_PACKAGE_DIR` 覆盖），`getDocsPath()` 基于它。
- `src/core/system-prompt.ts` 把提示拆成命名 section，其中 `docs` section 固定含：绝对路径三行（readme/docs/examples）、cwd 误解析警告、主题→文件路由表、跟随交叉引用规则。
- **量级实测**（评审 B3 修正）：pi 的 docs section 含绝对路径约 1600 字符 ≈ **400 token**，并非先前估计的 150 token。ink 的预算据此定为 **≤280 token（≈1100 字符）**，见 D4。
- 四要素：绝对路径 / 主题→文件路由表 / "仅问到自身时才读"守卫 / 跟随交叉引用。

## 2. 现状盘点（ink @ 1c27f38，评审 B1 补全后的引用面）

- `docs/`：74 文件（git 跟踪），仅 `skills.md` 是功能文档，其余全为设计/分析/评估记录。
- `package.json` `files`: `["bin/ink.js", "dist", "README.md", "LICENSE"]`——docs、examples、CHANGELOG 均不发布。
- `scripts/package-smoke.mjs`: `allowed` 正则白名单（第 21 行）仅放行 `package.json|README.md|LICENSE|bin/ink.js|dist/...`；`validateFiles()`（第 44-45 行）是 **allowed 正则 AND permittedPaths 精确集合**双重收紧——改 files 字段必须同步 `expectedFiles()` 复刻 files 语义（含否定排除），否则 smoke 必挂。
- **引用面全清单**（迁移 `docs/*-design.md` 等文件时必须同步更新的位置）：
  - `README.md`：5 处 `docs/...` 链接（其中 2 处指向设计档案）；
  - `PROJECT_PLAN.md`：58 处；
  - `RELEASING.md`：4 处（复核实补，如 :26 指向 publishing-design.md）；
  - `src/`：**30 个文件约 35 处**注释引用 `docs/*-design.md`（设计追溯标记，如 `compaction.ts:61`）；
  - `test/`：**15+ 个文件**引用（头部注释为主，如 `bash-tool.test.ts:2`、`guardian.test.ts:3`、`fresh-install-hint.test.ts:14`）；
  - `test/package-tar.test.ts:153` 与 `test/release-guards.test.ts:133`：两处 `docs/x.md` **拒绝反例**；
  - `CHANGELOG.md`：8 处（历史条目，见 D1 政策）；
  - `examples/extensions/web-search/README.md:231`：指向设计档案（发布物内断链，必须处理）；
  - `.github/workflows/release.yml:3`：注释引用；
  - `docs/` 内部互链：45 个文件。
- `src/core/system-prompt.ts`: `buildSystemPrompt()` 纯函数、无自身文档引用；现有测试 `test/system-prompt.test.ts` 25 用例打这个纯函数。`assembleSystem()`（runner.ts:740-822）负责 override/append、context、extension sections、skills、agents 的拼接，skills 注入有 `tools.some(t => t.name === "read")` 门控先例。
- `src/env.ts:29`：固定 `resolve(dirname, "..")`（**不是**向上查找——它成立仅因 env.ts 位于 src 顶层；不可直接复用于 src/core/ 下的新文件，D2 改述）。
- 本机 npm 全局 `ink-agent` 是指向本仓库的 symlink，开发环境 docs 可达 ≠ 发布环境可达。

## 3. 决策

### D1 文档分层与引用迁移政策
- 功能文档 = `docs/*.md` 顶层（发布）；设计档案 = `docs/design/`（不发布）。
- `docs/skills.md` 留顶层（功能文档）。
- **引用更新政策分三类**：
  1. **活文档**（README、PROJECT_PLAN、AGENTS、RELEASING、src/test 注释、release.yml、docs/ 内部互链）：全部改为 `docs/design/...` 新路径，不留断链；
  2. **历史条目**（CHANGELOG 已发布版本节）：**不改写**——历史记录的链接指向当时的位置，接受失效；在风险表登记。CHANGELOG 仅在新增 Unreleased 条目时写新路径。
  3. **发布物内引用**（examples/web-search/README.md）：改为 GitHub 仓库绝对链接（发布物内相对路径无意义），或删链接留文意。
- 设计文档自身（本文件）迁移完成后归档至 `docs/design/`。

### D2 功能文档清单（10 个，新建/保留）
读者双重（用户 + 模型）。体例：单文件目标 ≤200 行、主题单一、文件头 3-5 行"何时读本文"导读、相对链接交叉引用。内容来源 = README 对应章节下沉改写（事实不改写，压缩为概览+链接）。

| 文件 | 主题 | 来源 |
|---|---|---|
| `docs/index.md` | 目录 + "何时读哪个"导航 | 新建 |
| `docs/skills.md` | skills | 保留，补交叉引用 |
| `docs/extensions.md` | 扩展：api 面、加载层级、guardian | README Extensions 下沉 |
| `docs/mcp.md` | MCP：stdio/HTTP、OAuth 边界 | README MCP 下沉 |
| `docs/subagents.md` | task 工具、agent profiles、worktree 隔离 | README 章节合并下沉 |
| `docs/sessions.md` | JSONL 会话、/tree /fork、压缩 checkpoint | README Sessions+Compaction 下沉 |
| `docs/settings.md` | settings.json 全字段 | settings.ts + README |
| `docs/providers.md` | 5 provider、/login、key 与 plan | README Providers 下沉 |
| `docs/images.md` | 视觉模型、粘贴、resize 阶梯 | README Images 下沉 |
| `docs/cli.md` | CLI flag 参考 + print/pipe | cli.ts --help 改写 |

README 瘦身后保留：一句话定位、安装、最小 quickstart、指向 `docs/index.md` 的文档入口、License（pi 分工：README ≈95 行概览）。

`docs/environment-variables.md` 推迟（env 注入后续批次；文档不承诺尚不存在的变量）。

### D3 发布物
- `package.json` `files`: `["bin/ink.js", "dist", "docs", "!docs/design", "examples", "CHANGELOG.md", "README.md", "LICENSE"]`。目录级否定 `!docs/design` **已实验验证有效**（评审员独立复验通过）。
- `scripts/package-smoke.mjs` 三处同步：
  1. `allowed` 正则新增 `docs/[^/]+\.md`、`examples/**`、`CHANGELOG.md`（docs/design/** 仍被拒）；
  2. `expectedFiles()` 复刻 files 语义：遍历 docs/ 顶层 .md（不含 design/）与 examples/ 全部文件加入 permittedPaths；
  3. `required` += `docs/index.md`（守住在售文档入口）。
- `test/package-tar.test.ts:153`、`test/release-guards.test.ts:133`：`docs/x.md` 反例改为 `docs/design/x.md`（顶层 .md 必须放行后，design/ 必须仍被拒）。
- 发布增量预算 ≤300KB。
- 实施门控：`npm pack --dry-run` 亲眼确认 design/ 不在列表。

### D4 系统提示注入（核心）
**注入点（评审 N1 采纳）**：挪进 `buildSystemPrompt()` 纯函数——`SystemPromptOptions` 新增 `selfDocs?: SelfDocsPaths`，默认提示路径（非 override）在 tool catalog 段之后、append 段之前注入（与 pi 的 docs→addendum 相对顺序一致）；override 模式不注入（pi parity）。收益：直接获得纯函数单测（现有 25 用例同框架），无需新写 harness 级测试；runner 侧只需解析路径传入。

**路径解析**（评审 B2 修正）：新增 `resolveInstallRoot()`——自模块文件目录（src/core/ 或 dist/core/）**向上遍历查找最近的 package.json**（pi `findNodePackageDir` 语义，非 env.ts 的固定 ".."）。三态：src（tsx dev）、dist（发布）、**缺失**（docs 目录不存在，如旧版本升级现场）→ `selfDocs` 传 undefined → 注入空串，行为退化为现状，不报错。

**read 门控**（评审 N4 采纳）：`assembleSystem()` 侧沿用 skills 先例，`tools.some(t => t.name === "read")` 为假时不传 selfDocs（没有 read 工具时文档路径是死文本）。

新增 `src/core/self-docs.ts`（纯函数 + 常量，无 IO）：

```ts
export interface SelfDocsPaths { readme: string; docs: string; examples: string }
export function selfDocsSection(paths: SelfDocsPaths): string  // 缺失 → ""
export const SELF_DOCS_TOPICS: ReadonlyArray<{ match: string; doc: string }>
```

**注入文案 v2**（评审 B3：预算 ≤280 token ≈ 1100 字符，实测见 D6 断言；相比 v1 删 docs.json 行、合并两条 "When…" 为一条）：

```
Ink documentation (read only when the user asks about ink itself, its tools, extensions, skills, MCP, or sessions):
- Main documentation: {readme}
- Full docs index: {docs}/index.md
- Examples: {examples} (extensions, skills, agents)
- When reading ink docs or examples, resolve docs/... and examples/... under the paths above, not the current working directory
- When asked about: extensions (docs/extensions.md), skills (docs/skills.md), MCP (docs/mcp.md), subagents and worktrees (docs/subagents.md), sessions and compaction (docs/sessions.md), settings (docs/settings.md), providers and models (docs/providers.md), images (docs/images.md), CLI (docs/cli.md)
- When working on ink topics, read the docs and follow cross-references before implementing
```

主题表保留 9 项（评审 Q2 裁决：主题表是机制核心，不可精简为一行索引；D2 的 environment-variables.md 推迟后为 9 条——评审 N2 修正）。

### D6 校验与测试
- 新增 `scripts/check-docs.mjs`（并入 `npm run lint:scripts`）：
  (a) D2 清单 10 文件存在；
  (b) 顶层 docs/*.md 的相对链接目标存在；
  (c) SELF_DOCS_TOPICS 与 `docs/index.md` 导航引用的文件一致存在。**机制**（评审 N5）：topics 单一事实源 = `src/core/self-docs.ts` 常量；脚本用正则从该文件提取 `doc: "..."` 字面量（常量格式受约束、有测试钉住），不做 tsx 执行。
- 单测：`selfDocsSection()` 两态（完整路径/undefined）+ **长度上限断言 ≤1100 字符**；read 门控与注入位置由 `buildSystemPrompt`/runner 用例覆盖（门控在 assembleSystem 侧，非纯函数职责）；`resolveInstallRoot()` 三态（src/dist/缺失，tmp 目录构造）；`buildSystemPrompt` 新增 selfDocs 用例（注入位置：catalog 后、append 前；override 不注入）。
- package-smoke 全量跑（tarball 含 docs/ 顶层与 examples/、不含 design/）。
- 现有 `test/system-prompt.test.ts` 25 用例回归。

## 4. 迁移清单（实施顺序）

### 4.1 归类与引用迁移（D1 政策三分类）
- **留顶层**：skills.md。
- **迁 docs/design/**：73 个设计/分析/评估文件，`git mv` 保留历史。
- 引用更新（全量，按 §2 清单）：README 5、PROJECT_PLAN 58、RELEASING 4、src/ 30 文件 35 处、test/ 15+ 文件、release.yml 1、docs/ 内部互链 45 文件；两个拒绝反例改路径；CHANGELOG 不动（政策 2）；web-search README 改绝对链接（政策 3）；本设计文档归档。
- 完成判据：`grep -rn --exclude=CHANGELOG.md --exclude-dir=design -E "docs/[a-z0-9-]*-design|docs/(compaction-ratio-threshold|live-thinking-toggle|mcp-http-transport-scoping|ink-local-install)" README.md PROJECT_PLAN.md RELEASING.md AGENTS.md src/ test/ .github/ docs/` 零命中（CHANGELOG 除外——政策 2 不改写历史）。

### 4.2 功能文档撰写（D2）+ README 瘦身
### 4.3 发布物（D3）：package.json / smoke 正则 / expectedFiles / 反例
### 4.4 self-docs.ts + buildSystemPrompt 注入 + runner 传参（D4）
### 4.5 校验脚本与测试（D6）
### 4.6 全链路验证：`npm run typecheck && npm run lint && npm test && npm pack --dry-run`

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| npm files 否定模式边界（嵌套目录等） | 已双重实验验证；实施时 `npm pack --dry-run` 门控 + smoke 断言 |
| 功能文档与实现漂移（长期最大风险） | AGENTS.md 增约定：功能 PR 同步更新对应 docs/*.md；check-docs.mjs 守结构 |
| token 预算失控 | selfDocsSection 输出 ≤1100 字符单测断言（实测口径，v1 文案曾超标已压缩） |
| **发布物内断链**（CHANGELOG 历史条目指向 docs/design/*） | D1 政策 2：不改写历史，接受失效，已登记 |
| README 瘦身丢信息 | 章节搬运事实不改写；CHANGELOG 记迁移 |
| 旧版本升级现场（docs 缺失） | resolveInstallRoot 三态降级为空注入（评审 N6） |
| 引用迁移遗漏 | §2 全清单 + 4.1 完成判据 grep 零命中 |

## 6. 评审记录

- **rev 1 → rev 2**（评审 session b8c54e23，approve-with-changes）：
  - B1 引用面盘点补全（src/ 35 处、test/ 15+ 文件、release-guards 反例、CHANGELOG 政策、web-search README、release.yml、本文档自身）→ §2、D1；
  - B2 env.ts 复用说法错误 → D4 改述为向上查找 package.json；
  - B3 预算矛盾（v1 文案 941 字符超 800 上限；pi 基线 150→400 token 修正）→ §1、D4 压缩文案 + 预算 1100 字符实测断言；
  - B4 smoke 改动具体化（双重收紧、expectedFiles 复刻）→ D3；
  - N1 注入点挪 buildSystemPrompt、N2 砍 docs.json、N3 表现层移出、N4 read 门控、N5 check-docs 机制、N6 风险补行 → 全部采纳。
- 评审员裁决采纳：Q1 保留 `!docs/design` 方案；Q2 主题表保留全部主题条目（实现为 9 项）；Q3 README 瘦身边界；Q4 不引入 docs.json；Q5 表现层独立分支；Q6 引用清单如 §2。

## 7. 评审记录（已关闭）

rev 3 为终版。遗留复核意见 3 条（RELEASING 引用、grep 判据、D6 措辞）已在 §2、§4.1、D6 落实。评审员明确：关闭后可直接进入实施，无需再次全量评审。
