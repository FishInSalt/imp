# MCP（模型上下文协议）

当你连接外部工具服务器时，读这一篇。编写扩展 → [extensions.md](extensions.md)。

## 快速配置

Ink 通过 **stdio**（`command`）或 **Streamable HTTP**（`url`）从 MCP 服务器
获取工具，因此现有配置无需改动即可使用：

```jsonc
// ~/.config/mcp/mcp.json (or ~/.agents/mcp.json, or <project>/.mcp.json)
{
	"mcpServers": {
		"zai-vision": {
			"command": "npx",
			"args": ["-y", "@z_ai/mcp-server"],
			"env": { "Z_AI_API_KEY": "…" }
		},
		"tushare": {
			// token in the URL — the env placeholder keeps it out of the file
			"url": "https://api.tushare.pro/mcp/token=${TUSHARE_MCP_TOKEN}"
		},
		"github": {
			"url": "https://api.githubcopilot.com/mcp/",
			"headers": { "Authorization": "Bearer ${GITHUB_PAT}" }
		}
	}
}
```

## 配置发现

靠后的文件按服务器覆盖靠前的文件（整条替换）：

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<project>/.mcp.json`
5. `<project>/mcp.json`

两个项目文件是**位于信任门之后的可执行资源**——不受信任的目录会跳过
它们并给出提示（`ink --trust` 可启用）。

值展开：`${VAR}`、`$env:VAR` 和 `{env:VAR}` 占位符在 `command`/`args`/
`env` 以及 `url`/`headers` 中均可使用。`"disabled": true` 会跳过某个
服务器（在 `/mcp` 中可见）。

## 规则与限制

- **服务器键必须小写**：组合工具名必须匹配 `^[a-z][a-z0-9_-]{0,63}$`。
  不匹配的键（`tushareMcp`）注册的工具数为零，而 `/mcp` 仍显示已连接——请
  把它改名（`tushare`）。
- 每个服务器工具都以 `<server>_<tool>` 的形式扁平注册（例如
  `zai-vision_analyze_image`），模型可以像调用内置工具一样调用它。
- `url` 必须是 https（纯 http 仅限回环主机）；从不跟随重定向——token
  可能搭载在 URL 上，跟随重定向可能造成泄露。
- 连接在启动时异步建立（npx 冷启动可能较慢）；在一次运行进行中才连接上
  的工具会在下一个运行边界加入。会话中途终止的服务器会在下一次工具调用
  时透明重连；过期的 HTTP 会话会被重新初始化，该调用会被重试一次。
- `/mcp` 显示各服务器的状态。
- `INK_MCP=0` 或设置中的 `"mcp": {"enabled": false}` 会完全禁用该模块。
  找不到配置 = 零开销：不启动任何进程，不发出任何请求。

## 范围（有意为之）

只支持工具。没有 OAuth（用 PAT 或 URL token 认证），没有 sampling 或
elicitation，没有 resources/prompts 接口，没有逐次调用的审批门，
不导入其他厂商的配置（cursor/claude/windsurf），没有 `mcp` 代理工具
（在拥有 ≥10 个工具的服务器出现之前保持扁平注册）。每一项暂缓事项都在
设计档案中记录了触发条件。
