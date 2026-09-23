# 子代理软着陆设计（child tool budget — soft nudge + browse-block）

状态：rev 2（2026-09-24，rev 1 的轮次提醒机制被 pi-subagents 演化证据推翻，改版为工具预算制）· 批次 `feat/subagent-softlanding`
前置：M5 子代理设计（docs/m5-subagents-design.md）、#compaction-ux 批（childFloor 已就位）
参照系：**pi-subagents 扩展 v0.69.0**（npm 安装于本机，`~/.pi/agent/npm/node_modules/pi-subagents`；pi 本体无子代理）——用户指引，替代 rev 1 的"无参照"结论。

## 0. 问题：硬墙式的 40 轮上限

`CHILD_MAX_TURNS = 40`（constants.ts:13）是硬墙：第 40 轮若模型仍在发工具调用，
loop.ts:213 直接封口返回 `max_iterations`。三个伤害：

### 事故 A（2026-09-23，本仓库审查子代理）

`children/2026-09-23T12-44-57-988Z-97391b25….jsonl`，实测：

- 40 轮 / 40 次工具调用（每轮恰好 1 次，持续 read/grep）、工具输出共 83,902 字符
- usage 33,714 in / 11,181 out（≈44.9k token）
- **最终文本：无**——第 40 轮仍在发工具调用，报告一个字没写
- 父代理收到：`(subagent completed with no output)`——"completed" 是假的，且无再派发指引

### 伤害 B（结构性）：子代理对预算无感知，硬墙不保最终文本

子代理的 system prompt 无任何预算信息；40 轮硬墙截断时若模型还在调工具，产出为零。
硬墙的失败模式恰恰是"花了全部预算在挖、没写结论"——墙本身不制造结论。

### 伤害 C（派发侧）：prompt 尺寸无约束提示

M5 §11 已知风险 "parents paste huge context into prompt"，task 工具描述只教
self-contained，不教多大算大。

## 1. pi-subagents 的演化证据（本设计的直接依据）

本机安装的 pi-subagents 0.69.0，源码与 CHANGELOG：

1. **曾有轮次预算 + wrap-up 注入**（rev 1 同构）：`turnBudget { maxTurns, graceTurns }`，
   软限经 system prompt 注入 wrap-up 警告、宽限轮后硬终止（CHANGELOG :1418）。
2. **0.59.0（2026-08-28）整体移除**："Remove assistant turn budgets, including hard
   termination, wrap-up prompt injection, and launch configuration."（CHANGELOG :454）。
3. **替换为 `toolBudget`**（src/runs/shared/tool-budget.ts）：
   - 计数单位改为**工具调用**（`tool_call` 事件，含被封锁的调用）
   - 软限一次（`softNudged` 标记）经 `sendUserMessage(deliverAs:"steer")` 注入
     （subagent-prompt-runtime.ts:392-396）：
     `"Tool budget soft limit reached after N tool calls (soft S, hard H). Stop
     starting new browsing/search work and finalize from the context you
     already have."`（tool-budget.ts:60-62）
   - 硬限**不终止 run、封锁工具**：`nextToolCount > hard && block 表命中 → { block:
     true, reason }`（shouldBlockToolForBudget，tool-budget.ts:55-58），封锁消息
     `"The 'X' tool is blocked so you can finalize from the context you
     already have."`（:64-66）
   - **默认封锁表 = `["read","grep","find","ls"]`**（DEFAULT_TOOL_BUDGET_BLOCK，:3），
     `"*"` 可全封；**最终 assistant 文本永不被封**（docs/tool-reference.md:121）
4. 政策注记（docs/tool-reference.md:135）：硬预算适合 read-only scout/reviewer；
   不建议对有编辑权的 worker 设紧预算（封读会砍掉其编辑后验证）。
5. 示例数值 soft:40 / hard:60（docs/workflows.md:104），soft/hard ≈ 2/3。

**对事故 A 的映射**：若第 30 次工具调用后 read/grep 被封，剩 10 轮模型只能写报告——
封锁机制**从结构上保证**最终文本可产生；提醒只恳求，封锁才保证。

**rev 1 被推翻的点**：轮次阈值提醒（75%/95% 注入）= pi-subagents 已建又拆的方案。
保留的是被验证的部分：steer 通道 user 消息注入 + 恰好一次；替换的是触发器
（工具调用数）与终止语义（封工具，不封 run）。

## 2. 目标与非目标

**目标**
1. 子代理在预算尾部被有效引导收尾，且**机制上保证**最终文本可产生
2. 撞限/撞预算结果对父代理诚实、可行动
3. 派发侧有尺寸意识提示

**非目标**
- 不改 CHILD_MAX_TURNS=40（M5：40 轮 ≈ 30min 恰配 wall clock；仍是绝对后备墙）
- 不做子代理与用户交互（one-shot 契约不变）
- 不做 per-agent 配置/设置暴露（常量 + 环境开关，settings 化留给未来批次）
- 不封锁 bash/edit/write（封锁表只含 browse 类，见 §3.1 理由）

## 3. 方案：三层

### 3.1 层 1 —— 子代理工具预算（soft nudge + browse-block）

**常量**（constants.ts，导出以便未来 settings 化）：

```ts
export const CHILD_TOOL_BUDGET_SOFT = 20; // advisory nudge, once
export const CHILD_TOOL_BUDGET_HARD = 30; // browse tools blocked after this
export const CHILD_TOOL_BUDGET_BLOCK = ["read", "grep", "find", "ls"];
```

- **soft=20**：约 2/3 × hard，对齐 pi-subagents 的 40/60 比例；纯建议，不打断工作
  （合法读 25 个文件的 scout 只在 20 收到一次"该收尾了"，仍可继续读到 30）
- **hard=30**：40 − 30 = **≥10 轮纯文本余量**——事故 A 每轮恰 1 次工具调用的节奏下，
  封锁后模型有 10 轮写报告；与 M5 的 30min wall clock 联动不变（封锁轮极廉价，
  无工具执行、无工具输出）
- **封锁表只含 browse 类**（read/grep/find/ls）：pi-subagents 默认表原样。bash
  不封——它是 imp 的通用工具（审查子代理跑 `git log` 也靠它），封锁会误伤非浏览
  用途；worker 的编辑-验证路径靠 bash/read 验证，30+ 读的 worker 被封读后仍可
  报告"已编辑、验证未完成"，**父代理（主循环）无预算、总能接手验证**——这是
  pi-subagents 政策（"workers 别设紧预算"）在 imp 单层派发结构下的等价物
- **开关**：`IMP_CHILD_TOOL_BUDGET=0` 整体关闭（IMP_AUTOCOMPACT 同款逃逸口）

**机制**（全部在 subagent.ts，loop.ts 零改动，两条现成缝）：

1. **计数 + 封锁**：包装 `onToolCall`——每次调用 `toolCount++`（含被封锁的尝试，
   pi-subagents 同款）；`toolCount > HARD && name ∈ BLOCK` → 返回
   `{ block: true, reason: 封锁消息 }`（不转发父 gate——封锁优先于父审批，
   道理同 loop 内部 gate）；否则转发 `options.onToolCall`。封锁经 executeToolBatch
   的 block 合成路径变成 isError 工具结果给子代理——即封锁消息本身。
2. **软提醒**：计数器观察到 `toolCount >= SOFT && !nudged` 时，把 nudge 文案压入
   本地队列；`launchLoop` 新接 `getSteeringMessages`（现成缝，M17 前就有，子代理
   从未接过）回调排空该队列——**loop.ts:143-151 原样 push 进 history**，与
   pi-subagents 的 `deliverAs:"steer"` 同形：user 消息、恰好一次、进子 history
   与持久化（审计可见"系统何时催促过"）。
3. **状态**：`softNudged` 布尔 + `toolCount` 计数器在 runSubagent 闭包，溢出恢复
   的第二次 launchLoop 继续累计（与"提醒不重发"自洽——预算状态跨重试继承）。

**文案**（对齐 pi-subagents 语义，imp 前缀 `[task]` 便于 transcript 辨识）：

- nudge：`[task] tool budget soft limit reached after N tool calls (soft 20, hard 30). Stop starting new browsing/search work and finalize from the context you already have.`
- block：`[task] tool budget hard limit reached after N tool calls — the 'X' tool is blocked so you can finalize from the context you already have.`

### 3.2 层 2 —— 撞限结果升级（诚实 + 可行动）

现状 task.ts:305：`[task] hit the turn cap; result may be incomplete.` + text 为空时
`(subagent completed with no output)`。按 text 有无分二形：

**有 text**：
```
[last assistant text]
[task] hit the 40-turn cap; this is the child's wrap-up answer, not a confirmed completion.
(child: 40 turns, 33.7k in / 11.2k out)
```

**无 text**（事故 A 形态）：
```
[task] child spent all 40 turns without producing a final answer (it was still calling tools on the last turn). Nothing was lost — the child's transcript is preserved. Re-dispatch with a narrower prompt: fewer files to read, or ask for partial findings.
Transcript: /path/to/children/<id>.jsonl (first 200 chars of task: "…")
(child: 40 turns, 33.7k in / 11.2k out)
```

- transcript 路径：task.ts 已有 `where`（session 路径 / `not persisted`）；无 session
  模式退化为不含路径形态（"re-dispatch narrower" 仍成立）
- **isError 维持 false**（M5 "cap is a valve, not an error"；升 isError 会诱导父代理
  盲目整体重试；带指引的成功形引导**缩小再派发**决策）
- 层 1 落地后此形态应趋罕见（封锁保文本）——层 2 是后备墙的诚实化，两层独立生效

### 3.3 层 3 —— 派发侧尺寸教学

`taskSchema.prompt.description` 追加：

> Keep the prompt focused (~300 words max): the child re-reads files itself; pasting repo context into the prompt wastes its context window.

## 4. 改动清单

| 文件 | 改动 | 量级 |
|---|---|---|
| src/core/constants.ts | 三个导出常量 | ~8 行 |
| src/core/subagent.ts | onToolCall 包装（计数/封锁/nudge 入队）+ launchLoop 接 getSteeringMessages + 队列状态 | ~45 行 |
| src/core/tools/task.ts | 撞限二形渲染 + transcript 路径；描述加尺寸教学 | ~25 行 |
| test/subagent.test.ts | 层 1：soft 一次/硬封锁表/封锁消息形态/budget=0 关闭/溢出继承/不进父 history | ~90 行 |
| test/task.test.ts | 层 2/3 契约钉子 | ~25 行 |

**细节**：
- 计数在包装的 onToolCall 里（每次 gate 调用 = 一次调用尝试，与 pi-subagents 的
  tool_call 事件计数同义——被封锁的也计数）
- nudge 入队发生在 gate 调用时刻（轮中），排空发生在下一个 top-of-loop poll——
  与 pi-subagents 的 steer 投递时序一致；skipSteeringPoll 交互：子代理无其他
  steering 源，队列只可能含 nudge，无竞态
- `IMP_CHILD_TOOL_BUDGET=0` 读一次（runSubagent 入口，非每调用）

## 5. 测试计划

**层 1（subagent.test.ts，hermetic fake provider）**
1. 15 次工具调用：无 nudge、无封锁
2. 22 次调用（跨 soft 未到 hard）：恰好 1 条 nudge（形态：`[task]` 前缀、含
   "soft limit"），其余不封
3. 35 次调用（跨 hard）：第 31+ 次 read/grep 调用返回 isError 封锁消息（含工具名）；
   bash 调用不封
4. nudge 进子 history（onMessage/持久化可见）、**不进父 history**
5. nudge 不计入 turns/usage 计账
6. 撞 40 轮墙（封锁后仍不写文本的极端 fake）：outcome=max_iterations + 层 2 渲染
7. IMP_CHILD_TOOL_BUDGET=0：全程无 nudge 无封锁
8. 溢出恢复：第一次循环已 nudge → 重试不重发
9. 并行批次跨 soft+hard：计数含全部调用，nudge 仍恰好一次

**层 2（task.test.ts）**
10. max_iterations + text：wrap-up 文案 + trailer
11. max_iterations + 无 text + session：transcript 路径 + 再派发指引 + 任务首 200 字符
12. max_iterations + 无 text + 无 session：无路径形态
13. isError === false 三形全部

**层 3（task.test.ts）**
14. 描述含 "~300 words" 教学文案

## 6. 风险与开放问题

- **封锁被无视**（极端模型行为）：10 轮全领封锁结果仍不写文本 → 40 轮墙兜底 →
  层 2 诚实渲染。最坏情况 = 现状（事故 A），不会更糟
- **soft/hard=20/30 数字依据**：单事故 + pi-subagents 比例外推，无对照实验。常量
  导出，未来可按 dogfood 证据调整
- **worker 误伤**：30+ 读的编辑型子代理被封读 → 报告"编辑完成、验证受限"→
  父代理验证（主循环无预算）。接受：比 40 轮零产出好
- **`[task]` 前缀**：子代理 history 里 user 消息只可能是初始 prompt 或本机制注入，
  无撞车面
- **开放**：per-agent 预算（scout/reviewer/worker 差异化）、settings 暴露、
  soft/hard 自适应——记 M5 后续，本批不做
- **开放**：层 3 教学有效性不可预验证（F4a 教训）；成本一行描述，可撤

## 7. 审查问题清单（给对抗审查）

1. soft=20/hard=30 的数值与 40 轮墙、30min wall clock 的联立论证是否自洽？
2. onToolCall 包装与父 gate 的组合语义（封锁优先于父审批）是否有边角——父 gate
   的 allow-this-session 状态会不会被封锁绕乱？
3. nudge 入队（gate 时刻）与排空（top-of-loop poll）之间的时序洞：同批后续调用、
   would-stop 边界 poll 会不会漏投？
4. 溢出恢复继承 toolCount/softNudged——第二次循环 maxIterations 重置但预算不重置，
   子代理"预算已尽但轮次充裕"的怪态是否需要文案缓解？
5. 层 2 无 text 形态不升 isError 的决策是否会被父代理系统性误读？
6. IMP_CHILD_TOOL_BUDGET=0 与 autoCompact 开关的对称性（env 名、读取时机）是否一致？
