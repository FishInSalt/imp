# 压缩抗"思考挤占正文预算"：降档重试 + reserve 提升（#compaction-thinking-retry）

状态：已审批（2026-09-27，两轮独立评审：第一轮超时前完成大部分核验；第二轮收窄复核
判"先修后实施"，4 项必改已全部落入本文）
分支：`fix/compaction-thinking-retry`（独立 worktree `imp-wt-compaction`；与在途的
`fix/bash-process-group` 零文件重叠，可独立合入）
参考：实测日志 `~/.imp/logs/*.jsonl`（三次失败 + 八次成功，见 §1）；pi 对照：
`packages/coding-agent/src/core/compaction/compaction.ts` 的 `getSummarizationFailure`
（pi 对 length 停同样拒绝，且**无重试**——本设计是有意偏离）

## 0. 目标

- 消除"思考吃光输出预算 → 摘要正文写不出/被截断 → 被拒绝 → /compact 失败"这一类故障；
- **不改预算公式**（`min(0.8 × reserveTokens, modelMaxTokens)` 原样保留）、不加窗口钳制、
  不加预算升额、不加分块摘要；
- 正常路径行为零变化（第一次调用成功即返回，仍按会话档位思考）；
- 验收：§1 的三类失败场景在实现后能成功压缩；全量门禁绿。

## 1. 证据（本机实测，2026-09-23 ~ 09-27）

三次失败——**都是思考占满输出上限、正文 0 字或被截断**：

| 时间 | 模型 | 上限 | thinking 字符 | 正文字符 | 结果 |
|---|---|---|---|---|---|
| 09-23 | glm-5.3 | 2,048 | 8,570 | 0 | max_tokens → 拒绝 |
| 09-26 | kimi-k3 | 8,192 | 17,149 | 14,575（截断） | max_tokens → 拒绝 |
| 09-27 | deepseek-flash | 13,107 | 39,373 | 0 | max_tokens → 拒绝 |

八次成功的摘要（同会话/同模型）：**正文输出只有 912–7,742 tokens**，全部低于各自上限；
思考量则波动极大（同模型 2.7k–39k 字符）。结论：**思考是唯一的破坏变量，正文的真实
需求远小于上限**——把思考从这次调用里移开，摘要就一定装得下。

## 2. 决策记录

### D1 降档重试（一次）

- **触发**：摘要调用返回 `stopReason === "max_tokens"`（现在该条件直接 throw，
  `compaction.ts:526`；分支摘要同，`:406`）。
- **降档目标**：`clampThinkingLevel(thinkingMetaFor(provider.name, model), "off")` ——
  复用现成语义："off 可用 → off；off 被标为不支持（`levelMap.off === null`，
  如 `thinking.ts:159/:223/:238` 的模型）→ 就近取最低可用档（minimal/low）"。
  不硬写 `off`（对强制推理的模型毫无意义）。
- **未知模型的语义**（`thinkingMetaFor` 返回 null，含测试 mock）：clamp 恒得 `"off"` →
  经 `!== "off"` 映射后请求里**不带任何 thinking 字段**——对 provider 是"不干预"
  （模型默认行为；GLM/deepseek 族默认开思考），不是"关"。如实记录：
  ① 已知 meta 的模型，阶梯真实生效（`off:null` → 降到最低可用档，如 minimal/low）；
  ② `meta === null` 时重试只改变请求意图，线路上是"不发 thinking 字段"，效果取决于
  模型默认值——文档不假装能关（测试 mock 即此类，可用请求里的 thinking 字段断言
  重试发生）；
  ③ 强制推理类（`off:null` 且无 effort 可降）可能两跳都失败——由 D3 触发条件兜底。
- **仅当降档后的有效档严格低于第一次尝试时才重试**（按 `THINKING_LEVELS` 索引比较）。
  会话本身就是 `off`/未启用思考（`args.thinking` 为 undefined）时**不重试**，直接按现行
  语义拒绝——重试不会改变任何输入。
- **一次，不递归**：沿用同一 cap、同一 transcript、同一 signal；`args.signal.aborted`
  时不重试（保持"aborted → rejected"的现行顺序语义）。
- **usage 两跳累加**：账要如实记（`CompactionResult.usage` 是真实成本）。
- **两跳都 max_tokens** → 抛错；文案保留现有关键子串
  `"summary hit the token cap — incomplete, rejected"`，追加诊断：
  `(attempt 1: thinking=<level>, cap=<n>; retry: thinking=<level>)`。
- **分支摘要同规则**：`summarizeBranchSegment` 的 cap 只有一半（现在 6,553），
  同一受害路径，必须一起修。
- 与 pi 的有意偏离已记（pi 直接拒绝）；理由是三次实测失败全部由思考挤占引起，
  且降档对正常路径零成本。

### D2 reserveTokens 16,384 → 32,768

- 摘要上限 `0.8 × reserve`：**13,107 → 26,214**（实测最坏组合 ≈ 13k 思考 + 6k 正文
  = 19k < 26,214）；分支摘要 6,553 → 13,107。
- 自动压缩触发点 `min(0.85×窗口, 窗口−reserve)` 的影响：

| 窗口 | 现在(16,384) | 改后(32,768) | 变化 |
|---|---|---|---|
| 1M | 850,000 | 850,000 | 无 |
| 200k | 170,000 | 167,232 | 早 1.6% |
| 131k（已知/回退） | 111,411 / 114,688 | 98,304 | 早 12–14% |
| ≤32k | 16,384 | 27,852 | 改走比例分支 |

- **不需要窗口钳制的证明（限定范围）**：在 `source === "fallback"` 与
  `contextWindow > reserve` 的 `min(...)` 两条分支上 `触发 ≤ 窗口 − reserve`，
  且 `cap = 0.8×reserve < reserve` ⇒ `输入 + cap < 窗口`。
  **比例分支（窗口 ≤ reserve，即 ≤32k 窗口）不在该证明范围内**——连同"手动在接近
  满窗口时 /compact"，一并归入 D3 已知边界，不修。

### D3 明确不做（各记触发条件）

- 不改公式形态（不引入 `max()`、costCeil、room、sanitize）；
- 不升额、不分块、不加结构校验（模板小节/标识符计数）、不做"思考占比守卫"；
- 已知边界不修：手动满窗 /compact、≤55k 窗口模型 —— **触发条件**：日志里出现
  "输入+cap 超窗"的 API 报错（而非 token cap）时，回来加 room 钳制。
- 降档重试后仍失败的场景（未观测到）——**触发条件**：日志出现第二跳 max_tokens。

## 3. 实现

- `src/core/compaction.ts`：
  - `DEFAULT_COMPACTION_SETTINGS.reserveTokens`（:46）`16384 → 32768`，注释更新
    （记依据：三次实测失败 + 26,214 覆盖最坏组合 + 触发点影响表）；
  - 抽取 `runSummarizer(args)`：把现在两处各自的 `for await (provider.stream(...))`
    循环（`compactHistory` :503-516 与 `summarizeBranchSegment` :392-406）参数化为
    `{provider, model, system, userContent, maxTokens, thinking, signal}`，
    返回 `{summary, finalText, usage, stopReason}`（校验逻辑不变：text_delta 累加、
    finalText 兜底、空摘要拒绝）；
  - 新增 `runSummarizerWithRetry(args)`：attempt 1（原档位）→ **先判 abort**：已中止则
    抛现行 `"summarizer aborted — incomplete, rejected"`（`compaction.ts:531-532`）
    且不重试；未中止且 max_tokens 且可降档 → attempt 2（降档、同 cap；若 signal 已中止
    同样抛 aborted 文案）→ 返回后跳结果/抛错（D1 文案）。分支摘要（`:405/:409`）按同一
    顺序调整。注意这会**调整现行 max_tokens / aborted 两条检查的相对顺序**（`:526` 在
    `:532` 之前 → 改为 abort 优先）——对既有测试无影响（中止流不产生 message_end，
    stopReason 为 undefined，两条检查不会同时命中）。
  - 两处调用点改走包装；分支摘要的 `thinking` 来源（runner 传 `this.level`）不变。
- 不改：provider 层、runner、settings schema、CLI、配置面。

## 4. 测试计划

- **更新**：
  - `test/compaction-wiring.test.ts:96`：`triggerTokens 83616 → 67232`（100k 窗口、
    新 reserve 下的正确值）；
  - `test/compaction.test.ts:46-47`：补钉子 `DEFAULT_COMPACTION_SETTINGS.reserveTokens === 32768`。
- **新增**（`test/compaction.test.ts`，scriptedProvider 会重复最后一个脚本，
  现有两个 "token cap" 用例天然变成"两跳都失败"路径，断言补"调用次数=2"）：
  1. 第一次 max_tokens、第二次成功：断言两次调用、第二次请求的 thinking 参数
     = 降档结果（mock provider → meta null → off → 请求里为 undefined）、
     采用第二次的文本、usage 累加；
  2. 会话档位已经是 off（`args.thinking` undefined）时命中 max_tokens →
     **只调用一次**并抛错（不重试）；
  3. 两跳都 max_tokens → 抛 `"token cap"` 且带诊断后缀。
- **手动**：worktree 内 `npm ci` 后跑 `npx vitest run test/compaction*`，再跑全量门禁
  （typecheck / lint / test）。

## 5. 风险

- 罕见失败路径多一次摘要调用（成本/时延），正常路径零变化；
- 降档重试仍失败时保持现行拒绝语义（会话不动，绝不落盘半截检查点）；
- reserve 提升对 131k–200k 窗口模型触发更早（压缩更频繁，成本略增），对 1M 模型无影响；
- 与 pi 的有意偏离（多一次降档重试）记档，避免未来"对齐 pi"时误删。

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `src/core/compaction.ts` | reserve 常量 +1；抽取/包装函数 ~60 行 |
| `test/compaction.test.ts` | +3 用例、+1 钉子、2 处断言补强 |
| `test/compaction-wiring.test.ts` | 1 行（触发点期望值） |
| `docs/compaction-ratio-threshold.md` | 第 21 行 "reserveTokens remains unchanged" 等措辞改为随默认值走（指向本文）；第 9/12 行"16,384-token reserve"字样同步 |
| `docs/compaction-thinking-retry-design.md` | 本文（新增） |
