# 搭头批设计：子代理 overflow 恢复 + Anthropic 家族模型发现翻页

状态：独立审查已闭环（needs-fixes 2 P1 + 4 P2 + 5 P3 全部落入，见 §6.5）；待用户批准实现

## 0. 背景

M5 账本遗留两项对齐缺口，M18 优先级普查确认仍在：

1. **子代理上下文溢出无恢复**：主循环有 `runTurnOrRecoverFromOverflow`（runner.ts:735，#overflow-grace：活的溢出错误→压缩一次→重试一次→二次失败给指引），子代理的 catch 一律 `status:"crash"`（subagent.ts:306）。
2. **Anthropic 家族模型发现不翻页**：发现层解析 `{data:[...]}` 后丢弃 wrapper 字段；z.ai 的 Anthropic 兼容端点返回 camelCase 翻页元数据（实测见 §2），`hasMore=true` 那天会静默截断列表。

## 1. 范围

| 项 | 内容 | 不做 |
|---|---|---|
| A | 子代理单次 overflow compact-retry | 不改主循环恢复；不加 Case-2 式"成功响应超窗"检测 |
| B | anthropic 分支游标翻页 + camelCase 形状钉 | 不动 zai coding 端点（无翻页字段）；不做 openai 分支翻页 |

## 2. 现状与实测（2026-02-07）

### A. 子代理

- `runSubagent`（subagent.ts:148）已具备：轮间阈值压缩 `onBeforeTurn`（M6 镜像主循环）、summarizer 三连败熔断 `compactionDisabled`、`summarizedTurns/Usage` 补账、双模式压缩 `compactChildHistory`（有 session 走 `compactSession` 重建，无 session 走 `compactHistory` 纯计算+原地 splice）。
- 缺的只有：`runAgentLoop` 抛出的活溢出错误（`isContextOverflowError`，compaction.ts:155）直接落 crash。轮间压缩防不到它——单轮请求超窗（如巨型工具结果）在 onBeforeTurn 之后才炸。
- **pi 对照**（packages/coding-agent/src/core/agent-session.ts:2157-2216 `_checkCompaction`）：Case 1 = 溢出且未完成 → 移除失败 assistant 消息、压缩、`agent.continue()` 重试**一次**，`_overflowRecoveryAttempted` 守卫防循环。pi 无『子代理』概念——其 print 模式（modes/print-mode.ts）驱动完整 AgentSession，即子进程享受与主会话同款 `_checkCompaction` 全量恢复，这就是『子代理对齐』的实质。**结构性差异（实现者须知）**：pi 事后检查的是已落库的失败 assistant 消息所以需要『移除』步骤；imp 的 streamAssistant 只在 message_end 才入 history（loop.ts:245），抛错时无悬挂内容，恢复**不需要任何移除步骤**。
- **主循环差异**：imp 主循环恢复不受 `IMP_AUTOCOMPACT=0` 门（恢复≠轮间阈值压缩，runner.ts:751 直接调 compactAndSplice）；且 `compactAndSplice` 无 session 时返回 false——主循环恢复实际仅会话模式可用。子代理的 `compactChildHistory` 双模式都活，恢复复用它（不反向去改主循环）。

### B. 模型发现翻页

- 现状：`fetchOnce`（discover.ts:182）接受裸数组/`{data}`/`{models}`/pi.dev 记录四种形状，wrapper 字段全丢。
- 实测（Bearer Z_AI_API_KEY，2026-02-07）：
  - `api.z.ai/api/coding/paas/v4/models`（imp 的 zai 分支端点）：`{object, data}`，**无任何翻页字段**。
  - `api.z.ai/api/anthropic/v1/models`（用户主链路：anthropic 分支 + `ANTHROPIC_BASE_URL` 指向 z.ai）：`{data:[11], firstId, hasMore:false, lastId}` camelCase；`limit=2` 被忽略（仍 11 条）；`lastId=glm-5.3-flash` 被忽略（仍 11 条首条相同）；`after_id` 一次请求超时（不结论，可能是未知参数挂起或网络抖动）。
  - 真 Anthropic API 规范：响应 `{data, has_more, first_id, last_id}` snake_case，请求 `after_id` + `limit`。
- 结论：今天无 bug（hasMore=false），全部是预防性加固 + 形状钉。

## 3. A：子代理 overflow 恢复设计

**改动点 1 —— `compactChildHistory` 返回 `{ compacted: boolean; error?: string }`**（是否真的压缩了 + 失败原因）。现状返回 void；恢复路径需要两个信号：没压动就别重试（对齐主循环），压失败的原因要进 `overflowGuidance` 的 cause 槽（对齐主循环 compact-throw 分支：runner.ts:760-763 传 compactCause 而非谎称 nothing-to-compact）。返回路径三条：成功 → `{compacted:true}`；try 尾 `compacted===null`（keepRecent 吞掉一切、`cut<=0`）→ `{compacted:false}`；内部 catch（summarizer 失败/abort）→ `{compacted:false, error}`。**注意（审查 P2-1 核实）**：`shouldCompact` 阈值门只在 onBeforeTurn 包装层（subagent.ts:178），`compactChildHistory` 本体无门——恢复直调**不可能**因『估算偏低』被拒（压缩后估算偏高的已记档偏差也不会拒），唯一无病拒绝是 `cut<=0`。onBeforeTurn 调用点忽略新返回值，行为不变。

**改动点 2 —— runAgentLoop 调用包一层恢复**（subagent.ts:276 附近）：

```
let result = await runAgentLoop({ ..., userMessage: options.prompt, ... })
  catch err:
    if (!isContextOverflowError(err)) → 现行 crash 路径（不动）
    if (compactionDisabled) → crash，reason = overflowGuidance(... "compaction disabled after repeated failures")
    { compacted, error } = await compactChildHistory(history)   // 复用：补账、熔断计数都走原缝
    if (!compacted):
      if (child.signal.aborted) → 现行 aborted/timeout 判定返回（timedOut = 时钟 fired 且父未 abort）  // 审查 P1-1：压缩窗口内的 abort 被内部 catch 吞掉只落 false，必须在恢复缝重新识别，不得误报 crash
      → crash，reason = overflowGuidance(..., error ?? "nothing safe to compact")   // 有 error 传真实原因（P2-1）
    result = await runAgentLoop({ ..., userMessage: undefined, ... })  // 失败尝试已把 user 消息留在 history（loop.ts:112 只在非空时追加），重试不重复注入——主循环同款（runner.ts:772）
  catch retryErr:
    if (!isContextOverflowError(retryErr)) → 现行 crash 路径（原始 message）  // 审查 P1-2：对齐 runner.ts:775，非溢出错误（401/500/网络）不得谎称溢出
    → crash，reason = overflowGuidance(... "still over the window after one compaction")  // 单次守卫，对齐 pi _overflowRecoveryAttempted 与主循环
```

细节决策：

- **D1 单次恢复**：对齐主循环与 pi。二次失败 reason 用 `overflowGuidance`（compaction.ts 既有函数）而非裸 provider 400。**受众差异记档（审查 P3-2）**：guidance 文案面向 REPL 用户（提到 /model、/compact、/new），而子代理的 reason 落进父模型的工具结果——父模型跑不了这些命令。保留同一函数不做分支：工具结果的最终读者是人，指引仍然成立。
- **D2 abort 语义（审查 P1-1 修订）**：压缩与重试都在 `child.signal` 作用域内。两个窗口分论：**重试窗口**——runAgentLoop 对 abort 返回 `stopReason:"aborted"`，走现行 aborted/timeout 分支，无需处理；**压缩窗口**——compactChildHistory 把 abort 引发的 summarizer 失败吞进内部 catch（只落 `{compacted:false, error}` 且计入熔断），恢复缝必须在判定 crash 前检查 `child.signal.aborted`：时钟 fired 且父未 abort → timeout；否则 aborted。二者都不产生额外状态，但缺少该检查会把超时误报为 crash『nothing safe to compact』。
- **D3 计账与预算（审查 P2-3 补）**：重试成功后 `turns/usage` 不用第二次 runAgentLoop 的返回值（它只数第二轮迭代），改用 crash 路径同款 `historyStats(history) + summarized 累计`——两轮的真实成本都在 history 里。**预算重置**：重试是新的 runAgentLoop 调用，`maxIterations`（CHILD_MAX_TURNS）从头再计——最坏 2×40 轮。与主循环同形（每次 runTurnInner 独立 maxTurns，runner.ts:815）；这是恢复的固有代价而非漏洞，随本批修订 subagent.ts:158 的『compaction does NOT reset the turn budget』注释（轮间压缩仍不重置；溢出恢复会重置——两回事分说）。
- **D4 不碰 task 工具/状态机**：恢复成功 → 正常 status；失败 → 现行 crash 渲染。无新状态、无接口变化。

## 4. B：Anthropic 分支翻页设计

**改动点 1 —— 拆出 `fetchPage(url, headers): Promise<{ ids, hasMore, lastId } | null | "retry">`**（审查 P2-4：现 fetchOnce 签名 `string[] | null | "retry"` 容不下翻页字段，必须命名新缝）：共享现 fetchOnce 的 controller/超时/429 重试/四形状解析核心；wrapper 字段双命名接受（camelCase `hasMore/lastId` + snake_case `has_more/last_id`，z.ai 与真 Anthropic 各取其一）。`fetchOnce` 变成 `fetchPage` 的薄包装（丢弃 hasMore/lastId），zai/openai/codex 三分支签名与行为完全不变。

**改动点 2 —— anthropic 分支改用 `fetchAnthropicModelsPaged(baseUrl, headers)`**：

```
ids = []; seen = Set
url = {base}/v1/models?limit=1000
循环最多 10 页（页上限常数，同 MCP TOOLS_LIST_PAGE_CAP 精神）：
  page = fetchPage(url, headers)              // 复用：429 重试、超时、形状回退；不传 cacheKey（见下）
  newIds = page.ids 去重（seen）后追加
  若 newIds 为空 → 停（服务端忽略 after_id 时返回同页，幂等终止——实测 z.ai 忽略游标参数，这是主保险）
  若 !page.hasMore 或 page.lastId 为空 → 停（正常终点）
  url = {base}/v1/models?limit=1000&after_id={encodeURIComponent(lastId)}   // 审查 P3-3
缓存语义（审查 P2-2）：逐页调用一律不带 cacheKey（fetchPage 的落缓存仅发生在无翻页路径的包装里）；循环结束后一次 `cache.set(key, 合并去重列表, now())`；中途任一页 null → 整体返回 null（今天的回退语义：静态种子兜底），不缓存半截列表
```

- **D5 参数用 Anthropic 规范 `after_id`**：z.ai 是否支持未证实（一次超时不结论）；"无新 id 即停"使服务端忽略参数时行为退化为今天的单页——不会错、不会循环。
- **D6 只挂 anthropic 分支**：zai coding 端点无翻页字段（实测）、openai 分支无该形状。触发条件记档：任一端点开始返回 hasMore=true 即扩。
- 页上限触顶静默停（列表发现是尽力而为语义，与 MCP 工具列表不同——不记 note，/model 面板本就是"发现到什么列什么"）。

## 5. 测试计划

- A（subagent.test.ts 扩展，沿用注入 provider）：
  1. 溢出→压缩→重试成功：首轮注入抛 `context window exceeded`（isContextOverflowError 认的形状，compaction.test.ts:276-303 矩阵同款），压缩 provider 记录到调用，二轮正常脚本 → status 正常、history 无重复 user 消息、turns 计账含两轮。
  2. 二次溢出 → crash，reason 含 overflowGuidance 文案；**summarizer 调用数恰为 1**（审查 P3-5：重试首轮边界可能再入 onBeforeTurn 触发一次无 LLM 的 cut<=0 尝试——钉子数 summarizer 真调用，不数压缩函数进入次数）。
  3. 压缩熔断（三连败后）触发溢出 → 直接 crash 不调 summarizer。
  4. `compactChildHistory` 无病拒绝（keepRecent 吞掉一切、`cut<=0`，如历史只有 1 条 assistant）→ crash reason 含 "nothing safe to compact"。
  5. 恢复压缩窗口内时钟超时（summarizer 挂起至超时）→ status="timeout" 而非 crash（审查 P1-1 钉子）；父 abort 同理 → aborted。
  6. 恢复压缩时 summarizer 抛 401 → crash，reason 携带 401 原因（不是 nothing-to-compact），熔断计数 +1（审查 P2-1 钉子）。
- B（model-discovery.test.ts 扩展，沿用该文件现有的本地 `node:http` 服务器 + `hits[]` URL 断言模式——审查 P3-1 更正：不是 globalThis.fetch stub）：
  1. camelCase wrapper + hasMore:false（今天的 z.ai 实测形状）→ 单页 11 条，不二次请求。**形状钉**。
  2. hasMore:true → 带 after_id 二次请求、合并去重。
  3. 服务端忽略 after_id（两页同内容）→ 停在第二页，列表无重复。
  4. 页上限：恒 hasMore:true → 10 页停。
  5. snake_case has_more/last_id（真 Anthropic）同样翻页。
  6. zai coding 端点形状（{object,data}）单页不翻。

## 6. 规模

| 文件 | 变更 | 估行 |
|---|---|---|
| src/core/subagent.ts | compactChildHistory 返回值 + 恢复包装 | ~60 |
| src/provider/discover.ts | parseListing 拆分 + paged 循环 | ~70 |
| test/subagent.test.ts | +5 例 | ~120 |
| test/model-discovery.test.ts | +6 例 | ~130 |

## 6.5 独立审查记录（2026-02-07，审查通过前的修订）

reviewer 判 **needs-fixes**（2 P1 + 4 P2 + 5 P3），逐条亲自核实后全部落入上文：

- **P1-1**（已修，D2 + 伪码 + A5）：压缩窗口内的 abort/超时被 compactChildHistory 内部 catch 吞成 `{compacted:false}`——恢复缝必须重查 `child.signal.aborted` 分流 timeout/aborted，否则超时误报 crash『nothing safe to compact』。
- **P1-2**（已修，伪码 catch retryErr 分支）：非溢出的重试错误必须走现行 crash 带原始 message（对齐 runner.ts:775），不得一律 overflowGuidance 谎称溢出。
- **P2-1**（已修，改动点 1）：boolean 返回值合并了『summarizer 失败』与『无可压缩』——改 `{compacted, error?}`，error 进 guidance cause 槽；明确 shouldCompact 门只在 onBeforeTurn、恢复直调不可能被低估算拒绝（审查问答 Q3 结论：设计前提成立）；A4/A6 按真实触发改写。
- **P2-2**（已修，§4 缓存语义）：逐页不带 cacheKey（fetchOnce 现状每页成功即落缓存，会缓存半截）；合并后一次落盘；中途失败整体 null。
- **P2-3**（已修，D3）：重试重置 maxIterations（最坏 2×CHILD_MAX_TURNS）——与主循环同形，记为决策并修订 subagent.ts:158 注释。
- **P2-4**（已修，改动点 1）：fetchOnce 签名容不下翻页字段——命名 `fetchPage` 新缝，fetchOnce 变薄包装。
- **P3×5**（已修）：§2 pi 措辞（pi 无子代理概念；结构性差异=imp 无需移除步骤）；D1 受众差异记档；encodeURIComponent；§5-B 测试模式更正（本地 http 服务器）；A2 钉 summarizer 真调用数。

审查同时核实通过的关键前提：loop 对活 provider 错误直接抛出（恢复前提成立）、失败尝试后 history 重试良构（无悬挂 tool_use、user 消息恰一条）、翻页停止条件在任意字段组合下终止、范围未越 §1。

## 7. 风险与开放问题

- **R1 after_id 挂起**：实测一次超时。若 z.ai 对未知参数挂起，翻页日 hasMore=true 时每页多付一次超时（REQUEST_TIMEOUT_MS 现值）——可接受（发现路径已有缓存与回退）；不做参数探测。
- **R2 子代理恢复与轮间压缩的预算**：恢复的压缩调用走三连败计数——恢复失败（含压缩窗口内的 abort，见 D2）会消耗熔断额度（合理：同一台 summarizer）。记档。
- **R3 无 session 主循环恢复缺口**（compactAndSplice 无 session 返 false）：本批不修（子代理两模式都活，不比主循环差）；记触发条件=用户关 session 报溢出时补。
