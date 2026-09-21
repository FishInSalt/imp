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

- **M8 独立对抗审查轮（2026-09-07，`64e68f2`→`3b7d8a7`，386 tests）**：三路并行只读审查（run `imp-m8-review-mtra8f8f-wd1ocr`，280.9K tok），裁决 trust-gate=ship-with-nits、tier-scope=ship-with-nits、**worktrees=fix-first（1 个 P1）**。全部发现先对照代码核实再修（+17 测试）。
  - **P1**：`/worktrees` 的 "merged — safe to delete" 在 worktree 仍有未提交文件时照说——`merged` 只测分支祖先，未提交-only 的回传（子代理没 commit、只留文件）tip==基点==祖先，**唯一成果文件被 UI 亲口批准删除**。修复：删除安全 = 无可合并 **且** 无未提交两层都要；merged+脏显示 "merged, but uncommitted work remains: <stat>"
  - 其余修复：统计基点改 merge-base（main 前移的新提交不再算成子的删除行；patch 等价条目改从分支尖端 diff，只显真实未提交）；squash/cherry-pick 用 `git cherry` 检测 → "already in main — safe to delete"（不再建议产生空 merge）；主检出永不入列（目录名撞 `imp-worktree-*` 也不）；目录被删的 worktree 提示 prune；命令改 awaited（输出不再乱序）；"untracked:" 只列 `??`（M6b 起修改过的文件被错标未跟踪）；**ask 三态**——EOF/Ctrl+C 是取消（本会话拒绝、不落记录；掉线的 SSH 不再变成永久拒绝）+ 显式 SIGINT 监听（pause→close 是未文档化的运气）；**store 原子写+锁**（撕裂读砖死、并发丢更新实测 120 丢 52）；坏 store 的错误文案带恢复法，且 `--trust`/`--no-trust` 可重建（自证的恢复命令不再被它要修的损坏砖死）；`cwd==home` 不再门掉自己的全局 agent（pi 的豁免，移植漏了）；task 工具在被门掉时说明原因而非谎报"没有 agent"诱导模型去未信任仓建文件；ask 点名 cwd+文件数；HELP 补 `-e` 不走门、`--trust` 措辞
  - **审查流程新知**：`subagent` 载体的 `reviewer` 是只读工具白名单，嘱托含"可跑 vitest"会被宿主判为实现任务直接拒——对抗审查改走 `workflow` 工具通用代理（M7 同款）才通；审查代理 PTY 探针自身 bug 把一条垃圾记录写进了真实 `~/.imp/trust.json`（如实披露、已清理）；真机复验：merged+脏、坏 store+`--trust` 重建均过

- **M9 TUI 表现层迁移（2026-09-08，两阶段，444 tests）**：交互壳从 readline 迁到 pi-tui（`@earendil-works/pi-tui@0.82.0` 精确钉版），核心零依赖不变——状态机、print 字节契约、legacy 逃生门（`IMP_REPL=legacy`）全部保留。
  - **第一阶段（`35968f5`+审查修 `51d749c`，合入 `07a3982`，400→417 tests）**：`src/tui.ts` 薄边界（约 50 行 re-export）+ `TranscriptSink`（Renderer 字节流→pi-tui 组件：`\n` 结行/`\r\x1b[2K` 重写/宽度契约换行）+ `TuiShell`（pi 布局：transcript+ask+标记+editor；ask FIFO、Ctrl+C/D 语义、自记 history）+ `ReplMachine` 零改动（input 抽象为 `LineInput` 接口）。三路对抗审查（385K tok）全部 fix-first：2 个 P0（render(width) 无视宽度→pi-tui 抛未捕获异常杀进程；kitty 释放序列双触发 Ctrl+C）、3 个 P1（合并块里的重写标记被吞、addToHistory 从未调用→上箭头召回从未工作、优雅退出注被同 tick 停机+process.exit 双杀）全部修复；cli 收尾改 `exitCode` 自然退出让最后一帧上屏（真 pty 验证）
  - **第二阶段（`219fa44`+两路 worktree 代理+审查修，444 tests）**：①footer 底部状态行（model·session·累计 tokens，机器四点推送）；②折叠 diff（Fold 组件+ctrl+o，机器 tool_end tap 把 edit 结果的 "summary:\n diff" 变成折叠——真实生产者，审查 P1 抓出的空接线即修）；③选择器（TuiShell.select：SelectList、焦点接管、Enter 选/Esc/Ctrl+C 取消、重入拒绝、ask 延迟到关闭后、SIGINT 拆卸）+ /model 无参走选择器（legacy 字节不变）；/help 补键位说明
  - **并行流程首试成功**：worktree 可靠性探针先行（上次失败根因=未传 `cwd`）；两路 worker（`context:"fresh"`+自足嘱托）真隔离、各自 424/429 tests；**worktree 分支会随运行清理——完成后须立即抢救悬空提交**（rescue/* 分支）；合并冲突 4 处全是接口并集，手工保序（键路由：release→selector→ctrl+c→ctrl+d→ctrl+o）；双路审查（语义=fix-first 2 P1、完整性=approve 9 P2）全部亲证后修（+6 回归测试：启动即 footer、命令后刷新、选择器后 Ctrl+C 复活、重入拒绝、ask 延迟、SIGINT 拆卸、dim 原始字节、编辑真工具端到端折叠）

- **M10 交互手感三路并行（2026-09-09，第一波，500 tests，feat/m10-wave1）**：目标=对齐 Claude Code 2.1.88 交互面的 90%（对照其还源源码 144 组件实测，明确放弃语法高亮/checkpoint/transcript 检索/vim/主题/成本显示）。第一波三路 worktree 代理并行+单作者集成：
  - **Lane A 输入手感**（`da612b3`）：**降本发现**——pi-tui 0.82 自带 `CombinedAutocompleteProvider`（行首 `/` 命令过滤+任意位置 `@` 文件模糊补全、引号路径、fd 快路径），从“造组件”降为“接线”（`tui.ts` 边界再导出+`runRepl` 映射 COMMANDS→SlashCommand）；placeholder 提示行（Editor 无 API，shell 自绘 dim 行于 ask 与 marker 间，空输入+idle+无待答时可见）；`! cmd` 直通（机器层，经 `Runner.getTool("bash")` 执行 runner 同实例——新增 4 行访问器，测试假件直达；echo dim 行+输出块+非零退出码注记；活动时排队、刷新时保持 bang 语义；单独 `!` 教学提示）；Esc 中断运行回合（键路由插在 selector 后、ctrl+c 前；已知双重消费边角=补全面板开着时 Esc 同时关面板+中断，无 API 可查面板态，接受并写进 HELP_KEYS）；HELP_KEYS 补全键位+多行回归钉住
  - **Lane C 确认体验**（`1209dd5`）：`confirm(message, detail?, {sessionKey?})` 三参扩展（向后兼容）；宿主三选项 [Yes / Yes-session / No]+会话 Set 放行表（无 select 壳字节不变 [y/N]）；guardian 两处 confirm 透传 sessionKey（bash=命中 pattern、越界写=cwd）；/resume 无参走选择器（前 20 会话 id8·时间·条数·预览）；/sessions 尾行提示；队列可视行 `setQueue?`（ask 后 dim 行，0 行消失；push/steering 消费/flush/Ctrl+C 清队四处同步）；**trust 首跑对话框按简报退路放弃**——扩展加载在 TuiShell 构造前、重构> 40 行预算，readline [y/N] 原样保留
  - **Lane D 独立小件**（`fbe15c8`）：`decorateDiffLines` 折叠着色（+/－/@@头/上下文四色）+新文件行号槽（`@@ line K` 推导，右对齐 dim 槽，删行不增；无头行容错降级为纯着色）——diff 原文一字不动；footer `ctx N%`（`estimateContextTokens(runner.history)` 同一活数组，`IMP_CONTEXT_WINDOW` 缺省 131072；≥80% 追加提示+一次性 note+回落重置）；终端标题 OSC2（`setTitle?` 直写 stdout 不走帧管线，start 缓冲+teardown 清空）
  - **集成**（`05305ef`→`089c8ef`→`930ea86`，A→C→D 序）：9 处冲突全为接口/布局/测试并集型，保序决策：布局 ask→queue→hint→marker→editor；flushQueue 先 `syncQueue()` 再 bang 拦截（bang 提前 return 时队列显示仍刷新）；两处 git“共同尾部”误判丢测试收尾括号（tsc/esbuild 双道抓回）。真机 pty 冒烟：启动帧 placeholder+ctx%+title ✓、补全面板 `→ help` 实时过滤 ✓、bang echo+输出+教学提示 ✓、/exit 干净退出 ✓；**ESC 只关面板不清文本**（readline 惯例）——冒烟脚本第一版误判为 bug，修正序列后通过
  - 代理施工质量：三路各自 469/463/456 全绿+build+biome 与基线零新增；两处越界（A 的 runner.ts/tui.ts 经 supervisor 批准、C 的 registry/loader/cli 签名级穿透 sessionKey 必需链——集成方追认）

- **M10 B 批流式路径（2026-09-09，`f066b1a`+`51f0b1a` 前身修，506 tests）**：单作者实现（第二波，原 M9 清单 #2+#4）。**关键架构发现**：Renderer 的 `liveTools=false`+one-line 语义正好就是活动区模式（pending 静默登记、think() no-op、tool_end 永久写 ✓/⎿ 行）——Renderer **零改动**，print/legacy 字节契约天然无忧，cli 只改一个开关（`liveTools: interactive && transcript===undefined`）
  - **活动区**：`LineInput.setActivity?(snapshot)`（tools/agents 纯数据行，机器每次事件推送）；壳侧 120ms ticker 拥有 spinner 动画与秒表（elapsed 由 startedAtMs 现算，机器不重推）；布局 folds→activity→ask；close() 停表
  - **事件中继**：`RunTurnOptions.onEvent` 加 `AgentEventInfo`——task 工具构造期拿不到每回合 tap，加 `turnEventTap` 回合级持有者（finally 清空）；子事件带 {agent,cwd} 到机器、**顶层事件不带 info**（M5"渲染器零子事件"规则改在机器 tap 强制）；子 edit 折叠维持 M9 语义（仅顶层）
  - **踩坑三连**（全被测试抓回）：①`returnToIdle` 开头清场时 state 尚为 running→快照算成 thinking、行与 ticker 不死——`clearActivity` 显式推 idle；②无名 agent 的子事件（info={agent:undefined}）掉进顶层工具分支污染工具行——分类改按 info 是否存在而非 agent 名；③脚本化子代理整个回合短于一个渲染间隔、行从未上屏——测试门控子的首个模型响应拉长窗口（帧闪断言不可靠，子事件中继另立 runner 级测试钉住）
  - **task 行标签**：summarizeArgs 无 task 摘要器→原始 JSON 上屏；改用 `args.prompt`（shorten）作标签
  - **真机（含一次经批准的真 API 回合，GLM）**：! bang/placeholder/footer ctx%/saved note 全过；活动区视觉链全程可见——`⠋ thinking…` 帧轮转、`⠴ bash $ echo …` 工具行、`● … ✓`+`⎿` 完成对、模型答复、footer `↑2.8k ↓19 · ctx 2%` 更新、干净退出；TUI 转录区无 pending 重绘字节（`●` 仅出现在永久完成行——正是 liveTools=false 的预期拆分）
  - markdown 增强按计划放弃：dim 渲染已显示语言标签，真正的提升只有语法高亮（M10 明确出局项）

- **M10 对抗审查闭环（2026-09-09，`c4a88bc`+修复批，512 tests）**：完整性路（无 P0/P1，6 P2 全修：legacy 低上下文 note 门控、中断 bang 弃队、picker 下藏提示行、子事件过滤/中断清场/布局顺序三处空真补钉）+ 语义路重跑（GO with notes，8 猎区全过：! 直通零模型副作用、嵌套 task 构造性排除、ctx% 无闪烁、turnEventTap 生命周期充分）
  - **P1 抓获**：测试文件一处非 authored 内容（`<arg_value>(<b88a6f17>await settle(0))`）——vitest 擦除断言不解析名字、tsc 只查 src、biome 无类型感知，三道门全盲。修复+**新增测试类型检查门**（`tsconfig.test.json` 挂进 `typecheck` script），顺带清掉 31 个存量测试类型债——其中抓出**真封闭性破坏**：两条子代理测试传错属性名（`agentsHome`≠`agentsHomeDir`），scout 实际来自真实 `~/.imp/agents`（换机即红）；以及 fakes 里一处不存在的 `settle` 死导入
  - **P2 修复**：stdin `end` 镜像 SIGINT 先拆选择器（死 pty 不再挂死 confirm 门）；**重入 select 从"拒绝"改"排队"**——guardian confirm 在 /model picker 开着时到达仍会被问到（旧行为静默否决、用户从未见过问题）；close() 排空队列 promise
  - 接受不修（cosmetic）：bang 的 `(exit N)` 剥离可被 stdout 尾部伪造（构造苛刻、纯显示误标）
  - **教训入账**：名字级损坏只有类型检查能抓（擦除式转译+无类型 linter 双盲）；并行代理的测试也要进类型检查面

- **M10 dogfood 修复（2026-09-09，514 tests）**：用户实测报两处——①**提交的提示词不回显**（TUI 编辑器清行后转录区只剩回答，print 模式靠 readline 终端回显所以没人发现）→ `Renderer.user()`（每物理行一个 `> ` 前缀）+ `submitTurn` 在 `setFooter !== undefined`（TUI 门）下调用，flushQueue 走同一路径故排队转正也回显；②**每回合双行统计噪声**（run 行 + session cumulative 行，而 footer 已带 cumulative）→ `printSessionStats` 改 print-only（`setFooter === undefined` 门），TUI 只留一行 turn 统计——与 CC 的单行 turn status 对齐。print 字节零变化（两处均门控）。教训：**回显类体验没有 e2e 钉子就等于不存在**——此前 512 个测试没有一个断言"问题行可见"；本次补 render 单测 + TUI e2e 双钉

- **M10 dogfood 第二批（2026-09-09，522 tests，`a41ed7a`）**：用户实测再报两处——①**非 bash 工具行显示原始 JSON**（`● find {"path":…}`）→ `summarizeArgs`（format.ts 单漏斗：print 工具行/TUI 转录/replay/活动区共用）为六个内建工具出友好标签：read=`path · from line N · limit N`、write/edit=`path`、grep=`"pattern" in path (*.ts)`、find=`pattern in path · files`、task=`(agent) prompt`（shorten 截断）；未知/扩展工具保持紧凑 JSON；bash 保持 `$ cmd` 字节不变；`shorten` 移到 format.ts 导出。②**`>`/`+` marker 行是 readline 遗物**（pi-tui Editor 本身画全宽边框盒=CC 式输入框，hint 的 idle 门+活动区已编码同一状态位）→ marker 行删除，钉子改锚 hint 可见性/活动区/编辑器边框。**顺带大发现**：pi-tui `Text` 构造默认 `paddingX=1, paddingY=1`——shell 所有布局 Text 各多烧两行空白+一列缩进（idle 屏 12 行）→ 全部显式 `(text, 0, 0)`，idle 屏降到 5 行（hint+边框盒+footer），全部 flush-left。print 字节变化仅工具行标签（用户要求的功能性变更，两模式统一、钉子同步）；新增 test/format.test.ts（8 例）+ flush-left 钉子。**流程教训**：本批改动误直接提交到 main（漏跑 checkout -b，同名旧分支迷惑）——未做 reset 修整（高危需确认），留此记录；后续批次恢复分支纪律

- **M11 交互批 #1+#2+#3+#7+#8（2026-09-09，527 tests）**：①**工具结果可展开**——`Renderer.foldedResults` 新选项（默认 false，print 字节零变化）：TUI 下成功结果不再写 `⎿` 行，改挂折叠（标题=`summarizeResult` 预览，正文=完整内容，400 行防御性封顶），Ctrl+O 展开；edit 沿用装饰 diff 折叠；错误结果保留红 `⎿`（醒目、通常短）——测试挂具同步 cli.ts 接线。②**bash 预览跳过 `stdout:` 段头**：`summarizeResult(name, content)` 单漏斗（⎿ 与折叠标题共用），首行取真正输出、(+N) 计数扣除段头；two-line print 的 `→` 行同步（显示层变更，模型所见结果内容不变）。③**排队双显去重**：`▪ queued:`/`▪ continuing with queued:` 两处 note 以 `setQueue === undefined`（legacy 判据）门控——TUI 的 queue 行+回显已覆盖，print 不变。④**/status**：model/session(msgs+cumulative)/context(~tokens+%of window，≥80% 带 /compact 提示)/project trust（最近祖先条目）四行只读汇总，`allowedDuringRun: true`；`contextWindowTokens` 移到 constants.ts（避免 commands↔repl 环依赖）。⑤**运行态中断提示**：hint 行内容随状态切换——idle=`(/ @ ! newline)`、running=`(esc to interrupt · typed lines queue)`（顺带宣传 steering）、ask/selector 开启时清空。**测试纪律收获**：child-edit 旧断言全为 `not.toContain`（帧未冲刷时空洞通过），正向断言暴露后改为 waitUntil 等终端帧而非 sink；新增折叠展开 e2e、排队去重 e2e、/status 单测、summarizeResult 单测 6 例

- **M11 对抗审查闭环（2026-09-09，531 tests）**：两路并行（字节契约路+语义生命周期路，审 `8044228..main` 三批次），无 P0，2 P1 + 一批 P2，全部核修（`fix/m11-review` → main）：
  - **P1-A（bytes）**：`summarizeResult` 非 bash 分支只查 `lines[0]`——旧 `firstLine` 语义是"首个非空行"，首行空白的文件（markdown 常见）误报 `(no output)` 且属未申报字节漂移 → 改 `firstLine(remainder)`，钉 `read "\nfoo\nbar"` → `foo (+2 lines)`
  - **P1-B（semantics）**：`stopSpinner` 在 liveTools=false 清空 pendingTools——M11 `/status` 允许运行中执行后，慢 bash 中途 note 会让完成行降级为 `● bash ✓`（丢 `$ cmd` 标签与时长）→ 非 liveTools 分支不清，`endRun` 在回合边界清（防跨回合泄漏）；钉"note 中途到达完成行保留标签"
  - **P2 修复**：summarizeArgs 内建分支 fallback 补 120 截断；折叠体尾换行不再计幽灵行（标题与正文同规则 pop）；`Fold` 加 `decorate` 开关——非 edit 折叠不再被 diff 着色误染（`ls -l` 的 `-rw` 行变红）；FOLD_LINE_CAP 400→2000（≥各工具自身截断）；扩展工具恰好名叫 `edit` 且无 `":\n"` 契约时从"预览全丢"改为落入通用折叠；/status trust 块 try/catch 降级+cwd 口径统一 process.cwd()；HELP_KEYS/setActive/多处注释与测试标题随 marker 删除/折叠泛化更新；repl-status 挂具补 `foldedResults: true` 对齐 cli 接线
  - **接受不修（记录）**：错误结果不折叠（bash timeout 的 Partial output 长错误无展开途径——v1 对称性缺口，后续批次）；foldContainer 与 transcript 同为无上限且 /new 不清（pre-existing 债务）；Ctrl+O 只切最新折叠（v1 声明的设计债，候选做循环导航）；bash 预览 `(+N)` 含段间空行与 Exit code 行（显示口径，无害）
  - **审查质量注**：两路各自独立发现了 P2 级共同项（diff 误染、尾换行、/status 容错、陈旧文案）——双路交叉印证有效；reviewer 只读无 shell 的约束下报告 file:line 精度可用

- **M11 收尾批 #4/#9/#6（2026-09-09，550 tests，两分支两合入）**：
  - **#4 输入历史跨会话持久化**：`~/.imp/history.jsonl` 全局单文件（bash 惯例），连续去重、2000 行压缩、全部 fs 尽力而为（历史绝不拖垮 REPL）；TuiShell 启动时取尾部 100 条播种编辑器召回；`historyPath` 选项注入（挂具缺省=不持久化，封闭性保持）；cli 仅 tui shell 传真实路径
  - **#9 选择器打字过滤**：`SelectOptions.filterable`——打开期间可打印键累积为大小写不敏感子串查询（匹配 label+description，含 IME/中文提交块），退格编辑；Enter 解析**原始索引**（过滤永不改接线）；键消费走 shell 预聚焦监听器（选择器优先级链内）；/resume 启用、/model 不启用（行数少）
  - **#6 markdown 快捷命令（CC parity）**：`~/.imp/commands/*.md`（全局）+ `<cwd>/.imp/commands/*.md`（项目，过 M8 信任门——"clone 即多出会跟模型说话的命令"不可接受）；文件名=命令名（`[a-z0-9][a-z0-9_-]*`，与内置同名拒绝）；frontmatter description/allowedDuringRun；`$ARGUMENTS` 替换（无占位符则参数追加成段）；经 `CommandContext.submitPrompt`→机器 `enqueuePrompt`（idle 开回合/运行中排队，不经 handleLine 重路由——正文以 `/`/`!` 开头仍是模型内容）；项目级覆盖全局级；/help 带 `md:project`/`md:global` 层级标签；复用扩展命令管道（冲突规则/列表自动生效）
  - **踩坑记录**：①select 重写时漏 `box.addChild(list)`——6 测试齐红（选择器内容断言类全挂、取消类照过=空洞安全的旧问题再现）；②pi-tui `readFileSync` 不在 node:fs/promises、Editor 历史导航要求编辑器空/首行+空条件——上箭头召回用 DBG 钉子逐步定位（文件✓/getHistory✓/帧✓）；③差分帧断言纪律再确认：过滤后消失断言必须 post-mount mark

- **M11 收尾批对抗审查闭环（2026-09-09，556 tests）**：两路（字节契约/边界 + 语义/生命周期），无 P0，2 P1 + 一批 P2 全核修。**流程注**：本批交付时先漏跑了独立审查（用户追问"有没有独立审查过"后补上）——此后每批交付显式给出审查评估结论
  - **P1-1（两路交叉命中）**：`.imp/commands` 不在 `trustRequiringResources` 清单——commands-only 仓库走空资源早退，项目级 md 命令零门槛加载（含已记录不信任/--no-trust 的目录），违背模块自述"cloned repo must not grow commands that talk to the model"→ 清单加一项（一行）
  - **P1-2**：`enqueuePrompt` 排队的 md 正文以 `!` 开头时，flush 被 `isBangLine` 命中→**当 bash 执行**（违背三处自述"body starting with '/' or '!' must stay model content"；idle 路径正确、仅排队路径错）→ 队列改联合类型 `string | { prompt }`：打字行保持旧路由、prompt 项 flush 直达 submitTurn 且**不参与 steering**（按文档语义排队在回合后）；steering/flush/preview/discard 四处适配
  - **P2 修复**：历史文件改 append 快路径（并发竞态窗口从整文件缩到一行；超限才压缩重写）+MAX_LINES 注释改真；shell.history 播种改 unshift（newest-first 契约——原 push 让连续去重比对最旧行、可跳过一次持久化）；filterKey 识别 bracketed paste 剥壳取首行（原方案整块丢弃）；md 解析剥 BOM（Windows 编辑器）；NAME_RE 去 `/i`（大小写敏感派发下大写文件名=没人敲得出的命令）；扩展命令名并入 reserved（同名静默遮蔽+/help 双行→诊断行）；HELP_KEYS 补 type-to-filter；submitPrompt 对扩展命令可见性注释记录
  - **接受不修（记录）**：历史文件与 trust.json 的锁纪律不对齐（best-effort 声明在案）；scripted REPL 也加载 md 命令（与扩展命令行为一致，非契约破坏）
  - **补钉**：!-前缀排队转正 e2e（模型收到原文+无 bang echo）；过滤退格清空/无匹配/Esc 取消；md allowedDuringRun:false 中途拒绝；commands-only 信任门；BOM/大写/扩展名冲突单测——共 550→556

- **已声明设计债全量清偿（2026-09-09，565 tests，feat/debt-clearance）**：范围=A 折叠三债 + B 交互四债 + C 健壮性两项 + D 测试面两项 + #16；E（M10 出局项）与 #5/#10（需产品决策）不动
  - **A1**：Ctrl+O 改展开/收起**全部**折叠（v1 只切最新——回合中间结果永不可达）；Fold 增 isExpanded/setExpanded，HELP_KEYS 同步
  - **A2**：错误结果也折叠（红箭头红标题，FOLD_LINE_CAP 封顶；`● tool ✗` 行保住醒目度，红 `⎿` 预览行在 foldedResults 下取消——print/legacy 字节不变仍走 `⎿`）
  - **A3**：`TranscriptSink.clear()` + `foldContainer.clear()`；/new 先清屏再落 note（顺序反了 note 会被清掉）；/resume 回放前清屏（原先旧会话内容+回放追加混排）；输入历史不清（是用户自己的召回）
  - **B4**：**trust 首跑对话框 TUI 化**——`src/repl/trust-ask.ts` 一次性询问壳（start→select→close，同一 TranscriptSink），三选项 Yes/No/session-only，Esc=掉线拒绝（不记录）；legacy/print 路径字节不变；`TrustAskAnswer` 三态映射既有记录规则（session-only 新增：本会话加载不记录）
  - **B5**：Esc 双重消费边角修复——pi-tui Editor 有 `isShowingAutocomplete()`（此前无 API），补全面板开着时首 Esc 只关面板不打断
  - **B6**：bang `(exit N)` 伪造修复——`ToolExecuteResult.exitCode?` 结构化字段（bash 填充），注释只信结构化值、剥离只匹配真实 code；伪造行降级为普通内容
  - **B7**：`summarizeResult` (+N) 只数内容行（空行/Exit code 行不再膨胀计数；段头保留——展开时真实可见）
  - **C**：history 追加包进 trust.json 式文件锁（压缩重写的读-改-写竞态）；README 新增 md 快捷命令章节（含 scripted 模式规则）
  - **D**：`frameSince` 写边界加固（跨帧粘连假阳性）；IME 组合窗口假设写进 README known limits；#16 resize 回归钉子（FakeTerminal 模拟 SIGWINCH，宽折叠重截断）
  - **踩坑**：scripted provider 测试要喂助手消息流而非裸 tool_end；pty 里 /tmp 解析为 /private/tmp；帮助文案改 HELP_KEYS 需同步 repl-commands 字节钉；closes 时序（note 后清屏=note 消失）——/new 清屏必须在 newSession **之前**

- **设计债清偿批对抗审查闭环（2026-09-09，566 tests）**：两路（字节/边界 + 语义/生命周期），**P0/P1 同一条两路独立命中**（第三次交叉印证）+4 P2 全核修
  - **P0（ask 壳交接竞态）**：trust-ask close() 的 40ms 延迟 stopTerminal 与真壳 start 无屏障竞态——热缓存下真壳 40ms 内起完，随后 ask 的停机在真壳脚下 pause process.stdin（输入死）+清共享 sink 的 onUpdate（流式不重绘）。修复：`TuiShell.whenSettled()`（停机真跑完才 resolve；未启动壳立即 resolve）+trust-ask await 之；加固：stopTerminal 只在 onUpdate 仍指向**本壳闭包**时才置 null（boundOnUpdate 属主校验）。钉子：ask promise resolve 时 terminal.stop 必已发生；pty 冒烟=选择后 0.3s 即输入仍存活
  - **P2**：bang 截断场景 exit code 双显（截断段在 Exit code 段之后→正则不匹配→正文+note 各一次）→ note 只在真正剥离时发；history 锁 degraded 分支 unlink 活锁可级联破坏互斥（A 的 finally 删掉 C 的新锁）→ 与 trust 完全对齐（降级不删锁）；Esc 注释过度声明（debounce 窗口内仍会中断+迟弹面板，上游 cancel API 未公开）→ 措辞修正；clearView 接口文档"after"与实现"before"相反→修正；transcript.ts clear() 插在 feed 文档注释与 feed 之间→注释归位；frameSince 第三份副本（repl-status）漏加固→同步+两份已加固处补"合成换行不得跨 write 断言"文档
  - **报告级接受**：Ctrl+O 全展开的单帧 O(总行数) 截断计算（展开全部的固有代价）；summarizeResult 对所有工具滤 `Exit code: N` 行（read 日志含此行时 +N 少计——与"status-y 行"框定一致）；ask 壳 close 后 ≤40ms typed-ahead 被吞（与 M8 F9 同类 cosmetic）

- **#10 会话树 批次 1：/fork（2026-09-09，576 tests，feat/fork-batch1）**：设计评估修正——M2 起存储层就是 pi v3 树格式（id/parentId、leafId、getBranch、append-only），缺的只是操作与界面层，成本从"另一个量级"降为两个半天批次。三决策（用户拍板"按建议来"）：fork 边界跟 pi（选中用户消息→从其**之前**分叉，该条重说）；切换摘要默认开+`IMP_BRANCH_SUMMARY=0` 关（批次 2）；/fork 弃尾不摘要（旧枝在文件里，/tree 可回——批次 2）
  - **存储**：`store.forkBefore(entryId)`（校验=用户消息+在当前分支上；leafId 移到目标 parentId；返回 retained/abandoned 计数）+ `userForkPoints()`（当前分支用户消息 oldest→newest，含最新一条=重做末轮）
  - **runner**：`forkSessionAt`（镜像 resumeSession：history 清空重载 buildContext——同一接线）+ `forkPoints`（预览=shorten(userText)）
  - **命令**：`/fork` 无参 TUI 弹 filterable picker（复用 #9）；`/fork <n>` 数字直选（legacy 文本回退=编号列表+教学行，契约"缺 select 必须有文本回退"）；成功后 clearView→replay（/resume 同款流）+ note `▪ forked before "…" — N kept, M left on the old branch`；allowedDuringRun:false
  - **语义自查**（已核）：steering user 消息只注入在 toolResult 之后→fork 保留路径永不以悬空 tool_use 结尾；fork 点在旧 compaction 之下→新路径不含该 compaction（回到压缩前全文=设计语义）；auto-compact 闩随 ctx% 重挂
  - 钉子：store 4 例（分叉/首条前清空/非用户与他枝拒绝/分叉点枚举）+ 命令 5 例 + e2e（真 picker 过滤选点→fork 后**下一个模型请求**不含弃尾内容、屏幕清除需 post-fork mark）+ /help 金样与 known 行同步；pty 真机：GLM 冷启动下时序放宽后全链路通过
  - **流程**：批次 2（/tree+branch_summary）落地后**合并为一轮对抗审查**覆盖两批交互面（存储核心已在批次 1 自查+钉子覆盖）

- **#10 会话树 批次 2：/tree + branch_summary（2026-09-09，585 tests，feat/tree-batch2）**：pi 的 BranchSummaryEntry 思想落地——切走时给被弃分支生成 LLM 摘要写进新分支上下文（"换思路不丢教训"）
  - **存储**：`BranchSummaryEntry`（type/parentId/summary，参与上下文不进 stats）；`otherBranchTips()`（叶子枚举=分叉目标，label=分歧段首条用户消息+消息数）；`splitBranches()`（最长公共**前缀**拆分两侧分歧段——初版误写为后缀剥离，单测当场抓回）；`switchBranch()`（目标必须是叶子且不在当前路径）；`appendBranchSummary()`
  - **摘要**：`summarizeBranchSegment`（复用 serializeForSummary+流式收集，独立 prompt：What was tried/Outcome & learnings/Worth carrying over，≤200 词）；runner `switchSessionBranch`（切换前取 abandoned 段→摘要→追加在新 tip 上→history 重载）；`IMP_BRANCH_SUMMARY=0` 关（对齐 IMP_AUTOCOMPACT 先例）；失败 best-effort（照切不摘要）
  - **上下文与回放**：`branchSummaryToMessage` 框架消息（`[Branch summary — …]` 惯例同 SUMMARY_MARK）；buildContext 两个分支（有无 compaction）都展开它；replay 检测 BRANCH_MARK 渲染为 dim 块（note 引导行"a direction you left, kept for context"）
  - **命令**：`/tree` picker（filterable，条目=`label · #N · M messages`）+ `/tree <n>` 文本回退 + 无分支教学行；切换后 note 报告 summarized 与否；/fork 的 note 追加"(/tree switches back)"
  - 钉子：store 3 例（tips/split/switch 拒绝面、branchSummary 往返+stats 跳过）、命令 6 例（含摘要方向性：**摘要覆盖被离开的分支**、共享主干不重摘、摘要请求恰一次）、e2e（fork→新枝写→/tree 切回→摘要请求只含弃段→下一请求携带 `[Branch summary —` 框架+旧枝内容、q3 原文仅经摘要进入）；/help 金样与 known 行同步
  - **踩坑**：①多脚本 python 编辑中一段结果误写临时文件未回源文件（/tree 命令"消失"但测试全绿=金样没破——测试全绿≠功能落地，功能性新增必须金样先行红后绿）；②测试方向性错误（摘要在被离开侧，测试却断言目标侧）——语义断言先想清楚"谁被弃"；③TS 的 AgentMessage 联合类型上 .content 需 UserMessage 谓词收敛
  - **审查计划**：与批次 1 合并发两路对抗审查（存储语义+命令生命周期交互面）

- **#10 会话树两批对抗审查闭环（2026-09-09，590 tests，fix/tree-review）**：两路（存储语义/不变量 + 命令生命周期/交互）。命令路 BLOCK（2 P1）、存储路 OK-with-notes（4 P2）——其中"写位置不落盘"两路都发现（定级 P1/P2 分歧，按 P1 处理）。全部核修：
  - **P1-1 摘要窗口裸奔**：`/tree` 的 5-20s summarize await 期间状态机保持 idle——窗口内打字会**对陈旧 history 直接开回合**（更糟于进队列）；`/new`//resume` 可令 runner.session 与 runner.history 指向不同会话（await 返回后无条件重载把新会话 history 覆盖成旧分支）。修复：runCommand 把 tree 与 compact 同等置 "compacting" 态（setActive+isActive 拒并发命令+finally flushQueue）+ runner 侧 await 返回后 `sessionStore === store` 属主守卫（纵深防御）。e2e 钉：窗口内输入进队列（无第 5 请求）、/new 被拒、释放后队列行 flush 成新分支上的真实回合；真机复现 "1 queued · next: …"
  - **P1-2 写位置不落盘**：fork/switch 只改内存 leafId，重启 open() 取文件末行=被弃分支；fork 后未写即退出→fork 彻底不可见（note 却承诺 "/tree switches back"）。修复：文件级 position 标记行（`{"type":"position","leafId"}`，**非树节点**）；重开规则=末位树 entry 优先于更早的 position（追加自带 leaf），position 仅在无后续追加时生效——fork/switch/切回后追加全部语义自洽；损坏 id 忽略回退末 entry；torn 末行（恰是 position）天然安全。钉子：fork-无写-重启 leaf 受位+弃枝可列、append 后 entry 胜出、null leaf、corrupt id
  - **P2×4**：/tree 前置进度 note "▪ switching branches…"（原来 20s 死空气+Ctrl+C 提示误导退出——退出恰好踩 P1-2）；摘要结果四态（written/empty/disabled/failed）note 精确化+catch 落 run_log（原先 disabled 与 failed 同句不可诊断；空弃段曾谎报 failed）；getBranch/SUMMARY_MARK 契约注释归位×2（M10 同类踩坑再现）；tip label 改 firstLine（首行空白的多行消息曾出空标签）
  - **F4 补钉**：branchSummary 落在 compaction 之后的 else 分支（帧序 SUMMARY→retainedTail→BRANCH→后续）此前零覆盖
  - **接受（记录）**：巨大弃段摘要请求无总量截断（serialize 只截单条）——超窗报错被 catch 降级为无摘要切换，best-effort 声明内；switchBranch 第三重校验为防御性死代码；"N messages here" 含摘要帧（与 /resume 同口径）
  - 踩坑：测试期望两次写错语义方向（fork 后未写的分支无 tip；重启后 otherBranchTips 为空）——**树操作的期望值要沿叶子存在性推演**，不能凭直觉

- **#多 provider 批次 0：OpenAI Chat Completions 通用层（2026-09-10，600 tests，feat/openai-compat）**：动机=用户持有 OpenAI（ChatGPT 订阅凭证）与 z.ai 两家 coding plan，要求支持且尽量通用。市场事实：主流厂商分两种协议——Anthropic Messages（已支持，z.ai 在用）与 OpenAI Chat Completions（本批新增）。一个适配器解锁 OpenAI 本家+DeepSeek/Kimi/MiniMax/xAI/OpenRouter/网关+z.ai OpenAI 模式端点。
  - **shared.ts 抽取**：parseSse/parseFrame/abortSafe/safeParseJson/重试策略从 anthropic.ts 原位抽出为 postJsonWithRetry（含中止返回 null 哨兵保持"静默结束"契约）；anthropic 行为等价由既有 590 测试背书
  - **openai-completions.ts（~280 行）**：system 走 messages[0]；tool_calls 按 index 流式累积（id/name 首块到达、arguments 分片）；toolResult → 独立 role:"tool" 消息；usage 末块到达（stream_options.include_usage）含 prompt_tokens_details.cached_tokens 与 OpenRouter prompt_cache_hit_tokens 双拼写；finish_reason 映射（tool_calls→tool_use/length→max_tokens/stop→end_turn）+ 无 finish_reason 判截断 + 有 toolCall 兜底 tool_use；maxTokensField 按 model 探测（gpt-5*/o 系→max_completion_tokens，其余 max_tokens，参考 pi compat 经验）；空回复合成 "(empty)" 文本块；401/404 提示带 env 名
  - **resolve.ts 路由种子**：`openai/<id>` 前缀路由（bare id 默认 anthropic，未知前缀含斜杠的 id 整体回退——存量配置/会话字节不变）；runner 构造期解析（`options.model` → {provider, modelId}），子代理天然继承；运行中 /model 跨 provider 切换留给注册表批次
  - **测试（+10）**：本地 SSE 服务器 wire 级——文本流/交错工具调用分片累积/OpenRouter usage 双拼写/请求体全形状（system 首位、assistant tool_calls 回显、tool 消息、嵌套工具格式、maxTokensField 翻转、Bearer 头）/中止无 message_end/截断报错/429 重试恢复/401 提示/空回合
  - **真机验证（z.ai OpenAI 模式端点）**：协议与认证通过，返回结构化 429 code 1113 "Insufficient balance"——**GLM Coding Plan 额度不覆盖 OpenAI 模式端点（走平台计费）**；错误路径按设计（重试→清晰提示+会话续跑）。正向流由 wire 测试覆盖
  - 已知边界：run_log provider 名显示 "openai"（批次 2 随注册表细化）；/model picker 候选仍是提示文本（批次 2）；ChatGPT 订阅凭证走批次 1 OAuth+批次 2 Responses
  - 踩坑：blocks 与 tool_call_delta 均按**到达序**排列（与 anthropic 约定一致）——交错流的测试期望两次写反，先推演到达序再写断言

- **#多 provider 批次 1+2：Codex OAuth + Responses 协议 + 模型注册表（2026-09-10，617 tests）**：用户场景=ChatGPT 订阅凭证 + z.ai GLM Coding Plan 两家；批次 0（OpenAI Chat Completions 通用层）已先行合入。
  - **批次 1（feat/codex-oauth，607）**：`provider/codex-auth.ts` 设备码 OAuth（auth.openai.com/codex/device 展示 user_code 轮询、slow_down 退避、token 交换（设备码流的 PKCE verifier 由服务端返回）、60s 过期余量刷新、**单飞刷新**——并发回合竞态双刷新会用已轮换的 refresh token 自锁）、JWT claim 提取 chatgpt_account_id；凭据 `~/.imp/auth.json`（0600），损坏/异构文件=未登录而非崩溃；CLI `imp login`/`imp logout`。7 个封闭测试（本地假认证服务器+自铸 JWT，产线端点零接触）。真机：login 拿到真实设备码、无凭证路径教学清晰
  - **批次 2（617）**：`provider/codex-responses.ts`（~280 行）——chatgpt.com/backend-api/codex/responses，Bearer+chatgpt-account-id+originator:imp+OpenAI-Beta 头；instructions 承载 system；input 项形状（input_text/output_text/function_call/function_call_output——工具调用是独立项非 role 消息）；扁平工具格式+strict:false；output_index 槽位流；**usage.input_tokens 含缓存读需减**；completed/incomplete/failed/error 事件映射+无终止事件判截断；reasoning 事件按 v0.1 策略忽略（加密回放缓做）。`provider/models.ts` 静态注册表（contextWindow 逐模型，数字全部取自 pi 自动生成目录：codex 系 272k/128k、claude-sonnet 系 1M、glm-4.6 200k；未知模型回退 131072 保守方向——压缩宁可早触发）；IMP_CONTEXT_WINDOW 仍最优先。**runner.setModel**：/model 运行时跨协议族切换（providerName 追踪；同族保持当前实例——测试注入友好+产线即真实例）；compaction settings 的 contextWindow 与 footer//status 的 ctx% 全部改读 runner.contextWindow（按当前模型解析）
  - **接线**：`openai-codex/<id>` 前缀路由；/model picker 候选增 openai-codex/gpt-5.5 与 openai/gpt-5.2；cli HELP 增订阅 plan 段
  - **流程事故（1 起）**：批次 1 提交直落 main（忘开分支）——同 d271d5f 事故；保提交拓扑修正（branch feat/codex-oauth + reset --keep + merge --no-ff）。**教训：合入后立即 git branch 确认落点再开新批次**
  - **调试大战（批次 1 测试）**：症状=fetch 永挂。沿途修掉两个真问题（403-pending 响应体未排水毒化 keep-alive 连接——与 postJsonWithRetry 的 drain 注释同一课；sleep abort 只清 timer 未 resolve 永久挂起）。最终根因=**测试服务器 handler 对 form-encoded body 裸 JSON.parse 抛异常→无响应→fetch 静默挂起**——"假服务器处理器抛异常表现为客户端无限等待，无任何错误浮出"；二分法（隔离复刻→模块探针→逐段打点）全程 90 分钟
  - 已知边界：模型选择不随会话持久化（既有语义，跨 provider 需重开时 -m 指定）；reasoning 加密回放/usage 限额显示/browser 登录缓做；z.ai OpenAI 模式端点不覆盖 Coding Plan 额度（批次 0 已证）
  - 待办：**全量对抗审查**（三批合并 diff：shared 抽取等价性、openai-completions wire、codex-auth 状态机、responses wire、setModel 切换面）——按 #10 惯例两路

- **#多 provider 审查闭环（2026-09-10，622 tests，fix/multi-provider-review）**：两路对抗审查（wire/auth 路 OK-with-notes：1 P1+4 P2；集成/切换面路 **BLOCK**：4 P1+5 P2）全部核实为真并修复。
  - **P1-1 子代理拿到过期 provider**：task 工具构造期按值捕获 this.provider（同处的 getModel 等都是 getter，注释自己写着"spawn-time reads live"——provider 漏掉）→ 跨族 /model 后子代理=旧协议实例+新 wire id=必 404。修复：TaskToolOptions.provider → `getProvider: () => this.provider`；钉子：spawn 期换 provider 实例子代理跟随
  - **P1-2 在飞回合的压缩缝读活 provider**：/model allowedDuringRun → 运行中切换后 onBeforeTurn/compactAndSplice 用**新族 provider + 旧族捕获 model**（404 冒泡毁整个回合）。修复：runTurn 入口与 model 一并快照 provider+settings 贯穿 runTurnInner/compactAndSplice（/compact 手动路径同步）；钉子：gated fake 在飞回合中 /model 跨族，回合仍以旧 model 完成
  - **P1-3 构造期窗口不初始化**：settings.contextWindow 唯一写点是 setModel——默认用户 footer 用注册表 1M、压缩门却 131072：~11% 即压缩且 ≥80% 警告永不出现（注册表批次的核心承诺未兑现）。修复：构造期 `contextWindowFor(options.model)` 初始化；钉子：默认 1M / glm 200K
  - **P1-4 切换后 run_log 静默**：setModel 换的实例未包 withLogging。修复：与构造期同款包装
  - **F1（wire 路 P1）openai-completions usage 双计**：prompt_tokens 含缓存读被原样入 inputTokens，而 compaction 锚点公式按 anthropic 语义（input 不含缓存读）再叠加 cacheReadTokens——缓存重度会话 ctx% 虚高~2 倍、过早压缩。修复：减法对齐（与 codex-responses 同约定）；钉子 100-40=60
  - **P2 批**：F2 重试耗尽错误丢 provider 名（postJsonWithRetry 增 label 参数三处传入）；F3 设备码 interval NaN 通过校验→0ms 热循环（Number.isFinite）；F4 登录轮询按迭代挂 abort 监听器不移除（~900 闭包触发 Node 告警——双 settle 路径 removeEventListener）；F5 codex-responses auth 阶段是 abort 盲区（检查移到 await auth() 前）；P2-5 bare id 显示面歧义（runner.modelReference() canonical——note/picker 前置项/current 标记/无参显示四处，anthropic 族保持 bare=存量字节不变；钉子：跨族后 picker 首项 openai-codex/gpt-5.4* 且 bare 项不再出现）；P2-6 近似前缀静默错路由（trim+大小写归一——"OpenAI/x"曾是延迟 404）；P2-7 注入 fake 时 providerName 按初始模型解析（openai/ 前缀初始模型+fake+同族切换不再丢 fake）；P2-8 constants.contextWindowTokens 死代码删除、models envInt 无效值告警一次+忽略（与旧契约对齐而非静默分叉）、login 文案 gpt-5.2→gpt-5.5（对齐注册表/HELP/404 提示）
  - **P2-9 补钉**：跨族切换真回合 e2e（OPENAI_BASE_URL 指向本地假服务器——请求落新 provider 且 wire id 剥前缀、Bearer 正确）、构造期窗口、子代理继承、picker canonical、parseModelRef 大小写/trim；**未做**：login/logout CLI 集成测试（argv[0] 薄分派，记入已知项）
  - 测试面连锁修改：TaskToolOptions 接口变更波及 task-tool/child-compaction 测试 16 处调用点+repoTask overrides（`{ provider }`→`{ getProvider }`）；makeEnv 增 model 参数
  - 真机冒烟：glm 默认路径无回归（6/6 答对、无错误）
  - 两路 Correct 交叉印证：shared 抽取等价（null 哨兵=原静默 return）、单飞刷新竞态窗口推演、403/404 排水体真修对、parseModelRef 边界、footer/status 改线正确

- **#model-discovery 模型列表动态发现（2026-09-10，634 tests，feat/model-discovery）**：用户报告两问题——①无 anthropic 订阅却见 claude 且能聊天（z.ai 网关对未列出 id 的兜底路由，非声明支持）②glm/openai 只列静态表一小部分。根因：/model 候选=硬编码静态表，与端点实际供应脱钩。**只读探测证实** z.ai Anthropic 兼容端点实现 /v1/models，返回 10 个 GLM 全集、无 claude。
  - **provider/discover.ts**：discoverModels(family)——anthropic 家 GET {base}/v1/models?limit=1000（Bearer/x-api-key+anthropic-version，与 anthropic.ts 同解析）、openai 家 GET {base}/models；内存缓存 5 分钟（(family,baseUrl) 键，时钟可注入）；2.5s 超时静默回退；familyConfigured(family) 凭证门控（codex=读凭据文件，**支持 IMP_AUTH_PATH 覆盖**——测试封闭性/沙箱）
  - **buildModelList**（commands.ts 导出，deps 可注入）：已配置族的**发现结果即列表**（anthropic bare、其余加前缀 canonical）；未配置族整体排除（用户拍板"列表即当前真实可用"）；发现失败→该族静态种子+note；**全部未配置（全新安装）→经典全局种子表**保住 picker 可用性与既有金样；codex 无公开列表端点→静态目录即真相；当前模型在列表内则原地标 current（不重复前置），自定义 id 恒首位；行描述标族名（P2-5 教训延续）
  - 真机验收：z.ai 10 GLM 全现、claude 消失、族标签正确；测试隔离修复两处（repl-commands describe 级 + tui picker 用例——**用户真实 ~/.imp/auth.json 曾令测试非封闭**，IMP_AUTH_PATH 钉住）
  - 测试 +12：buildModelList 六路径（发现即列表/claude 不凭空/多族合并排除/codex 静态/全新安装经典表/自定义 current 前置）、发现层（头形状/缓存命中与 TTL 过期/401→null/未配置零网络）、IMP_AUTH_PATH 凭据门控
  - **审查评估**：纯增量功能（picker 数据源+发现层），无并发/协议状态机面，12 专属测试+真机验证——判定无需独立对抗审查；遗留：openai 家发现未对真实 OpenAI 端点验收（无 key）、z.ai 发现结果含 has_more 未翻页（10 条内无影响）
  - 已知边界：/model <id> 手动路径不变（网关兜底路由仍是用户的显式选择）；legacy readline 无参路径仍是教学文本（无列表能力）

- **#codex-catalog 补全 + 发现健壮性（2026-09-10，635 tests，fix/codex-catalog）**：用户报告——已登录 OpenAI coding plan 但模型列表非全集。核实：①ChatGPT 后端**存在** /codex/models 端点（400 索要 client_version；0.50/0.60 + codex_cli_rs originator 全部 200 但 `{"models":[]}`——计划账户当下不供动态列表，pi 生成器同持显式目录"避免别名"）②我的静态目录只放了 3 款（pi 生成目录实有 7）。
  - **静态目录补全至 7 款官方全集**（gpt-5.5/5.4/5.4-mini/5.3-codex-spark/5.6-luna/sol/terra，取自 pi openai-codex.json）
  - **codex 发现改为"温缓存增补"**：fetchJson 兼容 {data:[]} 与 {models:[{slug|id}]} 双形状；picker 对 codex 只读**已温缓存**（peekCachedModels）——绝不为列表等网络；打开 picker 时后台 warmCodexCache() 预热供下次合并；后端将来供模型即自动出现
  - **发现健壮性**：超时 2.5s→4s + 429/5xx 一次 400ms 静默重试（真机复现过 z.ai 瞬时限流把列表打成 fallback——重试后恢复）
  - 真机终验：picker (1/17)=10 发现 GLM+7 Codex 全集、无 fallback note；调试插曲：picker 曾两连 fallback，pty 下直跑发现层成功——定位为端点瞬时限流（加重试后消失），DBG 打点确认无失败路径后移除
  - 测试 +1（codex 温缓存增补序：静态 7 款在前、extras 追加）+ 1 处期望更新（合并路径 8 行）；已知边界：picking 视口只显前 ~8 行（17 行滚动，计数可见）；OPENAI_CODEX_BASE_URL 同源复用于发现

- **#codex-catalog-2 数据源更正：pi.dev 中心目录（2026-09-10，636 tests，fix/codex-catalog-2）**：用户质疑上一批核实并给出关键线索（pi 登录同账户能见 gpt-6，imp 不能）。复盘证实我上一批有三处错误：①"计划账户拿不到动态列表"——错，是 client_version 门控（条目带 minimal_client_version≥0.124，我用 0.50/0.60 太旧得空）；②"官方 Codex CLI 维护静态目录"——未核实的推断，错；③"pi 的 7 款=官方全集"——过度陈述。**真相**：ChatGPT 后端 /codex/models 用真实版本（0.130.0，本机 codex CLI）只回 3 条能力门控推荐集（gpt-5.5/spark/codex-auto-review(visibility=hide)）；**pi 的完整列表来自自己的中心目录服务 `pi.dev/api/models/providers/<id>`**（公共无认证、4 小时刷新、新模型当日上线——现含 8 款：gpt-6-astra/5.5/5.4/5.4-mini/spark/5.6-luna/sol/terra）。
  - **实现**：codex 家发现源改 pi.dev（IMP_CATALOG_BASE_URL 可重定向，测试/镜像用）；静态种子同步 8 款（含 gpt-6-astra ctx 272k，models.ts 注册表同补）作离线兜底；**发现失败→静态兜底+note**（不再"只温缓存增补"——pi.dev 快且公共，与其他族同样 await）；fetchJson 兼容三种形状（裸数组 / {data|models:[]} / **pi.dev 的按 id 键记录**——第三形状正是首版冒烟失败的原因，pi 自己的 parseCatalog 就有 Object.values 分支）
  - 测试：codex 发现改 record 形状 + 门控（有登录才拉目录）；pi.dev 主源/静态兜底二路径；"未配置零网络"测试的 env 钉法修正（**删 IMP_AUTH_PATH 会暴露宿主真实登录**——必须钉 nonexistent）
  - 真机终验：picker (1/18)=10 GLM+8 codex、无 fallback 注记、发现层直证 gpt-6-astra 在列
  - **教训（记档）**：对"端点返回空"的结论必须先穷尽参数空间（此处=版本门控）再定性；对参考项目的断言（"CLI 也静态"）要么读源码要么不写；"官方全集"这类词只用于有出处的事实
  - 已知边界：pi.dev 为第三方公共服务（参考项目自用）——uptime 依赖以静态兜底+缓存衰减；ChatGPT 后端 /codex/models 的能力元数据（reasoning levels 等）未利用（记为潜在增强）

- **#codex-max-output 修复（2026-09-10，636 tests，fix/codex-max-output）**：用户切换 openai 模型聊天报 400 "Unsupported parameter: max_output_tokens"——codex-responses 请求体误发该参数（ChatGPT 后端 Responses 端点不接受；pi 的实现本就不发，输出限额由计划策略在服务端管理，request.maxTokens 对该族不适用）。移除参数 + 回归钉（wire 不得携带）。教训：wire 参数清单对照参考实现逐项核对，"看起来标准"的参数在方言端点可能非法。

- **#context-window-adapt 窗口自适应补全（2026-09-10，637 tests，feat/context-window-adapt）**：用户问"切换不同上下文长度的模型能否自适应+自动压缩"（glm-5.3=1M vs gpt=272k）。盘点：机制已在（审查闭环 P1-2/P1-3 修的 setModel 窗口重算+快照），**但 glm-5.3 不在静态注册表——用户日常模型一直跑 131072 兜底**（过早压缩、ctx% 失真）。
  - **静态表补齐 z.ai 当前全系**（出处 pi.dev zai 目录）：glm-5.3/5.3-flash/5.3-highspeed/5.2-highspeed=1M
  - **运行时窗口富集**：发现层解析条目的 contextWindow 字段（pi.dev 目录带、第一方 /v1/models 不带）→ registerDiscoveredContextWindows 运行时映射；contextWindowFor 查找序=**env > 发现富集 > 静态表 > 默认**——新模型发布当天从目录拿到真实窗口，压缩不早不晚
  - 钉子：注册表补齐（glm-5.3 1M）、富集优先级（新 id 立即生效/覆盖表值/前缀剥离/重置回表）、**双向切换适配**（glm-5.3 1M↔gpt-5.5 272k：settings 门随族收紧放宽——切小后超限历史下回合自动压缩而非 400，切大后不再早压缩）
  - 已知边界：anthropic(z.ai) 家第一方列表无 ctx 字段——窗口靠静态表（全系已补）；发现富集当下只对 codex 家（pi.dev 源）实际供数；/status 只显百分比不显分母

- **#thinking-levels 思考强度（2026-09-10，694 tests，feat/thinking-levels `bdbb18a`）**：用户点名“选模型但无法调思考强度”。先调研三方：imp 思考链路完全缺席（LLMRequest 无字段、anthropic v0.1 注释性忽略）；pi 五层实现（7 级阶梯/模型元数据门控/每请求 reasoning 传递/provider 三路映射/会话持久化+设置+shift+tab 循环+边框七色+ooter 段）；claude 2.1.88 源码弼。用户拍板“存+dim 展示一次做齐”。落地：**thinking.ts** 阶梯+家族风格表（claude=anthropic-budget 用 pi 预算数字 1024/2048/8192/16384 与调整算法；GLM 两协议均为二值 {type:enabled}；openai=reasoning_effort；codex=reasoning.effort；deepseek-reasoner=auto）+clampThinkingLevel 就近钳位；**anthropic** 解析 thinking 块（含 signature_delta）且**回放带签名**（工具连续回合 API 硬约束）；**openai-completions** reasoning_content → thinking_delta+存为块但**不回放**（厂商建议丢弃）；**渲染** 缓冲后整段 dim 斜体刷出（正文/工具/endRun 触发 flush），/resume 重放同形；**runner** thinkingLevel 状态（--thinking/IMP_THINKING 启动）+setThinkingLevel 钳位+会话 thinkingLevelChange 条目（pi 同款，buildContext 跳过）+/model 切换钳位；**UI** /think（无参循环/非法报阶梯/无旋钮报 pi 原话）+Shift+Tab 循环+footer think:<level> 段。**记档偏差**：无跨会话默认（pi 有 settings 文件，imp 无设置基础设施，先 IMP_THINKING 代）；无编辑器边框七色（imp 无主题系统）；GLM 二值无中间档；/resume 重放不显示级别变更 note（仅审计条目）；xhigh/max 需单模型 map（pi 有目录，imp 先全幅钳到 high）。真 TTY 冒烟：dim 斜体思考段、块序、后续流正常。测试 +26（668→694）
- **#thinking-parity 系统性对齐批次（2026-09-10，711 tests，`92d7470`）**：用户质疑“功能是否真与 pi 对齐”，逐层重查 pi 源码+目录（packages/ai/src/providers/data/*.json + pi.dev 在线目录）后修 8 处偏差：①**off 三处未真正关闭**（anthropic/codex/GLM-zai 省略参数≠关闭，现按 pi 发显式 disabled / effort:none / zai disabled）②**Claude ≥4.6 走错协议**（pi 目录 forceAdaptiveThinking：adaptive+output_config.effort+xhigh/max+128k，原 budget 封顶 high/64k）③**gpt-5 家族 off 语义**（gpt-5/o3/gpt-6 目录 off:null=不可关，5.1+ off→"none"）④**codex 档位映射**（minimal→low、xhigh 5.3+ 原生、gpt-6 max 原生）⑤**GLM 二值只对一半**（glm-4.x/5-turbo 二值属实；5.2+ pi 目录有 effort 阶梯 low/med/high→"high"、max 原生；imp 5.3 按 5.2 外推记档；anthropic-compat 协议路径仍二值=协议约束）⑥**压缩摘要不带级别**（pi compaction.ts:549，已穿线）⑦**子代理继承是上轮修反方向**（pi spawn 不传 --thinking，已回退）⑧**切换提示 pi 化**（showStatus：dim 单行 `Model: x`/`Thinking level: x`，连续切换就地合并为一行，transcript 增 status kind + 尾行替换；无旋钮模型打 pi 原话）。thinking.ts 重写为 **MODEL_RULES per-model 目录**（ThinkingLevelMap 类 pi thinkingLevelMap，未知 id 回退家族默认 off..high）。用户三问答案：GLM 二档=一半对一半错（已修）；gpt-6 四档=错（pi.dev 目录：minimal..max 六档且 off 不可用，已修）；切换提示=已对齐合并语义。**仍待拍板（成本可见）**：默认级别 off vs pi 的 medium；ctrl+t 隐藏思考切换（需 transcript 重建）；跨会话持久化（pi settings 自动写入 defaultThinkingLevel）。测试 699→711
- **#thinking-parity 审查闭环（同日，711 tests，P1 修于 `8dfde3e`，merge `cccc55b`）**：reviewer 判 **BLOCK**，逐条核实属实。**P1**：runner.ts:681 把 off 折成 undefined（pi agent 层同款），但 imp provider 把 undefined 当“省略参数”——三处 off 分支成死代码，/think off 后 Claude ≥4.6/gpt-5.1+/codex 实际按后端默认继续思考而 footer 显示 off（pi 是在 provider 层重新解释 undefined→disabled）。已修：三协议 undefined/off 一律显式禁用（off:null 模型除外）+三家 undefined 变体钉。**P2 目录修正**（pi.dev 在线+pi openai.json）：GLM 实测数据推翻我的外推——glm-5.2/5.2-highspeed 实际 {off:“none”, high, max}（low/medium 已关）；**glm-5.3 系 off 不可用（思考关不掉），档位=low/high/max**；openai gpt-5.4/5.4-mini/5.5（off→none、minimal 关、xhigh 原生）；pro 系稀疏阶梯无 off；o1/o1-pro low 起步；claude-fable-5 思考常开（off:null）；claude-opus-4-1 32k 上限；gpt-6 并入 max_completion_tokens 家族。**P2 测试缺口**：TUI 级连续 shift+tab 合并 E2E（测试装配补接 statusSink，与 cli.ts 同款）+openai undefined→none 钉。**记档（报告级）**：glm-anthropic 协议路径的 disabled/enabled 仍 live 未验证（pi 无 anthropic 协议 GLM 可对照，建议真机冒烟一次）；pi showStatus 每条前有 Spacer(1) 空行，imp 未加（美观差异）；本地 pi 克隆目录落后于 pi.dev 在线（GLM 与 codex 新模型以在线为准）。**顺带查明用户问题**：
- **#followup-runs M17 follow-up 同 run 推进 + 队列消费模式（2026-09-22，956 tests，feat/followup-runs）**：设计 docs/m17-followup-runs-design.md，闭环 #queue-parity 遗留（“follow-up 为独立 REPL turn，非 pi 的同 run 内连续推进”）。**机制**：loop 增 `getFollowUpMessages` 缝，no-toolCalls 边界先 poll steering（pi :257 顺序：turn 期间新排队的 steer 优先于 followUp 消费），steering 空才 poll followUp——非空则消息进 history 同 run 继续（同一 abort 作用域、usage 聚合、一次 run_end），注入后置 skipSteeringPoll 跳过循环顶的下一次 poll（pi :195 守卫：one-at-a-time 不双投）；maxIterations 仍只守工具轮（followUp 轮受队列长度天然限界）。REPL：steeringMessages/followUpMessages 均按模式 drain（首匹配 splice 保序，bang/{prompt} 条目永不入池），followUp 消费回显为完整 user 块（新对话轮）vs steering 的 note（轮中注入）；模式每 run 快照（submitTurn 活读合并视图，/settings 写下次 run 生效）；flush 语义保留给 bang/{prompt}/竞态窗口残留。**默认值有意偏离 pi（用户拍板，设计 §2）**：steeringMode=`all`（及时补充信息：一次边界整批送达、积压消化不拖延新消息）、followUpMode=`one-at-a-time`（独立任务：逐条消费保 esc+p 修订窗口，队列结构即任务分解信号）；两键进 /settings（kind mode，Enter 循环 all↔one-at-a-time，来源列同其他键）；偏离只是默认值，一键可回 pi 行为。**wire 形状**：all steering 产生连续 user 消息——四家适配器均透传不合并（Anthropic API 服务端合并同角色连续轮；openai 系原生接受），anthropic+openai-completions 各钉。abort 语义不变：中断当前轮，未消费条目交还编辑器（#queue-parity ③）。README 队列段重写。测试 +13（943→956）：loop 同 run/空池即停/边界 steer 优先/abort；TUI 同 run 钉（hold 末轮断言 idle hint 全程不现）、两条 followUp 逐边界消费、abort 中途交还、steer 批量默认（两行一 poll 注入为连续 user 消息）；settings coerce+面板+写入；双 provider wire pin。门禁：956/956 mac、typecheck 0、biome 132 文件净、dist 冒烟（dist 产物直接驱动 loop followUp 继续 + settings 往返）。
- **#small-tools M16 小工具批（2026-09-21，938 tests）**：设计 docs/m16-small-tools-design.md。三个独立 pi 对齐面：**ls 工具**（core/tools/ls.ts，pi 同款：大小写不敏感排序、点文件、目录 `/` 后缀、条目上限 500/字节上限 50KB 带可操作提示；走 read 的 resolveReadPath 同缝；主/子代理双注册+系统提示行）；**/copy**（最后一条助手消息文本→剪贴板；clipboard-write.ts：pbcopy/clip/wl-copy/xclip/xsel 命令链+OSC 52 终端逃逸兜底（SSH 场景，100k 编码上限），无原生绑定 D8 同款；ctx.copyText 注入缝，测试不碰真剪贴板；思考块跳过，工具调用轮跳过）；**/name**（会话树元数据 session_info 条目——与 thinkingLevelChange 同类：进树不进上下文/统计；换行净化为空格；/sessions 标题、/status 名字段接管）。/help 与 unknown-command 钉子、扩展保留名派生列表随动。938/938 mac、929+9 跳过 Linux、typecheck 0、biome 134、dist 冒烟（ls 实跑 8 条目+上限提示、session_info 落盘重开）。**审查 FIX-FIRST（3 P1+7 P2）全核实修复**：P1 扩展可注册 `ls` 遮蔽内置工具（BUILTIN_TOOL_NAMES 手列表又漂移——补 ls+task，此前 task 也漏）；P1 /name 换行净化警告两条注释都声称存在但代码从未发出（补 note+钉子）；P1 存储层"空名清除"语义从 REPL 不可达（parseCommand 预剪裁，补 `/name -` 显式清除）；P2 钉子批——名字分支局部性（fork 后消失/tree 回来恢复，走 forkBefore+otherBranchTips+switchBranch 真链）、未知字段前向兼容（futureField 乘风）、OSC 52 写 fd 1 与 pi-tui 帧同流的安全性注释（同流串行化+非打印序列原子消费，帧汇换必须重审此缝）、ls 中途 abort 确定性钉子（翻转型的形状替身信号）、clamp 处提示改教收窄路径、扩展保留名拒收 ls/task 钉子、设计文档补版本偏斜政策段。修复后 943/943 mac、934+9 Linux、typecheck 0、biome 134。
- **#settings-panel M15 设置面板（2026-09-20，920 tests，`08fde88`+`66d8965`）**：设计 docs/m15-settings-design.md。pi settings-manager 架构对齐、键按 imp 现状收敛。交付：**双作用域**——全局 `~/.imp/settings.json` + 项目 `<cwd>/.imp/settings.json`，深度合并（项目赢、嵌套按键合、数组整体替换），项目层过 M8 信任门（`.imp/settings.json` 存在现在触发信任弹问，未信任读作空且不可写）；未知键读写全程保留（前向兼容）；原子写+mkdir。新键 `defaultModel`/`autoCompact`（`IMP_MODEL`/`IMP_AUTOCOMPACT=0` 环境变量保持最高优先）；Runner 全部设置读统一走合并视图构造时快照（按**会话 cwd** 解析项目层，接口暴露 effectiveSettings/projectSettingsAllowed/runnerCwd/globalSettingsPath 四缝）；子代理经 task 工具 getAutoCompact 继承父级决定。启动模型链=env>受信项目>全局>内置（解析期信任预读，未知保守跳过）。`/settings` 命令：TUI 选择器（当前值+来源列+env 遮蔽标注；Enter 循环布尔/思考档、defaultModel 文本输入走同校验、作用域选择器——未信任不出现项目项）、legacy 表格、`/settings <key> [value] [global|project]` 校验写入+old→new 回显+写入失败显式报错+"(next session)"语义；命令读写全走 runner 四缝（活读非快照）。**D7 blockImages 按用户决策维持推迟**（纯能力削减无消费方，记档更新）；D16（无文件锁，last-writer 整文件）、D17（精简选择器）、D18（程序化持久化写全局）记档。**开发中抓两 bug**（测试套件抓 saveScope 嵌套合并自吞原始兄弟键；dist 冒烟抓 defaultModel 优先序写反）+**单镜头审查 FIX-FIRST（3 P1+6 P2）全核实修复**：P1 /settings 显示构造时快照致自写不显示（改活读）、hideThinking 只读全局（信任解析后从合并视图重赋）、`--no-trust` 下项目设置仍播种模型（argv 预扫跳过项目预读）；P2 skills 键并进合并视图、写失败显式报错、来源列 [env|project|global|default]、TUI 输入同校验（尾随空格）、拒绝文案指向真实路径、BUILTIN_COMMAND_NAMES 从 COMMANDS 派生（手列表漂移成子集）。920/920 mac、911+9 跳过 Linux、typecheck 0、biome 130。dist 冒烟：受信项目 glm-4.7 赢全局 glm-5.3、.env IMP_MODEL 赢两者（设计行为）。
- **#model-catalog M14 模型目录中心服务（2026-09-20，897 tests，`9d3e0a3`+`d44de1d`）**：设计 docs/m14-model-catalog-design.md。模型元数据（上下文窗口/费率/思考档位/视觉能力/各家模型清单）从手工静态表迁到 **pi.dev 公共目录服务**（与 pi remote-catalog-provider 同一端点，无认证；live 核实条目含 contextWindow/maxTokens/cost/thinkingLevelMap/input/compat）。交付 `src/provider/catalog.ts`：拉取+ETag 协商（304 只挪新鲜窗口、有缓存体才带验证器——永不清空 overlay）、磁盘缓存 `~/.imp/models-catalog.json`（原子写、IMP_CATALOG_PATH/IMP_CATALOG_BASE_URL 注入、坏文件按无缓存处理）、4 小时新鲜度窗口、每家状态处理（404/501 记无目录、瞬态失败保缓存体+顶窗防砸）、单飞行（并发共享一次网络，含 force）、4s 尝试超时+单次安静重试（429/5xx，discover.ts 先例=pi fetchWithRetry 的适配 D15）。触发=启动过时检查+/model 打开（pi 语义双触发，**无轮询**）；`--help`/`--version` 等快速退出零网络；loadDotEnv 之后、任何 Runner 之前同步载缓存。四个消费点全部 overlay 优先：contextWindowFor（env>目录>发现>静态）、costFor（+家族订阅标注 zai/codex）、thinkingMetaFor（精确 id 胜前缀规则、reasoning:false→无旋钮、compat.forceAdaptiveThinking→adaptive）、modelSupportsVision（input 数组即真相）；/model 离线回退序=端点探测>目录缓存>静态种子。静态表冻结（兜底层，横幅声明）。分歧记档 D11（无 generatedAt 守卫——表已冻结远端无条件赢）、D12（单飞行无 per-runtime 协调器）、D13（无 publish/事务存储）、D14（跨进程 last-writer 整文件）、D15（重试适配）。**单镜头审查 FIX-FIRST（1 P1+5 P2）全核实修复**：P1 未 await 的启动刷新在端点黑洞时把进程扣住 ~16.8s（实测；kick 收拢 main 模式解析后+finally abort+timer unref+自身 abort 不顶窗，残余 ~1.9s=单家相位）；P2 载入路径同净化/重试防 4h 冻结/注释改正（探针仍先行、无陈旧性回归）/测试死断言修真+四个新测/缓存目录 mkdir/环初始化安全注记。live 冒烟：四家 anthropic 14/openai 39/codex 6/zai 7 全拉通，glm-5.3 窗口/费率/档位/视觉全由 pi.dev 回答，磁盘往返无损。897/897 mac、888+9 跳过 Linux、typecheck 0、biome 129。
- **#images2 M13 图片批 2——处理器（2026-09-20，875 tests，`9098da2`+`34bd8dd`+`2312fe6`）**：设计 §14。核心=photon-node@0.3.4（pi 同版本钉死，纯 WASM）管线七文件移植 `src/core/image/`——加载器（无 Bun fs 补丁阶梯：纯 npm ESM 直接读 wasm，lazy+null 契约）、EXIF 方向（JPEG APP1+WebP EXIF 走读，1–8，解析器导出供测试）、缩放阶梯（2000×2000/4.5MB 编码后/PNG+JPEG 候选/质量 {80,85,70,55,40}/×0.75 衰减到 1×1）、worker 入口+编排（进程内回退）、转换（BMP→PNG，EXIF 烧入）、processImage（规范化→缩放→hints：转换提示+坐标映射维度提示，pi 措辞）。read 全面改接（pi read.ts:112 对齐）：超限**缩放**而非教学错误（后者仅在 autoResize=false 时按编码尺寸保留）；BMP 带提示转换；设置 `images.autoResize`（默认 true，工具构造时快照）。@file CLI 附件（print 模式）：`@path` 位置参数先剥离再组装提示词，processFileArguments 移植（文本→`<file>` 块、图片→经处理器挂首条 user 消息；缺文件退出 1）+ resolveReadPath 变体（~ 展开/Unicode 空格/macOS 截图四变体）；loop userImages 组块、裸字符串路径字节不变。Ctrl+V 剪贴板贴图（TUI）：命令式读取器（osascript JXA NSPasteboard/wl-paste 类型协商/xclip TARGETS/WSL powershell.exe 门控/原生 win32 PS），不支持格式经 photon 转 PNG，写临时文件插光标——消息层零感知。**单镜头审查**无 P0、2 P1+9 P2 全处置：P1 read 补 resolveReadPath、P1 测试真跑 pbpaste→pasteText 注入；Linux 类型协商/wslpath 门/NSPNGFileType 兼容/PS System.Drawing/stderr ignore+EPIPE/加载器强制不可用测试/EXIF 容器走读+像素级旋转测试全套补齐；D7–D10 分歧记档。875/875 mac、866+9 跳过 Linux、typecheck 0、biome 127 文件、dist 真实 worker 冒烟（3000×2000→2000×1333 711ms）。**记档推迟**：kitty 内联图形（D3）、images.blockImages（D7）
- **#images M13 图片输入（2026-09-20，831 tests，`c55207b`+`c8556d3`+`9449c76`）**：批 1"只铺线不做缩放器"（设计 docs/m13-images-design.md）。交付：ContentBlock（text|image）联合类型上 UserMessage/ToolResult + contentText() 显示/摘要唯一文本源；魔数嗅探逐字节移植 pi image.ts（拒 JPEG-XR/动画 PNG）；read 图片路径（文本注释+图片块、BMP 降注释、超 4.5MB**编码后**教学错误——审查前自修 raw vs base64 算术、3.4MB 边界测试）；vision.ts 前缀规则（未知默认 false，zai 条目经 2026-09-20 官方文档核实：套餐=GLM-5.3 文本+GLM-5.3-Flash/FlashX 原生多模态，旧 ID 自动路由）；downgradeUnsupportedImages（pi transform-messages 对齐：占位替换/连续折叠/字符串零开销）三条线入口全接；线上格式——Anthropic 塞 tool_result.content 数组、openai-completions/zai 提升为后续 user 消息（pi 文本前导+data URL）、codex-responses input_image；显示层 ▪ image [mime, size] 注释（print/单行/⎿/TUI fold/回放全覆盖）；压缩 4800 字符/图（pi 对齐）、摘要器永不见图片字节；README Images 章节。**单镜头审查**无 P0、1 P1+3 P2 全修：P1 codex vision 键名错（规则表用"codex"而 ProviderName 是"openai-codex"——read 工具注释与请求实际行为矛盾，双侧统一+测试钉住 runner 名）；提升消息补 pi 文本前导；TUI fold 补注释；设计文档不存在的 compat 措辞重写；补 zai 包装黄金串+压缩排除测试。831/831 mac、820+9 跳过 Linux、typecheck 0、biome 115 文件。**记档推迟批 2**（设计 §1/§13）：photon-node 自动缩放+BMP/EXIF 转换、剪贴板粘贴、@file 附件、kitty 内联图形、images.autoResize 设置
- **#skills-batch2 M12 Skills 批 2：调用面（2026-09-20，806 tests，`d4fd176`+`22e1f90`）**：`/skill:name` 命令面。交付：expandSkillBlock（pi 字节对齐——调用时读盘、frontmatter 剥离、空参不落空行）；buildSkillCommands（骑 md 命令管线、source="skill"、disable-model-invocation 照样注册、撞名让位）；submitPrompt(text,{display}) 显示覆盖全链路（队列项/预览/回显穿透；会话记录永远存完整块，restore 恢复真实内容）；replay 折叠为 ▪ 摘要行；examples/skills/ledger（含 references/ 两级）；docs/skills.md+README 章节；test/repl-skills.test.ts 17 测（含 e2e 渐进披露：系统提示只含目录→真实 read 读 SKILL.md→读引用文件→按内容作答）。**单镜头审查**（集成缝/pi 字节/回归面，6 猎杀点全部落空或证实正确）无 P0/P1、4 条 P2 全处置：机器级 TUI 测试补齐（摘要行回显+完整块达模型的显式断言）、/sessions 标题对技能块会话显示 ▪ 摘要行、设计文本两处修正（`(skill)`→`[skill]` 方括号惯例、md 名不含冒点让路径实为防御性）、"failed to read" 措辞维持（目录单字符串契约）。806/806 mac、795+9 跳过 Linux、typecheck 0、biome 112 文件。批 1 遗留覆盖缺口（B2 CLI 级挂具、SKILL.md 为目录/符号链接环/项目 .agents 层）一并记档待后续
- **#skills-batch1 M12 Skills 批 1：加载面（2026-09-20，788 tests，`6b409c1`+`d0c1d87`）**：设计文档 docs/m12-skills-design.md（pi/CC 2.1.88 源码/agentskills.io 三方调研+实现契约）。交付：src/core/skills.ts（414 行，pi 对齐加载器——四层位置、SKILL.md 即根停钻、分层裸 md 规则、realpath 去重、先见者胜、宽松校验、formatSkillsForPrompt XML 块）；信任门加 `.imp/skills`+`.agents/skills` 祖先链（到 git 根、`~/.agents/skills` carve-out）；CLI `--skill`/`--no-skills`；runner assembleSystem 末尾注入（read 工具守卫，/new 稳定）；新运行时依赖 yaml@2.9.1。**实现期修订**（已记设计文档）：优先级改 显式>项目>用户（原稿用户优先与 imp 本地压全局惯例及 pi 资源加载器相悖）；settings 非字符串条目静默丢弃。**两路对抗审查**（信任/pi 对齐 + 集成/字节契约）无 P0/P1、11 条 P2 全核修（TOCTOU 包裹、carve-out 规范化比较、碰撞败者不占 realpath、告警用解析后名、"." 退化项过滤、设计文本三处对齐、`&apos;`/1024 边界/非字符串描述补测）；B2（CLI 级测试挂具）与剩余覆盖记批 2。788/788 mac、779+9 跳过 Linux、audit 0。教训：mkdirSync(recursive) 返回首个新建目录，拿返回值 join 会少一层
- **#ci-linux-fix CI 首跑抓出两处 Linux 特有失败（2026-09-13，757 tests，`6a5088f`）**：CI 上线即见效。①**EOF 挂起**（extensions-repl）：EOF 后运行中的 run 继续产出工具门 ask——close 只排空其前已排队的问句，之后的 ask 排进永远无人应答的队列；mac 碰巧靠 prompt() 在已关接口抛错被当作拒绝放行，Linux 静默 no-op 死等。修：ask()/secret() 增加 streamClosed 守卫立即拒绝（与 closed 守卫对称，语义=EOF 即拒绝）。②**git 夹具分支假设**：seedRepo 类夹具 `git init -q` 依赖运行器默认分支，CI 上是 master 而 task-tool B2 硬编码 checkout main；全部 7 处夹具改 `init -q -b main`。验证：Docker node20 全量 748 过+9 平台跳过零失败、mac 本地 757/757。审查判定：无需独立审查（两守卫+夹具钉分支，双平台实证）。教训记档：docker 挂载卷内跑 npm ci 会把宿主 node_modules 换成 Linux 二进制（biome/rolldown 平台包），本地恢复须 npm ci；容器内验证用命名卷隔离 node_modules
- **#engineering-health 工程健康批（2026-09-13，757 tests，`18a5fa3`→`ba3287c`，merge 本批）**：用户拍板“先补工程健康”。四项：①**Dependabot 清零**：vitest 3.2.7→4.1.11（告警范围 >=2.1.0,<4.1.11，3.x 无补丁版本；vite 8.3.0 使 esbuild 全树 dedupe 到 0.28.2）——npm audit 0 漏洞。升级暴露一处真契约矛盾：extensions-loader 断言 error≤160 vs firstLine 语义（内容 160+省略号=161）——裁决保留既有字节契约（shorten≡firstLine 同形，757 存量零改），断言改 ≤161+注释；曾试改 firstLine 省略号计入上限，连带 resultPreview(80) 出 79+… 字节漂移，撤回。②**20 处存量类型债清偿**（typecheck 门自 debt-clearance 落地后无人执行，后续批次漏进漂移——正是无 CI 的洞）：TuiShell 新必需三回调补桩、Renderer 补 toolStyle、runRepl 多余 renderer 删除（renderer 经 runner 传递）、AgentMessage 按 role 收窄、noUncheckedIndexedAccess 守卫（throws/??，随 child-compaction 先例）、REQ thinking 类型 ThinkingLevel、exit 回调 never 化。③**biome 存量清零**（npm run lint 全绿）：死导入/死变量/死参数 12 处、useTemplate×3、故意 ESC/OSC 正则与错误注入 generator 加 biome-ignore 注明理由、unsafe optional chain 安全化；注意 fsp 是局部动态 import 遮蔽故为死导入、AgentMessage 误删后回滚（biome 报的 Tool 才是死的）。④**CI 上线**：.github/workflows/ci.yml（push/PR，node 20+24 矩阵，typecheck→lint→build→test 四门）+51 个已合并分支删除。生产代码仅两处零行为变化（useTemplate 改写、注释）。**审查判定：无需独立对抗审查**（生产面零行为变化，四道门覆盖）。测试计数不变 757

- **#trust-home-fix（2026-09-12，757 tests，`762141b`+审查修复，merge 待记）**：用户问“任何目录启动都不见信任弹窗”。诊断：①门是资源触发而非目录触发（与 pi 一致，普通目录零摩擦）——预期行为；②真偏差：trustRequiringResources 的 isWithin(cwd, $HOME) 豁免整个 home 树——macOS 下一切目录都在 ~ 下，等于全盘禁用信任门。修复：仅豁免 $HOME 本身（此处 .imp/ 即用户全局安装，不得自我拦截；审查确认这是 imp 目录形状下对 pi 语义的结构性必需——pi 全局层 ~/.pi/agent/ 与项目层 cwd/.pi/ 路径形状不同无需豁免，imp 两层同形（~/.imp 与 cwd/.imp））；比较经 canonicalizeDir（realpath，失败向关闭方向坠落：最多多问一次并记录）；删 isWithin。钉子：home 下带 .imp/agents 的项目返回拦截（旧代码返回空）、$HOME 本身仍豁免。真 pty：同一探针目录修复前 NO-PROMPT-UNDER-HOME、修复后 PROMPT-NOW-FIRES-UNDER-HOME。**审查 OK with notes**：P2（旧测试名与断言仍声称已退役的整树豁免且空派通过——改名并删除该断言）已修；P3 预存（registry.ts 同目录同字符串比较未规范化——无害，待后续对称化）保留。756→757

- **#thinking-stream + #glm-retire（2026-09-12，756 tests，`421a405`+`624d40f`+审查修复 `308ed68`，merge `fd9706f`）**：用户两问驱动。①thinking 逐块流式：pi 的 TUI 随内容增长重渲染思考；imp 改为复用正文同一条段落完成规则（空行/闭合围栏，findFlushPoint），每完成一段立即渲染 dim+italic，flushThinking 只补尾段；隐藏模式仍整段缓冲、静态标签（pi 同）。字节契约：单段/无 ansi 多段逐字节不变（754 存量测试零改动全过）。②退役 anthropic-compat GLM 回退（2B）：pi 从无 glm 特殊路由——zai 是唯一官方路径。parseModelRef 裸 glm-* → zai 无条件（恢复纯字符串路由，删 zaiConfigured 咨询）；缺凭据时 runner.noteMissingZaiCredential 一行教学（/login zai | ZAI_API_KEY | anthropic/前缀逃生口；warmup 与 setModel 两处，存键或 env 在场即静默）；/model 的 anthropic 家族发现结果过滤 glm-*（compat 端点返回的 glm 不再与 zai 重复）；README 重写（zai 优先，compat 降级为显式前缀逃生口）。**审查 OK with notes → P1+P2+P3 已修**：P1（--help 环境段仍写已退役的回退承诺，改无条件路由+登录指引措辞）；P2（多段 trace 逐块各自 dim/italic 包裹 vs 旧单一包跤——已接受偏差，钉子测试+注释显式化；回放路径保持单包跤）；P3×2（zai.ts 注释、教学措辞预设 BASE_URL——报告性保留）。真 pty 冒烟 SMOKE-RETIRE-OK（无键启动出教学行、zai/glm-5.3 footer、列表无重复）；755→756

- **#login-repl Batch B（2026-09-12，754 tests，`1a00f81`+审查修复 `3a28ce7`，merge `b108ee3`）**：codex OAuth 进 REPL + /logout，/login 对齐收官。①OAuth 分支：选 ChatGPT plan 行/直接 /login openai-codex → 渲染 “▪ open <URL> and enter code: <码>”（验证 URL 跟随注入 base，不再打印误导性生产链接）→ 后台轮询 → “Logged in to OpenAI (ChatGPT plan)”（pi 措辞）+ /model 指针；Login cancelled 静默，真错误才渲染②守护长操作状态：loginNeedsGuard（无参 picker 或 oauth 引用，含大小写/显示名匹配=pi findLoginProviderOptions）→ compacting 式守护（Ctrl+C 中断轮询、输入排队、/new 拒绝）；IMP_CODEX_AUTH_BASE=机器级 e2e 注入点③/logout：只列已存储凭据（pi getLogoutProviderOptions 语义，env 配置永不列出），措辞对齐（适配无 models.json）。**审查 OK with notes → P1+P2 已修**：P1（机器缺陷）——每个 runCommand finally 无条件清空 longOpAbort，登录中输入任意斜杚命令即解除取消，双 Ctrl+C 直接强退——修为仅 stateful 清空+身份比较注册（被取代的流先 abort），机器级钉 /help 中插+仍取消；P2（pi 对齐）——fetch 网络窗口内 abort 显示为“This operation was aborted”错误，修为 pi fetchWithLoginCancellation 式的 fetchOrLoginCancel 包装（usercode/poll/exchange 三处）→ 静默取消，延迟服务器钉住 150ms 中断落在 fetch 内。P3×6 均为接受偏差（拒绝提示未提登录、/logout 行预计算与 pi 同形、body 读取不携 signal 与 pi 同类等）。真 pty 冒烟 SMOKE-B-OK（URL 渲染→Ctrl+C →存活→zai 保存→/logout 移除）；753→754

- **#login-repl Batch A（2026-09-11，749 tests，`e2939e9`+审查修复 `e30f3b7`，merge `2a6254e`）**：用户指令对齐 pi 的 /login（选供应商→引导接入）。**评估先行**：核实 pi 源码（interactive-mode.ts:5485+ / envApiKeyAuth / LoginDialog 不掩码），测算 600–800 行代码+350–450 行测试，拆两批；用户“开工”。Batch A 落地：①auth-store.ts：auth.json 分节（version/codex/apiKeys），旧扑平 codex 文件无损迁移，token 刷新保留 apiKeys，imp logout 只删 codex 节；解析序=pi 的 stored>｢env②三家族 provider+发现头+familyConfigured+裸 glm 路由门全部走同一谓词（/login 存 zai key 后裸 id 立即翻转路由）③/login 命令：四行选择器带状态标签（signed in — stored key/env: VAR/not signed in）、pi 原文提示 Enter Z.AI API key、Saved API key for X措辞、异族登录后 /model 指针（pi 仅从 unknown 切换——imp 总有模型故以指针代之）、静默取消、codex 行桥接 imp login CLI（Batch B 搬入 REPL）④secret 原语：两 shell 的 ask 队列泛化为 yesno|text，与 pi 一致不掩码、不入历史不发模型；顺带修复空闲 Esc 无法取消挂起问句的旧问题。**审查 OK with notes → 已修**：P2×2（resolveApiKey 的 env 回退默默翻转了 compat 环境下 AUTH_TOKEN 优先序——改为仅文件键费越 env+真 SSE 服务器钉住三态；存储 anthropic 键压 AUTH_TOKEN 无测试——补钉+README 警告）；P3×6（大小写/显示名匹配、空白取消、创建即 0600、清空剪枝、secret 藏提示行、/HELP_KEYS 补问句键位）。真 pty 冒烟全链过（/login→选 Z.AI→输 key→保存→指针→/model glm-4.7 翻转 Model: zai/glm-4.7→文件落盘）；测试全局 sandbox IMP_AUTH_PATH（729→749）。Batch B 待做：codex OAuth 进 REPL 对话框、/logout、/status 凭据状态

- **#zai-default GLM 官方路径收口（2026-09-10，729 tests，`f0fccdb`+审查修复 `2aa695e`，merge `1954d56`）**：用户拍板“默认按 pi：GLM 只有一条官方路径 zai；anthropic-compat 自行评估”。**评估结论：保留为带标记的回退**（否则现有只配 ANTHROPIC_AUTH_TOKEN/BASE_URL 的环境直接断）。落地：①parseModelRef 裸 glm-* id + ZAI_API_KEY 在场→ zai 家族；不在场→ anthropic-compat 回退；显式前缀永远优先（纯函数文档已更正为环境敏感）②/model 候选与 anthropic 回退表 GLM 条目全部改 zai 规范形式③--help/README 主示例换 ZAI_API_KEY 方式。**可分辨性（用户问“怎么分辨走的哪条路”）**：footer 与 /model 显示 `zai/glm-5.3`（带前缀）vs 裸 `glm-5.3`；裸 id 落 compat 时打一行指引（启动 warmup 与 /model 切换两处都发；显式 anthropic/ 前缀与 zai 路径永不提示）；Runner 公开 providerName 只读。**审查 OK with notes → 已修**：P1（footer 实际用裸 id——承诺的 tell 只存在于 /model，改为 modelReference()+TUI 正则钉）；P2×5（启动路径提示缺失已补并钉住用户自己 .env 同款场景、宿主 ZAI_API_KEY 污染面四处补 save/delete/restore、构造路径 IMP_MODEL+钥匙→zai+钳位钉、纯函数文档更正；另清了存量 lint 欠账 unused ×5）。测试 727→729

- **#thinking-finalize 三项用户拍板（2026-09-10，726 tests，`2aa3676`+审查修复 `d6353d3`，merge `e0c3aa8` 前身）**：①**默认 medium+持久化**（pi DEFAULT_THINKING_LEVEL + setDefaultThinkingLevel 同款守卫；新建 src/core/settings.ts `~/.imp/settings.json`，IMP_SETTINGS_PATH 可注入；解析序 --thinking/IMP_THINKING>会话条目>设置>medium；测试经 vitest setupFiles 全局隔离——一度有 runner 测试把 "low" 写进真实家目录）②**ctrl+t 隐藏思考**（pi app.thinking.toggle：翻转+持久化+transcript 清屏重放与 /resume 同路径，隐藏时每段仅显 dim `Thinking...` 静态标签；运行中只翻标志不重建+打 pi 原话状态行）③**zai 家族**（pi providers/zai.ts 对齐：coding 端点+ZAI_API_KEY/ZAI_BASE_URL+tool_stream+max_tokens 字段+zai thinking 对象+pi.dev 档位；/model 候选与发现接线）。**审查 BLOCK→修复**：P0（cli `envThinking() ?? "off"` 恒定值使 medium/settings 链在正式二进制中不可达——改为 undefined 才落链；P1×2（--thinking 优先于会话条目修复；/model 选择器 families 漏 zai 使发现与回退表成死代码）；P2×4（no-op 不再写会话条目、ctrl+t 状态行反馈、zai 发现缓存+尾斜杠修剪、五个测试缺口全补）。glm-5.2 档位采用 pi.dev 在线目录（审查员无法访问外网已标注，本地克隆目录较旧）。测试 721→726

- **#思考强度 pi 对齐系列记录（GLM 接入方式）**：pi 接 GLM-5.3 用 **openai-completions 协议 + zai 专属 provider**（coding 套餐端点 api.z.ai/api/coding/paas/v4，国内镜像 zai-coding-cn），不用 anthropic-compat；anthropic-compat 是 imp/用户侧的连接方式

- **#thinking-levels 审查闭环（同日，699 tests）**：reviewer 判 OK with notes。核心算法与 pi 逐项等价验证（预算数学、钳位、块序、reasoning 单块块、启动无多余会话条目、测试零同义反复）。**P1×2 已修**（`1912f9b`）：① anthropic 回放原来无条件送出思考块——跨协议 /model 切换后 GLM/deepseek 的无签名块会 400 真 Anthropic；修为 pi 规则（有签名才以 thinking 回放，无签名降级为纯文本、空块丢弃）；②斜体转义未门控 ansi——管道输出泄漏 ESC 字节，违反 print 契约，门控修复+零转义钉。**P2×4 已修**：子代理继承父级别（getThinking 穿线）；--resume/-c 与 /resume 恢复分支最后级别（pi sdk 同款，直接写不追加新条目）；flushThinking 先 flush markdown 防交错倒序；--help 补 --thinking 与两处陈旧注释。审查指出的测试缺口全补（拆分签名拼接、无签名降级、GLM 无签名、ansi=false 字节、resume 恢复）。**记档（报告级）**：redacted_thinking 块接收时丢弃且不回放（pi 会同模型回放；罕见路径，仅影响纯 redacted 工具连续回合）。合入 main `8107a33`，699/699

- **#user-block 用户输入背景块（2026-09-10，666 tests，feat/user-block `1502755`）**：真机回看找不到自己的输入。三方源码对照：pi = 整块灰底（#343541，Box paddingX/Y=1，无前缀，OSC 133）；claude 2.1.88 源码证伪网检“内联只有彩色前缀”的旧印象——两模式均为 rgb(55,55,55) 灰底块+暗色 ❯。对齐 pi 形制：TranscriptSink.feedUser 一次调用=一块（行级 kinds 数组，内容按 width-2 换行+左 1 列内边距+渲染期右填满宽+背景 48;5;237，上下 pad 行夹心，多行输入=一块，resize 随缓存重建）；Renderer.user 增 userSink 侧门（cli.ts/repl 测试装配接线；字节流 `> ` 回显保留为其他调用方回退，print 不调 user 零字节风险）；/resume 重放 TUI 走全文块（与实时同形），截断预览留作 print 回退。块内无 `> ` 前缀（pi 同款）。真 TTY 冒烟：块 80 列满宽、背景码 3 行、后续流不受影响。测试 +3（663→666）
- **#user-block 审查闭环（同日，668 tests）**：reviewer 判 OK with notes（无 P0/P1：kinds 平行性单一写入点 pushLine 、满宽不溢出含宽图形手推、fold 锚点与块交错 resize 稳、userSink 全部构造点/print 字节/巨型消息线性成本均逐项确认）。P2 已核实并修（`29bbc43`）：两处陈旧 `> ` 回显注释；测试缺口×2 补钉（replaySession 带 userSink：全文单次进 sink+摘要帧绕过 sink；块夹两 fold 之间 80/30 列顺序不漂）。**记档遗留（报告级，不修）**：/resume 无截断全文块（pi 对齐故意，巨型粘贴重放会刷满滚动）；粘贴文本含 \x1b[0m 会中断行背景（纯视觉，pi 同暴露）；48;5;237 为 #343541 近似值（未来主题系统接管）。合入 main `f379fe4`，668/668

- **#inline-results-stats 两项 pi 对齐（2026-09-10，663 tests，feat/inline-results-stats `d1cbd18`）**：真机审收两细节均与 pi 相反，对齐之。① **工具结果内联**：v1 折叠区（转录流下独立 Container）使结果漂离工具行且跨回合累积；改为 TranscriptSink.appendChild 锚定已完成行数（重绘稳定：每行 wrapped 行数累计前缀表），fold 落在 `● … ✓` 行正下、后续文本流在 fold 下（tap 内 renderer.event 先于 showResultFold，顺序免改动）；foldContainer 删除，/new 随转录一并清除；单元交错测试+集成顺序测试（║行<▸ fold<后文）+真 TTY 冒烟。② **TUI 去掉每回合 `— model · N turns · tokens` 行**：pi agent_end 零输出、footer 独占状态；printRunStats 加 { statsLine }，TUI 传 false（停止注记如 (aborted) 保留），print 字节不动；两个 footer 测试的“第二回合完成”信号改锥 hint 行回闲（(/ for commands 重现）。遗留：本机质变更流属性新增不适用（如每回合 cache 命中率），需时再议。测试 +2（661→663）
- **审查闭环（同日）**：reviewer 判 OK with notes（无 P0/P1：锚点算法/重绕稳定性、统计门控全部调用点、print 字节、pi 对齐事实均逐项源验确认）。P2×3 已核实并修（`a98e45f`）：line-input addFold 注释换内联描述；子组件拼接改逐行 append（消每帧全量拷贝 + V8 spread 上限）；交错测试补 80→30 resize 后顺序不漂的重绕钉（repl-fold FakeTerminal 补 SIGWINCH）。合入 main `63e19dd`，663/663

- **#queue-parity 审查闭环（2026-09-10，661 tests）**：reviewer 判 OK-with-notes（无 P0）。**P1×2 已修**（同根因）：alt+enter 与 restore 路径此前读 raw getText——大粘贴（>10 行/1000 字符）在编辑器里是 `[paste #N]` 标记，提交/恢复会把字面标记排队且 setText 清空粘贴注册表致内容不可恢复（违反“用户输入不丢”）；修复=两处改 `getExpandedText().trim()`（与 Enter 的 submitValue 管线对齐），回归测试×2（alt+enter 提交体非标记；中止恢复展开草稿、视口尾行+无标记钉）。**P2×4 已修**：flushQueue 的 pendingExitCode 早退不再静默丢（交还+回显）；退出态（pendingExitCode/eofPending）恢复一律回显而非落进即将关闭的编辑器；恢复重解释语义代码内声明（blob 以 ! 开头=单个多行 bang、{prompt} 恢复后失去免重解释）；HELP_KEYS/金样补 alt+enter/alt+up/esc+p；shell.ts 布局注释同步。**记档**：esc+p 仅当 Esc+p 同一输入块到达（keys.js 识别 \x1bp 整体序列）；慢速分开按 Esc→p 仍走 M10 Esc 中断路径——既有行为，非本批回归。测试 +2（659→661）

- **#queue-parity 队列四项对齐 pi（2026-09-10，659 tests，feat/queue-parity）**：用户点名四差距全部闭环——①排队可见性：TUI 队列区升级为逐条预览（`N queued` 头 + 每条 `  steer:/follow-up:/bash:/prompt: <预览≤40列>` + `  ↳ alt+up / esc+p to edit all queued` 提示行，空队列零行折叠）；②撤回重编：`alt+up`/`esc+p`（pi-tui \x1bp 别名，无 Kitty 协议终端可用）整体回编辑器，当前草稿保留在下方，运行不受扰；③中止不丢：四处 discardQueue 全部改为 restoreQueueToEditor（TUI=编辑器+`▪ restored N`，legacy=逐行回显 `(not run)`），失败路径同规则（设计变更：原拟"失败后保留队列跨 run"，探针实证下一 run 首次 steering poll 会吞掉 held 行——跨 run 保留需 pi 式 agent 级队列，超出本批，改统一交还）；④follow-up 分流：QueueEntry 带 mode（Enter=steer 默认 / alt+enter=followUp），steeringMessages 只弹 steer 条目，settle 后 flush 逐条 drain；idle 时 alt+enter=普通提交。hint 行同步（`alt+enter follow-up`）。**遗留（记档）**：follow-up 为独立 REPL turn（各带回显+统计），非 pi 的同 run 内连续推进（需 loop 级 getFollowUpMessages）；legacy shell 无 alt 键位（Enter-only）。README 补终端兼容表（WezTerm 全屏冲突/Alacritty 需映射 \x1b[13;3u/esc+p 兜底）。测试 +5（shell 键位、分流不注入+独立 turn、esc+p 恢复含草稿、失败交还 legacy、abort 编辑器恢复改钉）

- **#logo-font-truth 字体原文件裁决（2026-09-10，654 tests，fix/logo-font-truth）**：用户目检报告 ①"i 第一个像素向右歪"②"p 右下角多两像素像 R"。**两处均为 bug 且都不是前两轮修的方向**。方法升级：拉取 ANSI Shadow.flf 原字体（xero/figlet-fonts）解析字形（行尾 @ 终止、$ 硬空格、7 行含空尾行、顺序码位、full-width=old_layout 0），**以 "hello" 全宽渲染逐字符命中经典图案验证提取器**后裁决：
  - **i = 纯竖笔**（`██╗/██║×4/╚═╝`，无点无偏移无尾随空隙——此字体小写 i 不带 tittle，与 l（8 宽带脚）不同）；上上轮"补的点状衬线"（` ██╗/██╔╝`）系凭空杜撰=用户看到的歪斜
  - **p = 碗形第 4 行收口**（`██╔═══╝`），第 5–6 行只剩左降部（`██║/╚═╝`）；我版右侧一路到底=用户看到的 R 感
  - **m 与字体一致** ✓；定稿六行=字体全宽拼接，钉子全量换字体原文
  - **核心教训（终版）**：视觉字形问题不得凭记忆裁决——三轮手打三轮翻车（丢 p→吞间隙→杜撰衬线+假降部），唯一可靠路径=获取字体源文件+程序化提取+已知渲染对照验证；此法已沉淀为本条目方法

- **#logo-gap 字母间隙（2026-09-10，654 tests，fix/logo-gap）**：用户再查前后 diff——仍缺 **i 与 m 的字母间隙列**：ANSI-Shadow 的 i 第 3–6 行字形带尾随空格（`██║ `/`╚═╝ `），首版拼接把它吞了，i 竖笔粘死 m 第一拱。修正方法=用字形数据程序化拼接（逐字母 verbatim 宽度、只去整行行尾空格）替代手打；钉子改为六行全断言（第 3–6 行显式带间隙空格）。
  - 踩坑续：手打字形的第二轮翻车证明**拼接必须程序化从字形数据生成**（我自己的修正脚本第一次还把 per-part rstrip 写错——尾随空格是接缝内部不能剥）；验证手段升级为"逐行与字形拼接结果对照"

- **#logo-imp logo 补全（2026-09-10，654 tests，fix/logo-imp）**：用户发现 logo 不完整——首版手打字形**漏了字母 p**（拼成 "im"）且 i 少顶点衬线。修正为完整 ANSI-Shadow 小写 "imp" 六行（i=带点竖笔、m=三拱、p=碗形+降部），渐变测试锚点从"首列=精确蓝停靠点"放宽为"首列≈蓝"（列位插值本就不落在停靠点上）。
  - 踩坑：手打 figlet 字形必须逐字母对照字体验证——凭记忆连写丢字母且不自知（用户肉眼抓出）；真机 smoke 只查了渐变转义与行存在，没查"拼的是什么"

- **#gemini-welcome Gemini 风格欢迎页（2026-09-10，654 tests，feat/gemini-welcome）**：用户给 Gemini CLI 截图，要求把该风格应用过来（zai-vision 识别：像素块大字 logo 蓝紫粉渐变 + "Tips for getting started:" 编号列表 + 无边框）。
  - **替换圆角框**：figlet ANSI-Shadow 像素 "imp" logo（██ 块，6 行×15 列）+ 逐列水平渐变（truecolor 38;2，三停靠点 (66,133,244)→(156,107,255)→(255,110,199)，空格不着色）+ Gemini 原版三条 tips 逐字（通用最佳实践：提问/改文件/跑命令、要具体、/help）+ dim 身份行（版本·session·模型）——**logo 即问候，无边框**；上一批的六条命令速查退役（/help 与占位符已覆盖）
  - 渐变门控 `renderer.ansiEnabled`（Renderer 新 getter）：非 ANSI 渲染纯文本 logo，测试封闭
  - 测试：结构钉重写（logo 两端行、三条 tips 逐字、身份行、旧 banner 消失）+ gradientLine 单元钉（ansi=false 无转义；true 首列蓝末列粉；tips 行永不着色）；四个锚点 "◆ Welcome to imp!" → "Tips for getting started:"
  - 真机：`██╗███╗   ███╗` 六行渐变 + tips + identity，扩展笔记随后；蓝粉 truecolor 均在

- **#welcome-order 欢迎页顺序优化（2026-09-10，653 tests，fix/welcome-order）**：用户晒启动截图评估出两问题：①扩展/上下文/信任 note 抢在欢迎页之前（噪音压过问候，本末倒置）②框内提示行 `/ commands · @ files · ! bash · Ctrl+D exits` 与 TUI 编辑器占位符逐字重复。
  - **启动 note 缓冲**（cli.ts，仅 interactive）：REPL 接管屏幕前所有 `▪` note（扩展行/上下文横幅/信任结果/恢复摘要）入队，`releaseStartupNotes` 在 runRepl 打完欢迎框或恢复 banner 后统一释放——问候置顶、环境噪音随后。**错误行与交互式询问照常实时**（走 error/confirm 路径不经过 note）；打印模式不包装、字节不变；/new 之后的 note 实时（已释放）
  - **框内提示行删除**：键位教学只留编辑器占位符一处（它还会在输入清空时复现，且多教 shift+enter）
  - 释放时机契约：fresh=欢迎框后；resumed=banner 后、`▪ session` note 前（相对顺序不变）
  - 测试：banner-order 测试翻转为新契约（welcome < extension < context）+ harness 复刻 cli 包装；+释放时机钉（RELEASED-HERE 探针，fresh 场景）；欢迎结构测试加 not.toContain("Ctrl+D exits"/"@ files")
  - 真机：框置顶、`▪ extension guardian/notify/…` 在框后、无重复提示行

- **#welcome-screen 欢迎页（2026-09-10，652 tests，feat/welcome-screen）**：用户要求仿 Claude Code 启动欢迎页。
  - **新会话（TUI interactive）**：圆角边框欢迎面板（整体 dim）：`◆ Welcome to imp!` + 六条高频命令速查（/help /model /new /compact /sessions /resume——全部真实存在，不虚构）+ 输入提示行（/ 命令 · @ 文件 · ! bash · Ctrl+D 退出）+ 身份行（版本 · session id8 · modelReference）；框宽按内容自适应（全 ASCII+◆ 单宽）
  - **恢复会话**：保持旧紧凑 banner（`imp 0.1.0 — /help...` + `▪ session` + `▪ replayed N`）——欢迎页是"新对话"时刻，不重复打扰（CC 同款语义：continuation 显示 "Continued from..."）
  - 判据 `session.stats().messageCount === 0`（上下文文件不算消息，agentsMd 场景仍算新会话）；**打印/管道模式字节不变**（interactive 分支外）；/new 不重弹欢迎页
  - 测试 +3：面板结构（框+命令行+身份行+旧 banner 消失）、interactive=false 无面板、恢复会话走旧 banner+replayed 且无面板；banner 顺序测试锚点改 `◆ Welcome to imp!`
  - 踩坑：**会话存储按扁平化 cwd 分目录**——resume 测试需共享 baseDir+cwd（startRepl 语义化为"传 sessionBaseDir 即同世界"）；欢迎页含 /compact 字样撞上 M10 测试的 not.toContain("/compact")（改为断言具体提示语 "low — /compact"）
  - 真机：glm-5.3 新会话框渲染正确

- **#footer-stats pi 式状态栏（2026-09-10，649 tests，feat/footer-stats）**：用户要求 footer 按 pi 展示模型状态（例：`↑15M ↓1.9M R415M CH99.6% $76.556 36.7%/1.0M (auto)`）。
  - **usage 段**（全部从 live history 累计）：↑↓ 现有 + `R`缓存读 + `W`缓存写（>0 才显示）+ `CH%` 末条命中率（pi 公式 cacheRead/(input+R+W)，取最后一条报了缓存数据的 assistant）
  - **$ 成本**：`models.ts` 新增每百万 token 费率表（出处=pi 的 provider 目录 JSON：anthropic API 价、zai 全 0+subscription、openai-codex API 价+subscription；**分层计价>272k 未建模**，长会话 tiered 模型略低估——记档）；**每条 assistant 消息打 model 戳**（loop 在 streamAssistant 出口打，新字段可选、旧会话回退当前模型费率）→ 会话中途 /model 切换各按各价；订阅族显示 `$0.000 (sub)`（pi 语义：流量走套餐，数字=API 价等效值）；表外模型整段省略
  - **ctx 段**：`ctx N%` → `36.7%/1.0M (auto)`（一位小数+窗口尺寸+自动压缩指示，IMP_AUTOCOMPACT=0 时无 (auto)）；80% 低上下文提示与 note 同步改一位小数
  - **formatTokens 升级为 pi 精确算法**（<1k 原样 / <10k 一位小数 k / <1M 整 k / <10M 一位小数 M / 以上整 M）——全局统一（压缩 banner、task 预算拖尾、resume note 同步变化，测试断言随改）
  - Runner 接口加 `autoCompactEnabled`；打印模式字节不变（setFooter 本就 TUI 专属）
  - 测试 +8：CH 公式（末条而非累计）、无缓存无段、按生产模型计价（1.0M×$3/$15→$1.050）、(sub) 显示、表外省略、(auto) 开关、costFor 解析（canonical/bare/订阅/未知）、formatTokens 分档、loop model 打戳
  - 真机：glm-5.3 footer=`↑2.6k ↓3 CH0.0% · $0.000 (sub) · 0.3%/1.0M (auto)`
  - 踩坑：TUI 测试脚本第二段需要第二次发消息才触发（scriptedProvider 重复末段）；Runner 是接口+Impl 双层——getter 只加 Impl 会 TS2339（接口也要声明）

- **#overflow-grace 溢出优雅失败（2026-09-10，641 tests，feat/overflow-grace）**：用户问 500k 上下文切 272k 模型会发生什么。核实：imp 与 pi 的阈值压缩同构（都把全量转录单发摘要模型）——**单发摘要架构下"用小窗模型摘要超它窗口的转录"无解，是两家共同盲区**；pi 的差别是失败路径优雅（响应式 overflow 一次恢复+指引）。用户拍板"只做 pi 式优雅失败"（不做压缩先于收缩/硬截断）。
  - **isContextOverflowError**（compaction.ts）：跨 provider 短语识别（anthropic "prompt is too long"/openai "context_length_exceeded|maximum context"/codex 变体）；**overflowGuidance**：教学文案（数字+原因+两条出路：切大窗模型 /compact 或 /new）
  - **响应式一次恢复**（runner.runTurnOrRecoverFromOverflow，调用侧包裹不动方法体）：活请求报溢出→note→compactAndSplice（同快照 provider/settings/model）→成功则**重试（userMessage 抑制防重复入列——首次尝试已把 user 消息推进 history）**；压缩失败或重试再溢出→指引而非裸 400。**不设 pi 的同模型守卫**：imp 只捕获活错误不持久化错误消息，该场景不可能出现（记档）
  - **前置压缩失败教学化**（onBeforeTurn catch）：切小死锁场景（摘要请求自身超窗）从裸 400 变为指引；run_error 双源落日志（compaction/overflow-recovery）
  - 测试 +4：识别矩阵（四家短语真/两假阴性）、恢复成功（无重复 prompt+摘要帧入列）、二次溢出=指引且恰三次调用（fail→summarize→fail，无第三轮）、死锁教学（同族 /model+IMP_CONTEXT_WINDOW 缩窗触发前置路径）
  - 真机回归：glm 正常路径无变化。**遗留（用户知情）**：500k→272k 切换死锁仍不可自动解开（恢复会失败并指引手动路径）；"压缩先于收缩+硬截断"方案已设计未实施
  - 踩坑×3（同一课三犯）：**多步 python 脚本中途断言失败=零写盘**（三连"以为改了其实没改"——import 先落/主体后落的分裂态最难察觉）；biome 会把长参数行拆多行致锚点失配；**makeEnv 直连 runTurn 不流式渲染文本**（断言走 history 而非 output——e2e cross-family 测试当时删 output 断言就是这个原因）

- **M8 项目信任门 + /worktrees 清单（2026-09-06，`72ac78a`/`b3cd13f`，369 tests）**：把“clone 即 RCE”的洞补上，顺手清掉 M6b 设计 §7 预留的运维缺口。
  - **信任门（移植 pi trust-manager，逐行核验后裁剪）**：全局 `~/.imp/trust.json`（`Record<目录, boolean>`，排序+tab 缩进，diff 友好）；查询走**最近祖先**（monorepo 根信任一次全覆盖）；realpath 规范化防符号链接别名；坏文件=硬教学错误（绝不静默重诠）。权威序：`--trust`/`--no-trust` 旗标（落记录）→ 已记录决定 →（仅交互）启动前一次性 [y/N]（短命 readline，答案落记录；EOF/Ctrl+D=拒绝）。**print 模式未决=本会话拒绝且不落记录**+教学行（含文件与修复法），绝不挂死。门控面：`.imp/extensions` + `.imp/agents`；`AGENTS.md` 惯例不拦；全局 `~/.imp/` 自装免门；`-ne` 与门互斥语义明确。loader/runner 各加一个布尔参（只关项目层）。Claude Code 只贡献了提示语框定（"信任此目录的文件？"点名要加载什么）
  - **`/trust` 命令**：列全部记录+本目录生效决定（含决定来自哪个祖先）；`/trust remove <dir>` 撤销
  - **`/worktrees` 命令**（M6b §7 follow-up）：数据源 `git worktree list --porcelain` 过滤 `imp-worktree-*`（自有台账必然漂移，git 才是事实）；每条带 merged（`merge-base --is-ancestor` 对主检出 HEAD——merged 分支上没有可丢的工作）与变更统计（与子代理回传尾行同形）；未合并的给出 `git merge` 命令；非 git 目录=标准教学错误
  - **真机验证**：假"恶意"项目（evil.mjs 写 stderr）——无旗标 print 模式：教学行+项目层跳过+全局扩展完好、PWNED 不出现；`--trust` 落记录（`/private/tmp/...` 规范化路径）并加载；`--no-trust` 翻转记录并跳过。/worktrees 演示仓 ff-merge 前后 merged 翻转
  - **教训**：`bin/imp.js` 走 `dist/`——bin 级冒烟必须先 `npm run build`，只跑 `tsc --noEmit` 会拿陈旧产物得出假阳性（本轮第一次冒烟"PWNED 出现"即此）；交互式信任首问不可 pty 冒烟（与 M7 TtyConfirm 同限），以可注入流的 `askTrustOnce` 单元测试钉住（渲染字节、严格 y/yes、EOF=拒绝）

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
