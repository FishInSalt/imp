# 提供商与模型

当你登录、切换模型，或想了解 Ink 支持哪些提供商时，读这一篇。CLI 参数见
[cli.md](cli.md)。

## 登录：/login

REPL 中的 `/login` 把凭据存入 `~/.ink/auth.json`（权限 0600）。已存储的
key 优先于环境变量。

```
/login            → Z.AI · Anthropic · OpenAI · OpenAI (ChatGPT plan) ·
                    DeepSeek · Moonshot AI · Moonshot AI CN
/login zai        → straight to the key prompt; any family name works
/logout           → remove a stored credential (environment variables stay)
```

每一行显示对应提供商的状态（`signed in — stored key`、`env: ZAI_API_KEY`、
`not signed in`）。ChatGPT 套餐所在的行会在 REPL 中走设备码 OAuth 流程：
Ink 打印验证 URL 和验证码，在后台轮询，Ctrl+C 可以取消而不会强制退出。

## 家族

### Z.ai GLM Coding Plan

官方途径是 zai 家族：

```bash
export ZAI_API_KEY=<your z.ai api key>
export INK_MODEL=glm-5.3   # or glm-5.2, glm-4.7, ... per your plan
```

或者 `/login` → Z.AI。不带前缀的 `glm-*` id 会无条件路由到 zai；没有凭据
时 Ink 会打印登录指引（`/login zai`），绝不静默回退。`ZAI_BASE_URL` 可覆盖
端点（例如国内镜像 `https://open.bigmodel.cn/api/coding/paas/v4`）。思考
档位：glm-5.2 = off/high/max；glm-5.3 = low/high/max（无法关闭）。在 zai 家族
出现之前的 anthropic 兼容配置（将 `ANTHROPIC_BASE_URL` 指向 z.ai）在显式
强制时仍然可用（`ink -m anthropic/glm-5.3`），且仅支持二元的思考开关。

### Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

或者 `/login anthropic`。`ANTHROPIC_AUTH_TOKEN` 发送 Bearer 风格的认证；
已存储的 `/login anthropic` key 会以 x-api-key 风格将其覆盖——在兼容
端点上，优先使用环境变量组合（见下一节）。

### 任意 Anthropic 兼容服务

```bash
export ANTHROPIC_AUTH_TOKEN=<token>          # or ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=<your endpoint>
export INK_MODEL=<id the endpoint serves>
```

### OpenAI

API key：`export OPENAI_API_KEY=...`，或者 `/login openai`。ChatGPT 套餐：
`ink login`（CLI）或 `/login` → OpenAI (ChatGPT plan)——设备码 OAuth。
`ink logout` 只删除 ChatGPT 套餐的凭据。任何 OpenAI 兼容服务（OpenRouter、
MiniMax 等）都可以通过 `OPENAI_BASE_URL` 配合该端点提供的模型 id 来使用。

### DeepSeek

```bash
export DEEPSEEK_API_KEY=...
ink -m deepseek/deepseek-v4-pro        # or deepseek/deepseek-flash
```

或者 `/login deepseek`。`DEEPSEEK_BASE_URL` 覆盖端点；已存储的 key 优先于
环境变量。

### Moonshot / Kimi

```bash
export MOONSHOT_API_KEY=...
ink -m moonshotai/kimi-k3       # overseas: api.moonshot.ai/v1
ink -m moonshotai-cn/kimi-k3    # China: api.moonshot.cn/v1
```

或者 `/login moonshotai` / `/login moonshotai-cn`（按家族分别存储 key）。
`MOONSHOT_BASE_URL` / `MOONSHOT_CN_BASE_URL` 覆盖端点。思考档位：k2.6 在
off/on 之间切换；k2.7-code 和 k3 始终会思考（k3 接受 `reasoning_effort` 的
low/high/max；启动档位 `medium` 映射为 `high`）。

## 模型解析与 /model

- 没有任何凭据时，Ink 会如实说明（`no model available — run /login to
  connect one`），而不是假装可用；不可用的模型绝不会被写入会话文件。
- 只配置了一个提供商时，新会话以该家族的推荐模型启动，并给出一行说明；
  `/model` 可以更改；`/settings defaultModel <id>` 固定启动默认值。优先
  级：`-m` > `INK_MODEL` > 设置中的 `defaultModel` > 会话保存值 >
  单提供商推荐值 > 内置默认值。
- `/model [id]` 从下一轮起生效；Ctrl+L 打开选择器。切换模型或思考档位会
  打印一行暗色状态行；连续切换会合并显示。
- 思考档位：`/think [level]` 或 Shift+Tab 循环切换；`--thinking` /
  `INK_THINKING` 设置启动档位；所选档位会持久化到设置中，作为下一个会话
  的默认值。档位遵循各模型的目录条目——有些模型无法关闭思考（gpt-5 base、
  o3、gpt-6），较新的模型提供 `xhigh`/`max`。

## 模型目录（pi.dev）

模型元数据——上下文窗口、费用费率、思考档位阶梯、视觉能力、家族模型
列表——来自 `pi.dev` 的公开目录服务。磁盘缓存
（`~/.ink/models-catalog.json`）让它可安全离线使用：启动时 Ink 同步加载
缓存（随包内置的静态表是冻结的最终兜底），缓存超过 4 小时未更新时会以
非阻塞方式刷新；打开 `/model` 会重新检查同一时间窗口。没有周期性轮询。
抓取成功时，目录总是优先于内置表，因此新模型和价格变动无需发布新版 Ink
即可生效。

```bash
INK_CATALOG_BASE_URL=https://mirror.example   # redirect the catalog source
INK_CATALOG_PATH=/path/to/models-catalog.json # relocate the cache
```
