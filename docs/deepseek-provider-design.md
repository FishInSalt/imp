# DeepSeek 官方 API 接入（#deepseek-provider）

状态：rev2（评审后修订；rev1 见 git 历史）
分支：feature/deepseek-provider
参照系：pi @ /Users/z/Z/Agent_demo/pi（每条 parity 声明锚定源码行）
日期：2026-09-25

---

## §1 目标与非目标

**目标**：`deepseek/<id>` 模型引用走 DeepSeek 官方端点（api.deepseek.com，
DEEPSEEK_API_KEY 或 `/login deepseek` 存储 key），包含 thinking 旋钮、
reasoning 回放、模型发现、目录、/login、/model picker 全链路——zai 家族
（src/provider/zai.ts）是模板，差异处逐条锚定 pi。

**非目标**：
- 不改 zai 家族行为（含 §4-D2 记录的遗留怪癖，仅入账不动）
- 不做 pi 的通用三字段 reasoning 读取（pi :595-626 读
  reasoning_content/reasoning/reasoning_text 三个字段；imp 只读
  reasoning_content——DeepSeek 实际只用这个字段，openai-completions.ts:317
  已有）
- 不做裸 `deepseek-*` id 路由（zai 的裸 glm-* 路由是历史包袱特例，
  runner.ts:51 有注释；deepseek 只走显式前缀）

## §2 设计

### §2.1 ProviderName 家族扩展

`ProviderName` 增加 `"deepseek"`（resolve.ts:28）。parseModelRef 增加一行
前缀路由（`deepseek/<id>` → {provider:"deepseek"}），未知前缀落回 anthropic
的现有行为不变。createProviderFor switch 增加分支。

**连带穷举开关**（每处都是 `"zai"` 既有成员旁加一个成员，编译器穷举检查
会逐一暴露）：
- auth-store.ts:24 `ApiKeyFamily`
- catalog.ts:40 `CATALOG_FAMILIES`（pi.dev 实测已上线
  /api/models/providers/deepseek，2026-09-25 探测）
- discover.ts:75-101 familyConfigured
- commands.ts:634-639 ModelListDeps 签名、:657 families 数组、:792
  LOGIN_TARGETS、:249 FAMILY_FALLBACKS、familyLabel
- core/session/store.ts:43 parseModel 白名单
- thinking.ts catalogThinkingMeta switch（:369-378）

### §2.2 provider 模块（src/provider/deepseek.ts，镜像 zai.ts）

```ts
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_SEED_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

export function createDeepSeekProvider(): LLMProvider {
	return createOpenAICompletionsProvider({
		baseUrl: process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
		// P2-6: 只走 auth（存储 > DEEPSEEK_API_KEY）；不再同时传 apiKey
		// ——两条解析路径会漂移。
		auth: { family: "deepseek", envVar: "DEEPSEEK_API_KEY" },
		name: "deepseek",
	});
}
export function deepseekApiKey(): string | null {
	return resolveApiKey("deepseek", "DEEPSEEK_API_KEY")?.key ?? null;
}
```

#### §2.2.1 pi 行为 parity 表（每条锚定）

| # | 声明 | pi 锚点 | imp 现状/动作 |
|---|------|---------|---------------|
| 1 | baseUrl `https://api.deepseek.com`（无 /v1 后缀；SDK 自动拼 /chat/completions；imp 直接 `${baseUrl}/chat/completions` 等价） | providers/deepseek.ts:10 | 新建 |
| 2 | auth = envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"])；存储 key 优先于 env（imp 的 resolveApiKey 同语义） | deepseek.ts:11；auth/helpers.ts envApiKeyAuth.resolve | 新建（auth-store ApiKeyFamily） |
| 3 | max_tokens 字段（非 max_completion_tokens） | openai-completions.ts:1627 useMaxTokens 含 isDeepSeek；:1641 | imp 正则 `/^(o\d\|gpt-[56])/` 对 deepseek-* 已判 max_tokens——**零改动**，测试钉住即可 |
| 4 | 不发 store、不用 developer role | :1609-1620 isNonStandard 含 isDeepSeek → supportsStore/DeveloperRole false | imp 从不发 store、system 一律 "system"——**零改动** |
| 5 | thinkingFormat "deepseek"：`reasoning_effort` 存在 → `thinking:{type:"enabled"}`；否则若 levelMap.off !== null → `thinking:{type:"disabled"}`；enabled 且 supportsReasoningEffort → `reasoning_effort = levelMap[level] ?? level` | :914-926 | 新增 style 分支（§2.3） |
| 6 | supportsReasoningEffort 默认 true（排除列表无 deepseek；模型 compat 缺省 `??` 回落 detected） | :1636；:1697-1699 | catalogThinkingMeta 映射用 `!== false`（**不是** zai 的 `=== true`——zai 的 detected 默认是 false，deepseek 是 true；两家的 ?? 语义必须分别锚） |
| 7 | 助手消息回放：`requiresReasoningContentOnAssistantMessages && model.reasoning && reasoning_content === undefined` → 填 `reasoning_content: ""` | :1357-1361 | 新增（§2.4）——DeepSeek V4 交错思考的工具调用续传要求 assistant 帧带该字段 |
| 8 | 助手消息的 thinking 块按到达字段名回放为 `reasoning_content = 拼接文本`（非空时） | :615-619（流入时签名=字段名）；:1312-1317（回放） | 新增（§2.4） |
| 9 | reasoning 流入字段 reasoning_content（delta） | :601-626 | imp openai-completions.ts:317 已读——**零改动** |
| 10 | 不发 tool_stream（compat.zaiToolStream 默认 false） | :1675 默认 false | 不传该选项——**零改动** |
| 11 | strict mode 支持（supportsStrictMode true） | :1647 排除列表无 deepSeek | imp 不发 strict 字段——**零改动** |
| 12 | usage 随流（supportsUsageInStreaming true） | :1639 默认 | include_usage 已发——**零改动** |

### §2.3 thinking 旋钮（新 style "deepseek"）

`ThinkingStyle` 增加 `"deepseek"`。openai-completions.ts stream() 的 thinking
分支（:248-266 区域）新增：

```ts
} else if (meta?.style === "deepseek") {
	// P1-1: level 可能是 "off"（compaction/branch-summary 路径传原样
	// this.level，runner.ts:1042 的 off→undefined 只在主请求）；pi 在
	// sdk 层归一（openai-completions.ts:738）。glm 分支同理防御
	// （openai-completions.ts:251-252）。
	if (level !== undefined && level !== "off") {
		body.thinking = { type: "enabled" };
		if (meta.supportsEffort !== false) {
			body.reasoning_effort = effortFor(meta, level);
		}
	} else if (meta.levelMap?.off !== null) {
		// off 可用（V4 地图无 off:null 项）：显式 disabled。
		// 反例（负面钉子）：地图含 off:null 的模型 level undefined
		// → 两个都不发（pi else-if 落空的负面空间）。
		body.thinking = { type: "disabled" };
	}
}
```

注意与 zai GLM 的两处差异：无 `clear_thinking` 旗标（pi :915 只发
`{type:"enabled"}`，GLM 才带 `clear_thinking:false`）；"off" 可用（V4 的
levelMap 无 off:null 项 → off 可选 → thinking 显式 disabled）。

（P3-8：pi.dev 的 v4-pro 带 supportsMidConvoSystemMessages:true —— imp
各处均不消费该旗标，本批明确不采纳，行为差异入账不扩散。）

**离线地板**（thinking.ts MODEL_RULES，frozen 惯例照 zai 先例加入快照）：
- `{provider:"deepseek", prefix:"deepseek-flash", meta:{style:"deepseek",
  levelMap:{minimal:null, low:"low", medium:null, high:"high", max:"max"}}}`
- `{provider:"deepseek", prefix:"deepseek-", meta:{style:"deepseek",
  levelMap:{minimal:null, low:null, medium:null, high:"high", max:"max"}}}`

（来源：pi.dev 线上目录 2026-09-25 实测；pi 本地 data/deepseek.json 与
pi.dev 有漂移——本地 json 的 v4-flash 是 text-only 且 low:null，pi.dev 的
deepseek-flash 是 "DeepSeek V4.1 Flash"、low:"low"、input 含 image。
M14 既定规则：pi.dev 线上为准。）

`supportedThinkingLevels` 走既有 map 驱动路径，无需改动（off 缺省=可用、
minimal/low/medium null=不可用、high/max 显式映射——v4-pro 梯子恰好
["off","high","max"]，flash 多一个 low）。

catalogThinkingMeta 增加 `case "deepseek"`：
```ts
return {
	style: "deepseek",
	supportsEffort: entry.compat?.supportsReasoningEffort !== false, // parity 表 #6
	levelMap: sanitizeCatalogLevelMap(entry.thinkingLevelMap),
	maxOutputTokens: entry.maxTokens,
};
```

### §2.4 reasoning_content 回放（wire 层）

toWireMessages 增加可选第三参（provider 侧传入）：

```ts
interface AssistantReplayCompat {
	/** pi :1643/:1357-1361 —— deepseek 家族：assistant 帧必须带
	 *  reasoning_content（有 thinking 块→拼接文本；没有→""）。 */
	reasoningContent: boolean;
}
```

- `reasoningContent = true` 时：assistant 消息的 thinking 块（现有
  AssistantBlock，非空文本）拼接为 `reasoning_content`；无 thinking 块或全
  空 → `reasoning_content: ""`。**字段名硬编码为 reasoning_content**
  （P1-2 澄清：pi 的通用机制按流入字段名回放 `assistantMsg[signature]`
  （:1312-1318），但 imp 不实现通用签名——DeepSeek 流入字段恒为
  reasoning_content，硬编码即 D5 范围内的完整 parity；未来其他
  reasoning 字段家族走 D5 的通用化）。
- WireMessage 的 assistant 变体增加 `reasoning_content?: string`。
- 判定：`options.name === "deepseek" && thinkingMetaFor("deepseek", model) !== null`
  （imp 无 model.reasoning 字段，thinking 元数据存在性即其代理——目录/地板
  表都只为 reasoning 模型建条目）。
- 其余家族（openai/zai）：不传 compat，行为逐字节不变（thinking 块照旧
  丢弃——zai 的 GLM 语义本就是 clear_thinking 的服务端清理 + pi zai 兼容
  不回放；openai 的 o 系不收 reasoning_content）。

### §2.5 key 解析与 no-key 报错（§4-D2）

现状：openai-completions.ts:203 `options.apiKey ?? resolveApiKey("openai",
"OPENAI_API_KEY")` —— deepseek 家族若走此回退，会把用户的 OpenAI key 发给
api.deepseek.com（401 且泄露 key 归属）。新增 provider 选项：

```ts
/** 家族级 key 解析（存储 > 指定 env var），替代 openai 家族回退。 */
auth?: { family: ApiKeyFamily; envVar: string };
```

`apiKey = options.apiKey ?? (options.auth ? resolveApiKey(options.auth.family,
options.auth.envVar)?.key : resolveApiKey("openai","OPENAI_API_KEY")?.key)`。
no-key 报错消息：auth 存在时点名 `export <envVar>=...`（或 `/login <family>`）
而非 OPENAI_API_KEY。deepseek.ts 传
`auth: {family:"deepseek", envVar:"DEEPSEEK_API_KEY"}`。
zai 不改（入账 §4-D2）。

### §2.6 发现与目录

discover.ts：familyConfigured 增加 `case "deepseek": return
deepseekApiKey() !== null`；discoverModels 增加 deepseek 分支（镜像 zai
:131-148）：`GET {DEEPSEEK_BASE_URL|默认}/models`（OpenAI 形状，Bearer），
`#gateway-truth` 同款——DEEPSEEK_BASE_URL 重定向时不落种子返回 null；
默认端点不可达 → DEEPSEEK_SEED_MODELS。

catalog.ts：CATALOG_FAMILIES 加 "deepseek" 即全通（refresh/ETag/4h 窗口/
磁盘缓存都是 family 泛型；pi.dev 端点已实测存在）。

### §2.7 /login、picker、静态地板

- LOGIN_TARGETS 追加
  `{family:"deepseek", name:"DeepSeek", envVar:"DEEPSEEK_API_KEY",
  method:"api_key", switchHint:"deepseek/deepseek-v4-pro"}`（追加在表尾，
  /login picker 行序与现有钉子最小扰动）。loginStatus/familyConfigured 走
  ApiKeyFamily 泛型，自动生效。/login deepseek 走刚合并的 LoginDialog
  （api_key 路径），无需对话框改动。
- buildModelList families 数组加 "deepseek"；firstParty 增加
  `family === "deepseek" && process.env.DEEPSEEK_BASE_URL === undefined`；
  FAMILY_FALLBACKS.deepseek = ["deepseek/deepseek-v4-pro",
  "deepseek/deepseek-flash"]；familyLabel 加 deepseek 分支（"DeepSeek"）。
- models.ts 冻结表加静态地板快照（照 glm-5.x 先例，标注 pi.dev 2026-09）：
  MODEL_CONTEXT_WINDOWS：deepseek-flash / deepseek-v4-pro = 1_000_000；
  MODEL_COSTS：flash {input:0.3, output:1.2, cacheRead:0.006, cacheWrite:0}、
  v4-pro {input:1.32, output:3.96, cacheRead:0.044, cacheWrite:0}（P1-3：
  rev1 的 0.28/0.28 是笔误；pi.dev 2026-09-25 实测值，已二次确认）。
- MODEL_CANDIDATES（commands.ts:235-243，P2-4）：追加
  "deepseek/deepseek-v4-pro"（离线零配置下 /model 候选可见；其余家族均
  在列）。
- vision.ts 离线规则：`{provider:"deepseek", prefix:"deepseek-flash",
  vision:true}`（pi.dev input 含 image）；其余 deepseek-* 默认 false（无规则
  即 false，已有测试 test/images.test.ts:326 钉住 deepseek-v4=false）。
- cli.ts 帮助区追加 DeepSeek 官方接入块（DEEPSEEK_API_KEY +
  IMP_MODEL=deepseek/deepseek-v4-pro + /login deepseek）；原
  "any compatible endpoint" 示例块（cli.ts:171-172 的
  OPENAI_BASE_URL=api.deepseek.com 示例）改为通用措辞并把 DeepSeek 示例
  指向新块（P2-4：避免留下与官方路径竞争的绕行示例）。
- runner 的 noteMissingZaiCredential **不扩展**（zai 特例是因为裸 glm-* 无
  条件路由；deepseek 只显式前缀，选错家族的场景不存在）。

## §3 测试计划（test/deepseek.test.ts + 既有钉子更新）

1. **路由**：parseModelRef("deepseek/x") → {provider:"deepseek"}；裸
   "deepseek-chat"（无前缀）仍落 anthropic（钉住非目标决策）；
   resolveModel/createProviderFor。
2. **key 解析**：familyConfigured 随 DEEPSEEK_API_KEY 与存储 key（stored >
   env）；no-key 报错点名 DEEPSEEK_API_KEY 而非 OPENAI_API_KEY（钉 §2.5——
   设 OPENAI_API_KEY、不设 deepseek，断言报错而不是拿 OpenAI key 连线）。
3. **wire（本地 http 服务器，zai.test.ts 模板）**：
   a. Bearer key、路径 /chat/completions、**无 tool_stream**（钉 parity #10）、
      max_tokens（钉 #3）、无 store、system role。
   b. level high → `thinking:{type:"enabled"}`（无 clear_thinking）+
      `reasoning_effort:"high"`；level off → `thinking:{type:"disabled"}`、
      无 reasoning_effort；level low（v4-pro 地板 low:null）→ clamp 到 high。
   **（P1-1）summarizer 路径**：直接调 provider.stream 传 thinking:"off"
      （复刻 compaction/branch-summary 的原样传递）→ 断言
      `thinking:{type:"disabled"}`（而非 enabled）。
   **（P2-5b）负面钉子**：假目录条目含 off:null、level undefined →
      请求体既无 `thinking` 也无 `reasoning_effort`。
   c. **回放**（钉 #7/#8）：构造含 thinking 块 + toolCall 的 assistant 历史
      → 下一请求体该 assistant 帧 `reasoning_content` = 拼接文本；纯文本
      assistant 帧 → `reasoning_content === ""`。
   d. streaming reasoning_content delta → thinking_delta 事件（既有通用路径，
      钉 #9 回归）。
4. **thinking 梯子**：v4-pro → ["off","high","max"]；flash（地板规则）→
   ["off","low","high","max"]；catalogThinkingMeta 假 fetcher：compat 缺
   supportsReasoningEffort → supportsEffort 仍 true（钉 #6 的 !== false）。
5. **发现**：默认端点不可达 → 种子；DEEPSEEK_BASE_URL 重定向+不可达 → null
   （#gateway-truth）。
5b. **无 key 交叉污染**（§2.5）：设 OPENAI_API_KEY、不设 deepseek 任何
    key → no-key 报错点名 DEEPSEEK_API_KEY（报错文案断言 not.toContain
    OPENAI_API_KEY）。
6. **目录**：CATALOG_FAMILIES 含 deepseek；refresh 假 fetcher 写盘后
   contextWindowInfoFor 走 catalog 源。
7. **静态地板**：离线 contextWindowInfoFor("deepseek/deepseek-v4-pro") →
   static 1M；costFor 命中新费率。
8. **vision**：deepseek-flash true、deepseek-v4-pro false。
9. **会话**：setModel("deepseek/deepseek-v4-pro") 持久化 + modelReference
   带 prefix；parseModel 白名单接受；无 zai 式教学 note。
10. **/login**：loginTargetFor("deepseek") 命中；unknown-provider 消息含
    deepseek；picker 行追加（LOGIN_TARGETS 长度 +1）。
11. **buildModelList**：configured deepseek → 发现列表行带 deepseek/ 前缀；
    不可达 → FAMILY_FALLBACKS 行。
12. **既有钉子更新**：全量 grep 扫钉是固定步骤（P2-5c）——至少
    repl-commands 的 known-providers 消息串、login-dialog/settings-panel 钉
    过的 zai picker 行串、session-store 白名单测试；执行时 grep
    'zai.*anthropic.*openai' 跨全部 test 文件逐个对齐。

## §4 决策点（需要用户/审查确认）

- **D1 DEEPSEEK_BASE_URL**：pi 的 deepseek.ts 无 base 覆盖；imp 加它是照
  ZAI_BASE_URL 先例（对称 + #gateway-truth 需要）。成本一行 + discover 分支。
- **D2 zai 遗留**：zai 家族缺 key 时回退 OPENAI_API_KEY（zai.ts:37 ?? undefined
  → openai-completions.ts:203 回退）——发错端点的 key 归属问题，与 deepseek
  同构。本批只给 deepseek 用新 auth 选项修好，zai 留原样（改 zai 是行为变更，
  值得单独小批 + dogfood）；入账 PROJECT_PLAN。附带：zai 的 no-key 报错文案
  本批后仍点名 OPENAI_API_KEY/z.ai 行——zai 小批一并修。
- **D3 回放范围**：完整 pi parity（#7 "" 填充 + #8 真实文本回放）。替代方案
  （只做 #7）省 ~15 行但丢上下文连贯性收益，pi 明确选择了完整回放，跟。
- **D4 种子/地板来源**：pi.dev 线上（deepseek-flash 命名 + vision 能力与 pi
  本地 json 漂移，线上为准——M14 既定规则）。
- **D5 imp 不读 reasoning/reasoning_text 备用字段**（pi :601 通用三字段）：
  DeepSeek 官方流只用 reasoning_content；通用化留给未来家选用。

## §5 规模核算

- src：deepseek.ts ~35 + openai-completions.ts（style 分支 + 回放 + auth
  选项）~70 + thinking.ts（style + 2 地板规则 + catalog case）~35 +
  discover.ts ~30 + resolve/auth-store/store/catalog 各 1-3 + commands.ts
  （LOGIN_TARGETS/families/fallbacks/label）~25 + models.ts 地板 ~10 +
  vision ~3 + cli.ts ~8 ≈ **+230 行**，删除 0。
- test：deepseek.test.ts ~300-400 + 既有钉子更新 ~20。
- 门禁预期：全量 vitest（1932 → ~1950+）、typecheck×2、biome、build。

## §6 风险

- pi.dev 目录漂移（flash 的 low/vision 已发生一次）：地板规则注释锚定探测
  日期，目录在线时自动纠正——M14 机制本就为此设计。
- DeepSeek V4 文档语义若与 pi 实现有出入（thinking:{type} 是 V4 新形状）：
  以 pi 运行时行为为准（pi 目录 compat 即从官方 API 生成）。
- 行序/消息串钉子散布：合并前全量 grep "zai, anthropic" 扫钉子（上一批
  教训：pin-grep 要跨全部测试文件）。
