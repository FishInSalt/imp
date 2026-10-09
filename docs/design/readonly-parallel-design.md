# 只读工具并行化(roster 扩展 + catalog 披露 + queued 行显示)

- 状态:draft(待评审)
- 前置:sliding-window-concurrency-design.md(已实现,merged `83e7f9d`);
  abort-grace-design.md §6b.2 已关闭(keep-alive × SIGINT 系 fixture
  假象——宽限机制在双血统下验证完整);grace re-baseline 批
  (merged `c920aae`)。
- 批次:feat/readonly-parallel
- 关联:sliding-window 设计 §2 non-goal 7(roster 不扩)与 §3.3
  caption 条目(非 task queued 行随本批落地)——本批就是该设计的
  预定后续。

## 0. 问题与目标

`concurrencySafe` 机制(滑动窗口、前缀冲刷、abort 宽限、queued 行、
`tool_running`/`tool_settled` 显示事件)已全部就绪,但 roster 上只有
`task` 一个成员。四个只读工具(`read`/`grep`/`find`/`ls`)是 agent 的
高频操作(单轮多读/多搜是常态),串行执行是纯时延浪费。本批:

1. **roster 扩展**:`read`/`grep`/`find`/`ls` 标 `concurrencySafe: true`;
2. **系统提示披露**:catalog 区渲染一行派生的并行规则(safe 名单 ≥2 时);
3. **queued 行显示**:sliding-window §3.3 预留的非 task `└─ queued`
   caption 路径落地(本批 roster 扩展后该路径可达);
4. 文档同步:transcript.ts:108 过时注释、两份设计文档的 roster 引用。

### Non-goals

1. 不改 `MAX_CONCURRENT_SAFE_CALLS = 5`(常量与值均不动)。
2. 不动串行路径、门禁语义、事件契约(一切既有承诺照旧)。
3. 不动 abort 宽限(roster 扩展自动受益,无代码变化)。
4. 不做批量确认("approve all N",sliding-window §6.1 已押后)。
5. 不动 MCP bridge / 扩展工具的 concurrencySafe(第三方工具安全自证
   不在本批;机制不变,后续按需)。

## 1. 决策记录(已与用户对齐的结论)

### 1.1 披露通道:catalog 区派生行,单一事实源

**结论**:并行规则一行渲染在 `# Available tools` 清单块**内部**(清单
条目之后、"In addition…" 句之前),由工具数组的 `concurrencySafe ===
true` 成员名单**派生**;**≥2 个时渲染**(单成员教不出并行,且措辞悬空)。
渲染门与 catalog 一致(清单空则整段含并行行都不渲染——同一条件变量)。

**理由**:
- 机制触发器是"模型在同一条 assistant 消息里发出多个工具调用",模型
  看不到 `concurrencySafe` 标记——不教,并行度完全依赖模型自发批处理
  倾向。业界先例:Claude Code 系统提示的 "make all of the independent
  calls in the same block" 条款,存在即证据。
- 规则作用域恰是 catalog 名单(它只对清单内 safe 工具成立,而清单是
  每会话派生的);放清单旁随数据走,放核心规则区则成为静态模板与名单
  脱钩。
- override 语义自洽:`SYSTEM.md` 覆盖时 catalog 连并行行一起消失——
  自定义提示作者接管工具教学;机制正确性不依赖披露(非 safe 严格串行
  是构造保证),丢的只是批处理鼓励,与今天 task 无披露同级。
- 成本:一行 ~25 token,对比 per-tool 描述 ×N 重复。
- 漂移:单一事实源(标志),行自动随 roster 变化;不硬编码名单。

**措辞(草案,评审可改)**:

```
When several of the tools above (read, grep, find, ls, task) have no
dependencies between them, issue all the independent calls in one
message — they run concurrently. Dependent calls must wait for the
previous results.
```

名单部分程序化拼接;括号仅在名单 ≤6 时渲染,>6 时省略(防 token 膨胀;
当前名单 5 个)。

### 1.2 已考虑并否决的备选通道

- **工具 description 尾注**:每次请求 ×5 重复;撞 MCP 描述预算管理方向
  (prompt-audit P7 的 2048B 降级);并发性是一组工具间的关系 + 消息组装
  规则,不是单工具属性——单点 description 在决策点信息不完整(模型读
  read 的描述仍不知 grep 安全、不知该合并);手写散文与标志脱钩风险。
  唯一优势:override 场景下 description 随工具数组幸存。不翻盘:机制
  不依赖披露。记档备选。
- **参数 description**:并发性与任何参数无关,塞进去是误导性噪音。否决。
- **核心规则区硬编码**:见 §1.1 override/漂移论证。

### 1.3 不教的都别教

上限 5(超发只是排队)、结果按呼叫序返回(对模型不可见)、safe 调用需
相邻(微观管理)——均不披露。过度批依赖调用是唯一风险,措辞的
"no dependencies" + "must wait" 覆盖;即使过批,非 safe 按呼叫序严格
串行,正确性由构造保证。

## 2. 变更清单

### 2.1 roster 标记(4 个布尔)

`src/core/tools/read.ts`、`grep.ts`、`find.ts`、`ls.ts`:各加
`concurrencySafe: true`,行内注释指向本设计。types.ts:104-108 的
jsdoc 已覆盖语义,不改。

### 2.2 catalog 渲染(system-prompt.ts)

`buildSystemPrompt`(`src/core/system-prompt.ts:37`):

- 签名不变——`PromptCatalogTool` 增可选 `concurrencySafe?: boolean`
  (interface 扩展,调用方 runner.ts:735-738 的 catalogTools 传的是
  `this.tools`(已是 Tool[],含该字段)——**实际是零适配**:接口加字段
  即可,runner 无改动。核对点:mcpCatalogEntries(bridge.ts)产出的
  条目不含该字段(undefined)→ 不进名单,正确(第三方工具未自证)。
- 渲染逻辑:catalog 块内部,清单行后追加规则行(名单从同一数组派生,
  **列出的 safe 名单 = 有 snippet 的 safe 工具**——无 snippet 的 safe
  工具不列,避免悬空引用;≥2 才渲染)。
- override 分支不动(返回 override 时本就不含 catalog)。

### 2.3 queued 行显示(shell.ts + repl.ts)

sliding-window §3.3 caption 条目的落地:

- **现状**:非 task 工具行只有 closing suffix(裸 `Ns`),无 live 行;
  task 行有 `└─ pending #N`/`└─ queued`(queued 枚举已在 #task-inline-live-rows
  落地,shell.ts:785-787)。
- **本批**:`renderActivity` 为 `state === "queued"` 的非 task 工具行生成
  live 行 `└─ queued`(无计时);running 态的既有字节完全不动。路径
  复用 `#call-closing-status` 的快照推导,仅新增枚举值——与该设计
  §3.3 预留描述一致。
- REPL tap 无新事件消费(`tool_running` 升级路径已就绪);`repl.ts:1302`
  的 `queued` 标记按 `concurrencySafe` 派生,roster 扩展自动生效,零改。
- 计时规则:queued 行不生成 closing suffix——**双循环都要跳过**(非
  task 的 nextSuffixes 与 task 的 taskStarts;本批只涉及非 task 行,
  task 循环不动)。
- middle-refusal 显示漂移(sliding-window §3.6.1 已记档)在本批成为
  可达场景:被拒绝的 safe 行以 queued 态挂起直到 tool_end 冲出。接受,
  与该设计已记档漂移同类;本批不改(长期修复仍是 refusal 终态化事件)。

### 2.4 文档/注释同步

- `src/repl/transcript.ts:108`:"Concurrency-safe calls (only `task`)"
  → 措辞改为不点名 roster("concurrency-safe calls")。
- `docs/design/sliding-window-concurrency-design.md`:§2 non-goal 7
  加一行"(后续批次已落地:只读工具并行化设计,见 readonly-parallel)"
  (不改原文语义,加指针)。
- abort-grace-design.md:§6b.2 关闭段已有"前置已满足"措辞,不动。

## 3. 已核对的安全性(事实,非断言)

- 四工具 execute 均为无共享可变状态:read/ls 纯 fs 异步;grep/find 走
  `runSearch`(每调用独立 spawn、局部 Buffer、BUFFER_GUARD 1MB/调用);
  共享的只有 `bin-detect` 缓存(幂等探测,Promise 缓存并发安全)。
- `readFile` 传 `signal`(read.ts:83)——abort 传播就绪;grep/find 的
  `runSearch` 收 signal(kill 路径);ls 无 IO 长驻。宽限机制自动覆盖。
- 子代理路径无涉:child runner 的 loop 与父同源,子会话内这四个工具
  标记相同——`getToolsForChild` 的 worktree 分支(runner.ts:589-597)
  重建的七内置含这四个工具,标记随工具对象走,行为一致。核对点已列入
  §4 测试(子会话 read 并行冒烟)。
- 事件契约:batching 由连续 safe 段决定,前缀混排(read+bash+read)
  今天已可达且已测(loop-concurrency 既有用例);本批只是让真实工具
  进入该路径。

## 3b. 显示通道核对(sliding-window §3.3 的引用锚点已逐一重核)

- `repl.ts:1290-1330` tool_start 分支对 safe 调用置 `queued`(快照),
  task 与非 task 两态皆备;
- `shell.ts:785-787` task 行 queued 枚举已落地;非 task 行是本批新增;
- `transcript.ts:104-115` fold anchor 按 id 归位,与串行无关,不动;
- 计时单写者模型(renderActivity 从快照推导)不动,本批只加非 task
  queued 枚举值。

## 4. 测试计划

loop 层(`test/loop-concurrency.test.ts` 增补):

1. **roster 单元**:四个工具对象的 `concurrencySafe === true`(防回归
   的存在性断言,一眼可读)。
2. **真实工具并行冒烟**:scripted provider 发 `[read a, read b, grep c,
   find d]`(小 fixture 文件),断言:总耗时 < 串行和(时间采样或并发
   观测点)、tool_end 序 = 呼叫序、durationMs 各自不含排队。
3. **abort**:并行 read 段中 abort → 已启动者走宽限/合成,未启动者
   无事件;复用既有 grace 用例形状,工具换成真 read。

系统提示层(`test/system-prompt.test.ts` 增补):

4. **渲染**:含 ≥2 safe snippet 工具时,规则行出现且名单正确(读、
   grep、find、ls、task);
5. **门槛**:仅 1 个 safe 工具(如只有 task)→ 无规则行;
6. **门**:无 snippet 工具(全空)→ 无 catalog 无规则行;
7. **override**:override 模式 → 无规则行(catalog 整体消失)。

显示层(`test/repl-tui.test.ts` / `repl-fold.test.ts` 增补):

8. **非 task queued 行**:5+1 个 safe 调用(6 个 gated read 替代——
   gated 工具测试里即 safe read fixture),前 5 running、第 6 行渲染
   `└─ queued`、无 closing suffix;第 6 个 tool_running 到来后升级
   (suffix 从执行起点计)。
9. **middle refusal 漂移**(\$3.6.1 可达性):中位拒绝行显示 queued
   直到 tool_end——现状钉子(标注"接受为记档漂移"),防止未来无声
   改变。
10. **print 字节**:print 模式 chunk 输出 corpus 更新(真实工具段
    形状:4 头 + 呼叫序尾),两次运行一致断言保留。

回归:全量 vitest、biome、双 tsconfig、build;sliding-window /
abort-grace 设计文档引用的既有测试全绿。

## 5. 风险

1. **批处理率不确定**:披露只是鼓励,模型可能仍逐个发。缓解:无——
   措辞评审 + 观察期;机制收益不依赖单模型行为,不做 A/B 承诺。
2. **并行 grep/fd 资源占用**:5 并发 rg 在大树上 CPU 峰值 ×5。缓解:
   上限 5 不变;BUFFER_GUARD 每调用独立;无计划改。
3. **显示形状变化**:print corpus 更新(4 头连续);非 task queued 行
   是新增可见表面。接受并记档(§4.10 钉住)。
4. **middle-refusal queued 挂起**:已记档漂移(sliding-window §3.6.1),
   本批使其可达,钉子测试固定现状。
5. **测不到的**:模型真实批处理行为(集成层)——不在本批验收,记为
   观察项。

## 6. 评审待决点

1. 措辞草案(§1.1)——英文文案、名单呈现方式(括号 ≤6 个)。
2. 规则行位置:清单条目后、块内(vs 块尾独立小节)。
3. §4.2 并行冒烟的并发观测方式:时间采样(墙钟)vs 注入观测点——
   倾向时间采样 + 宽松下界(避免新观测点),评审定。
4. 测试 8 的 safe read fixture 形状(gated read vs 真实慢读)。

## 7. Review log

(待评审)
