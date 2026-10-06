# M19 远程 MCP（Streamable HTTP 传输）设计

状态：设计文档（**独立审查已通过**：一轮 2 blocker + 应修项、二轮 4 小项全部修订并经原审查者复核确认；见 §4 审查记录）
日期：2026-09-29
基线：imp main `b7d8a9d`（`src/mcp/`、`src/cli.ts` 等引用文件自 `f417fba` 起零差异，行号引用有效）
分支：设计在 `docs/mcp-completeness-analysis`；实现将另开 `feat/mcp-http`（自 main 开 worktree）
参考：
- 本 worktree 三件套：`design/mcp-completeness-analysis.md`（完备性分析）、`design/mcp-http-transport-scoping.md`（Tushare 触发梳理）、`design/mcp-oauth-evaluation.md`（OAuth 评估：本批不含 OAuth）
- `pi-mcp-adapter@2.34.0`（本机安装包）：`server-manager.ts:1430` 传输选择、`session-recovery.ts` 会话过期、`mcp-auth-fetch.ts:85` 带凭据请求 `redirect:"error"`
- Claude Code 2.1.88 还原源码：`services/mcp/client.ts:823-891`（`type:"http"`）与 `:608-659`（`type:"sse"`）
- MCP 规范修订版 2025-06-18（Streamable HTTP；授权部分不在本批）

## 0. 目标与验收

**目标**：imp 能消费 Streamable HTTP 远程 MCP 服务器（静态凭据形态：URL 内嵌 token 或 `headers` 带 PAT）；同时关闭 F1（项目级 mcp 配置不受 M8 trust 门保护）安全缺口。不引入运行时依赖（继续用内置 fetch + 手写 SSE/JSON-RPC）。

**验收场景（真机）**：
1. Tushare 官方配置原样可用（服务器键改小写，如 `tushare`；理由见 D6）→ `/mcp` 显示 `connected · N tools（N>0）` → 模型调用数据工具返回结果。
2. GitHub 远程（`https://api.githubcopilot.com/mcp/` + `headers.Authorization: Bearer ${GITHUB_PAT}`）→ connected + 工具调用（权限按 PAT）。
3. F1：未信任目录 + 项目 `.mcp.json`（stdio 与 http 两种形态）→ 不 spawn、不外联、有 note。
4. 密钥卫生：URL token 与 header 值不出现在 `/mcp`、note、错误输出；重定向不跟随。
5. 门禁：既有 55 个 MCP 用例保持全绿；全量 vitest、typecheck、biome、dist 冒烟照旧。

**非目标（v1）**：OAuth（触发条件见 `design/mcp-oauth-evaluation.md` §5）、SSE-legacy 专用传输（回退预案见 §6）、resources/prompts、sampling/elicitation、GET 独立流、`Last-Event-ID` 断点恢复、progress 通知、每服务器超时配置、工具名规范化（S5 另记，README 教学代替）。

## 1. 决策记录

### D1 传输抽象：McpClient 保留协议核心，传输层抽接口

- **结构**：
  - `src/mcp/transport.ts`：`McpTransport` 接口 + JSON-RPC 消息类型 + 秘密脱敏工具（D5）。
  - `src/mcp/stdio-transport.ts`：现有 `client.ts` 的 spawn/NDJSON/信号关闭逻辑整体迁入（行为零变化）。
  - `src/mcp/sse.ts`：SSE 解析器（D5）。
  - `src/mcp/http-transport.ts`：Streamable HTTP（D5）。
  - `src/mcp/client.ts`：只留协议核心——pending 表、请求/通知、超时、abort、`initialize` 握手、`tools/list` 分页（10 页上限）、`tools/call` 映射、服务器请求应答（ping→result、其余 -32601）。
- **接口草案**：
  ```ts
  interface TransportEvents {
    onMessage(msg: unknown): void;                  // 已解析的 JSON-RPC 对象
    onRequestError(id: number, error: Error): void; // 请求级传输失败（5xx/非预期响应/流提前关闭）——只拒绝该 pending
    onDeath(reason: string): void;                  // 进程死 / 会话失效 / 传输致命错误（拒绝全部未决）
  }
  interface McpTransport {
    readonly kind: "stdio" | "http";
    start(events: TransportEvents): Promise<void>; // stdio: spawn；http: URL 校验（无 IO）
    send(msg: Record<string, unknown>): void;      // 通知也走这里
    close(): Promise<void>;                        // 优雅：stdio 发起信号序列后立即解析；http: abort 流 + DELETE（3s 上限在本层）后解析
    forceKill(): void;                             // 同步尽力（双 Ctrl+C 路径）
    getDiagnostics(): string;                      // 替代 stderrTail（http: 状态码+体片段，已脱敏）
    isOpen(): boolean;
  }
  ```
- **请求级 vs 连接级错误的分工（审查 blocker 1 修复）**：每个请求在传输层必须二选一收尾——交付 JSON-RPC 响应（onMessage）或以 `onRequestError(id, error)` 终止该 pending；`onDeath` 只用于连接致命（网络错误/会话失效/致命 framing）。通知的传输失败静默（仅诊断）。D5 的"5xx 不判死、走请求级错误"依赖这条通道。
  `McpClient` 构造改为 `(transport, { name, clientVersion, connectTimeoutMs?, callTimeoutMs? })`；对外保留 `connect/listTools/callTool/close/forceKill/isConnected/onDead`。
- **死亡与关闭的传播规则**：closed 标志住在 core；transport 检测到死亡 → `events.onDeath(reason)` → core.die（先拒绝全部未决 → 标记 closed → 转发 manager）；core 主动 `close()/forceKill()` 时先置 closed，后续从 transport 冒出的死亡事件一律忽略（防自报死亡）；transport.send 在关闭后为 no-op（对齐现有 `write` 守卫）；stdio 的 exit/error 监听器保留 `if (!this.closed)` 守卫（迁入 stdio-transport 后由 core 的 closed 态把关）。新增钉子：close()/forceKill() 后 onDeath 不再触发。
- **为什么不是平行类（`HttpMcpClient` 复制核心）**：pending/abort/取消通知/分页这 ~200 行是两轮独立审查过的逻辑，复制即漂移源。
- **兼容**：直接构造点共三处——`test/mcp-client.test.ts:20/:163`（含 `ConstructorParameters<typeof McpClient>[0]` 类型表达式，需随签名更新）与 `manager.ts` 的客户端构造；替换为 `new McpClient(new StdioTransport({...}), {...})`。**断言零变化**（55 用例仅构造/类型表达式机械更新）——"行为零变化"由此证明。`getStderrTail` 现无调用者（死代码），改名 `getDiagnostics` 安全；`McpConnectionError` 第二参数保留（manager 的 `instanceof` 一次重试依赖该类，参数名改为 `detail`）。

### D2 配置 schema：stdio 与 http 判别联合

- 两种条目：
  - stdio：`{ kind:"stdio", name, command, args, env, cwd?, disabled }`（现行为不变）
  - http：`{ kind:"http", name, url, headers: Record<string,string>, disabled }`
- JSON 形态判型：`command` → stdio；`url` → http；两者都有或都没有 → note + 跳过该条目。
- 可选 `type`：接受 `stdio`、`http`、`streamableHttp`、`streamable-http`（大小写不敏感，归一到两种 kind）；`sse` → note"not supported yet"（回退预案 §6）；其他值 → note。`type` 与字段矛盾（如 `type:"http"` + `command`）→ note + 跳过。
- http 条目上出现 `args`/`env`/`cwd` → note + 忽略（教学，不拒绝连接）；stdio 条目上出现 `headers` → note + 忽略；出现 `url` 由互斥规则覆盖。
- `url` 校验：`new URL` 可解析；`https:` 一律允许；`http:` 仅回环主机（`localhost`/`127.0.0.1`/`::1`）；其余 note + 跳过。
- `headers`：值均字符串；名字匹配 HTTP token 字符集、值不含 CR/LF/NUL，违规 → note + 跳过；值过 env 展开。
- env 展开（`${VAR}`/`$env:VAR`/`{env:VAR}`，未定义→""）扩展到 `url` 与 `headers` 值；展开后校验失败 → note。
- 所有 note 不回显 URL 原文（只给文件、服务器名、原因）；`/mcp`"looked in" 行仍列五条路径。
- 容错基调不变：坏文件/坏条目一行 note 跳过，永不阻断启动。

### D3 合并规则：维持"整体替换"（显式重新拍板，取代 M18 §2 触发句）

M18 §2 记录：*"触发条件：引入 HTTP/凭据型服务器时改为字段级合并+凭据绑定规则。"* 本设计显式重新拍板：**维持整体替换**——该偏离路径由 scoping §2（"或在设计文档显式重新拍板偏离"）与 §4（"批 A 的合并规则需在设计文档先拍板"）授权。理由：

1. **整体替换对"跨源凭据继承"免疫**：没有字段继承就没有跨源污染。M18 触发句要防的场景（高优先源换 url 却继承低优先源凭据）在整体替换下不存在；字段级+绑定规则是"事后打补丁达成同等安全"。**残余成本（如实记录）**：若全局条目里放的是字面 token（Tushare 官方形态即如此），项目侧想改一个字段就必须复述整条、连带复制 token——这是整体替换唯一比字段级差的地方；缓解 = README 教学用 `${ENV}` 形态，并列入重访触发。
2. **数组/映射没有自然的逐字段合并语义**：`args` 合并还是替换？`env`/`headers` 逐键还是整体？任何选择都是新增的、需要长期背负的任意语义。
3. **整体替换是已测试、已写进 README 的用户契约**（"later files override earlier ones per server, whole entry"）；改语义本身是风险，而收益仅是"少抄一遍条目"。
4. 复制条目的成本可用 `${ENV}` 展开降低为复述占位符（前提是用户采用 env 形态；见理由 1 的残余成本）。
- **重访触发**：出现"按字段覆盖"的真实需求（例如项目只想把某全局服务器 `disabled`，不想复制整条、也不想在项目文件里出现 token）。届时实现字段级合并 + pi 式凭据绑定（url 变→丢继承 `headers`；command 变→丢继承 `env`）。
- **账本更新（实施批次 D 执行）**：`design/m18-mcp-design.md` §2 触发句加"已被 M19 D3 取代"注记；`design/mcp-http-transport-scoping.md` §2 批 A 行的"字段级合并"表述以本文件为准。

### D4 会话生命周期、错误与重连（HTTP）

- **建链**：`transport.start()`（http 无 IO）→ core 发 `initialize` POST → 成功（无论响应是 JSON 还是 SSE）→ 发 `initialized` 通知（此 POST 即回带会话头）→ `connected`。
- **会话**：任一 POST 响应携带 `Mcp-Session-Id` 则记录/更新（initialize 是常态；中途重赋也接受）；**其后所有 POST（请求与通知，含 initialized、cancelled）与 DELETE 都回带**；无会话的服务器按每请求独立处理。响应体是 SSE 流时，也要在消费流之前先取响应头（fetch 先 resolve headers，天然满足；加测试钉住时序）。
- **协议版本头**：`initialize` 成功后，后续所有 POST 与 DELETE 带 `MCP-Protocol-Version`，值 = **服务器响应中协商的 protocolVersion**（缺省时回退请求值 2025-06-18）——对齐 SDK 行为（回显协商值，而非硬编码客户端常数）。
- **死亡判定**（→ `onDeath`，manager 标 `disconnected`，调用路径重连）：
  - 网络错误（fetch reject）；
  - 响应 `404` 且当前持会话 id（会话过期）：先以 `McpSessionExpiredError extends McpConnectionError` 对该请求走 `onRequestError`，再判死；**该错误类型绕过重连冷却**（见下）——对齐 pi `session-recovery.ts` 的 404-重初始化；
  - `401/403`（凭据被拒；错误文案给出指引，重试受冷却/上限约束）；
  - 其余 4xx/5xx 不判死：以 `onRequestError` 走请求级错误 → 桥接成 `isError` 结果（与 stdio 的 bash 契约一致）；
  - 请求级失败若需要驱动 manager 的"单次重试"，必须抛 `McpConnectionError`（或其子类）——`manager.callTool` 的 `instanceof` 判断是既有契约。
- **重连**：两条既有路径原样复用——启动失败 run 边界重试（上限 3 + 30s 冷却）；中途死亡由调用触发单飞重连+一次重试。**会话过期例外（审查 blocker 2 修复）**：`McpSessionExpiredError` 路径**绕过 30s 冷却**立即重初始化（单飞），成功后重试原调用一次——否则"刚连上就过期"会被冷却拒成 "on cooldown" 死路（对齐 pi 的无冷却立即恢复）。HTTP 的"重连"= 新 client + 重新 `initialize`（拿新会话）→ 重拉工具列表 → 既有重注册；重连成功刷新 `lastAttemptAt`。stdio 语义不变。
- **abort**：调用 abort → 立刻拒绝 pending（既有）→ 发 `notifications/cancelled`（POST，5s 超时、失败忽略）→ 中止该请求的 fetch/流。manager 不判死、不杀进程（http 无进程）的语义不变。
- **关闭**：优雅 `close()` 升级为返回 `Promise<void>`——stdio 立即解析（行为不变，不阻塞退出）；http 中止未决 + DELETE 会话（若有；上限 3s；`404/405` 与超时均忽略——服务器不支持则降级）后解析。`forceKill()` → 同步中止所有流（不等待 DELETE）。调用点（批 D）：`repl.gracefulExit` 改为 async 并在 await close 后链式 `finish()`（其五个同步调用点保持 fire-and-forget：`void this.gracefulExit(...)`）；退出等待期间引入 `exiting` 中间态，保证二击强退（forceExit）不被 `state === "exited"` 吞掉——forceExit 可抢占：forceKill 并使进行中的 close 放弃 DELETE、其 promise 照常解析；print 模式 finally 改 `await`；`McpManager.close()` 由 `void` 改 `Promise<void>`（聚合 transport close；stdio 实现立即解析保持快速退出）。测试：注入 exit 见证"close 解析时 DELETE 已收"、DELETE 超时仍解析、forceKill 与 close 竞争的放弃语义。stdio 的 stdin.end→SIGTERM→SIGKILL 序列不变。
- **超时**：连接（`initialize` 完成）默认 stdio 45s（npx 冷启动，不变）、**http 30s**；调用 120s 不变；5s 用于取消通知、3s 用于关闭 DELETE。全部保留 options 测试缝。

### D5 Streamable HTTP 实现要点

- 单端点；每个 JSON-RPC 消息一次 POST：`Content-Type: application/json`、`Accept: application/json, text/event-stream`；通知收到任意 2xx（规范 202）即可。
- 响应三态：202（通知无体）；2xx + `application/json`（单消息）；2xx + `text/event-stream`（SSE 流：流内可含本次响应 + 服务器请求/通知；按 id 匹配 pending；流结束收尾）。非 2xx → 诊断错误（状态 + 体片段 ≤2KB，已脱敏）。
- **流提前关闭**：POST 的 SSE 流关闭时若本次请求仍未 settle → 以请求级错误立即拒绝该 pending（不等 120s 超时）；响应 `content-type` 既非 JSON 也非 SSE → 诊断错误。
- 服务器请求（流内）：沿用既有应答逻辑（ping→POST result；其余→POST error -32601），应答本身是独立 POST（带会话头/协议版本头）。
- **重定向**：fetch `redirect: "error"`——**所有**请求任何 3xx 直接报错，不跟随、不回显 `Location`。（pi 的 `mcp-auth-fetch.ts:85` 只对携凭据 header 的请求如此；本设计更严：token 可能藏在 URL 里，不能只护 header 请求。Tushare 实测存在 307 且附带 https→http 降级，跟随即明文外发。）
- **并发**：每请求独立 fetch/流，无共享流状态，传输层并发安全由构造保证；bridge 仍不标 `concurrencySafe`（模型侧串行，现状不变）。测试：顺序调用 + 并发调用（client 层直测）各一。
- **SSE 解析器（`sse.ts`）**：输入 `AsyncIterable<Uint8Array>`（`response.body`）；支持 LF/CRLF、多行 `data:` 以 `\n` 拼接、注释行（`:`）忽略、空行分派事件、丢弃 BOM；UTF-8 跨块字节缓冲（沿用 P2-4 修复模式：整行/整事件才解码）；单事件 `data` 累计上限 10MB（同 NDJSON 守卫，超限判死）；`event`/`id` 字段解析但 v1 不消费。产出事件 → `JSON.parse` 失败按"杂散数据"跳过并记诊断（与 NDJSON 杂散行同语义）；流 EOF 时若缓冲中还有未派发事件，**按完成事件处理（宽容）**并钉测试。
- **诊断**：以"HTTP 状态码 + 响应体片段（≤2KB、脱敏）"替代 stdio 的 stderr 环；`McpConnectionError` 的第二参数改为通用的 `detail`。
- **秘密脱敏**：秘密集合 = 全部 `headers` 值 + `url` 的 userinfo 与 path/query 部分；任何外发字符串（错误消息、note、`/mcp` 状态、诊断片段）中出现的秘密字面量替换为 `«redacted»`；请求 URL 只允许以 `origin` 形式出现在消息里；协议版本/会话头的值不敏感，照常。**边界声明**：主机名里嵌 token 的形态无法通用识别（不入集合，属已知边界）；工具名/描述里由服务器自带的敏感内容会经 promptSnippet 进系统提示目录——服务器可控内容，与 stdio 同边界，不在本批范围。
- 不新增依赖：内置 `fetch`（undici）+ 手写 SSE。

### D6 接线、用户面与命名摩擦（S5 不在本批）

- manager：按 `kind` 构造 transport + client；重试/冷却/parking/status/notes 原样复用。
- `/mcp`：状态行不变；错误行经脱敏。`401` 文案含"check the token；OAuth is not supported yet"。
- settings（`mcp.enabled`）、`IMP_MCP=0`、print 模式（onRunStart/onRunEnd/finally close）不变。
- **命名摩擦**：官方配置键 `tushareMcp` 含大写会被 imp 名称规则逐个拒绝（`connected · 0 tools`）。本批不做 S5 规范化；README 与验收教学用**小写键**（如 `tushare`），并在 README 写明该约束。验收断言工具数 >0（只断言 connected 无效）。
- README：新增远程段（Tushare 原样示例 + GitHub PAT 示例 + `${ENV}` 建议 + 安全说明：https/回环、不跟随重定向、脱敏）；顺手修正 S1 措辞（不再声称"与 pi 相同的配置文件清单"——imp 实际五路径、pi 2.34.0 六源，差异参见完备性分析 S1）。

### D7 F1：项目级 mcp 配置并入 M8 trust 门（批 0，先行、独立提交）

- **接口**：`discoverMcpConfig({ cwd, home?, paths?, projectAllowed })`——`projectAllowed` 为**必填**（不设默认，杜绝 fail-open：新调用者必须显式决定信任语义；现有 `test/mcp-config.test.ts` 的 7 处调用点**在批 0 内**机械补 `true`——否则批 0 的 typecheck/vitest 无法全绿；批 A 的 schema 改造再动其余部分）。`projectAllowed=false` → 跳过第 4/5 条项目路径（`<cwd>/.mcp.json`、`<cwd>/mcp.json`），notes 加一行教学：`mcp: project config skipped — directory not trusted (--trust to enable)`（仅当被跳过的文件确实存在；空目录零噪音）。返回的 `paths` 仍列全部五条（`/mcp` 的 "looked in" 提示不变，note 讲清跳过原因）。
- **实施修订（批 0 落地时发现）**：定位 `resources.length === 0 → true` 的短路后确认——`trustRequiringResources` **必须**把两条项目级 mcp 文件计入（`isFile`），否则"目录里只有 `.mcp.json`"的克隆仓库会走"无资源→零摩擦"分支，信任位恒为 true，本门形同虚设。已随批 0 落地（`src/core/trust.ts`）并配单元（清单）与 e2e（pid 见证）钉子。
- **接线**：`createMcpSetup` 传 `runner.projectSettingsAllowed`（信任位——extensions/skills/settings/AGENTS 项目层用同一个决策，语义正确）。时序：交互模式信任在 `cli.ts:583` 解析、`:632` 进 runner、`:649` 调用 createMcpSetup；print 模式 `:1004` 解析、`:1047` 调用——两处调用点信任均已在先。global 三条路径不受影响；`--trust`/ask（含 session 选项）通过后项目层恢复。
- **测试**：未信任 + 项目 `.mcp.json`（stdio fake server）→ 不 spawn（pid 见证）+ note；未信任 + 项目 http url → fake http server 见证 0 请求；信任后两者恢复；global 层不受影响。

### D8 测试计划

| 面 | 用例 |
|---|---|
| sse 单测 | 多行 data、CRLF、注释、空行分派、UTF-8 跨块、10MB 上限判死、杂散 JSON 跳过、`event`/`id` 解析、**EOF 无空行收尾（缓冲事件按完成处理）** |
| config | type 归一化/矛盾/未知、`sse` 拒绝、url 校验（https/回环/坏 URL）、headers 校验+展开、http 上 args/env/cwd 忽略 note、command∩url 互斥、disabled、整体替换（含 url 条目）、**note 不回显 URL** |
| 重构回归 | 既有 55 用例全绿（仅构造点机械替换；断言零变化） |
| http client（fake http server） | JSON 响应握手；SSE 响应握手（会话头先于流消费的时序）；**initialize 由 SSE 应答时，会话头在紧随的 initialized 通知 POST 上回带**（时序钉子）；会话头回带（通知 POST/调用 POST/DELETE 各断言一次）；202 通知；`MCP-Protocol-Version` 见证（值为协商值）；流内服务器 ping → 应答 POST 见证、未知请求 → -32601；404（有会话）判死；401 判死+文案；5xx 请求级错误（连接不判死）；307 → 报错且不跟随（第二端点 0 请求、消息无 Location）；慢调用超时；**SSE 流 EOF 无空行收尾 → 缓冲事件按完成处理**；abort → cancelled POST + 流中止见证；close → DELETE 见证（close 解析即 DELETE 已收）；DELETE 404/超时（>3s）忽略且 close 照常解析；**close()/forceKill() 后 onDeath 不触发**；并发交错（A 流内 ping 与 B pending 同时在场）；脱敏经 `statusLines()` 断言 + header 值含 URL 保留字符 |
| manager | http 启动失败重试（边界/冷却/上限）；run 中连接完成 parking 复用；**中途会话过期 → 立即重初始化 + 原调用重试一次（不受冷却阻塞，时间见证）**；close/forceKill 竞争语义 |
| trust（批 0） | 未信任时 stdio 不 spawn（pid 见证）、http 0 请求（含"仅 http 会外泄"用例）；信任后两者恢复；global 层不受影响 |
| wiring/e2e | runRepl + http fake server（`/mcp` 渲染、`/exit` 后 DELETE 见证）；fake provider 驱动工具调用端到端；dist 冒烟（dist + fake http server） |
| 门禁 | 全量 vitest、typecheck 0、biome 净、dist 冒烟 |

夹具：`test/helpers/mcp-fake-http-server.mjs`（`node:http`，进程内可启动；可配置逐请求响应脚本、记录收到的请求头/体，供见证断言；vitest 与 dist 冒烟共用）。

### D9 文件清单与规模（估）

| 文件 | 内容 | 估行 |
|---|---|---|
| `src/mcp/transport.ts` | 接口 + 消息类型 + 脱敏工具 | ~100 |
| `src/mcp/stdio-transport.ts` | 自 client.ts 迁出的 spawn/NDJSON/信号 | ~150 |
| `src/mcp/sse.ts` | SSE 解析器 | ~120 |
| `src/mcp/http-transport.ts` | Streamable HTTP | ~260 |
| `src/mcp/client.ts` | 协议核心（重构后） | ~200 |
| `src/mcp/config.ts` | schema/校验/trust/notes | +120 |
| `src/mcp/manager.ts` | kind 分派 | +40 |
| cli/commands/README | 接线、文案、文档 | ~60 |
| 测试 | D8 + 夹具 | ~550 |

### D10 风险与回退

- **真机差异**（Tushare 传输类型/token 形态）→ 回退分支见 §6；GitHub 侧已确认 PAT 路径。
- **重构引入 stdio 回归** → 批 B 单独提交、纯重构；55 用例与 dist 冒烟是回归网。
- **SSE 边界**（分块、多事件、混流）→ 夹具矩阵 + 真机兜底；解析器与 v1 后回退 SSE-legacy 共用。
- **凭据泄漏** → 脱敏规则 + 全路径夹具断言 + 真机复查（验收第 4 条）。
- **服务器行为未知**（是否支持 DELETE、会话头行为）→ "不支持则忽略/降级"路径已定。
- **F1 与远程叠加** → 批 0 先行，之后 http 项目配置才在"信任后可外联"的前提下存在。

## 2. 实现批次（设计审查通过后开工）

- **批 0**：F1 trust 门（独立提交、独立走查；不依赖重构；含 `test/mcp-config.test.ts` 调用点机械补 `projectAllowed`）。
- **批 A**：配置层（D2 schema + D3 合并规则维持的钉子 + 脱敏 note）。
- **批 B**：传输抽象重构（纯重构，55 用例全绿）。
- **批 C**：HTTP 传输（sse.ts + http-transport.ts + D4/D5 语义 + fake http server 夹具与用例）。
- **批 D**：接线与文档（manager kind 分派收尾、/mcp、README、M18 D5 行 1 与 §2 注记、scoping 表述对齐）。

每批：全量 vitest + typecheck + biome + dist 冒烟；批次独立提交。

## 3. 验收（真机，汇总）

1. Tushare：官方 URL（token）→ `/mcp` connected 且工具数 >0 → 工具调用返回数据；abort 与退出清理各验一次；错误 token 得到脱敏的指引性错误。
2. GitHub：`headers` PAT → connected + 至少一个读类工具调用成功（权限按 PAT 实际范围）。
3. F1：未信任目录的项目 `.mcp.json`（stdio/http 两种）不执行、不外联。
4. 全程输出（/mcp、note、错误）复查无 token；重定向不被跟随。
5. 门禁全绿（既有 55 + 新增用例）。

## 4. 独立审查记录

### 第一轮（2026-09-29，fresh-context 对抗审查）——结论 needs-fixes，修订已应用

- **Blocker 1（已修）**：传输接口缺"请求级错误"通道——5xx/非预期响应/流提前关闭无法只拒绝单个 pending → D1 增加 `onRequestError(id, error)` 事件与"每个请求二选一收尾"规则。
- **Blocker 2（已修）**：404 会话过期走通用重连会被 30s 冷却拒绝（刚连上就过期 → "on cooldown" 死路）→ D4 增加 `McpSessionExpiredError` 子类 + 绕过冷却的单飞立即重初始化 + 原调用重试一次（对齐 pi `session-recovery.ts` 的无冷却恢复）。
- **应修项（已应用）**：协议版本头回显协商值（非硬编码）；会话头从任一响应捕获/更新、initialized 通知显式回带；脱敏集补 userinfo、声明主机名/服务器内容边界、经 `statusLines()` 断言；`discoverMcpConfig.projectAllowed` 改必填防 fail-open；D3 补残余成本（字面 token 复制）与授权出处；D1 兼容清单修正（三处构造点、类型表达式、closed 归属 core、getStderrTail 死代码）；异步 close 的退出态竞争（`exiting` 中间态、forceExit 抢占）写明；D8 补时序/冷却绕过/EOF/DELETE 失败/交错/竞争钉子；pi 重定向引用范围与基线（b7d8a9d）修正。

### 第二轮复核（2026-09-29，原审查者）——原 findings 全部确认处置；新出 4 小项已修

- 复核更正：D1 `close()` 签名改 `Promise<void>`（3s 上限归 transport）；`test/mcp-config.test.ts` 7 处调用点归属批 0（否则批 0 无法全绿）；`McpManager.close()` 改 `Promise<void>` 明写；SSE EOF 用例补进 sse 单测行。

### 结论（2026-09-29）

两轮审查关闭：**设计通过，可进入实施**（批 0 先行）。

### 实施期修订

- **批 0（已落地）**：`trustRequiringResources` 计入两条项目级 mcp 文件（见 D7 实施修订）——审查文本只覆盖了 `projectAllowed` 的接线，漏了信任清单本身；实现时以 `resolveProjectTrust` 的"无资源短路"为证据补上，并配清单单测 + pid 见证 e2e。
- **批次顺序说明（2026-09-29）**：为让每个提交独立全绿，实际顺序为 批 0 → 批 B（纯重构，配置未动）→ 批 A+C 合并（配置联合类型与传输同源；拆开会留下"http 已解析但未实现"的中间态）→ 批 D。交付物与 D1-D8 一致，仅提交切分不同。
- **实施记录（提交）**：批 0 `4b8e1b7`；批 B `87855fb`；批 A+C `ff8b120`；批 D `26f1b23`：repl 退出态机（`exiting` + forceExit 抢占）+ DELETE 放弃语义 + README/M18 账本。
- **批 D 实现发现**：`McpClient.forceKill` 原先因 `closed` 早退，close() 之后无法把力传到 transport，导致进行中的 DELETE 不会被放弃——已修（forceKill 无条件通知 transport），并加"forceKill during close abandons the DELETE"钉子（1500ms 延迟下 close 仍 <1s 解析）。
- **真机自验（2026-09-29，Tushare 官方服务器）**：两层验证通过，**全程未写入用户任何配置文件**。① 协议层（imp 的 `HttpTransport`/`McpClient` dist 产物直连）：配置层接受用户现有 `.mcp.json` 原样（kind=http、notes 空）；握手 404ms；tools/list 254 个；真实调用 `stock_basic`（贵州茅台行）、`daily`（600519.SH 2026-09 收盘价）、`trade_cal`（交易日历）均返回数据；不存在的工具得到干净 `isError`（"40101 请指定正确的接口名"）；token 未出现在任何输出。② 循环层（agent loop + 脚本模型，零 LLM 配额）：254 个工具全部注册（note 见证），模型请求携带 **262 个工具定义 / 267KB**，模型发起的 `tushare_daily` 真实调用结果回传到下一次请求。**坐实 D5 #7 触发**：254 工具/267KB 就是每轮请求的实际负担，includeTools/excludeTools（对齐 pi）或代理模式必须跟进。**用户决策（2026-09-29）：延后，等实际使用出现痛点再做**（速解半天；痛点指标 = 日常 Tushare 会话轮次成本/延迟可感，或模型在 254 个相似工具间选错接口）。
