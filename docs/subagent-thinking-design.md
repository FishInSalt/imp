# 子代理思考策略：frontmatter 档位 + 继承父会话 + 显式化（SA-09 设计，draft）

状态：**draft，待独立对抗评审**（本文件通过评审前不得进入实现）。
日期：2026-09-30。分支：`feat/subagent-thinking`。前置：SA-02（子模型绑定，已合入）、#output-truncation D3b（子请求预算=目录值，已合入 `df4becb`）。

## 0. 目标与非目标

**目标**：子代理的思考档位成为显式策略——由且仅由两个来源决定：

1. `agent frontmatter` 的 `thinking:` 字段（按 agent 固定）；
2. 没写时**继承父会话当前档位**（spawn 时读取）。

并把解析结果**如实**写进子代理的每一个 LLM 请求（"显式化"），使实际行为由策略决定，而不由"未传参 × provider 家族回落"决定。

**非目标**（owner 决策，2026-09-30；各记触发条件见 D6）：settings 层（`subagents.defaultThinking` / `maxThinking` / `disableThinking` / `agentOverrides`）、per-run 覆盖（task 参数换档）、主会话请求的 off 形状改动、任何显示面改动。

## 1. 现状与证据

### 1.1 结构性事实（代码位点）

- 子代理链路没有档位：`SubagentOptions`（`src/core/subagent.ts:28-95`）无 `thinking` 字段；`launchLoop`（`:322-352`）的 `runAgentLoop` 调用（`:338`）不传 `thinking`；溢出重试的第二次 launch（`:433`）复用同一 options——修复点只有这一处 seam。
- 请求通路已就绪：`RunAgentLoopOptions.thinking`（`src/core/loop.ts:48-49`）被逐请求转发（`loop.ts:211`）；`LLMRequest.thinking`（`src/provider/types.ts:27`）。
- agent frontmatter（`src/core/agents/registry.ts:120-215`）字段：`name` / `description` / `tools` / `model` / `timeout` / `worktree`——无 `thinking`。校验先例：`timeout`、`worktree` 非法值 → 解析错误、文件跳过、warning（`:155-176`）；空白 `model:` 是显式配置错误、留给调度期拒绝（SA-02 C6，`:136-138`）。
- task spawn：父模型/provider 在同步步进里钉住（SA-08 round 3 F-4，`src/core/tools/task.ts:711-718`）；fresh dispatch 在 `:853-880` 组装 `runSubagent`；resume 在 `:613-640`，其中 `resumeAgent` 从**当前**注册表重取（`:482`），`extraSystem`、`timeoutMs` 用当前文件值（`:598`、`:619`）——`model`/`role`/`cwd`/`worktree` 冻结，文件内容与 timeout 以当前为准。
- 主会话档位：`runner.thinkingLevel`（`src/runner.ts:1121`），启动时 clamp 到当前模型（`:501-509`）；主请求把 `off` 映射为 `undefined`（`:1472`，pi parity 形状）；task 工具接线在 `:548-551`（`getProvider`/`getModel`/`getModelReference` 同类 getter 先例）。
- clamp 与线格：`THINKING_LEVELS`（`src/provider/thinking.ts:21`）；`supportedThinkingLevels`（`:548`）、`clampThinkingLevel`（`:567`，不可用档位先向上、再向下取最近）；线格映射在 `openai-completions.ts:326-356`（glm-openai / deepseek / openai-effort 三支）与 `anthropic.ts:178-209`（budget / adaptive / glm-anthropic + 显式 disabled 的 else-if）。
- 子代理自己的压缩摘要器**不**带档位：`subagent.ts:256`（`compactSession`）、`:274`（`compactHistory`）都不传 `thinking`；而两函数与 `runSummarizer` 均支持（`src/core/compaction.ts:403`、`:527`、`:604`；off→undefined 在 `:424`）。主会话的摘要器搭 session 档位（`runner.ts:1020`：`thinking: this.level`）。

### 1.2 未传档位时的线上行为（子代理现状）

`thinking` 为 `undefined` 时，各家族的回落分支（已逐支核读）：

| 模型类别 | undefined 的线格结果 | 子代理实际行为 |
| --- | --- | --- |
| off 允许的已知模型（deepseek-flash、zai GLM、Claude ≥4.6 等） | 显式 disabled（`openai-completions.ts:342-349`；anthropic else-if `:205-209`） | 关思考 |
| `off:null` 强制推理模型（fable-5、kimi-k2.7-code、gpt-5-pro 系列等） | 不写字段（各支均以 `off !== null` 判断） | 模型默认（通常照常推理） |
| 未知模型（meta `null`） | 不写字段 | 模型默认 |

**更正**：本仓库 SA-09 backlog 原文称"anthropic-messages 省略字段 = 新 Claude 默认开"——不准确；对 off 允许的 Claude 模型，`undefined` 走显式 disabled（上表第 1 行）。真正落到"模型默认"的只有 `off:null` 与未知模型两类。

实测佐证：deepseek-flash 子会话 21 回合零 thinking 块（2026-09-30，child JSONL）——与该家族"显式关"一致。

### 1.3 前置条件（已满足）

`#output-truncation` D3b 已让子请求预算取目录值（deepseek-flash = 384000），思考不再立刻撞旧的 8192 上限；截断可见性与截断工具调用拒绝对子代理同规则生效（`df4becb` 已合入）。

## 2. 决策记录

### D1 解析模型：frontmatter > 继承父会话（owner 已定，2026-09-30）

```
agent frontmatter thinking: <level>   → 用它
没写                                  → 父会话 spawn 时的当前档位
```

- 只有这两个来源；**无 settings 层**。论证：pi-subagents 的 `defaultThinking`/`agentOverrides`/`maxThinking` 服务于"随包发布、用户不可编辑的内建 agent"；imp 的 registry 从第一天起全归用户所有（registry 头注释 "No builtin agents"），每个 agent 文件都可直接改，全局默认层与天花板解决的"改不了文件"问题不存在，少一层也少一个"没写时用哪个"的歧义。
- 语义自洽：子代理是会话的延伸（父级 off → 子级 off；父级 max → 子级 max——**owner 已知情并接受**"没写 frontmatter 的 agent 全部继承 max"的成本后果）。
- 档位经 provider 的 clamp 落到子模型可表达的最近档位（见 D2 表；解析层不做 clamp，与主会话一致）。

### D2 显式化：解析结果如实进请求

- 解析出的档位**原样**传 `runAgentLoop({ thinking })` → 每个子请求 `thinking: <level>`（包含 `"off"`）；provider 现有的 `clampThinkingLevel` + 线格映射负责表达。**无 provider 改动**。
- `off` 的线格（本批后，子代理视角）：

| 模型类别 | 子=`off` 时 | 与现状差异 |
| --- | --- | --- |
| off 允许的已知模型 | 显式 disabled | 无（与今天回落一致） |
| `off:null` 强制推理模型 | clamp 到**最低可用档**并显式表达（如 claude-fable-5：off→minimal，adaptive 映射为 effort "low"；kimi-k2.7-code：off→minimal→thinking enabled；gpt-5-pro 系列：off→high） | **有**：今天不写字段=模型默认；现在是最低档显式 |
| 未知模型（meta `null`） | clamp 后仍 `off`，无分支命中 → 不写字段 | 无 |

- 非 off 档位（本批新能力）：所有家族显式启用（deepseek/GLM enabled(+effort)；Claude adaptive/budget 按档位）。
- **范围边界**：主请求的 `off→undefined`（`runner.ts:1472`）本批不动。差异仅在 `off:null` 模型上可见（子=最低档显式、主=模型默认）；不在本批扩大行为变更面（D6）。
- 继承档位在子模型上不可用时的既有 clamp 语义（pi parity）——文档示例：父 `low` + 子 `gpt-5-pro`（只支持 high）→ 子 high；父 `max` + 子 GLM 5.2（binary/稀疏图）→ 按图向上取最近可表达档。这是 clamp 的既定行为，不是本批新语义。

### D3 读取时机：spawn 时钉住；resume 时重新解析

- `TaskToolOptions` 新增可选 `getThinkingLevel?: () => ThinkingLevel`；runner 接线 `() => this.thinkingLevel`（与 `getModelReference` 同"真 runner 总是接上"模式；缺席 → `undefined` → 旧行为，测试与自定义 wiring 不受影响）。
- fresh dispatch：父级读取放进 F-4 同步块（`task.ts:711-718` 旁），与 provider/model 一并钉住——本次尝试内不漂移。
- resume：重新解析（当前文件的 frontmatter + 当前父级）。先例对齐：`timeoutMs`/`extraSystem` 用当前文件；`model`/`role`/`cwd`/`worktree` 作为"尝试身份"冻结。thinking 是"本次生成的档位语义"，归入前者。
- 溢出重试的第二次 launch 复用同一解析值（attempt 内一致）。

### D4 frontmatter 字段与校验

- 新增可选字段 `thinking: <level>`；合法集 = `THINKING_LEVELS`（`off, minimal, low, medium, high, xhigh, max`），trim 后按小写归一。
- 非法值或**空白** `thinking:` → 解析错误、文件跳过、warning 一行（`timeout`/`worktree` 先例）；空白与 `model` 的 C6 处理一致（保留空值、判为显式配置错误、教学文案列全部档位）——理由：用户写了这一行即显式配置意图，静默当作"未出现"会吞掉配置；档位字段没有合法空值。
- `AgentDefinition.thinking?: ThinkingLevel`；`registry.ts` 头注释与 README 的 agent 格式段同步更新。

### D5 子代理自己的压缩摘要器也随身档位

- `compactChildHistory` 的两处调用（`subagent.ts:256`、`:274`）直传 `thinking: options.thinking`。
- 论证：子会话的**所有** LLM 调用遵守同一档位（主会话先例：摘要器搭 session 档位，`runner.ts:1020`）；off→undefined 的形状由 summarizer 请求层既有处理（`compaction.ts:424`）。
- 备选（评审可推翻）：保守不动、记触发条件。取舍点：一致/可预期 vs 摘要器成本（子代理短命、压缩频率低；主会话同一语义已被接受）。

### D6 明确不做（各记触发条件）

| 不做 | 触发条件（何时回来加） |
| --- | --- |
| `subagents.defaultThinking` / `agentOverrides` | 出现"想批量调档但不愿逐个改文件"的需求 |
| `subagents.maxThinking` 天花板 | 继承档位导致子代理成本/延迟实际成为困扰 |
| `subagents.disableThinking` 总开关 | 需要一个压过 frontmatter 的全局关闸 |
| per-run 覆盖（task 参数换档） | 出现"单次派发想换档、不想改文件"的需求 |
| 主请求 `off→undefined` 改动 | 要统一主子 off 语义时（会改变 off:null 模型上主会话的行为） |
| 显示面（任务卡片展示子档位等） | 实际需要时 |

## 3. 实现（文件与改动点）

1. `src/core/agents/registry.ts`：`AgentDefinition.thinking?: ThinkingLevel`；`parseAgentFile` 校验（D4）；头注释更新。
2. `src/core/tools/task.ts`：`TaskToolOptions.getThinkingLevel?`；F-4 块内钉住父级；fresh（`:802-805` 旁）与 resume（`:598` 旁）解析 `agent?.thinking ?? getThinkingLevel?.()` 并传 `runSubagent`。
3. `src/core/subagent.ts`：`SubagentOptions.thinking?: ThinkingLevel`；`launchLoop` 传入 `runAgentLoop`（存在才传，模式同 `maxTokens`）；压缩两处直传（D5）。
4. `src/runner.ts`：`createTaskTool({ ..., getThinkingLevel: () => this.thinkingLevel })`（`:+548-551` 区）。
5. `README.md`（agent 格式段）与 `docs/subagent-delegation-task-list.md`（SA-09 条目：改为已定契约 + anthropic 事实更正）。
6. 无 provider 改动（D2 已核验 raw `off` 与各档位被现有分支正确表达）。

## 4. 测试计划

- `test/agents-registry.test.ts`：合法档位解析；非法/空白 → 警告且文件跳过；大小写归一；合法文件不影响既有字段。
- `test/subagent.test.ts`：`SubagentOptions.thinking` → 每轮请求带 `thinking`（sink 捕 `LLMRequest`）；溢出重试第二轮同样带；未提供 → `undefined`（回归）。
- `test/task-tool.test.ts`：frontmatter 优先于继承；继承取 getter 值；getter 缺席 → 旧行为；spawn 后改 getter 不漂移（尝试内钉住）。
- `test/child-resume.test.ts`：resume 用当前文件 + 当前父级（两变量各改一次各测）。
- `test/child-compaction.test.ts`：子压缩摘要器请求带子档位（sink）。
- 线格：`test/deepseek.test.ts:187-205` 已有 "raw off 防御"与 "off:null + undefined 不掉字段"先例——新增/引用覆盖 `off` 在 off:null 上 **clamp 上移** 的子代理语义；`test/thinking.test.ts` 如缺 clamp(off) 于 off:null 的断言则补。
- 回归：全量套件；基线以开工时 main 为准（不复用旧测试数）。

## 5. 风险与回滚

- **成本/延迟**：继承=max 语义使未写 frontmatter 的 agent 全部按 max 思考（owner 已知情）。缓解：README 写明降档方法（frontmatter）。
- **off:null 行为变化**：子=`off` 从"模型默认"变为"最低档显式"——有意为之，文档化。
- **clamp 上移意外**：继承档位在子模型稀疏图上可能上移（low→high）。文档表现表说明，非本批语义。
- **兼容**：新字段可选，旧 agent 文件不受影响；无持久化格式变化（launch record 不含 thinking），回滚 = 整体 revert，无迁移。

## 6. 文件清单（预计）

改动：`src/core/agents/registry.ts`、`src/core/tools/task.ts`、`src/core/subagent.ts`、`src/runner.ts`、`README.md`、`docs/subagent-delegation-task-list.md`。
新增：`docs/subagent-thinking-design.md`（本文件）。
测试：`test/agents-registry.test.ts`、`test/subagent.test.ts`、`test/task-tool.test.ts`、`test/child-resume.test.ts`、`test/child-compaction.test.ts`（± `test/thinking.test.ts`、`test/deepseek.test.ts` 增补）。

## 7. 评审记录

- 评审轮 1：待启动。
