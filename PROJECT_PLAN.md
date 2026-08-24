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

**任务清单**
- [ ] 脚手架：`package.json`（ESM + TypeScript）、`vitest`、`tsup`/`tsx`、ESLint
- [ ] `provider/`：选定 provider 的流式 API 封装
  - 统一事件模型：`text_delta` / `tool_call_start` / `tool_call_delta` / `message_start` / `message_end` / `usage`
  - 请求组装：messages + tools(JSON Schema) + system
  - 工具调用参数的流式累积与最终解析
- [ ] `core/messages.ts`：定义 `AgentMessage` 联合类型
- [ ] `core/loop.ts`：agent 主循环
  ```
  用户消息入栈 → 调 LLM(流式) → 若含 tool_use：
    逐个执行工具 → 把 tool_result 追加为 user 消息 → 再调 LLM
    → 直到 assistant 不再产生工具调用 → 本轮结束
  ```
  - 支持 AbortSignal（Ctrl+C 可中断）
  - 工具参数校验（JSON Schema validate，失败要返回错误给模型而不是崩溃）
  - 工具执行异常捕获，转为 `tool_result(isError: true)` 喂回模型
- [ ] 工具 ×2：`bash`（超时 + 输出截断）、`read`（行范围 + 大文件截断）
- [ ] `cli/`：`imp -p "..."` print 模式，流式打印到 stdout
- [ ] 系统提示词 v1：角色、工具使用规范、安全边界（workspace 内读写）

**验收标准**
```bash
imp -p "当前目录下有哪些 .ts 文件？统计总行数"
# → 模型自主调用 bash/ls 工具并给出正确答案
imp -p "读取 foo.ts 并修复其中的类型错误"   # 能改文件
```

**对照 pi 源码**：`packages/agent/src/agent-loop.ts`、`packages/agent/src/stream-fn.ts`、`packages/agent/src/harness/tools/bash.ts`、`tools/read.ts`

---

### M1 — 完整工具集 + 工程质量（1~2 周）

**任务清单**
- [ ] `write` 工具：整文件写入（参考 pi 仅 39 行）
- [ ] `edit` 工具：精确文本替换（oldText 必须唯一匹配，支持一次多处编辑）
  - 失败时返回有用的错误（"匹配 0 次/匹配 N 次"）
  - 彩色 diff 渲染（参考 pi `tools/edit-diff.ts`，500 行，可先简化）
- [ ] `grep` / `find` / `ls` 工具（或先让模型用 bash 凑合，观察日志再决定）
- [ ] 并发文件写保护：同一文件的写操作串行化（参考 `file-mutation-queue.ts`，56 行）
- [ ] AGENTS.md 上下文文件加载（全局 + 向上遍历父目录 + 当前目录，拼接进 system prompt）
- [ ] bash 输出截断完善：超限写临时文件，把路径告知模型
- [ ] 集成测试：对真实 mini 项目跑"加函数→跑测试→修错误"闭环
- [ ] 日志：完整记录每轮 LLM 请求/响应（调试生命线，类似 pi 的 `/debug`）

**验收标准**：在一个真实小仓库上完成"实现一个函数并通过其测试"的自主任务；全程无人工干预。

**对照 pi 源码**：`tools/edit.ts`（127 行）、`tools/write.ts`、`harness/system-prompt.ts`、`harness/utils/truncate.ts`

---

### M2 — 会话管理 + 上下文工程（2 周）

**任务清单**
- [ ] JSONL 会话文件：每行一条消息（`id`、`parentId`、时间戳、usage）
  - 存储位置：`~/.imp/sessions/<project-hash>/<uuid>.jsonl`
  - 树结构：消息追加只认 `parentId` 链，天然支持分支
- [ ] `--continue` / `--resume <id>`：恢复最近/指定会话
- [ ] Token 计量与成本显示（input/output/cache 分开）
- [ ] **Compaction（压缩）**：上下文快满时，用 LLM 把旧消息总结成一条 summary 消息替换
  - 保留最近 N 条 + 全部活跃文件路径等关键信息
  - 触发策略：先手动命令，后自动（剩余 <15% 时）
  - 原始历史不删，仍在 JSONL 里
- [ ] steering：流式执行中允许用户插话（M0 可先做简单版：新消息排队到本轮工具执行间隙注入）

**验收标准**：单会话连续工作 50+ 轮不爆上下文；kill 进程后 resume 能无缝继续。

**对照 pi 源码**：`harness/session/`（session.ts、jsonl-storage.ts、jsonl-repo.ts）、`harness/compaction/compaction.ts`；文档 `docs/session-format.md`、`docs/compaction.md`

---

### M3 — 交互式体验（2~4 周，按野心裁剪）

**建议两步走：**

**3a. readline REPL（3~5 天）**
- [ ] 多轮对话、`/exit` `/new` `/model` `/compact` 基础命令
- [ ] 流式渲染 assistant 输出、工具调用过程展示（工具名+参数摘要+结果状态）
- [ ] Ctrl+C 中断当前轮（恢复到可输入状态）

**3b. 真 TUI（可选，量大）**
- [ ] 选型：自研（参考 pi-tui 的组件思路）vs [ink](https://github.com/vadimdemedes/ink)（React 式终端 UI）
- [ ] 编辑器组件：多行输入、历史、`@` 文件模糊补全
- [ ] 消息区：markdown 渲染、工具输出折叠/展开
- [ ] 状态栏：cwd / 模型 / token / 成本 / 上下文占用
- [ ] 会话树浏览器（`/tree`）

**验收标准（3a 后就够日常自用）**：交互模式下完成一次 30 分钟的真实编码会话，全程不用退出。

**对照 pi 源码**：`packages/tui/src`、`coding-agent/src/modes/interactive/`；文档 `docs/tui.md`、`docs/keybindings.md`

---

### M4 — 扩展系统（2~3 周，可选）

- [ ] 扩展 = 一个 TS/JS 模块，默认导出 `function(api)`，`api` 提供：
  - `registerTool()` / `registerCommand()` / `on(event, handler)`
  - 事件：`tool_call`（可拦截/改写/否决）、`message_start`、`session_end`…
- [ ] 热加载：改扩展文件不重启（watch + 重新 import）
- [ ] 基于扩展实现 2 个实战案例验证 API 设计：
  1. 权限门：`bash`/`write` 前弹确认（pi 刻意不内置，我们用扩展补）
  2. 简易 sub-agent：注册一个"派生任务"工具，内部再起一个 agent loop

**对照 pi 源码**：`coding-agent/src/core/extensions/`；文档 `docs/extensions.md` + `examples/extensions/`

---

### M5 — 锦上添花（按需）

- 多 provider（抽象出 provider 接口 + 能力探测：工具调用/视觉/思考模式）
- `--mode json` 事件流输出 / RPC 模式（进程集成）
- Skills 机制（按需加载的 SKILL.md 能力包）
- 提示词模板、主题
- GitHub 发布 + `npm install -g`（npm 上 `imp` 短名大概率被占，发 scope 包 `@<user>/imp`，bin 名仍设为 `imp`）

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
