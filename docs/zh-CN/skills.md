# 技能

技能是模型按需加载的自包含指令包——[Agent Skills](https://agentskills.io) 标准
（与 Claude Code 和 pi 技能形态相同）。只有一行目录条目（名称 + 描述 + 位置）
会进入系统提示；当任务真正匹配时才会读取完整正文。这就是*渐进式披露*：使用之前
零成本。相关页面：[扩展](extensions.md)（代码，不是 markdown）、
[设置](settings.md)（`skills` 键）。

## 目录结构

```
<cwd>/.ink/skills/ledger/SKILL.md     project tier (this repo, trust-gated)
<cwd>/.agents/skills/…                shared tier (this repo, trust-gated;
                                       also found in ancestor dirs up to the
                                       git root)
~/.ink/skills/…                       user tier (all your projects)
~/.agents/skills/…                    user shared tier (all your projects)
--skill path / settings "skills"      explicit tier (always loads)
```

`SKILL.md` = YAML frontmatter + Markdown 正文：

```markdown
---
name: ledger                          # optional; defaults to the directory
description: What the skill does, for whom (required, ≤1024 chars)
disable-model-invocation: false       # true = user-only (/skill:name still works)
---
Body — instructions, optionally referencing files in the same directory.
```

发现规则（与 pi 保持一致）：包含 `SKILL.md` 的目录就是一个技能根——不会再继续
扫描它的子目录（要嵌套技能，把每个 `SKILL.md` 放在各自的叶子目录中）。散放的
`.md` 文件在 `.ink/skills` 根中算作技能，但在 `.agents/skills` 根中不算（在那里
它们按嵌套处理）。名称冲突按先出现者优先解决；通过符号链接产生的重复会被去重。
没有描述的技能会被跳过，并给出警告——模型看到的正是描述，所以它不是可选项。

项目层级的技能只有在 M8 信任门放行该仓库后才会加载（与扩展/agent/命令相同的
规则）。显式路径代表用户意图，总会加载。

## 使用技能

按设计有两种方式：

- **让模型自己决定。** 系统提示末尾有一个 `<available_skills>` 目录；当任务匹配
  某个描述时，模型会用 `read` 工具读取 SKILL.md。无需输入任何内容。
- **强制使用：** `/skill:ledger add an entry for the CI fix`——命令会展开为完整
  正文（其中的引用相对技能目录解析）并开始一轮。对话记录会显示一行
  `▪ skill: ledger (…)` 的回显；会话保存完整内容块，回放时会折叠回这行摘要。

`/help` 会列出已注册的技能，并标注 `[skill]`。在 `~/.ink/settings.json` 中设置
`"enableSkillCommands": false` 可跳过命令注册（目录条目仍保留）。

## CLI

```
ink --skill path/to/SKILL.md     # explicit skill (repeatable)
ink --skill path/to/skills-dir   # scan a tree per the rules above
ink --no-skills                  # skip discovered + settings skills
                                  # (explicit --skill paths still load)
```

设置（`~/.ink/settings.json`）：`"skills": ["/abs/or/~/path", …]`、
`"enableSkillCommands": true|false`。

## 示例

`examples/skills/ledger/`——一个面向 PROJECT_PLAN.md 的记账技能，带
`references/` 子目录，演示配套材料按需读取的模式：

```
cd examples && ink -p --skill skills/ledger "summarize the entry rules"
```
