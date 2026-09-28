# Fresh-install model availability UX (#fresh-install-hint)

Status: rev2 — review findings F1–F8 folded in; awaiting re-review
Branch: `fix/fresh-install-model-hint` (worktree, base main `8115822`)
Date: 2026-09-28
Review round 1: FIX-FIRST (8 findings, all verified against source; see §8)

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
3. The first message fails: the anthropic provider throws "No API key
   found" (`anthropic.ts:146`) which teaches only env vars — no `/login`,
   no exit-code difference from any other provider error.
4. Session files persist the dead default (`seedModel`) — `imp -c` later
   resurrects it after the user has configured something else.
5. Print mode (`imp -p hello`) errors after a session file with the dead
   model was already created (observed on the published tarball).

Existing machinery that ALREADY solves credential probing but is unused
on the startup path:

- `familyConfigured(family)` (`src/provider/discover.ts:89`) — stored key
  OR env var, per family, including codex OAuth and the
  `ANTHROPIC_AUTH_TOKEN` bearer case.
- `/login` supports 7 families (`commands.ts LOGIN_TARGETS`, line 822).
- `noteMissingZaiCredential` (`runner.ts:909`) — the note pattern this
  design generalizes (zai-only today).

## 2. Design principles

P1 **No invented model.** imp never presents a model as "in use" when its
   family holds no credential (stored key or env var).            [F1]

P2 **The teaching moment is startup, not first failure.** When no usable
   model exists, the startup surface says so in one line and points to
   `/login`.                                                      [F2]

P3 **Least surprise for the configured majority.** Users with a working
   env var / stored key see zero new output (byte-identical startup).

P4 **Resumability is never destroyed — and the dead default never
   sticks.** No `seedModel` write of an unusable model on ANY path
   (fresh warmup, `/new`, resume/-c restore); message history still
   persists; a model-less session stays resumable.

P5 **Reuse, don't duplicate.** Credential probing reuses
   `familyConfigured`; the note generalizes `noteMissingZaiCredential`;
   the banner line reuses `welcomeLines`' identity line.

P6 **Deterministic tests.** Credential state is observable state; both
   the probe and every display surface must be controllable from tests
   without host-env coupling.

## 3. Detailed design

### 3.1 Model availability seam (new module)

New `src/provider/model-availability.ts`:

```ts
export interface ModelAvailability {
  /** true when the CURRENT model's family holds a credential
   *  (stored key or env var — familyConfigured semantics). */
  usable: boolean;
  /** All families with a credential right now. */
  configuredFamilies: ProviderName[];
}

export function modelAvailability(providerName: ProviderName): ModelAvailability;
// usable = familyConfigured(providerName)
```

**Live probe, not cached** (round-1 F4 resolved): callers probe at render
time. `familyConfigured` reads one small JSON file (`~/.imp/auth.json`,
already redirected by `IMP_AUTH_PATH` in tests) plus `process.env` — a
per-footer-refresh read is bounded and negligible next to a turn's LLM
call, and live probing makes staleness impossible: after `/login` the
next footer repaint is automatically correct. No invalidation hooks, no
cache coherency surface. (`refreshFooter` fires per turn and per command
dispatch, `repl.ts:388,592,655` — never per keystroke.)

Scope note: `familyConfigured` is a *credential* probe, not a
reachability probe — a configured family whose endpoint is down still
counts as usable. Correct semantics here: the problem is "no credential
anywhere", not "endpoint down".

**Test-seam rule (P6, new D6):** when `RunnerOptions.provider` is
injected (the existing test seam — a fake provider REPLACES resolution
entirely in `createRunner`), availability is reported `usable: true`
without probing. This keeps the 2000+ existing tests byte-stable on any
host (a developer with `~/.imp/auth.json` or `ANTHROPIC_API_KEY` set
must not flip pinned banner/footer bytes). Tests FOR the unusable path
scrub env (`delete ANTHROPIC_API_KEY` …) and point `IMP_AUTH_PATH` at a
temp empty file — both levers already exist and are used by
`test/login-dialog.test.ts:38`.

### 3.2 Startup display: usable vs unusable

**Decision D1 — banner/footer when unusable:**

Interactive fresh install (`claude-sonnet-4-5`, no credential):

```
███… (logo unchanged)

Tips for getting started:
1. Ask questions, edit files, or run commands.
2. Be specific for the best results.
3. /help for more information.

imp 0.1.0 · session 1a2b3c4d · no model available — run /login to connect one
```

- Identity line suffix: `no model available — run /login to connect one`.
  The dead model id never renders as the session's model; it appears by
  name only inside the teaching note (D2).
- Footer while unusable: the model segment becomes `no model — /login`
  and **the think segment is dropped** (round-1 F7: `claude-sonnet-4-5`
  HAS a thinking meta — `anthropic-budget` — so keeping it renders the
  contradictory `no model — /login think:medium`). The knob is
  meaningless without a credential; it returns with the model segment
  once usable.
- Byte-identical to today whenever usable (P3).

**Decision D2 — the startup teaching note (interactive):**

One `▪` note printed after the banner (through the existing
startup-notes deferral, `cli.ts runInteractive`):

```
▪ no model available — sign in with /login (zai, anthropic, openai, openai-codex, deepseek, moonshotai, moonshotai-cn) or export <FAMILY>_API_KEY
```

- The family list derives from `LOGIN_TARGETS` (no hand list).
- When `configuredFamilies.length > 0` but the CURRENT model's family is
  unconfigured (e.g. `IMP_MODEL=deepseek/…`, no DeepSeek key, but a zai
  key stored), the note instead targets:
  `▪ <model-id> (deepseek) has no credential — run /login deepseek (or /model to pick a configured one)`.
- **Suppression rule (round-1 F5):** when the current model is zai+glm
  and the existing `noteMissingZaiCredential` fires, that MORE SPECIFIC
  note wins and the generic D2 note is suppressed — one `▪` line per
  teaching, no double note. (`noteMissingZaiCredential` already no-ops
  when a credential exists, so the overlap is exactly the
  zai-unusable case.)

**Decision D3 — print mode:**

Print mode has no `/login`. `imp -p …` with an unusable model errors
BEFORE `createRunner` (hence before any session/log write; the run
logger and session store are both created inside it):

```
imp: <model-id> (<family>) has no credential — export <FAMILY>_API_KEY (see `imp --help`), or start an interactive session and run /login
```

- Family→env-var mapping reuses `LOGIN_TARGETS`. Top-level `imp login`
  is codex-OAuth-only today; it is mentioned only when family is
  openai-codex (`imp login` then `-m openai-codex/…`).
- Exit code 1; stderr only; stdout stays empty (byte contract).
- `-m <explicit id>` with no credential: same fail-fast — the user named
  a family without a credential; the error names family + env var.

**Decision D4 — the dead default must not stick (round-1 F2, expanded).**

ALL THREE `seedModel` call sites are gated on the same live usability
check — gating only `warmup` is insufficient because the resume path
re-seeds one process later:

- `runner.ts:560` (warmup, fresh session): skip `seedModel` when
  unusable. The session starts model-less; `getModel()` returns
  `undefined` (round-1 F1 correction: undefined, not null — the store's
  contract; `append()` writes fine without a model, `open()` tolerates
  model-less sessions — verified `store.ts:268`).
- `runner.ts:676` (`/new`): same gate — otherwise `/new` on a fresh
  install resurrects the dead default.
- `runner.ts:944` (`restoreModelFromSession`): `else` branch becomes
  `else if (usable) store.seedModel(prepared.ref)` — the in-memory
  model still applies (the turn can run and fail with the provider's
  key error — existing behavior), but nothing unusable is persisted.

Consequences:

- `imp -c` after a fresh-install session resolves via the startup chain
  (`!explicit && saved ? … : options.model`), and the 944-gate stops it
  persisting the dead default again.
- Submitting a prompt while unusable (interactive): the run fails with
  the provider's key error (unchanged), the turn persists as today, and
  the session file still has NO model row.
- **0.1.0 files (round-1 F6): no migration.** Sessions written by 0.1.0
  carry `session_model: claude-sonnet-4-5`; resuming one without a
  credential keeps the saved model in memory, displays it as unusable
  (`no model — /login` + note), and — via the 944-gate — no longer
  re-writes it. The seed (`explicit:false`) never set
  `explicitModelSelection`, so no `setModel` write happens either.
  Deliberate: display fixes the lie; rewriting user files is out of
  scope.

**Decision D5 — anthropic provider error teaching:**

`anthropic.ts:146` "No API key found" message appended:

```
  /login anthropic  (interactive — stores the key in ~/.imp/auth.json)
```

Other families' providers already teach their env var; their in-REPL
`/login` pointers arrive with #login-dialog polish, out of scope.

**Decision D6 — `/login` mid-session footer refresh (round-1 F3):**

`/login` and `/logout` success paths call `ctx.refreshFooter?.()`.
With the live probe (3.1) the footer then flips
`no model — /login` → the model id on the very next repaint. Today
`refreshFooter` is only invoked from `/think` (`commands.ts:1622,1635`)
— the login paths never repaint.

### 3.3 Which surfaces change

| Surface                     | Today                                    | After                                                        |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Interactive banner identity | `… · claude-sonnet-4-5`                  | `… · no model available — run /login to connect one` (unusable only) |
| Footer model segment        | dead id shown                            | `no model — /login`; think segment dropped (unusable only)   |
| Startup note (interactive)  | none                                     | one `▪` line (D2), after banner via startup-notes deferral    |
| Print mode                  | session written, then key error          | clean pre-flight error, exit 1, no session/log side effects  |
| Session seed (3 sites)      | dead default persisted on warmup/new/resume | skipped while unusable; message history still persists     |
| anthropic error text        | env vars only                            | + `/login anthropic` line                                    |
| /login, /logout             | footer stale until next turn             | `refreshFooter()` on success (D6)                            |
| `--help` model line         | `default: $IMP_MODEL or claude-sonnet-4-5` | unchanged — the id stays the fallback ROUTING target; only display-as-in-use changes |

`--help` unchanged: if every family is unconfigured AND the user passes
`-m whatever`, print pre-flight (D3) catches it; the id itself remains
the documented fallback.

### 3.4 Tests

1. Banner: unusable → identity line ends with `no model available — run /login to connect one`; usable → byte-identical to today's pinned `imp 0.1.0 · session [0-9a-f]{8} · <model>` (`test/repl.test.ts:145` keeps passing).
2. Footer: unusable → `no model — /login`, NO think segment; usable → pinned footer bytes (repl-tui) unchanged.
3. Startup note: fresh install shows the `▪ no model available…` line after the banner (release-order via releaseProbe); another-family-credential case shows the targeted note; zai+glm bare id shows ONLY the specific zai note (F5 suppression); no note when usable.
4. Availability seam: per-family table (env only / stored only / neither / codex OAuth stored), `IMP_AUTH_PATH` hermetic.
5. Print pre-flight: unusable `-p` run → stderr text, exit 1, ZERO files under the session dir AND the log dir (P4).
6. `imp -c` after a model-less fresh-install session → resolves startup chain; the session file gains NO model row.
7. `/new` while unusable → new session also gains no model row (F2 third site).
8. Resume a 0.1.0-shaped session (seeded dead model, explicit:false) without credential → banner shows unusable, session file NOT rewritten (byte-compare).
9. Interactive submit while unusable (D4 consequence, round-1 F8): turn fails with provider key error, message rows persist, `getModel()` stays `undefined`, footer still `no model — /login`.
10. `/login <family>` success → footer flips to the model segment (D6; scripted secret input via existing login-test harness).
11. `/model` switch mid-session to an unconfigured family → footer `no model — /login` (live probe).
12. Test-seam determinism (D6/P6): injected provider + host env with `ANTHROPIC_API_KEY` set → footer shows the model (usable), banner unchanged.
13. D5: anthropic error text contains `/login anthropic` (provider unit test).

## 4. Reviewer questions (round 1) — resolutions folded in

- Q1 seed-skip legality → YES (verified: model-less sessions are
  contract-legal today); but resume re-seeds at `runner.ts:944` — now
  gated (D4).
- Q2 think segment while unusable → DROP it (F7: contradictory with
  "no model").
- Q3 print fail-fast → YES; check sits before `createRunner` (session
  AND logger both created inside it — verified).
- Q3b explicit `-m` unusable → same fail-fast (D3).
- Q4 banner length → accept; only ever occurs in the degraded state.
- Q5 resume must not block on credentials → correct; plus explicit
  no-migration statement (F6).

## 5. Out of scope

- `imp login <family>` top-level for api-key families (codex-only today).
- Auto-switching the model after `/login` (switchHint note stays, pi parity).
- Localizing per-family footer/banner strings.
- `imp login` help-text rewording in `--help`/README (recorded debt).
- Other families' provider error texts gaining `/login` lines.

## 6. Milestones

M1: availability seam (+ test-seam rule) + banner/footer + startup note
    (D1/D2 + F5 suppression + F7 drop-think) + tests 1–4, 12.
M2: print pre-flight (D3) + three-site seed gating (D4) + /login footer
    refresh (D6/F3) + tests 5–11.
M3: anthropic error teaching (D5) + CHANGELOG + README note + test 13.

Each milestone lands as its own commit; independent code review after
M3; merge `--no-ff` to main.

## 7. References

- Feedback report (this conversation, 2026-09-28).
- `docs/m15-settings-design.md` — the startup model chain this sits on.
- `src/provider/discover.ts familyConfigured` — the probe reused.
- `src/runner.ts noteMissingZaiCredential` — the note pattern generalized.
- `docs/login-dialog-design.md` — #login-dialog scope boundary.

## 8. Round-1 review record (2026-09-28)

Verdict FIX-FIRST, 8 findings — all verified against source before
folding:

- F1 (P3) line-citation drift (anthropic throw 146 not 120; zai note 909
  not 905; `getModel()` undefined not null) → fixed in §1/§3.2.
- F2 (P0) resume path re-seeds dead default (`runner.ts:944`) → D4 gates
  all THREE seed sites (560/676/944).
- F3 (P1) /login never repaints footer → D6 adds refreshFooter calls.
- F4 (P1) "few state-change points" vs per-turn footer → resolved as
  LIVE probe at render time (§3.1), no cache.
- F5 (P2) double note for bare glm-* → D2 suppression rule.
- F6 (P2) 0.1.0 session migration unstated → explicit no-migration (D4).
- F7 (P2) `think:medium` beside `no model` → think segment dropped (D1).
- F8 (P3) missing submit-while-unusable test → test 9.
