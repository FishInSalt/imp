# 子代理软着陆设计 rev 3 —— 零注入 + 后备墙 + 失败信息保全

状态：rev 3（2026-09-24，用户决策：零提示词污染方案）· 批次 `feat/subagent-softlanding`
前置：M5 子代理设计（docs/m5-subagents-design.md）、#compaction-ux 批
参照系（三方实测源码，2026-09-24）：
- **pi-subagents 扩展 v0.69.0**（本机 `~/.pi/agent/npm/node_modules/pi-subagents`）
- **Claude Code 2.1.88 泄漏源码**（`/Users/z/Z/claude-code-sourcemap/restored-src/src`，AgentTool 6k 行 + query.ts 循环）
- imp 自身两次事故实录（40 轮撞限审查子代理 + 第一次委派审查撞限）

## 0. 演化过程与决策链（为什么是 rev 3）

| 版本 | 方案 | 被什么推翻 |
|---|---|---|
| rev 1 | 轮次提醒注入（75%/95% 双阈值）| pi-subagents 建过同构方案（turnBudget wrap-up 注入）又在 0.59.0 整体移除（CHANGELOG :454）|
| rev 2 | 工具预算（soft 20 nudge + hard 30 封锁 read/grep/find/ls）| 用户质疑：预算提示词会污染子代理思维、影响任务质量；CC 实测内建 agent 零注入零封锁 |
| **rev 3** | **零注入 + 60 轮后备墙 + 时钟默认不限 + 失败信息保全** | —— |

三方实测结论支撑零注入：
- **CC 内建子代理**（Explore/general-purpose/Plan）：maxTurns 不设、循环无任何 wrap-up 注入路径、无工具封锁、**无 wall-clock 时限**（query.ts 零 timeout 逻辑；终止权 = 用户 Ctrl+C / TaskStop）。防线完全靠工具池角色化（Explore 剥离 edit/write）+ 模型自律
- **pi-subagents**：轮次预算建了又拆是重要警示，但其 toolBudget（封 browse）方案对"合法深挖"的子代理是误伤——它面向原子化 workflow 步骤，imp 的子代理跑完整审查/调查，探索深度不可预测
- **事故 A 的真实伤害在回传端**：44.9k token 零回报 + 父代理被 "completed with no output" 误导。挖到的东西全在 transcript 里（M5 封口设计保证完整持久化），问题是父代理不知道去哪接手

**核心哲学（用户拍板）**：子代理零提示词污染——不因预算干扰其思维；撞限是边界事件，处理它的责任在**父代理**（看得见全局、能读 transcript、能缩小再派发），不在子代理内部塞机制。

## 1. 问题定义

### 事故 A（2026-09-23，本仓库审查子代理）

`children/2026-09-23T12-44-57-988Z-97391b25….jsonl`，实测：40 轮 / 40 次工具调用（持续 read/grep）/ 工具输出 83,902 字符 / usage 33,714 in + 11,181 out（≈44.9k token）/ **最终文本：无**。父代理收到 `(subagent completed with no output)`——"completed" 是假的，无任何接手指引。

### 三个具体伤害

1. **假完成**：撞限 ≠ 完成，父代理被误导
2. **信息黑箱**：transcript 完整存在但父代理不知道路径（children/ 文件名含时间戳+UUID，不可猜）
3. **墙太低**：40 轮对合法 worker 不够（构建-修复循环 ~4 轮/迭代 ≈ 10 迭代；真实修复批次可能 12+ 迭代）；且快工具场景墙先于时钟咬、恰恰在轮次便宜的合法场景里先截断

## 2. 方案

### 2.1 层 A —— 轮墙调整：40 → 60，降格为后备墙

- `CHILD_MAX_TURNS: 40 → 60`（constants.ts:13）
- 定位从"预算主机制"降格为"防退化循环的后备墙"（对齐 CC fork 的 200 防呆墙定位；CC 内建不设墙，imp 保留一道是因为 imp 无子代理观测/steer 通道——结构上裸奔面更大）
- 联动注释改写：constants.ts:15-17 的"40 轮 × 45s ≈ 30min"推导失效（时钟已不限，见层 B）；M5 设计文档的墙值记档但不再作为推导链
- 溢出恢复最坏情况：2×60 = 120 轮（每轮 maxTokens 有界，纯文本退化循环的烧钱上限仍被轮墙封顶）

### 2.2 层 B —— 时钟：默认不限时，父代理可选设定

- `CHILD_TIMEOUT_MS` 删除（subagent.ts:16,283 的 `AbortSignal.timeout` 链整体移除；`options.timeoutMs` 保留为注入缝，默认 `undefined` = 不限时）
- task schema 加可选 `timeoutMs?: number`（毫秒，描述教："Default: no time limit — the child is bounded only by its turn cap and your Ctrl+C. Set a millisecond budget only for tasks expected to be cheap."）
- 终止兜底链：用户 Ctrl+C（父 signal 转发链，已验证）→ 60 轮墙 → 父代理自设 timeoutMs（可选）
- 无 `TaskStop`/steer 通道（CC 异步架构产物，imp 单 turn 同步派发用不上——Ctrl+C 即全链终止）
- abort/timeout 分类逻辑保留（subagent.ts 现有 timedOut 判定不删——timeoutMs 显式设置时仍然可用）

### 2.3 层 C —— 撞限失败信息保全（核心层，rev 1/2 的层 2 原样）

现状 task.ts:305：`[task] hit the turn cap; result may be incomplete.` + text 为空时 `(subagent completed with no output)`。按 text 有无分二形：

**有 text**（子代理收尾了）：
```
[last assistant text]
[task] hit the 60-turn cap; this is the child's wrap-up answer, not a confirmed completion.
(child: 60 turns, 33.7k in / 11.2k out)
```

**无 text**（事故 A 形态）：
```
[task] child spent all 60 turns without producing a final answer (it was still calling tools on the last turn). Its work is preserved — the full transcript (all turns, tool calls, and outputs) is at:
  <transcript path>
The child's task was: "<first 200 chars of prompt>"
Re-dispatch with a narrower prompt, or read the transcript and continue the work yourself.
(child: 60 turns, 33.7k in / 11.2k out)
```

- transcript 路径：task.ts 已有 `where`（session 路径）；无 session 模式（IMP_CHILD_SESSIONS=0）退化为不含路径形态（"Re-dispatch with a narrower prompt" 仍成立，去掉 "read the transcript" 句）
- **isError 维持 false**（M5 "cap is a valve, not an error"；升 isError 诱导父代理盲目整体重试；带完整信息的成功形引导父代理做**缩小再派发/接手**决策）
- timeout 形态（父设了 timeoutMs 且触发）：同构诚实渲染——`[task] child exceeded its N-minute budget (status: timeout)`，同样给 transcript 路径与再派发指引

### 2.4 层 D —— 派发侧尺寸教学（保留 rev 1/2 层 3）

`taskSchema.prompt.description` 追加一句（只出现在**父代理**看到的工具描述里，子代理不可见——零污染原则不冲突）：

> Keep the prompt focused (~300 words max): the child re-reads files itself; pasting repo context into the prompt wastes its context window.

### 2.5 明确不做（记档）

- ~~soft nudge 注入~~（rev 2）——污染子代理思维；对合法深挖是误伤
- ~~browse-block 工具封锁~~（rev 2）——同上；封锁消息是持续噪声
- ~~per-agent 预算差异化~~——预算概念整体后移，等 dogfood 证据
- ~~wall-clock 写死 30min~~——推导基础已失效；父代理自决
- ~~TaskStop/steer 通道~~——异步架构产物，imp 单 turn 同步派发不需要
- 子代理观测面板/fleet 视图——未来批次，非本批范围
- ~~异步派发（后台子代理 + 完成通知回流）~~——三方实测后搁置（用户决策 2026-09-24）：pi-subagents 的后台子系统 22,942 行（async-execution/tracker/retention/resume/status/intercom 四个交付面 + completion-batcher），CC 的通知回流带全局队列 + 轮边界排水 + 去重标记 + per-agent 路由 + 反猜测 prompt 教学（query.ts:1570-1631, LocalAgentTask.tsx:197-254, prompt.ts:93）——两家都为异步付了最重的工程量。imp 不做：①批内并行已覆盖主流需求（task 是 concurrencySafe，同批多个 task 并发，结果按位返回，零回流机制）；②异步通知是“干扰父代理思维”的最大单一污染源，与零注入哲学冲突；③“等子代理期间继续对话”的真实痛点未出现。**重启条件**：该痛点实际出现时，先加 wait 型工具（pi-subagents 的中间形态），不跳全套异步

## 3. 改动清单

| 文件 | 改动 | 量级 |
|---|---|---|
| src/core/constants.ts | `CHILD_MAX_TURNS = 60`；删 `CHILD_TIMEOUT_MS` 及其推导注释 | ~6 行 |
| src/core/subagent.ts | 删 clock 中止链（:283 及 abort 分类里的 timeout 判定改由 timeoutMs 是否设置驱动）；`timeoutMs?: number` 保留 | ~20 行 |
| src/core/tools/task.ts | schema 加 `timeoutMs`（透传 runSubagent）；撞限/timeout 二形渲染 + transcript 路径；描述加尺寸教学 | ~35 行 |
| test/subagent.test.ts | 时钟相关测试改写（默认无限时、显式 timeoutMs 触发 timeout 分类）；60 轮墙值钉子 | ~40 行 |
| test/task.test.ts | 层 C 二形/三形态契约钉子 + 层 D 文案钉子 | ~35 行 |

## 4. 测试计划

**层 A（subagent.test.ts）**
1. CHILD_MAX_TURNS === 60 钉子（防止未来无意识改回）
2. 撞 60 轮墙：outcome = max_iterations（现有 fake 驱动改参）

**层 B（subagent.test.ts）**
3. 默认（无 timeoutMs）：无 clock abort——长跑 fake（慢工具轮）不被时限打断
4. 显式 timeoutMs=50ms + 挂起工具：outcome = timeout，reason 分类正确
5. timeoutMs 触发与父 Ctrl+C 的分类区分（timedOut 判定保留验证）

**层 C（task.test.ts）**
6. max_iterations + text：wrap-up 标注 + trailer
7. max_iterations + 无 text + session：transcript 路径 + 任务首 200 字符 + 双指引句
8. max_iterations + 无 text + 无 session：无路径形态（指引句不含 "read the transcript"）
9. timeout 形态：`[task] child exceeded its N-minute budget` + transcript 路径
10. isError === false 全部形态

**层 D（task.test.ts）**
11. prompt 描述含 "~300 words" 教学文案

## 5. 风险与开放问题

- **零文本撞限在 60 轮下仍可能发生**（用户接受，记档）：本方案不保证最终文本；兜底 = transcript 保全 + 父代理接手。与 rev 2 "封锁保证文本" 是真实 tradeoff——换来零污染对全部正常子代理有效。60 轮比 40 轮多 50% 的挖掘+收尾余量
- **60 数字依据**：三方演化方向（CC 内建无墙 / pi 拆墙 / CC fork 200）+ imp 保守折中；单事故样本，无对照。常量导出，dogfood 证据驱动调整
- **不限时的极端风险**：纯文本退化循环烧 token 直到 60 轮墙——每轮 maxTokens 有界，上限 = 60 × maxTokens 输出 + 输入膨胀。接受（与 CC 内建同风险面）；用户 Ctrl+C 随时可用
- **transcript 路径被父代理整读**：read 有 50KB 截断救场 + 本批文案教 "narrower re-dispatch or continue yourself"；JSONL 单行大条目可能压满截断——首 200 字符任务摘要缓解定位
- **开放**：层 D 教学有效性不可预验证（F4a 教训）；成本一行描述，可撤

## 6. 审查问题清单（给对抗审查）

1. 60 轮 + 不限时 + 零注入的联立：最坏烧钱场景的量级估算是否可接受？上限是否需要在文档里显式算出来？
2. timeoutMs 透传链（schema → task.ts → runSubagent → clock）在 abort 分类、溢出恢复、session 持久化各处是否有边角（e.g. timeout 发生在 compaction 中途）？
3. 层 C 无 session 形态的指引文案是否足够可行动（无 transcript 可读时）？
4. isError=false 决策：父代理模型会不会仍把 "hit the 60-turn cap" 文案当失败而整体重试？（教学靠文案，无机制保证）
5. 删 CHILD_TIMEOUT_MS 的兼容面：M5 设计文档、既往 ledger、测试引用处是否全部同步？
6. timeoutMs schema 参数的滥用面：父代理会不会给所有任务都设时限（反向污染）？描述文案是否足够约束？
