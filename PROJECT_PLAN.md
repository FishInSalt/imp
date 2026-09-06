# Imp — 从零开发的 Coding Agent · 项目计划

> **名字**：imp（小恶魔/小精灵）——替主人跑腿办事的小家伙，勤快、偶尔捣蛋，天生自带"工具需要权限门"的直觉。彩蛋：IMP 也是 ARPANET 最早的分组交换节点，路由器的祖先。
> 参考项目：[pi](https://github.com/earendil-works/pi-mono)（本地已克隆在 `../pi`）
> 本文档基于对 pi 源码结构的实际分析制定

---

## 0. 先要做的三个决策（建议）

| 决策点 | 建议 | 理由 |
|--------|------|------|
| **语言/运行时** | TypeScript + Node.js | 与 pi 同栈，源码可直接对照；模型 API 生态最成熟；将来可编译为单二进制 |
| **起步 Provider** | 只支持 1 个（Anthropic 或 OpenAI） | 多 provider 兼容层是 pi 中最大的复杂度来源（`packages/ai` 约 2.1 万行），起步阶段不值得 |
| **交互形态** | 先 CLI（print/REPL），后 TUI | pi 的 `packages/tui` 约 1.2 万行，是第二大复杂度来源；先验证 agent 核心，再投资 UI |

**最重要的认知**：pi 看起来功能繁多，但真正的 "agent 核心" 极小 —
`packages/agent/src/agent-loop.ts` + 4 个内置工具（bash/read/write/edit）合计 **约 1300 行代码**。
复杂度几乎全部在：provider 兼容、TUI、扩展系统。所以计划的核心思路是：

> **先花 20% 的力气把 agent 核心做对，再按需逐层加壳。**

---

## 1. pi 的架构解读（我们借鉴什么）

```
packages/
  ai/            # ~21k 行：LLM provider 抽象、流式、OAuth、模型目录
  agent/         # ~10k 行：agent loop、消息类型、工具、会话存储、compaction ★核心
  tui/           # ~12k 行：终端 UI 组件
  coding-agent/  # ~55k 行：CLI、交互模式、扩展系统、设置
  evals/ storage/ server/
```

关键设计决策（值得继承）：

1. **分层严格**：`agent` 包不依赖 UI、不依赖 CLI，可以独立嵌入（这是 SDK 的基础）。
2. **AgentMessage 与 LLM Message 分离**：内部用统一的 `AgentMessage`（含元数据），只在调 LLM 边界转换（见 `agent-loop.ts` 开头注释）。
3. **会话是树，不是列表**：JSONL 文件里每条记录有 `id`/`parentId`，分支/fork 不需要复制文件。
4. **工具即数据**：工具 = name + description + JSON Schema + execute(signal)，注册即可用，没有隐藏耦合。
5. **哲学：核心极简，一切可扩展**：sub-agents、MCP、plan mode、权限弹窗全部不内置，靠扩展实现。第一版应学习这一点 —— **克制是特性**。

---

## 2. 目标架构（分五层）

```
┌─────────────────────────────────────────────┐
│ L5  扩展系统（自定义工具/命令/钩子，M4+ 可选） │
├─────────────────────────────────────────────┤
│ L4  交互层：CLI print → REPL → TUI           │
├─────────────────────────────────────────────┤
│ L3  会话层：JSONL 树存储 / resume / compaction│
├─────────────────────────────────────────────┤
│ L2  Agent 核心：loop + 工具集 + 系统提示词 ★  │
├─────────────────────────────────────────────┤
│ L1  Provider 层：单 provider 流式封装         │
└─────────────────────────────────────────────┘
```

仓库结构（对照 pi 的 monorepo，但初期单包即可）：

```
imp/
  src/
    provider/        # L1：LLM API 封装（流式、工具调用解析）
    core/
      loop.ts        # L2：agent 主循环
      messages.ts    #     消息类型定义
      tools/         #     bash / read / write / edit / grep / find
      system-prompt.ts
    session/         # L3：JSONL 存储、树、compaction
    cli/             # L4：参数解析、print 模式、REPL/TUI
    extensions/      # L5
  test/
  PROJECT_PLAN.md    # 本文件
```

---

## 3. 里程碑计划

> 时间按业余时间投入估算；全职可压缩到 1/3。

### M0 — 最小可用 Agent（1~2 周）★最关键

**目标**：一个能通过 LLM 驱动、能执行工具、完成简单任务的命令行程序。

**任务清单**（✅ = 已完成于 commit 46a7548）
- [x] 脚手架：`package.json`（ESM + TypeScript）、`vitest`、`tsx`、typebox（ESLint 推迟到 M1 质量周）
- [x] `provider/`：Anthropic 流式 API 封装
  - [x] 统一事件模型：`text_delta` / `tool_call_start` / `tool_call_delta` / `message_end`（含 usage）
  - [x] 请求组装：messages + tools(JSON Schema) + system
  - [x] 工具调用参数的流式累积（wire index → block 映射）与最终解析
- [x] `core/messages.ts`：定义 `AgentMessage` 联合类型（与 LLM wire 格式分离）
- [x] `core/loop.ts`：agent 主循环
  - [x] AbortSignal 贯穿（Ctrl+C 可中断，二次 Ctrl+C 强退）
  - [x] 工具参数校验（typebox，失败返回错误给模型）
  - [x] 工具异常捕获 → `isError` 结果喂回模型
  - [x] maxIterations 防失控（默认 40）
- [x] 工具 ×2：`bash`（超时 + 尾部截断 + 滚动缓冲防内存爆）、`read`（offset/limit + 截断提示引导续读）
- [x] `cli/`：`imp -p "..."` print 模式，流式打印 + 工具过程展示 + token 汇总
- [x] 系统提示词 v1：角色、工具规范、安全边界
- [x] 测试：20 个（工具真行为 + loop 全路径 mock 测试）
- [x] **真实模型端到端验证**（2025-12-06，GLM-5.3 via Z.ai，commit 待补）
  - [x] 验收 #1：bash 工具 — 自主 find+xargs 统计 12 个 .ts 文件/1431 行 ✓
  - [x] 验收 #2：read 工具 — 读取并准确解释 AgentMessage 类型 ✓
  - [x] 验收 #3：涌现能力 — 无 edit 工具时自主用 read 定位 bug + sed 修复 + node 验证（NaN→2.5）✓

**M2 发现的问题及处置**：
- **合并后补审抓出 1 major + 5 minor**（commit 9b432c6 修复）：major 为悬空 tool_use——loop 在 max_iterations/中止路径持久化 assistant(tool_use) 却无完整 toolResult，导致 kill 后会话永久无法 resume（违反本里程碑验收标准）。根因：83 个测试全绿但 abort 时序/resume 重放路径无覆盖。教训已固化为 imp/AGENTS.md 的"代码审查纪律"条目：行为变更收尾前评估独立审查（触发条件见 AGENTS.md）

**M1 发现的问题及处置**：
- **AGENTS.md 上下文从未发给模型**（cli.ts 拼好 system 变量但 runAgentLoop 仍内联重建）—— Biome noUnusedVariables 首日抓到的真 bug；已修复并实机验证（system prompt 暗号测试，1 turn 零工具答对）。验收时被模型自己 `cat AGENTS.md` 掩盖，教训：**上下文注入类功能必须用"模型不读文件也能知道"的方式验收**

**M0 发现的问题及处置**：
- ~~Z.ai 端点不上报 input_tokens~~ **误判已修正**：Z.ai 在 `message_delta` 中上报真实 usage（含 input/cache），与 Anthropic（在 `message_start` 报 input）不同。provider 已兼容两种约定（取 max），token 显示已正确
- edit/write 工具缺失，模型靠 sed 改文件能用但易错 → M1 优先项

**验收标准**
```bash
imp -p "当前目录下有哪些 .ts 文件？统计总行数"
# → 模型自主调用 bash/ls 工具并给出正确答案
imp -p "读取 foo.ts 并修复其中的类型错误"   # 能改文件
```

**对照 pi 源码**：`packages/agent/src/agent-loop.ts`、`packages/agent/src/stream-fn.ts`、`packages/agent/src/harness/tools/bash.ts`、`tools/read.ts`

---

### M1 — 完整工具集 + 工程质量（1~2 周）

**任务清单**（✅ = 已完成，见 git log）
- [x] `write` 工具：整文件写入（自动建父目录，创建/覆盖分别提示）
- [x] `edit` 工具：精确文本替换
  - [x] 语义：所有 oldText 匹配原始文件、互不重叠、一次替换（继承 pi）
  - [x] 教学式错误：0 匹配提示重新 read+检查空白；N 匹配提示扩大范围
  - [x] 原子性：任一失败全部不写盘
  - [x] diff 渲染：自研 LCS 行级 diff，`@@ line N @@` 定位（v0.1 简化版）
  - [x] CRLF/BOM 归一化往返（测试覆盖）
- [x] 并发文件写保护：`file-lock.ts`（同步注册段修复了顺序 bug —— pi 用 registration 链解决同一问题）
- [x] AGENTS.md 上下文加载（~/.imp/AGENTS.md 全局 + 父目录向上遍历，`-nc` 可关）
- [x] bash 截断完善：截断时全量输出（≤10MB）写临时文件并告知模型路径
- [x] 日志：`~/.imp/logs/*.jsonl`（run_start/llm_request/message_end/tool_*/run_end；IMP_LOG=0 关闭；provider 装饰器模式接入）
- [x] 集成验收（GLM-5.3 真实闭环）：AGENTS.md 规范被遵循 + write 建带 JSDoc 的函数 + edit 一次多处改名跨文件同步 + 测试独立复核通过
- [~] grep/find/ls 独立工具：**暂缓** —— 日志观察模型用 bash 的 cat/find/ls 很顺，暂无必要（pi 也有 read/grep，等观察到实际瓶颈再加）
- [ ] ESLint：推迟到 M2 一起（不影响功能）

**验收标准**：在一个真实小仓库上完成"实现一个函数并通过其测试"的自主任务；全程无人工干预。

**对照 pi 源码**：`tools/edit.ts`（127 行）、`tools/write.ts`、`harness/system-prompt.ts`、`harness/utils/truncate.ts`

---

### M2 — 会话管理 + 上下文工程（2 周）

**任务清单**
- [x] JSONL 会话文件：每行一条消息（`id`、`parentId`、时间戳、usage）
  - 存储位置：`~/.imp/sessions/<cwd-横杠化>/<timestamp>-<uuid>.jsonl`（同 pi）
  - 树结构：消息追加只认 `parentId` 链，天然支持分支（分支 UI 属 M5）
- [x] `--continue` / `--resume <id>`（id 前缀/文件名均可）：恢复最近/指定会话；`imp sessions` 列表
- [x] Token 计量：run 级 + 会话累计（input/output/cacheRead/cacheWrite 分开，cli 尾行显示）；成本 $ 待多 provider 价格表（M5）
- [x] **Compaction（压缩）**：上下文快满时自动触发（`IMP_CONTEXT_WINDOW - 16384`，默认窗 131072）
  - 切点：保留尾部 ~20k tokens，回退到轮次边界（user 消息处）——toolResult 永不成为 retainedTail 开头
  - 摘要提示词沿用 pi 的结构化模板（Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context）
  - 估算：最后一次 assistant usage 锚定 + 尾部 chars/4 估算（pi 的洞察：最后一次调用的 usage 即实测上下文大小）
  - 原始历史不删，仍在 JSONL 里；compaction entry 自带 retainedTail，是自包含检查点
  - `IMP_AUTOCOMPACT=0` 可关；手动命令待 M3 REPL 斜杠命令
- [x] steering：loop 增加 `getSteeringMessages` 轮询（每轮开始前注入，含 run 开始时），与 pi 同构；REPL 接线在 M3

**验收标准**：单会话连续工作 50+ 轮不爆上下文；kill 进程后 resume 能无缝继续。

**验收结果（2026-08-28，GLM-5.3 实测通过）**：
- `imp sessions` 列表正常（时间/id 前缀/计数/标题）；`-r <前缀>` 恢复正常
- 暗号测试：跨进程 resume 后零工具答对暗号；cache↓ 映射实证（input 65 + cache 1.9k）
- 强制压缩（window=4000/keep=600）：3 次 compaction 落盘，结构化摘要模板被 GLM 严格遵守；fetch 瞬时失败后 `-c` 恢复，凭压缩摘要零重读答对 4 文件主题（input 仅 939 tok）；`(compacted)` 标记与累计统计正确
- 验收中发现并修复：**切点只认 user 边界导致单 user 消息的长工具流永不压缩**（已允许 assistant 切点，与 pi 同构）；`-v` 被无 prompt 分支拦截
- 50+ 轮长会话压测未做（压缩机制已实证，留待日常 dogfooding 观察）

**对照 pi 源码**：`harness/session/`（session.ts、jsonl-storage.ts、jsonl-repo.ts）、`harness/compaction/compaction.ts`；文档 `docs/session-format.md`、`docs/compaction.md`

---

### M3 — 交互式体验（2~4 周，按野心裁剪）

**建议两步走：**

**3a. readline REPL（3~5 天）**
- [ ] 多轮对话、`/exit` `/new` `/model` `/compact` 基础命令
- [ ] 流式渲染 assistant 输出、工具调用过程展示（工具名+参数摘要+结果状态）
- [ ] Ctrl+C 中断当前轮（恢复到可输入状态）

****3a 结果（2026-08-30，已合并 `4f136e7` + `a912164`）**：
- 工作流四阶段产出：2 份并行研究报告 → 906 行设计文档 → 10 提交实现（+3955/−202，零新依赖，core/provider 语义不变）→ 对抗评审
- 评审闭环 ×2：首轮 1 major（流式中止显示为 provider 错误：undici 中止 DOMException 逃逸，三层修复 abortSafe/loop null-on-abort/settleFailure 兜底）+ 4 minor；复审抓出我引入的 P1 回归（坏 `-r` id 崩溃）+ P1（批量编辑原子失败致 print 模式修复未落地）+ 截断掩盖（message_stop 追踪）
- dogfood 实测再抓 1 个 P1：**/compact 状态前置自我拒绝**——组件各自正确、接缝断裂的又一例
- 测试 89 → 142；全局限量全局 `imp` 已是 REPL 版本

**3a 经验教训**：
- **关键路径必须有从入口到输出的集成测试**：本轮两个 P1 都活在"单元测试直调内部函数、自控前置条件"的缝隙里（dispatchCommand 直调绕过状态机交互）。已用 handleLine 全路径测试堵住
- **脚本化管道探测全生命周期**是高性价比验收手法：echo 逐行喂数 + 等 stats 落定再发下一条，可确定性复现时序问题
- 中止类测试要**信号忠实**：不响应 signal 的假 provider 测不出流式中止（本轮 major 的盲区根源）；真 undici + 本地 SSE 服务器测试补齐
- 批量 edit 失败是原子的：失败后必须逐条验证落地，否则 commit message 会宣称不存在的修复

3b. 真 TUI（可选，量大）**
- [ ] 选型：自研（参考 pi-tui 的组件思路）vs [ink](https://github.com/vadimdemedes/ink)（React 式终端 UI）
- [ ] 编辑器组件：多行输入、历史、`@` 文件模糊补全
- [ ] 消息区：markdown 渲染、工具输出折叠/展开
- [ ] 状态栏：cwd / 模型 / token / 成本 / 上下文占用
- [ ] 会话树浏览器（`/tree`）

**验收标准（3a 后就够日常自用）**：交互模式下完成一次 30 分钟的真实编码会话，全程不用退出。

**对照 pi 源码**：`packages/tui/src`、`coding-agent/src/modes/interactive/`；文档 `docs/tui.md`、`docs/keybindings.md`

---

### M4 — 扩展系统（1~1.5 周，三个子里程碑）

> 完整设计契约见 `docs/m4-extensions-design.md`（900 行，已对照 pi 源码逐条核验引用）。
> 范围对原计划的调整：热加载与 sub-agent 案例移入 M5（理由见设计文档 §16）；
> 权限门改为规则式（M4 无 UI API，交互式确认是 M5 UI 贡献点的首个用例）。

**公共契约**：扩展 = 一个 ESM 模块（`.mjs`），默认导出 `function(api)`；`api` 是 7 个成员的薄对象（`cwd`/`version`/`origin` + `registerTool`/`registerCommand`/`registerContext` + `on`），工具与命令直接复用 core 的 `Tool`（tools/types.ts:13-19）与 `SlashCommand`（repl/commands.ts:14-21）。发现顺序：`-e` 显式路径 → `<cwd>/.imp/extensions/` → `~/.imp/extensions/`（realpath 去重）；`-ne`/`--no-extensions` 跳过两个目录但保留 `-e`。加载 = 裸 `await import()`，零新依赖（pi 需 jiti 做别名，imp 扩展不 import 宿主，别名层整体不需要）。三层错误隔离：import/工厂抛出 → 该扩展整体作废、其余照常；注册冲突（内置名保留、扩展间先到先得）→ 跳过该注册并致教学式诊断；handler 抛出 → `tool_call` 失效保护拦截（回错给模型）、其余事件打诊断行继续。信任模型：M4 不做首用确认（与 bash/AGENTS.md 现状一致，见设计 §11），启动横幅公示每个扩展来源，M5 发布时重审。

**M4a — 加载器 + 完整 API + 自定义工具（1~2 晚）**

**M4a 结果（2026-09-01，已合并 `a558bae`，真机验收通过）**：
- 工作流三阶段：单写手实现（9 commits，+1868/−32，零新依赖）→ 对抗评审（0 P1/0 P2/7 P3，APPROVE；自跑门禁 + 5 组变异验证证明测试承重）→ P3 顺手修 4 条（`3a58bc3`）
- 交付：`src/extensions/{types,registry,loader}.ts`（7 成员 API、三层隔离、发现链与去重）、runner 工具合并（print/REPL 共用 seam）、cli `-e`/`-ne`、`examples/extensions/notes.mjs` 巡礼
- 测试 142 → 172；关键测试：case 9 真动态 import 穿真接线、case 16 echo 管道探测、stored-unconsumed 三重断言（计数但确实未消费）
- 真机验收（GLM-5.3，3 次调用；1 次是脚本失误多耗的 46 out——教训：诊断类检查用零行管道即可零成本）：①E4 教学诊断 + 进程存活 + 后续轮正常 ②notes 工具 set→get 两连调、`.imp/notes.json` 落盘、cache↓5.3k ③`-ne` 对照：无 banner、模型可见工具恰为 6 内置 ④零成本项：`IMP_LOG=1` 零行管道下 `run_error {source:"extension"}` 全栈落盘（评审 P3-3 的验收侧覆盖）
- 已接受残余：P3-5 排序锁依赖 APFS readdir 恰好有序（平台运气）；P3-7 cli 两处 `loadExtensionSetup` 调用点的固有缝隙（共享 banner helper 防漂移，GLM 验收兜底）
- [ ] `src/extensions/{types,registry,loader}.ts`（共 ~440 行）：契约类型（完整 7 成员 API，见下条）/ 数据登记表+冲突策略+隔离 emit / 发现+动态 import+原子丢弃
- [ ] `runner.ts`：`RunnerOptions.extensions`，工具集 = `[...(options.tools ?? 内置六件), ...(扩展工具)]`（runner.ts:61-64 的测试缝就地升级）
- [ ] `cli.ts`：`-e`/`--extension`（可重复）、`-ne`、HELP 两行、loadExtensions + 诊断打印
- [ ] `examples/extensions/notes.mjs`（API 巡礼：tool+command+context，~70 行）——因此 **M4a 必须交付完整 7 成员 API**：`registerCommand`/`registerContext`/`on` 在 M4a 即登记入册（横幅计数）但暂不消费，命令分发在 M4b、事件发射与上下文注入在 M4c 落地；若只做 tool 版 api，本文件三合一巡礼会在 M4a 因 factory 抛错（E4）整体作废，验收即失败
- 验收：加载器单测（发现/去重/排序/E1-E8 诊断串）+ 全路径集成（fixture 写入临时 `.imp/extensions/`，走真实 import 与真实 cli 接线）；GLM ≤2 次：`imp -p "用 notes 工具保存 'ship it' 再告诉我存了什么"` 模型自主调用；坏扩展在旁边时 imp 照常完成任务且诊断可见

**M4b — 斜杠命令（0.5~1 晚）**
- [ ] `repl/commands.ts`：`dispatchCommand(line, ctx, extraCommands?)` 第三参；`/help` 与未知命令教学列表合并生成（不可漂移），扩展命令带 `[来源]` 后缀
- [ ] `repl/repl.ts`：`ReplOptions.commands` 透传（repl.ts:164 单点）；扩展命令 run 抛错沿用 `runCommand` 的 try/catch → `imp:` 行，零新代码
- 验收：`fake.send("/notes save hi\n")` 全路径断言（M3 教训：不直调 dispatchCommand）；保留名 fixture 被拒（E7）；GLM 0 次（命令不碰模型，可选 REPL 冒烟 1 次）

**M4c — 循环/回合事件钩子 + 上下文注入 + 案例（1~2 晚 + 1 晚打磨）**

**M4c 结果（2026-09-01，已合并 `7719ae1`；M4 代码全部落地，待真机验收）**：
- 工作流三阶段：单写手实现（6 commits，+771/−32；core 唯一改动 = `onToolCall` 否决门：校验后/执行前，block 变 isError 回灌模型；runner 接线 `message_end`/`tool_end`/`run_end` 发射与 `# Extension context:` 注入（AGENTS.md 之后、装载序稳定、`/new` 重注入）；`guardian.mjs` 规则式权限门案例 105 行）→ 对抗评审（1 P1 / 1 P2 / 2 P3，NEEDS-FIXES）→ 全部修复（`a305481`/`d3be569`/`3cd5b97`）
- **P1 教训（本里程碑最有价值的一课）**：评审者的"灭门变异"（把 gate 判定改成 `if (false)`）让测试套件真的执行了脚本里的 `rm -rf src/`，删掉 `src/` 下 31 个文件（`git restore` 救回）——guardian 测试自身 fail-dangerous。修复：牺牲树放进临时 cwd，fail-open 现在只会红不会毁
- **P2 是潜伏生产 bug**：默认内置工具忽略 `RunnerOptions.cwd` 回落 `process.cwd()`（生产中两者恰好一致所以没炸）——现已转发，红-绿全路径测试钉死
- 测试 177 → 190；评测确认 M4a/M4b 全部精确串零漂移；变异验证 7→3 处红
- **M4c 真机验收（2026-09-01，通过；3 次调用 ≤ 预算 4）**：①guardian 拦截——模型把 rm -rf 藏进组合命令仍被抓住，精确教学串回灌，模型承认被拦且照教学提示行事（主动列文件请确认），牺牲目录幸存，`~/.imp/guardian.log` 审计落盘（首次跑遇 fetch 瞬断，重试补全回合）②上下文注入——模型零工具准确引用 notes 扩展注入的 context 并确认无多余注入
- **M4 后续实战扩展（2026-09-01~02，用户提案）**：①`notify.mjs`——`run_end` 钩子 → Glass 音 + osascript 弹窗，`IMP_NOTIFY_MIN_SEC`（默认 5s）防瞬时噪音，`IMP_NOTIFY_DRY` 测试钩子；②`web_search.mjs`——`web_search`（Tavily）+ `url_read`（HTML→文本），零依赖。两者 symlink 进 `~/.imp/extensions/` 全局挂载，`[global]` 来源标签验证了真实发现路径
- **keyless → key 演进**：tavily 官方 SKILL.md 揭示 Search 支持 `X-Tavily-Access-Mode: keyless`（限流、免注册）；tvly CLI 的 OAuth 只给会话令牌不吐原始 key，故 keyless 先行（真机全链路过：GLM→工具→带引用综合），后配 `IMP_TAVILY_KEY` 进 .env 走 Bearer 全配额；三层稳健：有 key→Bearer / 无 key→keyless / 故障→教学错误回灌。tvly CLI 留装（map/crawl/research 需认证会话）
- **实战教训**：`.mjs` 是纯 JS，混入 TS 语法 import 即炸（E1/E4 隔离路径的价值实证）；JSONL 断言里带引号的子串会被转义导致误判；验收脚本失误提醒——诊断类检查用零行管道即零成本
- **遗留观察**：url_read 遇慢页面可拖长整轮（>180s，单调用有 15/20s 超时但多轮累计）→ M5"运行中工具进度显示"候选

- **M4 正式关闭**：a/b/c 三子里程碑全部落地、评审闭环、真机验收通过；扩展系统 = 7 成员 API + 三层隔离 + 工具/命令/钩子/上下文四类贡献点 + guardian 案例
- [ ] `core/loop.ts` 唯一改动：`RunAgentLoopOptions.onToolCall`（校验后、执行前；`{block, reason}` → isError 工具结果回模型，~18 行）
- [ ] `runner.ts` 发射接线：`onMessage`(assistant)→`message_end`、`onEvent`(tool_end)→`tool_end`、runTurn 返回→`run_end`（fire-and-forget，隔离）；`assembleSystem` 追加 `# Extension context:` 段（`registerContext` 注入点，runner.ts:184-196）
- [ ] 事件集仅 4 个：`tool_call`（可拦截）/`tool_end`/`message_end`/`run_end`；无 per-call ctx（M5+ 加法式扩展）
- [ ] `examples/extensions/guardian.mjs`（规则式权限门，~90 行，`IMP_GUARDIAN_BLOCK` 可配；偿还 M0 §6.6 的 bash 安全债）+ README "Extensions" 节
- 验收：拦截短路链/失败保护拦截/事件载荷单测；GLM ≤4 次：诱惑 `rm -rf` 的任务收到教学式拦截结果后自主改道；`imp -p "你有哪些扩展上下文？"` 凭注入段答对（M1 暗号式验收）

**完成定义**：零新依赖（package.json 零 diff）、`src/provider/` 零改动、loop 差异限 `onToolCall`、现有 142 测试全绿、AGENTS.md 审查纪律评估执行。

**明确延后到 M5+**（理由见设计文档 §16）：MCP、自定义 provider、sub-agent（需经 api 暴露引擎，且纠缠 D1/D2 决策）、UI 贡献点（`ui.confirm` 交互门）、热加载/`/reload`、npm/git 扩展包与 manifest、消息改写类事件、handler ctx/超时。

**对照 pi 源码**：`coding-agent/src/core/extensions/`（loader.ts 发现与隔离、runner.ts emit 隔离、types.ts API 形状）；文档 `docs/extensions.md`；分歧清单见设计文档附录 A（内置名保留 vs pi 覆盖、注册冲突跳过 vs pi 整体作废、4 事件 vs ~26 事件、无信任门等）

---

### M5 — 锦上添花（按需）

**M5 主菜：Subagents —— 设计已定稿（2026-09-03，`docs/m5-subagents-design.md`，workflow 8-agent 研究+对抗评审产出，引用已人工抽查核实）**
- 范围 = M4 记录的最小委托：`task` 工具（自包含 prompt）→ 新上下文子代理（嵌套 `runAgentLoop`，复用父 system+`CHILD_SUFFIX`、工具池去掉 `task`、40 turn 上限（父代理对齐）、30 min 墙钟超时 `AbortSignal.any`（时钟随轮数缩放的不变量写进 §4））→ 末条 assistant 文本作为工具结果（≤50KB 尾截断 + usage 尾行）
- 三子里程碑：**M5a** 顺序 task 工具 + 子会话文件（`children/` 子目录 + `parent` 头字段，默认开、`IMP_CHILD_SESSIONS=0` 关）→ **M5b** 并发（`concurrencySafe` 标志 + 连续段分块并发上限 5（上限只排队不丢任务；10 经评估否决——代价是端点压力与最坏等待）+ 门串行评估 + 调用序 `tool_end`/结果 + 渲染聚合 spinner）→ **M5c** agent 注册表（`.imp/agents/`+`~/.imp/agents/` markdown+frontmatter，无内置 agent，`tools:`/`model:` 可选）
- 关键否决：子进程方案（pi 是 CLI shell-out，imp 无 `--mode json` 面）、子消息入父文件（双写者毁树遍历）、steering/后台/missions（产品层 bloat）、frontmatter YAML 依赖（手写 ~40 行解析）
- 已知取舍：扩展门看不到子代理工具调用（Q3=否）；并发确定性 `tool_end` 排序以 10 min 超时为上界
- 原 M5 清单其余项（多 provider、`--mode json`、Skills、TUI 等）顺延为 M5 后段/M6 候选
- **M6 候选（并发竞争的正解）**：per-child git worktree 隔离——M5 共享 cwd 下 edit/write 有进程级文件锁（file-lock.ts，M5b 起承重）、oldText 失配退化为教学错误，但 bash 变更不在锁内、write 整替换会静默覆盖；task 工具描述已加并发纪律引导（2026-09-04）

- **M5 正式关闭（2026-09-04）**：a/b/c 三子里程碑全部落地并推送，测试 220 → 273（25 文件），零新依赖。
  - M5a `2a3ec71`：task 工具 + 嵌套 runAgentLoop 子代理（src/core/subagent.ts）+ 子会话（`children/` 子目录 + `parent` 头字段）；测试曾抓到真实 bug：createChildSession 未透传 sessionBaseDir，子会话写进了真实 `~/.imp/sessions/`
  - M5b `c224fcc`：`concurrencySafe` 标志 + 固定波次并发（cap 5，只排队不丢任务）+ 门串行评估 + 调用序发射 + 聚合 spinner；print 模式字节零变化（有测试保护）
  - M5c `fc9b3be`：agent 注册表（手写 frontmatter 解析，无 YAML 依赖，项目级胜出）+ `agent` 参数 + roster 自动路由提示；示例 `examples/agents/scout.md`（只读子集）
  - 并发边界文档化 `68a8798`：edit/write 进程级锁、oldText 失配退化为教学错误、bash 不在锁内——task 描述加并发纪律引导并测试固定
  - 实际运行验收（2026-09-04）：两个通用子代理并发执行 13/16 轮、子会话文件与 parent 链接在磁盘核实、usage 尾行格式与设计逐字符一致；**计划外验证了错误路径**——未安装 scout 时模型收到教学错误后自行改道重试成功
  - 实际运行暴露的三个代码问题全部修复 `9eb2294`（报错指向不存在的 CLI 命令、SUMMARY_MARK 单一来源、Renderer 移出 repl/ `371eed2`）
  - 遗留观察（M6 候选）：扩展门看不到子代理工具调用（Q3，安全缺口——**已于 M6a 修复，见下**）；无子级 compaction（子代理上下文耗尽是真实上限）；worktree 隔离
- **M6b worktree 隔离**（2026-09-05，`docs/m6b-worktree-design.md`）：task 参数 `worktree: true` / agent frontmatter `worktree:`；`git worktree add -b imp/task-* HEAD`（tmpdir 默认、`IMP_WORKTREE_DIR` 可覆盖、node_modules symlink、canonical root 防嵌套）；子代理工具池按 worktree 路径重建（内置六件套；扩展工具排除——api.cwd 无法迁移）；提示注入路径换算+提交指引（分支制回传的前提）；无改动→自动清理（worktree+branch+prune），有改动→保留+结果尾行教合并（`git merge <branch>`）；crash/abort/timeout 同规则（finally 清理，工作不丢）。参照核验：pi-subagents worktree.ts（802 行，补丁制回传被否决）与 Claude Code worktree.ts（保留+报告制，采纳）。非 git / 无提交 / 宿主未接 per-cwd 池 → 教学错误。子模块、未提交状态传播显式不解决。
- **M6b 正式关闭（2026-09-05）**：实现 + 独立审查 + 真机验证三段闭环。
  - 实现 `a1a4621`（292 测试）：`src/core/worktree.ts`（约 200 行，canonical root 解析/创建/变更检测/清理/提示与尾行）+ task 参数与生命周期 + runner per-cwd 工具池 + registry frontmatter
  - 独立审查（reviewer 子代理，裁决 fix-first）`819d4e7` 全部修复：**B1** agent 工具校验在 worktree 创建后返回导致泄漏（校验前移，创建后全部纳入 try/finally）；**B2** 分支基于主根 HEAD 而变更检测对比父 HEAD——父代理在链接 worktree 内时静默合并错误的树（改为基于 repo.head，回归测试搭真实嵌套场景）；**补测试时发现的死锁**（审查报告未含）：已中止的父信号不再触发 abort 事件，子代理永久挂起（继电器对已中止信号立即触发）；8 条 nit 全修（提交后工作入统计、清理失败可见、node_modules 排除、子目录重映射等）。审查→测试→再发现问题的链条是本轮最大收获
  - 真机验证（2026-09-05，/tmp 测试仓库）：隔离执行（主检出零改动）→ 子代理按注入提示提交（`imp/task-*` 分支）→ 结果尾行给分支名+统计+合并命令 → 手动 `git merge` 快进合入 → 清理后无孤儿 worktree/分支；子会话双留痕。**计划外**：模型误派只读 scout 执行写任务，结构性失败可见、父代理自行改派成功（M5c 纪律在真实场景再次生效）
  - 已知行为（记录不修）：guardian 路径规则以父目录为基准——worktree 子代理用绝对路径写 `/tmp` 下隔离区会被误报"项目外写入"（防御性误报，相对路径默认行为不受影响）

- **M7 横向加固（2026-09-05，workflow 三并行编排）**：一个 workflow 脚本、三个实现代理、33 个新测试（298→331），串行合并三段。
  - `fix/stats-branch`：`stats()` 改走 `getBranch()`（M5 分支化后旧统计把废弃分支也计入）；线性会话数字不变（钉住）；坏父链文件在列表层按"跳过不致命"处理
  - `feat/gate-confirm`：`ToolCallEvent/ToolEndEvent` 增 `cwd?: string`（执行方工作目录——worktree 子代理的绝对路径不再被 guardian 误报，M6b 已知行为就此修复）；`ExtensionApi` 第 8 个成员 `confirm(message, detail)`（无交互宿主→stderr 教学行+false，绝不挂死；REPL 侧 [y/N] 队列化、Ctrl+C=拒绝）；guardian 两层化（硬底线不问：/etc、~/.ssh、~/.gnupg、rm -rf 指向家目录根；其余先问后拦，拒绝返回原教学文案，print 模式退化为旧行为）
  - `feat/child-compaction`：`compactHistory` 拆出纯计算层（compactSession 变薄封装，行为逐字节不变）；`runSubagent` 镜像主循环 onBeforeTurn 自动压缩（有会话→appendCompaction+buildContext 重建；无会话→纯内存 splice，framed summary 保持回放一致）；`IMP_AUTOCOMPACT=0` 同门控；40 轮上限不重置（压缩买上下文不买轮数，注释写明）；摘要调用失败→保留原历史下轮重试（子代理无外层宿主，catch 即 REPL 对主循环的等价契约）
  - **真机验证**：日记任务子会话 5 个 compaction 条目（小窗口反复触发，轮边界重试路径一并验证）、结构化摘要、压缩后子代理继续完成；guardian print 模式降级端到端（rm -rf → confirm 无宿主 → 拦截 + `[bash]` 审计行 + 模型改道）；TTY 弹问由 fake-stdin e2e 覆盖（y/n/yes/空），真 pty 未测（非交互 shell 不可行，如实记录）
  - **独立审查轮（三份并行 fix-first，2026-09-05）**：裁决 stats=ship-with-nits、compaction=ship-with-nits、gate=**fix-first**。全部发现先对照代码核实再修（`1e59783`，+15 测试）。**gate 两个 P1**：其一，EOF/Ctrl+D 在待答 [y/N] 上崩溃进程（settleAsk 在 resolve 之前对已关闭 readline 调 prompt，ERR_USE_AFTER_CLOSE，等待者永不结算）——改为先结算、仅活流提示；其二，guardian 硬底线对 `~`/`$HOME` 拼写与分离旗标 **fail-open**（`rm -r -f ~/.ssh/known_hosts` 两层全漏、无任何门）——家目录展开（含词内引号）、rmForceRecursive 接受 `-r -f`/`--recursive --force`、底线先于一切层。其余：kill -INT 排空待答队列、NO_CONFIRM 单次上限、失败注释重写；compaction 三次连败熔断+stderr 教学行、子信号转发进摘要调用（持久化仅在全量流后，安全）、崩溃路径轮数/用量带回被摘要量、constants.ts 过时注释；stats 标题同分支、getBranch 线性化、抛错单元钉住。审查要求的三个场景（EOF 中断、FIFO 双问、Ctrl+C 单结算）全部落测。审查会话：imp-m7-review-mtp64ium-hnolu0
  - **编排事故与流程修复**：workflow 的 `worktree: true` 未隔离——三代理共用主检出、互相切分支（代理自行察觉并在报告中说明，分支恰好堆叠成链反而强制了正确合并顺序）；合并链里 `npm run lint | tail -1` 吞退出码致 20 条预存诊断漏网（至少 M6a 起）——管道退役，另花两个清理提交清零（含一个用既有 throwing-script 模式替代豁免注释的教训）

- **M6a 扩展门覆盖子代理**（2026-09-04）：`runSubagent` 透传 `onToolCall` 给子循环；`ToolCallEvent` 增量字段 `subagent?: boolean` + `agent?: string`（现有扩展零改动即覆盖子代理——guardian 的 bash 规则与路径规则自动约束分身）；被拦截的子代理调用返回教学式错误结果，子代理可自行改道。三层测试：runSubagent 单元（透传+拦截恢复）、task 工具（agent 名上下文）、runner 级（真实扩展文件 + 真实 `.imp/agents/` 发现 + 真实 loader）

- 多 provider（抽象出 provider 接口 + 能力探测：工具调用/视觉/思考模式）
- `--mode json` 事件流输出 / RPC 模式（进程集成）
- Skills 机制（按需加载的 SKILL.md 能力包）
- 提示词模板、主题
- GitHub 发布 + `npm install -g`（npm 上 `imp` 短名大概率被占，发 scope 包 `@<user>/imp`，bin 名仍设为 `imp`）；**同里程碑重审扩展信任模型**（pi 的 trust.json + 最近祖先 + `project_trust` 是移植参照）并承接 M4 延后项：sub-agent（经 api 暴露引擎，含 D1 共享 cwd/worktree 决策落地）、交互式权限门（`ui.confirm`）、热加载、npm/git 扩展包

---

## 4. 关键技术设计（提前定死，避免返工）

### 4.1 消息类型（M0 就要设计好）

```ts
type AgentMessage =
  | { role: "user";      content: UserContent; id: string; parentId: string; ts: number }
  | { role: "assistant"; content: AssistantContent[]; /* text/thinking/toolCall blocks */ usage: Usage; ... }
  | { role: "toolResult"; results: ToolResult[]; ... };
```
原则：**内部消息 ≠ LLM API 消息**。内部格式带 id/parentId/元数据，仅在 provider 边界做一次转换。这样换 provider、做会话树、做 compaction 都不碰核心类型。

### 4.2 工具接口

```ts
interface Tool {
  name: string;
  description: string;          // 写给模型看的，质量决定模型用得好不好
  parameters: JSONSchema;       // TypeBox / Zod 生成
  execute(args, signal): Promise<ToolResult>;
}
```
- 工具描述要写"什么时候用/什么时候不用"，这是 prompt 工程的一部分
- 所有 execute 必须可中断（AbortSignal 贯穿）
- 工具报错永远返回给模型，不要让进程崩溃

### 4.3 系统提示词要点（参考 pi 的 harness/system-prompt.ts）

- 身份与能力边界；工作目录；平台信息
- 每个工具的使用规范（尤其 edit 的精确匹配规则）
- 输出风格：简洁、先改后说、给出行号
- **用 eval 来迭代提示词**，不要凭感觉改（见 §5）

### 4.4 截断策略（很容易被忽视的坑）

- bash 输出：默认保留尾部 N 行（错误通常在尾部），超限存临时文件并把路径给模型
- read：50KB / 2000 行上限，支持 offset/limit 分页
- 截断信息必须显式告知模型，否则它会以为看到的是全部

---

## 5. 测试与评估策略

| 层次 | 手段 |
|------|------|
| 工具单元测试 | vitest；bash 用临时目录，edit 测匹配 0/1/N 次三种情况 |
| Agent loop | mock provider（脚本化返回预设的 tool_use 序列），测循环/中断/错误恢复 |
| 端到端 | 准备 3~5 个标准化小任务（修 bug / 加功能 / 重构），脚本化跑通率统计 |
| 提示词/模型评测 | 抄 pi 的 `packages/evals` 思路：任务集 + 评分脚本，改 prompt 前后对比 |
| **Dogfooding** | **最重要的评估**：一旦 M1 完成，就用它开发它自己 |

---

## 6. 风险与坑（按踩中概率排序）

1. **edit 工具匹配失败**：oldText 不唯一/有不可见字符差异。对策：错误信息要教学式，提示模型先 read 再 edit；行尾/空白规范化。
2. **provider 流式协议细节**：tool 参数分块到达时的拼接、usage 在最后一块、思考块与文本块交错。对策：M0 就写几个"录制的真实响应"回放测试。
3. **上下文爆炸**：工具输出不截断 → 几轮就满。对策：M0 就做截断，不要拖。
4. **过度设计**：一开始就想做扩展系统/多 provider/权限系统。对策：严格按里程碑，M0~M2 期间禁止加非计划功能。
5. **TUI 深坑**：终端兼容性、ANSI 转义、重排性能。对策：REPL 撑到实在不够用再上 TUI。
6. **bash 工具安全**：模型可能执行破坏性命令。对策：早期靠系统提示词约束 + 自用自觉；正式做权限门放在 M4 扩展。

---

## 7. pi 源码阅读地图（按里程碑）

| 里程碑 | 必读 | 选读 |
|--------|------|------|
| M0 | `agent/src/agent-loop.ts`（核心中的核心）、`agent/src/types.ts`、`ai/src/types.ts`（消息/流事件）、`harness/tools/bash.ts`、`tools/read.ts` | `agent/src/stream-fn.ts` |
| M1 | `tools/edit.ts`、`tools/edit-diff.ts`、`tools/write.ts`、`harness/system-prompt.ts`、`utils/truncate.ts` | `tools/file-mutation-queue.ts` |
| M2 | `harness/session/`（4 个文件）、`harness/compaction/compaction.ts`、docs：`session-format.md`、`compaction.md` | `session/memory-repo.ts` |
| M3 | `tui/src` 组件目录结构、docs：`tui.md` | `coding-agent/src/modes/interactive/` |
| M4 | docs：`extensions.md`、examples/ | `coding-agent/src/core/extensions/` |

阅读方法建议：**不要通读**。每个里程碑只读对应文件，且带着"我要实现什么"的问题去读，边读边在自己的简化版里落地。

---

## 8. 本周就可以开始的 M0 第一步

1. `cd imp && npm init`，装 typescript / tsx / vitest / typebox
2. 写 `src/provider/anthropic.ts`：一个函数 `stream(request): AsyncIterable<Event>`
3. 写 `src/core/loop.ts`：先不支持工具，只做流式对话 —— 跑通第一轮对话
4. 加 bash 工具 → 见证第一次自主工具调用 🎉
5. 把 pi 的 `agent-loop.ts` 打开对照，逐段理解它比你多处理了什么（steering、重试、并发工具、abort 恢复…），记进 TODO
