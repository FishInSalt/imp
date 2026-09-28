# Fresh-install model availability UX (#fresh-install-hint)

Status: rev3 APPROVED (round 3, 2026-09-28) — implementation may start
Branch: `fix/fresh-install-model-hint` (worktree, base main `8115822`)
Date: 2026-09-28
Review round 1: FIX-FIRST (F1–F8, folded in rev2; all verified correct in round 2)
Review round 2: FIX-FIRST (N1–N8; fold-ins clean, new-in-rev2 issues)
Review round 3: APPROVE (fold-ins verified; one P3 line nit — legacy codex
OAuth success tail is commands.ts:936, not :941 — fixed at M2)
Implementation review: FIX-FIRST (6 findings) → fixes folded, APPROVE
(see §9)
Round-2 implementation review (post-merge): F1–F7 all fixed (see §10)

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

**Test-seam rule (P6, D7):** the seam tracks the LIVE provider
instance, not `RunnerOptions`: `usable = (this.provider is the injected
fake) || familyConfigured(currentFamily)`. `createRunner` knows
injection (`options.provider ?? resolved.provider`, `runner.ts:298`);
`prepareModel` swaps to a REAL provider on a runtime `/model` switch, at
which point probing applies (round-2 N2 — otherwise test 11 could never
pass). This keeps the 2000+ existing tests byte-stable on any host (a
developer with `~/.imp/auth.json` or `ANTHROPIC_API_KEY` set must not
flip pinned banner/footer bytes). Tests FOR the unusable path scrub env
(`delete ANTHROPIC_API_KEY` …) and point `IMP_AUTH_PATH` at a temp empty
file — both levers already exist and are used by
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
- **Resumed-session surfaces too (round-2 N3):** a resumed session never
  shows `welcomeLines` — it renders the warmup note
  `▪ resumed <id> · <model> · … msgs · ~… tokens` (`runner.ts:555`) and
  the REPL line `▪ session <id> · model <id>` (`repl.ts:1572`). While
  unusable both show `no model — /login` in place of the model segment
  (same P1 rule — no dead id rendered as in use).
- Footer while unusable: the model segment becomes `no model — /login`
  and **the think segment is dropped** (round-1 F7: `claude-sonnet-4-5`
  HAS a thinking meta — `anthropic-budget` — so keeping it renders the
  contradictory `no model — /login think:medium`). The knob is
  meaningless without a credential; it returns with the model segment
  once usable.
- Byte-identical to today whenever usable (P3).
- **Wording (round-2 N7):** banner/footer use the one canonical short
  form `run /login` / `no model — /login`; the longer per-family detail
  lives only in the D2 note and D3 print error.

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
- **The pre-flight honors the D7 seam** (round-2 N1): if
  `runnerOptions` carries an injected provider (tests), the check is
  skipped — existing print-mode tests with fake providers keep passing
  on keyless hosts; test 5 exercises the real path with scrubbed env.
- **Side-effect scope (round-2 N8):** "no session/log write" means the
  session dir and log dir (both first touched inside `createRunner`:
  `createRunLogger` at its entry). The trust store MAY be written earlier
  by `--trust`/`--no-trust` (`cli.ts resolveProjectTrust`) — recorded
  exception; test 5 asserts session dir + log dir only.

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

**Decision D6 — `/login` `/logout` footer refresh (round-1 F3, sites
enumerated per round-2 N6):**

With the live probe (3.1) a footer repaint picks up any credential
change; today only `/think` repaints (`commands.ts:1622,1635`). Add
`ctx.refreshFooter?.()` on ALL FIVE success paths: legacy api-key login
(`commands.ts:962`), legacy codex OAuth success tail (`:936`), dialog
api-key (`:1001`), dialog OAuth tail, and `/logout`'s two `act()`
closures (`:1566`, `:1577` — these run inside the picker callback, so
the call sits inside each closure, not the command body).

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
8. Resume a 0.1.0-shaped session (seeded dead model, explicit:false) without credential → the RESUMED line (`▪ session <id> · …`, repl.ts:1572 — not the banner, which fresh sessions only render) shows unusable; immediately after startup, before any turn, the session file is NOT rewritten (byte-compare).
9. Interactive submit while unusable (D4 consequence, round-1 F8): turn fails with provider key error, message rows persist, `getModel()` stays `undefined`, footer still `no model — /login`.
10. `/login <family>` success → footer flips to the model segment (D6; scripted secret input via existing login-test harness).
11. `/model` switch mid-session to an unconfigured family → footer `no model — /login` (live probe; the D7 seam no longer applies once the provider instance is real — N2).
12. Test-seam determinism (D7/P6): injected provider + host env with `ANTHROPIC_API_KEY` set → footer shows the model (usable), banner unchanged.
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

## 8. Review record

### Round 1 (2026-09-28) — FIX-FIRST, F1–F8 (all verified against source
before folding into rev2; round 2 re-verified all 8 fold-ins correct)

- F1 (P3) line-citation drift → fixed (anthropic throw :146, zai note
  :909, `getModel()` undefined not null).
- F2 (P0) resume path re-seeds dead default (`runner.ts:944`) → D4 gates
  all THREE seed sites (560/676/944).
- F3 (P1) /login never repaints footer → D6 adds refreshFooter calls.
- F4 (P1) "few state-change points" vs per-turn footer → resolved as
  LIVE probe at render time (§3.1), no cache.
- F5 (P2) double note for bare glm-* → D2 suppression rule.
- F6 (P2) 0.1.0 session migration unstated → explicit no-migration (D4).
- F7 (P2) `think:medium` beside `no model` → think segment dropped (D1).
- F8 (P3) missing submit-while-unusable test → test 9.

### Round 2 (2026-09-28) — FIX-FIRST, N1–N8 (fold-ins all correct; new
issues in rev2's own decisions, folded into rev3)

- N1 (P1) print pre-flight vs the test seam undefined → D3 states the
  pre-flight honors the D7 seam (skip when provider injected).
- N2 (P1) seam ambiguity after mid-session `/model` switch (test 11
  contradiction) → D7 restated: usable = live-provider-instance is the
  injected fake OR familyConfigured(current family); post-switch real
  providers probe.
- N3 (P2) resumed-session surfaces (`runner.ts:555` note, `repl.ts:1572`
  line) still render the dead id → D1 extended to both.
- N4 (P3) test 8 pinned the wrong surface (banner vs resumed line) and
  lacked the before-any-turn precondition → reworded.
- N5 (P3) duplicate "D6" label → seam renamed D7.
- N6 (P3) refreshFooter path list incomplete → D6 enumerates all five
  call sites incl. logout act() closures.
- N7 (P3) wording drift D1/D2/D3 → canonical `run /login` short form in
  D1; long forms only in note/print error.
- N8 (P3) trust-store write precedes createRunner under
  `--trust`/`--no-trust` → recorded as explicit exception; test 5 scope
  fixed to session dir + log dir.

## 9. Implementation review record (2026-09-28)

Independent adversarial code review after M1–M3: FIX-FIRST — F1 (P1) and
F2 (P2) required before merge, F3 strongly recommended, F4–F6
record-or-fix. Disposition:

- F1 (P1): print pre-flight probed `opts.model`, ignoring the SAVED model
  under `-c`/`-r` — a stored-zai-key user whose last session ran zai/*
  would be blocked by an anthropic error before the saved model was ever
  consulted. **Fixed**: `-c`/`-r` skip the pre-flight entirely; the
  provider's own key error teaches (0.1.0 behavior for that path).
- F2 (P2): biome failures on the new code (formatter + one unused import).
  **Fixed** (format --write; the pre-existing commands.ts import-sort on
  base 88be785 also cleared in passing).
- F3 (P2): the unit-suite "footer" test pinned constants, not behavior —
  a revert of the `usable &&` think-drop gate would have passed. **Fixed**:
  three real footer tests in repl-tui.test.ts (design tests 2/10/11) via a
  new `realProvider` startTuiRepl flag (no scripted injection — the D7
  seam would mask the gating; no turn is submitted, nothing hits the
  network): unusable→`no model — /login` + no think segment + dead id
  never rendered; /model to an unconfigured family flips the footer back
  (post-switch real-provider probe); /login success flips it forward.
- F4 (P3): mid-session `/resume` to an unusable model swaps the footer
  but fires no `▪` teaching note (the D2 note lives on the warmup path
  only). **Accepted gap** — the footer carries the pointer; recorded.
- F5 (P3): `/model <unconfigured family>` persists via `setModel`
  (explicit user intent — resumable once the user logs in). **Accepted,
  deliberate**: D4 gates seeds, never explicit selections.
- F6 (P3): design D3/N1 said the pre-flight "honors the D7 seam"; the
  implementation documents the CLI entry never injects instead.
  Behaviorally equivalent; **design addendum recorded here**.

Gates after fixes: 2164/2164 tests (3 new footer pins), typecheck clean,
biome clean (214 files), tarball smoke re-verified.

## 10. Round-2 implementation review record (2026-09-28)

A second independent review of the merged batch returned F1(P2)+F2–F5(P3)+F6–F7(P4). All fixed on the branch; dispositions:

- F1 (P2) biome format on the realProvider ternary → fixed.
- F2 (P3) the resume seed gate probed the PRE-switch live family —
  live=zai(keyed) + /resume of a model-less session wrote an unusable
  anthropic row. Gate now probes `prepared.ref.provider` (the model BEING
  persisted), D7 fake-provider exemption kept. The unit test that pinned
  the old verdict ("legacy seed lands as the startup default") was
  asserting the pre-F2 bug — re-pinned to the model-less contract, with a
  repro-shaped test of its own.
- F3 (P3) the D2 note leaked onto PRINT stdout on the -c/-r path → new
  RunnerOptions.interactive seam (print passes false; default true), the
  note gates on it; the zai-specific 0.1.0 note keeps its reach. Pinned by
  a subprocess test (stdout clean, provider error on stderr).
- F4 (P3) -c/-r + explicit -m skipped the pre-flight → skip now applies
  only when `!modelExplicit` (explicit -m outranks the saved model in
  restoreModelFromSession, so the pre-flight applies again). Pinned.
- F5 (P3) four more surfaces rendered an unusable id as current: TUI
  terminal title, /status `▪ model`, legacy /model `model:`, and the
  mid-session /resume note. Title semantics refined: it mirrors the
  user's PICK (explicit -m or /model → new `modelSelectedExplicitly()`
  flag shows the id even keyless), while in-use surfaces keep the
  /login pointer. /status//model//resume use the strict gate.
- F6 (P4) the three new footer tests leaked IMP_AUTH_PATH (never
  restored) → saved/restored like the file's existing pattern; the unit
  suite's auth-path generator also gained a monotonic counter (two tests
  in one millisecond shared a path — a stored zai key from the targeted
  test leaked into the F5-suppression test; same defect class).
- F7 (P4) dead `configuredFamilies()` API removed; `noteModelCredential`
  probes once instead of twice; ALL_FAMILIES derived from LOGIN_TARGETS
  (a future family can no longer be silently missing); cli-run-start
  header comment updated (dummy key); blank `-m ""` skips the pre-flight
  (parse matter, not credential).

Gates after fixes: 2168/2168 tests (16 in the batch suite: +F2/F3/F4/F5
pins), typecheck, tarball smoke re-verified (stdout clean on -c,
pre-flight fires for -c+-m, F2 repro writes only the explicit
selection).

### Round-3 verification follow-up (2026-09-28)

The round-3 re-review found the F1 lint fix incomplete (2 new format
errors + 1 unused-variable warning — the previous gate had run
`biome check src/ test/`, not the repo-root `.` scope) and the F5 pin
still self-proving. Both closed:

- F1: `npx biome check .` now exits clean (216 files, zero findings).
  Root cause recorded: gate scope drift — the merge message claimed the
  broader check while only the narrower one ran.
- F5: the /status test now drives the REAL command body (COMMANDS
  dispatch through the runner's renderer) and the terminal-title pin
  asserts the OSC 2 bytes in the raw stream (shell.setTitle writes them
  directly; FakeTerminal.setTitle is not on that path) — both a revert
  of the gating code now fails tests.

Gates: 2169/2169 tests, typecheck, `biome check .` clean.
