# 主循环输出截断处理：目录预算 + 截断工具调用拒绝 + 可见性（#output-truncation）

状态：草稿 —— 设计独立评审未进行。主人决策已签（2026-09-30）：
D3 = 直接用模型目录上限；D2/D4 按建议；D1 无异议。
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
- 本仓库先例：`docs/compaction-thinking-retry-design.md`（同一"思考挤占正文预算"故障
  的摘要场景修复：降档重试一次 + 失败带诊断；与 pi 的有意偏离已记档）、
  `docs/m17-followup-runs-design.md`（would-stop 边界续跑：只消费队列、不注入）、
  `docs/loop-health-design.md`（主人决定：不做数值阀门、不做注入）、
  `docs/m14-model-catalog-design.md`（目录服务）。

## 0. 目标

- 消除"输出被截断 → 静默停止/无输出"的可观测性缺口：任何截断都必须在界面可见；
  print/headless 以非零退出码收尾。
- 截断消息中的工具调用**一律不执行**（参数可能被截断、且可能在合法 JSON 边界上被误判为
  完整）——对齐 pi。
- 主循环每轮输出上限改为模型目录值（主人决策）：deepseek-flash 由固定 16384 提升到
  384000，本次事件场景直接消失。
- 正常路径（未截断的运行）行为零变化；截断路径不引入额外调用（不重试、不注入）。

验收：
1. `stopReason === "max_tokens"` 的 assistant 消息带工具调用时：工具零执行、模型收到
   逐条错误、UI 可见失败行；
2. 运行以截断（无工具调用）结束时：TUI 与 print 均出现截断注记；`-p` 模式退出码 1；
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
  照常执行（`loop.ts:269-284`，无截断检查）。
- 界面只对 aborted / max_iterations 提示（`runner.ts:1551-1572`）；用户 settings
  `hideThinkingBlock:true` 时，无正文的截断消息在屏幕上完全无输出。
- 主循环不消费目录值：`modelMaxTokensFor()`（`catalog.ts:197-210`）目前仅压缩预算使用；
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
- **顺序**：既有 `maxIterations` 检查保持在其前（到达上限时仍返回 `max_iterations`，
  行为不变）；拒绝分支替换 `executeToolBatch` 的调用位置。
- `_parseError` 兜底保留（防御纵深，两条路径不冲突）。
- 结果照常 `history.push` + `onMessage` 持久化：tool_use / tool_result 闭合不变，
  会话可恢复性不受影响。

### D2 可见性（已定，按建议）

- `RunAgentLoopResult` 新增可选 `truncated`：仅在"无工具调用 → completed"返回路径、
  最后一条 assistant `stopReason === "max_tokens"` 时置 true；aborted / max_iterations
  不置。
- `runner.printRunStats` 的 `completed` 分支：truncated 时打注记（两模式都显示，沿用
  既有"stop notes stay in both modes"规则）。文案（草稿，评审可调）：
  `(stopped: response truncated at the output limit (16384 tokens) — send another message to continue)`
  数字 = 该 run 解析出的上限（见 D3，经 `lastRunMaxTokens`）。
- **退出码**：EOF 退出路径（`handleEof` 的 idle 分支与 `returnToIdle` 的 eofPending
  分支）以"最后一次 run 是否 truncated"决定 `gracefulExit(1 / 0)`；普通运行保持 0。
- `run_end` 事件与扩展载荷**不变**（避免扩展 schema 波纹）；树视图既有 max_tokens
  标记（`tree-selector.ts:81`）保留。
- 不做逐消息转录横幅（pi 的 `assistant-message.ts:182-186` 形态）——拒绝行 + 停止注记已
  覆盖本次缺口；触发条件见 D4。

### D3 输出上限 = 模型目录值（主人决策：直接用；已定）

- **解析**（每次 run，`modelReference` 计算之后；`runner.ts:1268` 附近）：
  `effective = maxTokensExplicit ? cli 值 : (modelMaxTokensFor(modelReference) ?? 回退值)`
- `--max-tokens` 增加显式标记（对齐 `maxTurnsExplicit` 模式：`cli.ts:119/238/294`）；
  帮助文案（`cli.ts:152`）改为：默认=模型目录上限，未知时 16384。
- 顺带：`--max-tokens` 输入校验（非正整数报错），对齐 `--max-turns` 的既有修正
  （`cli.ts:288-295`）。
- 解析值记入 runner（`lastRunMaxTokens`）供 D2 文案；`/model` 中途切换天然生效。
- **成本记录**：deepseek-flash 最坏 384000×$1.2/M ≈ $0.46/轮（owner 已知并接受；实际由
  模型自然停止决定）。
- **服务端接受性探针**：实施/验收阶段以一次实发请求验证 deepseek 端点接受该值（花费可
  忽略；**执行前需 owner 放行**）。若被拒：cap 至服务端接受的最大值，按修订记录进本文。
- 不动：`loop.ts:141` 直连默认 8192（测试/直连调用者）；压缩链路的 `modelMaxTokensFor`
  用法；provider 协议层。

### D4 明确不做（各记触发条件）

- **不自动重试/不注入"继续"**（loop-health 主人决定精神；compaction D1 的降档重试不平移
  到主循环）。触发条件：日志再现"目录预算下仍纯思考截断"（如某模型目录上限天生偏小）
  → 回来做"降档重试一次"（镜像 compaction D1；机制参考 pi overflow-recovery 的
  state 移除 + 重试）。
- **不做逐消息转录横幅**。触发条件：截断复现且用户表示拒绝行/注记不足以定位。
- **永不做**截断工具调用的部分执行 / 参数修补。

## 3. 实现（文件与改动点）

| 文件 | 改动 |
|---|---|
| `src/core/loop.ts` | `RunAgentLoopResult.truncated?: boolean`（completed 返回路径置值，:247 附近）；工具分支插入拒绝路径（:269 附近）：`assistant.stopReason === "max_tokens"` → 新 helper `failToolCallsFromTruncatedMessage(toolCalls, results, onEvent)`（逐条 tool_start/tool_end + 错误结果 + `persistableResult`），否则原 `executeToolBatch`；新增文案常量。 |
| `src/runner.ts` | 每次 run 解析 effective maxTokens（`runTurnInner`，`modelReference` 之后；替换 :1401 的 `this.options.maxTokens`）；记录 `lastRunMaxTokens`；`printRunStats` completed 分支加 truncated 注记。 |
| `src/repl/repl.ts` | `settleSuccess` 记录 `lastRunTruncated`（每次 run 开始清零）；EOF 退出路径按它选择 1/0。 |
| `src/cli.ts` | `CliOptions.maxTokensExplicit`（默认 false；`--max-tokens` 置 true + 校验）；帮助文案；`RunnerOptions` 传 `maxTokensExplicit`。 |
| `src/core/constants.ts` | `DEFAULT_MAX_TOKENS = 16384`（cli 默认与 runner 回退共用单一出处）。 |
| `docs/output-truncation-design.md` | 本文。 |

不改：provider 层（openai-completions / deepseek）、compaction、session schema、
`run_end` 与扩展事件载荷、tree-selector。

## 4. 测试计划

新增（`test/loop.test.ts`，基建已有 tool_start/tool_end 断言与 scriptedProvider）：
1. 截断（max_tokens）+ 工具调用 → 工具零执行（mock 记录）、每条得到 pi 文案的 isError
   结果、事件序列含 tool_start/tool_end、历史 tool_use/tool_result 闭合、后续继续到正常
   结束；
2. 截断 + 无工具调用 → `result.truncated === true`；
3. 正常结束 → `truncated` 未置（undefined）钉子；
4. 上限到达 + 截断同 turn → 仍 `max_iterations`（顺序钉子）。

新增（`test/runner.test.ts`，printRunStats 精确字符串用例群旁）：
5. 显式 `--max-tokens` 优先于目录值；
6. 目录值生效（catalog 注入：`setCatalogFetcherForTest` / `IMP_CATALOG_PATH` 夹具；
   `test/model-catalog.test.ts` 已有基建）；
7. 目录值缺失 → 回退（16384）；
8. truncated 注记精确字符串（含数字）。

新增（print/repl 用例，就近落位现有 `runRepl` 基建）：
9. `-p` 截断 → 退出码 1 + 注记；正常 → 退出码 0（回归钉子）。

手动验收（owner 放行后）：
10. 实发探针：deepseek-flash 请求 max_tokens=384000 被端点接受；
11. `--max-tokens 512` 强制截断复现：观察"拒绝行 + 注记 + 退出码"三件套。

门禁：typecheck / lint / vitest 全量（UNMASKED 退出码，沿用 loop-health 的教训）。

## 5. 风险

- **成本天花板上升**（目录值直接使用）：单轮最坏成本随模型目录值放大；已接受，记录在案。
- **截断拒绝循环**（模型连续重发被截断的调用）：print/headless 由 maxIterations 兜底；
  交互模式无上限，由 loop-health 监视（repeat-loop）部分覆盖——观察触发条件：日志出现
  连续 ≥3 轮"截断拒绝"（阈值可评审调整）。
- **退出码 1**：既有把 `-p` 非零视为失败的脚本从现在起能正确捕获截断（本意），发布说明
  需提及。
- **离线首启且无缓存**：目录值缺失 → 回退 16384，截断仍可能发生，但 D1/D2 保证安全与
  可见。
- **服务端拒绝 384000 的可能性**：探针先行；被拒则按修订流程 cap。

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `src/core/loop.ts` | 结果类型 +1 字段；拒绝路径 helper（~30 行） |
| `src/runner.ts` | 解析函数 + 状态字段 + 注记（~15 行） |
| `src/repl/repl.ts` | 2 处（状态写入 + 退出码分支，~6 行） |
| `src/cli.ts` | 选项字段 + 解析 + 校验 + 帮助（~12 行） |
| `src/core/constants.ts` | +1 常量 |
| `test/loop.test.ts` | +4 用例 |
| `test/runner.test.ts` | +4 用例 |
| repl/print 测试 | +2 用例 |
| `docs/output-truncation-design.md` | 本文 |

## 7. 评审记录

- （占位）设计评审轮次、结论、折叠项；实现评审记录后续追加。
