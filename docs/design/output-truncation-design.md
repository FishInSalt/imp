# 主循环输出截断处理：目录预算 + 截断工具调用拒绝 + 可见性（#output-truncation）

状态：设计评审已关闭（5 轮：2×P1+7×P2+3×P3 → 3×P2+4×P3 → 4×P3 → 2×P3 笔记 →
**CONFIRMED**，commit acc522c）。实现：commit 1d0f0d0（实现评审已关闭：
NEEDS-FIXES → 折叠 → APPROVE WITH CORRECTIONS → 收尾修正）。主人决策已签
（2026-09-30）：D3 = 直接用模型目录上限；D2/D4 按建议；D1 无异议。D3b（子代理同
规则）为评审新增，已由主人确认（2026-09-30：采用目录值；子代理思考策略另立后续
批次 SA-09，见 `design/subagent-delegation-task-list.md`）。
分支：`fix/output-truncation`（独立 worktree `imp-output-truncation`）；基线 main `b7d8a9d`。

参考（均已读/已核实）：
- 本次事件现场：`~/.imp/logs/20260930-110143-65752.jsonl`、
  `~/.imp/logs/20260930-100708-23859.jsonl`；会话
  `~/.imp/sessions/Users-z-Z-Agent_demo/2026-09-30T02-07-08-840Z-a0a388a9-….jsonl`
  （内部 id `eca7ce9d-3061-4b89-b6d5-e361b57dc922`）；`~/.imp/settings.json`；
  `~/.imp/models-catalog.json`。
- pi 对照：`packages/agent/src/agent-loop.ts:226-231, 373-394`（截断工具调用全部失败，
  原文案在 :394）；`packages/coding-agent/src/modes/interactive/components/assistant-message.ts:182-186`
  （截断横幅）；`packages/coding-agent/src/core/agent-session.ts:2182-2226` +
  `packages/ai/src/utils/overflow.ts:171-173`（recoverable-length）；
  `packages/coding-agent/src/core/provider-composer.ts:122,161`（maxTokens 取值）；
  `packages/ai/src/providers/data/deepseek.json`（`deepseek-v4-flash` maxTokens=384000，
  与 pi.dev 目录同值）。
- 本仓库先例：`design/compaction-thinking-retry-design.md`（同一"思考挤占正文预算"故障
  的摘要场景修复：降档重试一次 + 失败带诊断；与 pi 的有意偏离已记档）、
  `design/m17-followup-runs-design.md`（would-stop 边界续跑：只消费队列、不注入）、
  `design/loop-health-design.md`（主人决定：不做数值阀门、不做注入）、
  `design/m14-model-catalog-design.md`（目录服务）。

## 0. 目标

- 消除"输出被截断 → 静默停止/无输出"的可观测性缺口：任何截断都必须在界面可见；
  print/headless 以非零退出码收尾。
- 截断消息中的工具调用**一律不执行**（参数可能被截断、且可能在合法 JSON 边界上被误判为
  完整）——对齐 pi。
- 主循环每轮输出上限改为模型目录值（主人决策）：deepseek-flash 由固定 16384 提升到
  384000，本次事件场景直接消失；同一解析规则覆盖子代理请求路径（D3b=目录值，已确认）。
- 正常路径（未截断的运行）行为零变化；截断路径不引入额外调用（不重试、不注入）。

验收：
1. `stopReason === "max_tokens"` 的 assistant 消息带工具调用时：工具零执行、模型收到
   逐条错误、UI 可见失败行；
2. 运行以截断（无工具调用）结束时：TUI 与 print 均出现截断注记；`-p` 模式退出码 2
   （该退出码为手动验收 11，无自动化 e2e——自动化由脚本化 REPL 出口面覆盖）；
3. deepseek-flash 默认请求 max_tokens=384000（显式 `--max-tokens` 仍优先）；
4. 全量门禁绿（typecheck / lint / vitest）。

## 1. 证据（本机实测，2026-09-30）

### 1.1 事件时间线（会话 eca7ce9d 的恢复运行，log `20260930-110143-65752.jsonl`）

| 本地时间 | 事件 | 细节 |
|---|---|---|
| 11:01:43 | run_start | `imp -r eca7ce9d`，cwd `/Users/z/Z/Agent_demo` |
| 11:01:51 | llm_request | messageCount=20 |
| 11:03:12 | message_end | `stopReason:"max_tokens"`，outputTokens=16384，blocks=[thinking 62,668 字符]，**无文本、无工具调用** |
| 11:03:12 | run_end | `stopReason:"completed", turns:1` → 界面静默停止 |
| 11:06:10 | 重试（"别想太多，执行"） | 11:07:31 max_tokens，thinking 62,445 字符，无输出 |
| 11:08:00 | 重试 | 11:09:17 max_tokens，thinking 59,983 字符，无输出 |

（日志内 UTC 时间戳：03:03:12Z / 03:07:31Z / 03:09:17Z。）

### 1.2 结构性事实（含代码位点）

- 请求上限固定 16384：`cli.ts:232` 默认 → `runner.ts:1401` → `openai-completions.ts:304`
  （deepseek 线路上的 `max_tokens` 字段）。
- 服务端截断 → `finish_reason:"length"` → `stopReason:"max_tokens"`
  （`openai-completions.ts:204-215`）。
- loop 无工具调用即 `completed`，不检查 stopReason（`loop.ts:223-249`）；带工具调用则
  照常执行（`loop.ts:270-284`，无截断检查；调用点在 :271）。
- 界面只对 aborted / max_iterations 提示（`runner.ts:1550-1574`）；用户 settings
  `hideThinkingBlock:true` 时，无正文的截断消息在屏幕上完全无输出。
- 主循环不消费目录值：`modelMaxTokensFor()`（`src/provider/catalog.ts:200-211`）目前仅压缩预算使用；
  pi.dev 目录给 deepseek-flash `maxTokens=384000`（`~/.imp/models-catalog.json`；
  checkedAt 2026-09-30 10:07，内容 lastModified 2026-09-25）。
- 截断工具调用的"运气结构"：10:08:47（本会话早前运行）一次截断工具调用因 JSON 非法
  （`_parseError`，`provider/shared.ts:92`）被 schema 校验挡下——**合法但被截断的参数不会
  被任何检查拦截**（loop 直接执行）。

## 2. 决策记录

### D1 截断消息的工具调用全部拒绝（pi parity；已定）

- **触发**：`assistant.stopReason === "max_tokens"` 且该消息含工具调用。
- **行为**：不执行任何一个调用；对每个调用生成 isError 结果，文案与 pi 逐字一致：
  `Tool call "<name>" was not executed: the response hit the output token limit, so its
  arguments may be truncated. Re-issue the tool call with complete arguments.`
- **事件形状**与执行路径一致（`tool_start` + `tool_end`，复用 `persistableResult`），保证
  UI 行、扩展 tap（`emitToolEnd`）与正常失败一致；**故意不过 onToolCall gate**（gate 是
  "执行前最后一道"，此路径无执行）。
- **顺序**：既有 `maxIterations` 检查保持在其前（:257；到达上限时仍返回 `max_iterations`，
  行为不变）；拒绝分支替换 `executeToolBatch` 的调用位置（:270-271）。
- `_parseError` 兜底保留（防御纵深，两条路径不冲突）。
- 结果照常 `history.push` + `onMessage` 持久化：tool_use / tool_result 闭合不变，
  会话可恢复性不受影响。

### D2 可见性（已定，按建议）

- `RunAgentLoopResult` 新增可选 `truncated`：仅在"无工具调用 → completed"返回路径、
  最后一条 assistant `stopReason === "max_tokens"` 时置 true；aborted / max_iterations
  不置。**只由最终那条 assistant 决定，历史截断不累积**（D1 拒绝续跑后正常结束 →
  不置）。
- `runner.printRunStats` 的 `completed` 分支：truncated 时打注记（两模式都显示，沿用
  既有"stop notes stay in both modes"规则）。文案（草稿，评审可调）：
  `(stopped: response truncated at the output limit (16384 tokens) — send another message to continue)`
  数字 = 该 run 解析出的上限（见 D3，经 `lastRunMaxTokens`）。
- **退出码（两个出口面；评审 P1-1 修正）**：
  ① print 模式走 `runPrint`（`cli.ts:965` 起），**不经过 `runRepl`**——在
  `printRunStats` 之后按 `result.truncated` 置 `process.exitCode = 2`；
  ② 脚本化 REPL（管道输入、无 -p）与交互 TUI 走 `runRepl` 的 EOF 路径
  （`handleEof` 的 idle 分支与 `returnToIdle` 的 eofPending 分支），以"最后一次 run
  是否 truncated"决定 `gracefulExit(2 / 0)`；普通运行保持 0。
  码值说明（实现评审第 1 轮 P2 折叠）：不用 1——`cli.ts:684-686` 对 runRepl 返回码 1
  的旧约定是"零行管道 stdin → 补打 HELP"；截断码必须避开该哨兵，两个出口面统一为
  专用码 2（`test/repl.test.ts` 的退出码钉子同步为 2）。
  状态语义（评审 P3-N6）：清零只发生在模型 run 入口（`submitTurn`），写只发生在
  `settleSuccess`；模型 run 之外的 shell（`! cmd`，`runBangCommand`）与失败 settle
  （`settleFailure`）不改写该状态。
- `run_end` 事件与扩展载荷**不变**（避免扩展 schema 波纹）；树视图既有 max_tokens
  标记（`tree-selector.ts:81`）保留。
- 不做逐消息转录横幅（pi 的 `assistant-message.ts:182-186` 形态）——拒绝行 + 停止注记已
  覆盖本次缺口；触发条件见 D4。

### D3 输出上限 = 模型目录值（主人决策：直接用；已定）

- **解析**（每次 run，`modelReference` 计算之后；`runner.ts:1268` 附近）：
  `effective = maxTokensExplicit ? opts.maxTokens : (modelMaxTokensFor(modelReference) ?? opts.maxTokens)`
  （`opts.maxTokens` 未显式时为 `DEFAULT_MAX_TOKENS = 16384`）。
- `--max-tokens` 增加显式标记（对齐 `maxTurnsExplicit` 模式：`cli.ts:119/238/294`）；
  帮助文案（`cli.ts:152`）改为：默认=模型目录上限，未知时 16384。
- 顺带：`--max-tokens` 输入校验（非正整数报错），对齐 `--max-turns` 的既有修正
  （`cli.ts:286-294`）。
- 解析值记入 runner（`lastRunMaxTokens`，写入点 = `runTurnInner` 解析后立即），
  `printRunStats` 读取的是**本次 run** 的值；`/model` 中途切换天然生效；连续性多 run
  （flushQueue 续跑）逐个更新（评审 P2-4）。
- **成本记录**：deepseek-flash 最坏 384000×$1.2/M ≈ $0.46/轮（owner 已知并接受；实际由
  模型自然停止决定）。
- **服务端接受性探针**：实施/验收阶段以一次实发请求验证 deepseek 端点接受该值（花费可
  忽略；**执行前需 owner 放行**）。若被拒：cap 至服务端接受的最大值，按修订记录进本文。
- 不动：压缩链路的 `modelMaxTokensFor` 用法；provider 协议层。
- **更正（评审 P1-2）**：`loop.ts:141` 的 8192 直连默认不是"只影响测试"——子代理
  （`subagent.ts:337-347`，`maxIterations: Infinity`）是生产级直连调用者；同规则见 D3b。

### D3b 子代理请求上限同规则（评审 P1-2 新增；主人已确认=目录值，2026-09-30）

- 现状：子代理直连 `runAgentLoop` 不传 `maxTokens` → 每轮 8192 兜底；且
  `maxIterations: Number.POSITIVE_INFINITY`（#loop-health 主人决定 A：子代理无轮墙）。
- 决策：子代理请求上限同走目录值——`subagent.ts` 已有 `childModelMetadata()` 解析
  `modelMaxTokens = modelMaxTokensFor(reference)`（:154-163），`launchLoop`（:337）在
  `modelMaxTokens !== undefined` 时传入 `maxTokens`；undefined 时不传（loop 兜底
  8192 不变）。不引入子代理自己的显式覆盖入口（无 CLI 面）。
- 子代理**截断可见性**（`settled("completed")` 对截断仍不可见）不在本次范围——记 D4
  触发条件（父调用方需要区分"截断完成"时回来做 task 结果通道）。
- 成本面与主循环同账：子代理用同一模型时同样吃目录上限。

### D4 明确不做（各记触发条件）

- **不自动重试/不注入"继续"**（loop-health 主人决定精神；compaction D1 的降档重试不平移
  到主循环）。触发条件：日志再现"目录预算下仍纯思考截断"（如某模型目录上限天生偏小）
  → 回来做"降档重试一次"（镜像 compaction D1；机制参考 pi overflow-recovery 的
  state 移除 + 重试）。
- **不做逐消息转录横幅**。触发条件：截断复现且用户表示拒绝行/注记不足以定位。
- **永不做**截断工具调用的部分执行 / 参数修补。
- 附记（评审 P3-12）：回访若照搬 pi，需要对 `isRecoverableLength`
  （`packages/ai/src/utils/overflow.ts:171-173`）的 `usage.output < desiredMaxOutput`
  条件放宽——D3 把目录值直接当请求上限后，"在目录上限处截断"恰好使两者相等，pi 的
  启发式不会判为可恢复。

## 3. 实现（文件与改动点）

| 文件 | 改动 |
|---|---|
| `src/core/loop.ts` | `RunAgentLoopResult.truncated?: boolean`（completed 返回路径置值，:247）；工具分支插入拒绝路径（替换 :270-271 的 `executeToolBatch` 调用）：`assistant.stopReason === "max_tokens"` → 新 helper `failToolCallsFromTruncatedMessage(toolCalls, results, onEvent)`（逐条 tool_start/tool_end + 错误结果 + `persistableResult`），否则原 `executeToolBatch`；新增文案常量。 |
| `src/runner.ts` | 每次 run 解析 effective maxTokens（`runTurnInner`，`modelReference` 之后；替换 :1401 的 `this.options.maxTokens`）；记录 `lastRunMaxTokens`；`printRunStats` completed 分支加 truncated 注记。 |
| `src/repl/repl.ts` | 4 个触及点：run 开始处清零 `lastRunTruncated`；`settleSuccess` 写入；`handleEof` idle 分支与 `returnToIdle` eofPending 分支按它选择 `gracefulExit(2 / 0)`。 |
| `src/cli.ts` | `CliOptions.maxTokensExplicit`（默认 false；`--max-tokens` 置 true + 校验，锚点 :286-294 模式）；帮助文案 :152 引用常量；`RunnerOptions` 传 `maxTokensExplicit`；**`runPrint`（:965 起）在 `printRunStats` 后按 `result.truncated` 置 `process.exitCode = 2`**（评审 P1-1；码值经实现评审 P2 改 2）。 |
| `src/core/constants.ts` | `DEFAULT_MAX_TOKENS = 16384`（cli 默认与 runner 回退共用单一出处；*不* 波及 `compaction.ts:55`、`thinking.ts:594` 的同值文本）。 |
| `src/core/subagent.ts` | D3b：`launchLoop`（:337）在 `childModelMetadata().modelMaxTokens` 非 undefined 时传入 `maxTokens`（undefined 保持不传，loop 兜底 8192 不变）。 |
| `design/output-truncation-design.md` | 本文。 |

不改：provider 层（openai-completions / deepseek）、compaction、session schema、
`run_end` 与扩展事件载荷、tree-selector。

## 4. 测试计划

新增（`test/loop.test.ts`，基建已有 tool_start/tool_end 断言与 scriptedProvider）：
1. 截断（max_tokens）+ 工具调用 → 工具零执行（mock 记录）、**onToolCall gate 调用次数 0**
   （对照：正常路径调用次数=工具数）、每条得到 pi 文案的 isError 结果、事件序列含
   tool_start/tool_end、历史 tool_use/tool_result 闭合；随后模型重发并正常结束 →
   `stopReason === "completed"` 且 **`truncated` 未置**（最终 assistant 决定，不累积）；
2. 截断 + 无工具调用 → `result.truncated === true`；
3. 正常结束 → `truncated` 未置（undefined）钉子；
4. 上限到达 + 截断同 turn → 仍 `max_iterations`（顺序钉子）。

新增（`test/runner.test.ts`，printRunStats 精确字符串用例群旁）：
5. 显式 `--max-tokens` 优先于目录值；
6. 目录值生效（catalog 注入：`setCatalogFetcherForTest` / `IMP_CATALOG_PATH` 夹具；
   `test/model-catalog.test.ts` 已有基建）；
7. 目录值缺失 → 回退（16384）；
8. truncated 注记精确字符串（含数字）；
8b. 子代理预算：目录值非 undefined 时 `launchLoop` 收到 `maxTokens`；目录缺失 → 不传
   （loop 兜底 8192 回归钉子）；
8c. `lastRunMaxTokens` 每次 run 更新（评审第 3 轮，8c 机制项）：同一 Runner 两次
   截断 run，其间 `runner.setModel()`（公开 API、`/model` 底层）切到目录上限不同的
   模型——maxTokens 无运行时 setter，上限变化只经由模型切换；**切换须在同一 family
   内**以复用注入的 fake provider（跨 family 会构建真实 provider；`test-model` 落
   anthropic family，夹具在同 family 注入两个不同 `maxTokens` 的 id）；第二条注记显示
   第二个 run 的上限。

新增（print/repl 与 CLI e2e 用例，就近落位现有 `runRepl` / `bin/imp.js` 基建）：
9. 脚本化 REPL（`runRepl` 已导出 + mock provider）：截断的最终 run → EOF 退出码 2 +
   注记；正常 → 退出码 0（回归钉子）；
9b. 帮助文案与同源双重钉子（评审第 2/3 轮：落位修正 + 同源缺口）：① `bin/imp.js --help` e2e 输出含
   新的默认说明（模型目录上限，未知时 16384）；② 源码/AST 断言 `cli.ts` 的
   `--max-tokens` 帮助行引用 `DEFAULT_MAX_TOKENS`（复用 `test/cli-model-explicit.test.ts`
   的 AST 提取模式——`HELP` 未导出、入口模块底部 `await main()`，直接 import 会触发
   启动）；
9c. `! cmd` 不改写退出码状态：截断 run 后执行 `! echo hi`，EOF 退出码仍为 2
   （评审 P3-N6 的语义钉子）。
print 模式（`-p`）退出码 2 由手动验收 11 覆盖——`runPrint` 不导出（入口模块），无
稳定自动化承载；如需自动化，触发条件见 §5。

手动验收（owner 放行后）：
10. 实发探针：deepseek-flash 请求 max_tokens=384000 被端点接受；
11. `--max-tokens 512` 强制截断复现：观察"拒绝行 + 注记 + 退出码"三件套。

门禁：typecheck / lint / vitest 全量（UNMASKED 退出码，沿用 loop-health 的教训）。

## 5. 风险

- **成本天花板上升**（目录值直接使用）：单轮最坏成本随模型目录值放大；已接受，记录在案。
- **截断拒绝循环**（模型连续重发被截断的调用）：print/headless 由 maxIterations 兜底；
  交互模式与**子代理**（`maxIterations: Infinity` 且非交互）无轮墙，由 loop-health 监视
  （repeat-loop）部分覆盖——观察触发条件：日志出现连续 ≥3 轮"截断拒绝"（阈值可评审
  调整；子代理随 D3b 预算提升概率进一步下降）。
- **退出码 2**：既有把 `-p` 非零视为失败的脚本从现在起能正确捕获截断（本意），发布说明
  需提及。print 模式的退出码暂无自动化 e2e（`runPrint` 在入口模块内、不可导入测试；
  由手动验收 11 覆盖）——触发条件：出现回归时，把 `runPrint`/退出码判定抽成可导入
  helper。
- **离线首启且无缓存**：目录值缺失 → 回退 16384，截断仍可能发生，但 D1/D2 保证安全与
  可见。
- **服务端拒绝 384000 的可能性**：探针先行；被拒则按修订流程 cap。

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `src/core/loop.ts` | 结果类型 +1 字段；拒绝路径 helper（~30 行） |
| `src/runner.ts` | 解析函数 + 状态字段 + 注记（~15 行） |
| `src/repl/repl.ts` | 4 触及点（清零/写入/两处退出码读取，~10 行） |
| `src/cli.ts` | 选项字段 + 解析 + 校验 + 帮助 + `runPrint` 退出码（~18 行） |
| `src/core/subagent.ts` | D3b 传参（~3 行） |
| `src/core/constants.ts` | +1 常量 |
| `test/loop.test.ts` | +4 用例（含 gate 0 调用与"续跑不累积"断言） |
| `test/runner.test.ts` | +6 用例（含 8b/8c） |
| print/REPL 与 CLI e2e 测试 | +3 用例（9 / 9b / 9c） |
| `design/output-truncation-design.md` | 本文 |

## 7. 评审记录

- 设计评审第 1 轮（2026-09-30，独立对抗、fresh context；commit 750924a）：
  **NEEDS-FIXES** —— 2×P1（print 模式退出路径遗漏；子代理直连与"无轮墙"覆盖分类
  错误）、7×P2（catalog 路径、lastRunMaxTokens 契约、repl 触及点与 flushQueue 续跑、
  truncated 最终态语义、续跑钉子、gate 钉子、常量单一出处）、3×P3（行号微偏 ×2、
  isRecoverableLength 语义差异）。全部折叠入本文（D2/D3/D3b/D4 与 §3-§6）。
- 第 2 轮复核（2026-09-30，同一评审子代理续跑；commit 38c67d4）：**NEEDS-FIXES** ——
  12 项确认全部折叠；新增 3×P2（D3b 状态一致性、5b/8c 落位不可实现、print 退出码
  自动化缺口）与 4×P3（§6 计数、shell/失败路径状态语义、D1 行号），已折叠（本修订）。
- 第 3 轮复核（2026-09-30，同一评审子代理续跑；commit 8d8681e）：**APPROVE WITH
  CORRECTIONS** —— 第 2 轮 7 项确认折叠；新增 4×P3（9b 论证事实错误、9c 机制不可
  实现、9b 未钉"同源"、验收项 2 未标注手动面），已折叠（本修订）。
- 第 4 轮复核（2026-09-30，同一评审子代理续跑；commit 239d16c）：**CONFIRMED WITH
  NOTES** —— 第 3 轮 4 项确认折叠；2 条 P3 笔记（8c 同 family 提示、C 标签悬空），已
  折叠（本修订）。
- 第 5 轮复核（2026-09-30，同一评审子代理续跑；commit acc522c）：**CONFIRMED** ——
  设计评审关闭；唯一未决项为主人决策 D3b（非文档缺陷）。
- 主人确认（2026-09-30，会话）：**D3b 采用目录值**；子代理思考策略记录为后续批次
  （`design/subagent-delegation-task-list.md` SA-09）。实现自此开工。
- 实现评审第 1 轮（2026-09-30，独立对抗、fresh context；commit ffb800d）：
  **NEEDS-FIXES** —— 1×P2（REPL 退出码 1 与 cli 的"空 stdin → 补打 HELP"哨兵冲突，
  管道/脚本化截断收尾会污染 stdout）⇒ 折叠：两个出口面统一改专用码 2（见 §D2 码值
  说明）；3×P3（`--max-tokens` 的 `parseInt` 整数性沿 `--max-turns` 既有风格，记独立
  清理；idle/eofPending 两分支表达式相同、覆盖可后续加固；CLI e2e 依赖先构建 dist——
  沿既有 e2e 惯例）。已折叠（本修订）。第 2 轮复核（commit 1d0f0d0）：
  **APPROVE WITH CORRECTIONS** —— 折叠正确、门禁全绿；仅 2 处文档行未同步（§3 repl
  行、§4 9c 的码值），已顺手修正（本修订）。**实现评审关闭**。
