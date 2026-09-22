# 系统提示自定义(SYSTEM.md / APPEND_SYSTEM.md)设计文档

状态:**已被 `docs/system-md-design.md` 取代**(2026-02-08,经独立设计审查闭环;本稿正确接缝已并入新稿,矛盾判定以新稿为准)

## 0. 背景与目标

提示词优化批(#prompt-audit)记档延后项:用户自定义系统提示。pi 的机制
(`resource-loader.ts:1023` discoverSystemPromptFile / :1033
discoverAppendSystemPromptFile + `system-prompt.ts` 的 customPrompt 分支):

- **整替**:一个文件替换默认系统提示的身份/规则/工具目录部分
- **追加**:一个文件接在主提示之后
- 各自项目文件优先(trust 门控),全局 `~/.pi/agent/` 兜底
- pi 的关键设计:替换不是裸替换——上下文文件/skills/cwd 照常自动附加

本批目标:给 imp 同构能力——`.imp/SYSTEM.md`(整替)与
`.imp/APPEND_SYSTEM.md`(追加),全局 `~/.imp/` 兜底,项目层过 M8 信任门。
非目标:模板变量、多文件合并、`/system` 命令、热重载。

## 1. 判定:采纳 pi 什么、改什么

| 项 | pi | imp 判定 |
|---|---|------|
| 两个文件、整替+追加双槽 | 是 | **采纳**——两个语义都真实:换 persona vs 只加一段 |
| 每槽一个文件,项目优先于全局 | 是 | **采纳**——整替不可叠加(两个"完整提示"无合并语义);项目意图胜全局默认与 imp 现有 tier 惯例一致(commands-md 同款) |
| 项目层 trust 门控 | 是(isProjectTrusted) | **采纳**——克隆仓库不能接管系统提示;复用 M8 的 `projectTrusted` 位(与 agents/settings 同一决定) |
| 替换后仍附加上下文/skills/cwd | 是 | **采纳并加强**:pi 只补一行 cwd;imp 附加完整 `# Environment` 块(cwd/platform/date)——平台事实影响 bash 行为,属机器管理不是 persona,替换不应丢失 |
| 追加文件落位:主提示之后、项目上下文之前 | 是 | **采纳**——用户文本连续,机器块(上下文/skills/agents)在后 |
| 空文件 → 视为无 | 是(resolvePromptInput 空→undefined) | **采纳**,静默跳过 |
| 读失败 → 把路径字符串当提示 | 是(pi 的怪异回退) | **拒绝**——读失败视同缺失+一条 warning note(pi 在此处把路径当 prompt 文本用,明显是缺陷不是设计) |
| BOM 剥离 | 是 | **采纳** |
| 无大小上限 | 是 | **采纳**(用户自己的文件;AGENTS.md 同样无上限) |
| 发现时机:每次 assembleSystem | 是(/new、资源 reload) | **采纳**——imp 的 assembleSystem 在 warmup//new//resume/MCP refresh 跑,天然拾取 |

## 2. 设计

### 2.1 发现与加载(新模块 `src/core/custom-prompt.ts`)

```ts
export interface CustomPromptFile {
	content: string;
	path: string;
	tier: "project" | "global";
}
export interface CustomPrompts {
	system?: CustomPromptFile;
	append?: CustomPromptFile;
	/** Teaching lines (trust-skip / read-failure) — surfaced via renderer.note. */
	notes: string[];
}
export function loadCustomPrompts(args: {
	cwd: string;
	home?: string;            // 默认 os.homedir(),测试注入
	projectAllowed?: boolean; // M8 trust 位;false 时项目层跳过
}): CustomPrompts
```

规则:
- SYSTEM 槽:先 `<cwd>/.imp/SYSTEM.md`(仅当 `projectAllowed`),后
  `~/.imp/SYSTEM.md`;**第一个存在且非空者胜**,另一层不再看
- APPEND 槽同构(`APPEND_SYSTEM.md`),与 SYSTEM 槽**独立**——项目 SYSTEM +
  全局 APPEND 可共存
- 非空 = stripBom 后 trim 非空;空文件静默跳过
- 项目文件存在但 `projectAllowed === false` → note:
  `imp: .imp/SYSTEM.md skipped — this directory is not trusted (review it, then restart with: imp --trust)`
  (与 agents/commands 的门控教学一致)
- 读失败 → note `imp: cannot read ${path} — ignored`,视同缺失
- 文件必须 isFile()(目录遮蔽名不算,`statSync` 判断)

### 2.2 接线(runner)

- `RunnerOptions` 增 `promptsProjectAllowed?: boolean`(cli 由既有
  `projectTrusted` 位传入;与 agentsProjectAllowed 同源不同名,沿用按资源
  命名的惯例)
- `assembleSystem()`:
  1. `const custom = loadCustomPrompts({ cwd, projectAllowed: promptsProjectAllowed })`
  2. 有 `custom.system` → 主体 = 其 content;否则主体 = 默认
     `buildSystemPrompt(context, catalogTools)`
  3. **替换模式下追加 `# Environment` 块**(cwd/platform/date——默认模式它
     在主体头部,替换模式补在主体之后,信息不丢)
  4. `custom.append` → `\n\n# Appended system prompt (${tier}: path)\n\n${content}`
     (段落标题带来源,与 Extension context 的标注风格一致)
  5. 其后照旧:`<project_context>` → 扩展区 → skills → `<advertised_agents>`
  6. notes 逐条 `renderer.note`(仅 `notify=true` 路径——MCP refresh 静默,
     与 context note 同款处理)
- **门控总开关**:`options.noContextFiles === true` 时完全跳过发现(含全局
  层)——该 flag 的语义就是"无本地注入",且测试机上的 `~/.imp/SYSTEM.md`
  不得泄进 hermetic 测试
- `refreshSystemPrompt`/`/new`//resume 语义不变(每次重读文件)

### 2.3 组装后的完整形状(替换模式示例)

```
<用户 SYSTEM.md 全文>

# Environment
- Working directory: /x
- Platform: darwin (arm64), shell: bash
- Date: 2026-09-22

# Appended system prompt (project: /x/.imp/APPEND_SYSTEM.md)
<用户 APPEND_SYSTEM.md 全文>

<project_context>…</project_context>

# Extension context: …
<available_skills>…</available_skills>
<advertised_agents>…</advertised_agents>
```

默认模式形状不变(APPEND 段插在主提示与 project_context 之间)。

## 3. 兼容性

- 无文件时行为与今天逐字节相同(发现函数返回空,组装路径不动)
- MCP refresh 重读文件:与 AGENTS.md 现状一致,无新语义
- print/REPL/TUI 共用 assembleSystem
- session 不存系统提示,无持久化影响

## 4. 测试计划(预计 +9)

custom-prompt 单元(新 test/custom-prompt.test.ts):
1. 项目 SYSTEM 优先于全局(全局不读)
2. 仅全局时用全局
3. `projectAllowed=false` → 项目文件跳过 + note 文案
4. 空文件(仅空白/BOM)→ 视为无,落到下一层
5. 读失败(路径是目录)→ 视为无 + note
6. 两槽独立:项目 SYSTEM + 全局 APPEND 共存
7. `noContextFiles` 门控总开关(runner 集成:system prompt 不含自定义文本)

runner 集成(扩 test/system-prompt.test.ts):
8. 替换模式:主体=文件内容,Environment/skills/catalog 缺席但
   project_context/advertised_agents 仍在
9. 追加模式:默认主体保留,APPEND 段落在主提示后、project_context 前

## 5. 决策记录

- **D1 双槽一文件、项目优先**:整替无合并语义;tier 惯例同 commands-md。
- **D2 替换保留机器块**:Environment(imp 加强,pi 只补 cwd)+
  project_context+扩展+skills+agents 全部照常——用户文件保持纯 persona,
  不必手拼机器管理内容(pi 的核心设计,采纳)。
- **D3 读失败拒绝 pi 的路径当提示回退**,改 note+视同缺失。
- **D4 noContextFiles 总门控**:含全局层,防测试机泄漏。
- **D5 信任位复用 M8 projectTrusted**,RunnerOptions 按资源命名
  `promptsProjectAllowed`。
- **D6 APPEND 段带来源标题**(`# Appended system prompt (tier: path)`),
  与 Extension context 标注一致——多来源文本可追溯。
- **D7 无大小上限、无模板变量、无热重载命令**:记档,触发=用户需要。
