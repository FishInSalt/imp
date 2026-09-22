# 系统提示整替(SYSTEM.md / APPEND_SYSTEM.md)设计

状态:已实现(设计审查闭环后用户批准;实现审查再闭环,见 §6.7;测试 1052→1075);**本稿取代 `docs/custom-system-prompt-design.md`**(同题旧草案,其正确接缝已并入,见 D 表与 §6.5 P2-1)

## 0. 背景与目标

prompt-audit 批把系统提示定型为"身份+环境+6 核心规则+工具目录+收尾句"。
但它是一块写死的代码——用户无法定制角色(如"你是我的 Rust 代码评审")
或追加长期指令(如"回答用中文")。pi 有成熟的整替机制,本批按"独立审视
优先"原则移植。

**净目标**:用户提供文件即可替换/追加系统提示主体;替换不掉的是模型运转
必需的四件套(上下文/技能/agent 名单/cwd);项目级文件过 trust 门。

## 1. pi 机制核实(全部亲读源码;审查逐行复核确认)

| # | 机制 | pi 坐标 |
|---|------|---------|
| 1 | 两文件两层级:项目 `.pi/SYSTEM.md`、全局 `~/.pi/agent/SYSTEM.md`;APPEND 同构 | resource-loader.ts:1023-1049 |
| 2 | 项目层需 `isProjectTrusted()` 且存在;**每对只取一个**(项目优先,不合并) | 同上(:1025、:1039) |
| 3 | 读取:stripBom;**读失败→警告并把路径字符串当提示文**(SDK 内联语义的副作用) | resource-loader.ts:53-68 |
| 4 | 空文件→`""`→falsy→**回落默认提示,该对槽位已占**(全局不再被咨询);pi 无 trim,空白串会生效 | system-prompt.ts:48 |
| 5 | customPrompt 分支:替换全部默认主体,保留 append→`<project_context>`→skills(**条件:存在 read/bash 工具**,imp 恒有 read,恒成立)→cwd 行 | system-prompt.ts:48-73 |
| 6 | 默认分支:append 在主体之后、context/skills 之前 | system-prompt.ts:146-165 |
| 7 | /context 列表把 SYSTEM/APPEND 源列为 Context 资源 | interactive-mode.ts:1716-1725 |
| 8 | 工具集变化即 `_rebuildSystemPrompt`,customPrompt 分支同样参与 | agent-session.ts:1061-1098 |

## 2. 判定表(imp 取舍;含对旧稿的显式取代)

| # | 场景 | 判定 | 依据 |
|---|------|------|------|
| D1 | 两文件两层级、项目优先、每对一个 | **照抄 pi** | 层级语义清晰;合并两层 SYSTEM.md 语义混乱 |
| D2 | 项目层过 trust 门;文件进 `trustRequiringResources`;**判定用会话内已解析的布尔,不重读 trust 库** | **照抄 pi+接缝修正(§6.5 P1-1)** | M8 原则:重定向模型的仓库内容必须门控。trust 语义以 `resolveProjectTrust` 的返回值为准——"仅本会话信任"返回 true 但不落库,加载器自行重读库会把用户刚授予的信任丢掉(cli.ts:734);`projectSettingsAllowed`/`agentsProjectAllowed` 均为此模式,新增 `systemPromptProjectAllowed?: boolean` 同构 |
| D3 | 整替保留四件套:context XML、skills、`<advertised_agents>`、cwd 行;**扩展 context 区(`# Extension context:`)也保留** | **照抄 pi 并外延** | pi 保留 context/skills/cwd(§1#5);imp 的 agents 块是路由信息(同 skills 性质);扩展 context 区是 runner 追加区的一部分,guardian.mjs 类扩展静默失效是回归 |
| D4 | 整替删掉:身份句、# Environment(除 cwd 行)、核心规则、工具目录、收尾句 | **照抄 pi;显式驳回旧稿"保留 # Environment"论** | 旧稿理由是"平台事实影响 bash 行为"——但平台/架构可由模型一次 `bash uname -m` 按需获得,不是不可发现事实;cwd 是唯一必须钉死的机器事实(工作区边界规则与全部路径解析依赖它)。整替=作者接管,pi 同判 |
| D5 | 读失败:pi 把路径当提示文 | **拒绝,改 warn+穿到全局层** | pi 行为是内联语义副作用,路径字符串成为系统提示是缺陷;穿层与 context-files 读失败穿透哲学一致 |
| D6 | 未信任+项目文件存在 | **加 dim note,但仅当全局层接管时**;文案指向 `imp --trust` | 修复两处:① `/trust` 只读不授权(commands.ts:1262-1289),恢复指引必须是 `imp --trust`(仓库既有教学行同款);② 启动时信任决议已有一行消息(`▪ trust: … skipping …`),再报"ignored"是复读——只有"全局文件接管了、项目文件被无视"才是真正意外的情况(用户会奇怪为什么生效的是全局内容) |
| D7 | 空文件/纯空白文件(已信任、可读) | **该对槽位已占→默认提示,不穿全局** | 修正自审查 P2-4:pi 即此语义(§1#4),context-files 的"空文件占位"同判(`context-files.ts:76-77` 有意为之);否则笔误空文件会静默让全局 persona 接管,比回落默认更意外。注意:未信任时不读内容,直接记 ignored(不因"可能是空文件"而免记——门控先于窥视) |
| D8 | BOM 剥离;发现与 trust 清单均用 `statSync().isFile()` 判存在 | **照抄 pi+收紧(§6.5 P3-1)** | 目录遮蔽 `.imp/SYSTEM.md` 时 existsSync 为真:trust 清单会虚报、加载器会走读失败;isFile 双处堵住(pi 的 context 加载器同款守卫) |
| D9 | cwd 行在 custom 分支的位置:pi 放最后 | **变通:放 override+append 之后、runner 追加区之前;来源钉 `options.cwd`** | imp 组装序是 buildSystemPrompt 返回→runner 追加 context/ext/skills/agents;cwd 行留 buildSystemPrompt 内则位置在前,外观差异内容一致。来源必须钉 options.cwd 而非 `defaultSystemPromptContext()` 的 process.cwd()(§6.5 P2-5:整替模式下它是唯一存活的机器事实,多 cwd/worktree 调用时不可错) |
| D10 | refreshSystemPrompt 在整替模式 | **保留,自然降级** | 无目录可刷新→重组=重读文件;文件中途被编辑的语义与 context 文件一致。会话库不持久化系统提示(/resume 重组),无新增不一致 |

## 3. 设计

### 3.1 新模块 `src/core/system-prompt-files.ts`

```ts
export interface SystemPromptOverride {
  override?: { text: string; path: string };
  append?: { text: string; path: string };
  ignoredUntrusted?: { path: string; supersededByGlobal: boolean };
}
export function loadSystemPromptFiles(
  cwd: string,
  projectAllowed: boolean,        // 会话解析布尔(D2),非重读库
  home = os.homedir(),
): SystemPromptOverride
```

- 每对依次探:项目 `.imp/SYSTEM.md`(`projectAllowed` && `isFile`)→ 全局 `~/.imp/SYSTEM.md`(isFile);APPEND 同构
- 未信任+项目文件存在:记 `ignoredUntrusted`(不读内容);`supersededByGlobal` = 全局层是否接管
- 已信任读失败(目录遮蔽外的 IO 错误):穿到全局层(与 D5 一致)
- 内容 stripBom+trim;trim 后空 → **该对缺席**(D7:不再穿全局)
- 纯函数风格与 context-files 对齐(home 可注入)

### 3.2 `buildSystemPrompt` 增参(不破坏现有签名)

```ts
buildSystemPrompt(context, tools, opts?: { override?: string; append?: string })
```

- override 分支:`override` + (append?`\n\n`+append) + `\n\nCurrent working directory: ${context.cwd}`,直接 return
- 默认分支:主体 + (append?`\n\n`+append)(相对序与 pi 一致:append 在 context 之前,context 由 runner 追加)
- 不传 opts 行为不变——既有单测零波及

### 3.3 runner 接线(组装序不变;两个新 RunnerOptions 接缝)

- `systemPromptProjectAllowed?: boolean`(D2):cli 在 `resolveProjectTrust` 之后传入(REPL :484 与 print :780 两处调用点都已先解析)
- `systemPromptHomeDir?: string`(默认 `os.homedir()`)(§6.5 P1-2):**测试密闭性**——开发机上真实的 `~/.imp/SYSTEM.md`(合法用户配置)会整替掉系统提示,`test/system-prompt.test.ts` 的 runner 集成断言(`# Available tools`、`- bash:`)随之机器相关;沿 `settingsPath`/`agentsHomeDir`/`sessionBaseDir` 先例注入临时 home
- `assembleSystem` 内:cwd 上下文钉 `options.cwd`(D9);其余追加区(context/ext/skills/agents)不动
- notify 时新 note:
  - `▪ system: .imp/SYSTEM.md`(override 或 append 生效;append-only 也报,路径相对化)
  - `▪ global SYSTEM.md active — project .imp/SYSTEM.md ignored (imp --trust to enable)`(仅 `supersededByGlobal` 时,D6)
- `noContextFiles` 不门控本特性(语义不同:前者是测试隔离 context 文件的开关);密闭性由 home 接缝承担

### 3.4 trust 资源清单

`trustRequiringResources` 增 `.imp/SYSTEM.md`、`.imp/APPEND_SYSTEM.md`(isFile 判存在,settings.json 文件级先例)。

### 3.5 子代理

不变:子代理系统=父系统文本+CHILD_SUFFIX,整替自动传播。

## 4. 测试计划(约 +23)

- 发现:项目信任优先/未信任记 ignored+不窥内容/仅全局/两者皆无/**空与纯空白=槽位占住不穿全局(D7)**/BOM 剥离/读失败穿全局/**目录遮蔽不算存在(D8,isFile)**/**未信任+全局接管→supersededByGlobal**
- 组成:override 分支无核心规则无目录有 cwd 行/append 紧随 override/无 override 有 append=默认主体+append 在 context 前/不传 opts 完全不变
- 集成:整替后 context XML+skills+agents+扩展 context 区仍在(D3 四件套)/`systemPromptHomeDir` 密闭(临时 home 无泄漏)/cwd 行= options.cwd(D9)
- trust 流:**会话信任("session" 不落库)仍加载项目文件(P1-1 钉)**/--trust 与 --no-trust 旗标路径/note 文案钉(system:/supersededByGlobal 两句)/trustRequiringResources 认两个新文件
- D10:**会话中途编辑文件→refreshSystemPrompt 后 runner.system 变化**/整替模式重组无目录不报错

## 5. 延后与不做

- **不做**:`--system-prompt` CLI 旗标与内联字符串(pi 的 SDK 面)
- **不做**:多 APPEND 文件合并(pi loader 的 string[] 面向 SDK)
- **延后**:file watcher 热重载;/context 命令(启动 note 已覆盖可见性)

## 6. 规模

src 4 文件约 +160 行(新模块 ~85、system-prompt ~25、runner+cli 接线 ~35、trust ~15);测试 +23/改 0。README 增一段用法。旧稿 `docs/custom-system-prompt-design.md` 头部标注被本稿取代。

## 6.5 设计审查记录(needs-fixes 全采纳)

- **P1-1(信任接缝)**:原稿 §3.1 让加载器重读 trust 库——"仅本会话信任"返回 true 不落库,用户刚授权就被丢弃且紧随"not trusted"注记自相矛盾。修正:会话解析布尔经新 `systemPromptProjectAllowed` 接缝传入(D2)。核实:cli.ts:734 session 分支 return true 无落库;`projectSettingsAllowed`/`agentsProjectAllowed` 同模式先例。
- **P1-2(测试密闭性)**:原稿无 runner 级 home 接缝——开发机真实 `~/.imp/SYSTEM.md` 会破坏 imp 自身测试套件("测试零波及"仅单测层成立;整替是破坏性变更,与 context 文件的可加性泄漏不同)。修正:`systemPromptHomeDir` 接缝+测试注入(D10/§3.3);"测试 +17/改 0"主张撤回,改 +23。
- **P2-1(双稿并存)**:仓库存在同题旧草案 `docs/custom-system-prompt-design.md`(prompt-audit 批延后项的草稿,从未送审),与原稿 5 处矛盾且互不引用。处置:本稿头部声明取代;其正确判定(信任布尔接缝、密闭性)已并入;其错误判定(`/trust` 指引、append 加标签头、noContextFiles 总门控)不采纳;D4 显式驳回其"保留 # Environment"论(见 D 表)。旧稿头部加被取代标注。
- **P2-2(恢复指引错误)**:`/trust` 只读不授权(commands.ts:1262-1289),D6 文案改指 `imp --trust`(与 cli.ts print 模式 stderr、commands.ts:450 既有教学行一致)。
- **P2-3(注记复读)**:启动时信任决议已有一行消息;ignored 注记仅当 `supersededByGlobal`(全局接管才是意外情形)。
- **P2-4(空文件语义)**:原稿"空→穿全局"偏离 pi(槽位已占)与 context-files 先例(空文件占位);修正为 D7 现判。未信任时不窥内容直接记 ignored(门控先于窥视,P3-2 一并解决)。
- **P2-5(cwd 来源)**:钉 `options.cwd`,不用 `defaultSystemPromptContext()` 的 process.cwd()。
- **P3-1(isFile)**:发现与 trust 清单双处 `statSync().isFile()`(目录遮蔽不算存在)。
- **P3-3/P3-4**:测试计划 +6 例(会话信任/密闭/旗标/refresh 实效/文案钉);规模更新 +160 行。

verdict 摘录:"§1 fact-base itself is accurate — all eight rows confirmed";needs-fixes 集中在接缝(信任布尔、home 密闭)与双稿并存,均已落入。

## 6.7 实现审查记录(`801830c` 后,同日)

判 needs-fixes(1 P1+2 P2+4 P3),无组装/信任语义缺陷;D1-D10+§6.5 逐项核实落实(D5 半实现、P1-2 半落实除外)。全部亲自核实后修复:
- **P1(密闭性回归)**:两个既有 runner 测试未注 `systemPromptHomeDir`,真实 `~/.imp/SYSTEM.md` 会让套件机器相关(恰是 §6.5 P1-2 要防的场景,新接缝加了旧测试没配)。修复升级为**全局 HOME 沙箱**(settings-setup.ts 先例):`process.env.HOME` 指向临时目录,os.homedir() 在 POSIX 解析 $HOME——修一类而非两个点,skills/task-tool/mcp-wiring 等所有 runner 测试免费继承隔离。
- **P2(D6 混对文案失实)**:ignored/superseded 旗标跨两对共享+文案硬编码 SYSTEM.md——SYSTEM 未信任+全局 APPEND 接管时会打出"global system prompt active"却无全局 persona 生效。修复:逐对追踪(`ignoredUntrusted/supersededByGlobal/unreadableProject` 三数组),每条 superseded 注记点名真实文件。
- **P2(D5 的 warn 半边未实现)**:已信任但不可读的项目文件静默穿层。修复:`unreadableProject` 数组+`▪ could not read … — skipped` 注记。
- **P3×4**:`override: ""` 改真值判断(与 D7 对齐);chmod 测试加 win32/root 守卫;补 mixed-pair/APPEND slot/unreadable 注记钉(+5 测试,总 +18→+23 与 §4 对齐);README 幸存清单补扩展 context 区。

测试 1052→1075(+23,与 §4 计划一致)。
