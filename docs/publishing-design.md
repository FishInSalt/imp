# 发布设计：npm 首个公开版本与持续发布

状态：修复待复核（2026-09-26，独立评审 B×1/S×4/N×6 已逐条修复）
分支：本设计 `docs/publishing-design`；实现批次 `release/ci-publish`
参考：npm trusted publishers 文档（docs.npmjs.com/trusted-publishers）；npm community
讨论 #176761（首包引导的循环依赖）；PROJECT_PLAN.md:602（路线图原猜测发 scope
包 `@<user>/imp`，bin 名仍设为 `imp`）；前置批次 #npm-packaging（打包侧已就绪，见
PROJECT_PLAN.md:99）

## 0. 目标

- 首个公开版本 `imp-agent@0.1.0` 发布到 npmjs.com，**带 provenance**（构建来源证明）。
- 后续版本一条命令发布：打 tag → CI 全门禁 → OIDC 免 token 发布。
- 用户侧安装路径成型：`npm install -g imp-agent` / `npx imp-agent`，命令仍是 `imp`。

验收场景：

1. 首版：维护者按 RELEASING.md 手工发布 → `npm view imp-agent version` 为 `0.1.0`；
   干净环境 `npm i -g imp-agent` 后 `imp --version` 正常。
2. 后续版：`git push origin v0.1.1` → release workflow 全绿 → npm 上出现 0.1.1
   且带 provenance attestation。
3. tag 与 `package.json` 版本不一致 → workflow 失败，绝不发错版本。

**非目标**：Windows 支持（见 README Platform support）；Homebrew tap；单文件二进制；
扩展包分发（M4 延后项，路线图见 PROJECT_PLAN.md:602，另行设计）。

## 1. 决策记录（已拍板）

### D1 包名 `imp-agent`、命令 `imp`（已落地，#npm-packaging）

npm 上 `imp` 已被占用（v0.0.1，2022），且 `imp-cli` 亦被占。**偏离路线图猜测**
（D 参考中的 scope 包）：改为无 scope 的 `imp-agent`——安装命令短、无需账号开
scope；`bin` 仍只有 `imp` 一条，包名与命令名解耦。

### D2 引导路径：首版手动发布，之后 OIDC

trusted publisher 的配置入口在**包设置页**，而包设置页只有在包已存在后才出现——
首包存在循环依赖（社区讨论 #176761 已证实）。因此：

1. v0.1.0 由维护者本机 `npm login`（2FA）后 `npm publish`；
2. 随后在 npm 包设置里绑定 GitHub Actions（仓库 + workflow 文件名 `release.yml`）；
3. 从下一版起 CI 用 OIDC 发布，**不引入任何长期 token**。

备选（评估后不采用）：granular access token + repo secret（凭据长期存在、90 天轮换、
泄露面大）；staged publishing（新增人工审批步，当前规模不值；记为将来可选增强）。

### D3 发布触发器 = 版本 tag；版本漂移由三层守卫封死（含手工引导步）

- tag 形如 `v0.1.0`（annotated），只打在 main 上；workflow 的校验语义**有意取
  “祖先关系”而非“等于 origin/main tip”**：既挡住“tag 打在没有并入 main 的 commit
  上”，又允许对一个已发布的旧 tag 重跑 workflow（绑定修正后重试的场景）。校验命令
  固定为 `git merge-base --is-ancestor "$(git rev-parse "$GITHUB_REF^{commit}")"
  origin/main`（checkout 取 fetch-depth 0，并先 `git fetch origin main`）。
  “tag 打在 main 的旧提交上”由 RELEASING.md 的流程纪律禁止（发布一律在 main HEAD
  打 tag）。
- 版本一致性三层守卫：①`test/package-metadata.test.ts` 钉 `src/format.ts` VERSION
  == package.json version（已存在）；②release.yml 校验 tag 去 `v` 前缀 ==
  package.json version；③手工引导步（v0.1.0 本机发布）**不经 release.yml 的发布
  路径**，因此在 RELEASING.md 的 checklist 里给出一条显式命令：
  `test "$(node -p 'require("./package.json").version')" = "${TAG#v}"`。
  三者合起来覆盖“CI 路径 + 手工路径”——设计初稿只写了①②，被独立评审指出手工
  首发布恰恰没有守卫（S1）。
- 版本策略：semver。0.x 期间 minor 可含行为变更；CLI 参数与扩展 API 尚无稳定承诺
  （README/docs 不写兼容保证）。

### D4 发布闸门：仓库变量 `NPM_PUBLISH_ENABLED`

publish job 的真实发布步骤仅在仓库变量 `NPM_PUBLISH_ENABLED == 'true'` 时执行；
否则**跳过但必须显眼**：`echo "::warning::publish skipped (NPM_PUBLISH_ENABLED != true)"`
并写 job summary，run 保持绿（gate 是 run 的主角）。设定原因：

- v0.1.0 的 tag 在绑定 trusted publisher **之前**就要推（tag 是发布的不可变锚点），
  没有闸门会得到一次注定失败的红 run 或一次未授权发布尝试；
- 变量同时是紧急刹车（设回 false 即停发，无需改代码）。

时序：实现 release.yml（开关未被设置）→ 手工发布 v0.1.0 + 推 tag（workflow 跑
门禁、干净跳过 publish）→ 绑定 trusted publisher → 设变量 `true` → 下一版起 CI 发布。
“绿而无发布”是刻意接受的引导期行为，但也是误判面：RELEASING.md 的验收要求核对
warning/job summary，不得只看 run 颜色（独立评审 S2）。变量同时是紧急刹车。

### D5 release.yml 结构

- 触发：`push: tags: ["v*.*.*"]` + `workflow_dispatch`（输入 `dry_run`，默认 true）。
- job `gate`：与 ci.yml 相同的五步门禁 + 打包冒烟（步骤体与 ci.yml 同步，允许重复，
  不抽 composite action——两份 10 行 vs 一个共享抽象，当前规模选前者）；顺带给
  ci.yml 的打包冒烟步骤补 `name: packaging smoke`（现在 UI 显示首行 `mkdir -p …`）。
- job `publish`（`needs: gate`）：`ubuntu-latest` × Node 24 单跑（发布只跑一次；
  引擎下限 `>=20` 由 ci.yml 的 20/24 矩阵继续守护）；权限 `id-token: write` +
  `contents: read`。
- **npm CLI 版本前置（独立评审 B1）**：trusted publishing 要求 npm CLI ≥ 11.5.1
  （Node ≥ 22.14，Node 24 已满足后者）。publish job 在 `npm ci` 前先
  `npm install -g npm@latest` 并断言版本满足下限——setup-node 自带的 npm 若偏旧，
  OIDC 会静默退回 legacy token 流、报错含糊，必须显式升级。
- 步骤：checkout（fetch-depth 0）→ `git fetch origin main` → tag-on-main 校验
  （D3 的命令）→ tag/版本一致性校验 → `npm install -g npm@latest` → `npm ci` →
  `npm publish --provenance --access public` → 轮询 `npm view imp-agent@<version>
  version` 确认注册表可见 → 打印 provenance 链接。
- 发布/干跑的分支条件（独立评审 S4：`workflow_dispatch` 不得成为第二条真发布入口）：
  - 真发布步：`startsWith(github.ref, 'refs/tags/v') && vars.NPM_PUBLISH_ENABLED
    == 'true' && inputs.dry_run != true`；
  - 干跑步：`inputs.dry_run == true || !startsWith(github.ref, 'refs/tags/v')`，
    跑 `npm publish --dry-run --access public`（不写注册表，供绑定前探测）；
  - 跳过通报步：tag 推送且变量非 true 时打 `::warning::`（D4）。
  于是“在任意分支上手工派发”最坏也只是干跑，真发布只可能发生在 tag 上。
- 失败语义：任一步失败即停；**不做自动重试**——同 tag 重跑会因版本已存在而失败，
  属预期行为（RELEASING.md 写明：失败后先修因，再决定是删 tag 重来还是发下一版）。

### D6 GitHub Release 手动创建（保持最小权限）

publish job 只申请 `contents: read`，不代发 GitHub Release；RELEASING.md 给一条
`gh release create vX.Y.Z --verify-tag --generate-notes`。理由：发布到 npm 与发布
GitHub Release 是两个独立对外动作，分开做便于各自确认；将来嫌烦可并入 workflow
（需 `contents: write`，触发条件=每月发布 >3 次）。

### D7 CHANGELOG 维护方式

Keep a Changelog 风格，手写；发布前把 `## [Unreleased]` 落成 `## [x.y.z] - 日期`。
首个版本只写一段能力摘要并指向 README 的 Status 段（避免同一份"当前能力"在
README 与 CHANGELOG 两处并行腐烂——这是 #readme-refresh 的教训）。

### D8 回滚/撤回策略

- 发布出错优先**补丁版本**修复（0.1.1）；
- `npm unpublish` 仅限发布后 24h 内且确有必要——版本号永久作废、对下游是破坏性；
- 已发布版本若发现缺陷，`npm deprecate` 标记并附替代版本指引。

## 2. 首版发布流程（RELEASING.md 将落地的步骤）

前置：main == origin/main、CI 绿、工作区干净且 `git rev-parse HEAD` == 拟打 tag 的
commit、npm 账号已登录（2FA）。

1. **tag/版本一致性 checklist 核对**（手工路径的守卫，S1）：
   `test "$(node -p 'require("./package.json").version')" = "0.1.0"`。
2. 在 main HEAD 上打 annotated tag 并推送：`git tag -a v0.1.0 -m "imp-agent v0.1.0"`
   → `git push origin v0.1.0`；workflow 跑门禁后按 D4 打 warning 跳过真发布
   （闸门未开）。
3. 手工发布：在**工作区干净且 HEAD 即 tag commit** 的状态下
   `npm publish --access public`（仓库根；`prepare` 会构建）。
4. 验证：`npm view imp-agent version` → `0.1.0`（registry 传播有延迟，未见就等
   30s 重查，同 D5 轮询语义）；`npm i -g imp-agent@0.1.0` 冒烟；npm 包页检查
   README 渲染、repository 链接、provenance 徽标。
5. 绑定 trusted publisher：包设置 → Trusted Publisher → GitHub Actions → 仓库
   `FishInSalt/imp`、workflow **文件名** `release.yml`（表单填文件名，不带
   `.github/workflows/` 前缀；实施时以 npm 当前 UI 为准）。
6. 设仓库变量 `NPM_PUBLISH_ENABLED=true`。
7. GitHub Release：notes 取 CHANGELOG 里该版本的段落（单一事实源，不用
   `--generate-notes` 的自动 PR 列表）——手工粘贴或用
   `gh release create v0.1.0 --verify-tag --title "imp-agent v0.1.0" --notes-file <文件>`。

失败尾巴（明示）：tag 已推而手工发布失败 → 修因后原 tag 继续用（闸门仍关，不会
再触发发布尝试）；手工发布成功而 tag 推送失败 → 补推 tag（tag 与内容仍一致）。

## 3. 测试与验证计划

- 本地（实现批内）：`npm publish --dry-run` 全量检查元数据与 tarball 内容（若
  CLI 在该模式下仍要求登录，记录之，不改设计）。
- CI 探测（绑定前）：`gh workflow run release.yml -f dry_run=true` 真跑一遍
  gate + dry-run publish，验证语法/权限/变量闸门路径。
- 发布后（首版验收）：干净环境 `npm i -g imp-agent` 冒烟；npm 页面元数据检查。
- 常驻钉子：tag/版本一致性校验 + tag-on-main 校验（release.yml 内）+ publish job
  内断言 npm CLI ≥ 11.5.1（B1）+ `test/package-metadata.test.ts`。
- 闸门可辨识性检查：变量未设时推 tag，确认 run 绿、且出现 publish-skipped warning
  与 job summary（S2）——这是“绿而无发布”误判面的验收。

## 4. 风险与开放问题

- **npm 侧新能力**：npm 已提供 `npm trust` 命令与 staged publishing；实施前先查
  是否支持"未发布包预绑定 trusted publisher"——若支持则可砍掉 D2 的手工引导步。
- **白名单漏项**：发布批之后再往包里加运行时资源文件（模板/示例等）必须同步
  `files`；现有 CI 断言只覆盖"白名单外顶层目录不出现"，不覆盖"dist 里新增但未
  打包"这类；触发条件=任何新增运行时资源的批次。
- **名称抢注窗口**：`imp-agent` 至今空闲（2026-09-26 复查 E404）；发布前被抢注
  则需改名，触发条件=首次发布前发现被占。
- **provenance 前置**：公开仓库 + 云 runner（均满足）；self-hosted runner 不支持。
- **npm 账号**（开放问题 Q1）：用户名、2FA 状态需维护者提供；账号上的显示名会
  公开出现在包页。
- **Environment 保护**（开放问题 Q2）：是否给 publish job 加 GitHub Environment
  （required reviewers）——默认不加（单人仓库，审批步=自己批自己）；记录为可选。
  将来若要开放 `workflow_dispatch` 的真发布路径，Environment 审批是首选保护
  （与 S4 的派发约束同批决策）。
- **首版 CHANGELOG 措辞**（开放问题 Q3）：随实现批给出草稿，维护者确认。

## 5. 文件清单与规模

- 新增：`docs/publishing-design.md`（本文）；实现批新增 `.github/workflows/release.yml`
  （~60 行）、`CHANGELOG.md`、`RELEASING.md`（~80 行）。
- 修改：`.github/workflows/ci.yml`（打包冒烟步骤补 `name:`，1 行）。
- 不动：`package.json`（`files` 不带 CHANGELOG/RELEASING——它们不参与运行时，npm
  页面由 README 与元数据呈现）。
- 流程：实现批经 `release/ci-publish` 分支、独立评审、`--no-ff` 合入 main；合入前
  更新 PROJECT_PLAN.md 账本（承接 #npm-packaging 的 P3 遗留）。
