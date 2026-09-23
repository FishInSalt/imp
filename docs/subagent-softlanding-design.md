# 子代理软着陆设计（turn-cap soft landing）

状态：rev 1（2026-09-24）· 批次 `feat/subagent-softlanding`
前置：M5 子代理设计（docs/m5-subagents-design.md）、#compaction-ux 批（childFloor/自动压缩已就位）
本批无 pi 参照（pi 本体无 task/子代理工具；imp 子代理系统为 M5 自研）——参照系是 M5 设计
文档本身与两次真实事故。

## 0. 问题：硬墙式的 40 轮上限

`CHILD_MAX_TURNS = 40`（constants.ts:13）是硬墙：第 40 轮若模型仍在发工具调用，
loop.ts:213 直接封口（补 `(not executed: reached max turns)` 合成结果）返回
`max_iterations`。三个具体伤害：

### 事故 A（2026-09-23，本仓库审查子代理）

`children/2026-09-23T12-44-57-988Z-97391b25….jsonl`，实测：

- 40 轮 / 40 次工具调用（每轮恰好 1 次，持续 read/grep）、工具输出共 83,902 字符
- usage 33,714 in / 11,181 out（≈44.9k token）
- **最终文本：无**——第 40 轮仍在发工具调用，报告一个字没写
- 父代理收到的 tool result：`(subagent completed with no output)` + 40 轮 trailer

伤害面：44.9k token 零回报；渲染文案 **"completed" 是假的**（上限截断≠完成）；
父代理无再派发指引，只能靠自己的经验重写 prompt。

### 伤害 B（结构性）：子代理对预算无感知

子代理的 system prompt（父 prompt + CHILD_SUFFIX）从头到尾没有任何"你还剩多少轮"的
信息。模型无法在剩余轮次内做质量取舍（"还剩 5 轮，够读 2 个文件，先写结论"）。
主循环无此问题：它无轮上限（#no-turn-cap 批，100 轮仅为打印默认）。

### 伤害 C（派发侧）：prompt 尺寸无约束提示

M5 §11 已知风险："parents paste huge context into prompt"。task 工具描述只教
"self-contained"，不教"多大算大"。事故 A 的任务 prompt 约 700 字符（尚可），但
更长的派发（粘贴整个审查上下文）会烧掉子代理的窗口预算，无任何提示。

## 1. 目标与非目标

**目标**
1. 子代理在预算尾部收到的信息足以主动收尾（写结论而非继续挖）
2. 撞限结果对父代理诚实、可行动（不是 "completed with no output"）
3. 派发侧（父代理写 prompt 时）有尺寸意识提示

**非目标**
- 不改 CHILD_MAX_TURNS 值、不做自适应上限（M5 定 40：平均 45s/轮 × 40 ≈ 30min 恰配
  30 分钟 wall clock；两常量联动，改值另议）
- 不做子代理与用户的交互通道（子代理仍 one-shot、不能提问——CHILD_SUFFIX 契约不变）
- 不做 prompt 硬截断（只在工具描述里教学，不设机器强制）
- 不动 loop.ts 的核心循环结构（reminders 走既有 getSteeringMessages 缝）

## 2. 方案：三层软着陆

### 2.1 层 1 —— 轮次预算提醒（收尾指令注入）

**机制**：`runSubagent.launchLoop` 新增 `getSteeringMessages` 回调。loop.ts 零改动
——该缝本来就是为轮边界消息注入设计的（M17 之前就有，主循环用于队列 steering），
子代理从未接过它。

**注入规则**（turn 从 1 数起）：

| 时机 | 注入内容 |
|---|---|
| 第 30 轮边界（turns ≥ 0.75 × 40） | `[task] 10 turns left (cap 40). Start wrapping up: finish the current step, then write your final answer.` |
| 第 38 轮边界（turns ≥ 0.95 × 40，即剩 2 轮） | `[task] 2 turns left. Write your final answer NOW — the next response after this one may be cut off.` |

- **形态**：user-role 消息（steering 通道的标准形态，loop.ts:145-151 原样 push）。
  前缀 `[task]` 区别于任何用户 steering（子代理本无用户输入通道，前缀纯为可辨识）。
- **为什么 user 消息而非 system**：system prompt 是请求级常量（每次 stream 都带上），
  动态追加会把"剩余轮次"塞进所有后续请求并随缓存失效；user steering 消息只注入一次，
  且是 loop.ts 唯一现成的注入通道。
- **75%/95% 双阈值理由**：75% 是"开始收尾"的合理提前量（事故 A 第 30 轮时已读了
  大量材料，有 10 轮余量写报告）；95% 是最后通牒（防模型把 75% 提醒当作"还有很久"）。
  单阈值（只 75%）与事故 A 的行为模式不匹配——该模型直到第 40 轮仍在读。
- **恰好一次**：每个阈值各注入一次（turns 计数器达到即置已发标记），不重复轰炸。
- **溢出恢复交互**（overflow retry）：重试的第二次 runAgentLoop 轮次**重新计数**
  （maxIterations 从头，overflow-pagination-design.md D3 决策），但提醒状态
  （已发标记）**继承**——恢复场景本来罕见，若提醒已发过则不再发（子代理已被告知预算紧张）。
- **userMessage 形态注意**：提醒消息经 getSteeringMessages 注入与正常 steering 完全
  同形（role: user 字符串 content），进入 history、进入子代理 session 持久化（onMessage
  回调 fire），replay 时可见——这是特性不是 bug（审计可见"系统在何时催促过子代理"）。

### 2.2 层 2 —— 撞限结果升级（诚实 + 可行动）

现状 task.ts:305：`[task] hit the turn cap; result may be incomplete.` + text 为空时
父代理看到 `(subagent completed with no output)`。

改为按 text 有无分两形：

**有 text**（子代理收尾了）：
```
[last assistant text]
[task] hit the 40-turn cap; this is the child's wrap-up answer, not a confirmed completion.
(child: 40 turns, 33.7k in / 11.2k out)
```

**无 text**（事故 A 形态——死于挖掘中）：
```
[task] child spent all 40 turns without producing a final answer (it was still calling tools on the last turn). Nothing was lost — the child's transcript is preserved. Re-dispatch with a narrower prompt: fewer files to read, or ask for partial findings.
Transcript: /path/to/children/<id>.jsonl (first 200 chars of task: "…")
(child: 40 turns, 33.7k in / 11.2k out)
```

- **transcript 路径**：task.ts 已有 `where`（session 路径或 `not persisted`）。无 session
  模式（IMP_CHILD_SESSIONS=0）则退化为不含路径的指引（"re-dispatch with a narrower
  prompt"仍然成立）。
- **isError 语义**：维持 `isError: false`（M5 决策"cap is a valve, not an error"不变）
  ——文案升级是让父代理可行动，不是把上限变成失败。
- **isError 例外**：无 text 时是否升 isError？**不升**。理由：升 isError 会让父代理
  把它当失败而重试整个任务（更烧 token）；带指引的成功形让父代理做**缩小再派发**决策。
  （此处与 M5 §3 原文"return last assistant text as a success-shaped result"一致——
  升级的只是 text 为空这个此前未细分的分支。）

### 2.3 层 3 —— 派发侧尺寸教学（task 工具描述）

`taskSchema.prompt.description` 追加一句：

> Keep the prompt focused (~300 words max): the child re-reads files itself; pasting repo context into the prompt wastes its context window.

- 只改描述文案，无 schema/机器强制。
- 与层 1/2 独立可关（若教学无效果，未来可撤——同 F4a 的教训：无证据不常驻）。

## 3. 改动清单

| 文件 | 改动 | 量级 |
|---|---|---|
| src/core/subagent.ts | launchLoop 加 getSteeringMessages（阈值常量 REMINDER_75=0.75/REMINDER_95=0.95，turns 计数从 onEvent 或外层包装计数） | ~30 行 |
| src/core/tools/task.ts | 撞限结果二形渲染 + transcript 路径 | ~20 行 |
| src/core/tools/task.ts | prompt 描述加尺寸教学 | 1 行 |
| test/subagent.test.ts | 层 1：75%/95% 注入时机、恰好一次、aborted 不注入、溢出恢复继承状态；层 2：两形渲染钉子 | ~80 行 |
| test/task.test.ts | 层 2/3 契约钉子 | ~20 行 |

**计数细节**：turns 在 runSubagent 侧怎么拿到？loop 的 turns 是内部计数器。两个方案：
(a) onEvent 观察 message_end 事件计数（子代理 launchLoop 已传 onEvent 透传）——但
onEvent 是 options.onEvent 可能未传；(b) onMessage 数 assistant 消息（已透传、必 fire）。
**选**：外层包装现有 onMessage，计数 assistant role 消息——零侵入、两模式（session/
无 session）都经过。注意溢出重试第二次 launchLoop 时 history 不清空，onMessage 计数
继续累计——与"提醒状态继承"自洽（提醒阈值按累计轮数判断，第二次循环内不再重复注入）。

**getSteeringMessages 的调用时机细节**（loop.ts:143-151）：每轮 top-of-loop poll 一次 +
would-stop 边界 poll 一次。注入实现为：回调闭包查当前计数，达阈值且未发过 → 返回
[reminder]；否则 []。would-stop 边界的额外 poll 无害（已发标记挡住重复）。

## 4. 测试计划

**层 1（subagent.test.ts，hermetic fake provider）**
1. 25 轮 fake（低于 30）：零注入（history 无 `[task]` 消息）
2. 35 轮 fake：恰好 2 条注入（30 边界 1 + 38 边界…注意 fake 轮次粒度——用可数
   provider 驱动到 31+ 轮验证 75% 那条；95% 用 39 轮验证）
3. 注入消息形态：role user、以 `[task]` 开头、含 "turns left"
4. 撞限（40 轮全是工具调用）：注入过且 outcome.status === max_iterations
5. 溢出恢复：第一次循环注入过 75% → 恢复重试不再注入
6. 提醒不影响 usage 计数（注入消息不计入 turns/usage）

**层 2（task.test.ts）**
7. max_iterations + text：wrap-up 文案 + trailer
8. max_iterations + 无 text + session：transcript 路径 + re-dispatch 指引 + 任务首 200 字符
9. max_iterations + 无 text + 无 session：无路径形态
10. isError === false 三形全部

**层 3（task.test.ts）**
11. 描述含 "~300 words" 教学文案

**层 1 拒绝路径**
12. 提醒消息不进入父 history（只进子 history）——via onMessage 回调的 store mock 验证

## 5. 风险与开放问题

- **提醒被当指令 obeyed 过头**：模型收到 "start wrapping up" 可能提前收尾，任务质量
  下降。接受：40 轮用尽后的零产出比早收尾伤害大（事故 A 即证）。残余风险：75% 太早？
  30/40 留 10 轮写报告，参考事故 A 每轮 1 工具调用的节奏，10 轮够写。
- **`[task]` 前缀撞车**：子代理输出里若恰好含 `[task]` 开头的 user 消息形式（不可能——
  子代理无用户输入，history 里 user 消息只可能是初始 prompt 或本机制注入）。
- **turns 计数与 loop 内部计数漂移**：onMessage 数 assistant 消息 vs loop 的 turns++。
  两者对"每 assistant 消息 turns++"语义一致（loop.ts:158-159）；溢出重试后 loop 重置
  但 onMessage 累计——设计如此（见 §3 计数细节），提醒按累计判断。
- **开放**：层 3 教学文案是否有效无法预验证（同 F4a 教训）。接受：成本一行描述，可撤。
- **开放**：撞限无 text 时给父代理的 transcript 路径会不会被父代理直接 read 整个
  JSONL（50KB 截断救场）？接受——read 截断 + 本批文案教"narrower re-dispatch"。

## 6. 审查问题清单（给对抗审查）

1. 阈值 0.75/0.95 的数字依据是否充分？（事故 A 单样本 + 推理，无对照）
2. 注入走 getSteeringMessages 与主循环 steering 语义冲突？（主循环该缝消费用户队列；
   子代理消费系统提醒——同一 API 两种用途，是否该分缝？）
3. onMessage 计数方案的边角：skipSteeringPoll 交互、would-stop 边界二次 poll 交互？
4. 无 text 撞限不升 isError 的决策（§2.2）是否会被父代理系统性误读？
5. 层 2 无 session 形态的指引文案是否足够可行动？
6. 事故 A 里 fake 25 轮测试与真实 40 轮行为的代表性缺口？
