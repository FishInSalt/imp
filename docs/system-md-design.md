# 系统提示整替(SYSTEM.md / APPEND_SYSTEM.md)设计

状态:待独立设计审查

## 0. 背景与目标

prompt-audit 批把系统提示定型为"身份+环境+6 核心规则+工具目录+收尾句"。
但它是一块写死的代码——用户无法定制角色(如"你是我的 Rust 代码评审")
或追加长期指令(如"回答用中文")。pi 有成熟的整替机制,本批按"独立审视
优先"原则移植。

**净目标**:用户提供文件即可替换/追加系统提示主体;替换不掉的是模型运转
必需的四件套(上下文/技能/agent 名单/cwd);项目级文件过 trust 门。

## 1. pi 机制核实(全部亲读源码)

| # | 机制 | pi 坐标 |
|---|------|---------|
| 1 | 两文件两层级:项目 `.pi/SYSTEM.md`、全局 `~/.pi/agent/SYSTEM.md`;APPEND 同构 | resource-loader.ts:1023-1047 |
| 2 | 项目层需 `isProjectTrusted()` 且存在;**每对只取一个**(项目优先,不合并) | 同上 |
| 3 | 读取:stripBom;**读失败→警告并把路径字符串当提示文**(SDK 内联语义的副作用) | resource-loader.ts:54-66 |
| 4 | 空文件→`""`→falsy→回落默认提示 | system-prompt.ts:48 |
| 5 | customPrompt 分支:替换全部默认主体(工具目录/指南全消失),**保留** append→`<project_context>`→skills→cwd 行 | system-prompt.ts:48-73 |
| 6 | 默认分支:appendSection 在主体之后、context/skills 之前 | system-prompt.ts:152-154 |
| 7 | /context 列表把 SYSTEM.md 源+APPEND 源列为 Context 资源 | interactive-mode.ts:1716-1725 |
| 8 | 重组时机:工具集变化即 `_rebuildSystemPrompt`,customPrompt 分支同样参与 | agent-session.ts:1078-1096 |

## 2. 判定表(imp 取舍)

| # | 场景 | 判定 | 依据 |
|---|------|------|------|
| D1 | 两文件两层级、项目优先、每对一个 | **照抄 pi** | 层级语义清晰;合并两层 SYSTEM.md 语义混乱 |
| D2 | 项目层过 trust 门 | **照抄 pi** | M8 既定原则:重定向模型的仓库内容必须门控;且**文件要加进 `trustRequiringResources`**(M15 settings.json 先例:克隆的仓库不能带着 SYSTEM.md 免门进场) |
| D3 | 整替保留四件套:context XML、skills、`<advertised_agents>`、cwd 行 | **照抄 pi 并外延** | pi 保留 context/skills/cwd(亲读核实:customPrompt 分支仍附加);imp 的 agents 块是路由信息(同 skills 性质)故保留。imp 独有扩展 context 区(`# Extension context:`)**也保留**——guardian.mjs 类扩展静默失效是回归 |
| D4 | 整替删掉:身份句、# Environment(除 cwd)、核心规则、工具目录、收尾句 | **照抄 pi** | 整替=作者接管;环境块里平台/日期非必需(自定义作者可自行写) |
| D5 | 读失败:pi 把路径当提示文 | **拒绝,改 warn+穿到全局层** | pi 行为是内联语义副作用,路径字符串成为系统提示是明显缺陷;穿层与 context-files 读失败穿透哲学一致 |
| D6 | 未信任+项目文件存在:pi 静默忽略 | **拒绝,加一行 dim note** | 用户编辑了文件却无声无效是排错黑洞;imp 教学注记哲学(`.imp/SYSTEM.md ignored — directory not trusted (/trust to enable)`),不泄内容 |
| D7 | 空文件/纯空白文件:pi 空串回落、空白串生效 | **收紧:都回落默认** | 纯空白成为生效的自定义提示=用户笔误静默变成空系统提示;按缺席处理 |
| D8 | BOM 剥离 | **照抄 pi** | Windows 编辑器现实 |
| D9 | cwd 行在 custom 分支的位置:pi 放最后(skills 之后) | **变通:放 override+append 之后、runner 追加区之前** | imp 的组装序是 buildSystemPrompt 返回→runner 追加 context/ext/skills/agents;cwd 行留 buildSystemPrompt 内则位置在前。位置是外观差异,内容一致;避免为排序把 cwd 行拆到 runner |
| D10 | refreshSystemPrompt(MCP 目录重组)在整替模式 | **保留,自然降级** | 整替模式无目录可刷新,重组结果=重读文件;文件中途被编辑的语义与 context 文件一致(每次组装重读) |

## 3. 设计

### 3.1 新模块 `src/core/system-prompt-files.ts`

```ts
export interface SystemPromptOverride {
  override?: { text: string; path: string };
  append?: { text: string; path: string };
  ignoredUntrusted: string[];  // 存在但未信任的项目文件相对路径
}
export function loadSystemPromptFiles(cwd: string, home = os.homedir()): SystemPromptOverride
```

- 每对依次探:项目 `.imp/SYSTEM.md`(需 `nearestTrustEntry(readTrustFile(...), cwd)?.trusted === true` 且存在)→ 全局 `~/.imp/SYSTEM.md`;APPEND 同构
- 单对内穿透:项目层"存在但读失败"(如目录遮蔽)→ 警告进 `ignoredUntrusted`?**不**——读失败与未信任分开:读失败继续试全局层(不产生 note,与 context-files 穿透一致);未信任才进 `ignoredUntrusted`
- 内容 stripBom+trim;trim 后空 → 该层缺席
- 纯函数风格与 context-files 对齐(home 参数可注入,便于测试)

### 3.2 `buildSystemPrompt` 增参(不破坏现有签名)

```ts
buildSystemPrompt(context, tools, opts?: { override?: string; append?: string })
```

- override 分支:`override` + (append?`\n\n`+append) + `\n\nCurrent working directory: ${cwd}`,直接 return——不产 # Environment/核心规则/目录
- 默认分支:主体 + (append?`\n\n`+append),与 pi 的"append 在 context 之前"相对序一致(runner 的 context 追加在 buildSystemPrompt 返回值之后)
- 现有调用(不传 opts)行为不变——测试零波及

### 3.3 runner 组装序(notify 语义不变)

```
assembleSystem(notify=true):
  sp = loadSystemPromptFiles(cwd)                    // 新
  buildSystemPrompt(ctx, catalogTools, { override: sp.override?.text, append: sp.append?.text })
  → context XML(照旧追加)
  → extension sections(照旧)
  → skills(照旧)
  → <advertised_agents>(照旧)
  notify 时:
    ▪ context: …(照旧)
    ▪ system: .imp/SYSTEM.md + (· +APPEND_SYSTEM.md)   // 新,有 override 或 append 时
    ▪ .imp/SYSTEM.md ignored — not trusted (/trust)    // 新,ignoredUntrusted 非空时
```

- `noContextFiles` 选项**不**门控 SYSTEM.md(两者语义不同:前者是测试隔离 context 文件的开关);文档记明
- /new、/resume、refresh 走同一 assembleSystem,自动一致

### 3.4 trust 资源清单

`trustRequiringResources` 增加 `.imp/SYSTEM.md`、`.imp/APPEND_SYSTEM.md`(文件级判存在,同 settings.json 先例)。

### 3.5 子代理

不变:子代理系统=父系统文本+CHILD_SUFFIX,整替自动传播(与 pi-subagents 语义一致:广告块/继承都来自父)。

## 4. 测试计划(约 +17)

- 发现:项目信任优先/未信任穿全局+记 ignored/仅全局/两者皆无/空与纯空白回落/BOM 剥离/读失败(目录遮蔽)穿全局
- 组成:override 分支无核心规则无目录有 cwd 行/append 紧随 override/无 override 有 append=默认主体+append 且在 context 前/不传 opts 完全不变(既有测试即钉)
- 集成:runner 整替后 context XML+skills+agents 块仍在(D3 四件套)/扩展 context 区存活/untrusted note 与 system note 文案/trustRequiringResources 认两个新文件
- 边界:refresh 在整替模式下重组不报错且无目录/子代理继承含 override 文本

## 5. 延后与不做

- **不做**:`--system-prompt` CLI 旗标与内联字符串(pi 的 SDK 面;imp 无 SDK 层需求)
- **不做**:多 APPEND 文件合并(pi loader 的 string[] 面向 SDK,发现层每对一个)
- **延后**:系统提示热重载观察(file watcher);/context 命令(imp 尚无该命令,启动 note 已覆盖可见性)

## 6. 规模

src 3 文件约 +130 行(新模块 ~80、system-prompt ~25、runner+trust ~30);测试 +17/改 0。README 增一段用法。
