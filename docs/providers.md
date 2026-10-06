# Providers and models

Read this when you sign in, switch models, or wonder which providers Ink
supports. CLI flags live in [cli.md](cli.md).

## Sign in: /login

`/login` in the REPL stores credentials in `~/.ink/auth.json` (0600). A
stored key beats the environment variable.

```
/login            → Z.AI · Anthropic · OpenAI · OpenAI (ChatGPT plan) ·
                    DeepSeek · Moonshot AI · Moonshot AI CN
/login zai        → straight to the key prompt; any family name works
/logout           → remove a stored credential (environment variables stay)
```

Rows show each provider's status (`signed in — stored key`,
`env: ZAI_API_KEY`, `not signed in`). The ChatGPT-plan row runs device-code
OAuth in the REPL: Ink prints the verification URL and code, polls in the
background, Ctrl+C cancels without force-quitting.

## Families

### Z.ai GLM Coding Plan

The official path is the zai family:

```bash
export ZAI_API_KEY=<your z.ai api key>
export INK_MODEL=glm-5.3   # or glm-5.2, glm-4.7, ... per your plan
```

or `/login` → Z.AI. A bare `glm-*` id routes to zai unconditionally; without
a credential Ink prints a sign-in pointer (`/login zai`), never a silent
fallback. `ZAI_BASE_URL` overrides (e.g. the CN mirror
`https://open.bigmodel.cn/api/coding/paas/v4`). Thinking: glm-5.2 =
off/high/max; glm-5.3 = low/high/max (cannot be disabled). The pre-zai
anthropic-compat setup (`ANTHROPIC_BASE_URL` at z.ai) still works when forced
explicitly (`ink -m anthropic/glm-5.3`), binary thinking knob only.

### Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or `/login anthropic`. `ANTHROPIC_AUTH_TOKEN` sends Bearer-style auth; a
stored `/login anthropic` key overrides it with x-api-key style — on a compat
endpoint prefer the env pair (next section).

### Any Anthropic-compatible service

```bash
export ANTHROPIC_AUTH_TOKEN=<token>          # or ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=<your endpoint>
export INK_MODEL=<id the endpoint serves>
```

### OpenAI

API key: `export OPENAI_API_KEY=...`, or `/login openai`. ChatGPT plan:
`ink login` (CLI) or `/login` → OpenAI (ChatGPT plan) — device-code OAuth.
`ink logout` removes only the ChatGPT-plan credential.

### DeepSeek

```bash
export DEEPSEEK_API_KEY=...
ink -m deepseek/deepseek-v4-pro        # or deepseek/deepseek-flash
```

Or `/login deepseek`. `DEEPSEEK_BASE_URL` overrides; a stored key wins over
the environment variable.

### Moonshot / Kimi

```bash
export MOONSHOT_API_KEY=...
ink -m moonshotai/kimi-k3       # overseas: api.moonshot.ai/v1
ink -m moonshotai-cn/kimi-k3    # China: api.moonshot.cn/v1
```

Or `/login moonshotai` / `/login moonshotai-cn` (per-family stored keys).
`MOONSHOT_BASE_URL` / `MOONSHOT_CN_BASE_URL` override the endpoints.
Thinking: k2.6 toggles off/on; k2.7-code and k3 always think (k3 takes
`reasoning_effort` low/high/max; the `medium` startup level maps to `high`).

## Model resolution and /model

- With no credentials, Ink says so (`no model available — run /login to
  connect one`) instead of pretending; no unusable model is ever written into
  a session file.
- With exactly one provider configured, new sessions start on that family's
  recommended model with a one-line note; `/model` changes it;
  `/settings defaultModel <id>` pins the startup default. Precedence:
  `-m` > `INK_MODEL` > settings `defaultModel` > session-saved >
  single-provider recommendation > builtin default.
- `/model [id]` applies from the next turn; Ctrl+L opens the picker.
  Switching model or thinking level prints one dim status line; consecutive
  switches merge.
- Thinking levels: `/think [level]` or Shift+Tab cycles; `--thinking` /
  `INK_THINKING` set the startup level; the choice persists in settings as
  the next session's default. Levels follow each model's catalog entry —
  some models cannot turn thinking off (gpt-5 base, o3, gpt-6), newer ones
  expose `xhigh`/`max`.

## Model catalog (pi.dev)

Model metadata — context windows, cost rates, thinking ladders, vision
capability, family model lists — comes from the public catalog service at
`pi.dev`. A disk cache (`~/.ink/models-catalog.json`) makes it offline-safe:
at startup Ink loads the cache synchronously (bundled static tables are the
frozen last-resort floor) and refreshes non-blocking when the cache is older
than 4 hours; opening `/model` re-checks the same window. No periodic
polling. On a successful fetch the catalog always wins over the bundled
tables, so new models and price changes arrive without an Ink release.

```bash
INK_CATALOG_BASE_URL=https://mirror.example   # redirect the catalog source
INK_CATALOG_PATH=/path/to/models-catalog.json # relocate the cache
```
