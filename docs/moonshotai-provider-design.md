# Moonshot / Kimi 官方 API 接入（#moonshotai-provider）

状态：rev2（独立对抗评审后修订：1×P1 + 7×P2 + 4×P3 已折入；rev1 见 git 历史）
分支：feature/moonshotai-provider
参照系：pi @ /Users/z/Z/Agent_demo/pi（每条 parity 声明锚定源码行）；官方文档 platform.kimi.ai/docs/guide/use-thinking-models（thinking 矩阵）与 Kimi Code FAQ 平台对照表（www.kimi.com/code/docs/en/kimi-code/faq.html，base URL 表）；pi.dev 线上目录实测（两家均 HTTP 200，2026-09-26）
日期：2026-09-26

---

## §1 目标与非目标

**目标**：`moonshotai/<id>`（api.moonshot.ai/v1）与 `moonshotai-cn/<id>`
（api.moonshot.cn/v1）两个家族走 Moonshot 官方 OpenAI 兼容端点，
`MOONSHOT_API_KEY` 或 `/login` 存储 key（存储优先，pi 顺序）；包含
thinking 旋钮（k3 / k2.7-code / k2.6 三分叉）、reasoning_content 回放、
usage 兜底、模型发现、目录、`/login`、`/model` picker 全链路——
zai/deepseek 家族是模板（src/provider/zai.ts、deepseek.ts）。

用户已确认（2026-09-26）：两家都做；key 走 `/login` 存储；用户充值平台
platform.kimi.com = 开放平台**国内站**（人民币按量付费）→ 日常主用
`moonshotai-cn`。官方平台对照表：Open Platform China =
`https://api.moonshot.cn/v1`，Overseas = `https://api.moonshot.ai/v1`。

**非目标**：
- `kimi-coding`（Kimi Code 订阅制 OAuth；api.kimi.com/coding；anthropic-messages
  协议）不在本批——不同产品线，用户已确认
- 裸 `kimi-*` id 不路由（只走显式前缀；deepseek 同款决策）
- 动态工具加载（pi `deferredToolsMode:"kimi"`；pi.dev 的 moonshotai 目录
  未启用该旗标，本批不做）
- `inputLimits`/图片 resize 不消费（全仓库现状，继续记账）
- `supportsMidConvoSystemMessages`/`supportsMidConvoToolAdditions` 旗标不消费
  （deepseek P3-8 同款记账）
- k2.6 `thinking.keep:"all"` 不发送（pi parity；冒烟观察项，§4-D5）

## §2 设计

### §2.1 ProviderName 家族扩展

`ProviderName` 增加 `"moonshotai" | "moonshotai-cn"`（resolve.ts:30）。
parseModelRef（resolve.ts:38-68）增加两行前缀路由，未知前缀落回 anthropic
的现有行为不变。createProviderFor（resolve.ts:71+）增加两个分支。

**连带穷举开关**（每处编译器穷举检查会逐一暴露）：
- auth-store.ts:26 `ApiKeyFamily`
- catalog.ts:35-41 `CATALOG_FAMILIES`（pi.dev 两键实测已上线，2026-09-26）
- discover.ts:78-101 `familyConfigured`
- core/session/store.ts:43 parseModel 白名单
- commands.ts:235 MODEL_CANDIDATES、:250 FAMILY_FALLBACKS、:283 familyLabel、
  :638-645 ModelListDeps 签名、:663 families 数组、:680 firstParty、
  :799 LOGIN_TARGETS
- thinking.ts:380+ catalogThinkingMeta switch

### §2.2 provider 模块（src/provider/moonshotai.ts，单文件双工厂）

两家只差 baseUrl / provider name / key 解析函数；共享 seeds 与常量。
（pi 是两个文件（providers/moonshotai.ts 与 moonshotai-cn.ts:10-11），imp
合并为一个模块的理由：减少 resolve.ts 导入面，seeds 单点；如审查偏好
拆两文件，成本 2 行。）

```ts
export const MOONSHOT_DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";
/** pi.dev 目录快照（2026-09-26，目录序）。 */
export const MOONSHOT_SEED_MODELS = [
	"kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3",
] as const;

export function createMoonshotProvider(): LLMProvider {
	return createOpenAICompletionsProvider({
		baseUrl: process.env.MOONSHOT_BASE_URL ?? MOONSHOT_DEFAULT_BASE_URL,
		auth: { family: "moonshotai", envVar: "MOONSHOT_API_KEY" }, // deepseek §2.5 形状
		name: "moonshotai",
	});
}
export function createMoonshotCnProvider(): LLMProvider { /* moonshotai-cn / MOONSHOT_CN_BASE_URL */ }
export function moonshotApiKey(): string | null { return resolveApiKey("moonshotai", "MOONSHOT_API_KEY")?.key ?? null; }
export function moonshotCnApiKey(): string | null { /* 同构 */ }
```

注意：两家共用 `MOONSHOT_API_KEY` env（pi :11 同款），但**存储 key 按家族
隔离**（auth-store apiKeys 分区），`/login moonshotai-cn` 不会污染
`moonshotai`。⚠ 用户可见后果（评审 P2-7）：设了 `MOONSHOT_API_KEY` 后
**两家都会显示为 configured**（familyConfigured 同源），picker 出现两行；
未配的那家 discover 会向默认端点发一次请求——401 按现有语义落 null → 种子
兜底（不是错误）。测试钉：单 env → 两 familyConfigured 均 true。

#### §2.2.1 pi 行为 parity 表（每条锚定）

| # | 声明 | pi 锚点 | imp 现状/动作 |
|---|------|---------|---------------|
| 1 | baseUrl `.ai` / `.cn` 两家 | providers/moonshotai.ts:10；moonshotai-cn.ts:10 | 新建 |
| 2 | auth=envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"])；存储优先于 env | moonshotai.ts:11 | auth 选项新建（imp resolveApiKey 同语义） |
| 3 | 不 store、不用 developer role（isMoonshot ∈ isNonStandard） | :1592、:1610、:1633-1634 | imp 从不发 store、system 一律 "system" — 零改动 |
| 4 | `max_tokens` 字段（非 max_completion_tokens） | :1620 useMaxTokens、:1639 | imp :185-187 正则 `/^(o\d\|gpt-[56])/` 对 `kimi-*` 已判 max_tokens — **零改动，钉子** |
| 5 | supportsReasoningEffort 的**检测默认是 false**（isMoonshot ∈ 排除列表） | :1636 | 家族 case 用 `=== true`（与 deepseek 的 `!== false` 相反——连续两批的反向语义要各配锚点钉）；per-model compat 覆盖时以目录为准（k3 为 true） |
| 6 | supportsStrictMode false | :1662 | imp 不发 strict — 零改动 |
| 7 | k2.6/k2.7-code：thinkingFormat "deepseek"（目录 per-model compat 覆盖检测值）→ `thinking:{type}` | :914-926 分支；目录实测 | 复用 imp deepseek style 分支（:302-315） |
| 8 | k3：thinkingFormat "openai" → `reasoning_effort`；无匹配时检测默认落 "openai" | :956-963；:1644-1654 三元链 | 复用 imp openai-effort 分支（:317-327） |
| 9 | requiresReasoningContentOnAssistantMessages 检测值**仅 deepseek**；Moonshot 由目录 compat 提供（k3=true，k2.6/k2.7 无） | :1643 vs :1697-1699（compat 折叠） | §2.4 回放泛化 |
| 10 | 助手 thinking 块按流入字段名回放（非空拼接） | :1312-1318 | §2.4；字段名 reasoning_content 硬编码（deepseek D5 范围；三家官方均用此字段） |
| 11 | usage 兜底：`choice.usage`（"some providers (e.g., Moonshot)"） | :565-568 | §2.5 |
| 12 | usage：顶层 `cached_tokens`（"Kimi documents top-level usage.cached_tokens"） | :1511-1523 | §2.5 |
| 13 | 不发 temperature（官方文档：k2.6/k2.7-code 不可改、不要显式传） | 文档表格 | imp 不发任何 temperature/top_p（grep 零命中）— 零改动 |
| 14 | reasoning 流入：pi 读三字段（reasoning_content / reasoning / reasoning_text，:601-626 区域） | :601-626 区域 | imp 只读 reasoning_content（:376-385）——既有 D5 记账；三家官方均用该字段 |
| 15 | 流式 reasoning_content 恒先于 content；reasoning+content 共享 max_tokens（建议 ≥16k） | 官方文档 | 记账（不改请求语义；max_tokens 由现有设置链路提供） |

### §2.3 thinking 旋钮（三模型分叉）

catalogThinkingMeta（thinking.ts:380+）增加两 case（moonshotai /
moonshotai-cn 共用），**由目录 compat.thinkingFormat 驱动**（pi 的检测默认
在未覆盖时是 "openai"，:1644-1654——因此缺省落 openai-effort，只有显式
"deepseek" 才走 thinking 对象分支）：

```ts
case "moonshotai":
case "moonshotai-cn": {
	if (entry.compat?.thinkingFormat === "deepseek") {
		return {
			style: "deepseek",
			supportsEffort: entry.compat?.supportsReasoningEffort === true, // 检测默认 false，见 parity #5
			levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap),
			maxOutputTokens: entry.maxTokens,
		};
	}
	return { style: "openai-effort", levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap), maxOutputTokens: entry.maxTokens };
}
```

**行为矩阵**（目录现役四模型；`supportedThinkingLevels` :470 / clamp :489 /
主请求 off→undefined runner.ts:1042 / compaction 原样传 level 的 P1-1 防御
沿用）：

| 模型 | compat | 可选级别 | level 选中 → 请求体 | 显式 off/undefined → |
|------|--------|----------|---------------------|----------------------|
| kimi-k2.6 | deepseek, effort:false, 无 map | off/high（无 map 二进制默认 :475-478） | `thinking:{type:"enabled"}`（无 reasoning_effort） | `thinking:{type:"disabled"}`（off 可用） |
| kimi-k2.7-code(-highspeed) | deepseek, effort:false, map{off:null} | minimal/low/medium/high | `thinking:{type:"enabled"}` | 什么都不发（off:null；模型恒思考） |
| kimi-k3 | openai, effort:true, 全 map | low/high/max | `reasoning_effort:"low"/"high"/"max"`；**永不发 thinking** | 什么都不发（off:null；服务端默认 max） |

**默认级别链路（评审 P1 修正）**：启动级别 =
`options.thinking ?? 设置 defaultThinkingLevel ?? "medium"`（runner.ts:387-390，
pi 的 DEFAULT_THINKING_LEVEL 即 "medium"），再按模型 clamp（thinking.ts:489）：
- k2.6：clamp（medium）→ **high → `thinking:{type:"enabled"}`**（默认开思考）
- k2.7-code：clamp（medium）→ medium → `thinking:{type:"enabled"}`（恒思考）
- k3：clamp（medium）→ **high → `reasoning_effort:"high"`**（服务端默认 max，
  imp 显式降档到 high）

**显式 off**（`--thinking off` 或用户调到 off；主请求 off→undefined
（runner.ts:1042），compaction/branch-summary 原样传 "off"）：
- k2.6 → `thinking:{type:"disabled"}`（undefined 与 raw "off" 同果）
- k2.7-code → 什么都不发（off:null；模型恒思考）
- k3 → 什么都不发

**离线地板**（thinking.ts MODEL_RULES:81，frozen 快照 pi.dev 2026-09-26；
两 provider 各 3 条，共 6 条或抽 helper 注册）：
- `{prefix:"kimi-k3", meta:{style:"openai-effort", levelMap:{off:null,minimal:null,low:"low",medium:null,high:"high",xhigh:null,max:"max"}}}`
- `{prefix:"kimi-k2.7-code", meta:{style:"deepseek", supportsEffort:false, levelMap:{off:null}}}`
- `{prefix:"kimi-k2.6", meta:{style:"deepseek", supportsEffort:false}}`

**不设泛化 `kimi-` 规则**：旧世代 id（kimi-k2-0711 / k2-thinking / k2.5…，
pi 本地数据有、pi.dev 现目录无）能力未知；缺省 meta null=仅 off、不发
thinking 更安全。在线时目录自动覆盖。

### §2.4 reasoning_content 回放泛化（deepseek §4-D5 预留点）

现状：toWireMessages（openai-completions.ts:87-131）单布尔
`reasoningContentReplay`：true 时（a）thinking 块非空拼接为
`reasoning_content`、（b）**恒补** `reasoning_content: ""`（:118-128）。
call site :264 只在 `family === "deepseek" && meta !== null` 时开。

pi 的两条独立规则：非空签名回放（:1312-1318）+ 空串填充
（`requiresReasoningContentOnAssistantMessages`，:1357-1361）。拆成：

- **文本回放**：family ∈ {deepseek, moonshotai, moonshotai-cn} 且
  `thinkingMetaFor ≠ null`（沿用现门）
- **空串填充**：模型级
  - deepseek 家族：恒定 true（pi :1643 检测式；保持现行为，不动）
  - moonshot：目录 compat `requiresReasoningContentOnAssistantMessages === true`
    （k3）；k2.6/k2.7 无 thinking 块的 assistant 帧**不出现**该字段（不是 ""）

实现：`ModelThinkingMeta` 增 `requiresReasoningContentOnAssistantMessages?: boolean`
（catalog case 从 entry.compat 读）；toWireMessages 第三参改
`{ replay: boolean; fillEmpty: boolean } | null`；call site 组装。
字段名 reasoning_content 硬编码不变（deepseek D5 范围）。

反例钉子（测试）：
- k2.6 历史 assistant 无 thinking → 请求体**无** reasoning_content 键；
  k3 同输入 → `reasoning_content: ""`
- k3 **tool-call-only 帧**（content:null + tool_calls + 无 thinking）→ 同样补
  `reasoning_content: ""`（pi :1357-1361 对所有 assistant 帧生效）；k2.6 同形
  帧 → 无键
- **跨家族切换**（评审 P2-4）：回放 gate 只按**当前请求模型**的 compat 判定
  （pi :1697-1698 同款）；历史含其他家族帧时填充与否随之切换——此行为有意
  pi-parity（非逐帧判定），用跨切换测试钉住（k3→k2.6 历史帧不补 ""，反向补）

### §2.5 usage 兜底

- 提取点（:419-430 区）：整块以 `const rawUsage = chunk.usage ?? choice?.usage;`
  开头、守卫改 `rawUsage != null`，**块内所有 `chunk.usage.` 引用全部替换为
  `rawUsage.`**（评审 P2-2：只追加链尾会留 null 解引用），链尾再追加
  `?? rawUsage.cached_tokens`（官方文档：Kimi 顶层 cached_tokens 在 final
  usage chunk；pi :1520）。null/undefined 双守卫 = deepseek null 教训不动摇
- （评审 P2-3）类型：抽具名 `StreamUsage`（现有 :220-222 区字面量），
  `chunk.usage?: StreamUsage | null`、choices 元素新增 `usage?: StreamUsage | null`
  （pi 用 `as any` 读；imp 声明诚实、不用 any）；顶层补 `cached_tokens?: number`
- reasoning 计费 token 不消费（现状，记账）

### §2.6 发现与目录

- discover.ts:78-101 familyConfigured 增两 case（moonshotApiKey() /
  moonshotCnApiKey() !== null）
- discoverModels 增两分支（mirror deepseek 分支）：`GET {base}/models`
  Bearer、cache TTL 同款；env override 重定向时 #gateway-truth（不可达 →
  null 不落种子）；默认端点不可达 → `[...MOONSHOT_SEED_MODELS]`
- catalog.ts CATALOG_FAMILIES += 两键（已验证 200）

### §2.7 /login、picker、静态地板、cli、401 文案

- LOGIN_TARGETS（:799）追加表尾两条：
  `{family:"moonshotai", name:"Moonshot AI", envVar:"MOONSHOT_API_KEY", method:"api_key", switchHint:"moonshotai/kimi-k3"}`
  `{family:"moonshotai-cn", name:"Moonshot AI CN", envVar:"MOONSHOT_API_KEY", method:"api_key", switchHint:"moonshotai-cn/kimi-k3"}`
- FAMILY_FALLBACKS（:250）：`moonshotai: ["moonshotai/kimi-k3","moonshotai/kimi-k2.6"]`；
  cn 同构（前缀替换）
- familyLabel（:283）：`moonshotai-cn/` 与 `moonshotai/` 两分支（注意
  cn 前缀更长，判断顺序要在前）
- MODEL_CANDIDATES（:235）+= `"moonshotai/kimi-k3"`、`"moonshotai-cn/kimi-k3"`
- families 数组（:663）+= 两键；firstParty（:680）：
  `(family === "moonshotai" && process.env.MOONSHOT_BASE_URL === undefined) || (family === "moonshotai-cn" && process.env.MOONSHOT_CN_BASE_URL === undefined)`
- models.ts 静态地板：
  - MODEL_CONTEXT_WINDOWS（:20）：kimi-k2.6 / kimi-k2.7-code /
    kimi-k2.7-code-highspeed = 262144；kimi-k3 = 1048576
  - MODEL_COSTS（:72）快照（pi.dev 2026-09-26，USD/MTok）：
    k2.6 {in 0.95, out 4, cacheRead 0.16, cacheWrite 0}；
    k2.7-code {0.95, 4, 0.19, 0}；k2.7-code-highspeed {1.9, 8, 0.38, 0}；
    k3 {3, 15, 0.3, 0}
- vision.ts：两 provider 各 3 条精确前缀规则（`kimi-k3`、`kimi-k2.6`、
  `kimi-k2.7-code` → vision:true）；**不设泛化 `kimi-` 规则**（同 §2.3
  理由）。匹配是首命中（vision.ts:55-62 顺序遍历），三条互斥前缀无顺序问题
- cli.ts 帮助区：新增 Moonshot 官方接入块（MOONSHOT_API_KEY /
  IMP_MODEL=moonshotai-cn/kimi-k3 / /login moonshotai-cn / 国内站与国际站
  对应关系）；:171-175 "any compatible endpoint (Kimi, …)" 注释块改为指向
  官方路径（deepseek P2-4 同款处理）
- 401 文案家族化（:344）：有 `options.auth` 时 `check ${options.auth.envVar}`，
  否则保持现文案；openai/anthropic 路径不变；deepseek 同受益（grep 确认
  现无测试钉子）；zai 未走 auth 选项保持原样（记账）

## §3 测试计划（新 test/moonshotai.test.ts + 既有钉子更新）

1. **路由**：parseModelRef 两家前缀；裸 `kimi-k3` 仍落 anthropic（钉非目标）；
   createProviderFor/resolveModel。
2. **key 解析**：familyConfigured 随 env 与存储 key；stored > env；两家存储
   隔离（登录 cn 不影响 ai）；**交叉污染钉**：设 OPENAI_API_KEY、不设
   moonshot → 报错点名 MOONSHOT_API_KEY（`not.toContain("OPENAI_API_KEY")`）；
   **单 env 双家族钉**（P2-7）：设 MOONSHOT_API_KEY → 两家 configured，
   未配家族 discover 401 → null → 种子。
3. **wire（本地 http 服务器，zai/deepseek.test.ts 模板）**：
   a. k2.6 level high → `thinking:{type:"enabled"}`、无 reasoning_effort、
      max_tokens 字段、无 store/developer、Bearer。
   b. k2.6 显式 off（直接传 "off" 与主路径 undefined 两形）→
      `thinking:{type:"disabled"}`（P1-1 防御钉）；**默认链路钉**：
      clamp("medium") → high → enabled（P1 修正后的默认推导）。
   c. k2.7-code level high → `thinking:{type:"enabled"}`；直接传 "off" /
      undefined（off:null 负面）→ 请求体既无 thinking 也无 reasoning_effort。
   d. k3 level low/high/max → reasoning_effort 映射值；**任何情况无 thinking
      键**（文档硬约束钉）；显式 off/undefined → 两个都不发；**默认链路钉**：
      clamp("medium") → reasoning_effort:"high"。
   e. 回放：k3 无 thinking 的 assistant 帧 → `reasoning_content: ""`；有块 →
      拼接文本；**k3 tool-call-only 帧（content:null + tool_calls）→ 同样补 ""**；
      k2.6/k2.7 无块（含同形 tool-only 帧）→ **键不存在**；**跨切换**（k3→k2.6
      与反向）按当前请求模型判定；deepseek 行为不变钉。
   f. usage：顶层 cached_tokens → cacheRead 计入且 input 扣除；choice.usage
      兜底（chunk.usage 缺省/null）；中间块 usage:null 守卫回归。
   g. reasoning_content delta → thinking 事件（既有路径回归钉）。
   h. 401 文案：auth 家族 → "check MOONSHOT_API_KEY"；deepseek 同款更新。
4. **thinking 梯子**：k2.6 → ["off","high"]；k2.7-code →
   ["minimal","low","medium","high"]（无 off）；k3 → ["low","high","max"]；
   clamp 数字钉（off→minimal / off→low）；catalog case 反向默认钉：
   compat 无 supportsReasoningEffort 的 "deepseek" 条目 → supportsEffort
   false（`=== true` 锚）。
5. **发现**：/models 成功列表；不可达 → 种子；env override + 不可达 → null
   （#gateway-truth）。
6. **目录**：CATALOG_FAMILIES 含两键——精确钉
   `arrayContaining(["moonshotai","moonshotai-cn"])` + `toHaveLength(7)`
   （P3-10：不用弱 toContain）；refresh 假 fetcher 写盘后 contextWindowInfoFor
   走 catalog 源。
7. **静态地板**：离线 contextWindowInfoFor("moonshotai/kimi-k3") → 1048576；
   costFor 命中新费率。
8. **vision**：kimi-k3/kimi-k2.6/kimi-k2.7-code 两 provider 均 true；
   未知旧 id（如 kimi-k2-0711-preview）→ false（无规则）；**离线断言前先
   resetCatalogForTest**（P3-11，避免目录命中掩盖规则）。
9. **会话**：setModel("moonshotai-cn/kimi-k3") 持久化 + modelReference 带前缀；
   parseModel 白名单接受。
10. **/login**：loginTargetFor 两键命中；unknown-provider 消息含新家族；
    picker 行 +2；switchHint 串。
11. **buildModelList**：configured → 发现行带前缀；不可达 → FAMILY_FALLBACKS
    行。
12. **既有钉子更新**：全量 grep 家族字面量（P3-9 校准为 7 个文件：
    test/deepseek.test.ts、images.test.ts、model-discovery.test.ts、
    repl-commands.test.ts、thinking.test.ts、auth-store.test.ts、
    model-catalog.test.ts），逐一对齐；**精确串基线**：
    test/repl-commands.test.ts:1736 的 unknown-provider 消息
    `"known: zai, anthropic, openai, openai-codex, deepseek"` 追加两家族后重校；
    **hermetic 环境擦洗**（P2-6）：test/repl-commands.test.ts:241-248 及
    model-discovery/auth-store 相关 setup 增擦 `MOONSHOT_API_KEY`、
    `MOONSHOT_BASE_URL`、`MOONSHOT_CN_BASE_URL`。

### §3.x 真机冒烟（实施评审之前，PROJECT_PLAN 2026-09-26 教训）

前置：实现 + build；用户执行 `/login moonshotai-cn`（key 只落
`~/.imp/auth.json`，冒烟读同一存储、不打印明文）。

1. `GET /v1/models`（stored key）→ 四个模型在列
2. k2.6 流式：默认路径（thinking enabled）与显式 off（disabled）各一次；
   工具调用一轮 → 续传帧接受；第 2 次调用确认 usage 顶层 cached_tokens 出现
   且解析正确
3. k2.7-code：imp 实际行为（`thinking:{type:"enabled"}`）→ 服务端接受；
   对照省略 thinking 的一次请求。**判定规则（P2-8）**：enabled 被 400 →
   触发 §6 风险 1 降级（off:null 且 effort:false 时不发 thinking）并更新设计
4. k3：`reasoning_effort:"high"`（默认）与 "low" 接受；工具续传对照（带/
   不带 `reasoning_content`）。**判定规则**：任一形式被拒 → 上修回放策略
   （fillEmpty 扩到 k2.6/k2.7，以证据为准）；两形都接受 → 维持 pi parity
5. 坏 key → 401 文案点名 MOONSHOT_API_KEY
6. `/model` picker：/login moonshotai-cn 后出现带前缀的两家族行；switchHint
   提示串出现
7. 连通性：`GET https://api.moonshot.cn/v1/models`（stored key）可达、四模型
   在列；api.moonshot.ai 同测（无 key 时至少测 401 形状与可达性）
产出记录进本文件附录或 PROJECT_PLAN。

## §4 决策点

- **D1** 两家都做 —— 用户确认（2026-09-26）✓
- **D2** 命名 `moonshotai` / `moonshotai-cn`（pi 与 pi.dev 目录键一致）✓
- **D3** base 覆盖 env：`MOONSHOT_BASE_URL`（ai）/ `MOONSHOT_CN_BASE_URL`
  （cn）——照 DEEPSEEK_BASE_URL 先例；#gateway-truth 语义沿用
- **D4** 401 文案家族化（deepseek 同受益）——推荐本批
- **D5** k2.6 `keep:"all"` 不发（pi parity；冒烟后按需单独评估）
- **D6** kimi-coding 订阅制 OAuth 非本批 ✓（已告知用户）
- **D7** 无泛化 `kimi-` 地板规则（thinking 与 vision 表都只收精确前缀）
- **D8** 单模块双工厂（vs pi 两文件）——推荐单模块

**记账（不改）**：费率显示沿用 pi.dev 美元口径（国内站人民币价不换算，
与 zai/deepseek 同）；`inputLimits` 不消费；`supportsMidConvo*` 不消费；
reasoning 计费 token 不消费；zai 的 401 文案不动；动态工具加载不做。

## §5 规模核算

- src：moonshotai.ts ~55 + thinking.ts（case + 6 条地板 + meta 字段）~50 +
  openai-completions.ts（回放拆分 + usage 兜底重构 + 类型 + 401 文案）~50 +
  discover.ts ~45 + resolve/auth-store/catalog/store/vision ~20 +
  commands.ts ~40 + models.ts ~20 + cli.ts ~10 ≈ **+290 行**，删除 0。
- test：moonshotai.test.ts ~400-480（含 P2-4/P2-5 帧形状与跨切换钉）+
  既有钉子更新 ~30。
- 门禁预期：全量 vitest（1961 → ~2050+）、typecheck×2、biome、build。

## §6 风险

1. **k2.7-code 的 thinking 形状**：文档正文 "should not pass" vs 表格
   "仅 enabled 可传"；pi 发 `{type:"enabled"}`。冒烟裁决；若被拒 → 降级为
   “off:null 且 effort false 时不发 thinking”（本地单点小改）。
2. **k3 回放强制程度**：冒烟对照；若服务端宽容，空填充仍保持（pi parity），
   无行为风险。
3. **usage 形状漂移**（choice.usage 是否存在、顶层 cached_tokens 位置）：
   双兜底 + 冒烟；三态守卫。
4. **目录漂移**：M14 机制（4h 窗口、在线纠正、离线地板）。
5. **钉子散落**：合并前全量 grep 家族字面量（已知 5 个测试文件）；上一批
   教训（枚举类钉子要精确匹配）。
6. **默认级别交互**（P1 修正后）：默认 medium → k2.6 默认**在思考**（high）、
   k3 默认 `reasoning_effort:"high"`（服务端默认 max，imp 显式降档）、
   k2.7-code 恒思考；`/think` 可调，帮助/README 补一句说明。
