# 子代理

当你用 `task` 工具委派工作、定义具名 agent 配置，或需要 worktree 隔离时，
读这一篇。

## task 工具

`task` 把一个自包含的工作委派给全新的子代理，子代理拥有自己的上下文窗口：
探索过程的冗余内容不会进入主对话，子代理的最终消息作为工具结果返回
（附有用量信息；过大的结果保留尾部、截断到 50KB）。

子代理与父级在同一进程内运行，使用父级的工具（`task` 本身除外）和父级的
工作目录，不设上限——预算决策始终由父级掌握。一轮中的多个 `task` 调用并发
运行（按波次，每波最多 5 个）；结果在对话中保持确定的、按调用顺序排列的
位置，界面上每个调用有自己的条目：运行时在各自的 `● task` 标题下显示实时
概览，结束时结果立刻落在该标题下，并带有各自的耗时。

## 循环健康监测

一个共享的循环健康监测器（主循环与子代理使用相同的信号）会如实报告退化
模式——重复的相同工具调用、反复失败的编辑——报告形式为任务结果行、任务
记录字段，以及每个信号一条 REPL 暗色提示（`INK_HEALTH=0` 可将其关闭）。
它从不向子代理注入任何内容。

## 持久化与计时

- 每个子代理的对话记录都会持久化为会话文件，存放在父会话旁的 `children/`
  目录中（`INK_CHILD_SESSIONS=0` 可退出此项）。
- 墙钟时间：REPL 中不设时钟（Ctrl+C 兜底）；打印/无头运行中有 60 分钟的
  挂起保护。调用上的 `timeoutMs` 或 agent 文件中的 `timeout:`（秒）始终
  优先。

## 具名 agent

agent 配置是带手工解析 frontmatter 的 markdown 文件——没有 YAML 依赖，
也没有内置 agent。位置：`<project>/.ink/agents/`（位于信任门之后）和
`~/.ink/agents/`；名称冲突时项目目录优先。agent 文件在启动时加载——
新增文件需要重启，与扩展的变更相同。

```
.ink/agents/scout.md
---
name: scout
description: Explores a codebase to answer research questions
tools: read, grep, find     # optional subset of the parent pool
model: glm-5.3              # optional: same-provider override only
timeout: 300                # optional wall clock, seconds
thinking: high              # optional: off|minimal|low|medium|high|xhigh|max
worktree: true              # optional: run on an isolated git worktree
---

You are a code scout. Go broad before deep.
```

- `model:` 覆盖该 agent 的子代理运行所用的模型——**仅限当前提供商**：
  可以是不带前缀的 id，也可以是命名同一提供商的 `provider/id` 前缀
  （前缀会被剥离）。跨提供商的引用会在子代理启动前被拒绝，错误信息中会
  指出变通做法。省略则继承会话的模型；`model:` 留空属于配置错误（同样会被
  拒绝）。
- `thinking:` 为该 agent 的子代理设置思考档位。省略则在派生子代理时继承
  会话当前的档位；值为空属于配置错误（该文件会被跳过，并在启动时给出
  警告）。档位会被限制在子代理模型支持的范围内。
- 已注册的 agent 会在系统提示词的 `<advertised_agents>` 块中通告给模型；
  `task(agent: "scout", prompt: …)` 可运行其中一个。

一个可直接复制的示例在 `examples/agents/scout.md`（只读的代码侦察
agent：`tools: read, grep, find`）。

## worktree 隔离

`task` 调用可以设置 `worktree: true`（agent 文件也可以声明 `worktree:`）：
子代理在自己的 git worktree 上运行——系统临时目录下已提交状态的一份独立
检出——内置工具在该路径下重建，因此它物理上无法触碰父级的文件。给子代理
的提示词会要求它转换路径并提交自己的工作；结果中给出分支名和变更摘要，
父级审阅后用 `git merge --no-ff <branch>` 合并。没有改动的 worktree 会被
移除（连同分支一起）；已保留的成果绝不会被丢弃。`/worktrees` 列出为手动
合并而保留的 worktree。

扩展工具会被排除在 worktree 子代理之外（它们注册的 cwd 无法移动）。隔离
默认以工作目录为边界——子代理的 `bash` 仍可能引用工作目录之外的绝对路径。

## 并发边界

并发的子代理共享父级的工作目录。对同一文件的 `edit`/`write` 修改会通过
进程级文件锁串行化，`oldText` 匹配失败会退化为教学式错误（重读、重试）
——但 `bash` 的修改完全绕过该锁，整文件的 `write` 会静默覆盖更早的一次
写入。因此：相互独立的子任务并行委派；同一文件的修改串行进行（task
工具的描述也会这样告诉模型）。只读的 agent 配置（`tools:` 中不含
edit/write/bash）让这一点成为结构性约束——而 `worktree: true` 会完全消除
共享面。
