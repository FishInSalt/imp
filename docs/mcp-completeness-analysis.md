# imp MCP 模块完备性分析（对照 pi-mcp-adapter 2.34.0 与 Claude Code 2.1.88）

状态：分析报告（只读分析 + 测试核实，未改产品代码）
日期：2026-09-29
基线：imp `f417fba`（main）——`src/mcp/` 4 文件 922 行 + 6 个测试文件 55 用例
参考：
- `pi-mcp-adapter@2.34.0`（本机安装包 `/Users/z/.pi/agent/npm/node_modules/pi-mcp-adapter/`，~29k 行 TS；pi 的 coding-agent README（packages/coding-agent/README.md:499）明言 "No MCP"，MCP 由该扩展承载）
- Claude Code 2.1.88 还原源码（`/Users/z/Z/claude-code-sourcemap/restored-src/`）

## 0. 结论

**在 M18 声明的 v1 范围（stdio 传输、工具面、直连平铺、无会话内管理）内，imp 的 MCP 模块是完备的**：设计、实现、测试三条线对齐，55 个 MCP 用例与全仓 2507 个用例全过（§7），M18 两轮独立审查的修复均有测试钉住。配置容错、分页、UTF-8 分块、abort 监听器清理等细节甚至比 Claude Code 的客户端更严格（后者对 `tools/list` 不分页、`roots` 之外的细节从简）。

**但相对两个参考实现，完备性只在 v1 声明范围内成立**：

1. D5 七项延后的判断今日仍然成立（§3 逐项复核）。（2026-09-29 追踪：第 1 项触发已命中——Tushare 官方 MCP 为远程端点；HTTP 传输工作梳理见 `docs/mcp-http-transport-scoping.md`。）其中 sampling 一项目前与 Claude Code 同档——CC 2.1.88 的能力面只有 `roots` + `elicitation`（client.ts:989-1000），也不支持 sampling；pi 扩展则支持。
2. 新发现 **5 项 D5 未覆盖的缺口**（§4），其中 1 项是安全姿态问题，建议不等触发直接修：
   - **F1 项目级 mcp 配置不受 M8 trust 门保护**（未信任目录的 `.mcp.json` 也会在启动时 spawn 进程）——与本仓自己的信任模型矛盾，Claude Code 有项目服务器批准门；
   - F2 `notifications/tools/list_changed` 被忽略（服务器热更工具后注册表过期）；
   - F3 服务器 `instructions` 未消费（模型看不到服务器使用指南）；
   - F4 非文本内容块（图片等）被丢弃（M13 通道未接，设计里写了"留待后续"但没有触发条件）；
   - F5 会话内管理面缺失（`/mcp` 只读；pi/CC 都有重连/启停/导入面）。
3. 另有 8 项小项（§5 表）：配置发现路径与 pi 2.34.0 的两处漂移、超时不可配、无按需连接模式、无 roots 能力、无名称规范化等，均给出触发条件，不新增工作项。

一句话：**"是否完善"取决于范围声明。当前 v1 范围内是完善的；D5 之外还有 1 个应该立即补的安全缺口和 4 个值得记入触发表的兼容/能力缺口。**

## 1. 范围与方法

- imp 侧：通读 `src/mcp/`（config/client/bridge/manager 四个文件全量）、`cli.ts`/`repl/commands.ts`/`core/settings.ts`/`core/system-prompt.ts`/`runner.ts` 的接线、`docs/m18-mcp-design.md` 与 `docs/prompt-audit-design.md` 相关决策；核对 6 个测试文件的 55 个用例名与断言面。
- pi 侧：以 2.34.0 安装包为准确认传输、OAuth、配置来源、代理/直连模式、sampling/elicitation、notifications、输出守卫、审批、面板等行为（关键行号见 §8）。
- CC 侧：以还原源码为准清点 8 种传输、7 种配置 scope、OAuth/McpAuthTool、resources/prompts/elicitation/instructions、项目批准门、`/mcp` 与 `claude mcp` 命令面。
- 验证：`npx vitest run`（全仓）与 6 个 mcp 文件定向运行，均在基线提交上执行（§7）。
- 定位差异声明：pi 是"核心明确不做 MCP、全能力交给扩展"的路线（29k 行、默认代理工具、懒连接、OAuth 全套）；CC 是商业产品全功能面（8 传输、企业策略、插件/连接器体系）；imp v1 是有意的最小面（922 行、直连、仅 stdio）。**完备性判断以 imp 自己声明的范围与触发条件为准，不以功能计数为准。**

## 2. imp 现状盘点（v1 范围）

| 面 | 现状 | 关键位置 | 测试钉子（6 文件 55 用例） |
|---|---|---|---|
| 配置发现 | 5 路径按序合并；后文件按服务器名整体替换；`disabled` 跳过但保留展示；env 三形态展开（`${VAR}`/`$env:VAR`/`{env:VAR}`，未定义→空串）；坏文件/坏条目一行 note 跳过 | config.ts:39-133 | 发现序、三形态展开、整体替换、disabled、坏 JSON/坏条目（10 例） |
| stdio 客户端 | NDJSON 分帧、字节缓冲防 UTF-8 截断、>10MB 行断连、杂散行跳过；握手后发 initialized；宽松版本协商；`tools/list` 游标分页（10 页上限+note）；45s 连接/120s 调用超时；abort→拒绝+`notifications/cancelled`；stderr 2KB 环形缓冲；优雅关闭（stdin.end→3s→SIGTERM→2s→SIGKILL） | client.ts（22-27 常量） | 握手、坏行容错、两页合并、游标上限、UTF-8 跨块、两种超时、abort+取消通知、监听器归零、进程死拒绝未决（12 例） |
| 工具桥接 | `<server>_<tool>` 命名（pattern 校验+内置名/重名拒绝+note）；JSON Schema 直通+最小规范化；`isError` 直通；文本块拼接、非文本块计数注记（见 F4）；MAX_BYTES 尾截断；空描述兜底；promptSnippet ≤100 字 | bridge.ts（25/37/51/73） | schema 四态、命名三拒绝、文本拼接、非文本注记、isError、截断、snippet（16 例） |
| 生命周期 | 启动 fire-and-forget；run 中完成的工具 parking 到边界 flush；启动失败 run 边界重试（上限 3+30s 冷却）；中途掉线调用触发单飞重连+一次重试；重连后重注册不堆叠；close/kill 双路 | manager.ts（26/28 常量） | 晚到注册两侧、启动失败重试、掉线重连、close pid 见证、关闭后不 spawn、onToolsChanged（12 例） |
| 用户面 | `/mcp` 只读状态（五态+错误行，run 中可用）；settings `mcp.enabled` 总门；`IMP_MCP=0` 环境逃生；`/help` 金样 | commands.ts:1818-1856；settings.ts:55-118 | /mcp 状态渲染、settings 门、“looked in”教学（repl 3 例） |
| 系统提示 | prompt-audit P7/D10：MCP 工具进路由目录（100B/条+2KB 预算，超预算降级为按服务器一行）；每次工具数组同步后刷新 | system-prompt.ts:78-95；runner.ts:715-730 | onToolsChanged 触发面、e2e 目录（含在 manager/repl 用例） |
| 端到端 | fake provider 全回合调用；真 runRepl `/mcp` 渲染 + `/exit` 后子进程死亡见证；print 模式 onRunStart/onRunEnd/finally close | cli.ts:686-704/1042-1061 | repl e2e 1 例 + wiring 1 例（pid 见证） |

M18 设计 §7.5 记录的两轮独立审查（P1×2/P2×5/P3×6）修复均有对应钉子，且本轮复跑全过。

## 3. D5 七项延后逐项复核（"维持"=触发条件未出现，继续延后）

| # | 项 | 参考实现现状 | imp 现状 | 结论 |
|---|---|---|---|---|
| 1 | OAuth/HTTP 传输 | pi：streamable-http(+SSE 回退)、unix socket、OAuth 全套（DCR/CIMD、client_credentials、密钥环/加密文件、headers command、CA）；CC：sse/http/ws(+OAuth PKCE/回环/keychain/McpAuthTool) | 无（仅 stdio） | **触发已命中（2026-09-29）**：Tushare 官方 MCP 为远程 HTTP 端点——HTTP 传输进入实施梳理（`docs/mcp-http-transport-scoping.md`）；OAuth 子项维持延后但有前提——Tushare 官方配置用 URL 内嵌 token，端点同时广播 OAuth 元数据，token 形态是否足够以真机握手为准 |
| 2 | Sampling | pi：支持（仅文本，带同意，模型偏好提示）；CC 2.1.88：**不支持**（能力面只有 roots+elicitation） | 对 `sampling/createMessage` 回 -32601 | 维持；imp 与 CC 同档 |
| 3 | Elicitation | pi：form+url 两模式、校验、拒绝/取消语义；CC：form+url、schema 校验、hooks、完成通知 | 对 `elicitation/create` 回 -32601 | 维持；触发：某服务器核心流程依赖中途问句 |
| 4 | Resources/Prompts | pi：资源默认暴露为 `read_*` 工具，prompts 变 `/mcp__server__prompt` 命令，`mcp:` 引用语法；CC：List/Read 工具+`@server:uri` 提及+启动预取，prompts 变命令 | 均无 | 维持；触发：接入文档型/工作流型服务器 |
| 5 | 逐调用审批门 | pi：`approveTools` 常量/数组，会话批准持久化，headless fail-closed；CC：passthrough 权限+规则建议 | 无 | 维持；触发：接入持凭据/带副作用服务器。注意与 F1 的边界不同（F1 是启动即执行，与工具调用无关） |
| 6 | 跨厂商配置导入 | pi：imports 支持 cursor/claude-code/claude-desktop/opencode/vscode/windsurf/codex + hostConfigDiscovery；CC：add-from-claude-desktop | 无 | 维持；触发：在别处配了大量服务器 |
| 7 | `mcp` 元工具代理 | pi：默认代理工具（search/describe/instructions/install 等动作）+ directTools/命名空间模式；CC：`mcp__` 前缀+搜索折叠 | 平铺直连（有意偏离） | 维持；触发：接入工具数 ≥10 的服务器 |

## 4. 新发现（D5 未覆盖）

### F1 项目级 mcp 配置不受 M8 trust 门保护（安全姿态，建议立即修）

- imp 现状：`createMcpSetup` 只检查 `IMP_MCP`/settings 门，随即 `discoverMcpConfig({ cwd })`（cli.ts:686-690），五条路径中的项目级两条 `<cwd>/.mcp.json`、`<cwd>/mcp.json`（config.ts:39-48）读入即由 `manager.connectAll()` spawn。全程不看目录信任。
- 与本仓模型矛盾：M8 trust 门正是为"项目级可执行资源"而设——`.imp/extensions`（extensions/loader.ts:178）、项目 settings（settings.ts:159-165）、skills（skills.ts:304）、SYSTEM.md/命令等，未信任全部跳过；`--no-trust` 的说明也只覆盖 `.imp/` 资源（core/trust.ts）。**项目级 mcp.json 是本仓门禁的漏网面**（trust.ts:201-236 的受门禁资源清单不含这两条路径；邻近的 `.imp` 资源在 cli.ts:632-636 拿到 `projectTrusted`，MCP 两处（cli.ts:649、:1047）都没有）：在未信任的克隆仓库里启动 imp，仓库自带的 `.mcp.json` 会在用户看到任何界面之前 spawn 任意 command。
- 参考：CC 对项目服务器有显式批准门——`getProjectMcpServerStatus` 返回 `pending|approved|rejected`，pending 不连接，由 `handleMcpjsonServerApprovals` 弹窗批准（services/mcp/utils.ts:351-405；services/mcpServerApproval.tsx；源码注释直指恶意项目配置的 RCE 风险）。pi 2.34.0 未发现同类门（项目配置读入即用；config.ts:520 的信任边界注释只约束 ancestor 发现）——imp 当前与 pi 一致、与 CC 不一致。但 imp 有自己的 M8 模型，应服从本仓姿态。
- 建议：把两条项目路径并入 M8 trust 判定（未信任→跳过+note；`--trust`/会话信任后正常读）。改动小：`createMcpSetup` 已有 `runner`，把 `projectSettingsAllowed` 同源的 trust 位传给 `discoverMcpConfig` 过滤项目路径即可；测试加"未信任项目含 .mcp.json 不 spawn（pid 见证）"。
- 触发：立即（属修复类，不设触发条件）。补偿路径：global 层（`~/.config/mcp/mcp.json`、`~/.agents/...`）不受影响，用户显式信任目录后项目层恢复。
- 与 M18 §1 注的张力（审查提出）：M18 记录过"imp 模型本就握着 bash/write（全能力面），MCP 工具不构成能力增量"。那条论证针对运行期工具调用；F1 针对的是启动时、在用户与任何确认流程介入之前的进程执行，且 M8 的既有姿态正是"项目级可执行资源未经信任不跑"——两者不冲突。

### F2 `notifications/tools/list_changed` 被忽略

- imp 现状：`handleLine` 末行明文"v1 ignores server notifications"（client.ts:186-210 区域）；服务器声明 `tools.listChanged` 并热更工具后，imp 的注册表继续用旧快照——新工具永不出现（直到重连才重拉），被删工具仍发给模型、调用即错。
- 参考：pi 处理 tools/resources/prompts 三类 list_changed（server-manager.ts:1156-1245）并有 keep-alive 刷新兜底；CC 三类均处理（useManageMCPConnections.ts:616-750）。
- 建议：收到 `notifications/tools/list_changed` → 重拉 `tools/list` → 复用现有 `applyTools`/pendingSync 机制在 run 边界换注册（基础设施都在，改动小）。
- 触发：接入会动态变更工具集的服务器（聚合型/按需开通型服务器常见）。

### F3 服务器 `instructions` 未消费

- imp 现状：`connect()` 只读 `protocolVersion`（client.ts:129-140 区域），initialize result 的 `instructions` 字段直接丢弃。
- 参考：pi 存储 instructions 并在代理 `describe` 中给出预览+全文入口（server-manager.ts:974；proxy-modes.ts:835-841）；CC 有 instructions delta 注入（mcpInstructionsDelta.ts；按服务器名 diff、2048 截断）。
- 影响：服务器使用指南（"工具都是只读"、"先 search 再 fetch"、"写操作需 X"）对模型不可见——部分服务器把关键约束放在 instructions 而非工具描述里。
- 建议：小改。最低成本：握手完成后一条 note（用户可见）；完整版：并入系统提示 MCP 段——prompt-audit D10 的目录已有 100B/条+2KB 预算与降级机制（system-prompt.ts:78-95），instructions 可按服务器截断参与预算。
- 触发：任一服务器返回非空 instructions（可先只做 note，零提示成本）。

### F4 非文本内容块（图片等）被丢弃

- imp 现状：`mapCallResult` 只拼 text 块，其余仅计数注记 `(N non-text block(s) omitted)`（bridge.ts:51-71）。M18 设计 §4 写了"图片内容块映射进 `ToolExecuteResult.content`（M13 通道）留待后续"，但未进 D5 表、无触发条件。
- 参考：pi 图片块原样透传（output guard 对图片放行，mcp-output-guard.ts:160）；CC 对图片缩放/降采样后嵌入结果（client.ts:2478-2570）+二进制存盘。
- 影响：图片型服务器（截图、图表、图像生成）的结果在 imp 里只剩一句计数——是能力损失，不是体验问题。现有验收服务器 zai-vision 返回文本，所以 v1 验收无感。
- 建议：接 M13 通道——`ToolExecuteResult.content` 已是 `ContentBlock[]`（core/tools/types.ts:59-67），read 工具的图片路径同款；对 `image`/`audio` 块直接映射。这是设计已预留、只是没排期的改动（约 bridge.ts 二三十行+测试）。
- 触发：接入任一返回非文本块的服务器。

### F5 会话内管理面缺失

- imp 现状：`/mcp` 只读（commands.ts:1818-1856）——看得到状态，动不了（无重连、无启停、无编辑/导入）；改配置=手编 JSON+重启会话。
- 参考：pi `/mcp` 面板（启停/重连/OAuth/save，mcp-panel.ts）+ setup 导入向导 + CLI；CC `/mcp` 对话框（reconnect/enable/disable）+ `claude mcp` 九个子命令（add/remove/list/get/add-json/import 等）。
- 建议（最小面，不追求面板）：`/mcp reconnect <server>`——复用 `connectServer`，绕过冷却强制重连一次；可选 `/mcp enable|disable`（写项目层配置，与 pi 对齐）。触发：实际遇到需要热恢复时，或配置服务器数 ≥2。
- 备注：`/mcp` 保持 run 中可用（只读）的既有决策不变；reconnect 需新定 allowedDuringRun 语义（建议 run 边界生效，与晚到注册同哲学）。

## 5. 小项清单（记档用，均带触发条件）

| # | 项 | imp 现状 | 参考 | 建议/触发 |
|---|---|---|---|---|
| S1 | 配置发现路径漂移 | 五路径：generic global / agents×2 / `<cwd>/.mcp.json` / `<cwd>/mcp.json`（config.ts:39-48） | pi 2.34.0 实际为：generic / agents×2 / **agent-dir 全局 override**（`~/.pi/agent/mcp.json`） / `<cwd>/.mcp.json` / **`<cwd>/.pi/mcp.json`**（config.ts:15-21 + getAgentDir/getConfigDirName） | README 的 "the same config files pi's adapter reads" 不准确：imp 少了 pi 的 agent-dir 全局层，且第 5 条与 pi 的项目 override 不是同一文件（M18 转述把常量名 `PROJECT_PI_CONFIG_NAME="mcp.json"` 误读为项目根 `mcp.json`）。触发：pi 用户迁移时补两源或修正文档措辞；注：该误读已进 imp 源码注释（src/mcp/config.ts:3-8）与 README，修正面包括注释 |
| S2 | 超时不可配 | 45s 连接/120s 调用硬编码（client.ts:26-27） | pi 每服务器 `requestTimeoutMs`/`idleTimeout`；CC 连接 `MCP_TIMEOUT` | 触发：某服务器需要非默认预算 |
| S3 | 无按需连接模式 | 启动即连所有服务器（fire-and-forget），npx 冷启动成本每会话支付 | pi 默认 lazy（`lifecycle`），另有 keep-alive；CC 启动连接但有批处理 | 触发：服务器多/启动慢时引入 lazy（调用路径的 `ensureClient` 已具备基础） |
| S4 | 无 roots 能力 | 能力声明 `{}`；对 `roots/list` 回 -32601 | CC 声明 `roots:{}` 并按 `file://cwd` 应答（client.ts:989-1010）；pi 也未实现 | 低优先；触发：某服务器依赖 roots 限定作用域时向 D5 表补一行 |
| S5 | 工具名规范化 | 整名必须匹配 `^[a-z][a-z0-9_-]{0,63}$`，否则整条跳过（bridge.ts:37-49） | CC 非法字符替换为 `_` 并截 64（normalization.ts）；pi 有 fuzzy/前缀策略 | 触发：服务器名/工具名含大写或点（如 `GitHub.search`）时考虑"规范化+冲突检查"替代"整条拒绝" |
| S6 | structuredContent 未消费 | 只读 `content`（bridge.ts:51） | pi 校验 outputSchema；CC 结果处理含 structuredContent | 低优先（协议要求 content 必在，合规服务器不受影响）；触发：遇到只回 structuredContent 的服务器 |
| S7 | 无健康检查/ping | 掉线靠 exit/error 事件；挂起进程由每次调用 120s 超时兜底 | pi keep-alive 健康检查+退避；CC 仅远端自动重连（stdio 同凭事件） | 低优先；触发：出现"进程活着但不应答"的服务器 |
| S8 | progress 通知忽略 | 长调用无进度（调用行 UI 有耗时） | CC 完整 mcp_progress 事件+心跳；pi 亦有限 | 低优先；触发：慢工具希望看到进度时 |

不构成缺口的对照（避免误列）：`tools/list` 分页（imp 有游标+上限，CC 反而单页不翻）；结果尾截断（imp 按 MAX_BYTES，pi 输出守卫、CC 大输出存盘——语义不同但都有界）；版本协商（imp 宽松接受，pi legacy/modern 双轨，CC 走 SDK 协商——对仅 tools 的客户端等价）。

## 6. 建议汇总（按处置顺序）

1. **F1**（修，不设触发）：项目级 mcp 配置并入 M8 trust 门；补 pid 见证测试。
2. **F2**（小改，触发临近）：tools/list_changed → 重拉+run 边界换注册。
3. **F3**（小改，零成本起步）：instructions 先进 note，后考虑进目录预算。
4. **F4**（中改，触发：图片服务器）：非文本块接 M13 通道。
5. **F5**（UX，触发：需要热管理）：`/mcp reconnect`（可选 enable/disable）。
6. **S1-S8**（记档）：随对应触发条件并入 D5 表或顺手修正（S1 建议至少修正 README 措辞）。

D5 表本身建议增补两行（roots、list_changed）或将其折进"新发现"台账，使"延后项均有触发条件"的声明保持完整。

## 7. 验证记录

| 检查 | 命令 | 结果 |
|---|---|---|
| MCP 定向 | `npx vitest run test/mcp-{client,config,bridge,manager,repl,wiring}.test.ts` | 6 文件 55 用例全过（2.06s） |
| 全仓 | `npx vitest run` | 128 文件 2507 用例全过（25.32s） |

两处运行均在 `/Users/z/Z/Agent_demo/imp`（基线 `f417fba`）执行；分析 worktree 无 node_modules，未在其中运行测试。本次未重测真机（M18 设计文档已记录 zai-vision 真机验收通过），未调用真实模型。

## 8. 关键引用坐标

imp（`f417fba`）：
- `src/mcp/config.ts:39` 发现路径 / `:51` env 展开 / `:94-133` 合并与容错
- `src/mcp/client.ts:22` 协议版本、`:24` 分页上限、`:26-27` 超时、`:122` 能力声明、`handleLine` 通知忽略、`shutdown` 关闭序列
- `src/mcp/bridge.ts:25` schema 规范化 / `:37` 命名 / `:51` 结果映射 / `:73` snippet 截断
- `src/mcp/manager.ts:26` 重试上限、`:28` 冷却、`onRunStart/onRunEnd`、`ensureClient`
- `src/cli.ts:686-704` createMcpSetup（交互+print 共用）、`:1042-1061` print 模式接线
- `src/repl/commands.ts:1818-1856` `/mcp`；`src/core/settings.ts:55-118` settings 门
- `src/core/system-prompt.ts:78-95` MCP 目录；`src/runner.ts:715-730` 刷新
- `docs/m18-mcp-design.md` §1 D5/D6、§7.5 两轮审查、§8 风险

pi-mcp-adapter 2.34.0：
- `config.ts:15-21` 路径常量、`:183-195` agent-dir/项目解析、`:520` 信任边界注释
- `server-manager.ts:1129-1144` 能力声明、`:974` instructions、`:1156-1245` list_changed
- `proxy-modes.ts:835-841` instructions 呈现；`mcp-output-guard.ts:160` 图片放行
- `mcp-panel.ts`、`mcp-setup-panel.ts`、`commands.ts`、`cli.js` 面板/CLI 面

Claude Code 2.1.88：
- `src/services/mcp/client.ts:989-1010` capabilities(roots/elicitation)+roots 应答、`:2478-2570` 图片处理
- `src/services/mcp/utils.ts:351-405` 项目服务器批准状态
- `src/services/mcpServerApproval.tsx` 批准对话框；`src/components/MCPServerApprovalDialog.tsx`
- `src/services/mcp/envExpansion.ts`（`${VAR:-default}`）、`normalization.ts`（名称规范化）
- `src/services/mcp/useManageMCPConnections.ts:616-750` list_changed；`src/utils/mcpInstructionsDelta.ts` instructions 注入

## 9. 边界与不确定性

- pi 侧证据来自 2.34.0 安装包（`.ts` 源码随包分发）；CC 侧来自 sourcemap 还原源码，个别行号以还原文件为准。
- 未逐行复现参考实现的全部行为（如 CC 非交互模式的自动批准细节、pi 沙箱代理的完整链路）；结论只依赖 §8 列出的已读坐标。
- "未发现批准门"（F1 对 pi 的表述）为对全包 grep + 人工检查的结论，非穷尽证明。
- F1 的"漏网面"（imp 侧）结论基于受门禁资源清单（trust.ts:201-236）与 mcp 项目路径的比对，属定点核查；"唯一性"性质的穷尽证明未做（措辞已按此降级）。
- 未评估真机网络行为（npx 冷启动、真实服务器握手矩阵）；未运行 zai-vision 真机复测。
