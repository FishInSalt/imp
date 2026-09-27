# bash 工具中止链修复（孙进程劫持 stdio）

- 批次：`fix/bash-process-group`
- 日期：2026-09-27
- 状态：rev2（吸收对抗审查四项强制修订：审查结论 REJECT rev1 → 本版处理）

## 1. 问题（dogfood 2026-09-27，已端到端复现）

子 agent 的 bash 工具执行了一个命令，该命令的**孙进程**（wrapper 结构：
`bash -c 'npm xxx'` → node、脚本内再起 python 等）继承了 stdout/stderr
管道。用户按 Esc 中断：

1. 中止信号杀死了 bash 壳（直接子进程），但孙进程持管道不退；
2. node 的 `close` 事件 = 进程退出 **且** 全部 stdio 关闭 → 永不触发；
3. bash 工具的 promise 永不 settle → 子 agent 挂 → task 挂 → 主 turn 挂
   （状态机停在 `running`，`interruptCount` = 1）；
4. 第二次 Esc 命中"运行中双击 = 强退逃生门" → **forceExit(130)，整个
   REPL 退出**。

复现测试（本批随行）：
- `test/repro-esc.test.ts` — 命中场景，钉住当前行为（修复后收紧断言）；
- `test/repro-esc2.test.ts` — 对照场景（正常中断），行为契约不受本批影响。

单机验证（node -e，已做）：直接子进程 SIGTERM 死后孙进程持管道 → 3s 无
close。另：直接子进程卡 stdin（`read` 等 pipe 输入）场景 SIGTERM 秒杀、
中断链正常 —— **只有"孙进程持管道"这一形态触发本 bug**。

超时路径同病：`stop()` TERM→2s→KILL 只杀直接子进程，孙进程漏网。

## 2. 参考（已核源码）

| 来源 | 位置 | 做法 |
|---|---|---|
| **pi 主仓** | `coding-agent/src/core/tools/bash.ts:96,102,109-131`；`src/utils/shell.ts:216-246`；`src/utils/child-process.ts:49-127`；`src/core/exec.ts:75` | `detached`（非 win32）+ `process.kill(-pid, "SIGKILL")` 组杀、失败回退单杀；`waitForChildProcess`：监听 `exit` 而非 `close`，exit 后等 stdio **空闲**（100ms 宽限，每个输出块重置计时器，静默句柄超时即 destroy+resolve）；stdin `ignore`；detached 组登记在册、父关停信号统一杀 |
| **Claude Code** | `restored-src/src/utils/Shell.ts:333-336`；`ShellCommand.ts:193-196,336-341`；`shell/bashProvider.ts:75` | `detached: true` + `tree-kill` npm 包（遍历树杀）SIGKILL；显式注释弃 `close` 用 `exit`（注释原文点名 grandchild 持管道场景）；输出走文件 fd 不走管道（管道问题根上不存在）；abort reason==='interrupt' 时转后台化不杀 |
| pi-subagent 扩展 | `examples/extensions/subagent/index.ts:410-421` | 独立 pi 进程，TERM→5s→KILL 单杀（无组杀）——对本批参考价值低 |

两家在生产上都**不做 TERM→KILL 升级**（组杀直接 SIGKILL）。

## 3. 设计决策

### D1 杀法：进程组 SIGKILL（采纳 pi）
`spawn(..., { detached: process.platform !== "win32" })`；中止与超时共用
`killProcessTree(pid)`：
- win32：`taskkill /F /T /PID`（System32 绝对路径，pi 同款；spawn 失败
  静默）；
- 其他：`process.kill(-pid, "SIGKILL")`，ESRCH 回退 `process.kill(pid)`。

备选否决：
- TERM→宽限→KILL 升级（我初稿）：两家生产实现都不做；中止语义下杀干净
  优先于优雅退出，升级只是多等 2s；
- `tree-kill` npm 包（CC）：多一个依赖做组杀免费就能做的事。

**代价（显式声明）**：中止/超时会连带杀掉命令**有意后台化**的进程
（`npm run dev &` 类）。agent 场景这是期望行为（用户中断 = 这一窝全清），
CC 同语义。行为变化写进 CHANGELOG。

### D2 等待语义：`exit` + stdio 空闲宽限，带绝对上限（pi 基础上加固）
现在用 `close` → 孙进程持管道永不触发。改为 pi 的三事件合一：
- `exit` 到达记退出码 **和信号**（审查 P1-3：pi 的 helper 丢信号参数，
  imp 的 `command terminated by signal ${X}` 报告依赖它——本移植必须
  返回 `{ code, signal }`，不许照抄 pi 的 `number | null`）；
- stdio 各自 `end`，两者齐 → finalize；
- exit 后 100ms 空闲计时器（每个 data 块重置——仍在写的孙进程继续
  读满，不截断尾部输出；静默句柄 100ms 后 destroy 流并 resolve）。

**绝对上限（审查 P0-1，对 pi 的刻意偏离）**：空闲重 Arm 无上限时，
"setsid + 持续写"的逃逸者会在中止路径复现原 bug（组杀杀不到、
exit 后计时器永远重置、工具永不 settle）。规则：
- **中止/超时路径：exit 即 finalize**（进程已组杀，残余输出丢弃，
  已 append 进 StreamState 的部分保留——与现状中止语义一致）；
- **正常退出路径：空闲宽限照常重 Arm，但自 `exit` 起设
  `MAX_POST_EXIT_MS = 2000` 绝对上限**（持续写逃逸者最多拖 2s，
  尾部可能截断——记入 R2）。

`settled` 的定义（审查 P1-5）：= waitForChildProcess 已 resolve。
finalize 前到达的 data 块照常 append（宽限期间不丢）；finalize 时
  destroy 流，至多丢一个在途块——这是与现状唯一的可接受差异（现状
  close 语义下永不丢，但也永挂）。

常量 `EXIT_STDIO_GRACE_MS = 100` / `MAX_POST_EXIT_MS = 2000`。

备选否决：
- CC 的输出走文件 fd：管道问题根上不存在，但要重构 StreamState → 输出
  通道（文件生命周期、截断展示、溢出落盘全重做），代价远超收益，记为
  未选备选；
- 我初稿"SIGKILL 时销毁流"：只救中止路径，正常退出遇到 setsid 逃逸者
  仍挂（逃逸者自己 setsid 就不在组里）；空闲宽限在两条路径统一兜底。

### D3 关停清理：detached 组登记（采纳 pi）
`detached:true` 的进程组收不到终端信号——不登记则 imp 退出会漏孤儿组。
`trackDetachedChildPid/untrack` 模块级 Set；killProcessTree 与登记共用
`src/core/process-tree.ts`（新文件，bash.ts 与退出路径都 import）。
调用点（审查 P1-2 + P2-7）：
- `gracefulExit` / `forceExit`：`killTrackedDetachedChildren()` 在
  `this.exit(code)`（可能 process.exit）**之前**；
- **print 模式（审查补）**：`src/cli.ts` 的 SIGINT 强退路径
  （裸 `process.exit(130)`）与运行完成退出路径都补调；简单做法是
  在 cli 启动时一次性挂 `beforeExit`/SIGTERM/SIGHUP 钩子（pi 模式）。

track 时机（审查 P2-8）：spawn 返回后同步登记，任何 `await` 之前；
untrack 在 finally。

### D4 stdin：维持 pipe，不改 `ignore`（本批不动）
pi 用 `stdin: "ignore"`（交互命令 read 立即 EOF，挂不住）；CC 有前台/
后台任务分流。imp 改 `ignore` 是行为变化（依赖 stdin 的管道用法受影
响），且 D1+D2 已把"挂住"变成"可中断"（D2 的绝对上限后，含 setsid
  逃逸者在内所有形态都有界）——挂住→超时/中止可解。**记为独立决策项，
本批不改**；若后续 dogfood 仍见交互命令挂住浪费超时窗口，再单开小批改
`ignore`。

## 4. 变更清单（预计）

| 文件 | 变更 |
|---|---|
| `src/core/process-tree.ts`（新） | `killProcessTree`（win taskkill / posix 组杀+回退）+ `track/untrack/killTrackedDetachedChildren`（~60 行） |
| `src/core/wait-child.ts`（新） | `waitForChildProcess`：exit+空闲宽限+绝对上限，返回 `{ code, signal }`（~90 行） |
| `src/core/tools/bash.ts` | spawn 加 `detached`（非 win32）+ 同步 track；`stop()` 改 `killProcessTree`（去掉 TERM/2s 升级）；等待换 `waitForChildProcess`（中止时 exit 即 finalize）；退出报告用其 signal |
| `src/repl/repl.ts` | gracefulExit / forceExit：`killTrackedDetachedChildren()`（在 exit 调用前） |
| `src/cli.ts` | print 模式退出路径（SIGINT 强退 + 正常完成）补同一清理；或启动时挂 beforeExit/SIGTERM/SIGHUP 一次性钩子 |
| `test/bash-tool.test.ts`（新） | 见 §6 |
| `test/repro-esc.test.ts` | 断言收紧为修复后契约 |
| `test/repro-esc2.test.ts` | 原样收编 |

约 +150 src / +200 test。

## 5. 不变式

- 部分输出语义：中止时已 append 的输出保留，"command aborted by user"
  文案、超时/退出码报告不变；
- Esc/Ctrl+C 双击强退语义不变（真卡死逃生门）；
- `!` 直通命令复用同一工具，自动受益；
- MCP 子进程清理不受影响。

## 6. 测试计划

真实进程树（不 mock child_process）：
1. 孙进程持管道（`sleep 300 & wait`）+ abort → 限期内 settle、组内孙进程
   死（`ps`/`process.kill(pid,0)` 断言 ESRCH）、结果含 aborted 文案；
2. 同结构 + timeout → 限时结算、组死；
3. `trap '' TERM` 抗 TERM（现在杀法直接 KILL，理论上免疫；测试钉住
   "无 2s 升级延迟"——即 abort 后 settle 时长远小于旧 KILL_GRACE）；
4. setsid 逃逸者（命令里 `setsid sleep 300`）→ exit+空闲宽限兜底，
   100ms 后 settle（零输出——测静默句柄路径）；
4b. **空闲重 Arm（审查 P1-4）**：`setsid sh -c 'i=0; while [ $i -lt 40 ];
   do echo tick; i=$((i+1)); sleep 0.05; done' & sleep 0.3; echo
   parent-done`——断言 (a) 写者完成前工具不 settle（宽限持续重 Arm，
   ~2s），(b) 结果含全部 tick 行（尾部不截断）；
4c. **持续写逃逸者 + 绝对上限**：写者无限循环 + abort → settle 不晚于
   exit + MAX_POST_EXIT_MS（正常路径上限被 D2 规则覆盖）；
5. 正常命令输出完整性回归（现有测试覆盖，不重做）；
6. `repro-esc.test.ts` 收紧：Esc#1 限期内完整中断（任务行消失、无
   forceExit）、Esc#2 idle 无操作；
7. `repro-esc2.test.ts` 原样通过。

门禁：vitest 全量、typecheck ×2、biome、build。

## 7. 风险

- **R1** 有意后台化进程被杀（D1 声明的行为变化）：CHANGELOG 记录；
  dogfood 观察期若无真实受害场景则接受；
- **R2** 空闲宽限截尾：正常路径下，持续写逃逸者最多拖到 MAX_POST_MS
  （2s）后被截断——pi 上游（earendil-works/pi#5303）选了无限重 Arm
  （不截尾但可无限拖），imp 为闭环中止语义选了绝对上限，属对 pi 的
  有意偏离；截断只发生在 exit 后仍有活写的逃逸者场景；
- **R4（审查 P2-6）** grep.ts 同病（TERM→2s→KILL 只杀直接子进程），
  本批不修，记为已知遗留；process-tree.ts 落地后单开小批复用。
- **R3** macOS/Linux 进程组语义差异：`detached` 在两平台都是 setsid
  语义（新会话新组），`-pid` 组杀一致；Windows 走 taskkill 分支，本仓
  平台未支持、分支保持防御性静默。
