# Fresh-install model availability UX (#fresh-install-hint)

Status: draft (awaiting independent design review)
Branch: `fix/fresh-install-model-hint` (worktree, base main `8115822`)
Date: 2026-09-28

## 1. Problem

User feedback after publishing 0.1.0 (verified against the published
`imp-agent-0.1.0.tgz` in a fresh `HOME`, no env vars, no `~/.imp/`):

> F1. imp 初次安装时本地没有任何模型可用，但 imp 默认写死一个模型误导用户，
>     实际使用时不可用。
> F2. imp 应该在没有模型可用时提示用户通过 /login 接入模型服务厂商，
>     而不是显示正在使用一个默认又不可用的模型。

Verified behavior chain (all paths in `src/`):

1. `cli.ts defaultModel()` (line 44–59) falls back to the hardcoded
   `"claude-sonnet-4-5"` when `IMP_MODEL`, trusted project settings, and
   global settings are all absent — the fresh-install case by definition.
   Bare ids route to the anthropic family (`resolve.ts parseModelRef`).
2. Interactive banner (`repl.ts welcomeLines`, line 151) and footer
   (`repl.ts refreshFooter`, line 841) render `runner.modelReference()`
   unconditionally — the user sees `claude-sonnet-4-5` as if in use.
3. The first message fails: anthropic provider throws "No API key found"
   (`anthropic.ts:120`) which teaches only env vars — no `/login`, no
   exit-code difference from any other provider error.
4. Session files persist the dead default (`seedModel`) — `imp -c` later
   resurrects it after the user has configured something else.
5. Print mode (`imp -p hello`) errors after the banner-less startup; a
   session file with the dead model was still created (observed:
   `~/.imp/sessions/…` with `model: claude-sonnet-4-5`).

Existing machinery that ALREADY solves credential probing but is unused
on the startup path:

- `familyConfigured(family)` (`src/provider/discover.ts:89`) — stored key
  OR env var, per family, including codex OAuth and the
  `ANTHROPIC_AUTH_TOKEN` bearer case.
- `/login` supports 7 families (`commands.ts LOGIN_TARGETS`, line 822).
- `noteMissingZaiCredential` (`runner.ts:905`) — the exact pattern this
  design generalizes (zai-only today).

## 2. Design principles

P1 **No invented model.** imp never fabricates a working model when none
   is resolvable. A model reference is only *displayed as in use* when its
   family holds a credential (stored key or env var).          [F1]

P2 **The teaching moment is startup, not first failure.** When no usable
   model exists, the startup surface (banner/footer/print header) says so
   in one line and points to `/login`.                          [F2]

P3 **Least surprise for the configured majority.** Users with a working
   env var / stored key see zero new output (byte-identical startup).

P4 **Resumability is never destroyed.** A dead default must not become a
   sticky session default (`seedModel` writes it; `imp -c` resurrects it).

P5 **Reuse, don't duplicate.** Credential probing reuses
   `familyConfigured`; the note reuses the `noteMissingZaiCredential`
   pattern; the banner line reuses `welcomeLines`' identity line.

## 3. Detailed design

### 3.1 Model availability seam (new module)

New `src/provider/model-availability.ts`:

```ts
export interface ModelAvailability {
  /** true when the CURRENT model's family holds a credential. */
  usable: boolean;
  /** All families with a credential right now (stored or env). */
  configuredFamilies: ProviderName[];
}

export function modelAvailability(reference: string): ModelAvailability;
// usable = familyConfigured(parseModelRef(reference).provider)
```

Rationale: `familyConfigured` reads the auth store + env per family; the
runner calls it at the few state-change points (below), not per keystroke.

Note on scope: `familyConfigured` is a *credential* probe, not a reachability
probe — a configured family whose endpoint is down still counts as usable.
That is the correct semantics for this UX: the problem being fixed is "no
credential anywhere", not "endpoint down".

### 3.2 Startup display: usable vs unusable

**Decision D1 — what the banner/footer shows when unusable:**

Interactive fresh install (`claude-sonnet-4-5`, no credential):

```
███… (logo unchanged)

Tips for getting started:
1. Ask questions, edit files, or run commands.
2. Be specific for the best results.
3. /help for more information.

imp 0.1.0 · session 1a2b3c4d · no model available — run /login to connect one
```

- The identity line gains a suffix segment: `no model available — run /login`.
  The dead model id is NOT shown as "in use"; it appears, clearly named, only
  in the teaching note (D2) — never rendered as the session's model.
- Footer: `no model — /login` in place of the model segment while unusable
  (byte-identical to today for usable models).
- The banner text is NOT localized per provider — one string for all
  families.

**Decision D2 — the startup teaching note (interactive):**

One `▪` note printed after the banner (through the existing
startup-notes deferral, `cli.ts runInteractive`), honoring the
"one `▪` line per teaching" convention:

```
▪ no model available — sign in with /login (zai, anthropic, openai, openai-codex, deepseek, moonshotai, moonshotai-cn) or set IMP_MODEL/…_API_KEY
```

- The family list is derived from `LOGIN_TARGETS` (no hand-maintained
  duplication — BUILTIN_COMMAND_NAMES precedent).
- When `configuredFamilies.length > 0` but the CURRENT model's family is
  unconfigured (e.g. IMP_MODEL=deepseek/… with no DEEPSEEK key but a zai
  key stored), the note instead says: `▪ <model> has no credential — run
  /login <that family> (or /model to pick a configured one)`.

**Decision D3 — print mode:**

Print mode has no `/login`. `imp -p …` with an unusable model errors
BEFORE any session/log write (satisfies P4 for print runs):

```
imp: <model-id> (<family>) has no credential — export <FAMILY>_API_KEY (see `imp --help`), or start a session and run /login
```

The family→env-var mapping reuses `LOGIN_TARGETS`. Top-level `imp login`
is codex-OAuth-only today, so it is only mentioned when the family is
openai-codex (`imp login` + `-m openai-codex/…`).

- The check runs in `runPrint` before `createRunner` (which writes the
   session seed).
- exit code stays 1; stderr only, stdout stays empty (byte contract).
- `-m <explicit id>` with no credential: same fail-fast — the user named a
  family without a credential; the error names the family and its env var.

**Decision D4 — the dead default must not stick.**

`warmup()` currently seeds the session with the resolved model even when
unusable. Change: when availability is `usable === false`, the session
seed is skipped (the session starts model-less; `getModel()` returns null)
until the user picks/logs in — `seedModel` is not called for unusable
models; the session stays resumable with its messages.

- `/login` → `switchHint` note already teaches `/model <hint>`; after login
  the family becomes configured, `/model` picker leads with it.
- If the user submits a prompt anyway with an unusable model (interactive
  mode keeps accepting input — the teaching note told them why), the run
  fails with the provider's key error (existing behavior, unchanged).
  The turn still persists as today (a failed run is still a real turn) —
  but `seedModel` was never called, so `imp -c` does not resurrect the dead
  default; instead `restoreModelFromSession` falls back to the startup
  resolution chain (existing code path, `runner.ts restoreModelFromSession`
  "saved ? … : this.options.model" branch — verbatim reuse).

**Decision D5 — anthropic provider error teaching (`/login` pointer).**

`anthropic.ts` "No API key found" message appended (interactive-relevant,
harmless in print):

```
  /login anthropic  (interactive — stores the key in ~/.imp/auth.json)
```

The other families' providers already teach their env var; their in-REPL
`/login` pointer arrives with #login-dialog polish, out of scope here.

### 3.3 Which surfaces change

| Surface                     | Today (0.1. seam)                        | After                                                        |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Interactive banner identity | `… · claude-sonnet-4-5`                | `… · no model available — run /login to connect one`         |
| Footer model segment        | dead id shown                            | `no model — /login`                                          |
| Startup note (interactive)  | none                                     | one `▪` line (D2), after banner via startup-notes deferral    |
| Print mode                  | session written, then key error          | clean pre-flight error, exit 1, no session/log side effects  |
| Session seed                | dead default persisted                   | skipped while unusable; message history still persists       |
| anthropic error text        | env vars only                            | + `/login anthropic` line                                    |
| `--help` model line         | `default: $IMP_MODEL or claude-sonsur-…` | unchanged (the default id itself stays as the fallback id; only *display as in-use* changes) |

`--help` unchanged: the id remains the fallback *routing* target for bare
ids; what changes is that imp no longer *presents* it as usable. If every
family is unconfigured AND the user passes `-m whatever`, behavior is
today's error path (unchanged).

### 3.4 Tests

1. Banner/footer: unusable → `no model available — run /login` / `no model — /login`; usable → byte-identical to today (snapshot).
2. Startup note: fresh install shows the `▪ no model available…` line; another-family-credential case shows the targeted note; no note when usable.
3. `familyConfigured`-based availability seam: per-family table test (env only / stored only / neither / codex OAuth stored).
4. Print pre-flight: no session file created on unusable `-p` run (P4), stderr text, exit 1.
5. `imp -c` after a fresh-install session → resolves via startup chain, not the dead default.
5b. Footer follows `/model` switch to an unconfigured family mid-session: shows `no model — /login <family>` (state change re-probe).

Tests live in `test/` (vitest, existing conventions: hermetic `IMP_AUTH_PATH`,
temp `HOME`, env scrubbing via existing fixtures).

5c. D5 anthropic error contains `/login anthropic` (provider unit test).

## 4. Reviewer questions (pre-registered)

Q1. Is skipping `seedModel` when unusable acceptable to the session-format
    contract? (Design intent: yes — `getModel() === null` is already a
    supported state; `restoreModelFromSession` handles null today.)
Q2. Should the footer `no model — /login` replace the think segment too?
    (Draft: no — think segment renders only for knob-bearing models; an
    unusable model still has a thinking meta. Keep both segments.)
Q3. Print-mode pre-flight: fail-fast vs let the provider error surface
    after the session is written? (Draft: fail-fast, P4.)
Q3b. -m explicit + unusable: fail-fast too, or let it run? (Draft: same
    fail-fast — the user named a family with no credential; the error
    names the family and its env var. Consistent with D3.)Q4. Does the banner identity line get too long? (Draft: the suffix
    `no model available — run /login to connect one` is 42 chars; the
    identity line is already ~50 chars → ~92 chars worst case. Acceptable
    for TUI; acceptable for legacy shells? Reviewer call.)
Q5. Resume a session whose saved model is now unconfigured (key revoked):
    resume still works (history loads), footer shows `no model — /login`,
    teaching note renders. Session model stays saved; switching via /model.
    (Draft: this is right — resume must not block on credentials.)

## 5. Out of scope

- `imp login <family>` top-level for api-key families (codex-only today).
- Auto-switching the model after `/login` (pi parity note in commands.ts
  already documents why imp always shows the switchHint note instead).
- Localizing per-family footer/banner strings.
- `imp login` help-text rewording in `--help`/README (kept as recorded debt).

## 6. Milestones

M1: availability seam + banner/footer + startup note (D1/D2) + tests.
M2: print pre-flight (D3) + session-seed skip (D4) + tests.
M3: anthropic error teaching (D5) + CHANGELOG + README note + tests.

Each milestone lands as its own commit on the branch; independent code
review after M3; merge `--no-ff` to main.

## 7. References

- Feedback report (this conversation, 2026-09-28).
- `docs/m15-settings-design.md` — the startup model chain this design
  sits on top of (env > trusted project > global > builtin).
- `src/provider/discover.ts familyConfigured` — the probing seam reused.
- `src/runner.ts noteMissingZaiCredential` — the note pattern generalized.
- `docs/login-dialog-design.md` — #login-dialog scope boundary.
