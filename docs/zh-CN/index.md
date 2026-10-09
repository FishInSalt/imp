# Ink

先读这一篇：它把每个问题映射到给出答案的页面。

Ink 是一个开源的终端 AI 助手与 agent 运行框架。代码仓库是
[FishInSalt/ink](https://github.com/FishInSalt/ink)；npm 包是 `ink-agent`。
安装方式和完整选项参考见 [cli.md](cli.md)。

## 你想做什么？

- 快速上手、登录、选择模型 → [providers.md](providers.md)
- 运行 Ink、打印模式、管道、附加文件、全部参数 → [cli.md](cli.md)
- 理解会话、恢复、分叉、消息树、压缩 → [sessions.md](sessions.md)
- 配置默认值（启动模型、队列模式、图片、MCP） → [settings.md](settings.md)
- 编写扩展（工具、命令、事件、门控） → [extensions.md](extensions.md)
- 使用技能（SKILL.md 包） → [skills.md](skills.md)
- 连接 MCP 服务器（stdio 或 HTTP） → [mcp.md](mcp.md)
- 把工作委派给子代理，使用 worktree 隔离 → [subagents.md](subagents.md)
- 处理图片（视觉模型、粘贴、缩放） → [images.md](images.md)

## 核心概念，各用一段话

- **会话**——`~/.ink/sessions/` 下仅追加的 JSONL 消息树，按工作目录组织。
  每一轮都会保留；`/tree` 导航整棵树；`/fork` 将其分叉。见
  [sessions.md](sessions.md)。
- **技能**——自包含的指令包（SKILL.md），由模型按需加载。系统提示中只有
  一行目录条目。见 [skills.md](skills.md)。
- **扩展**——一个普通的 ESM 模块，注册工具、斜杠命令、系统提示段落、
  事件处理器或工具名配色。见 [extensions.md](extensions.md)。
- **子代理**——在 `task` 工具内发起的一次全新 agent 运行，拥有自己的
  上下文窗口；可以选择隔离在 git worktree 上。见
  [subagents.md](subagents.md)。
- **MCP**——基于 stdio 或 Streamable HTTP 的外部工具服务器；工具以
  `<server>_<tool>` 的形式平铺注册。见 [mcp.md](mcp.md)。
- **模型目录**——从公开的 `pi.dev` 目录服务获取的模型元数据（上下文窗口、
  费用、思考阶梯、视觉能力），配有离线安全的磁盘缓存。见
  [providers.md](providers.md)。

## 项目信任

可执行或会影响模型的项目资源——`.ink/extensions/`、`.ink/agents/`、
`.ink/commands/`、`.ink/settings.json`、项目技能、`.ink/SYSTEM.md` 以及
项目 MCP 文件——只有在你信任该目录后才会加载（`ink --trust`，或只询问
一次的提示）。克隆来的仓库不应长出能与模型对话的代码。`/trust` 显示
已记录的决策。

## 平台支持

macOS（开发平台）和 Linux（完整 CI 门禁）。Windows 暂不支持——请使用
WSL。可选的外部工具：`rg` / `fd` 支撑 `grep` / `find` 工具；剪贴板图片
粘贴在 macOS 使用 `osascript`，在 Linux 使用 `wl-paste` / `xclip`。
