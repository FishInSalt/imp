# Sliding-window concurrency for safe-tool chunks

Batch: `feat/sliding-window-concurrency`. Base: `main@f7f040e`.

## 0. Status

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
plan 才有）。与 `tool_settled` 同级：**显示专用**，tap 拦截，不进
Renderer/print/扩展/health/history。扩展事件面零变化（两 dispatch 站点
仍只认 `tool_end`）。

### 3.3 显示层（REPL tap + fold 行 + 计时）

- **REPL tap**（`repl.ts:744` 先例）：`tool_running` 分支，仅顶层。
  职责：a) 把对应调用行从 queued 升级 running（更新快照的 `startedAtMs`
  与状态），b) `pushActivity()`。
- **活动区快照**（`ActivitySnapshot`）每工具行增字段 `state:
  "queued" | "running"`，默认 running（串行路径与既有快照测试不变）。
  task 行同 `ActivityAgentLine` 增 state 字段；子行天然不涉及（子代理
  内部无 safe 工具，子行的 `tool_start` 语义不变）。
- **计时诚实**：fold 的 `running Ns` 文本由快照 `startedAtMs` 驱动
  （shell 120ms ticker 重算），预发后该戳在 `tool_start` 盖——**改为由
  `tool_running` 触发的 tap 写入**。fold 的 closing suffix
  （`#call-closing-status` 的 running 计时）同样由 tap 在 `tool_running`
  时通过 `setRunningSuffix` 更新为从执行起点计。
- **caption 差异**：queued 行 caption `└─ queued`，running 行沿用现状
  `└─ running Ns`。行通道完全复用 `#tool-inline-live-rows`/
  `#call-closing-status` 机制（`setCallLiveRows` / `setRunningSuffix`），
  仅新增枚举值。

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

UI 层（`test/repl-tui.test.ts` / `test/repl-fold.test.ts`）：

11. 预发后 queued→running 升级：断言行 caption 与计时起点。
12. fold closing suffix 由 tool_running 更新（queued 期间 suffix 空）。
13. task 行（activityAgents）queued 态与升级。
13b. **红测试**：两个 task 并发（均运行中）+ 第三个排队：快照中前两个
   state=running、第三个 state=queued 且 caption `└─ queued`；第三个的
   tool_running 到来前 running 计时为空/不启动——波次下第三行不存在
   （其 tool_start 未发），此断言必红；窗口下必绿。

## 5. 风险

1. **事件序承诺的清晰化**：phase 3 从 "每 chunk 后" 变 "前缀冲刷"——
   承诺本身未变（tool_end 呼叫序），但 print 下 interleaving 更细。corpus
   更新 + 两次运行一致性断言钉住。
2. **`tool_running` 是新事件类型**：走 health/tool_settled 已验证的
   "显示专用" 通道，tap 分支 2→3。税：tap 复杂度；换：排队可见性 +
   计时诚实。
3. **potentially large chunks**：模型一次发 20+ task——phase 1 预发 20
   头 + 20 次门禁串行。门禁本就是串行逐个（今天分波亦然），故唯一的
   新暴露是 20 确认框同弹（pendingAsks FIFO 已支持）与 20 头同屏。接受；
   cap 与配置面维持 non-goal。
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

1. 门禁预评估（本设计 §3.1）是否引入新的滥用面（如 7 个确认同弹的
   UX）——pendingAsks FIFO 已支持，倾向接受。
2. 前缀冲刷 vs 等全体：本设计选前缀冲刷（print 收益），若评审认为
   print 形状漂移过大可退为等全体（实现删一行）。
3. `tool_running` 的命名：备选 `tool_exec_start`、`tool_dispatch`。
4. queued caption 文案：`└─ queued`（无计时）。
5. 是否重命名常量（§5.5）。

## 7. Test plan 内联锚点

- `test/loop-concurrency.test.ts`：1-10。
- `test/repl-tui.test.ts` / `test/repl-fold.test.ts`:11-13b。
- 回归：system-prompt、render、subagent corpus。

## 8. Review log

（待评审）
