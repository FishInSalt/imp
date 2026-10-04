# #ask-timeout — 交互确认超时（设计 r4）

- 日期：2026-10-04
- 状态：**r4.3 — 设计/实现评审均闭合（§12 短评审 CONFIRMED；实现评审复核 APPROVE：F1-F5 与两处 P3 文字修正已折）**；r3 实现已合并、机器侧验收通过（见 PROJECT_PLAN）
- 关联：`#guardian`（驱动方）、`#confirm-prompt`（承载界面）

## 1. 背景与目标

guardian 的 ask 弹窗目前会**无限等待**。owner 要求：

1. ask 审批支持超时；超时行为 = **拒绝**（不批准）；
2. 超时给 agent 的反馈必须与**手动拒绝**不同（agent 要能区分"用户说不"和"没人答"）；
3. 模板（及 owner 本机配置）默认 10 分钟。

## 2. 已定决策（owner 讨论结论）

- **D1** 宿主侧实现：定时器属于 confirm 机制本身。扩展侧自 race 定时器会留"幽灵弹窗"（用户稍后点的批准落空），禁止。
- **D2** API 形状：`ConfirmOptions` 增加 `timeoutMs?: number`（沿用 additive/全可选惯例）；`confirm()` 返回值从 `Promise<boolean>` 扩为 `Promise<boolean | "timeout">`（`true`=批准；`false`=拒绝/取消/无交互面；`"timeout"`=超时）。**批准只认字面 `true`**（见 S9）。
- **D3** guardian 配置：顶层字段 `askTimeoutMs`（毫秒正整数；缺省 = 不超时）。校验从严：非法值 = 配置错误（保留上次有效规则 + footer + reload，现行机制）。
- **D4** 审计新增第三种结果：`[ask] <source> — <subject> — timeout`（现有为 `approved` / `denied`）。
- **D5** 超时的 agent 文案与拒绝不同，拟：`the confirmation timed out after 10 minutes — the call was not approved`（规则有自定义 reason 时：`<reason> — <该文案>`）。agent 面向的新文案统一用 "not approved" 家族；`guardian internal error — the call was not allowed` 为历史既有串，保持不变。
- **D6** 超时**不授予**"本会话不再询问"（不写入 session 记忆）；Ctrl+C / Esc / EOF / 取消仍为手动拒绝（`false`）。
- **D7** 计时语义：**从弹窗真正显示起算**——排队等待（被别的 picker 挡住）不计时。绝不超时一个用户没看见的问题。（机制：排队分支在晋级时会重新调用 `select(options)`，见 §5；r1 评审已对照 `shell.ts:886-893, 972-974` 逐行核实成立。）
- **D8** 定时器结算时 `clearTimeout`；结算漏斗保持一次性守卫（已有 `settled`，"恰好超时瞬间用户回车"先到者胜）；`unref?.()`（沿用 `shell.ts:656` 的调用惯例；vitest fake timers 兼容，r1 评审已核）。

## 3. 语义规格

- **S1** 只有调用方传了 `timeoutMs`（合法正值）才计时；未传/非法 → 无限等待（现行为）。
- **S2** 计时窗口 = 弹窗从打开到被答复/关闭之间的可见时间；排队中的问题不计时（D7）。
- **S3** 超时触发时：弹窗按正常关闭路径拆除（等价取消），其 Promise 以 `"timeout"` 结算。
- **S4** 宿主在 confirm 包装层写一行 dim note，**字节定稿**：`▪ confirm: <label><message> — timed out (declined)`（`label` 取现有确认 note 的同一来源；note 点名被超时的问题——因为下一个排队 picker 会在包装层恢复前同步打开）。agent 侧反馈 = 工具结果里的 block reason（由 guardian 生成）。
- **S5** 无交互面（print / no-handler / `ask === null`）路径不变：立即 `false`，忽略 `timeoutMs`。
- **S6** readline（legacy `IMP_REPL=legacy`）路径本次**不做**超时（§10 范围外；**此限制必须写进 `ConfirmOptions.timeoutMs` 的 JSDoc**——宿主不保证 legacy 面生效）。
- **S7** 多问题并行：各自独立计时；每个问题打开时启动各自的定时器。
- **S8** `timeoutMs` 宿主侧校验宽松：非有限数/≤0/非数字 → 视为未传（扩展侧 guardian 自己从严校验配置）；**超过平台计时上限（2147483647 ms）→ 钳位到上限**——Node 对超上限的 `setTimeout` 延时会在 ~1 ms 后触发，不钳位会把"很久以后"变成"瞬间超时"（实现评审 P2#1）。
- **S9** 返回联合类型对既有调用方无破坏的**准确表述**：仅新增 `=== "timeout"` 分支；`"timeout"` 是**真值**——凡通过 `timeoutMs` 启用超时的调用方，批准判断必须写 `=== true`，不能写 `if (ok)`（JSDoc 必须写明；§9 扫描全库 `if (ok)` 式示例）。

## 4. API 变更（宿主）——r2 完整清单（r1 评审判定原表不完整，tsc 已复现 TS2322/TS7015）

| 位置 | 现状 | 变更 |
|---|---|---|
| `src/extensions/types.ts` `ConfirmOptions`（~62） | `sessionKey? / warnSpans? / rememberLabel? / preview?` | 增 `timeoutMs?: number`（注释：TUI picker 可见期计时、排队不计、非法忽略、**超上限钳位**、S6 legacy 忽略） |
| `src/extensions/types.ts` `api.confirm`（~158） | `Promise<boolean>` | `Promise<boolean \| "timeout">`；JSDoc 重写：**批准要求值恰为 `true`**；`"timeout"` 属非批准；"never hangs" 的兜底归因于调用方期限，且**仅限能承载超时的宿主界面**（legacy/无交互面不生效，见 S6） |
| `src/extensions/registry.ts`（字段 ~122、`confirm()` ~466、**Options ~94**） | `Promise<boolean>` ×3 | 同步加宽联合 |
| `src/extensions/loader.ts`（`ExtensionLoaderOptions.confirm` ~36；接线 ~255, ~267） | `Promise<boolean>` | 同步加宽 |
| `src/cli.ts`（`loadExtensionSetup` 的 confirm 参数 ~505-508；使用 ~607） | `Promise<boolean>` | 同步加宽 |
| `src/repl/line-input.ts` `SelectOptions`（~32） | — | 增 `timeoutMs?: number`（注释同 S2/S8/S6，含超上限钳位） |
| `src/repl/line-input.ts` `LineInput.select?`（~133） | `Promise<number \| null>` | `Promise<number \| null \| "timeout">` |
| `src/repl/repl.ts` `bindSelect`（~348）+ confirm 包装（~279-346） | `(options) => Promise<number \| null>`；包装 `Promise<boolean>` | 签名与返回加宽；**分支顺序定稿**：`if (choice === "timeout")` 必须紧跟在 `await select(...)` 之后、早于 `choice === null` 与 sessionKey 逻辑（否则 `"timeout" !== 2` 会走成 `approved = true`——r1 评审 P1#1）；该分支写 S4 的 note 后返回 `"timeout"`、**不**写 `sessionAllowed` |
| `src/repl/repl.ts` select 选项装配（~309-316） | 无 `timeoutMs` | **转发**：仅当 `options?.timeoutMs !== undefined` 时携带 `timeoutMs`（保持既有精确断言不被 undefined 键扰动） |
| `src/repl/repl.ts` `ctx.select` 绑定（~1559-1560） | 将 `input.select` 赋给 `Promise<number \| null>` 类型 | **`ctx.select` 保持窄类型**：绑定处适配 `r === "timeout" ? null : r`（防御性；这些调用方不传 `timeoutMs`，实际不会出现 `"timeout"`）。不采用"加宽 ctx.select"方案（会触发 `commands.ts:585/1115/1445/1507/1548/1600` 的 TS7015 索引链，收益为零） |
| `src/repl/trust-ask.ts`（~59 直用 `TuiShell.select`；~64 索引 `ANSWERS[pick]`） | `pick === null ? null : (ANSWERS[pick] ?? null)` | **独立站点**（不经 ctx.select）：直用加宽后的 select 返回必然受影响——守卫 `typeof pick !== "number" ? null : (ANSWERS[pick] ?? null)`（r2 复核 N1；非阻断，实现时修） |
| 测试侧 | `test/extensions-repl.test.ts:138` 等把 handler 传入 loader；`test/repl-tui.test.ts` 三处回调（`:1183-1187`、`:1206-1210` 的 `(value: number \| null) =>`；`:900-903` 的 `settled = value` 赋入 `number \| null \| undefined`） | loader 加宽后前者自然一致；三处回调签名需加宽/守卫（r2 复核 N1）；实现时全库扫 `confirm(` / `select?(` / mock 类型 |

**门禁补充**：`npm run typecheck`（双配置）为本次硬门禁（r1 评审用仓库 tsc 复现过原表的类型错误）。

## 5. 宿主实现点（TUI picker）

- `TuiShell.select`（`src/repl/shell.ts`）：排队分支（~886-893）不做计时——晋级时重新调用 `this.select(options)`，定时器因此天然从"真正打开"起算（D7）。
- 打开路径：picker 渲染/`this.selector` 置位后启动 `setTimeout(...).unref?.()`（延时 `Math.min(timeoutMs, 2^31-1)` 钳位，见 S8）；回调走 `finish` 漏斗新分支（结算值 `"timeout"`），拆除动作与取消完全一致（清 selector、移除 box、聚焦编辑器、晋级后续排队问题——含 `askLine` 与 `pendingSelects`）。
- `finish` 内 `clearTimeout`；保持 `settled` 一次性守卫。
- 关闭路径复用现状（不动）：`close()`（~1223-1229）、SIGINT（~505-509）、stdin end（~511-518）均按取消结算；armed 定时器由 `finish` 清理。

## 6. guardian 扩展侧

- **配置解析**：接受顶层 `askTimeoutMs`；校验 `typeof === "number" && Number.isSafeInteger && > 0 && ≤ 2147483647`（后者为平台计时上限，超上限 = 配置错误），否则整文件配置错误。**reload 生命周期**：与 rules 原子存储——成功加载（含文件不存在 ENOENT）即整体替换（ENOENT → 无超时）；加载失败保留上次有效。`_` 前缀忽略规则不变。
- **调用**：ask 命中时 options **仅在配置存在时**携带 `timeoutMs`（同 §4 转发约定）。
- **结果三分支（严格比较）**：

```text
outcome === true       → 批准：return undefined；审计 — approved
outcome === "timeout"  → 审计 — timeout；block reason：
                         <reason 前缀（若有）> + "the confirmation timed out after <时长> — the call was not approved"
否则（false）           → 拒绝：现行「the user declined this call」路径
```

- **`humanDuration` 算法定稿**：`ms >= 60000` → `n = max(1, round(ms/60000))` → `` `${n} minute${n === 1 ? "" : "s"}` ``；`ms < 60000` → `n = max(1, round(ms/1000))` → `` `${n} second${n === 1 ? "" : "s"}` ``。边界：999→"1 second"、1000→"1 second"、59999→"60 seconds"、60000→"1 minute"、90000→"2 minutes"、600000→"10 minutes"（配 §8 边界单测）。**契约外兜底**：宿主违反契约在无配置期限时报 `timeout` 时，文案退化为 `the confirmation timed out — the call was not approved`（`humanDuration(undefined)` 不得产生 "NaN seconds"；实现评审 P3#7）。
- **内部错误回退路径**：同样携带 `timeoutMs`；超时结果 → 审计 `[ask] internal error — <subject> — timeout`；block reason 保持 `guardian internal error — the call was not allowed`（历史串不动）。

## 7. 模板与本机配置（在本功能落地后执行）

- **`examples/extensions/guardian.template.json` 全量重写**（明确任务，不是只加一个字段）：去敏版 = 家目录整体 `~`/`$HOME` 两条 + 文件系统根 + 毁盘（`diskutil erase*`/`apfs delete*`/`dd` 裸设备）+ `.ssh`（`~`/`$HOME` 两写法，两条）+ ask 两条 + `"askTimeoutMs": 600000`；不含 `/Users/z`、Desktop 等本机特有项（`_comment` 提示用户自补自己家的绝对路径）。
- **注意**：现有 `test/guardian.test.ts:610-629` 钉着**旧模板**的行为（`rm -rf /tmp/x` 放行 + 四条 confirm 流）——重写模板必须同步改写该测试（列入 §8）。
- owner 本机 `~/.imp/guardian.json` 加 `"askTimeoutMs": 600000`（随本次一起安装，重启一次）。

## 8. 测试矩阵（r2）

**宿主单元（fake timers）**

1. picker 打开 + `timeoutMs` → 推进时钟 → `"timeout"` 结算；随后到达的手动答复无效（一次性守卫）。
2. 手动答复先到 → 定时器清理，时钟再推进不产生 `"timeout"`。
3. 排队：A 打开时 B 入队（带 `timeoutMs`）→ 推进超过 B 期限、A 未关闭 → B 不超时（D7）；**A 以超时结束时**，被晋级的 B 从打开时刻获得全新计时窗口。
4. **换接路径**：armed 定时器 + `close()` → promise `null`，时钟越过期限无第二次结算、无崩溃；SIGINT / stdin end 同断言。
5. confirm 包装：**带 sessionKey** 且 select→`"timeout"` → 返回 `"timeout"`、写 S4 定稿 note、**不**写 `sessionAllowed`（随后同一 sessionKey 的 confirm 仍打开 picker）；`choice === null` 仍 `false`；无 sessionKey 路径同。
6. **转发**：confirm 调用带 `timeoutMs` → bound select 收到该值；未带 → select 选项不含该键。
7. 非法 `timeoutMs`（0 / 负数 / NaN / 字符串）→ 无计时，行为同现状。
8. registry：handler 返回 `"timeout"` 透传；无 handler / print 路径仍 `false`（回归）。
9. **集成**：fake/真实 TuiShell + `TtyConfirm.handler` 连线一条完整超时流（guardian options → select 定时器 → 包装 note → `"timeout"` 返回）。

**guardian 单元**

10. `askTimeoutMs: 600000` → `api.confirm` options 带 `timeoutMs: 600000`；未配置 → 不带键。
11. outcome `"timeout"` → block reason 文案正确 + 审计 `— timeout`；有自定义 reason 时前缀格式正确。
12. `askTimeoutMs` 非法（字符串 / 0 / 负）→ 配置错误路径（保留上次有效 + footer）。
13. reload：成功加载（含 ENOENT）替换超时值；加载失败保留。
14. `humanDuration` 边界单测（999 / 1000 / 59999 / 60000 / 90000 / 600000）。
15. 内部错误回退 + `askTimeoutMs`：options 带 `timeoutMs`；回退返回 `"timeout"` → 审计 `— timeout`、block reason 保持历史串；批准/拒绝分支不受扰动。
16. 模板重写后的新 pin（替换 `test/guardian.test.ts:610-629` 旧断言）——本项与 §7 同批执行（宿主 API 落地之后），随该批过全量门禁。

**门禁**：`npm run build`、`npm run typecheck`（双配置）、`npm run lint`、`npm run test`（全量）。

**r3 折叠补充（实现评审 2026-10-04）**：超上限钳位（S8；repl-tui 测"不瞬发、手动答复仍胜出"）；guardian 上限 2147483647 接受 / 2147483648 配置错误；ENOENT 重载连期限一起清（guardian 测试）；契约外宿主 `timeout` + 无配置期限 → 退化文案（guardian 测试）；非法值循环补字符串 `"500"`；stdin end + armed 定时器 → `null`（repl-tui 测试）。

## 9. 文档与变更记录

- `docs/guardian-design.md`：配置 schema（`askTimeoutMs` + reload 语义）、ask 流程（三分支、审计第三态、超时文案）+ rev 递增。
- `types.ts` JSDoc（§4 三条：批准=字面 true；timeoutMs 可见期/排队/非法语义；**legacy/无交互面不生效**）。
- `docs/confirm-prompt-design.md:545`："api.confirm still resolves boolean" 已过时——同步更新。
- README / 扩展文档：全库扫 `if (ok)` 式 confirm 示例并改成 `=== true`；扫描 `api.confirm` 提及处。
- CHANGELOG：guardian 条目补一句 ask 超时（或单开一条）。

## 10. 范围外（v1）

- 每条 ask 规则独立超时（先全局一个字段；需要再加覆写）。
- ~~弹窗上的倒计时显示~~ → 已追加为 §12（#ask-timeout-countdown，owner 2026-10-04）。
- readline legacy 路径与 `secret`/login 等其它问询形式的超时（S6）。
- 超时记忆（"这个问题超时过"）——不做。

## 11. 评审记录

- **r1 独立对抗评审：NEEDS-FIXES**（2×P1、6×P2、3×P3；另证实 D7 的排队机制、§4 行号、`unref()` fake-timer 兼容性成立，并用仓库 tsc 复现了原 API 表的类型错误）。r2 折叠如下：
  - **P1#1（超时分支位置）** → §4 repl.ts 行：分支顺序定稿 + §8-5 补 sessionKey 全链测试（含"不写 sessionAllowed、同 key 仍弹"）。
  - **P1#2（API 表不完整 / 兼容性声明不实）** → §4 补齐 cli.ts / loader.ts / registry.ts Options / ctx.select 决策（窄类型+绑定适配）+ 门禁加 typecheck。
  - **P2#3（timeoutMs 转发未规定）** → §4 转发行（仅当设置时携带）+ §8-6。
  - **P2#4（"timeout" 真值陷阱）** → D2/S9/JSDoc 三处写明"批准=字面 true"+ §9 全库扫描。
  - **P2#5（竞态矩阵缺口）** → §8-4（close/SIGINT/stdin-end armed）、§8-3（B 由 A 超时晋级）、§8-9（集成）。
  - **P2#6（humanDuration 边界）** → §6 算法定稿 + §8-14。
  - **P2#7（§7 模板描述与现存文件不符）** → §7 改为"全量重写"任务 + 旧测试同步改写（§8-16）。
  - **P2#8（内部回退路径自相矛盾）** → §6 明确 + §8-15。
  - **P3#9（reload 生命周期）** → §6 原子替换语义 + §8-13。
  - **P3#10（S4 note 无定稿文本/归属）** → S4 字节定稿 + §8-5。
  - **P3#11（文档清扫缺口）** → §9 四项（JSDoc legacy 限定 / confirm-prompt-design:545 处 / "not approved" 家族 / `unref?.()` 风格入 D8）。
- **r2 复核（同一独立评审，只读）：CONFIRMED**——上述 11 项折叠逐条核实通过；新增三项非阻断补充，r3 已折叠：
  - **N1（P2 残余）** → §4 补 `trust-ask.ts:64` 独立站点（直用 `TuiShell.select`，与 ctx.select 决策无关）+ `test/repl-tui.test.ts` 三处回调签名；删除原"trust-ask 属于被拒方案后果"的错误归因。
  - **N2（P3）** → §4 `api.confirm` 行："never hangs" 兜底限定为"能承载超时的宿主界面"（与 S6 对齐）。
  - **N3（P3）** → §8-16 注明与 §7 同批执行。
- **§12 短评审（独立对抗，commit 109d5b0）：NEEDS-FIXES**（3×P2+4×P3：0:00 顺序保证归因错误、装载顺序/开局帧未钉、测试矩阵缺口、算术/时钟、单一来源、文档同步、措辞）→ r4.1 全折 → **复核 CONFIRMED**（N1-N3 非阻断注已再折）。
- **§12 实现评审（独立对抗，commit 79d90c8）：NEEDS-FIXES** → 折叠（F1-F5）：
  - **F1（P2，变异证明）** → 可过滤行序钉改为 write-mark 区域分析（原整史比较对"倒计时加在列表后"的回归变钝）；
  - **F2（P3）** → 非法值负例补一条真实渲染（settle + 正控）的 picker；
  - **F3（P3）** → interval 句柄以 setInterval/clearInterval spy 钉住；
  - **F4（P3）** → 本节状态与评审记录修正（本条目）；
  - **F5（P3）** → `countdownText` 非有限输入防御（→ `0:01`）+ 单测。
  - **复核：APPROVE**（F1-F5 逐条核实含变异复测——F1 钉对"行加在列表后"变异双向抓获；F3 钉对泄漏变异抓获；两处 P3 文字修正已折入 D14）。
- **r3 实现评审（独立，只读；commit 5d8a9c8）：NEEDS-FIXES** → 已折叠：
  - **P2#1（计时上限）** → 宿主 `Math.min(timeoutMs, 2^31-1)` 钳位（S8/§5）+ guardian 配置拒绝 `> 2147483647`（§6）；测试：超上限不瞬发、手动答复仍胜（repl-tui）、上限接受 / 超界报错（guardian）。
  - **P3#2（stdin end 缺口）** → repl-tui 补测（armed + `process.stdin.emit("end")` → `null`）。
  - **P3#3（ENOENT 清期限未钉）** → guardian 补测（ENOENT → 重载 → 新配置无期限 → confirm 不带键）。
  - **P3#4（字符串非法值缺口）** → 非法值循环补 `"500"`。
  - **P3#5（真实计时器 flake 风险）** → 记录在案；沿用本文件既有 real-timer 风格（settle 等待），边界余量经重复运行 + 全量验证（非阻断）。
  - **P3#6（两处过时陈述）** → `docs/guardian-auto-mode-design.md` D16/§11 补 superseded 注释。
  - **P3#7（humanDuration(undefined) 防御）** → 退化文案分支 + 测试（§6）。
  - 核心路径（P0 类分支顺序、定时器生命周期、类型加宽、guardian 三分支）逐行核实无 P0/P1。

## 12. 追加：confirm 窗口的超时倒计时（#ask-timeout-countdown，r4.1）

owner 需求（2026-10-04）：配置了超时的 confirm 弹窗要能看到剩余时间提醒。
**纯宿主展示层**——guardian / 扩展 API / 配置格式零变更（`timeoutMs` 已在 §2 定义）。

- **D9 展示条件与单一来源**：仅当 `timeoutMs` 为合法正值（有限、> 0）才显示；实现为**一个** helper `effectiveTimeoutMs(options.timeoutMs): number | null`（含 `Math.min(…, 2^31-1)` 钳位），行可见性、初始文本、deadline、timeout 定时器全部取自它——显示的与计时的不可能公式分岔。helper 单测：0 / 负 / NaN / `"500"` / Infinity → null；2147483648 → 2147483647（钳位）；600000 → 原样。无期限 = 无此行（无期限 picker 的字节钉全部不变）。
- **D10 位置**：dim 单行（`dim(text, true)`），置于 preview 行之后、filter 查询行 / 编号 Spacer(1) / 列表**之前**（`shell.ts` 装箱点：preview ~:948 → 本行 → 查询行 ~:951 / Spacer ~:959 → List ~:960）。filterable picker 的列表必须保持最后一个子元素（`applyFilter` remove+append，列表之后的行会被重排到上方）；编号 picker 的 query 为 null、affordance 在列表后不受影响。**修订 `docs/confirm-prompt-design.md` 的 D5 位置规则**：timeout picker 在 preview 与空行之间多一行倒计时，空行仍紧贴 items 上方（向该文档回加一行指向本节）。排队中的问题没有倒计时（未打开，与 D7 一致）。`SelectOptions.timeoutMs` JSDoc 补一句"设置了就在 picker 里显示倒计时行"。
- **D11 文本与算法定稿**：`times out in <剩余>`。`s = max(1, ceil((deadline - now) / 1000))`（**下限 1 秒**，见 D13），然后：
  - `s < 3600` → `m = floor(s/60)`, `ss = s % 60` → `M:SS`（`10:00`、`0:59`）；
  - `s < 86400` → `Hh MMm`（`mm = floor((s % 3600)/60)`；`1h 00m`、`23h 59m`）；
  - 否则 → `Dd HHh`（`hh = floor((s % 86400)/3600)`；`1d 00h`、`24d 20h`）。
  floor/余数写法杜绝 `0:60`；打开瞬间显示完整期限（ceil 吸收打开延迟：600000 → `10:00`）。**时钟锚用 `performance.now()`**（单调；与相对 `setTimeout` 同语义——`Date.now()` 的墙钟跳变会与计时器分岔）。
- **D12 更新机制与装载顺序（规范性）**：1s interval，`unref?.()`；每 tick 重算文本，文本与上次相同则跳过 `setText`/重绘（≥1h 的格式每分钟才变）。**顺序硬约束**：① `effectiveTimeoutMs` 只算一次；② timeout 定时器先于 interval 创建；③ 初始行文本在**构建行时即携带**（空 Text 渲染零行；等首 tick 会晚 1 秒才出现）；④ `finish` 漏斗（唯一结算点）同时清 interval 与定时器——答复/取消/超时/close/SIGINT/stdin-end 全路径覆盖。
- **D13 边界**：**`times out in 0:00` 结构性不可达**——formatter 下限恒 1 秒（剩余 ≤ 0 也只输出 `0:01`），**不依赖**"同刻回调谁先触发"（Node 对同到期定时器无顺序保证；pi-tui 延迟渲染只是额外兜底，契约写在格式化层）。拆除后无后续重绘；readline/print 无 select 面天然无倒计时；颜色**不**随临近变化（保持 dim；未来若做临近变色，需重审"文本不变跳过重绘"的检查）。
- **D14 测试（r4.1 补全）**：
  - 负例：无 `timeoutMs` 的普通 picker（渲染后）帧历史**不含** `times out in`；§8-7 非法值循环后同样断言不含；
  - 开局帧即含 `times out in 10:00`（timeoutMs 600000）；随后轮询 `times out in 9:`（5s 预算）——首 tick 被负载推迟时会直接渲染 9:58、跳过精确 9:59 帧（实测 flake），断言"在倒数"而非毫秒精度（格式精确性由纯函数单测钉住）；
  - 格式纯函数单测（导出 `countdownText(remainingMs)`，入参 = 剩余毫秒）：600000→`10:00`、59999→`1:00`、60000→`1:00`、61000→`1:01`、3599999→`1h 00m`、3600000→`1h 00m`、3661000→`1h 01m`、86399000→`23h 59m`、86400000→`1d 00h`、钳位上限 2147483647→`24d 20h`、0/负数→`0:01`（下限）；
  - `effectiveTimeoutMs` 单测：非法值清单 → null；2147483648 → 2147483647；正常值原样；
  - 生命周期：答复 / 超时（短期限取 1000ms 整秒——tick 与到期同刻的路径也在其中；契约钉仍是纯函数 0/负数→`0:01`） / close 拆除后（write-mark 之后）帧无该行；**整个 picker 生命周期内任何帧都不含 `times out in 0:00`**（frameSince(0) 历史检查）；**interval 句柄以 setInterval/clearInterval spy 钉住**（负例对泄漏不敏感——实现评审 F3）；
  - filterable + timeoutMs：**双钉**——初始全帧钉倒计时行在列表行之上（行加在列表后会渲染在其下，变异自验被抓）；重排 diff 区域钉查询行在前、列表行紧随其后（pi-tui 只重绘变更行，未变的倒计时不在区域内）、列表行之后无任何 picker chrome（整史 index 比较对布局回归变钝——实现评审 F1）。
