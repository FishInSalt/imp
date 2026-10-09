# 会话

当你恢复或分叉一段对话、浏览历史，或者想了解压缩如何工作时，读这篇。模型/提供商
相关问题 → [提供商](providers.md)。

## 会话保存在哪里

会话是以追加方式写入的 JSONL 消息树，保存在 `~/.ink/sessions/` 下，按工作目录
组织。每一轮——用户消息、助手消息、工具调用与结果、模型切换、压缩检查点——都会
保留在磁盘上；内容从不重写。

```bash
ink -c                  # continue the most recent session in this directory
ink -r                  # ink sessions lists them; -r <id> resumes (prefix ok)
ink --no-session        # ephemeral run; nothing persisted
```

在 REPL 中：`/sessions` 列出会话；`/resume <id>` 切换（历史会在屏幕上重放）；
`/new` 开启全新会话（旧会话保留在磁盘上）；`/name <name>` 为会话命名（供选择器
显示）；`/status` 一眼展示会话、模型、上下文和信任状态。退出时总会显示如何恢复：
`ink -r <id>`。

## 消息树

每个会话的消息构成一棵树，而不是一条线。分叉或跳转会创建分支；活动分支为下一次
模型请求提供历史。

- `/fork`——在较早的某条消息之前分叉对话。从可过滤的用户消息列表中挑选一条，或
  使用 `/fork <n>`。跳到某条用户消息会把它重新放回输入框，以便再次编辑。
- `/tree`——覆盖所有轮次与分支的可视化选择器。方向键移动；Tab 循环切换过滤器
  （default / no-tools / user-only / labeled-only / all）；`f` 折叠子树；`L` 给
  选中条目加标签（标签是可搜索的书签，在任何过滤器下都会保留）；输入文字即
  搜索；Enter 跳转。←/→/PgUp/PgDn 翻页；alt+←/→ 在分支点折叠；ctrl+x 复制选中
  条目的文本；层级较深时自动横向平移。选择器从你当前所在的位置打开。
- 从某个分支跳走时，可以选择把你离开的分支摘要进新位置的上下文（三选一询问：
  No summary / Summarize / 自定义提示词）。`INK_BRANCH_SUMMARY=0` 完全禁用摘要；
  `/settings branchSummary.skipPrompt true` 跳过询问（直接不摘要）。
  `/settings treeFilterMode <mode>` 记住你的默认过滤器。
- readline（非 TUI）shell 把树渲染成带编号的列表；`/tree <n>` 跳到第 n 行。

## 压缩

接近上下文窗口时，较早的轮次会被 LLM 摘要成一个检查点：之后的模型请求使用摘要
加最近的轮次，而完整历史仍保留在磁盘上。`/compact` 手动触发压缩（可选自定义
指令）。`--no-session` 也会禁用自动压缩；`INK_AUTOCOMPACT=0` 或设置中的
`"autoCompact": false` 可将其关闭。`INK_CONTEXT_WINDOW` 覆盖窗口的估算值
（默认 131072）。

分支摘要（来自 `/tree` 跳转）是另一套机制：它把被放弃的分支记录成单个条目。两者
都会保留原始条目——树从不修剪。

## 转向与后续追问（交互模式）

Ink 工作期间输入的行会排队，绝不丢弃：

- **Enter** → 一条 `steer:` 行，在下一次模型调用前注入正在运行的轮次。默认排空
  模式 `all`：所有排队的转向指令在下一个边界一次性并入。
- **Alt+Enter** → 一条 `follow-up:` 行，在模型本要停下时由同一次运行消费。默认
  `one-at-a-time`：每个回答消费一条后续追问，因此排队的序列会持续前进，无需回到
  空闲状态。
- **Alt+Up / Esc+P** 把所有排队中的行拉回编辑器（保留草稿）；Ctrl+C 中止也会以
  同样的方式交还它们。
- 模式通过设置键配置：`/settings steeringMode` 和 `/settings followUpMode`
  （`all` | `one-at-a-time`）。

终端说明：WezTerm 默认把 Option+Enter 绑成全屏，Alacritty 可能发送普通回车——
把两者都映射为 `\x1b[13;3u`，或改用 Esc+P（出队有回退方案；Alt+Enter 没有）。

## 已知限制

- `/resume` 选择器的输入过滤只消费已提交的文本——输入法组合窗口在组合过程中不
  发出按键（kitty 协议），因此 CJK 输入在提交之后才会参与过滤。粘贴的一块内容
  只取第一行。
