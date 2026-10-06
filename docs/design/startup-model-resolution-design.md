# Startup model resolution (#startup-model-resolution)

Status: rev3 APPROVED — IMPLEMENTED; design rounds 1–3, implementation rounds 1–2 and the user-side review folded; gates green (see §10.6)
Branch: `fix/startup-model-resolution` (worktree, base main `bae428e`)
Date: 2026-09-28
Review log: §9 (design) · §10.4–10.6 (implementation + user-side reviews)
Implementation log: §10

## 1. Problem

After #fresh-install-hint (merged, base `848632a`), a fresh machine with no
credentials is handled honestly: the banner/footer teach `/login`, no dead
model renders as in use, nothing unusable is persisted. What remains is the
*resolution*: imp still lands on the hardcoded builtin default
(`claude-sonnet-4-5`, `cli.ts:47–61`) whose family (anthropic) usually holds
no credential, and nothing ever resolves a *usable* model on the user's
behalf. The result is a recurring, user-visible friction: every new
session on a single-provider machine requires a manual `/model`.

### 1.1 Verified behavior chain (live-run transcripts, base 848632a)

Fresh HOME, scrubbed env, single configured family (either `ZAI_API_KEY`
env or a `/login zai` stored key), real TTY driven with `expect`:

```
# session 1
fresh startup:  imp 0.1.0 · session 549e3b16 · no model available — run /login to connect one
                ▪ no model available — sign in with /login (zai, anthropic, openai, …)
/login zai:     Enter Z.AI API key → Saved API key for Z.AI
                ▪ switch with /model zai/glm-5.3            ← manual step #1
/model …:       Model: zai/glm-5.3; footer flips           ← session works

# session 2 (new process, same machine)
new startup:    imp 0.1.0 · session 8e344dd7 · no model available — run /login to connect one
                ▪ claude-sonnet-4-5 (anthropic) has no credential — run /login anthropic
                  (or /model to pick a configured one)
                no model — /login · 8e344dd7 · …           ← manual step #2, every session
```

Print mode on the same machine: `imp -p "hi"` fails fast with
`imp: claude-sonnet-4-5 (anthropic) has no credential — export
ANTHROPIC_API_KEY (see 'imp --help'), or start an interactive session and
run /login` — a wrong-family instruction for a Z.AI user; `-m zai/glm-5.3`
works. Environment-variable users (`export ZAI_API_KEY=…`, no `/login`)
hit the same screen from the very first session and have no login event to
hang a fix on.

### 1.2 Design-document tensions this resolves

- `design/fresh-install-model-hint-design.md` D2/D3 are built around "show
  the dead default's family and teach login". Their copy
  (`no model available`, `run /login anthropic`) becomes *false* once any
  other family is configured — a model IS available, it is merely not
  selected. This design corrects the copy (D6) and supersedes the D2 note
  text for the configured-elsewhere case.
- `design/session-model-restore-design.md` ("Runner / CLI") states:
  *"No new login or model API discovery requests. Missing credentials do
  not select a different model; errors occur through existing provider
  handling."* That clause was written for the restore path. This design
  amends it with a narrowly scoped exception (D2, and D3 if OPEN-1 is
  adopted): resolution happens only under the stated uniqueness rule and
  only when nobody configured a model.

### 1.3 pi reference (checked against `/Users/z/Z/Agent_demo/pi`)

pi solves the same problem in three layered ways; we adopt a conservative
subset:

| pi mechanism | source | adopted? |
| --- | --- | --- |
| `findInitialModel`: saved default (if still authenticated) → first available model, preferring provider defaults in table order | `core/model-resolver.ts` | **partially** — unique-family only; no multi-provider table order (silent choice among the user's providers is the rejected part) |
| `/login` with no model selected auto-selects the provider's default model and **persists it as the global default** (`persist: true`) | `modes/interactive/interactive-mode.ts:5687+` | **yes, minus the settings write** — imp keeps settings writes to the user (`/settings`) |
| Picker `Ctrl+S` "set as default" (`app.models.save`), documented in README/quickstart | `core/keybindings.ts:186`, `components/model-selector.ts` | **no** — imp's `select()` is single-action (`shell.ts:771`); replaced by the D5 one-line hint |

pi's explicit-switch semantics we deliberately keep: a plain `/model <id>`
is session-only (`persist: false`), never silent config mutation.

## 2. Principles

- P1 (inherited) **No invented model.** The resolver only ever selects a
  model whose family holds a credential; resolved ids come from
  `LOGIN_TARGETS[].switchHint` — the exact ids the UI already teaches.
- P2 **The recurring friction ends.** A single-provider machine never
  requires `/model` to start a new session, neither for `/login` users nor
  for env-var users, in interactive or print mode.
- P3 (inherited) **Least surprise for the configured majority.** Machines
  whose effective model is usable see byte-identical output; every
  resolved-model surface change is confined to previously-unusable states.
- P4 (inherited) **The dead default never sticks.** Resolution results are
  never written to settings and are seeded into sessions only via the
  existing usability-gated `seedModel` path (explicit:false).
- P5 **Resolve only when unambiguous and unconfigured.** Resolution fires
  only when (a) the effective model's family has no credential, (b) the
  effective model came from the *builtin* rung (nobody configured a
  model), and (c) exactly one credential-source family exists (D1).
  Explicit sources — `-m`, `IMP_MODEL`, project/global `defaultModel` —
  are never silently overridden.
- P6 (inherited) **Deterministic tests.** The existing seams suffice:
  scrubbed env + `IMP_AUTH_PATH` temp store trigger the resolution;
  injected fake providers stay `usable` (D7 seam) so existing suites do
  not move.
- P7 **Forward-compatible seam.** The resolver's input contract accepts
  "no requested model" (`undefined`), not merely "requested model
  unusable", so the eventual removal of the builtin default reduces the
  rewrite at the CLI boundary; runner-side tolerance sites are listed in
  §3.7 (see §8).

## 3. Detailed design

### 3.1 D1 — Credential-source uniqueness

`modelAvailability().configuredFamilies` (`provider/model-availability.ts:31–43`)
reports families. Resolution needs *credential sources*, because one
source can mark two families:

- `moonshotai` and `moonshotai-cn` both read `MOONSHOT_API_KEY`
  (`provider/moonshotai.ts` — both providers pass the same envVar), so an
  env-only moonshot setup reports **two** configured families from one
  credential.

Rule (new helper, name TBD, e.g. `credentialSourceFamilies()`):

1. Start from `configuredFamilies`.
2. If both moonshot families are configured: stored keys disambiguate —
   stored `moonshotai` only → drop `moonshotai-cn`; stored
   `moonshotai-cn` only → drop `moonshotai`; neither or both stored →
   drop **both** (env-only or doubly stored is ambiguous: do not resolve).
3. Result length 1 → resolvable; otherwise → not (§3.2 cases c/d).
4. Determinism statements (R1-A-F4): an unreadable/corrupt auth store
   behaves as empty (`auth-store.ts:50-62` catch → `{}`), so env-only
   determination applies and a shared-env moonshot pair is dropped (no
   resolution) — correct, but now stated. A *stored* key is authoritative
   over the shared env var: when exactly one moonshot family has a stored
   key, that family decides regardless of the env var.

### 3.2 D2 — Startup resolution

Where the current chain lives (`cli.ts:47–61`):

```
requested = -m / --model  >  IMP_MODEL  >  project settings.defaultModel
            (trusted only)  >  global settings.defaultModel  >  builtin
```

`defaultModel()` becomes (or is paired with) a source-aware resolver
returning `{ model: string | undefined; source: "cli" | "env" | "project" | "global" | "builtin" }`
— P7's seam: the builtin rung is the only "nobody asked" source, and the
shape already tolerates `model: undefined` for the post-removal world.

Resolution step (D2 runs at the CLI boundary before runner
construction; D3 runs inside the runner after restore — R1-A-F1):

```
0. blank/empty effective id (§5)              → no resolution; existing path
a. effective model's family usable?           → use it            (P3: no change)
b. source is cli/env/project/global?          → do not override   (P5; copy per D6)
   (explicit -m also outranks the saved row on -c/-r → D3 skipped)
c. builtin source, families (D1) == 1         → use that family's switchHint
   (resume/restore path per D3/OPEN-1: same, when no explicit -m)
d. otherwise                                  → no resolution; copy per D6
```

Wiring (R1-A-F1): the CLI-level rewrite covers the NON-resume path only.
Resolve in `cli.ts` **before** runner construction (both `runInteractive`
and the print path call `runnerOptions()` with `opts.model`; rewriting
`opts.model` there keeps the runner type surface untouched).
`modelExplicit` stays false. The resume path (`-c`/`-r`) is decided
inside the runner, because the saved `session_model` row outranks
`opts.model` (`restoreModelFromSession`, `runner.ts:1134-1135`) — the CLI
cannot know it. The resolved model then flows through warmup's existing
gates naturally:

- `modelUsable()` true → banner/footer/renderers show it; `seedModel`
  (sites `runner.ts:644`, `:806`, `:1147`) proceeds as for any usable
  model (pending, explicit:false — P4);
- `noteModelCredential` (`runner.ts:1079`) does not fire (family
  configured); a new one-line resolution note is emitted instead (D6).

Announcement (interactive only; print mode resolves silently — stdout
byte contract):

```
▪ no startup model configured — using zai/glm-5.3
  (only configured provider; /model to change, /settings defaultModel to keep)
```

(One line in practice; exact bytes pinned at review, OPEN-5.)

### 3.3 D3 — Resume/continue path (OPEN-1)

`-c`/`-r` restores the session's recorded model; if that family no longer
holds a credential, today the user sees `no model — /login` and the first
message fails at the provider (`restoreModelFromSession`,
`runner.ts:1132–1150`; design doc D4 kept this intentional).

**Recommended [REC]:** apply the same D1/D2 resolution when the *restored*
model is unusable and one credential-source family exists; apply
in-memory only, do **not** rewrite the session's `session_model` row
(that row records what the session actually used; re-deriving on each
startup is deterministic). An explicit startup `-m` outranks the saved row
(`restoreModelFromSession`'s explicit branch) — D3 never applies then
(R2-A-N1).

Implementation requirement (R1-A-F2): no existing store call achieves
"apply in memory without writing" — `seedModel` no-ops once a model row
exists (`store.ts:297-298`), `setModel` always writes an
`explicit:true` record (`store.ts:301-305`). The runner needs an
apply-only internals path (the `prepareModel`/`applyModel` pair invoked
without the store call) and this divergence contract must be stated as
intentional, not accidental:
- the session file keeps the recorded (now-unusable) model;
- each startup re-derives the resolved model deterministically;
- `imp sessions` may show the recorded (stale) model for such sessions;
- `-c` re-derivation is the behavior (no one-shot row rewrite).

Note:

Print-mode wording (F3 decision): the D3 note prints in print mode too,
alongside the already-printing `▪ resumed` line (warmup runs deferred in
print mode, after the run starts). D2's resolution remains silent in print
mode (§3.2); "resolution is silent" never covered D3. Pinned end-to-end by
the `-c -p` spawn test.

```
▪ restored model zai/glm-5.3 has no credential — using deepseek/deepseek-v4-pro
  (only configured provider; /model to change)
```

Rationale for inclusion: same "no usable model" predicate as D2, and the
stale-session case (logout, machine move) otherwise dead-ends. If the
reviewer prefers the literal P5 scope (builtin rung only), drop this
decision and keep 0.1.0 behavior — the fresh-install bug is fully fixed
without it.

### 3.4 D4 — Login-time selection

All three success tails of `/login` — codex OAuth (status `:877`, refresh
`:878`, note `:882`), api-key legacy (status `:905`, refresh `:906`, note
`:913`), dialog (status `:959`/`:961`, refresh `:963`, note `:967`) —
today end with:

```ts
ctx.refreshFooter?.();
if (currentFamily !== target.family) ctx.renderer.note(`▪ switch with /model ${target.switchHint}`);
```

New behavior: after the credential is saved, if
`!ctx.runner.modelUsable()` — imp's analog of pi's `isUnknownModel` —
switch instead of teaching, and refresh the footer AFTER the switch
(R1-A-F5: the tails currently refresh first at `:878/:906/:963`; keep
exactly one refresh, after `setModel`, so the footer never renders the
pre-switch state):

```ts
if (!ctx.runner.modelUsable()) {
  ctx.runner.setModel(target.switchHint);   // session_model explicit:true
  ctx.renderer.note(`▪ switched to ${target.switchHint}`);
  ctx.refreshFooter?.();                    // refresh AFTER the switch
} else {
  ctx.refreshFooter?.();                    // usable path keeps today's order
  if (currentFamily !== target.family) ctx.renderer.note(`▪ switch with /model ${target.switchHint}`);
}
```

(R2-A-N2: the usable branch's refresh-then-note order is preserved verbatim
— the earlier snippet had dropped that hint.)

If a usable model already exists, behavior is unchanged (status + the
`switch with /model` hint when families differ) — same "only when none is
selected" rule pi uses. The fourth login surface — the CLI `imp login`
(codex OAuth, `cli.ts:410`) — runs before any runner exists and needs no
switch; it is enumerated here as intentionally untouched (R1-A-F5).

**OPEN-3:** mark the row `explicit:true` (recommended: the login act is an
explicit family choice, the id is the curated switchHint, and title /
resume / model-only session discoverability all benefit) vs `seedModel`
(explicit:false, more conservative but loses the title and `-c` restore).

### 3.5 D5 — Discoverability: the `/settings defaultModel` hint

Explicit `/model` switches stay session-only. After a successful switch
(`switchModel`, `commands.ts:773`) emit one line when all hold:

1. `settingSource(ctx, "defaultModel") === "default"` — reuse the existing
   settings-source helper (`commands.ts:315–330`): no `IMP_MODEL`, no
   project/global `defaultModel` is pinning future sessions.
   Untrusted-project caveat (R1-B-F5): `settingSource` reads project
   settings only when `projectSettingsAllowed` is true
   (`commands.ts:325`), so with `--no-trust` an existing project
   `defaultModel` is invisible and the condition would wrongly pass —
   suppress the hint when project settings are gated off.
2. the picked reference differs from what D2 would resolve anyway (single
   family and ref === its switchHint → suppress; future sessions get it
   regardless);
3. at most once per session: the flag lives on `ReplMachine` (R1-B-F4),
   not `CommandContext` (test fixtures build ad-hoc literal contexts that
   would silently omit a new field and disable the guard) and not module
   state (leaks across tests).

```
▪ /settings defaultModel zai/glm-4.7 keeps this model for new sessions
```

Reachability (R1-B-F3): the hint fires only from `switchModel`
(`commands.ts:773`) — `/model <id>` on both shells and picker picks in
the TUI; the legacy shell's no-args `/model` is a text flow and never
reaches it. The note renders through the shared renderer either way.

### 3.6 D6 — Copy corrections

Current strings (all verified in live runs) and their replacements. Three
states replace today's two:

| surface | today | new: zero families | new: configured, unresolved (>=2) |
| --- | --- | --- | --- |
| banner segment (`repl.ts:105`) | `no model available — run /login to connect one` | unchanged | `no model selected — /model to choose one` |
| short segment (`repl.ts:106`, footer `:861`, title `:946`, resume line `:1594`) | `no model — /login` | unchanged | `no model — /model` |
| runner note (`runner.ts:1079+`) | `▪ no model available — sign in with /login (…) or export <FAMILY>_API_KEY` / targeted `▪ claude-sonnet-4-5 (anthropic) has no credential — run /login anthropic (or /model to pick a configured one)` | unchanged generic note | `▪ claude-sonnet-4-5 (anthropic) has no credential — configured: zai, deepseek — /model to pick one, or /settings defaultModel <id>` |
| print fail-fast (`cli.ts:720–737`) | `imp: claude-sonnet-4-5 (anthropic) has no credential — export ANTHROPIC_API_KEY (see 'imp --help'), or start an interactive session and run /login` | `imp: no model configured — export <FAMILY>_API_KEY (see 'imp --help'), or run /login in an interactive session` | `imp: no startup model — configured: zai, deepseek — pass -m <provider/model> (see 'imp --help'), or set defaultModel (/settings)` |

The explicit-source-unusable case (`-m …` / settings pointing at a
dead family) keeps the existing family-targeted message: it is a user
action, and naming the missing credential is the useful part. Exact
bytes to pin at review (OPEN-5). Resolution-success adds no print-mode
output.

Surface precision (R1-B-F2): footer (`repl.ts:861`) and title
(`repl.ts:946`) exist in the TUI shell only — `setFooter`/`setTitle` are
optional (`line-input.ts:102/:137`) and the legacy readline shell renders
neither. Legacy users see the banner (`repl.ts:1578`) and resumed line
(`repl.ts:1594`) plus `▪` notes; the copy matrix and tests must assert
per-shell surfaces accordingly.

### 3.7 D7 — Seams and forward compatibility

- `credentialSourceFamilies()` lives beside `modelAvailability()`
  (`provider/`) and is probed live like it (one auth-store read + env).
- The resolution helper takes `{ requested?: string; source; … }` and
  returns a resolution or `null`. This is CLI-boundary tolerance only
  (R1-A-F6): a later builtin removal still needs runner-side changes —
  `resolveModel(options.model)` / `parseModelRef(options.model)`
  (`runner.ts:342/:345/:440`), `RunnerOptions.model: string`
  (`cli.ts:90`), and the warmup no-model branches (`runner.ts:629/:643`).
  Listed here so the later milestone budgets them; P7's claim is narrowed
  to match.
- No new env vars, no new files, no settings writes.
- `modelExplicit` untouched; `modelSelectedExplicitly()` false for
  D2/D3-resolved models (title shows the id via the usable branch,
  `repl.ts:946`), true for D4 login selections (OPEN-3).

## 4. Resolution summary (pseudocode)

```
req = sourceAwareChain()        // {model, source}   (undefined-tolerant: P7)
resumeRef = (resume && !modelExplicit) ? restore(saved) : undefined   // D3; -m outranks (R2-A-N1)
eff = resumeRef ?? req
if eff.model.trim() == ""          -> eff (blank: resolution skipped — §5)  # R2-A-N4
if usable(eff)                     -> eff                                # P3
else if resumeRef != undefined      -> D3: resolve-or-teach              # OPEN-1
else if req.source != "builtin"     -> teach (D6 explicit-source copy)   # P5
else:
   fams = credentialSourceFamilies()                                    # D1
   if fams.length == 1          -> switchHint(fams[0]); announce; seed   # D2
   else                         -> teach (D6 unresolved copy)

print mode: identical decision; resolution is silent; only "teach" fails
fast (exit 1, zero session/log writes — fresh-install D3 contract retained).
D3's restore note is NOT covered by "silent": it prints with the warmup
notes (`▪ resumed` precedent).
```

## 5. Edge cases

- Blank ids (`-m ""`, `IMP_MODEL=""`, blank settings values): resolution
  never rewrites them and never treats them as resolvable (R1-A-F3 —
  the earlier "parse-level error" claim was wrong: `cli.ts:722` skips
  only the credential pre-flight, and the sole blank guard is
  `prepareModel`'s runtime throw at `runner.ts:1109`, reached on the
  restore/setModel paths). Existing blank-id behavior is unchanged.
- `--no-trust` (`cli.ts:54`): chain skips project settings as today;
  source accounting follows.
- `--no-session`: resolution still applies (credential-based, not
  session-based); seeding is a no-op.
- Sessions with a saved model: untouched unless D3/OPEN-1 is adopted.
- Injected fake provider (D7 test seam): `usable` → resolution never
  fires → existing suites' pinned bytes do not move.
- Trust: project-settings reads remain gated exactly as today.
- `/logout`: if the current family loses its credential, footer flips as
  today; no auto-switch in this batch (§8).

## 6. Tests (deterministic; env scrubbed + IMP_AUTH_PATH temp)

1. D2: single zai env family, no config → banner/footer show
   `zai/glm-5.3`; resolution note once; session seed explicit:false
   (resume restores it).
2. D2: single zai stored key (IMP_AUTH_PATH) → same.
3. D2: single deepseek / moonshot / openai-codex variant → correct
   switchHint each (table-driven).
4. D1: env-only moonshot pair → no resolution, unresolved copy, D6 list
   shows both families.
5. D1: stored `moonshotai` + env var → resolves `moonshotai/kimi-k3`
   (disambiguation rule pinned).
6. D2 negative: anthropic family configured → builtin usable → byte-stable
   (regression).
7. D2 negative: settings/IMP_MODEL pointing at a usable model →
   byte-stable.
8. P5: settings/`-m` pointing at a dead family → no override, targeted
   copy unchanged.
9. D2: multi-family (zai+deepseek), no default → no resolution, new
   banner/footer/note copy pinned.
10. Print: single family → runs (no pre-flight error, no session/log
    write regression for the failure path); zero families → new zero
    copy, exit 1, zero files; multi → new multi copy, exit 1, zero files.
11. D4: `/login` with unusable current model → auto-switch + status/note;
    session row per OPEN-3; with usable current model → unchanged.
12. D4: login then `-c` restores the switchHint (if OPEN-3 = explicit).
13. D5: hint appears once; suppressed when settings/env pins a default;
    suppressed when ref === single-family switchHint.
14. D3 (if adopted): `-c` stale model + unique family → resolved + note,
    session row NOT rewritten; usable restore → unchanged.
15. Title segment: auto-resolved model shows the id despite
    `modelSelectedExplicitly() === false`.
16. Copy matrix (R1-B-F2): three states × surfaces, pinned per shell —
    TUI: banner / footer / title / resumed line; legacy: banner /
    resumed line / notes only (no footer or title).

Added in rev2 (round-1 findings):
- Blank-id cases stay on the existing path; resolution no-ops — see §5.
- R1-B-F7 extras: resolved-model session listing in `imp sessions`
  (title / `(model: …)` behavior); subagent child-model binding inherits
  the resolved model (cross-family override rejection unchanged);
  usage/pricing identity for a D2-resolved model (`modelReference` =
  resolved `provider/modelId`); print `-p` with `-c` (pre-flight skip
  rule unchanged) and with `--no-session`; openai / openai-codex family
  variants of D2; D5 suppression under `IMP_MODEL` (env shadow) and
  with project settings gated off (R1-B-F5).

Existing tests whose pinned bytes move (R1-B-F1; line refs at base
`bae428e`):
- `test/fresh-install-hint.test.ts:88, 111, 113, 130, 148, 153, 256,
  278, 375, 392, 427`
- `test/repl-tui.test.ts:1548, 1567, 1599, 1624, 1651, 3592`
- `test/repl-commands.test.ts:1708, 1760`
- `test/login-dialog.test.ts` pins none of the moving strings — D4
  coverage there is additive.
These are the acknowledged update surface; anything else that moves is a
regression the implementation must catch with a knowingly-diffed suite.

## 7. Docs to update on implementation

- `README.md:51–54` (the "No credentials yet?" paragraph) — add the
  resolution behavior in one sentence.
- `design/fresh-install-model-hint-design.md` — D2 note text superseded for
  the configured-elsewhere case; D3 print text variants.
- `design/session-model-restore-design.md:15-16` ("No model discovery or
  credential-driven fallback occurs") — amended **regardless of OPEN-1**
  (R1-B-F6): D2 is itself a credential-driven resolution; the amendment
  narrows the clause to "no *invented* model; resolution only under the
  §3.1/§3.2 uniqueness and source rules".
- `CHANGELOG.md` under `[Unreleased] → Changed`.

## 8. Out of scope (explicitly deferred)

- **Last-pick memory** (the earlier "step 4"): a persistent record of the
  user's last explicit pick, consulted before D1. Needs its own design
  (settings surface + precedence amending session-model-restore).
- **Removing the builtin default**: P7 keeps the door open; the deletion
  is a separate milestone with a type-level no-model state (pi's
  `Model | unknown` shape).
- Picker "Ctrl+S save as default" (pi parity; needs `select()` API work).
- Multi-provider auto-pick by table order (pi's `findInitialModel` step
  4): rejected for now — silently choosing among the user's providers.
- `/logout`-triggered re-resolution; `/model` switches to unconfigured
  families (explicit user action domain).

## 9. Open decisions for the reviewer

- OPEN-1 (§3.3): include the resume path? [REC: yes, in-memory, no row
  rewrite]
- OPEN-2 (§3.1): moonshot disambiguation as specified (stored key
  disambiguates; env-only ambiguous)? [REC: yes]
- OPEN-3 (§3.4): login selection marks explicit:true? [REC: yes]
- OPEN-4 (§3.5): RESOLVED in rev2 — the flag lives on `ReplMachine`
  (R1-B-F4); round 2 to verify.
- OPEN-5 (§3.6): RESOLVED at implementation — exact bytes pinned in
  §10.2 and in `test/startup-model-resolution.test.ts`.
- OPEN-6 (§3.2): resolution note once per process (yes) and its exact
  bytes; print-mode silence.
- OPEN-7 (§3.2): source-aware chain shape — extend `defaultModel()` or a
  new `resolveRequestedModel(argv)` in `cli.ts`.

Review round 1 (2026-09-28, two independent fresh-context tracks, both
FIX-FIRST — all findings folded into rev2):
- Technical track F1–F6: resume wiring must live in the runner (F1);
  apply-only path underspecified (F2); blank-env misclassification (F3);
  moonshot corrupt-store/authority statements (F4); login footer ordering
  + fourth login surface (F5); P7 overstatement (F6).
- Copy/tests track F1–F7: existing-pinned-bytes inventory (F1); legacy
  shell surface precision (F2); D5 reachability (F3); once-per-session
  state host (F4); untrusted-project suppression (F5);
  session-restore amendment wording (F6); missing test cases (F7).
Round 2 (2026-09-28, two independent fresh-context tracks): technical
track FIX-FIRST — all six round-1 findings CLOSED; four new findings
folded in rev3: resume pseudocode ignored `-m`'s outrank (A-N1), the D4
replacement snippet dropped the usable-case `switch with /model` hint
(A-N2), tail line refs reconciled (A-N3/B-N1), blank-id guard made
explicit in the algorithm (A-N4). Copy/tests track APPROVE — all seven
round-1 findings CLOSED; two P3 notes (footer-cell wording; print
fail-fast refs to confirm before pinning OPEN-5 bytes).
Round 3 (2026-09-28, narrow verification): APPROVE — all four rev3
fold-ins CLOSED (resume explicit-`-m` guard; D4 snippet keeps the
usable-branch hint and today's order; tail line refs reconciled;
blank-id guard explicit and consistent with §5). No new material
findings. One P3 path-prefix cosmetic (some `commands.ts:` citations
omit `src/repl/`) — accepted as-is (consistent within the doc).
Design review closed.

## 10. Implementation log

### 10.1 What landed (commit `5f0d56f`, 2026-09-28)

- `src/provider/startup-model.ts` (new): D1 `credentialSourceFamilies()`
  (moonshot pair collapse: stored key authoritative, env-only ambiguous),
  `resolveStartupModelFallback()`, and the pure `decideStartupModel()` table.
- `src/provider/model-availability.ts`: exported `configuredFamilies()`.
- `src/cli.ts`: the chain is source-aware (`requestedModel()` returning
  {model, source}; `-m` → "cli"); `decideStartupResolution()` wires the
  decision to the live probe; runInteractive resolves + notes (deferred
  with the other startup notes), print pre-flight resolves silently and
  fails with the new D6 zero/multi copy otherwise.
- `src/runner.ts`: `hasConfiguredProviders()`; D3 in
  `restoreModelFromSession` (in-memory only, row untouched; the resolution
  note prints before the resumed line — implementation choice); the four
  copy constants + `noModelText()` (single source); the D6
  configured-elsewhere note text; resumed-line copy picker.
- `src/repl/commands.ts`: `loginSelectionTail()` (D4, all three REPL login
  tails; the CLI `imp login` path needs nothing — auth precedes any
  runner); `maybeNoteDefaultModelHint()` (D5, once per session, settings
  source "default" only, suppressed while project settings are gated off
  with a project settings file present, suppressed when the pick equals
  the resolvable switchHint); the three inline "no model — /login" surfaces
  (/resume note, legacy /model text, /status) use the copy picker.
- `src/repl/repl.ts`: `hintState` lives on the ReplMachine (shared into
  every per-line CommandContext); banner/footer/title/resume-line copy
  picker; the two legacy constants re-export from the runner module.
- Tests: `test/startup-model-resolution.test.ts` (20 cases, incl. two
  CLI-spawn e2e: silent print resolution and the interactive pipe note);
  `test/cli-model-explicit.test.ts` updated for the source-aware chain
  (+1 provenance case); `test/fresh-install-hint.test.ts` updated for the
  D6 note/print copy and the D3-resolved resume behavior (the F2 pin holds
  in corrected form: no anthropic row — the resolved zai row is seeded).

Implementation notes / deviations recorded:
- D3 applies to interactive `/resume` as well (same function), not only
  `-c`/`-r`.
- `hintState` absent in a CommandContext → the D5 hint is suppressed
  (dispatch fixtures stay byte-stable); production always wires it.
- The D6 note lists `availability.configuredFamilies` (families, not
  source-collapsed) — an env-only moonshot setup lists both.

### 10.2 OPEN-5 pinned bytes

```
resolve note:  ▪ no startup model configured — using zai/glm-5.3 (only configured provider; /model to change, /settings defaultModel to keep)
D3 note:       ▪ restored model zai/glm-4.7 has no credential — using deepseek/deepseek-v4-pro (only configured provider; /model to change)
D4 note:       ▪ switched to zai/glm-5.3
D5 note:       ▪ /settings defaultModel zai/glm-4.6 keeps this model for new sessions
D6 note (>=2): ▪ claude-sonnet-4-5 (anthropic) has no credential — configured: zai, deepseek — /model to pick one, or /settings defaultModel <id>
segments:      no model selected — /model to choose one  ·  no model — /model   (configured, unresolved)
               no model available — run /login to connect one  ·  no model — /login   (zero credential sources, unchanged)
print zero:    no model configured — export <FAMILY>_API_KEY (see `imp --help`) or run /login in an interactive session
print multi:   no startup model — configured: zai, deepseek — pass -m zai/glm-5.3 (see `imp --help`), or set /settings defaultModel
```

### 10.3 Gates

typecheck 0 · lint 0 · build ok · 119 files / 2278 tests passed
(implementation review pending).

### 10.4 Implementation review (round 1, 2026-09-28, independent fresh context)

Verdict FIX-FIRST — all findings folded; gates then 119 files / 2281 tests.

- F1 (P2, fixed): the print zero/multi copy keyed off the source-collapsed
  family set, so an env-only moonshot pair (one credential, two families)
  printed "no model configured" — false. `printNoModelText()` now counts
  configured FAMILIES; pinned by a spawn test.
- F2 (P3, fixed): D5's gated-off-project suppression triggered on mere file
  presence; it now reads the untrusted file and suppresses only when it
  actually carries a `defaultModel` (unreadable → conservative suppress).
- F3 (P3, fixed): D3 no longer resolves the interactive `/resume` fallback
  reference when it came from an explicit startup `-m`
  (`mayResolve = !explicit && !fake && (saved !== undefined || modelExplicit !== true)`);
  pinned by a test.
- F4 (P2, closed): §6 rev2 coverage obligations — (a) subagent child-model
  binding asserted on the D3-resolved reference, (b) usage identity
  (`provider/modelId` stamp) asserted on a resolved-style reference with a
  scripted provider, (c) `imp sessions` titles for auto-resolved sessions:
  accepted gap — resolution only changes WHICH model is seeded; the seeding
  mechanics are covered by the existing session tests.
- F5 (P3, fixed): the D3 test now asserts the resolution note precedes the
  resumed line.
- F6 (P3, no action): copy/doc alignment remark only.

### 10.5 Implementation-review round 2 (narrow verification, 2026-09-28)

Verdict: all five fixes CLOSED (F1 moonshot family truth, F2 parse-based
suppression, F3 -m guard, F4a/F4b assertions, F5 ordering). One low finding
folded: the F2 fix's changed direction (gated-off file WITHOUT defaultModel
→ hint must appear) is now pinned by the extended D5 test. Accepted remark:
the F4b stamp test exercises the resolved-STYLE reference through the
scripted-provider path (not a literal D2/D3 state) — recorded, no action.
Gates: typecheck 0 · lint 0 · build ok · 119 files / 2281 tests.
(Correction, user-side review F1: the typecheck claim was produced with the
app-config tsc only — `tsconfig.test.json` failed at the time; corrected
and re-run in §10.6.)

### 10.6 User-side review (2026-09-28) — findings folded

Independent review of the whole branch against main returned FIX-FIRST.
All findings handled; final gates: `npm run typecheck` (BOTH configs) 0 ·
lint 0 · build ok · 119 files / 2288 tests.

- F1 (BLOCKING, fixed): `test/startup-model-resolution.test.ts` failed
  `npm run typecheck` — the assistant-message narrowing lacked the role
  check (tsconfig.test.json; the earlier gate claim had used the app
  config's tsc alone). Fixed; gate rule recorded: both configs are the gate.
- F2 (fixed): `-c`/`-r` with NO resumable session skipped the CLI decision
  and fell back to the dead builtin — the exact wrong-family pointer this
  milestone removes. `resumingExistingSession()` now consults
  `resolveSession` (and treats `--no-session` as a fresh start), so D2
  applies when nothing is restored; D3 keeps owning real restores. Pinned
  by print + interactive-pipe spawn tests. Expectation moved in
  `test/fresh-install-hint.test.ts` (round-2 F3 test): `-c --no-session -p`
  now fails fast with the zero-family text instead of the provider error.
- F3 (decided + pinned): the D3 note prints in print mode (see §3.3 note);
  `-c -p` pinned end-to-end.
- F4 (coverage, closed): stored-key e2e, `-c`-no-session e2e (print +
  pipe), `-c -p` pin, multi-state legacy `/model` text + `/status` + banner
  composition + resumed-line pins added. Residual (recorded): the TUI
  footer/title call sites share the identical `noModelText(…, true)`
  expression and have no surface test (the TUI harness is heavy); the pure
  mapping + runner probe tests stand in.
- F5 (fixed): `printNoModelText` now counts `configuredFamilies()` outright —
  the mixed zai + env-only-moonshot case lists all three families.
- F6 (fixed): the D3 note says "restored model …" only when a row was
  restored; the no-row fallback names the dead reference plainly. The no-row
  pending seed is the documented, intended divergence corner.
- F7 (fixed): stale header/log lines and the incorrect gate claim corrected
  (above).
