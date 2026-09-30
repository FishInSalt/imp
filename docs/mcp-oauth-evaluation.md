# OAuth 型远程 MCP 服务器 — 立项评估（GitHub 需求预判）

状态：评估报告（结论：暂不立项；触发条件见 §5）
日期：2026-09-29
关联：`docs/mcp-http-transport-scoping.md`（HTTP 传输在案，批 A 含静态 `headers`）；`docs/mcp-completeness-analysis.md`（M18 D5 第 1 项的 OAuth 子项）

## 0. 结论

- **GitHub 需求不需要 OAuth 就能满足**：官方远程端点（`https://api.githubcopilot.com/mcp/`）明确支持 PAT——`headers: {"Authorization": "Bearer <PAT>"}`；本地 stdio 版今天就能用。前者在 HTTP 传输批 A/C 落地后即可用（headers + env 展开已在批 A 范围），后者零代码改动。
- **OAuth 不建议现在立项**：对 GitHub 而言 OAuth 的成本被两件事抬高——GitHub 授权服务器**不支持动态客户端注册（DCR，已实测）**，第三方客户端必须自带注册好的 GitHub App/OAuth App；以及 imp 侧还需要令牌存储/刷新/回环回调等一整套新面。工程量不低于 HTTP 传输本身，且有产品层面的长期责任（持有并维护一个 GitHub App）。
- **保留延后，触发条件**（任一命中再立项，见 §5）：EMU/组织禁用 PAT；必须接入一个只支持交互式 OAuth 的服务器；明确要求"不给用户发长寿命 token"的一键授权体验。
- 若立项，GitHub 的授权服务器质量不差（PKCE S256、refresh、device flow 都在），只是 DCR 缺失决定了"要不要注册 imp 自己的 App"必须先拍板。

## 1. GitHub 侧事实（2026-09-29 核实）

- 远程端点：`https://api.githubcopilot.com/mcp/`（Streamable HTTP）。官方文档：GitHub MCP server 对**所有 GitHub 用户**可用（不要求 Copilot 许可；个别工具按对应功能继承许可要求）。
- 认证两条（官方文档原文："uses one-click OAuth authentication by default, but you can also manually configure it to use a personal access token (PAT)"）：
  - OAuth（一键）；
  - PAT：文档给出配置 `Authorization: Bearer YOUR_GITHUB_PAT`（Visual Studio / JetBrains 段落同款）。
- EMU 注意：Enterprise Managed User 的 PAT **默认禁用**（管理员可开）；PAT 被禁时走 OAuth——前提是"each host application must have a registered GitHub App (or OAuth App)"（policy 文档）**且该 App 已获组织启用**（官方注记：除 VS Code/VS 外，各客户端的 OAuth App 都需被启用）。
- OAuth 实测（匿名探测）：
  - 401 响应头带 `WWW-Authenticate: Bearer ... resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"`；
  - PRM：`authorization_servers: ["https://github.com/login/oauth"]`，`scopes_supported` 覆盖 repo/org/packages 等，`bearer_methods_supported: ["header"]`；
  - AS 元数据（RFC 8414 路径插入变体可读）：`authorization_code` + `refresh_token` + device flow、PKCE `S256`、`device_authorization_endpoint` 都有；**没有 `registration_endpoint`** ——即无 DCR。
- 本地 stdio 版（`github/github-mcp-server`）：PAT 环境变量，Docker/二进制；imp 现有 stdio 传输直接可用。

## 2. imp 侧可行路径（均不需要写 OAuth）

| 路径 | 何时可用 | 配置要点 |
|---|---|---|
| A. 本地 stdio + PAT | 今天 | env 传 PAT（现有机制） |
| B. 远程 url + PAT header | HTTP 传输批 A/C 落地后 | `headers: { "Authorization": "Bearer ${GITHUB_PAT}" }`——静态头、env 展开、脱敏都在批 A 范围 |
| C. 复用 `gh` 的登录态（待验证） | 今天起可试验 | `export GITHUB_PAT=$(gh auth token)` 后走路径 A/B；注意：官方承诺的是 PAT（`ghp_`/`github_pat_` 前缀），`gh` 的 `gho_` 令牌是否被 MCP 端点接受**未经验证**——不行就回到"用 gh 辅助创建 PAT" |

路径 A/B（及 C 若验证成立）都建议 fine-grained PAT、最小权限、`${GITHUB_PAT}` 环境变量（不落明文配置）。注意 imp 的 env 展开不执行命令（pi 的 `!command` 秘密展开是有意没有对齐的面；若要引入需单独过安全评审）。

## 3. 若做 OAuth：成本在哪

- **规模参考**：pi 的 OAuth 相关 3 个文件共 3378 行（`mcp-oauth-provider.ts` 819 行 + `mcp-auth.ts` 1262 行 + `mcp-auth-flow.ts` 1297 行），另有令牌存储/keyring 辅助；Claude Code `auth.ts` 2465 行。imp 最小子集（PRM/AS 发现 + 授权码+PKCE + 回环回调 + refresh + 令牌存储）也 ≥ HTTP 传输批次。
- **GitHub 特有**：无 DCR → 要么 imp 注册并长期持有自己的 GitHub App（client 分发、secret 或 public client 形态、组织策略适配），要么允许用户自带 client_id（配置面变复杂）。这是产品承诺，不是代码问题。
- **令牌存储**：钥匙串/加密文件/明文的选择——pi 用键环且 fail-closed，CC 用 keychain；imp 在"零新增依赖"约束下需要单独立项（macOS `security` CLI、Linux secret-tool 的可用性矩阵）。
- **TUI 交互面**：打印授权 URL、等待回环回调、超时/拒绝/重试、`/mcp auth` 命令、登录态展示——新 UX 面，且要与 run 边界/trust 门（F1）交互。
- **失败模式**：refresh 过的令牌、撤销、多账号、离线——每个都是新的状态面。

## 4. OAuth 的收益（值不值）

- 一键浏览器授权（对手动建 PAT 的体验提升）；
- 短寿命 access token + refresh（泄露窗口小；但 GitHub 侧 refresh 本身长寿，这条的成色要打折）；
- 按会话批准 scope；
- EMU/企业策略环境在"App 获组织启用"前提下的路径；
- 注意 PAT 并不弱：fine-grained PAT 支持过期（最长 366 天，或选择不过期）、可按仓库/权限收窄、可单独撤销——"组织可审计/可撤销"不是 OAuth 独有；OAuth 的净增量主要是"不落长寿命凭据 + 按会话授权"；
- 对"多服务器、团队、企业"场景收益明显；对个人研究用途，PAT 足够。

## 5. 建议与立项触发条件

**决策：暂不立项 OAuth。** 先按已批准的 HTTP 传输路线走（批 A/C），GitHub 用路径 A/B（路径 C 待验证）。

立项触发（任一命中 → 写 OAuth 设计文档 → 独立审查 → 立项）：
1. 目标 GitHub 环境是 EMU/组织禁用 PAT；
2. 必须接入一个只支持交互式 OAuth、且无 PAT/静态头/stdio 途径的服务器；
3. 明确要求短寿命令牌/一键授权体验（产品决策，不再只是"能连上"）。

立项时的最小范围草案：PRM/AS 发现 + DCR（服务器支持则用；无则看 CIMD）+ 授权码+PKCE + 回环回调 + refresh + 令牌存储（先加密文件，键环后置）+ `/mcp auth` + **client_id 分发机制**（imp 注册 App vs 用户自带；GitHub 场景必须先拍板）；延后：device flow、XAA、多账号、企业策略面。

## 6. 对已批准工作范围的影响

- HTTP 传输批次不变——PAT/静态头路径已被批 A 覆盖，GitHub 无需额外范围。
- 建议 m19 设计文档的"非目标"把 OAuth 的延后理由更新为本评估 §5 的触发条件（替换现在"等 Tushare 真机"的单一前提表述）。

## 7. 证据与边界

- 已核实：GitHub 官方文档（remote OAuth/PAT、EMU 注记）、PRM 与 AS 元数据（本机匿名探测）、HTTP 响应头。
- 未验证：真实 PAT 与真实 OAuth 流程的端到端行为（无凭据，属验收阶段事项）；GitHub App 注册的具体审核/分发细节。
- 参考坐标：`api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/`；`github.com/.well-known/oauth-authorization-server/login/oauth`；GitHub Docs "Set up the GitHub MCP Server"；`github/github-mcp-server` policy 文档。
