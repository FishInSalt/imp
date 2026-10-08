# Abort grace period: a bounded wait for signal-ignoring tool calls

Batch: `feat/abort-grace`. Base: `main@83e7f9d`.

## 0. Status

DESIGN DRAFT — 待独立评审(对抗性、新上下文)。

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

```
claim 时(或串行调用前)记录 activeCalls: Set<{id, name}>
abort 发生(signal.aborted)→ 若宽限期未启动:启动一个 deadline 计时器
每个 settle 正常到达 → 从 activeCalls 移除
deadline 到 → 对仍在 activeCalls 的调用合成结果:
  "(aborted: tool X did not respond to the interrupt within 10s;
    result abandoned — the underlying process may still be running)"
  推入 settled[index] → 触发前缀冲刷(与正常 settle 同路径)
  logger.log("tool_abandoned", { name, id, waitedMs })
全部收尾后 loop 正常走 fillMissing → history 完整配对
```

关键点:
- **计时器只在 abort 后存在**:正常运行零计时器、零字节差别(健康监测
  器先例:monitor 零计时器 until observed)。
- **合成走 settled[index]**:复用前缀冲刷,顺序天然正确;僵尸 Promise
  若之后真 settle,写进 settled[index] 只是幂等覆盖的前缀已冲区,无处
  使用——但要防晚 settle 覆盖合成结果:合成时打标
  `abandoned: true`,worker 的晚 settle 检查到该标则丢弃。
- **串行路径同款**:`executeToolCall` 外包一层相同的
  `raceWithGrace(plan, id)`。
- **abort 检查点前移**:今天 `while (head < runnable.length)` 顶部的
  aborted 检查在挂死场景永不到达(worker 卡在 await);宽限期到期合成后
  worker 的 `plan.run` 仍在 await——需要 worker 在合成时被"释放":
  用 `Promise.race([plan.run(signal), graceDeferred])`,deadline 到时
  resolve graceDeferred,worker 拿到合成结果继续循环(下一轮认领前
  aborted 检查退出)。worker 循环因此多一个 await 点,认领序仍=呼叫序
  (race resolve 是同步排队的微任务,不改变 head++ 的同步性)。

### 2.2 配置

常量 `ABORT_GRACE_MS = 10_000`(constants.ts,与 cap 同款"no env knob"
纪律);`RunAgentLoopOptions` 不加面——宿主统一行为。测试注入:loop
options 已有 `clock` 先例,加可选 `graceTimer?: (ms, cb) => canceller`
或直接用真实 timer + vitest fake timers。倾向后者(少一个接口面)。

### 2.3 显示

宽限期内(abort 已发生、grace 未到期):现状不变——REPL 已显示
"(interrupt — press Ctrl+C again to force quit)"。deadline 触发合成
时,tool_settled/tool_end 带合成的 isError 结果,既有显示路径照常渲染
"✗ + 结果行"。无需新事件。print 模式:合成结果照常落行,exit code 走
既有 aborted 路径。

### 2.4 二次 Ctrl+C

宽限期不改变二次 Ctrl+C 的 forceExit 语义(那是用户显式动作,永远最
高优先)。宽限期只是把"第一次 Ctrl+C 之后"从可能无限变成至多 10s。

## 3. 与既有机制的关系

| 机制 | 关系 |
|---|---|
| task 工具的 60min 时钟 | 正交:那是正常运行的挂起守卫;本批是 abort 后的出口。task 响应 signal,宽限期对它通常无感 |
| #bash-abort 组杀 | bash 已响应 signal;本批兜的是"其他工具不响应"的剩余面 |
| fillMissingToolResults | 互补:宽限期合成的是"已启动未收尾"的调用;fillMissing 收的是"从未启动"的。两者都进 history,配对完整 |
| maxIterations | 无关 |

## 4. 否决备选

- **每调用硬超时**:打断合法长任务(bash 20 分钟),方向错误。
- **kill -9 子进程树**:宿主无法枚举任意工具的进程(task/bash 有登记,
  扩展/MCP 没有);登记面是另一个批次。
- **宽限期可配置(env)**:与 cap 同判据——单用户场景无需求,常量先行。
- **abort 即刻合成不等宽限**:撕掉合法慢停工具的收尾机会(bash 组杀
  要 100ms-2s;MCP cancelled 通知往返)。

## 5. 风险

1. **晚 settle 覆盖合成结果**:§2.1 的 `abandoned` 打标防覆盖;晚 settle
   被丢弃时 tool_settled 不再发(已发过合成版)。
2. **僵尸 Promise 泄漏**:无法避免(JS 语义);记日志;进程退出时
   unref。接受并记档。
3. **race 改变 worker 循环的微任务结构**:认领序仍由同步 head++ 保证;
   test 4b(顺序钉)继续钉。需评审确认 race 的 resolve 排队不引入认领
   乱序窗口。
4. **REPL 状态机**:宽限合成后 runTurn 正常返回 aborted,状态机走既有
   settleFailure/settleSuccess 路径,无新状态。
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
7. print e2e:hermetic 挂死工具脚本 + SIGINT → 进程 ≤ grace+余量 退出,
   exit code 130 路径不变(cli-run-start 先例)。

## 7. Review log

(待评审)
