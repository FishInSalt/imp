<p align="center">
  <a href="https://www.npmjs.com/package/ink-agent"><img alt="npm" src="https://img.shields.io/npm/v/ink-agent?style=flat-square" /></a>
  <a href="https://github.com/FishInSalt/ink/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://github.com/FishInSalt/ink/releases"><img alt="releases" src="https://img.shields.io/github/v/release/FishInSalt/ink?style=flat-square" /></a>
</p>

# Ink

[English](README.md) | **简体中文**

一个开源的终端 AI 助手与 agent 运行框架。可以用 Ink 做研究、写作、分析、软件开发，
以及其他需要工具辅助的任务。从零构建，设计灵感来自
[pi](https://github.com/earendil-works/pi)。

让 Ink 适应你的工作流，而不是反过来：通过[扩展](docs/extensions.md)、
[技能](docs/skills.md)、[具名子代理](docs/subagents.md)和
[MCP 服务器](docs/mcp.md)来扩展它——内置的
[示例](examples/README.md)（扩展、子代理、技能各一）展示了用法。

## 快速开始

在你希望它工作的目录里安装并运行：

```bash
npm install -g ink-agent@latest
cd /path/to/project
ink
```

用非交互方式验证安装是否成功：`ink --version`（输出 `Ink <版本号>`）或
`ink --help`；脚本化的一次性调用用 `ink -p "问题"`，打印答案后退出。
npm 包安装时不运行任何生命周期脚本。卸载用 `npm uninstall -g ink-agent`。

也可以让 npm 从明确的包名推断出唯一的 `ink` 可执行文件：

```bash
npm exec -- ink-agent@latest --help
```

不要用 `npx ink`：名为 `ink` 的那个 npm 包与本项目无关。没有 `imp` 这个
可执行别名。要求 Node 22.19.0 或更新版本（与固定的 TUI 依赖一致）。

然后用 API key 登录：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

或者在会话内用 `/login`（含 ChatGPT 套餐的 OAuth 登录）。接着给 Ink 一个任务。
完整的入门介绍请从[文档](docs/index.md)的主题地图开始。

从源码检出运行：

```bash
npm install   # 安装依赖并构建（prepare 脚本）
npm start     # 启动交互式 REPL
```

更新源码检出时，不要复制凭据、迁移状态或发布；正常安装请用上面的 npm 包。
Ink 只读取 `~/.ink` 和 `INK_*` 配置，从不触碰历史的 `.imp` 状态——
见 [docs/cli.md](docs/cli.md)。

## 内部构成

一个带交互终端界面、持久会话和可扩展工具的完整助手：

- 交互式 TUI（流式输出、单行工具状态、排队的转向指令和后续追问），外加
  打印模式（`ink -p "..."`）和管道 stdin 输入
- Agent 循环：流式 LLM 调用 + 工具执行，支持中断、参数校验、错误反馈、
  转向钩子和压缩钩子
- 会话：仅追加的 JSONL 消息树（`~/.ink/sessions/`），`--continue` /
  `--resume <id>` / `ink sessions`，`/tree` 导航器，`/fork` 分叉
- 自动压缩：接近上下文窗口时，较早的对话轮次会被 LLM 摘要成一个检查点；
  最近的轮次和磁盘上的完整历史都会保留
- 工具：`bash`（超时、截断）、`read`（offset/limit、图片）、`edit`
  （精确匹配的多处编辑）、`write`、`grep`（ripgrep）、`find`（fd）、`ls`、
  `task`（子代理）——搜索工具遵循 .gitignore
- 提供商：Anthropic、OpenAI（API key 或 ChatGPT 套餐 OAuth）、智谱 Z.AI（GLM）、
  DeepSeek、月之暗面 Kimi（国际与国内端点）——凭据来自环境变量或 `/login`
- 扩展、技能、具名子代理、MCP 服务器、markdown 快捷命令，以及自定义系统提示
  （SYSTEM.md）

路线图和历史实现台账在 `PROJECT_PLAN.md`；每个功能的设计文档与评审记录在
[docs/design/](docs/design/)（不随 npm 包发布）。

## 一屏看完交互模式

不带参数运行 `ink`，进入围绕同一份会话与共享对话的交互界面。普通行发送给
模型；Ink 工作期间输入的行会排队（回车以 `steer:` 发送、alt+回车以
`follow-up:` 发送——alt+上箭头可以找回它们）。Ctrl+C 中断当前轮次（按两次
退出）；Ctrl+D 退出；Ctrl+O 展开所有折叠；Ctrl+L 打开模型选择器；
Shift+Tab 切换思考档位；Ctrl+T 隐藏推理轨迹。

斜杠命令：`/help`、`/exit`、`/new`、`/fork <n>`、`/tree`、`/sessions`、
`/resume <id>`、`/model [id]`、`/think [level]`、`/compact`、`/status`、
`/copy`、`/name`、`/trust`、`/worktrees`、`/login`、`/logout`、`/mcp`、
`/settings`。未知命令会得到提示而不是发给模型；行首加一个空格可发送字面
斜杠开头的文本。细节见 [sessions.md](docs/sessions.md)。

alt 系列快捷键的终端说明：iTerm2、Ghostty、Kitty 和较新的 VS Code 终端
开箱即用。WezTerm 默认把 Option+回车绑成全屏，Alacritty 可能发送普通
回车——把它们映射为 `\x1b[13;3u`，或改用 esc+p。

## 文档

完整文档在 [docs/index.md](docs/index.md)——主题地图从这里开始：

- [CLI 参考](docs/cli.md)——安装、打印模式、管道、全部命令行参数与环境变量
- [提供商与模型](docs/providers.md)——登录、模型家族、`/model`、pi.dev
  模型目录
- [会话](docs/sessions.md)——JSONL 树、`/tree`、`/fork`、压缩、转向与
  后续追问
- [设置](docs/settings.md)——settings.json 的键、SYSTEM.md、markdown
  快捷命令
- [扩展](docs/extensions.md)——工具、命令、事件门控、配色、内置示例
- [技能](docs/skills.md)——SKILL.md 包、发现层级
- [MCP](docs/mcp.md)——stdio 与 Streamable HTTP 服务器、配置发现
- [子代理](docs/subagents.md)——`task` 工具、具名代理、worktree 隔离
- [图片](docs/images.md)——视觉模型、粘贴、缩放阶梯

npm 包会随包发布这些文档；agent 会把自己的问题路由到文档里。内置的
[示例](examples/README.md)——扩展、一个具名子代理、一个技能——随包安装。

## 平台支持

- **macOS**——开发平台；功能最先在这里验证。
- **Linux**——支持：CI 在 `ubuntu-latest` 上跑完整门禁（typecheck、lint、
  build、测试），覆盖精确的 Node 22.19.0 下限和 Node 24。CI 强制安装
  `rg` 和 `fd`，搜索工具测试无法静默跳过。
- **Windows**——暂不支持。原生 Windows 存在已知阻塞（`bash` 工具固定
  启动 `/bin/bash`；MCP 服务器启动时缺少 `.cmd` / shell 解析）且没有 CI
  覆盖。WSL 可用——在 WSL 里 Ink 就是普通的 Linux 程序。

外部工具是可选的且依平台而定：`rg` / `fd` 支撑 `grep` / `find` 工具
（缺失时给出安装提示；Ink 其余功能不受影响）；剪贴板图片粘贴在 macOS 用
`osascript`，在 Linux 用 `wl-paste` / `xclip`。

## 开发

```bash
npm run build          # tsc
npm run dev            # tsx src/cli.ts（不构建）
npm run typecheck      # tsc --noEmit（两份配置）
npm run lint           # biome + 脚本语法检查
npm test               # vitest run
```

设计档案：每个功能的设计文档与评审记录在 [docs/design/](docs/design/)
（不随 npm 包发布）。[RELEASING.md](RELEASING.md) 记录发布流程。仓库曾从
`FishInSalt/imp` 改名而来；GitHub 会重定向旧 URL，历史发布与设计记录保留
原名。

## 许可

[MIT](LICENSE)
