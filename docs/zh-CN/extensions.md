# 扩展

当你需要为 Ink 添加工具、斜杠命令、系统提示段落、事件门控或工具配色时，
阅读本文。技能（markdown 包）→ [skills.md](skills.md)；MCP（外部服务器）
→ [mcp.md](mcp.md)。

## 扩展是什么

一个普通的 ESM 模块（`.mjs`，或 module 类型包下的 `.js`），默认导出一个
工厂函数，接收一个轻量 `api` 对象。Ink 按以下顺序从三个位置加载扩展：

1. `-e <path>` / `--extension <path>` 参数（可重复；文件或目录；无视信任
   门控直接加载）
2. `<project>/.ink/extensions/`——位于[信任门控](index.md#project-trust)之后
3. `~/.ink/extensions/`

`--no-extensions` 会跳过两个发现目录（显式给出的 `-e` 路径仍会加载）。

```js
// .ink/extensions/hello.mjs — an extension is a plain ESM module.
/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	api.registerTool({ /* …an Ink Tool — name, description, parameters, execute… */ });
	api.registerCommand({ /* …a /slash command, listed in /help… */ });
	api.registerContext("hello", "…a system-prompt section, appended after AGENTS.md…");
	api.on("tool_call", (event) => {
		// may veto: return { block: true, reason: "…what to do instead…" }
	});
}
```

随 api 一起还会提供三个只读信息：`cwd`（Ink 启动时的绝对工作目录）、`version`
（Ink 版本字符串）和 `origin`（`"cli" | "project" | "global"`——扩展的
发现位置）。

## api 接口

- **`registerTool(tool)`**——注册一个可被 LLM 调用的工具（与内置工具结构
  相同：名称、描述、typebox `parameters`、`execute`）。
- **`registerCommand(command)`**——注册一个 REPL 斜杠命令（在 `/help` 中
  标记 `[source]`）。
- **`registerContext(id, text)`**——向系统提示追加一个静态段落，位于
  AGENTS.md 上下文之后。
- **`on(event, handler)`**——订阅 `tool_call`、`tool_end`、`message_end`、
  `run_start`、`run_end`。
- **`setStatus(key, text)`**——在 TUI 页脚显示一行状态（`undefined` 清除；
  键按扩展划分命名空间；样式由宿主负责）。可在处理器、定时器和命令回调
  中使用；打印模式下是安全的空操作。如果创建了定时器，请对它们调用
  `unref()`——泄漏的仍被引用的定时器会阻止进程退出。
- **`registerToolColor(names, color)`**——为 TUI 调用头中的工具**名称**
  上色。`names`：一个名称、多个名称，或 `"*"`（兜底）。`color`：一个
  standard-16 token（`black` … `bright*`）、`"none"`（仅加粗），或一个
  绝对 token——`#rrggbb` 或 `ansi256:N`（更可移植的选择）。精确名称优先
  于 `"*"`；同一层级内，某个名称的首次注册生效。默认不附带任何配色。
- **`suggestToolColor(names, color)`**——同样的 API，但弱一个层级：提供
  工具的扩展可以建议它的默认外观；**任何用户注册都优先于任何建议**
  （用户精确 > 用户 `"*"` > 建议精确 > 建议 `"*"`）。在提供工具的扩展中
  使用它；`registerToolColor` 应当放在主题里。
- **`confirm(message, detail?, options?)`**——向用户提出一个是/否问题。
  明确同意时恰好解析为 `true`；`false` 覆盖拒绝、空回答，以及没有交互式
  提示的宿主；`options.timeoutMs` 到期未作答时为 `"timeout"`（用
  `=== true` 比较，绝不要做真值判断）。`options.sessionKey` 启用“本次会话
  不再询问”的记忆；`options.warnSpans` 在详情中高亮字符区间；
  `options.preview` 渲染一个命令式请求。

## 事件

- `tool_call`——在参数校验之后、执行之前触发。处理器可以返回
  `{ block: true, reason: "…" }`；阻止决定会成为模型看到的工具结果（包含
  reason），因此运行会作出调整而不是直接失败。子代理调用会带着
  `subagent: true` 和 `agent` 配置名通过同一道门控——门控可以让子代理
  遵守更严格的规则。
- `tool_end` / `message_end`——观察者：工具结果和已定稿的助手消息。
- `run_start`——顶级运行开始时触发一次。如果运行崩溃（提供商抛错），
  `run_end` 并不会触发——要容忍没有配对的 `run_start`（例如在下一次触发
  时重置状态）。子代理运行两者都不发出。

## 失败行为

有问题的扩展绝不会让 Ink 崩溃：加载失败、注册冲突和处理器抛错，各自只会
变成一行 `ink:` 教学提示。`tool_call` 处理器抛出异常时按**安全**方式失败
——调用会被阻止。

## 安全

扩展就是代码，以你的完整权限运行——与 agent 本身相同的权限状态。对于不是
你自己写的仓库，请检查其中的 `.ink/extensions/`，或者用 `--no-extensions`
运行。

## 内置示例

`examples/extensions/` 附带一组案例：

- `notes.mjs`——API 导览
- `guardian.mjs`——配置驱动的权限门控：通配符/正则规则在调用运行前拒绝
  或询问，按文件限定的 `write`/`edit` 规则；配置在 `~/.ink/guardian.json`，
  审计记录写入 `~/.ink/guardian.log`
- `notify.mjs`——带声音的 macOS 完成通知
- `task-timer.mjs`——TUI 页脚中实时的单次运行计时器
  （`run_start`/`run_end` + `setStatus`）
- `tool-colors.mjs`——调用头的名称配色主题（内置工具 Claude 橙，`task`
  亮青色）
- `web-search/`——内置的多文件搜索工具

把其中一个复制到 `~/.ink/extensions/`，然后按需修改。
