# Abort grace period: a bounded wait for signal-ignoring tool calls

Batch: `feat/abort-grace`. Base: `main@83e7f9d`.

## 0. Status

DESIGN REV 2 — round 1 findings folded (见 §7)。待 round 2 复核。

## 1. Problem

用户 Ctrl+C(`AbortController.abort()`)后,loop 把 signal 交给每个工具的
`execute`。协议约定工具必须响应 signal(types.ts:"AbortSignal must be
honored (Ctrl+C kills tools)"),但**没有任何机制强制**:

- 一个不理 signal 的工具(扩展工具、MCP 服务器挂死、将来标 safe 的只读
  工具)会让 `plan.run(signal)` 永不 settle;
- 串行路径同样暴露(`executeToolCall` 直接 await);
- 后果分模式:REPL 第一次 Ctrl+C 后状态机停在 `running`,用户只剩二次
  Ctrl+C 强退(forceExit,丢上下文);print/headless 无键可按,进程挂到
  外部 kill(60 分钟子代理时钟只覆盖 task,不覆盖其他工具);
- 滑动窗口下伤害放大:一次挂死占住一个槽位,worker 停止认领,整批冻结。

这不是理论风险:#bash-abort 批次的起因就是孙进程持管道导致 close 永不
触发——那次修的是 bash 自身;本批修的是**任意工具**不理 signal 时,宿主
给等待者一个有界出口。

## 2. 方案:abort 后的宽限期(grace window)

**不是硬超时**——bash 合法跑 20 分钟,硬超时会打断真实工作。宽限期只在
**signal 已中止**后启动:用户已经明确要求停止,工具只是没听话。给它一个
有限窗口(默认 10s)自行 settle;到期后宿主停止等待、合成结果、正常收尾。
挂死的 Promise 无法真被取消(僵尸留在后台,记日志);**兜底解救的是等待
者,不是凶手**。

### 2.1 机制(loop.ts)

**单写者原则**(评审 MAJOR-1):每个被宽限保护的调用一个 registry 条目
`{ index, id, name, deferred, synthesize }`;worker/串行调用方始终是
`settled[index]` / `tool_settled` / `flush` 的**唯一写者**;loop 级
deadline 计时器只做两件事——为每个未收尾条目 resolve 其 deferred,并记
日志。resolve 的值就是该条目构造的**同一个合成 ToolResult 对象**,因此
race 赢家路径与正常 settle 路径逐字节同构:

```
claim/serial-call 前:registry.set(index, { deferred, synthesize })
  synthesize(): ToolResult — isError:true,
    "Tool X did not respond to the interrupt within 10s — result
     abandoned; the underlying process may still be running."
worker: const result = await Promise.race([plan.run(signal), entry.deferred])
  → (无论哪个赢)写 settled[index]、emit tool_settled、flush —— 单写者
正常 settle:registry.delete(index)(同帧,先于任何 timer 宏任务)
abort 感知:signal.addEventListener("abort", armDeadline, { once: true })
  快路径:进入时 signal.aborted 已真 → 立即 arm(先例 subagent.ts:336-341)
  arm 仅当 registry 非空;runAgentLoop finally removeEventListener + clear
deadline 到:对 registry 中每条 entry:
  process.stderr.write(`ink: tool ${name} did not respond to the
    interrupt within ${ABORT_GRACE_MS / 1000}s — abandoning its result\n`)
  entry.deferred.resolve(entry.synthesize())
全部收尾后 loop 正常走 fillMissing → history 完整配对(claimed→grace
  合成、unclaimed→fillMissing,answered-set 保证不重不漏)
```

关键点:
- **计时器只在 abort 后、且 registry 非空时创建**;创建即 `unref()`
  (REPL 有 stdin 兜底;print 模式事件循环不被多余的 10s 挂住——评审
  MAJOR-4),runAgentLoop 收尾 finally 中 clear。
- **race 输家的处置**(评审 MAJOR-2):race 输家的 continuation 在 race
  settle 后是 no-op,不存在"晚 settle 写入 settled[]"的路径;但输家
  promise 若之后真 settle/reject 无人观测。处置:fire-and-forget
  `.then(() => {}, () => {})` 吞掉 rejection 观测位,并在真 settle 时
  记 stderr 一行(`tool X settled late, result dropped`)。**承载不变
  量**:`runTool` 全量 try/catch(loop.ts:662-692)保证 plan.run 永不
  reject——race 输家不产生 unhandledRejection 依赖此不变量;将来 plan
  形态若可 reject,此处必须重审(记入代码注释)。
- **串行路径同款**:`executeToolCall` 的 `prepared.run(signal)` 一行外包
  相同 race;race 的两个分支都产出 ToolResult(合成对象非 undefined),
  串行调用点的 `results.push` 不变。校验/gate 在 run 之前,不在 race 内。
- **abort 检查点前移**:今天 `while (head < runnable.length)` 顶部的
  aborted 检查在挂死场景永不到达(worker 卡在 await);宽限 resolve 唤醒
  worker,它完成写入后在下一轮认领前的 aborted 检查退出。认领序仍=呼叫
  序:head++ 只发生在同步临界区;race resolve 的续体按 then 注册序入微
  任务队列,即便 worker 唤醒乱序,被认领的 index 序列仍由 head 单调保
  证(评审 a 项结论)。

### 2.2 配置

常量 `ABORT_GRACE_MS = 10_000`(constants.ts,与 cap 同款"no env knob"
纪律);`RunAgentLoopOptions` 不加面——宿主统一行为。**日志走
`process.stderr.write`**(subagent.ts:315 先例;runAgentLoop 无 logger
接缝,不为兜底日志开选项面——评审 MINOR-1)。测试注入:vitest fake
timers 控 deadline(不加 graceTimer 接口)。

### 2.3 显示

宽限期内(abort 已发生、grace 未到期):现状不变——REPL 已显示
"(interrupt — press Ctrl+C again to force quit)"。deadline 触发合成
时,tool_settled/tool_end 带合成的 isError 结果,既有显示路径照常渲染
"✗ + 结果行"。无需新事件。

**print 退出码(评审 MAJOR-5 更正)**:单次 SIGINT 的既有行为是
runTurn 正常 resolve aborted、**exitCode 保持 0**(cli.ts:1082-1088 仅
truncated 设 2);130 只属于第二次 SIGINT 的 process.exit(130)。本批
不改退出码语义——宽限合成后仍走 resolve-0 路径;测试断言 0(及进程有
界退出),不断言 130。

### 2.4 二次 Ctrl+C

宽限期不改变二次 Ctrl+C 的 forceExit 语义(那是用户显式动作,永远最
高优先)。宽限期只是把"第一次 Ctrl+C 之后"从可能无限变成至多 10s。

### 2.5 范围声明:门禁挂死不在本批(评审 MAJOR-3)

chunk phase-1 的门禁 `await`(loop.ts:534-538)发生在 plan.run 之前,
不在 race 覆盖内——一个挂死的扩展 `tool_call` handler 仍会让 executeChunk
悬置(activeCalls 为空,宽限无事可合成)。串行路径因外包整个
executeToolCall 反而覆盖。三个选项(收窄声明 / 门禁移入 worker / chunk
级 deadline)中**选收窄声明**:门禁移入 worker 会推翻滑动窗口设计
"gates 串行先于任何执行"的既定不变量(其评审 MAJOR #3 的修复正是串行
评估);chunk 级 deadline 为一条未验证的边缘路径引入第二套计时语义。
本批声明:宽限期覆盖**工具执行**;扩展 handler 挂死是扩展自身的 bug,
REPL 二次 Ctrl+C / print 二次 SIGINT 仍是其出口,记档不改。

## 3. 与既有机制的关系

| 机制 | 关系 |
|---|---|
| task 工具的 60min 时钟 | 正交:那是正常运行的挂起守卫;本批是 abort 后的出口。task 响应 signal,宽限期对它通常无感 |
| #bash-abort 组杀 | bash 已响应 signal;本批兜的是"其他工具不响应"的剩余面 |
| fillMissingToolResults | 互补:宽限期合成的是"已启动未收尾"的调用;fillMissing 收的是"从未启动"的。两者都进 history,配对完整 |
| maxIterations | 无关 |

### 2.6 嵌套与信号形态(评审 MINOR-2)

子代理的子信号是**手动 relay 复合**(subagent.ts:332-341;task.ts 经
childSignal relay 父 signal 与 timeout 的或门),不是 AbortSignal.any。
因此父未 abort、子 60min 时钟触发时,子 signal.aborted=true,子的宽限
**会**武装——这是可取的行为(挂死子代理的有界退出),属本批的行为扩
展,记档声明。listener 生命周期:进入时快路径查 aborted、arm 用
`{ once: true }`、runAgentLoop finally removeEventListener。

## 4. 否决备选

- **每调用硬超时**:打断合法长任务(bash 20 分钟),方向错误。
- **kill -9 子进程树**:宿主无法枚举任意工具的进程(task/bash 有登记,
  扩展/MCP 没有);登记面是另一个批次。
- **宽限期可配置(env)**:与 cap 同判据——单用户场景无需求,常量先行。
- **abort 即刻合成不等宽限**:撕掉合法慢停工具的收尾机会(bash 组杀
  要 100ms-2s;MCP cancelled 通知往返)。

## 5. 风险

1. **race 输家悬置**:plan.run 永不 reject 是承载不变量(runTool 全量
   catch);输家以 fire-and-forget 观测位吞 rejection,真 settle 记日志
   丢弃。§2.1 已钉死。
2. **僵尸 Promise 泄漏**:无法避免(JS 语义);stderr 记一行;计时器
   创建即 unref 且 finally clear,进程退出不被拖住(§2.1/MAJOR-4)。
3. **race 改变 worker 循环的微任务结构**:认领序仍由同步 head++ 保证
   (评审 a 项独立论证:race resolve 后各续体按注册序入队,head 单调,
   被认领 index 序列不变);test 4b(顺序钉)继续钉。**已关闭**。
4. **REPL 状态机**:aborted 的 runTurn 是 resolve(走 settleSuccess 的
   aborted 臂:restoreQueueToEditor + returnToIdle),无新状态(评审核
   实)。
5. **print 模式**:SIGINT 一次即 abort;宽限期在无 TTY 下同样生效(
   10s 后进程干净退出而非挂死)——正是本批主收益场景。

## 6. 测试计划

loop 层(loop-concurrency.test.ts 新 describe):
1. **红测试(核心)**:不理 signal 的挂死工具 + abort → 无宽限实现下
   runAgentLoop 永不 resolve(用 Promise.race 断言 100ms 内未 resolve
   作红基线);有宽限 → graceMs 后 resolve,history 7/7 配对,合成结果
   isError、文案含 "did not respond"。
2. 晚 settle 不覆盖:挂死工具在合成后 50ms 才 settle → history 仍是合
   成结果,无第二个 tool_end。
3. 串行路径:串行挂死工具 + abort → 同款有界收尾。
4. 正常运行零计时器:fake timers 断言 abort 前无 timer 创建(健康监测
   器先例的测试形状)。
5. 部分响应:批内 2 个工具响应 signal、1 个不理 → 响应者正常结果、不
   理者合成,前缀冲刷顺序正确。
6. 二次 forceExit 不受影响(既有测试保持绿)。
7. print e2e:hermetic 挂死工具脚本 + SIGINT(向子进程投递,fixture 需
   新增信号能力;cli-run-start 先例未发过信号)→ 进程 ≤ grace+余量 退出,
   exit code 0(单 SIGINT 的既有 resolve 语义,MAJOR-5 更正),stderr 含
   abandoning 行。

## 7. Review log

**Round 1 — 独立对抗评审(新上下文,2026-10-08),verdict NEEDS-FIXES。**
架构方向(宽限窗 + race + 前缀冲刷 + fillMissing 分工)被确认正确;排序
担忧(§5.3)经独立论证关闭。5 MAJOR 全部折叠:

- MAJOR-1(写者二义/resolve 值未定义):§2.1 重写为单写者——registry
  条目携带 deferred+synthesize,resolve 值即合成结果对象,worker 唯一
  写 settled[index];计时器只 resolve+记日志。
- MAJOR-2(晚 settle 守卫是幻影路径):§2.1 改为显式输家处置
  (fire-and-forget 观测位 + 真 settle 记日志丢弃)+ 声明 runTool 永不
  reject 为承载不变量;原测试 2 改为断言输家无 unhandledRejection 与
  日志行。
- MAJOR-3(gate 挂死破不变量):新增 §2.5 范围声明——收窄到工具执行,
  门禁挂死仍由二次 Ctrl+C 出口;门禁移入 worker 被否(推翻滑动窗口既定
  不变量)。
- MAJOR-4(计时器挂住 print 退出):§2.1 钉死——registry 非空才创建、
  创建即 unref、finally clear。
- MAJOR-5(exit code 130 前提为假):§2.3 更正——单 SIGINT resolve-0
  语义不变,测试 7 断言 0;fixture 需新增投递 SIGINT 能力。

MINOR 折叠:MINOR-1(stderr 日志先例);MINOR-2(嵌套信号形态更正:
无 AbortSignal.any,子超时会武装宽限——§2.6 记档);MINOR-3(settle
路径名更正,结论"无新状态"被核实);MINOR-4(删除失实的健康监测器类
比)。NIT 折叠:零输出字节差别措辞、红基线配 fake timers、registry
条目携带 index。
