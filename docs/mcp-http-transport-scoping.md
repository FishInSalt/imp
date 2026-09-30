# imp 远程 MCP（HTTP 传输）支持 — 问题梳理（Tushare 触发）

状态：问题梳理与工作分解（未写设计文档、未改产品代码）
日期：2026-09-29
触发：M18 设计 D5 第 1 项（OAuth/HTTP 传输延后）的触发条件"需要用某个远程 MCP 服务器"已命中——Tushare 官方 MCP Server 为 HTTPS 远程端点。
关联：`docs/mcp-completeness-analysis.md`（完备性分析，F1-F5 与新发现）；本文档是其"触发即按 pi 行为补"的首个响应。

## 0. 问题与结论

- **现象**：imp 的 MCP 模块只实现了 stdio 传输（`src/mcp/client.ts`：spawn 子进程 + NDJSON 分帧）。Tushare 官方 MCP 是远程端点，配置形态为 URL 内嵌 token（无 command、无 headers）：

  ```jsonc
  { "mcpServers": { "tushareMcp": { "url": "https://api.tushare.pro/mcp/token=<Tushare token>" } } }
  ```
  （来源：官方文档 tushare.pro/document/1?doc_id=463，2026-09-29 读取）

- **要做什么**：实现 Streamable HTTP 传输 + 配置层支持 `url`/`headers`。OAuth **预案不需要**（Tushare 官方配置用 URL 内嵌 token），但该端点同时广播 OAuth 元数据（见 §1），"token 即够"要等真机握手确认——不成立则走 §5.2 分支。工作主体在传输层与配置层，管理器/桥接/既有测试基建大体复用；对 imp 而言是里程碑级改动，按仓库规则先设计文档 → 独立审查 → 再实现。
- **两个已知摩擦点**（不处理就连不上/看不见，见 §2）：官方示例服务器名 `tushareMcp` 含大写会被现有命名规则逐个拒绝（服务器仍显示 connected · 0 tools——验收必须断言工具数 >0）；URL 里带密钥，全链路不得回显。

## 0.5 做完解决什么、有哪些效果

**直接解决**

1. imp 能连 Tushare 官方 MCP（及所有"URL token / 静态 headers"型 Streamable HTTP 服务器）：官方 JSON 贴进配置、重启即用，模型直接调数据工具取数——不切工具、不写脚本、不另开客户端。
2. 远程服务器与 stdio 混用无缝：同一套平铺注册、系统提示目录、`/mcp` 状态、错误进结果语义（模型可自述失败改道）、run 边界晚到注册、掉线重连——复用既有机制，无分叉。
3. Windows 上"MCP 必须 spawn"这一阻塞点消失（HTTP 无子进程、无 npx）；但 imp 整体仍不支持 Windows（bash 工具等），此效果不构成 Windows 支持。

**安全与账本**

4. F1 关闭（批 0）：未信任仓库的 `.mcp.json` 不再自动执行/外联——解决的是"克隆仓库即可执行任意命令"的越权面；远程化后该面会升级为外联+数据外泄，所以先行。
5. 密钥卫生：token 只存在于配置/env，不进入 `/mcp`、note、错误输出；重定向不跟随（实测的 https→http 降级路径被堵死）。
6. 账本对齐：M18 D5 第 1 项按触发条件兑现（HTTP 部分）；合并规则回到 M18 自己记录的"字段级合并+凭据绑定"，修掉"整体替换"在凭据面上的隐患。

**明确不解决（边界）**

- OAuth 型远程服务器（如 GitHub/Notion 的托管端点）仍连不上——Tushare 是否只需 URL token 待真机握手确认；不成立走 §5.2。
- 完备性分析的其他缺口不动：F2 工具热更新、F3 instructions、F4 图片结果、F5 管理面、S1 路径漂移等，各有触发条件。
- 不含 resources/prompts、sampling/elicitation、GET 独立流与断点恢复、每服务器超时配置。

**可观察的验收信号**

- `/mcp` 显示 `tushare: connected · N tools`（N>0）；对话调用工具返回数据，尾截断/isError/超时语义与 stdio 一致；
- 未信任目录 + 项目 `.mcp.json`：不 spawn、有 note（批 0）；
- 全仓门禁：既有 55 个 MCP 用例保持全绿 + 新增 HTTP 夹具。

## 1. 事实核实（2026-09-29）

- Tushare 官方配置：`url` 字段、token 嵌在 URL 路径（`/mcp/token=<token>`）；无 `headers`、无 `type` 字段。
- 匿名探测（未用真实 token）：`POST https://api.tushare.pro/mcp/token=invalid` → `401 {"error":"missing_token"}`（JSON）；`GET` 同址 → 同样的 401 JSON。401 只证明认证在协议之前被检查，不代表后续一定接受该 token 形态。
- OAuth 广播：401 响应头带 `www-authenticate: Bearer resource_metadata="https://api.tushare.pro/.well-known/oauth-protected-resource/mcp/"`，该元数据可读（`authorization_servers: ["https://tushare.pro"]`）。端点宣称支持 OAuth，与官方文档给的 URL token 形态可并存——"token 即够"待真机验证（§5.2 回退分支）。
- 重定向观察：`https://api.tushare.pro/mcp?token=x` → `307` 到 `http://api.tushare.pro/mcp/?token=x`（**https 降级**）。官方给出的 `/mcp/token=` 形态不经过该重定向；但实现必须禁止盲目跟随重定向（token 在 URL 里，跟随=明文外发），或至少拒绝 https→http 降级。
- 传输类型：预案按 **Streamable HTTP（2025-06-18 规范修订版）**规划；真实 token 下用真机握手确认（若服务端表现为 SSE-legacy，见 §5 增量）。
- 工具面：仅 tools 面（以真机握手为准）；同社区的 HTTP 版实现（如 duhanjun/tushare-mcp-http）给出 `tushare_query`/`test_connection` 一类工具名，仅作参照。
- imp 环境：Node `>=20`（全局 `fetch`/流式 body 可用）；M18 D3 的边界是"MCP 模块不新增依赖、不引 MCP SDK"——HTTP 用内置 fetch + 手写 SSE 解析，不新增依赖（仓内既有的 4 个运行时依赖与 MCP 无关）。

## 2. imp 侧改动面（按文件）

| 层 | 现状 | 需要做 |
|---|---|---|
| 配置 `src/mcp/config.ts` | `command` 必填；无 `url`/`headers` | 服务器条目扩展为两种形态：stdio（command/args/env/cwd）与 http（url/headers）；`command`∩`url` 互斥；`url` 值过 env 展开（三形态不变）；`headers` 对象（值均字符串、env 展开）；可选 `type` 兼容（缺省按 url 推断 http；接受 `http`/`streamableHttp`/`streamable-http` 拼写；`sse` 见 §5）；校验：https（`http://` 仅回环）、URL 可解析；**合并规则按 M18 已记触发切换**：M18 明记"引入 HTTP/凭据型服务器时改为字段级合并+凭据绑定规则"（m18-mcp-design.md:73）——本批落地字段级合并+pi 式凭据绑定（高优先源换 url 不得继承低优先源的 token/headers），或在设计文档显式重新拍板偏离；disabled/容错不变；坏条目 note 不回显 URL 原文 |
| 传输 `src/mcp/client.ts` | `McpClient` 与 stdio 绑死（spawn/NDJSON/stderr 环/信号关闭） | 抽出传输接口（建议 `{ start, send, onMessage, onClose, close }`），协议核心（pending 表/超时/abort/分页/结果映射/取消通知）原样保留；`StdioTransport` 原逻辑迁移（行为零变化，55 个既有用例必须全绿）；新增 `HttpTransport`：POST 单消息、SSE 解析、会话头、协议版本头、会话过期重初始化、DELETE 关闭、abort→`notifications/cancelled`+断流；**并发约束显式化**：v1 明确"MCP 工具保持串行"（bridge 现状不标 concurrencySafe），接口按单流设计并加测试钉住；放开并发需传输多流化（记触发） |
| 管理器 `src/mcp/manager.ts` | 进程死亡语义（exit 事件）、`forceKill` | 复用为主；`isConnected`/`onDead`/`ensureClient` 适配 HTTP 语义（无进程；"死亡"=会话失效/连续失败；`forceKill` 对 HTTP 退化为 close）；启动重试（3 次/30s 冷却）与调线重连照用；`/mcp` 状态行不变 |
| 密钥卫生 | stdio 无此面 | URL 路径 token 与 headers 值不得进入 note、`/mcp`、错误消息；边界明确到"任何被抛出/记录的字符串不得插值含 token 的完整 URL、不得回显重定向 Location"（fetch 的 TypeError/cause 链也不得携带 URL，夹具断言）；错误只留 origin+状态码+截断响应体 |
| 安全联动 | F1：项目级 mcp 配置不受 M8 trust 门约束（见完备性分析） | **F1 单列批 0、先行**（见 §4）：远程传输让"未信任仓库的 .mcp.json"从本地执行升级为外联+数据外泄 |
| 工具命名 | `^[a-z][a-z0-9_-]{0,63}$`，每个不合规工具名单独拒绝+note（服务器仍显示 connected） | 官方示例名 `tushareMcp` 含大写 → `tushareMcp_<tool>` 全部被拒后 `/mcp` 是 connected · 0 tools——验收必须断言工具数 >0。最小解：验收时把 key 改为小写（如 `tushare`）；可选：把完备性分析 S5（名称规范化+冲突检查）纳入本批 |
| 文档/账本 | M18 D5；README | README MCP 段加 HTTP 配置与 Tushare 原样示例；M18 D5 第 1 项拆分更新（HTTP 移入范围、OAuth 维持延后待真机确认） |

## 3. Streamable HTTP 实现要点（实现清单，设计文档逐条拍板）

- 单端点；每个 JSON-RPC 消息一次 POST；请求头 `Content-Type: application/json` + `Accept: application/json, text/event-stream`；通知收到 `202` 即可。
- 响应两种形态：`application/json`（单消息）或 `text/event-stream`（流内可含本次响应 + 服务器请求/通知：按 id 匹配 pending；服务器请求沿用既有应答逻辑——ping→result、其余回 -32601；流结束收尾）。
- 会话：`initialize` 响应可带 `Mcp-Session-Id`（响应体是 SSE 流时，也要在消费流之前先取响应头）→ **其后每个请求都回带**，包括 `notifications/initialized`、`notifications/cancelled` 这两个独立 POST 与 `DELETE`；无会话的服务器按每请求独立处理。
- 会话过期：收到 `404` 且此前有会话 → 重新 `initialize`（pi 有 `session-recovery.ts` 先例），复用管理器既有重连语义。
- `initialize` 之后在后续请求带 `MCP-Protocol-Version: 2025-06-18`。
- 关闭：`DELETE` 会话（服务器不支持则忽略）；abort：POST `notifications/cancelled` + 断开当前流。
- 重定向：不跟随（或禁止 https→http 降级）——token 在 URL，跟随即出网明文（§1 实测到 307 降级）。
- 代理：Node 内置 fetch 默认不读 `HTTP(S)_PROXY`；若使用环境需要代理，设计需拍板 dispatcher 策略（CC 有 proxy 支持先例；至少给出明确错误指引）。
- Windows：HTTP 路径不经 shell/npx，天然绕开 README 记录的 Windows spawn 阻塞；实现无平台分支（全局 fetch）。夹具对会话头的断言只查值、不查大小写（HTTP 头大小写不敏感）。
- v1 边界（建议，设计时定）：GET 独立流的服务器主动消息延后；`Last-Event-ID` 恢复延后；progress 通知照旧忽略；SSE 解析与 streamable 共用同一段代码以便 §5 回退。
- 诊断：以"HTTP 状态码 + 响应体片段（截断、脱敏）"替代 stdio 的 stderr 尾部环。

## 4. 工作分解（要做什么）

1. **设计文档**（建议 `docs/m19-mcp-http-design.md`）：传输接口与重构边界、配置 schema 与兼容拼写、**合并规则（字段级+凭据绑定 vs 显式偏离）**、会话生命周期与错误/重连语义、超时参数（HTTP 无 npx 冷启动，连接超时可否缩短）、重定向与密钥卫生、F1 联动方案、SSE 解析设计、并发约束（串行 v1）、测试计划、README/D5 更新、验收标准。
2. **独立设计审查**（仓库规则：不通过不开工）。
3. **实现批次**（每批自带测试，可独立走查；批 A 的合并规则需在设计文档先拍板）：
   - 批 0（安全，先行，独立走查）：F1——项目级 mcp 配置并入 M8 trust 门 + pid 见证测试；
   - 批 A 配置层：url/type/headers 解析、互斥、展开、校验、脱敏 note、字段级合并+凭据绑定 + 测试；
   - 批 B 传输抽象重构：纯重构，既有 55 个 MCP 用例全绿；
   - 批 C HTTP 传输：握手/会话/调用/abort/关闭/过期重初始化 + fake HTTP 服务器夹具（JSON 与 SSE 双响应、initialize-over-SSE 的会话头时序、通知 POST 与 DELETE 的会话头回带、MCP-Protocol-Version 见证、401/404/DELETE-405/5xx、慢调用、取消见证、重定向拒绝、大写服务器名→0 工具路径）；
   - 批 D 接线与文档：管理器状态/重连、/mcp、README、D5 更新。
4. **真机验收**（用户本地提供 token，不进仓库）：
   1) `~/.config/mcp/mcp.json` 加入 Tushare 条目（建议 `${TUSHARE_MCP_TOKEN}` 环境变量展开，避免明文落盘）；
   2) `/mcp` 显示 `tushare: connected · N tools`；
   3) 模型调用一个数据工具拿到结果；
   4) abort 与退出清理真机各验一次；"会话过期重初始化"只能在假服务器夹具上钉（真机无强制 404 手段，做尽力观察）；
   5) 全程复查输出中无 token。
5. **非目标（v1）**：OAuth 实现（前提"URL token 真机可用"成立；不成立走 §5.2）、SSE-legacy 专用传输（除非 §5.1 触发）、resources/prompts、sampling/elicitation、GET 独立流、`Last-Event-ID` 断点恢复。

预估规模：src ~+400-500 行列（HTTP 传输 250-300、配置 ~100、抽象改动 ~80），测试 ~+400-500 行；与 M18 同量级。

## 5. 回退预案（两个分支）

### 5.1 若 Tushare 实为 SSE-legacy

- 触发条件：**POST-first 探测**——向 `url` POST `initialize`，若得 404/405/406/415 一类明确拒绝（与 pi `shouldFallbackToSse` 同判据），改走 GET 长连：期待 `endpoint` 事件给出 POST 目标 + 旧握手顺序。（规范兼容探针即 POST 先行；不能反用"GET 拿到长连"当条件。）
- 增量：GET 长连 + `endpoint` 事件 + 旧握手顺序；SSE 解析与批 C 共用；参照 pi 的"仅在明确拒绝时回退 SSE"策略（避免行为漂移）。
- 预估 +1 小批（~100-150 行 + 夹具扩展）。

### 5.2 若"URL token"真机被拒/要求 Bearer

- 触发条件：真机携 token 握手仍 401/403，或响应要求 `Authorization: Bearer`（端点已广播 OAuth 元数据，§1）。
- 最小回退：批 A 已支持的静态 `headers` 可直接填 Bearer，覆盖"Bearer 直填"场景；完整 OAuth（PKCE/发现/刷新/令牌存储）仍是 D5 延后项、需单独立项——若 Tushare 强制交互式 OAuth，本目标的"最小连接"不成立，回炉重估。

## 6. 验收标准（真机，汇总）

1. 官方配置原样可用（服务器名改小写或完成 S5 规范化后）；`/mcp` connected 且**工具数 >0**（只 connected 不够——大写名会得到 connected · 0 tools）。
2. 模型调用工具返回数据；isError/尾截断/超时语义与 stdio 一致。
3. 会话过期重连、abort 取消、退出 DELETE 清理各有一条测试钉子（fake 服务器）；其中会话过期重连仅夹具可强制，真机做尽力观察。
4. `/mcp`、note、错误输出中无 token/headers 泄漏。
5. 既有 stdio 面 55 用例与全仓门禁全绿。

## 7. 风险

- Streamable HTTP 细节多（SSE 分帧、多消息混流、会话生命周期）——用假服务器夹具全覆盖后真机验收兜底。
- 真机端行为未知（是否支持 DELETE/GET、5xx 语义、会话头行为）——设计保留"服务器不支持则降级/忽略"路径。
- F1 不先修会扩大攻击面（远程外联维度的风险高于本地 spawn）——列为批 0 先行（§4）。
- 工具名规范化若纳入本批，会改动已审查过的桥接语义——需要单独设计小节与冲突规则。
- README/D5 措辞与实现同步，避免再次出现"路径清单转述不准"类偏差（见完备性分析 S1）。

## 8. 参考坐标

- imp：`src/mcp/client.ts`（传输现状）、`config.ts`（schema）、`manager.ts`（重连语义）、完备性分析 §4 F1/F4 与 §5 S5。
- pi-mcp-adapter 2.34.0：`server-manager.ts:1430` 传输选择（streamable-http，仅明确拒绝回退 SSE）、`session-recovery.ts`（404 会话过期重初始化）、`mcp-auth-fetch.ts`（带凭据请求拒绝重定向，与本项 §3 重定向策略同源）。
- Claude Code 2.1.88：`services/mcp/client.ts:823-891`（`type:"http"` StreamableHTTPClientTransport）与 `:608-659`（`type:"sse"`）、`headers`/`headersHelper`、远端传输重连退避（useManageMCPConnections.ts）。
- 官方 Tushare 文档：tushare.pro/document/1?doc_id=463（配置形态）。
