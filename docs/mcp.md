# MCP (Model Context Protocol)

Read this when you connect external tool servers. Writing extensions →
[extensions.md](extensions.md).

## Quick setup

Ink consumes tools from MCP servers over **stdio** (`command`) or
**Streamable HTTP** (`url`), so existing setups work unchanged:

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

## Config discovery

Later files override earlier ones per server (whole entry):

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<project>/.mcp.json`
5. `<project>/mcp.json`

The two project files are **executable resources behind the trust gate** —
an untrusted directory skips them with a note (`ink --trust` to enable).

Value expansion: `${VAR}`, `$env:VAR`, and `{env:VAR}` placeholders work in
`command`/`args`/`env` and in `url`/`headers`. `"disabled": true` skips a
server (visible in `/mcp`).

## Rules and limits

- **Server keys must be lowercase**: the composite tool name has to match
  `^[a-z][a-z0-9_-]{0,63}$`. A mismatched key (`tushareMcp`) registers zero
  tools while `/mcp` still says connected — rename it (`tushare`).
- Every server tool registers flat as `<server>_<tool>`
  (e.g. `zai-vision_analyze_image`) and is callable by the model like a
  built-in tool.
- `url` must be https (plain http only for loopback hosts); redirects are
  never followed — a token may ride the URL, and following one could leak it.
- Connections start asynchronously at startup (npx cold starts can take a
  while); tools that connect while a run is in flight join at the next run
  boundary. A server that dies mid-session reconnects transparently on the
  next tool call; an expired HTTP session is re-initialized and the call
  retried once.
- `/mcp` shows per-server status.
- `INK_MCP=0` or `"mcp": {"enabled": false}` in settings disables the module
  entirely. No config found = zero cost, nothing spawns, no requests are
  made.

## Scope (deliberate)

Tools only. No OAuth (authenticate with a PAT or a URL token), no sampling
or elicitation, no resources/prompts surfaces, no per-call approval gates,
no cross-vendor config import (cursor/claude/windsurf), no `mcp` proxy tool
(flat registration until a server with ≥10 tools shows up). Each deferral
has a recorded trigger in the design archive.
