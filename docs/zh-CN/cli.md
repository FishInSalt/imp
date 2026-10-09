# CLI

当你想从 shell 运行 Ink 时读这篇：安装、打印模式、管道、附件、会话，以及全部
命令行参数。交互模式的细节（树、分叉）见[会话](sessions.md)——本页讲的是命令行。

## 安装

```bash
npm install -g ink-agent@latest
ink
```

或者不安装直接运行：`npm exec -- ink-agent@latest --help`。
不要使用 `npx ink`——`ink` 是一个无关的 npm 包。也不存在 `imp` 可执行文件别名。

需要 Node 22.19.0 或更高版本。从源码检出运行：`npm install`（通过 prepare
脚本构建），用 `npm start` 启动。registry 上的包本身不运行任何安装生命周期脚本
（`prepare` 构建脚本只在 git 克隆和本地链接时运行）。

用非交互方式验证安装：

```bash
ink --version    # prints "Ink <version>"
ink --help       # flag reference, exits 0
```

卸载：`npm uninstall -g ink-agent`。如果全局安装因 EACCES 失败，说明 npm 的
prefix 不是当前用户可写的——不要在命令前加 sudo；把 npm 指向用户自己拥有的
prefix（先运行 `npm config get prefix`，再按 npm 文档修复权限），然后重试。
给脚本化运行的提示：Ink 在不受信任的目录中会拒绝加载 `.ink/` 项目配置
（默认安全）；可以用 `ink --trust` 预先批准，每个项目一次。

用 `/login` 登录——提供商选择器会把 API key 存到 `~/.ink/auth.json`（0600），
优先于环境变量；ChatGPT 套餐通过 OAuth 设备码登录。或者在启动前设置环境变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

各提供商的专门配置：[提供商](providers.md)。

## 调用方式

```bash
ink -p "<prompt>"        # print mode: stream the response, then exit
ink "<prompt>"           # same as -p
ink @file.png "prompt"   # attach files: text embeds as <file> blocks,
                         # images attach to the first message
ink                      # interactive session (REPL)
echo "fix the typo" | ink   # piped: one turn, exits at EOF (empty pipe: help + exit 1)
```

打印/管道运行默认 `--max-turns 100`；交互式 TTY 会话不设上限（显式传入有限值时
才会生效）。

## 选项

| 参数 | 说明 |
|---|---|
| `-p`, `--print <prompt>` | 要运行的提示词，随后退出 |
| `-m`, `--model <id>` | 模型 id（默认：`$INK_MODEL` 或 `claude-sonnet-4-5`） |
| `--thinking <level>` | `off` `minimal` `low` `medium` `high` `xhigh` `max` |
| `--max-tokens <n>` | 每轮最大输出 token 数（默认：模型目录上限） |
| `--max-turns <n>` | 每次运行的最大 agent 轮数 |
| `-nc`, `--no-context-files` | 跳过 AGENTS.md 发现 |
| `-c`, `--continue` | 继续本目录中最近的会话 |
| `-r`, `--resume <id>` | 按 id 恢复会话（可用前缀） |
| `--no-session` | 不持久化本次运行（同时禁用自动压缩） |
| `-e`, `--extension <path>` | 加载一个扩展（文件或目录；可重复；无论信任状态如何都会加载） |
| `-ne`, `--no-extensions` | 跳过扩展发现（显式 `-e` 仍会加载） |
| `--skill <path>` | 加载一个技能（.md 文件或目录；可重复；即使有 `--no-skills` 也会加载） |
| `--no-skills` | 跳过技能发现（用户 + 项目 + 设置） |
| `--trust` / `--no-trust` | 为本目录的 `.ink/` 资源记录信任决定 |
| `-h`, `--help` / `-v`, `--version` | 帮助 / 版本 |

## 子命令

| 命令 | 说明 |
|---|---|
| `ink sessions` | 列出本目录保存的会话 |
| `ink login` | OpenAI（ChatGPT 套餐）设备码 OAuth |
| `ink logout` | 移除存储的 ChatGPT 套餐凭据（`/login` 保存的 key 保留） |

## 环境变量

| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Anthropic key / Bearer token |
| `ANTHROPIC_BASE_URL` | 覆盖 Anthropic 兼容服务的端点 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI key / 端点覆盖（任何 OpenAI 兼容服务） |
| `ZAI_API_KEY` | Z.ai key（GLM Coding Plan） |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `MOONSHOT_API_KEY` | Moonshot/Kimi key（两个家族） |
| `INK_MODEL` | 默认模型 id |
| `INK_THINKING` | 默认思考档位（无效值：提示并忽略） |
| `INK_CONTEXT_WINDOW` | 自动压缩用的上下文窗口（默认 131072） |
| `INK_AUTOCOMPACT=0` | 禁用自动压缩 |
| `INK_MCP=0` | 完全禁用 MCP 模块 |
| `INK_HEALTH=0` | 禁用循环健康监控 |
| `INK_BRANCH_SUMMARY=0` | 禁用分支摘要（强制关闭） |
| `INK_CHILD_SESSIONS=0` | 不持久化子代理的对话记录 |
| `INK_CATALOG_BASE_URL` / `INK_CATALOG_PATH` | 重定向 / 迁移模型目录 |
| `INK_SETTINGS_PATH` | 覆盖设置文件路径 |

`INK_*` 开关变量用 `0` 表示禁用，其他任何值都表示启用。

## 从 imp 更名

Ink 只读取 `~/.ink`、项目 `.ink/` 和 `INK_*`。它不会迁移 `.imp` 状态或 `IMP_*`
设置；旧会话留在 `.imp` 中，无法恢复。标准的 `AGENTS.md`、`.agents/skills` 和
MCP 配置文件名保持不变。旧的 `FishInSalt/imp` GitHub URL 会重定向到
`FishInSalt/ink`。
