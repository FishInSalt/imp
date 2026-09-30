# 子代理思考策略：frontmatter 档位 + 继承父会话 + 显式化（SA-09 设计，draft）

状态：**已过独立对抗评审（3 轮，2026-09-30 CLOSED — CONFIRMED）**——实现已解锁。
日期：2026-09-30。分支：`feat/subagent-thinking`。前置：SA-02（子模型绑定，已合入）、#output-truncation D3b（子请求预算=目录值，已合入 `df4becb`）。

## 0. 目标与非目标

**目标**：子代理的思考档位成为显式策略——由且仅由两个来源决定：

1. `agent frontmatter` 的 `thinking:` 字段（按 agent 固定）；
2. 没写时**继承父会话当前档位**（spawn 时读取）。

并把解析结果**如实**写进子代理的每一个 LLM 请求（"显式化"），使实际行为由策略决定，而不由"未传参 × provider 家族回落"决定。

**非目标**（owner 决策，2026-09-30；各记触发条件见 D6）：settings 层（`subagents.defaultThinking` / `maxThinking` / `disableThinking` / `agentOverrides`）、per-run 覆盖（task 参数换档）、主会话请求的 off 形状改动、任何显示面改动。

## 1. 现状与证据

### 1.1 结构性事实（代码位点）

- 子代理链路没有档位：`SubagentOptions`（`src/core/subagent.ts:41-95`）无 `thinking` 字段；`launchLoop`（`:337`）的 `runAgentLoop` 调用（`:338`）不传 `thinking`；溢出重试的第二次 launch（`:433`）复用同一 options——修复点只有这一处 seam。
- 请求通路已就绪：`RunAgentLoopOptions.thinking`（`src/core/loop.ts:48-49`）被逐请求转发（`loop.ts:211`）；`LLMRequest.thinking`（`src/provider/types.ts:27`）。
- agent frontmatter（`src/core/agents/registry.ts:120-215`）字段：`name` / `description` / `tools` / `model` / `timeout` / `worktree`——无 `thinking`。校验先例：`timeout`、`worktree` 非法值 → 解析错误、文件跳过、warning（`:147-166`）；空白 `model:` 是显式配置错误、留给调度期拒绝（SA-02 C6，`:136-138`、`src/core/child-model.ts:75`）。
- task spawn：父模型/provider 在同步步进里钉住（SA-08 round 3 F-4，`src/core/tools/task.ts:711-718`）；fresh dispatch 在 `:853-880` 组装 `runSubagent`；resume 在 `:613-640`，其中 `resumeAgent` 从**当前**注册表重取（`:482`），`extraSystem`、`timeoutMs` 用当前文件值（`:598`、`:619`）——`model`/`role`/`cwd`/`worktree` 冻结，文件内容与 timeout 以当前为准。
- 主会话档位：`runner.thinkingLevel`（`src/runner.ts:1121`），启动时 clamp 到当前模型（`:501-509`）；主请求把 `off` 映射为 `undefined`（`:1472`，pi parity 形状）；task 工具接线在 `:548-551`（`getProvider`/`getModel`/`getModelReference` 同类 getter 先例）。
- clamp 与线格：`THINKING_LEVELS`（`src/provider/thinking.ts:23`）；`supportedThinkingLevels`（`:548`）、`clampThinkingLevel`（`:567`，不可用档位先向上、再向下取最近）；线格映射共四支：`openai-completions.ts:326-356`（glm-openai / deepseek / openai-effort）、`anthropic.ts:178-209`（budget / adaptive / glm-anthropic + 显式 disabled 的 else-if）、`codex-responses.ts:195-204`（openai-codex：显式 `reasoning.effort`；off 允许时写 map 的 off 值，`off:null` 不写字段）。
- 子代理自己的压缩摘要器**不**带档位：`subagent.ts:256`（`compactSession`）、`:274`（`compactHistory`）都不传 `thinking`；而两函数与 `runSummarizer` 均支持（`src/core/compaction.ts:403`、`:527`、`:604`；off→undefined 在 `:424`）。主会话的摘要器搭 session 档位（主压缩 `runner.ts:1604`、分支摘要 `:1020`：`thinking: this.level`）。

### 1.2 未传档位时的线上行为（子代理现状）

`thinking` 为 `undefined` 时，各家族的回落分支（已逐支核读）：

| 模型类别 | undefined 的线格结果 | 子代理实际行为 |
| --- | --- | --- |
| off 允许的已知模型（deepseek-flash、off 允许的 Claude ≥4.6 等） | 显式 disabled（`openai-completions.ts:342-349`；anthropic else-if `:205-209`） | 关思考 |
| `off:null` 且所属支对 off 有守卫（anthropic else-if、deepseek、codex 支：`off !== null`；openai-effort 支：`typeof off === "string"`；例：claude-fable-5、kimi-k2.7-code、gpt-5-pro 系列、codex `gpt-6-astra`） | 不写字段（codex 支见 `codex-responses.ts:201-204`） | 模型默认（通常照常推理） |
| `off:null`，**glm-openai 支（GLM 5.3）** | 该支**没有** `off !== null` 守卫（`openai-completions.ts:328-335`）→ 显式 disabled | 关思考（"显式 disabled 但模型实际关不掉"的既有形状；本批后的行为变化见 D2） |
| 未知模型（meta `null`） | 不写字段 | 模型默认 |
| `auto` 风格（`openai/deepseek-r`，`thinking.ts:241`） | 无支命中 → 不写字段 | 模型默认（本无旋钮） |

**更正**：本仓库 SA-09 backlog 原文称"anthropic-messages 省略字段 = 新 Claude 默认开"——不准确；对 off 允许的 Claude 模型，`undefined` 走显式 disabled（上表第 1 行）。真正落到"模型默认"的是上表第 2、4、5 行；第 3 行（GLM 5.3）是另一种形状：线格写 disabled，而该模型 off 实际不可用。

实测佐证：deepseek-flash 子会话 21 回合零 thinking 块（2026-09-30，child JSONL）——与该家族"显式关"一致。

### 1.3 前置条件（已满足）

`#output-truncation` D3b 已让子请求预算取目录值（deepseek-flash = 384000；该值来自 pi.dev 目录缓存 `~/.imp/models-catalog.json`，离线无缓存首跑回退 loop 的 8192 兜底），思考不再立刻撞旧的 8192 上限；截断可见性与截断工具调用拒绝对子代理同规则生效（`df4becb` 已合入）。

## 2. 决策记录

### D1 解析模型：frontmatter > 继承父会话（owner 已定，2026-09-30）

```
agent frontmatter thinking: <level>   → 用它
没写                                  → 父会话 spawn 时的当前档位
```

- 只有这两个来源；**无 settings 层**。论证：pi-subagents 的 `defaultThinking`/`agentOverrides`/`maxThinking` 服务于"随包发布、用户不可编辑的内建 agent"；imp 的 registry 从第一天起全归用户所有（registry 头注释 "No builtin agents"），每个 agent 文件都可直接改，全局默认层与天花板解决的"改不了文件"问题不存在，少一层也少一个"没写时用哪个"的歧义。
- 语义自洽：子代理是会话的延伸（父级 off → 子级 off；父级 max → 子级 max——**owner 已知情并接受**"没写 frontmatter 的 agent 全部继承 max"的成本后果）。
- 档位经 provider 的 clamp 落到子模型可表达的最近档位（见 D2 表；解析层不做 clamp，与主会话一致）。注意继承值是**父模型 clamp 之后**的档位：父级在某模型上被钳过的值会原样播给子代理，再在子模型上钳一次（如父级 `gpt-5-pro` 把 low 钳成 high，子代理继承到的是 high）。

### D2 显式化：解析结果如实进请求

- 解析出的档位**原样**传 `runAgentLoop({ thinking })` → 每个子请求 `thinking: <level>`（包含 `"off"`）；provider 现有的 `clampThinkingLevel` + 线格映射负责表达。**无 provider 改动**。
- `off` 的线格（本批后，子代理视角）：

| 模型类别 | 子=`off` 时 | 与现状差异 |
| --- | --- | --- |
| off 允许的已知模型 | 显式 disabled | 无（与今天回落一致） |
| `off:null`，deepseek / openai-effort / codex / anthropic-else-if 支 | clamp 到**最低可用档**并显式表达（claude-fable-5：off→minimal，adaptive effort "low"；kimi-k2.7-code：off→minimal→thinking enabled；`gpt-5-pro`：off→high；`gpt-5.2/5.4/5.5-pro`：off→medium；codex `gpt-6-astra`：off→low→effort "low"；openai `gpt-6`：off→minimal→effort "low"） | **有**：今天不写字段=模型默认；现在是最低档显式 |
| `off:null`，glm-openai 支（GLM 5.3） | clamp 上移 → low → enabled + effort "low" | **有**：今天是"显式 disabled 但模型实际关不掉"，现在是该模型真实的最低档 |
| 未知模型（meta `null`）与 `auto` 风格（无旋钮） | clamp 后仍无表达式 → 不写字段 | 无 |

- 非 off 档位（本批新能力）：**有旋钮的**家族显式启用（deepseek/GLM enabled(+effort)；Claude adaptive/budget；codex `reasoning.effort` 按档位）；`auto` 风格（无请求旋钮，`thinking.ts:241`）与无旋钮模型（meta `null`）无字段可写——档位在这些模型上天然惰性，如实记录，不假装"显式启用"。
- **范围边界**：主请求的 `off→undefined`（`runner.ts:1472`）本批不动。差异仅在 `off:null` 模型上可见（子=最低档显式、主=模型默认）；不在本批扩大行为变更面（D6）。
- 继承档位在子模型上不可用时的既有 clamp 语义（pi parity）——文档示例：父 `low` + 子 `gpt-5-pro`（只支持 high）→ 子 high；父 `max` + 子 GLM 5.2（binary/稀疏图）→ 按图向上取最近可表达档。这是 clamp 的既定行为，不是本批新语义。

### D3 读取时机：spawn 时钉住；resume 时重新解析

- `TaskToolOptions` 新增可选 `getThinkingLevel?: () => ThinkingLevel`；runner 接线 `() => this.thinkingLevel`（与 `getModelReference` 同"真 runner 总是接上"模式；缺席 → `undefined` → 旧行为，测试与自定义 wiring 不受影响）。
- fresh dispatch：父级读取放在 F-4 同步块内、`const provider = options.getProvider();`（`task.ts:718`）**之后**——不得插在既有两个读取之间（`task.ts:711-713` 的相邻性不变量），也不得放在 `:802-805`（那里在 `await resolveRepoState`/`await createChildWorktree` 之后，不构成钉住）。读取值 `agent?.thinking ?? getThinkingLevel?.()` 供 `:853` 组装使用；尝试内不漂移。
- resume：用 `resumeAgent?.thinking ?? getThinkingLevel?.()`——resume 分支的 `agent` 实参被 `checkResumeArgs` 拒绝（`src/core/child-resume.ts:35-41`，role 不可变），所以取 `resumeAgent`（`task.ts:482`，当前注册表重取）；读取与其同步、在租约获取等异步副作用之前。
- 先例对齐：`timeoutMs`/`extraSystem` 用当前文件；`model`/`role`/`cwd`/`worktree` 作为"尝试身份"冻结。thinking 是"本次生成的档位语义"，归入前者。
- 溢出重试的第二次 launch 复用同一解析值（attempt 内一致）。
- **已知缺口**：resume 重新解析出的档位变化在任何面上不可见（SA-03 记录、launch record、结果行都不含 thinking；`child-launch.ts` 的漂移校验只覆盖 `agent.system` 哈希，`:179`、`:752`）——归入 D6 显示面推迟项。

### D4 frontmatter 字段与校验

- 新增可选字段 `thinking: <level>`；合法集 = `THINKING_LEVELS`（`off, minimal, low, medium, high, xhigh, max`），trim 后按小写归一。
- 非法值或**空白** `thinking:` → 解析错误、文件跳过、warning 一行（解析期校验，同 `timeout`/`worktree` 先例）。空白要在解析期可见，必须**修订 `registry.ts:138`** 的填空题规则（`... || key === "model" || key === "thinking"`）——否则空白值被 fields 表静默丢弃、退化成"未出现"（评审轮 1 发现，见 §7）。
- 与 `model` 的 C6 关系**明示为不同**：`model` 空白是调度期字段级拒绝（`child-model.ts:75`，跨 provider 判定在调度层）；`thinking` 无解析器 seam、合法集是封闭枚举，故在解析期以**文件级跳过**校验。两者的共同点只是"显式配置错误必须响亮"。
- `AgentDefinition.thinking?: ThinkingLevel`；`registry.ts` 头注释与 README 的 agent 格式段同步更新。

### D5 子代理自己的压缩摘要器也随身档位

- `compactChildHistory` 的两处调用（`subagent.ts:256`、`:274`）直传 `thinking: options.thinking`。
- 论证：与主会话逐字同构——主压缩传 `this.level` 原值（`runner.ts:1604`）；非 off 档位如实搭乘，off 由 summarizer 请求层的既有约定映射为 undefined（`compaction.ts:424`）。
- **如实记录两处局限**（评审轮 1 发现，见 §7）：(a) 子=`off` 且 `off:null` 子模型时，正文请求（D2：lift 到最低档显式）与摘要器请求（off→undefined→无字段/模型默认）线格不一致——主会话同形状，属 compaction 层既有约定，本批不改；(b) 同组合下摘要器 token 超限无法降档重试（`summarizeWithRetry` 把 `off` 当 rank 0，`compaction.ts:496-500` 直接拒绝），失败被 `compactChildHistory` 的 catch 记入 3 连败禁用——与今天 off 形状下的行为一致，非本批引入。
- 测试须同时钉住 off 与非 off 两输入（见 §4）。备选（评审可再推翻）：保守不动、记触发条件。

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
2. `src/core/tools/task.ts`：`TaskToolOptions.getThinkingLevel?`；fresh 在 `:718` 之后即时读取（F-4 块内），供 `:853` 使用；resume 在 `:482` 的 `resumeAgent` 旁读取 `resumeAgent?.thinking ?? getThinkingLevel?.()`，供 `:613` 使用。
3. `src/core/subagent.ts`：`SubagentOptions.thinking?: ThinkingLevel`；`launchLoop` 传入 `runAgentLoop`（存在才传，模式同 `maxTokens`）；压缩两处直传（D5）。
4. `src/runner.ts`：`createTaskTool({ ..., getThinkingLevel: () => this.thinkingLevel })`（`:+548-551` 区）。
5. `README.md`（agent 格式段）与 `docs/subagent-delegation-task-list.md`（SA-09 条目：改为已定契约 + anthropic 事实更正）。
6. 无 provider 改动（D2 已核验 raw `off` 与各档位被现有分支正确表达）。

## 4. 测试计划

| 验收项 | 文件 | 断言 |
| --- | --- | --- |
| frontmatter 胜出 / 继承父级 / getter 缺席→undefined | `test/task-tool.test.ts` | 三种输入下子运行收到的 `thinking`（fake provider sink） |
| spawn 钉住（await 交错不漂移） | `test/child-resume.test.ts`（F4-a 同址：worktree+swap 装置在此；原计划 task-tool 落点调整） | 自定义 `getThinkingLevel` 在 worktree 创建 await 期间变更返回值，尝试仍用 spawn 时值 |
| 每轮请求带档位；溢出重试第二轮同值；未提供→回归 | `test/subagent.test.ts` | sink 捕 `LLMRequest.thinking`（三态 + 溢出重试；catalog `maxTokens` 组合由既有 D3b 用例覆盖） |
| resume 用当前文件 + 当前父级（两变量各测） | `test/child-resume.test.ts` | 同 sink 断言 |
| 摘要器档位（`off` 与非 off；session 与无 session 两分支） | `test/child-compaction.test.ts` | 摘要器请求的 `thinking`（off 映射为 undefined，D5 局限 (a)） |
| raw `off` 在 off:null 上的 lift | `test/anthropic-thinking.test.ts`（新增 fable-5→adaptive effort "low"）、`test/moonshotai.test.ts`（kimi-k2.7-code→enabled，`:283-285` 已有）、`test/openai-completions.test.ts`（新增：`gpt-5-pro`→effort "high"；`gpt-5.2-pro`→effort "medium"——两 id 各钉）、`test/codex-responses.test.ts`（gpt-6-astra→effort "low"，`:354-357` 已有） | 线格 body |
| GLM 5.3：off→low enabled；undefined→disabled（定格既有形状） | `test/zai.test.ts`（`:105-106` 已有 off→low；已补 undefined→disabled 定格） | 线格 body |
| 非法/空白 frontmatter → 解析期跳过 + 警告；大小写归一 | `test/agents-registry.test.ts` | `parseAgentFile` 返回值 / `loadAgentDefinitions.warnings` |
| 回归：全量套件 | — | 基线以开工时 main 为准（不复用旧测试数） |

## 5. 风险与回滚

- **成本/延迟**：继承=max 语义使未写 frontmatter 的 agent 全部按 max 思考（owner 已知情）。缓解：README 写明降档方法（frontmatter）。
- **off:null 行为变化**：子=`off` 从"模型默认"（deepseek/openai-effort/codex/anthropic-else-if 支）或"显式 disabled 但实际关不掉"（GLM 5.3）变为"最低档显式"——有意为之，文档化。
- **clamp 上移意外**：继承档位在子模型稀疏图上可能上移（low→high）。文档表现表说明，非本批语义。
- **兼容**：新字段可选，旧 agent 文件不受影响；无持久化格式变化（launch record 不含 thinking），回滚 = 整体 revert，无迁移。

## 6. 文件清单（预计）

改动：`src/core/agents/registry.ts`、`src/core/tools/task.ts`、`src/core/subagent.ts`、`src/runner.ts`、`README.md`、`docs/subagent-delegation-task-list.md`。
新增：`docs/subagent-thinking-design.md`（本文件）。
测试：`test/agents-registry.test.ts`、`test/subagent.test.ts`、`test/task-tool.test.ts`、`test/child-resume.test.ts`、`test/child-compaction.test.ts`，线格增补 `test/anthropic-thinking.test.ts`、`test/moonshotai.test.ts`、`test/openai-completions.test.ts`、`test/codex-responses.test.ts`、`test/zai.test.ts`（± `test/thinking.test.ts`、`test/deepseek.test.ts`）。

## 7. 评审记录

- 评审轮 1（2026-09-30，独立全新上下文）：11 项发现，全部折入本稿。7 项 P2——GLM 5.3（`off:null` 而 glm-openai 支无守卫）归类错误且行为变化未记；openai-codex 家族未进表；D4 空白值在 `registry.ts:138` 下不可实现且与 C6 表述自相矛盾；D3 fresh 位置自相矛盾（`task.ts:802-805` 在 await 之后，不构成钉住）；resume 公式误用 `agent?.thinking`（resume 分支该实参必被拒绝）；D5 在 `off:null` 上的论证不实、不可降档形状未记；测试计划未逐条钉住 5 项验收。4 项 P3——`auto`/无旋钮表述过度；6 处行号引用修正；resume 档位变化无披露面；384000 目录来源未注明。评审对 GLM 5.3 与 codex 的事实主张经本人复核属实（codex 条目在目录缓存 `openai-codex/gpt-6-astra` 等）。待评审轮 2。
- 评审轮 2（2026-09-30，独立全新上下文）：复核轮 1 的 11 项折叠**全部通过**；新发现 1 项 P2（`gpt-5.2/5.4/5.5-pro` 的 off 落点是 medium 非 high——代码复核属实，已改 D2 表与 §4 两处）、3 项 P3（openai-effort 的 off 守卫是 `typeof off === "string"`；§1.2 行 1 的 "Claude ≥4.6" 需排除 fable-5；kimi 的 lift 用例 `moonshotai.test.ts:283-285` 已存在——已标注）与 2 项备注（继承值=父级钳后值，已补 D1；`gpt-6` 示例已补 D2）。轮 2 结论：**CONFIRMED（含 finding 1 待折）**；上列全部已折入，待轮 3 快验关闭。
- 评审轮 3（2026-09-30，轮 2 评审员快验）：三处 `gpt-5.x-pro` 更正与 `thinking.ts:263-291` 一致；P3 清扫（守卫措辞/fable-5 排除/已有用例标注）与 D1/D2 补充均准确 → **CLOSED — CONFIRMED**。残留 P3 两条不改：§1.2 行 1 未内联标注 fable-5 排除（行 2 已含）；§1.2 行 2 例表保留 "gpt-5-pro 系列" 简写（无害）。
- 实现评审轮 1（2026-09-30，独立全新上下文）：**NEEDS FIXES**——1 P2（§4 所列 GLM 5.3 的 undefined 线格 pin 未实现）+ 3 P3（D5 的 session 分支无覆盖；spawn 钉住测试落在 `child-resume.test.ts` 而计划写 task-tool；§4 subagent 行措辞过强）。全部折入（`zai.test.ts` undefined pin、`child-compaction.test.ts` session 分支用例、§4 两处措辞修正）。待实现评审轮 2。
- 实现评审轮 2（2026-09-30，轮 1 评审员校验）：三项折叠全部核实（zai 的 undefined pin 与 `openai-completions.ts:331-335` 一致；session 分支 D5 用例非空洞；§4 措辞与代码对齐；折叠提交未引入 `src/` 变动）→ **APPROVE**。残留 P3（不改，记录）：session 分支只覆盖非 off 档位，off→undefined 映射在无 session 分支已钉住（D5 局限 (a)）。实现评审关闭。
