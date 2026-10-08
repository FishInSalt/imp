# Sliding-window concurrency for safe-tool chunks

Batch: `feat/sliding-window-concurrency`. Base: `main@f7f040e`.

## 0. Status

DESIGN REV 2 — round 1 findings folded (NEEDS-FIXES → 待确认复评).

DESIGN DRAFT — 待独立评审（对抗性、新上下文）。实现未开始。

## 1. Problem

`executeToolBatch`（`src/core/loop.ts:443`）把一个极大连续段切成
`MAX_CONCURRENT_TASKS = 5` 的**静态波次**（`loop.ts:471-476`），波次之间串行
衔接。时长不均的批付出 convoy 代价：straggler 所在波之后每一波的最大值，
本可与 straggler 重叠执行，却被串行在后面。例（分钟）：`[60, 10×6]` →
波次 70 vs 窗口 60；`[60, 10×24]` → 波次 100 vs 窗口 60。子代理时长是
重尾分布，这是 flagship 场景。批 ≤5 或时长均匀时两方案无差别。

第二症状：第 6 个起的调用在 UI 上不可见——`tool_start` 属于各波次的
phase 1，排队调用要等整波排空才首次出现在屏幕上。

## 2. Goal / non-goals

**Goal.** 连续段内 safe 调用改为有界并发滑动窗口（信号量式）：任意时刻
≤5 在跑，槽位释放即按呼叫序 FIFO 启动下一个调用。消除 convoy 代价；
排队调用从启动起可见。

**Non-goals.**

1. 不改结果顺序：`tool_end` 与 results 数组仍按呼叫序（既有契约）。
2. 不改 `MAX_CONCURRENT_TASKS = 5`、不加配置面。
3. 不做重排（短任务优先、优先级）——违反呼叫序发射契约。
4. 不动串行路径、门禁语义（M5 评审 #3 的串行呼叫序评估保持）。
5. 不动 `tool_settled`/`durationMs` 语义（排队时间不入时长——结构保证）。
6. 不做 loop 级单调用 hang 兜底（abort 宽限期）——独立后续批次。
7. 不改 `concurrencySafe` 名单（只读工具标 safe 是后续批次）。

## 3. Design

### 3.1 执行模型（loop.ts）

`executeToolBatch` 的 chunk 循环删除；`executeChunk` 改为接收**整个连续
段**（不再按 5 切片），内部三阶段：

- **Phase 1 — 全段预发**：按呼叫序，每个调用发 `tool_start`、跑校验、
  跑门禁（`await`，串行，呼叫序）。产出 plans（立即结果或待执行）。
- **Phase 2 — 滑动窗口**：plans 中待执行者进入 FIFO 队列。初始 ≤5 个
  启动（各自 emit `tool_running`）；任一 settle 后补位启动队头下一个
  （同样先 emit `tool_running`）。启动用 `clock()` 盖起点戳，settle 处
  计 `durationMs`、emit `tool_settled`（完成序）。
  **顺序约束（MINOR-2）**：`tool_running` 的 emit（及 REPL tap 对
  `startedAtMs` 的重写）必须先于 `plan.run()` 调用——子代理 source 行
  继承父行 `startedAtMs`（repl.ts:1246）、task 计时基线取各源最小值
  （shell.ts:795-800），旧戳先暴露给子事件会让 min() 永远取含排队时间
  的旧值。
- **Phase 3 — 前缀冲刷**：游标初始指向段首。任一调用 settle 后，把
  **已连续 settle 的最长前缀**立即 emit `tool_end` 并 push 进 results。
  非前缀的 settle 由 `tool_settled` 承担显示更新（既有语义），其
  `tool_end` 等待前缀推进。

防饿死性质（无需新机制）：因为 phase 2 是 FIFO 补位、phase 3 游标只向
前，任一 settle 都同时推进游标可用的最长前缀——存在一个由剩余调用数
严格递减的势函数，任意交错下段必然有限步内排空。不存在“后面先完但
`tool_end` 永不发射”的交错。

abort 检查保留在两处：phase 1 每调用循环内（未启动者不发事件，
`fillMissingToolResults` 合成），phase 2 每次补位启动前（排队者不启动、
不合成未启动的执行结果——已 settle 但未冲刷前缀者仍按前缀序冲出）。
已启动调用靠 AbortSignal 让工具自行 settle（既有语义）。

### 3.2 `tool_running` 显示事件

新 AgentEvent 成员：`{ type: "tool_running"; toolCallId: string }`。在
槽位获取、真正开始执行的瞬间发出（完成无关；只有已批准且已过门禁的
plan 才有）。与 `tool_settled` 同级：**显示专用**。REPL tap 拦截；print
模式下它直接到达 `Renderer.event`（cli.ts:1079 无 tap）——靠 default
分支 no-op（render.ts:173-176）兼底，与 `tool_settled` 同路径（非
"不进 Renderer"，见 tool-settle-design.md §5 的准确先例）；不进扩展
（两 dispatch 站点仍只认 `tool_end`）、health、history。扩展事件面零
变化。

**计时归因注（NIT-1）**：`durationMs` 是 loop 在 settle 处盖的
（loop.ts:539），非工具自带；所有经 chunk 执行路径 settle 的调用都带
它，故 sink 回退窗口（entry.startedAt）对 chunk 路径不可达。例外：
`failToolCallsFromTruncatedMessage`（loop.ts:336-346）的 tool_end 无
durationMs、回退可达——该路径本设计不改，行为不受影响。

### 3.3 显示层（REPL tap + fold 行 + 计时）

- **REPL tap**（`repl.ts:744` 先例）：`tool_running` 分支，仅顶层。
  职责：a) 把对应调用行从 queued 升级 running（重写快照行的
  `startedAtMs` 为执行起点、state 置 running），b) `pushActivity()`。
  tap **不直写 transcript**——suffix/live 行通道是单写者（renderActivity
  每 120ms 从快照重建），直写会被下一次 tick 覆盖。
- **活动区快照**（`ActivitySnapshot`）每工具行增可选字段 `state?:
  "queued" | "running"`，缺省 running（串行路径与既有快照测试不变）。
  `startedAtMs` 保持必填：queued 行写入 tool_start 时刻戳（仅作行序
  占位，不驱动计时）。task 行同 `ActivityAgentLine` 增可选 state 字段；
  子行天然不涉及（子代理内部无 safe 工具，子行的 `tool_start` 语义
  不变）。
- **计时诚实（单写者模型下）**：closing suffix 与 live 行的计时全部由
  `renderActivity` 从快照推导。规则：`state === "queued"` 的行**不生成
  closing suffix**（shell.ts:755-756 的 nextSuffixes 跳过 queued id），
  live 行渲染 `└─ queued`（无计时）；tap 在 `tool_running` 时重写
  `startedAtMs` 后，下一次快照推送/tick 自然从执行起点计。现状字节核
  对：非 task 行 closing suffix 是裸 `Ns`（`#call-closing-status` A1.1
  移除了 `└─ running` chrome，shell.ts:719-722）；task fold live 行是
  `└─ pending #N <agent>`（shell.ts:778）。本设计的 queued 态是这两个
  通道上的新枚举值，不改 running 态的既有字节。
- **caption 差异**：queued 工具行 caption `└─ queued`；task queued 行
  `└─ pending`。行通道完全复用 `#tool-inline-live-rows`/
  `#call-closing-status` 机制（`setCallLiveRows` / `setRunningSuffix`）
  的快照推导路径，仅新增枚举值。

### 3.4 行为漂移（接受并记档）

1. **门禁快照时点**：状态型扩展的计数/审计在门禁时刻看到的快照从
   "每波 t=n" 变为 "全程 t=0"。方向是更确定而非更乱。
2. **print 输出形状**：7 调用从 "5头5尾+2头2尾" 右移为 "7头 + 呼叫序
   尾"（前缀冲刷下尾可以边完成边落行）。每次运行仍逐字节确定；corpus
   按新形状更新，另加一条 "两次运行输出一致" 断言。
3. **混合序列** `[task×5, bash]`：bash 仍等整段——呼叫序语义，不在本批。
4. `[read, task]`（safe 调用排在非 safe 后）今天已并行段外，行为不变。

### 3.5 否决备选

- **槽位获取时再发 `tool_start`**：可见性收益归零。
- **`tool_queued` 事件 + 推迟 start**：fold 创建走新路径、start 前后语义
  分裂。
- **短任务优先/重排**：违反呼叫序发射契约。
- **abort 宽限期**：独立后续批次（hang 兜底与窗口正交）。

## 4. 测试计划

loop 层（`test/loop-concurrency.test.ts` 扩展）：

1. `[60, 10×6]`（delay 注入）：总耗时 ≈60 而非 70（伪时钟或时间采样断
   言）；第 6 个调用的 `tool_running` 早于第 1 个的 `tool_end`。
2. FIFO：5 个槽位释放顺序乱序（gated tools 乱序开闸），补位启动顺序
   仍为呼叫序。
3. 前缀冲刷：completion 序 [b,a,c]（a 为索引 1）→ tool_end 序 [a,
   b, c]：b 完成时游标未越 a，a settle 后 b、c 连续冲出。
4. 事件序：全段 `tool_start`(7) 先于任何 `tool_running`；`tool_running`
   先于对应 `tool_end`；refusal（校验/门禁拒绝）无 `tool_running`。
5. abort mid-chunk：已启动未 settle → `(interrupted...)` 不发；已 settle
   未冲刷 → 前缀冲出；排队未启动 → 无事件 + 合成结果。
6. 时长：queued 20s + run 5s → durationMs ≈5s（不含排队）。
7. 事件面零变化：`ExtensionRegistry` 侧跑一遍 chunk，`emitToolEnd` 计数
   与调用数一致（不 fire `tool_call` 二次）。
7b. **语义差异红测试**（新增）：段 `[a,b,c,d,e,f,g]`，gated 乱序完成
   [c,b,d,e,f,a,g]→ a 为游标阻塞点——断言 f 完成时 g 仍无 tool_end，
   a settle 后前缀 [a,b,c,d,e,f] 依序冲出、g 紧随；并断言 f 的启动
   （tool_running）早于 a 完成——波次下 f 必须等 wave1 排空，这条在
   波次实现下必红，窗口下必绿。
8. 门禁呼叫序（既有 order-recording gate 测试保持绿）。
9. print 模式：chunk print 输出两次运行一致；corpus 更新。
10. 相邻波次（consecutive-run batching）既有测试：形状变化后修正预期。
    特别地，"chunk cap 5" 用例（断言"释放一个调用不启动第 6 个"的
    波次反属性）需**重写**为窗口语义（FIFO 补位：释放即启动），不是
    修正预期能覆盖的。

UI 层（`test/repl-tui.test.ts` / `test/repl-fold.test.ts`）：

11. 预发后 queued→running 升级：断言行 caption 与计时起点。
12. fold closing suffix 由 tool_running 更新（queued 期间 suffix 空）。
13. task 行（activityAgents）queued 态与升级。
13b. **红测试（MAJOR-2 修正后的场景）**：6 个 safe 调用（6 个 gated
   task，或 5 个占槽 + 1 个）：前 5 个 state=running、第 6 个
   state=queued 且无 closing suffix；第 6 个的 `tool_running` 到来前其
   计时不启动——波次下第 6 行不存在（其 tool_start 未发），此断言必
   红；窗口下必绿。（3 个 safe 调用无论哪种实现都全部立即启动，不能
   构成区分场景。）

## 5. 风险

1. **事件序承诺的清晰化**：phase 3 从 "每 chunk 后" 变 "前缀冲刷"——
   承诺本身未变（tool_end 呼叫序），但 print 下 interleaving 更细。corpus
   更新 + 两次运行一致性断言钉住。
2. **`tool_running` 是新事件类型**：走 health/tool_settled 已验证的
   "显示专用" 通道，tap 分支 2→3。税：tap 复杂度；换：排队可见性 +
   计时诚实。
3. **potentially large chunks**：模型一次发 20+ task——phase 1 预发 20
   头 + 20 次门禁串行。门禁本就是串行逐个 `await`（loop.ts:505-514），
   确认框是**逐个串行出现**而非同弹（第 N+1 个 confirm 在第 N 个
   resolve 后才发起；pendingAsks FIFO 只服务并发子代理的子提问，与本
   路径无关）。真实新暴露：20 个串行阻塞确认全部前置在任何执行之前
   （今天波次间至少有波 1 的执行穿插）与 20 头同屏。接受并记档；批量
   确认（"approve all N"）是可能的后续优化，不在本批。
4. **打印头集中**：print 下 20 头连续（不再 5-5 分组）——每一次运行仍
   确定，corpus 更新。交互模式 live 行会缓解观感。
4b. **声明的非目标**：本批不解决 straggler 阻塞游标（a 未完则 b 的
   tool_end 不发）——这是呼叫序契约的固有代价；`tool_settled` 显示
   更新仍实时。
5. **命名**：`MAX_CONCURRENT_TASKS` 名不副实（cap 所有 safe 调用）。
   顺手重命名 `MAX_CONCURRENT_SAFE_CALLS`，纯机械，单 commit。
6. `prepareToolCall` 需标注 phase 2 的启动序 = 呼叫序（FIFO）——注释钉
   死，防未来"优化"成乱序补位。

## 5b. 并发正确性论证

**安全性**：窗内任意时刻执行中的调用 ≤ cap。初始启动 ≤5；此后每次启动
都由一次 settle 触发（settle 使在跑数 −1，启动 +1），不变量维持。FIFO
队列上无并发写竞争（JS 单线程，事件序确定）。

**活性**：每个 settle 事件推进两个游标（发射游标单调向前；FIFO 队头
出队）。若剩余未 settle 调用 >0 且窗非空，最短剩余时长者必 settle，
触发补位与游标重估——在剩余调用数严格递减的势函数下，段必然有限步内
排空。不存在队头已 settle 而游标停住的交错（前缀冲刷在每次 settle 后
立即重估）。

## 6. 评审待决点

1. 门禁预评估（本设计 §3.1）：真实代价是 §5.3 记档的串行前置确认
   （非同弹）。接受预评估（保持串行呼叫序门禁的评审结论 #3）；若未来
   UX 反馈强烈，批量确认是独立后续。
2. 前缀冲刷 vs 等全体：本设计选前缀冲刷（print 收益），若评审认为
   print 形状漂移过大可退为等全体（实现删一行）。
3. `tool_running` 的命名：备选 `tool_exec_start`、`tool_dispatch`。
4. queued caption 文案：`└─ queued`（无计时）。
5. 是否重命名常量：采纳（机械重命名 `MAX_CONCURRENT_SAFE_CALLS`，
   单独 commit）；§2 non-goal 2 指值不变（5），与重命名无冲突。从待决
   点转为已决。

## 7. Test plan 内联锚点

- `test/loop-concurrency.test.ts`：1-10。
- `test/repl-tui.test.ts` / `test/repl-fold.test.ts`:11-13b。
- 回归：system-prompt、render、subagent corpus。

## 8. Review log

**Round 1 — 独立对抗评审（新上下文，2026-10-08），verdict NEEDS-FIXES。**
核心调度设计（滑动窗口、前缀冲刷、abort 闭合、事件面零变化）经逐行
源码验证为健全（0 blocker）。4 个 MAJOR 全部折叠进本文档：

- MAJOR-1（closing suffix 单写者冲突）：§3.3 重写为单写者模型——tap 只
  重写快照 startedAtMs，不直写 transcript；state 为可选字段，queued 行
  不生成 suffix。
- MAJOR-2（测试 13b 场景不可能）：改为 6 调用场景（5 running + 1
  queued）；3 个 safe 调用在两种实现下都全部启动，不能构成区分场景。
- MAJOR-3（不存在的 `└─ running Ns` caption）：按真实表面重述（裸 `Ns`
  suffix、task 行 `└─ pending #N`）。
- MAJOR-4（"确认同弹"前提错误）：确认是串行逐个、全部前置；风险 3 与
  待决点 1 重写；批量确认为后续可选。

MINOR/NIT 一并折叠：MINOR-1（print 无 tap，"不进 Renderer"改为
"到达 Renderer 但 default no-op"，补测试断言）；MINOR-2（tool_running
emit + tap 戳重写必须先于 plan.run，写入 §3.1 顺序约束）；MINOR-3
（"chunk cap 5" 用例需重写为窗口语义，写入 §4.10）；MINOR-4（重命名
待决点矛盾，§6.5 转已决）；NIT-1（durationMs 是 loop 盖的、非工具自
带；truncated-refusal 路径例外且不受本批影响——写入 §3.2 注）。
评审另确认：(a) terminal guard + trackActivity 幂等使 settle+权威
end 双到达安全；(b) print 字节确定性成立；(c) abort 语义无洞；(d)
registry emitToolCall 链无状态，t=0 快照仅影响异型门禁（§3.4.1 已记
档）；(e) FIFO 补位 + 游标活性论证成立。

（待评审）
