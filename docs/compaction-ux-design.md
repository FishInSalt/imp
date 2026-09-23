# Compaction UX 修复批 — 设计文档

> 分支 `feat/compaction-ux` · 2026-09-23 · 1148 tests baseline
> 关联：#compaction-budget（2048 bug，已修）、#derived-budget（推导式预算，已修）、M10 B 批活动区、M17 队列

## 0. 背景与证据

用户 dogfood 报告三件事 + 数据分析追加一件，全部来自真实会话
（`~/.imp/sessions/Users-z-Z-Agent_demo/2026-09-22T15-52-24…jsonl`，compaction @ entry 967，
tokensBefore 224,852，retainedTail 154 msgs）：

1. `/compact` 执行中只有静态 note `▪ compacting…`，5-20s 无反馈（auto-compact 连 note 都没有）
2. 压缩完成后 footer 的 ctx% 显示旧值（实测 22.5%），交互一轮后才更新（实测 3.1%）
3. "压缩后还占不少"——21k 本身是设计值（20k keepRecent + 1k 摘要），但 10% 时刻被误读为
   压缩失效；实际是后续 30+ 轮调查 run 的真实再累积（36 个工具结果，142,617 字符）
4. （#5 新增）上述 142k 字符里 bash 占 183k chars/74 次——单次上限 50KB 并不是瓶颈
   （median 1.1KB、p90 4KB、max 30KB、零次撞顶），瓶颈是**调用次数 × 单次体积**的自伤模式

pi 对照（scout 亲读源码核实）：

- spinner：`CompactionStatusIndicator`（status-indicator.ts:78-91）三态文案 + Loader 动画 +
  ESC 取消（interactive-mode.ts:3386-3397）
- 压缩后显示：**拒绝显示估计值**——`getContextUsage()` 在最新 compaction 之后无带 usage 的
  assistant 时返回 `percent: null`，footer 显示 `?/200k`（agent-session.ts:3410-3438）
- pi 的 bash 截断与 imp 完全同参数（50KB/2000 行——imp 是 500 行，更紧），pi 也无按 run
  累积上限

## 1. 范围

四个独立修复，一个批次：

| # | 名称 | 性质 |
|---|------|------|
| F1 | 锚有效性（压缩后 ctx% 立即正确 + 消除假触发） | bug 修复 |
| F2 | 压缩进行中 spinner（手动 + auto 两路） | UX |
| F3 | Ctrl+C 中止压缩（/compact 手动路） | UX + 设计修订 |
| F4 | bash 输出纪律（系统提示引导 + 截断注记强化） | 提示词/行为 |

非目标：keepRecentTokens 设置化（用户未拍板，保持 pi 默认 20k）；压缩摘要流式展示
（pi 也不做）；per-run 累积 token 上限（pi 无先例，做=新机制，风险不成比例）。

## 2. F1 — 锚有效性

### 问题

`estimateContextTokens`（compaction.ts:142）锚 = 最后一条带 usage 的 assistant。压缩后
retainedTail 里的 assistant 仍带压缩前 usage（实测 224,852）：

- footer 显示 22.5%（真值 2.1%）
- 下一 run 的 onBeforeTurn `shouldCompact(224852 > 1M - 16384)` … 1M 窗下不触发；但 200k
  窗模型必触发 → 空转录护栏 bail → 误导 note "nothing safe to compact"。现状注释
  （compaction.ts:131-139）自己承认 "one extra compaction attempt on resume"

### 设计

`estimateContextTokens` 增加第二参数 `minAnchorIndex = 0`（默认不变，全部现有调用点零改动）：
锚扫描从 `min(messages.length - 1, minAnchorIndex)` 起向前——**压缩拼合点之前的 assistant
不作锚**。锚失效时退化为纯字符估算（`measured: false`），~21k → footer 立即显示 ~2%。

调用点改造（三处，均为"压缩刚发生"的时刻）：

1. `runner.compactAndSplice`：splice 后调用 `refreshContextEstimateFloor()`——把
   `session.buildContext().messages.length` 记入 runner 成员 `estimateFloor`；footer 的
   refreshFooter 读取活 history 时把 floor 换算成 `minAnchorIndex`（history 是 splice 后的
   完整数组，floor 即拼合长度，直接可用；后续追加只增大索引，floor 恒有效）
2. `runner.resumeSession` / `forkSessionAt` / `navigateTree`：同样从
   `session.buildContext()` 取 floor 记入（覆盖 /resume 已压缩会话的旧病——现状 resume 后
   footer 一样显示窗口满格直到一轮对话）
3. `subagent.compactChildHistory`：child history splice 后同规则——child 的
   shouldCompact 检查在 splice 之后的下一轮，必须看到压缩后的真实水位

不改变 `measured` 语义本身：floor 之后有新 assistant（带真 usage）锚自然恢复，floor 失效
是过渡态，与现状"一轮后自愈"兼容。

### 为什么不学 pi 的 "?" 方案

pi 显示 `?` 是**放弃**——1M 窗下 21k 猜测值（2%）远比 `?` 有用；char/4 对
summary+tail（无旧 usage 干扰、体积已知）误差 ±30% 内，够显示用。imp 的 footer 本来就是
估算驱动（M10 起），口径一致。

### 测试

- 现有 21 例 compaction 测试零破（默认参数路径字节不变）
- 新钉：压缩后立即 estimate = summary+tail 字符估算、measured=false；一轮后恢复
  measured=true；floor 参数向后兼容（不传=旧行为）；resume 已压缩会话 footer 立即显示
  估算而非满格；child splice 后 shouldCompact 读到低水位（不再假触发）

## 3. F2 — 压缩 spinner

### 设计

手动 `/compact`（commands.ts:1782）与 auto（runner onBeforeTurn 路径）统一：压缩开始时
向**活动区**推一行 `"compacting context…"`（M10 B 批 `setActivity` 机制，120ms ticker 已有），
结束清除。print/legacy 模式：保持现状 note 行为（print 字节契约不动，banner 已有）。

实现落点：

- 手动路：`/compact` 的 run 里，把 `▪ compacting…` note 替换为活动区行
  （`ctx.setActivity?.()` 存在才走新路，否则回退 note——legacy 兼容面与 queue 可视行同构）
- auto 路：runner `compactAndSplice` 成功路径前置活动区行。auto 触发点在 onBeforeTurn
  （无 renderer 契约），经 `options.renderer.note` 现有缝——新增 `setActivity?` 可选缝
  （存在才推，print 无感）

文案（pi 对照后定为 imp 风格）：`compacting context…`（统一一句，不抄 pi 的三态——auto
与手动的差异用户从上下文可辨，减少翻译负担）。

### 测试

- TUI e2e：`/compact` 后活动区出现该行、结束后消失（FakeTerminal 帧断言）
- legacy：note 字节不变（金样）

## 4. F3 — Ctrl+C 中止压缩

### 设计依据（为什么安全）

现状 `compactNow(signal?)` 签名预留但故意不转发（runner.ts:1052 注释引 design §7.4
"中止会持久化半截 checkpoint"）。**该理由已被后续批次推翻**：abort 质量门
（`compaction.ts`："summarizer aborted — incomplete, rejected"）保证中止流不落盘。
/tree 的分支摘要走的就是同一条链 + Ctrl+C 中止控制器（commands.ts:1240 先例，
review P1-3 的 abort 通道），已验证安全。

### 改动

- `/compact` 命令接线 onLongOpAbort 控制器（/tree 同款），Ctrl+C 中止摘要请求
- `runner.compactNow(signal)` 转发 signal（补上当年预留的接线），中止映射为
  `CompactOutcome` 新值 `"aborted"`——命令层 note `▪ compaction aborted — nothing changed`
- 状态机不动：/compact 本来就走 `state = "compacting"` 守卫（repl.ts:497），
  Ctrl+C 提示文案已在（"(compacting — press Ctrl+C again to force quit)"）
- auto-compact（onBeforeTurn）：**不接**——run 内部的压缩跟随 run 自身的 abort 信号
  （Esc 中断 run），不单独响应 Ctrl+C
- 设计文档 §7.4 的旧断言在本文件记录取代

### 测试

- 中止：summarizer 收到 abort → outcome aborted → 会话零改动（无 compaction 条目、
  history 不变）→ note 正确
- 完成路径不受影响（金样复跑）

## 5. F4 — bash 输出纪律

### 证据

74 次 bash、183k chars：median 1.1KB / p90 4KB / max 30KB / **零次撞 50KB 顶**。降单次
上限不解决问题（median 1.1KB 是模型选择的命令形状：全仓 grep、大段 sed 打印），改截断
只伤正常长输出（build/test 日志）。

### 设计（两手，都是提示词层）

1. **系统提示**：核心规则 4"Be concise"已有；在 bash 工具目录行（promptSnippet 后附加的
   guidelines 区，即 prompt-audit P5 的目录机制）加一条 routing 级引导：

   ```
   - For searching and reading, prefer grep/read with narrow scope over broad
     bash pipelines; large tool outputs fill the context window quickly.
   ```

   （pi 的 addGuideline 机制同位置——system-prompt.ts:104-114 先例；英文，与目录区语言一致）

2. **截断注记教学**（bash.ts 输出尾部既有 note 扩一句）：截断发生时现有文案已教
   "read the temp file"；补教**预防**——`(tip: pipe through head/tail or grep to keep
   output small)`。只在截断时出现，零常态成本。

不做的：per-run 累积上限（新机制无 pi 先例）、自动把超大结果降级为文件引用
（display 通道的架构改动，超出本批）。

### 测试

- 系统提示金样更新（1223 字符基线 → 新基线，prompt-audit 钉子同步）
- 截断注记出现条件：截断才带 tip、不截断零字节
- 行为不测（提示词引导不写行为断言——pi 同类引导也无行为测试，写=伪测试）

## 6. 批次划分与流程

- 单批实现（四项耦合面小、测试面重叠在 compaction/repl 一带）
- 分支：feat/compaction-ux
- 设计评审（本文件，对抗性独立审查）→ 实现一轮 → 实现审查 → 合入
- 预计测试：+8~12（F1 ×5、F2 ×2、F3 ×2、F4 ×2）

## 7. 决策表

| # | 决策 | 理由 |
|---|------|------|
| D1 | F1 用 floor 参数而非 pi 的 null 方案 | imp footer 本来就是估算驱动；21k 估算比 ? 有用 |
| D2 | F2 不抄 pi 三态文案 | 一句统一，auto/手动从上下文可辨；减少文案面 |
| D3 | F3 不接 auto 路 | run 内压缩已随 run abort 走；单独 Ctrl+C 会与 Esc 中断语义打架 |
| D4 | F4 不降 50KB 上限 | 证据：零次撞顶；median 1.1KB；降限只伤 build/test 长输出 |
| D5 | keepRecentTokens 维持 20k | 用户未拍板；pi 同值；21k 是设计行为非 bug |

## 8. 风险

- F1 的 floor 在 fork/tree 切换时机的正确性（navigateTree 的 identity 守卫已防 stale
  session；floor 记录跟随同一守卫）
- F2 的 print 字节契约（活动区行只在 TUI 路激活，setActivity 缺席=零字节）
- F4 系统提示金样变化（1213→~1290 字符区间，prompt-audit 的 1223 钉子要同步换新值）
