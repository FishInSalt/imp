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

**措辞(评审建议稿采纳——主语从工具改为调用、消除 "in one message"
与 "previous" 的指代歧义)**:

```
Several of the tools above (read, grep, find, ls, task) can run
concurrently. When you need several of these calls and they are
independent of each other, make all of them in the same message.
A call that depends on an earlier result must wait for that result.
```

**精确字节(NIT-4,评审定)**:规则行渲染为清单后**一个空行 +
非 bullet 的三句段落**(无 `- ` 前缀、按上述换行断行、名单括号
内逗号分隔、句点结尾)。名单部分程序化拼接;括号仅在名单 ≤6 时
渲染,>6 时省略(防 token 膨胀;当前名单 5 个;>6 分支见 §4.7c)。

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

`buildSystemPrompt`(`src/core/system-prompt.ts:36`):

- 签名不变——`PromptCatalogTool` 增可选 `concurrencySafe?: boolean`
  (interface 扩展,调用方 runner.ts:735-738 的 catalogTools 传的是
  `this.tools`(已是 Tool[],含该字段)——**实际是零适配**:接口加字段
  即可,runner 无改动。核对点:mcpCatalogEntries(bridge.ts)产出的
  条目不含该字段(undefined)→ 不进名单,正确(第三方工具未自证)。
- 渲染逻辑:catalog 块内部,清单行后追加规则行(名单从同一数组派生,
  **列出的 safe 名单 = 有 snippet 的 safe 工具(safe∩snippet)**——
  无 snippet 的 safe 工具不列也不计数,避免悬空引用;**计数口径统一
  为名单(safe∩snippet)≥2 才渲染**,评审 MINOR-1:分叉只可能来自
  合成工具,§4.7c 用合成夹具钉死)。
- 扩展工具若标 safe 且有 snippet 会进名单——**有意行为**(机制上
  `this.tools` 含扩展工具、无字段剥离,评审核实走得通;本批不标任何
  扩展工具,但名单是开放的)。
- override 分支不动(返回 override 时本就不含 catalog)。

### 2.3 queued 行显示(shell.ts + repl.ts)

sliding-window §3.3 caption 条目的落地:

- **现状**:非 task 工具行只有 closing suffix(裸 `Ns`),无 live 行;
  task 行有 `└─ pending #N`/`└─ queued`(queued 枚举已在 #task-inline-live-rows
  落地,shell.ts:785-787)。
- **本批**:`renderActivity` 为 `queued === true` 的非 task 工具行生成
  live 行 `└─ queued`(无计时);running 态的既有字节完全不动。
  **通道澄清(评审 MAJOR-2a)**:caption 走 **live 行通道**
  (`nextLiveRows` → `setCallLiveRows`),与 task 行先例同通道
  (shell.ts:784-798),**不是** closing-suffix 通道——sliding-window
  §3.3 原文的"复用快照推导"指快照→行的推导方式,非 suffix 通道。
  具体落点:`for (const tool of this.activity.tools)` 循环内
  (shell.ts:756-760),`tool.queued === true` 时
  `nextLiveRows.set(tool.id, ["└─ queued"])`(running 态不进
  live 行,现状不变)。
- **选择器(D10)交互(评审 MAJOR-2b,已决)**:非 task 工具的
  closing-suffix 循环包在 `if (this.selector === null)` 守卫内
  (shell.ts:753,D10 原则"picker 打开期间不绘制任何工具行,running
  声明会为假")。本批的 queued live 行**随 task 行先例豁免该守卫**
  (task/agent 行绘制在守卫外):`└─ queued` 不做 running 声明、无
  计时,"等待槽位"在 picker 打开期间依然为真,且与 task 行
  `└─ queued`(守卫外)通道对称。§4.9b 加 D10 场景测试。
- REPL tap 无新事件消费(`tool_running` 升级路径已就绪);`repl.ts:1302`
  的 `queued` 标记按 `concurrencySafe` 派生,roster 扩展自动生效,零改。
- 计时规则:queued 行不生成 closing suffix——**已就绪,本批无改动**
  (shell.ts:759 `if (tool.queued !== true)` 与 :767-772 `agentQueued`
  守卫在 sliding-window 批已实现;评审 NIT-3)。
- middle-refusal 显示漂移(sliding-window §3.6.1 已记档)在本批成为
  可达场景:被拒绝的 safe 行以 queued 态挂起直到 tool_end 冲出。接受,
  与该设计已记档漂移同类;本批不改(长期修复仍是 refusal 终态化事件)。

### 2.4 文档/注释同步

- `src/repl/transcript.ts:108`:"Concurrency-safe calls (only `task`)"
  → 措辞改为不点名 roster("concurrency-safe calls")。
- `src/repl/repl.ts:742-743` 注释 "Top-level only: children have no
  concurrency-safe tools" 在本批后为**假**(子会话 pool 含四工具,
  子 loop 会发射 child 源 tool_running,经 task.ts 回流父端;行为无恙
  ——tap 的 `if (info === undefined)` 守卫已正确忽略 child 源事件
  ——评审 MINOR-3):注释改为不依赖 roster 断言。同理核对
  repl.ts:1298-1301 的注释措辞。
- `docs/design/sliding-window-concurrency-design.md`:指针加在 **§0
  Status 头部**(活性头部,本就跟踪后续;评审 MINOR-6:已合入批次
  的批准正文(§2 non-goal 7、§3.3 caption 条目)不原地改,一处
  指针,不两处)。
- abort-grace-design.md:§6b.2 关闭段已有"前置已满足"措辞,不动。

## 3. 已核对的安全性(事实,非断言)

- 四工具 execute 均为无共享可变状态:read/ls 纯 fs 异步;grep/find 走
  `runSearch`(每调用独立 spawn、局部 Buffer、BUFFER_GUARD 1MB/调用);
  共享的只有两个 promise 缓存:`bin-detect` 的探测缓存
  (bin-detect.ts:4)与 read 图像路径的 photon 模块缓存
  (`src/core/image/photon.ts:16-18` 的 `photonModule`/`loadFailed`/
  `loadPromise`——评审 MINOR-2:均为幂等、并发安全)。
- `readFile` 传 `signal`(read.ts:82)——abort 传播就绪;grep/find 的
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
3. **abort**(评审 MINOR-7 修正措辞):并行 read 段中 abort → 真 read
   尊重 signal(readFile AbortError → isError 结果,**普通 settle 路径**,
   按前缀冲刷;宽限计时器只在 signal-ignoring 工具上武装——本用例
   不触发宽限),未启动者无事件、fillMissing 合成。

系统提示层(`test/system-prompt.test.ts` 增补):

4. **渲染**:含 ≥2 safe snippet 工具时,规则行出现且名单正确(读、
   grep、find、ls、task);
5. **门槛**:仅 1 个 safe 工具(如只有 task)→ 无规则行;
6. **门**:无 snippet 工具(全空)→ 无 catalog 无规则行;
7. **override**:override 模式 → 无规则行(catalog 整体消失);
   **append-only**(有 APPEND 无 override)→ 规则行保留(正路径,
   评审 MINOR-4)。
7b. **runner 级 plumbing**:"零适配"声明用 `runner.system` 断言——
    规则行含五个真名(read/grep/find/ls/task;挂 system-prompt.test.ts:118
    的既有 runner 级 catalog 断言旁)。
7c. **合成夹具口径**(MINOR-1):buildSystemPrompt 纯函数直接喂合成
    数组——(a) safe∩snippet 名单 1 个 → 无规则行;(b) 名单 7 个 →
    规则行出现且**括号省略**(>6 分支);(c) MCP 降级条目
    (`MCP server X`,有 snippet 无 concurrencySafe)→ 不进名单。

显示层(`test/repl-tui.test.ts` / `repl-fold.test.ts` 增补):

8. **非 task queued 行**(与 sliding-window §4.13b 同场景、tools 通道
   对 agents 通道的对称用例;评审 MINOR-5 重写——套件不存在 "safe
   read" 夹具,也不需要):bare-shell 合成快照测试(repl-tui.test.ts:3132
   起的 test 12 形状)——推一个 5 running + 1 queued 的非 task 工具
   快照,断言 `liveRows.get("f")?.[0]` 含 `└─ queued`、
   `suffixes.has("f")` 为 false;升级路径用 runTurn-mock 模式
   (repl-tui.test.ts:3059)以真名 "read" 驱动 tap 派生
   (queued 由 `getTool("read").concurrencySafe` 得出)。
   loop 层的真实工具并行冒烟(§4.2)用 **mkfifo 门控真 read**
   (readFile 阻塞在 FIFO 上直到测试写入——确定性优于墙钟采样,
   一并解决 §6.3/§6.4 两个待决点,转为已决)。
9. **middle refusal 漂移**(§3.6.1 可达性;夹具形状,评审 MINOR-8):
   gated straggler(索引 0)+ 中位校验拒绝(索引 1,如 offset 非法的
   read)+ 尾随 safe 调用,经 REPL tap 观察——机制:refusal 在 phase 1
   即进 settled[](loop.ts:719-723)、leading 冲出,中位者行以 queued
   态挂起直到 straggler settle、游标越过、tool_end 冲出。现状钉子
   (标注"接受为记档漂移"),防止未来无声改变。
9b. **D10 选择器场景**(MAJOR-2b 决策的钉子):picker 打开期间,
    queued 非 task live 行仍渲染(随 task 行先例豁免),running 行
    的 suffix 照旧被守卫抑制。
10. **print 字节**(评审 MAJOR-1 重写:仓库不存在 "corpus" 工件,
    sliding-window §4.9 的 corpus 半句从未落地——先例锚点是
    `test/render.test.ts:431` 的 tool_running no-op 钉与 :293 的
    print 并发形状字节一致断言):**新增**一条 print 形状测试,真实
    只读工具段(4 个 read 头 + 呼叫序尾),参照 render.test.ts:293
    的字节断言写法;不引入"两次运行一致性"机制(sliding-window
    §4.9 该半句按未落地处理,不在本批补建)。

回归:全量 vitest、biome、双 tsconfig、build;sliding-window /
abort-grace 设计文档引用的既有测试全绿。

## 5. 风险

1. **批处理率不确定**:披露只是鼓励,模型可能仍逐个发。缓解:无——
   措辞评审 + 观察期;机制收益不依赖单模型行为,不做 A/B 承诺。
2. **并行资源峰值**(评审 MINOR-2 补全):5 并发 rg/fd 在大树上 CPU
   峰值 ×5;5 并发图像 read = ×5 WASM 处理(每调用独立 PhotonImage、
   显式 .free(),机制安全但内存 ×5);readFile **无字节上限**整文件
   缓冲(输出才 50KB 截断,缓冲不截断)×5。缓解:上限 5 不变;
   BUFFER_GUARD 每调用独立;无计划改(与串行 read 大文件的既有
   行为同级,只是并发度不同)。
3. **显示形状变化**:print corpus 更新(4 头连续);非 task queued 行
   是新增可见表面。接受并记档(§4.10 钉住)。
4. **middle-refusal queued 挂起**:已记档漂移(sliding-window §3.6.1),
   本批使其可达,钉子测试固定现状。
5. **测不到的**:模型真实批处理行为(集成层)——不在本批验收,记为
   观察项。

## 6. 评审待决点

1. 措辞草案(§1.1)——英文文案、名单呈现方式(括号 ≤6 个)。
2. 规则行位置:清单条目后、块内(vs 块尾独立小节)。
3. ~~§4.2 并行冒烟的并发观测方式~~ 已决:mkfifo 门控真 read
   (确定性,非墙钟;随评审 MINOR-5 折叠进 §4.8)。
4. ~~测试 8 的 fixture 形状~~ 已决:bare-shell 合成快照 + runTurn-mock
   真名驱动,无新夹具(§4.8)。

## 7. Review log

**Round 1 — 独立对抗评审(新上下文,2026-10-08),verdict NEEDS-FIXES。**
前提事实核查(§3/§3b 的 10+ 处源码声称)**全部属实,零捏造**;披露
通道决策无致命缺陷(不重开)。2 MAJOR + 8 MINOR + 4 NIT 全部折叠:

- MAJOR-1(corpus 幽灵工件):§4.10 重写——指名 test/render.test.ts
  先例(:431 no-op 钉、:293 形状断言),"新增"而非"保留",不补建
  两次运行一致性机制。
- MAJOR-2(queued 行通道指错 + D10 未决):(a) §2.3 通道澄清为
  live 行通道(nextLiveRows → setCallLiveRows),落点写死
  shell.ts:756-760 循环;(b) D10 选择器交互决策:queued live 行随
  task 行先例豁免守卫(不做 running 声明、与 task 行通道对称),
  §4.9b 补 D10 场景测试。
- MINOR-1(≥2 口径分叉):统一为名单(safe∩snippet)≥2,§4.7c
  合成夹具钉死含 >6 括号省略分支;MINOR-2(photon 缓存 + ×5 WASM/
  整文件缓冲):§3/§5.2 补全;MINOR-3(repl.ts:742 注释将变假):
  §2.4 补同步项;MINOR-4(append-only/runner 级/MCP 排除测试缺):
  §4.7/7b/7c;MINOR-5("safe read 夹具"不存在):§4.8 重写为
  bare-shell 合成快照 + runTurn-mock,mkfifo 门控真 read 解决 §6.3;
  MINOR-6(指针位置):改 §0 Status,批准正文不动;MINOR-7(abort
  措辞——真 read 走普通 settle 不触发宽限):§4.3 修正;
  MINOR-8(钉子夹具形状):§4.9 写死组合。
- NIT-1(行号漂移 2 处)修正;NIT-2(state → queued 命名)统一;
  NIT-3(计时规则已实现)标注;NIT-4(规则行精确字节)定死。
- 措辞采纳评审建议稿(三句版):主语改调用、消除指代歧义。
- 评审另核实:扩展工具 safe+snippet 进名单机制走得通(§2.2 已声明
  有意行为);middle-refusal 机制描述逐行准确(loop.ts:719-723/
  726-734);system-prompt 既有回归零碰撞。

(待 round 2 复核)
