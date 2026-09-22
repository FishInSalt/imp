# 提示词优化批(prompt audit)设计文档

状态:已实现(设计审查闭环后用户批准;系统提示 2704→1223 字符;测试 1023→1049)

## 0. 背景与目标

对 imp 全部 32 处模型可见文本做了盘点,并与 pi 逐项对照(2026-02-07/08)。
对照原则:**不照抄 pi**——每处先独立审视"该场景下模型需要什么信息",pi 的设计
仅在其确实更优时采纳。本批目标:

1. **降固定成本**:每请求必发的系统提示+工具描述瘦身(系统提示 2704 字符→
   约 1250;消除教学双写)。
2. **堵正确性洞**:被 token 上限截断的半截摘要不能成为永久 checkpoint。
3. **补路由能力**:MCP 工具进目录;roster 迁出 task description 并加预算。
4. **补互操作**:CLAUDE.md 系上下文文件兼容;上下文改 XML 边界。
5. **edit 高频路径变轻**:diff 不再发模型。

非目标(§6):SYSTEM.md 整替(用户裁定下一批再评估)、pi-subagents 安全段、
扩展 promptGuidelines 注入机制。

## 1. 判定总表

| # | 项 | 判定 | 一句话理由 |
|---|---|------|-----------|
| P1 | edit 成功输出只回一句话 | 采纳 pi | 模型写的 oldText/newText 精确命中=结果完全在预期内,diff 是零信息复述 |
| P2 | 摘要质量门(stopReason error/length) | 采纳 pi | 半截摘要落盘=永久错误 checkpoint |
| P3 | UPDATE 增量摘要 | 采纳 pi | 摘要的摘要逐代漂移;PRESERVE 结构更稳更省 |
| P4 | XML 上下文包装+5 文件名 | 采纳 pi | markdown 标题可被文件内容伪造;CLAUDE.md 互操作 |
| P5 | 目录 snippet 机制 | 采纳 pi 机制,**文案 imp 重写** | pi 的 "Read file contents" 零路由信息;snippet 应答"何时选它" |
| P6 | # Editing rules 并入核心规则+内容迁移 | imp 独立 | 4 条里 3 条与 edit description 重复;"编辑后验证"独有价值升核心规则 |
| P7 | MCP 工具进目录(100B/条+2KB 总量) | pi+imp 加码 | pi 不限总量,目录会随服务器数爆炸 |
| P8 | roster 迁系统块(16/12KB/512B) | pi 数值,imp 简化 | description 里拼 roster 使其无法静态缓存;数值上限是好卫生;opt-in 是 pi 生态规模的需求,imp 不需要 |
| P9 | read 单行超限 sed 兜底 | 采纳 pi | 教学补全,几行 |
| — | imp 核心规则 5 条保留(不降级为 pi 的 2 条) | 拒绝 pi | imp 的安全地基比 pi 的 always-guidelines 完整 |
| — | 主动性收尾句保留 | 拒绝 pi | imp 独有,对弱模型有效 |
| — | bash 截断注记保留 imp 版 | 拒绝 pi | imp 版多教了"用 read 工具读全量" |

## 2. 各项设计

### P1 edit 输出瘦身 + display 通道(本批唯一接口变更)

**现状**:`edit.ts:94` 返回 `Edited path (N applied):\n<diff 片段>`,模型收到整段
diff。渲染层(`render.ts:526 toolEnd`/fold)只读 `ToolResult.content`(即模型侧
文本)——**imp 没有独立的显示通道**;`ToolExecuteResult.output` 在 content 存在时
被丢弃(loop.ts:470)。

**设计**:
- `ToolExecuteResult` 增加可选 `display?: string`(仅显示用,永不进模型);
  `ToolResult`(loop 侧)同步增加 `display?: string`,loop 映射:
  `display: result.display`(content 存在与否都透传)。
- 渲染消费点统一改为 `result.display ?? contentText(result.content)`:
  `render.ts` 的 `toolEnd`/`resultSummary`(含 two-line 分支,replay 经
  Renderer 自动覆盖)与 **`repl/repl.ts showResultFold`**——后者是 TUI 下
  edit 结果的真正显示面(edit 契约按 `":\n"` 切分后走 diff 装饰 fold,
  repl.ts:586-598),edit 分支改用 `display ?? contentText`,display 保持
  `"<summary>:\n<diff>"` 形状即维持今天的 diff fold。`repl/transcript.ts`
  是字节汇,不经 ToolResult,不动。(审查 P1-1)
- edit 成功返回:
  - 模型(content):`Edited ${path}: ${n} edit${s} applied.`
  - 显示(display):保持今天的 `Edited path (N applied):\n<sections>` 全文
    (⎿ 首行与 fold 正文与今天一致)。
- edit 失败路径不变(教学错误继续直发模型)。

**持久化拆分(审查 P1-2)**:loop 现状把同一个 ToolResult 对象同时推进
history(→ onMessage → session appendMessage,JSON.stringify 整个条目)与
onEvent——照抄会把 display 写进每个 session 文件。设计改为:`runTool`
返回的 history 形 ToolResult **不带 display**;loop 在发 `tool_end` 事件时
发 `{ ...result, display }` 克隆(events-only)。测试钉:持久化 JSONL 行
无 `display` 键。resume 重放时 fold 显示 content 一句话,可接受,记档。
扩展的 `emitToolEnd` 继续看模型侧文本(contentText(content))——审计语义
正确,不加 display。

### P2 摘要质量门

`compaction.ts`:
- `compactHistory` 的 message_end 处理中捕获 `message.stopReason`;
  流结束后若为 `"max_tokens"` → throw `compaction: summary hit the token
  cap — incomplete, rejected`(摘要不落盘、不 splice)。**词表以 imp 为准**
  (messages.ts:54:`end_turn|tool_use|max_tokens|stop_sequence|null`,
  无 pi 的 error/length;provider 失败本就以 throw 传播,已到恢复缝——
  审查 P1-3)。
- `summarizeBranchSegment` **需先补 message_end 分支**(现状只收集
  text_delta)再挂同一 `max_tokens` 门(分支摘要同风险)。
- 空摘要检查保留。

调用方行为不变:主循环/子代理的恢复缝把 throw 当 summarizer 失败处理
(重试/断路器/guidance),已存在,无需改。

### P3 UPDATE 增量摘要

**现状**:第二次压缩把 `[Conversation summary — …]` 框架消息当普通 user 消息
混进转录重新总结——每代漂移。

**设计**(`compaction.ts compactHistory`):
- 切割后检查 `messages[0]`:若 content **为 string 且**以 `SUMMARY_MARK`
  (`"[Conversation summary —"`,store.ts:596)开头——M13 后 content 可能是
  ContentBlock[],必须先判型(审查 P3-2)——提取 `"]\n\n"` 之后的
  正文为 `previousSummary`;`toSummarize` 改为 `messages.slice(1, cut)`
  (摘要消息本身不再进转录)。
- **空转录护栏(审查 P3-1)**:`cut === 1`(只有摘要消息老于边界)时
  `toSummarize` 为空——对空转录跑 UPDATE 正是 P3 要阻止的漂移;
  此时 `return null`(不压缩,下一边界再试)。
- 有 `previousSummary` 时 user 消息为:

  ```
  <previous-summary>
  {previousSummary}
  </previous-summary>

  {transcript}

  ---

  {UPDATE_SUMMARIZATION_PROMPT}
  ```

  无则维持今天的 CREATE 形状。`UPDATE_SUMMARIZATION_PROMPT` 采用 pi 的
  RULES 文案(PRESERVE 既有信息/ADD 新信息/移动 Progress 条目/可删失效项)
  + 相同 EXACT format 模板,全文写入本设计附录 A。
- system prompt、maxTokens 2048、usage 记账、splice 形状全部不变。
- 会话路径(compactSession→buildContext)与无 session 路径
  (summaryToMessage splice)都会产生 SUMMARY_MARK 头消息,统一命中。

### P4 上下文文件:5 文件名 + per-dir first-match + XML 包装

`context-files.ts`:
- `CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD",
  "CLAUDE.md", "CLAUDE.MD"]`(pi 全量,含 Windows 大写变体)。
- **每目录只取第一个命中**(现状:同目录多名会全部收录;改为 candidates
  顺序即优先级:override > AGENTS > CLAUDE)。**读取失败向下穿透**(pi 同款,
  resource-loader.ts:72-90):不可读的 AGENTS.md 不得占位遮蔽可读的
  CLAUDE.md(审查 P3-4)。全局 `~/.imp/AGENTS.md` 先于
  祖先链,维持现状;**全局文件名保持仅 `AGENTS.md`**(不在 5 名单内——否则
  `~/.imp/CLAUDE.md` 会新增加载,行为变化需显式决策,审查 P3-3)。
- `LoadedContext` 改为携带 `{ path, content }[]`(不再预拼 markdown 标题)。

`runner.ts assembleSystem`:
- 输出改 XML(pi 形状):

  ```
  <project_context>
  Project-specific instructions and guidelines:

  <project_instructions path="/abs/path/AGENTS.md">
  {content}
  </project_instructions>

  </project_context>
  ```

- `▪ context: …` note(用户侧)不变。
- 信任门维持现状(AGENTS.md 现状不受 M8 门控;CLAUDE.md 与 AGENTS.md 同
  等对待,记档:与 pi 一致——pi 的项目上下文文件同样不走 SYSTEM.md 那种
  trust 专门门控)。

### P5+P6 系统提示重组(目录 snippet 机制 + 规则合并)

**Tool 接口**(`tools/types.ts`):增加可选 `promptSnippet?: string`
(一行,进系统提示目录)。

**目录文案(imp 重写,落在各工具文件)**:

```
bash:  "run shell commands — builds, tests, git; anything without a dedicated tool. Never interactive."
read:  "read files (text or images); truncation notes tell you how to continue reading."
grep:  "find where code is defined or used (respects .gitignore) — prefer over bash grep."
find:  "find files by name glob (respects .gitignore) — prefer over bash find."
ls:    "list one directory's entries (dotfiles included)."
edit:  "precise in-place edits; each oldText must match exactly and be unique."
write: "create or overwrite whole files — never for small changes."
task:  "delegate a self-contained multi-step job to a fresh subagent."
```

**内容迁移**(防丢):
- read description 已含续读指引句,无需迁移。
- bash description 已含 "Avoid interactive commands (they hang until
  timeout)"(bash.ts:79)——**无需再补**,snippet 的 "Never interactive."
  是目录层的路由红线,不算重复(审查 P3-5)。

**buildSystemPrompt 重写**(`system-prompt.ts`,签名改为接收
`tools: Array<{ name: string; promptSnippet?: string }>`):

```
You are imp, a small coding agent that runs in the user's terminal.

# Environment
- Working directory: {cwd}
- Platform: {platform} ({arch}), shell: bash
- Date: {date}

# Core rules
1. Work inside the current working directory unless the user explicitly asks otherwise.
2. Inspect before you modify: read a file (or list/grep via bash) before editing it. Never guess file contents.
3. After editing code, verify the change — run it or its tests.
4. Be concise. State what you changed (file paths, commands run); do not dump whole files back at the user.
5. If a task fails, say what failed and why. Do not silently give up or fake success.
6. When a request is ambiguous or destructive beyond the workspace, ask the user first.

# Available tools
- bash: run shell commands — builds, tests, git; anything without a dedicated tool. Never interactive.
- read: read files (text or images); truncation notes tell you how to continue reading.
- grep: find where code is defined or used (respects .gitignore) — prefer over bash grep.
- find: find files by name glob (respects .gitignore) — prefer over bash find.
- ls: list one directory's entries (dotfiles included).
- edit: precise in-place edits; each oldText must match exactly and be unique.
- write: create or overwrite whole files — never for small changes.
- task: delegate a self-contained multi-step job to a fresh subagent.
- {mcp 工具目录行,见 P7}

In addition to the tools above, you may have access to other tools depending on the project.

Use tools proactively to establish facts; base your answers on observed output, not assumptions.
```

约 1250 字符(现状 2704)。`# Tools` 教学段与 `# Editing rules` 段整体删除
(内容分别被 snippet/description 与核心规则吸收)。

**组装序不变**:主提示 → `<project_context>` → 扩展区 → skills →
`<advertised_agents>`(P8)。

### P7 MCP 工具目录

- `Tool` 增加可选 `mcpServer?: string`(bridge 创建工具时填写,亦是元数据)。
- bridge 的 `promptSnippet = truncateAtWord(description, 100)`(词边界截断,
  截断加 `…`;pi adapter 同参数)。目录行显示**带前缀的完整调用名**
  (`zai-vision_analyze_image: …`)——模型按调用名路由。
- `assembleSystem` 汇总 mcpServer 标记的工具目录行字节数:**> 2048B 时整段
  降级**为每服务器一行 `MCP server {name}: {n} tools (descriptions in the
  tool list)`。
- **组装时机(审查 P2-1)**:assembleSystem 现在只在 warmup 与 /new//resume
  跑,而 MCP 工具在握手完成后才落进共享数组(cli.ts:597 后置接线、
  manager 的 run 边界 flush)——按原设计目录恒为空。设计:manager 增加
  可选 `onToolsChanged?: () => void`(每次 syncNow 之后调用:run 边界与
  握手两处),cli 接线到新的 `runner.refreshSystemPrompt()`(重跑
  assembleSystem 写回 this.system;task 工具经 getSystem 动态读)。prompt
  cache 说明:字符串仅在实际工具集变化时改变,重建本身不产生 churn。
- `truncateAtWord` 为 pi 助手,imp 需自实现(bridge 内或 shared util)。
- 不做 per-tool 截断以外的内容清洗(服务器自述质量由服务器负责)。

### P8 roster 迁系统块

- `task.ts` description 去掉 `${roster}` 拼接,恢复静态;
  `agent` 参数描述改 "Named agent to run (see <advertised_agents> in the
  system prompt if present); omit for a generic subagent"——无注册 agent 或
  项目层被 trust 门控时块不存在,措辞需容忍(审查 P3-6)。
- `assembleSystem`(`runner.ts`,数据源 `this.agents`)生成:

  ```
  <advertised_agents>
  Agent descriptions indicate available specializations, not instructions to delegate.
    <agent>
      <name>scout</name>
      <description>…</description>
    </agent>
  </advertised_agents>
  ```

- 数值上限(pi-subagents 同款):每条 description 压缩空白后 ≤512 字节(超限
  词边界截断+`…`)、最多 16 条(字典序)、总块 ≤12288 字节(超出丢弃后续
  条目并加 `<omitted count="N" />`)。XML 转义复用 skills 的 escapeXml(**需导出**,审查 P3-8)。
- 警示行作用:子代理继承父系统提示会看到此块,但子代理没有 task 工具
  (CHILD_SUFFIX 已声明)——一行消歧。
- 信任门现状不变:项目 `.imp/agents` 未过 M8 门时不进 registry,自然不进
  此块;task 工具的 gated 提示文案保留。

### P9 read 单行超限兜底

`read.ts`:选中范围内首行单独超过 `MAX_BYTES` 时,返回
`[Line {n} is {size}, exceeds {MAX_BYTES/1024}KB limit. Use bash: sed -n '{n}p' {path} | head -c {MAX_BYTES}]`
(pi 同款;formatSize 风格 KB/MB)。其余截断路径不变。

## 3. 兼容性

- 已存 session:系统提示不入库、每次重组,重放无影响;edit 的模型侧文本变化
  只影响新 turn。
- 子代理:继承重组后的父提示+CHILD_SUFFIX,P8 警示行覆盖 roster 误导。
- print 模式 / REPL / TUI 共用 assembleSystem,一处改三处生效。
- `IMP_AUTOCOMPACT` 等门与提示词无关,不动。

## 4. 测试计划(预计 +20 例,1009→…基线以合并时为准)

- **edit(display 通道)**:3 例——模型侧 content 为一句话且不含 diff 标记;
  display 含 diff 且 fold/⎿ 用 display;loop 映射 display 透传(content 缺省
  时 display 仍可用)。
- **质量门**:2 例——stopReason length → throw 且 history 未 splice/未
  appendCompaction;branch summary 同。
- **UPDATE 摘要**:2 例——二次压缩的请求 user 消息含 `<previous-summary>`
  且转录不含旧摘要消息;CREATE 首压缩形状不变(防回归)。
- **上下文文件**:4 例——同目录 AGENTS.md+CLAUDE.md 只取 AGENTS;仅
  CLAUDE.md 时收录;override 优先;输出为 `<project_instructions path=…>`
  XML。
- **系统提示**:3 例——目录来自 tools 的 snippet(含 task 行);无
  `# Editing rules`/旧 `# Tools` 段;核心规则含验证条。
- **MCP 目录**:3 例——bridge snippet 100 词边界截断;目录行用带前缀名;
  超 2KB 降级为服务器行。
- **roster 块**:3 例——块渲染+转义;512B/16 条/12KB 三上限各自触发。
- **read 单行超限**:1 例——超大单行返回 sed 提示。
- **既有测试改点(审查 P3-7)**:`task-tool.test.ts:574`(buildSystemPrompt
  签名变更)、`context-files.test.ts:37-46`(LoadedContext 形状变更)、
  及所有断言旧系统提示形状的用例(system-prompt 快照/runner 组装)。

## 5. 决策记录

- **D1 判定原则**:独立审视优先,pi 仅在其设计经得起推敲时采纳(P1-P4/P9
  全采纳;P5 机制采纳文案重写;核心规则/主动性句/bash 注记拒绝 pi 化)。
- **D2 display 通道**:ToolResult 增可选 display——渲染消费点显式回退
  `display ?? contentText(content)`。这是唯一接口变更,理由:渲染层与模型
  侧共用 content 是结构性耦合,edit 瘦身必须拆开。
- **D3 目录文案**:snippet 答"何时选它"(路由),how 留在 description;
  与 Claude Code 目录同构,与 pi 的干瘪 snippet 不同。
- **D4 上下文候选**:全 5 名(pi 全量,含大写变体——成本为零的 Windows
  互操作);per-dir first-match(多名同目录只取最高优先级)。
- **D5 UPDATE 形状**:`<previous-summary>` 包裹+转录+RULES 提示;
  SUMMARY_MARK 头消息不再混入转录。
- **D6 MCP 预算**:单条 100 词边界+总量 2KB 降级——pi 无总量限制,imp
  加码(服务器数量不可控)。
- **D7 roster**:数值上限抄 pi-subagents(16/12KB/512B);opt-in advertise
  不做(imp 注册量小;记档触发=注册量增长)。
- **D8 质量门**:error|length 双 stopReason,压缩与分支摘要两处;空摘要
  检查保留。
- **D9 延后**:SYSTEM.md/APPEND_SYSTEM.md 整替(用户裁定:本批不做,下一
  批再看);扩展 promptGuidelines 注入(contextSections 已覆盖);
  pi-subagents 安全段(治理产物)。
- **D10 显式取代 M18-D6**(审查 P2-2):M18 记录"不加 MCP 系统提示段——
  promptSnippet 纯冗余(描述已随 tools 数组进模型)"。本批重开该判定,
  新理由:(a) P5 使系统提示成为路由目录,8 个 MCP 工具缺席目录形成不一致
  的路由面(模型对系统提示的注意力显著高于 tools schema);(b) 多服务器
  场景描述质量不可控,100B/条+2KB 总量预算把暴露面封顶——M18 当时的
  单服务器冗余论点不再覆盖新场景。实现时在 PROJECT_PLAN 账本记
  supersedes-M18-D6。

## 6. 附录 A:UPDATE_SUMMARIZATION_PROMPT 全文

```
The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

(pi 的 RULES+模板原文;Create 版 SUMMARIZATION_PROMPT 维持 imp 现状不动。)

## 6.5 独立设计审查记录(2026-02-08)

reviewer(fresh context)判 **needs-fixes**,全部发现经亲自核实后落入上文:

- **P1-1 display 消费面错列**:TUI 下 edit 结果的真正显示面是
  `repl/repl.ts showResultFold`(edit 契约 `":\n"` 切分+diff fold,
  :586-598),transcript.ts 是字节汇不经 ToolResult、replay 经 Renderer
  自动覆盖——消费面改为 render.ts+repl.ts。已修。
- **P1-2 display 会写进 session**:loop 把同一 ToolResult 推 history 与
  onEvent,appendMessage 整体 JSON.stringify——改为 history 形不带
  display、tool_end 事件带(events-only 克隆),测试钉 JSONL 无 display
  键。已修。
- **P1-3 质量门词表错误**:imp StopReason 无 error/length,token 上限是
  `max_tokens`(messages.ts:54);provider 失败以 throw 传播已达恢复缝
  (subagent 断路器/主循环 guidance 核实属实)。门改为 max_tokens;
  分支摘要需先补 message_end 分支。已修。
- **P2-1 MCP 目录组装时机**:assembleSystem 仅 warmup//new//resume 运行,
  而 MCP 工具 run 边界才落地——目录恒空。增加 manager
  onToolsChanged→runner.refreshSystemPrompt,记录 prompt-cache 论证。已修。
- **P2-2 未记录取代 M18-D6**:本批 P7 与 M18 账本"不加 MCP 提示段"决策
  冲突——§5 增 D10 显式取代+新理由(路由面一致性+预算封顶),实现时账本
  记 supersedes。已修。
- **P3×8 加固**:UPDATE 空转录 return null;SUMMARY_MARK 判型(string);
  全局文件名保持仅 AGENTS.md;per-dir 读取失败穿透;bash 禁交互句不重复
  补;agent 参数措辞容忍块缺席;测试波及面清单(task-tool:574/
  context-files:37-46);escapeXml 导出。全部落入对应小节。

审查同时核实通过的关键前提:恢复缝确实已处理 summarizer throw;两条
splice 路径都产生 SUMMARY_MARK 头且 cut≥1 时形状良构;home 目录不可能经
祖先链双重加载;估算/压缩数学不读系统提示(瘦身不影响阈值);pi 参考文本
(UPDATE prompt/sed 提示/candidates 顺序/pi-subagents 数值上限)逐字核对
与源一致。

verdict 摘录:"architecture of the batch … sound and well-matched to the
verified seams; every judgment in §1 is directionally correct"。
