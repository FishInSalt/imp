# M18 MCP 工具接入（stdio 直连）设计

状态：已审批（2026-09-23，含 D6 修订 + 自审修复 P1×1/P2×4）
分支：`feat/mcp-tools`
参考：pi 经 `pi-mcp-adapter@2.34.0` 扩展实现（~29k 行 TS；本机源码 `/Users/z/.pi/agent/npm/node_modules/pi-mcp-adapter/`，引用坐标均指该目录）；imp 目标是**功能语义对齐**，不做架构对齐（D1）。

## 0. 目标

imp 能像 pi 一样消费 MCP（Model Context Protocol）服务器暴露的工具：启动时发现配置 → 连接 stdio 服务器 → 握手列出工具 → 摊平注册进工具表 → 模型调用 → 结果回模型。

验收场景（真机）：`~/.config/mcp/mcp.json` 里现有的 `zai-vision` 配置原样可用——imp 内让模型调 `zai-vision_analyze_image` 识别一张本地图片，主模型无需视觉能力。

## 1. 决策记录（已拍板）

### D1 原生模块，不做成扩展

- pi 走扩展的前提（包管理系统 `packages: [...]`，独立安装/版本化）在 imp 不存在——imp 无包管理器，"扩展"只能手动拷 .mjs，独立性优势归零。
- 扩展路径前置成本更高：MCP 工具集是启动后异步就绪的，而 imp 扩展 API 是加载期一次性注册（`registerTool` 工厂返回后 no-op；工具表构造期快照；无 unregister）。扩展版 = 先给扩展 API 加动态注册（core 改动）+ 再写客户端，两份工作换更少能力（无 vitest 直测、无版本化）。
- 功能对齐不受影响：配置发现顺序、命名、/mcp 状态、调用语义全部按适配器行为钉。

### D2 直连摊平，不做 `mcp` 元工具代理

每个 MCP 工具直接注册进工具表，命名 `<server>_<tool>`。**有意偏离 pi 默认**（pi 默认注册单个 `mcp` 代理工具省 prompt，`directTools` 才摊平）——理由：当前唯一服务器只有 2 个工具，摊平膨胀可忽略、对模型更可发现；代理模式是工具大户服务器的 prompt 优化，触发条件见 D5。

### D3 手写 JSON-RPC，零运行时依赖

v1 协议面只有 initialize / tools/list / tools/call 三个方法 + 两个通知，手写 stdio 分帧（NDJSON）约 280 行，保住 imp 零运行时依赖的性质。不引 `@modelcontextprotocol/client`。

### D4 无配置零开销 + settings 总门

无任何 mcp.json → 不 spawn、不注册、/mcp 提示未配置。settings 增 `mcp.enabled`（boolean，默认 true）总门：false 跳过整个模块。

### D5 v1 不做七项（每项记触发条件，触发即按 pi 行为补）

| 项 | 场景 | 触发条件 |
|---|---|---|
| OAuth/HTTP 传输 | 远程托管服务器（GitHub/Notion 等），HTTPS+OAuth 2.1 | 需要用某个远程 MCP 服务器 |
| Sampling（服务器反向借宿主模型） | 代理型服务器不自带 key，请宿主代调 LLM | 出现依赖 sampling 的服务器 |
| Elicitation（服务器向用户发结构化问句） | 调用中途让用户选工作区/账号 | 某服务器核心流程依赖中途问句 |
| Resources / Prompts 面 | 文档型服务器（resources=文档页）、工作流模板 | 接入 resources 型服务器（如文档库） |
| 逐调用审批门 | 持凭据服务器（邮箱/支付）的防误操作 | 接入有真实副作用的凭据型服务器 |
| 跨厂商配置导入 | 复用 Claude/Cursor/Windsurf 的既有 MCP 配置 | 在别处配了大量服务器且不想抄 |
| `mcp` 元工具代理 | 工具数上双的服务器省系统提示 token | 接入工具数 ≥10 的服务器 |

注：审批门的延后理由是姿态而非无用——imp 模型本就握着 bash/write（全能力面），MCP 工具不构成能力增量；持凭据服务器入场后此论不再成立。

### D6 v1 不加 MCP 系统提示段（有意偏离 pi，审批中拍板）【已被 #prompt-audit D10 取代，2026-02-08：系统提示成为路由目录后 MCP 工具缺席形成不一致路由面；100B/条+2KB 总量预算封顶后冗余论点不再成立】

pi 把已注册工具（含 MCP）枚举进系统提示 `# Tools` 段，每行 `名字: 描述截断 100 字符`（adapter index.ts:404 promptSnippet + agent-session.ts:1063-1091）——内容是逐轮随请求的工具定义的截短重复，存在理由是索引完整性。imp v1 不做：信息零损失（定义每轮随请求完整发送）、省 prompt 行、晚到工具的导读滞后问题不存在。触发条件与 D5 代理模式共用：工具大户服务器进场时切代理模式，由代理工具自带单行 snippet 那时才进系统提示。

## 2. 配置发现（`src/mcp/config.ts`）

**发现顺序**（pi `config.ts:15-21` 同序），全部存在才读，缺哪个跳过哪个：

1. `~/.config/mcp/mcp.json`（generic global）
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<cwd>/.mcp.json`（项目）
5. `<cwd>/mcp.json`（项目）

**形态**：顶层 `{"mcpServers": { "<name>": {...} }}`；服务器条目：

```jsonc
{
  "command": "npx",
  "args": ["-y", "@z_ai/mcp-server"],   // 可选
  "env": { "KEY": "value" },             // 可选，合并进子进程 env（继承父进程）
  "cwd": "/some/dir",                    // 可选，缺省 imp 启动 cwd
  "disabled": true                       // 可选，跳过该服务器
}
```

**合并规则**：按发现序读取，后文件按服务器名覆盖前文件（项目覆盖全局）；同名服务器**整体替换**，不做字段级合并——**有意偏离 pi**（pi 的 mergeServerMaps 是字段级合并，且带“凭据绑定 url”安全规则：高优先源换了 url 不得继承低优先源的凭据，adapter config.ts:661-669；v1 stdio 无凭据面，整体替换更简单可预测）。触发条件：引入 HTTP/凭据型服务器时改为字段级合并+凭据绑定规则。`disabled: true` → 跳过连接，/mcp 显示 disabled——**与 pi 对齐**（pi 的 /mcp 面板会把 disabled 写进项目层配置，adapter config.ts:1168-1206；原设计误判为“pi 无此消费面”，审查更正）。

**环境变量展开**（pi `utils.ts:136-138` 三形态）：`command`/`args[]`/`env` 值中 `${VAR}`、`$env:VAR`、`{env:VAR}` → 展开，未定义变量替换为空串。

**容错**：文件 JSON 损坏 → 一行 note（`mcp: <path> is not valid JSON — skipped`）跳过该文件；服务器条目类型不符（command 非字符串等）→ 一行 note 跳过该条目，其余照常。永不因配置问题阻断启动。

## 3. 协议客户端（`src/mcp/client.ts`）

**传输**：`spawn(command, args, { stdio: ["pipe","pipe","pipe"], env, cwd })`；stderr 收集环形缓冲尾部 2KB 供 /mcp 与失败诊断；stdout 按**换行分帧 NDJSON**（每行一个 JSON-RPC 2.0 消息）。非 JSON 行跳过（容错服务器杂散输出）；单行超 10MB 断连（防御，记诊断）。

**握手**：

1. `initialize` 请求：`{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "imp", version } }`
2. 收到响应后发 `notifications/initialized`
3. `tools/list` → `{ tools: [...], nextCursor? }`；有 `nextCursor` 则带 cursor 续拉，**页上限 10**（z.ai hasMore 教训同款），超限记 note 停止

**版本协商**：服务端返回的 protocolVersion 与请求不同 → 接受不退出（生态实践宽松；协议字面要求断连。真机以 zai-vision 实际行为验证后钉测试）。

**工具形状**：`{ name, description?, inputSchema }`——inputSchema 是 JSON Schema，见 §4 直通。

**调用**：`tools/call` `{ name, arguments }`：

- 默认超时 **120s**（视觉分析等慢工具）
- abort（run 中断）：pending 等待立即拒绝；向服务器发 `notifications/cancelled`（尽力而为，不等确认）
- 结果 `{ content: [...], isError? }`——文本块拼接，非文本块计数省略（§4）

**连接超时**：45s（npx 冷启动首次下载）。失败/超时 → 标 `failed`。重连分两场景（审查修复：原“工具被调用时重试”对启动失败场景是死锁——工具从未注册，调用永不发生）：

- **启动失败**（工具从未注册）：在 **run 边界重试**——新 run 提交时若未连接且冷却（30s）已过则重试，上限 3 次，之后该服务器本会话保持 failed（v1 无手动重连；/mcp 显示状态，恢复=重启会话）
- **中途掉线**（工具已注册但连接死了）：该服务器任一工具被调用时单飞重试（in-flight 去重），冷却 30s

/mcp 查看状态不触发重连。

**进程退出**：服务器 stdout close/exit → 未决请求全部拒绝（isError 语义）+ 标 disconnected。

**关闭**（imp 退出）：`stdin.end()` → 3s 宽限 → SIGTERM → 2s → SIGKILL；双 Ctrl+C 强退路径同步 `kill()`，不 await。

## 4. 工具桥接（`src/mcp/bridge.ts`）

**命名**：`<server>_<tool>`（如 `zai-vision_analyze_image`——pi 会话实证形态）。校验：

- 整名须匹配工具名 pattern（`^[a-z][a-z0-9_-]{0,63}$`，hyphen 合法——pi 适配器同）；超 64 字符或非法 → 拒绝注册 + note
- 撞 `BUILTIN_TOOL_NAMES` 或已注册工具名 → 拒绝注册 + note（与扩展工具冲突行为同构，M16 P1 教训：内置名单用同一份手列表常量）

**schema 直通**：MCP `inputSchema` 是 JSON Schema，imp `Tool.parameters` 是 TypeBox `TSchema`——运行时 TypeBox 即 JSON Schema，直通 + 最小规范化（确保 `type: "object"` 存在；非对象 schema 包一层 `{type:"object"}`）。真机以 zai-vision 实际形状为准钉测试。

**description**：直通；空 → `"MCP tool <tool> from <server>"`。

**execute 语义**：

- args 恒为记录（loop 契约）→ 直接作 `tools/call` 的 `arguments`
- 文本块按 `\n` 拼接为 `output`；非文本块（image 等）计数加尾注 `(N non-text block(s) omitted)`——图片内容块映射进 `ToolExecuteResult.content`（M13 通道）留待后续，视觉服务器返回的是文本分析，v1 无损失
- `isError` 直通
- 调用超时/进程死/连接断 → **不抛**：`isError: true` + 诊断文本（工具错误进结果语义，模型可自述失败并改道——与 bash 工具同契约）
- `concurrencySafe` 不标（保守串行）

**渲染**：走默认工具渲染（`● name … ✓` + 结果文本管道），v1 无自定义 renderer。**系统提示不加 MCP 段**：工具只经逐轮随请求的定义通道到达模型（见 D6）。

## 5. 生命周期接线

- **启动**：runner 构造后（repl init）`manager.connectAll()` fire-and-forget；每服务器 resolve 后走**晚到注册规则**（见下）+ 一行 note `▪ mcp <server>: N tools ready`（仅 connected 出）
- **晚到注册（审查修复）**：loop 的 wire 请求逐轮读 `this.tools` 活引用（loop.ts:154），但工具执行走循环前的 `toolMap` 快照（loop.ts:126、:416）——run 进行中推入的工具会被发给模型、被调用、热后报 `unknown tool`，比不可见更糟。因此：**连接完成时若 run 进行中，工具进 pending 队列，run 边界（run_end/新 run 提交）flush 进 `this.tools`**，下一 run 起可见且可执行（与 M17“设置下一 run 生效”同一哲学）
- **hermetic 注入缝（实现修订，独立审查 P3-9）**：实现比设计更强——manager 由 cli.ts 的 `createMcpSetup` 创建（`ReplOptions.mcp` → `ReplMachineOptions.mcp`，该键**必填可空**，漏传即编译错误，防 runRepl→ReplMachine 断线重演），runner 结构上无法 spawn（`RunnerOptions` 不含 mcp）。print 模式同样经 createMcpSetup，`onRunStart/onRunEnd` 包住唯一 run（晚到握手停在 pending，不泄漏进 wire），close 放 finally（失败 run 也杀子进程）。config 发现路径可注入（沙箱 home）
- **shutdown**：repl 统一退出路径 `gracefulExit` 调 `manager.close()`（§3 关闭序列）；双 Ctrl+C 强退路径同步 `kill()` 不 await；run 中断（abort）**不**杀服务器进程，只断 pending 调用等待
- **重连后重注册**：先移除旧工具对象再 push 新的——避免重名堆叠

## 6. REPL 面

- **`/mcp`**（`allowedDuringRun: true`，只读）：
  - 无配置：`no MCP servers configured (looked in: <五路径>)`
  - 有：每服务器一行——`zai-vision: connected · 2 tools` / `failed · <错误一行>` / `connecting…` / `disconnected`（掉线后陈旧工具仍可调用，见 §3 重连）/ `disabled`；`mcp.enabled=false` 时：`mcp disabled in settings`；`IMP_MCP=0` 时：专用环境行（不谎报"无配置"）
- **settings**：`mcp.enabled`（boolean，默认 true）——/settings 面板一行 + coerce 校验，走 M15 机器
- **/help**：命令表加 `/mcp` 行（金样钉随动）
- **README**：MCP 段——配置示例（zai-vision 原样）、发现顺序、v1 范围与七项延后表（含触发条件）

## 7. 测试计划

fixture：`test/helpers/mcp-fake-server.mjs`——讲 NDJSON 的假服务器（可配置：握手延迟/工具列表多页/慢调用/报错 isError/非文本块/垃圾行/收到 cancelled 通知即回）。

| 面 | 用例 |
|---|---|
| config | 发现序合并（项目覆盖全局、整体替换）、disabled 跳过、env 三形态展开、坏 JSON 文件跳过、坏条目跳过、无配置零服务器 |
| client | 握手拿工具、nextCursor 两页合并、10 页上限、调用超时、abort 中断、非 JSON 行容错、进程退出未决拒绝、连接超时标 failed |
| bridge | 命名/撞内置名拒绝+note/超长拒绝、schema 直通与规范化、isError 直通、非文本块尾注、空 description 兜底 |
| 生命周期 | **晚到工具 run 边界 flush（run 中连接完成→本 run 不可见不可调、边界后可见可执行）**、**启动失败 run 边界重试（上限 3+冷却）**、中途掉线调用触发重连后重注册不堆叠、**hermetic 显式 tools 路径不 spawn**、shutdown 杀进程（进程存活探测）、abort 不断服务器 |
| repl/e2e | /mcp 四态渲染、mcp.enabled=false 全跳过、端到端（fake provider 驱动模型调 mcp 工具→结果回模型）、abort 不断服务器 |
| TUI | /help 金样、/mcp 输出 |
| 真机 | zai-vision：/mcp connected、模型调 analyze_image 识别本地图片（验收场景） |

门禁照旧：全量 vitest、typecheck 0、biome 净、dist 冒烟（dist 产物 + 假服务器端到端）。

## 7.5 独立审查（第二轮，实现后）

reviewer 对 `f59065b` 全量 diff 对抗审查，结论 BLOCK → 全部修复并补钉子：

- **P1-1 runRepl→ReplMachine 断线**：`ReplMachineOptions.mcp` 漏传（可选键 tsc 静默）→ 四处死代码：优雅退出不杀子进程（pty 实测 /exit 挂起）、run 边界 parking 不生效、启动失败重连死、/mcp 永远显示"无配置"。修复=补传 + 该键改必填可空（漏传即编译错误）+ `test/mcp-wiring.test.ts` 驱动真 runRepl 钉住（/mcp 渲染 + /exit 后 pid 见证子进程死亡）。
- **P1-2 print 模式失败路径泄漏**：mcp 声明在 try 内，provider 抛错后不 close → `imp -p` 挂起。修复=close 移入 finally。
- **P2-3 print 模式无边界机**：晚到握手会 splice 进在飞 run 的活数组（模型可见不可执行）。修复=onRunStart/onRunEnd 包住唯一 run。
- **P2-4 分块 UTF-8 截断**：逐块 `toString("utf-8")` 使跨块多字节字符腐坏 → 整行被当杂散行丢弃 → 120s 挂起。修复=字节缓冲、按 0x0A 切、完整行才解码（10MB 守卫随之变成真字节计量，P3-13）。钉子=utf8split 模式（中文描述跨块写回）。
- **P2-5 页上限静默**：设计要求"超限记 note"，实现只 return。修复=listTools 返回 `{tools, capped}`，manager 记 note。钉子=liarcursor 模式（永不结束的 cursor）。
- **P2-6 桥接结果无截断**：违反仓内"工具自己截断输出"不变量（bash 50KB 尾截）。修复=mapCallResult 按 MAX_BYTES 尾截+注记。
- **P2-7 §7 桥接测试面未兑现**：补 `test/mcp-bridge.test.ts`（normalizeInputSchema 四态/directToolName 拒绝/mapCallResult 五态）；blocks 工具进 fixture 工具表（原先的"非文本省略"测试是假阳性——调用根本不存在的工具）；slow 工具的 cancelled 通知加回执见证（FAKE_MCP_CANCEL_FILE）。
- **P3**：abort 监听器泄漏（settle 时 removeEventListener + 正常完成后监听数归零钉子）；connect 失败杀进程升级为完整优雅序列；/mcp 对 IMP_MCP=0 显示专用行（原先谎报"无配置"）；/settings mcp 行加 envShadow；schema 显式非 object 类型改整体换新（§4"包一层"原意）；设计文档四处对齐（本节 + §3 重试上限语义 + §5 接缝 + §6 disconnected）。
- **对齐断言复核**：reviewer 找不到 adapter 源码（任务书给错路径）→ 亲自核实 `/Users/z/.pi/agent/npm/node_modules/pi-mcp-adapter/`：三形态 env 展开（utils.ts interpolateEnvVars）、字段级合并+URL 凭据绑定（config.ts mergeConfigs/URL_BOUND_AUTH_FIELDS）、promptSnippet 截断 100（index.ts）全部属实，引用坐标已修入附录。

## 8. 风险与开放问题

- **R1 npx 冷启动**：首次下载可能超 45s 连接超时 → failed + run 边界重试（≤3 次）；note 里给"再试一次"指引
- **R2 版本协商宽松性**：接受异版本不停连。真机已验证（2026-02-06，zai-vision）：initialize 回 `protocolVersion: "2025-06-18"`（与请求一致）、`serverInfo: {name: "zai-mcp-server", version: "0.1.5"}`、`capabilities` 仅 `tools`——宽松协商无需触发，握手形状即设计假设
- **R3 大输出**：单行 10MB 上限断连（防御性，罕见）
- **R4 Windows**：spawn 细节（shell 解析）未验证——imp 现有 CI 只覆盖 mac/Linux，记档
- **R6 settings 键命名**：`mcp.enabled` 单键起步；后续 per-server enable 走配置文件 `disabled` 键（§2），不进 settings——避免两处开关打架

## 9. 文件清单与规模

| 文件 | 内容 | 估行 |
|---|---|---|
| `src/mcp/config.ts` | 发现/合并/展开/容错 | ~130 |
| `src/mcp/client.ts` | spawn/NDJSON/握手/分页/调用/超时/abort/关闭 | ~280 |
| `src/mcp/bridge.ts` | 命名/schema/execute 语义 | ~120 |
| `src/mcp/manager.ts` | 多服务器编排/connectAll/close/status/两场景重连/pending flush | ~190 |
| settings/commands/repl 接线 | 总门、/mcp、生命周期 | ~100 |
| `test/mcp-*.test.ts` ×4 + fake server | §7 | ~550 |

合计 src ~800、test ~600。规模类比 M13（images）。
