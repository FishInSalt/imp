# Compaction UX 修复批 — 设计文档（rev 2）

> 分支 `feat/compaction-ux` · 2026-09-23 · 1148 tests baseline ·
> rev 2 = 设计审查修复轮（1 P0 + 5 P1 全核实，见 §9）
> 关联：#compaction-budget（已修）、#derived-budget（已修）、M10 B 批活动区、M17 队列

## 0. 背景与证据

用户 dogfood 报告三件事 + 数据分析追加一件，全部来自真实会话
（`~/.imp/sessions/Users-z-Z-Agent_demo/2026-09-22T15-52-24…jsonl`，compaction @ entry 967，
tokensBefore 224,852，retainedTail 154 msgs）：

1. `/compact` 执行中只有静态 note `▪ compacting…`，5-20s 无动态反馈。auto-compact **有**
   一行前置 note（runner.ts:1000 `▪ context ~X tokens — compacting…`，rev2 修正：初稿误称
   "连 note 都没有"），缺口同样只是"静态、无 spinner"
2. 压缩完成后 footer 的 ctx% 显示旧值（实测 22.5%），交互一轮后才更新（实测 3.1%）
3. "压缩后还占不少"——21k 是设计值（20k keepRecent + 1k 摘要）；10% 时刻是后续 30+ 轮
   调查 run 的真实再累积（36 工具结果，142,617 字符），非压缩失效
4. （#5）142k 字符里 bash 占 183k chars/74 次——单次上限 50KB 不是瓶颈
   （median 1.1KB、p90 4KB、max 30KB、零次撞顶），瓶颈是**调用次数 × 单次体积**

pi 对照（scout 亲读核实）：spinner = `CompactionStatusIndicator` 三态 + Loader + ESC 取消
（status-indicator.ts:78-91, interactive-mode.ts:3386-3397）；压缩后显示 = **拒绝估计值**
（`getContextUsage` 在最新 compaction 后无带 usage assistant 时 `percent: null`，footer 显示
`?`，agent-session.ts:3410-3438）；pi 的 bash 截断参数同款（50KB，pi 2000 行 vs imp 500 行）。

## 1. 范围

| # | 名称 | 性质 |
|---|------|------|
| F1 | 锚有效性（压缩后 ctx% 立即正确 + 消除假触发） | bug 修复 |
| F2 | 压缩进行中 spinner（手动 + auto 两路） | UX |
| F3 | Ctrl+C 中止压缩（/compact 手动路） | UX + 设计修订 |
| F4 | bash 输出纪律（系统提示引导 + 截断注记强化） | 提示词/行为 |

非目标：keepRecentTokens 设置化（用户未拍板，保持 pi 默认 20k）；压缩摘要流式展示；
per-run 累积 token 上限（无 pi 先例，新机制风险不成比例）。

## 2. F1 — 锚有效性（rev2 重写）

### 问题

`estimateContextTokens`（compaction.ts:142）锚 = 最后一条带 usage 的 assistant。压缩后
retainedTail 里的 assistant 仍带压缩前 usage（实测 224,852）：footer 显示 22.5%（真值 2.1%）、
200k 窗模型假触发 shouldCompact → 空转录 bail → 误导 note。

### 机制（P0 修复后的正确语义）

floor 语义 = **"压缩边界之后的第一条消息索引"**，不是"记录时刻的 history 长度"
（rev1 的错误：resume/fork/tree 时 buildContext().messages.length 是全量长度，把它当 floor
会把边界之后**所有** assistant 排除出锚扫描，`measured: false` 永久化——审查 P0-1）。

实现分两层：

**a) 结构层（单一真相源）**：`SessionStore.buildContext()` 增加返回字段
`compactionBoundary: number`——未压缩 = 0；已压缩 = `1 + retainedTail.length`
（summary 占 [0]，tail 占 [1..tailLen]，边界后第一条 = tailLen+1）。store 内部本来就有
`lastCompactionIndex`（store.ts:622），边界是既有信息的派生，非新状态。

**b) runner 层**：`estimateFloor: number` 成员（默认 0），在 history 重建/拼合的**每个**
时刻从 store 重算：

- `compactAndSplice`（splice 后）：floor = `1 + retainedTail.length`（与 store 边界一致）
- `resumeSession` / `warmup` / `navigateTree` / `forkSessionAt`（push 后）：floor =
  `store.buildContext().compactionBoundary`（resume 一个已压缩会话：floor = tailLen+1，
  **其后的 assistant 仍是合法锚**——rev1 方案在此永久失效，rev2 修复点）
- `newSession`（审查 P0-2 补）：floor 清零（否则旧会话的 floor 在新会话长过它后开始误排除）
- 会话禁用（`--no-session`）路径：无 store，floor 恒 0（无压缩发生，天然正确）

**c) 消费层（审查 P1-3 补齐，全部 estimate 调用点）**：
`estimateContextTokens(messages, minAnchorIndex?)` 第二参默认 0（全部现有调用零改动），
锚扫描起点 `min(messages.length - 1, minAnchorIndex)`——floor 之前的 assistant 不作锚。
接 floor 的调用点：

1. repl `refreshFooter`（repl.ts:804）——footer 显示
2. `/status` 命令（commands.ts:1633）——status 显示
3. runner `onBeforeTurn` auto-compact 检查（runner.ts:996）——**假触发就是从这里来的**，
   不接 floor 则"消除假触发"的承诺不成立
4. subagent `compactChildHistory` 之后的 shouldCompact 复查（subagent.ts:183）——child
   history 是局部数组，floor 用局部变量：splice 处 `childFloor = 1 + retainedTail.length`
   （或无会话路 `childFloor = summaryToMessage+tail 的长度`），onBeforeTurn 的 estimate 调用
   带上它；审查 P2-8 澄清：现状假触发返回 `{compacted:false}` 不抛错、不触 3 连败熔断——
   本修复消除的是空转与误导 note，不是熔断风险

floor 之后有新 assistant（带真 usage）锚即恢复；floor 是过渡态守卫，非永久状态。

### 不学 pi 的 "?" 方案

imp footer 本来就是估算驱动（M10 起）；1M 窗下 21k 估算（2%）远比 `?` 有用；
char/4 对 summary+tail 误差 ±30% 内够显示用。

### 测试

- 现有 compaction 21 例零破（默认参路径字节不变）
- 新钉：①压缩后立即 estimate = summary+tail 字符估算 + measured:false；②resume 已压缩
  会话：边界后 assistant **可作锚**（rev1 的失败模式回归钉）+ footer 显示低水位；
  ③newSession 后 floor 归零；④onBeforeTurn 假触发消失（200k 窗 + 压缩后状态，
  断言无第二压缩尝试）；⑤child splice 后低水位；⑥floor 参数向后兼容

## 3. F2 — 压缩 spinner（rev2 修正实现面）

### 问题重述（rev1 证据错误已修）

两路都是"静态 note、无动画"：手动 `▪ compacting…`（commands.ts:1790）；auto
`▪ context ~X tokens — compacting…`（runner.ts:1000，存在，rev1 说没有——错）。

### 机制（审查 P1-6/P2-7 修正：不复用 setActivity，走 transcript note 原位重绘）

活动区快照 `{phase, tools, agents}` 无自由文本槽、CommandContext 不暴露 setActivity、
runner 的 renderer 与 shell 的 input.setActivity 是不同对象——复用 = 三处接口改动。
改为**最小侵入**：REPL 层（有 shell 引用）在进入/退出 compacting 状态时用**状态机**驱动：

- `ActivitySnapshot.phase` 增字面量 `"compacting"`（repl.ts:1036 的 phase 三元改为四值：
  `state === "compacting"` → `"compacting"`）；壳渲染层为该 phase 显示 spinner 行
  `compacting context…`（120ms ticker 已有，Loader 语义同 thinking——只是文案不同）
- 状态机已经是唯一事实源：`runCommand` 进 `/compact` 前 `state = "compacting"`
  （repl.ts:497）→ 自动驱动；auto-compact 发生在 run 内（state 已是 running）——
  此时活动区已显示 thinking/tools，**auto 路不加新行**（其前置 note 已有，接受静态）
  （rev1 妄想 auto 也推 spinner 行——审查指出所有权冲突 + 无缝可推，撤回）
- 清除责任：`runCommand` 的 finally 已在每条命令后 flush 状态（repl.ts:495-498），
  phase 随 state 回 idle 自动消失——无"卡行"风险（审查 P2-7 的追问在此关闭）
- print/legacy：无 setActivity，零字节变化

### 测试

- TUI：`/compact` 期间活动区出现 `compacting context…`（FakeTerminal 帧断言）、结束后消失
- legacy：note 字节金样不变；print：零字节

## 4. F3 — Ctrl+C 中止压缩

### 安全性（审查 P3-10 独立复核通过）

abort 质量门（compaction.ts:524-527）在流上抛出、`appendCompaction`（:579）之后才可能
到达——中止零持久化。/tree 同款 abort 通道（commands.ts:1239-1243）已验证。

### 改动

- `/compact` 接 onLongOpAbort 控制器；`runner.compactNow(signal)` 转发（补当年预留线）
- `CompactOutcome`（runner.ts:167 闭联合）加 `"aborted"`；中止时 note
  `▪ compaction aborted — nothing changed`
- runner.ts:1052 的过时注释（引 design §7.4 旧断言）替换，指向本文件
- auto 路**不接**（rev1 决策 D3 维持：run 内压缩随 run 的 Esc 中断走）

### 测试

- 中止：summarizer 收 abort → outcome "aborted" → 会话零改动（无 compaction 条目、
  history 不变）→ note 正确；完成路径金样复跑

## 5. F4 — bash 输出纪律（rev2 重写落点）

### 证据

74 次 bash / 183k chars：median 1.1KB、p90 4KB、max 30KB、零次撞 50KB 顶。降上限不解决
（median 1.1KB 是命令形状问题），只伤 build/test 长输出。

### 落点（审查 P1-5 修正：imp 没有 guidelines 区/addGuideline——那是 pi 的机制，
prompt-audit 批已把 "扩展 promptGuidelines 机制" 记为延后）

**a) 系统提示——加进 Core rules（唯一存在的稳定插点）**：`buildSystemPrompt`
（system-prompt.ts:82）的核心规则区加第 7 条：

```
7. Keep tool outputs small: narrow grep patterns, read with offset/limit,
   head/tail for long command output. Large outputs fill the context window fast.
```

（一句话约束行为面："让工具输出保持小" 与规则 4 "Be concise"（约束回复面）互补；不造
新机制、不碰延后项。）注意 SYSTEM.md 整替（#system-md 批）会**替换核心规则区**——整替
用户本来就接管了行为约束，本条随之让位，属预期交互。

**b) 截断注记教学**：bash.ts formatOutput 的截断 note 尾部加
`(tip: pipe through head/tail or narrow the grep to keep output small)`——只在截断时出现。

### 金样（审查 P3-9 修正："1223 钉子"不存在——repo 无任何字符数断言测试）

新增**首个**系统提示金样测试：pin `buildSystemPrompt` 输出含 7 条规则目录（防未来
漂移）；不 pin 字符数（脆）。§0 证据里的 "1223 字符" 是历史记述不是测试基线——
rev1 引用它当"要同步的钉子"是错的，撤回。

### 测试

- 金样：7 条核心规则存在（`# Core rules` 区含 "Keep tool outputs small"）
- bash 截断注记：截断时含 tip、不截断零字节
- 行为不测（提示词引导不写行为断言）

## 6. 批次划分与流程

单批实现（耦合面小、测试面重叠在 compaction/repl）；设计评审（本 rev 2 即闭环产物）
→ 实现 → 实现审查 → 合入。预计测试 +10~14。

## 7. 决策表（rev2 修订）

| # | 决策 | 理由 |
|---|------|------|
| D1 | F1 floor=压缩边界（结构派生），非长度快照 | rev1 的长度快照在 resume 后永久禁锚（审查 P0） |
| D2 | F2 用 phase 四值 + 状态机驱动，auto 路不推新行 | setActivity 无文本槽 + 所有权冲突（审查 P1-6/P2-7）；auto 前置 note 已有 |
| D3 | F3 不接 auto 路 | run 内压缩随 run abort；单独 Ctrl+C 与 Esc 语义打架 |
| D4 | F4 不降 50KB 上限；规则进 Core rules 第 7 条 | 零次撞顶证据；guidelines 区不存在（审查 P1-5），Core rules 是唯一稳定插点 |
| D5 | keepRecentTokens 维持 20k | 用户未拍板；pi 同值；21k 是设计行为 |
| D6 | 不学 pi "?" 显示 | 估算比空值有用（维持 rev1） |

## 8. 风险

- F1 store 接口变化（buildContext 返回新字段）——纯加法，调用点解构不破
- F2 phase 联合类型扩字面量——壳渲染处 switch 需覆盖（tsc 穷尽性检查兜底）
- F4 系统提示规则 6→7 条：SYSTEM.md 整替用户的预期内交互（见 §5a）；金样是**新增**非更新
- F3 CompactOutcome 联合扩值：闭联合的 switch 消费点（commands.ts /compact 的
  banner 分支）需同步——tsc 兜底

## 9. rev2 变更记录（对审查的逐条处置）

| 审查发现 | 处置 |
|---|---|
| P0-1 floor 在 resume/fork/tree 永久禁锚 | §2 机制重写：floor=结构派生边界 |
| P0-2 漏 newSession | §2b 补（floor 清零） |
| P1-3 漏 onBeforeTurn / /status 两个 estimate 调用点 | §2c 消费层补齐（4 个调用点） |
| P1-4 "auto 无 note" 证据错误 | §0/§3 更正（有 note，缺口只是无动画） |
| P1-5 guidelines 区不存在 | §5a 改落 Core rules 第 7 条；金样改为新增 |
| P1-6 setActivity 不可达 + 快照无文本槽 | §3 改 phase 四值方案；auto 撤回 |
| P2-7 spinner 行清除责任 | §3 状态机 finally 关闭 |
| P2-8 child floor 落点未指明 + 熔断误判澄清 | §2c-4 局部变量方案 + 澄清记录 |
| P3-9 "1223 钉子"不存在 + 1213/1223 不一致 | §5 金样改为新增；不一致撤回 |
| P3-10 F3 安全性复核通过 | 无需改动，记录在案 |

## 10. 后续修订提案：撤回 F4a（规则 7）（2026-09-24，待用户拍板）

用户复审质疑规则 7 的必要性。重新审视的结论：依据不足，建议撤回。

- **证据是误读的产物**：10% 增长当时已查明是正常累积（1M 窗 + 订阅制下零成本、无速度影响）；
  F4 在解决一个未造成损害的行为。
- **违背 #prompt-audit 纪律**：核心规则 6 条全是行为契约（违反=真实失败），第 7 条是效率
  建议（违反=不够省）——混入稀释契约区的信号密度。pi 无此规则。
- **常驻成本换边际效果**：~25 tokens/请求全天候付费，效果不可验证（审查时即承认不写行为断言）。

处置方案：撤 system-prompt 规则 7 + rule-7 测试钉；**保留 F4b 截断 tip**（真实截断时刻的
零成本教学，观测会话中零次触发但无害）；若将来在小窗模型上观测到工具输出成为实际限制，
优先放 bash 工具描述（决策点）而非核心规则。
