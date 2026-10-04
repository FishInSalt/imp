# #ask-timeout — 交互确认超时（设计 r1）

- 日期：2026-10-04
- 状态：**待独立评审**（实现须在评审闭合后开始）
- 关联：`#guardian`（驱动方）、`#confirm-prompt`（承载界面）

## 1. 背景与目标

guardian 的 ask 弹窗目前会**无限等待**。owner 要求：

1. ask 审批支持超时；超时行为 = **拒绝**（不批准）；
2. 超时给 agent 的反馈必须与**手动拒绝**不同（agent 要能区分"用户说不"和"没人答"）；
3. 模板（及 owner 本机配置）默认 10 分钟。

## 2. 已定决策（owner 讨论结论）

- **D1** 宿主侧实现：定时器属于 confirm 机制本身。扩展侧自 race 定时器会留"幽灵弹窗"（用户稍后点的批准落空），禁止。
- **D2** API 形状：`ConfirmOptions` 增加 `timeoutMs?: number`（沿用 additive/全可选惯例）；`confirm()` 返回值从 `Promise<boolean>` 扩为 `Promise<boolean | "timeout">`（`true`=批准；`false`=拒绝/取消/无交互面；`"timeout"`=超时）。真值判断兼容现有调用方。
- **D3** guardian 配置：顶层字段 `askTimeoutMs`（毫秒正整数；缺省 = 不超时）。校验从严：非法值 = 配置错误（保留上次有效规则 + footer + reload，现行机制）。
- **D4** 审计新增第三种结果：`[ask] <source> — <subject> — timeout`（现有为 `approved` / `denied`）。
- **D5** 超时的 agent 文案与拒绝不同，拟：`the confirmation timed out after 10 minutes — the call was not approved`（规则有自定义 reason 时，与拒绝路径同构：`<reason> — <该文案>`）。
- **D6** 超时**不授予**"本会话不再询问"（不写入 session 记忆）；Ctrl+C / Esc / EOF / 取消仍为手动拒绝（`false`）。
- **D7** 计时语义：**从弹窗真正显示起算**——排队等待（被别的 picker 挡住）不计时。绝不超时一个用户没看见的问题。
- **D8** 定时器必须 `unref()`，结算时 `clearTimeout`；结算漏斗保持"只生效一次"（已有 `settled` 守卫），"恰好超时瞬间用户回车"由先到者胜。

## 3. 语义规格

- **S1** 只有调用方传了 `timeoutMs`（合法正值）才计时；未传/非法 → 无限等待（现行为）。
- **S2** 计时窗口 = 弹窗从打开到被答复/关闭之间的可见时间；排队中的问题不计时（见 D7）。
- **S3** 超时触发时：弹窗按正常关闭路径拆除（等价取消），其 Promise 以 `"timeout"` 结算。
- **S4** 宿主在 confirm 包装层写一行"问题已超时、按拒绝处理"的 dim note（避免弹窗无故消失）；agent 侧反馈 = 工具结果里的 block reason（由 guardian 生成）。
- **S5** 无交互面（print / no-handler / `ask === null`）路径不变：立即 `false`，忽略 `timeoutMs`。
- **S6** readline（legacy `IMP_REPL=legacy`）路径本次**不做**超时（见 §10 范围外；行为差异在文档中注明）。owner 使用 TUI picker。
- **S7** 多问题并行：各自独立计时；每个问题打开时启动各自的定时器。
- **S8** `timeoutMs` 宿主侧校验宽松：非有限数/≤0/非数字 → 视为未传（扩展侧 guardian 自己从严校验配置）。
- **S9** 返回联合类型对既有调用方无破坏：`if (ok)`、`!ok`、`=== true/false` 语义不变；仅新增 `=== "timeout"` 分支。

## 4. API 变更（宿主）

| 位置 | 现状 | 变更 |
|---|---|---|
| `src/extensions/types.ts` `ConfirmOptions` | `sessionKey? / warnSpans? / rememberLabel? / preview?` | 增 `timeoutMs?: number`（注释写明：TUI 可见期计时、排队不计、非法忽略） |
| `src/extensions/types.ts` `api.confirm` | `Promise<boolean>` | `Promise<boolean \| "timeout">`；JSDoc 更新（"never hangs" 语义改为"由显式回答或调用方期限兜底"） |
| `src/extensions/registry.ts` | `confirmHandler` 私有类型与 `confirm()` 均 `Promise<boolean>` | 同步扩为联合；无 handler 路径仍 `false` |
| `src/repl/line-input.ts` `SelectOptions` | — | 增 `timeoutMs?: number`（注释同 S2/S8） |
| `src/repl/line-input.ts` `LineInput.select?` | `Promise<number \| null>` | `Promise<number \| null \| "timeout">` |
| `src/repl/repl.ts` `bindSelect` + confirm 包装 | `(options) => Promise<number \| null>`；包装返回 `Promise<boolean>` | 签名与包装返回同步扩联合；包装中 `choice === "timeout"` → note（S4）+ 返回 `"timeout"` |

调用方排查：其余 `ctx.select` 使用者（/model、/resume 等）不传 `timeoutMs`，返回值永不为 `"timeout"`；类型加宽后其 `choice === null` / 数值比较代码不受影响（实现时全库扫一遍确认）。

## 5. 宿主实现点（TUI picker）

- `TuiShell.select`（`src/repl/shell.ts`）：排队分支（`this.selector !== null`）**之前**不做任何计时——晋级时它会重新调用 `this.select(options)`，定时器因此天然从"真正打开"起算（D7 免费成立）。
- 打开路径：在 picker 完成渲染/`this.selector` 置位之后启动 `setTimeout(...).unref()`；回调走 `finish` 漏斗的新分支（结算值为 `"timeout"`，拆除动作与取消完全一致：清 selector、移除 box、聚焦编辑器、晋级后续排队问题）。
- `finish` 内 `clearTimeout`（手动答复/取消/关闭都要取消定时器，防晚触）；保持既有 `settled` 一次性守卫。
- `close()`（宿主退出路径）沿用现有 drain 语义（按取消处理），无需超时介入。

## 6. guardian 扩展侧

- **配置解析**：接受顶层 `askTimeoutMs`；校验 `typeof === "number" && Number.isSafeInteger && > 0`，否则整文件配置错误（现行机制）。`_` 前缀忽略规则不变。
- **调用**：ask 命中时 options 增加 `timeoutMs`（仅当配置存在时传）。
- **结果三分支**：

```text
outcome === true       → 批准：return undefined；审计 — approved
outcome === "timeout"  → 审计 — timeout；block reason：
                         <reason 前缀（若有）> + "the confirmation timed out after <时长> — the call was not approved"
outcome === false      → 拒绝：现行「the user declined this call」路径
```

- **时长文案** helper：`humanDuration(600000) = "10 minutes"`（≥60s 用分钟、单复数；<60s 用秒）。
- **内部错误回退路径**同样携带 `timeoutMs`；超时结果审计为 `[ask] internal error — <subject> — timeout`，block reason 保持 `guardian internal error — the call was not allowed`（不新增第三种 internal 文案）。

## 7. 模板与本机配置（在第 2 条落地后执行）

- `examples/extensions/guardian.template.json`：去敏版模板（家目录整体 `~`/`$HOME` 两条 + 文件系统根 + 毁盘 + `.ssh` 一条；不含 `/Users/z`、Desktop 等本机特有项）加 `"askTimeoutMs": 600000`。
- owner 本机 `~/.imp/guardian.json` 同步加 `"askTimeoutMs": 600000`（随本次安装一起，重启一次）。

## 8. 测试矩阵

**宿主单元（fake timers）**

1. picker 打开 + `timeoutMs` → 推进时钟 → Promise 以 `"timeout"` 结算；`"timeout"` 结算后到达的手动答复**无效**（一次性守卫）。
2. 手动答复先到 → 定时器被清理，时钟再推进不产生 `"timeout"`。
3. 排队场景：A 打开时 B 入队（带 `timeoutMs`）→ 时钟推进超过 B 的期限、A 未关闭 → **B 不超时**（D7）；A 结束后 B 打开 → 再推进 → B 以 `"timeout"` 结算。
4. confirm 包装：choice `"timeout"` → 返回 `"timeout"` + 写入超时 note；choice `null` 仍 `false`。
5. 非法 `timeoutMs`（0 / 负数 / NaN / 字符串）→ 无计时，行为同现状。
6. registry：handler 返回 `"timeout"` 透传；无 handler / print 路径仍 `false`（回归）。

**guardian 单元**

7. `askTimeoutMs: 600000` → `api.confirm` 的 options 带 `timeoutMs: 600000`；未配置 → 不带。
8. outcome `"timeout"` → block reason 文案正确 + 审计 `— timeout`；有自定义 reason 时前缀格式正确。
9. `askTimeoutMs` 非法（字符串 / 0 / 负）→ 配置错误路径（保留上次有效 + footer）。
10. 回归：批准 / 拒绝（新文案）/ 内部错误路径不动。

**端到端（可选，视成本）**：extensions-repl 既有 confirm 夹具扩展一条超时流。

## 9. 文档与变更记录

- `docs/guardian-design.md`：配置 schema（`askTimeoutMs`）、ask 流程（三分支、审计第三态、超时文案）+ rev 递增。
- `types.ts` JSDoc（§4）；README 的扩展 API 描述（实现时扫描）。
- CHANGELOG：guardian 条目补一句 ask 超时（或单开一条）。
- `docs/confirm-prompt-design.md`：如需，补一行"超时关闭 = 取消路径 + note"。

## 10. 范围外（v1）

- 每条 ask 规则独立超时（先全局一个字段；需要再加覆写）。
- 弹窗上的倒计时显示。
- readline legacy 路径与 `secret`/login 等其它问询形式的超时（S6）。
- 超时记忆（"这个问题超时过"）——不做。

## 11. 待评审攻击点（评审请逐条打）

1. D7"显示期计时"与排队机制的实际行为是否完全成立（结合 `pendingSelects` 晋级路径核对）。
2. `boolean | "timeout"` 联合对**全部**现有调用方/夹具/类型注记的兼容性扫描是否遗漏（`grep` 验证建议面：`.confirm(`、`bindSelect`、`select?(`、mock 类型）。
3. `finish` 漏斗改造是否影响既有取消/关闭/晋级语义；`unref` 是否足够（不拖住进程退出）。
4. S6（readline 不做）与 S8（宿主宽松校验）的取舍是否可接受。
5. guardian 文案/审计与前一批"the user declined this call"的家族一致性；`humanDuration` 边界（60000、90000、59999）。
6. 测试矩阵是否覆盖 §11-1/2 的所有竞态；有无漏掉的 settle 路径（`close()`、`drainAsks`、EOF）。
7. §5 对 `TuiShell.select` 的推断（"晋级重调 → 计时天然显示期"）是否与代码一致——请对照 `shell.ts` 实际实现逐行核实并指出偏差。
