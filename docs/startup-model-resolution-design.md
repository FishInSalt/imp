# Startup model resolution (#startup-model-resolution)

Status: rev1 DRAFT — awaiting independent review; implementation not started
Branch: `fix/startup-model-resolution` (worktree, base main `bae428e`)
Date: 2026-09-28
Review log: §9 (round 1 pending)
Implementation log: §10 (empty)

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

- `docs/fresh-install-model-hint-design.md` D2/D3 are built around "show
  the dead default's family and teach login". Their copy
  (`no model available`, `run /login anthropic`) becomes *false* once any
  other family is configured — a model IS available, it is merely not
  selected. This design corrects the copy (D6) and supersedes the D2 note
  text for the configured-elsewhere case.
- `docs/session-model-restore-design.md` ("Runner / CLI") states:
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
  unusable", so the eventual removal of the builtin default is a deletion
  plus a semantic flip, not a rewrite (see §8).

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
3. Result length 1 → resolvable; otherwise → not (§3.2 step 3b/3c).

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

Resolution step (shared by both shells; runs after the chain, after
`-c`/`-r` session-model precedence is known):

```
a. effective model's family usable?           → use it            (P3: no change)
b. source is cli/env/project/global?          → do not override   (P5; copy per D6)
                                              (D3/OPEN-1 may add the resume path here)
c. source is builtin, families (D1) == 1      → use that family's switchHint
d. source is builtin, families == 0 or >= 2   → no resolution; copy per D6
```

Wiring: resolve in `cli.ts` **before** runner construction (both
`runInteractive` and the print path call `runnerOptions()` with
`opts.model`; rewriting `opts.model` there keeps the runner type surface
untouched). `modelExplicit` stays false. The resolved model then flows
through warmup's existing gates naturally:

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
in-memory only (`applyModel`-style), do **not** rewrite the session's
`session_model` row (that row records what the session actually used;
re-deriving on each startup is deterministic). Note:

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

All three success tails of `/login` (`commands.ts:877/882` codex OAuth,
`:905/913` api-key legacy, `:959/967` dialog) today end with:

```ts
ctx.refreshFooter?.();
if (currentFamily !== target.family) ctx.renderer.note(`▪ switch with /model ${target.switchHint}`);
```

New behavior: after the credential is saved and the footer refreshed, if
`!ctx.runner.modelUsable()` — imp's analog of pi's `isUnknownModel` —
switch instead of teaching:

```ts
ctx.runner.setModel(target.switchHint);   // session_model explicit:true
ctx.renderer.note(`▪ switched to ${target.switchHint}`);
```

If a usable model already exists, behavior is unchanged (status + the
`switch with /model` hint when families differ) — same "only when none is
selected" rule pi uses.

**OPEN-3:** mark the row `explicit:true` (recommended: the login act is an
explicit family choice, the id is the curated switchHint, and title /
resume / model-only session discoverability all benefit) vs `seedModel`
(explicit:false, more conservative but loses the title and `-c` restore).

### 3.5 D5 — Discoverability: the `/settings defaultModel` hint

Explicit `/model` switches stay session-only. After a successful switch
(`switchModel`, `commands.ts:773`) emit one line when all hold:

1. `settingSource(ctx, "defaultModel") === "default"` — reuse the existing
   settings-source helper (`commands.ts:315–330`): no `IMP_MODEL`, no
   project/global `defaultModel` is pinning future sessions;
2. the picked reference differs from what D2 would resolve anyway (single
   family and ref === its switchHint → suppress; future sessions get it
   regardless);
3. at most once per session (OPEN-4).

```
▪ /settings defaultModel zai/glm-4.7 keeps this model for new sessions
```

Both shells share `switchModel`, so the note renders through the shared
renderer in either.

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

### 3.7 D7 — Seams and forward compatibility

- `credentialSourceFamilies()` lives beside `modelAvailability()`
  (`provider/`) and is probed live like it (one auth-store read + env).
- The resolution helper takes `{ requested?: string; source; … }` and
  returns a resolution or `null` — usable as-is when the builtin rung is
  later removed (P7).
- No new env vars, no new files, no settings writes.
- `modelExplicit` untouched; `modelSelectedExplicitly()` false for
  D2/D3-resolved models (title shows the id via the usable branch,
  `repl.ts:946`), true for D4 login selections (OPEN-3).

## 4. Resolution summary (pseudocode)

```
req = sourceAwareChain()        // {model, source}
eff = (resume ? restore(saved) ?? req : req)
if usable(eff)                  -> eff                                   # P3
else if req.source != "builtin" -> teach (D6 explicit-source copy)       # P5
else:
   fams = credentialSourceFamilies()                                     # D1
   if fams.length == 1          -> switchHint(fams[0]); announce; seed    # D2
   else                         -> teach (D6 unresolved copy)

print mode: identical decision; resolution is silent; only "teach" fails
fast (exit 1, zero session/log writes — fresh-install D3 contract retained).
```

## 5. Edge cases

- `-m ""` / blank ids: parse-level errors win over resolution (mirror
  `printModelUnusable`'s F7e skip).
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
16. Copy matrix: all three states × banner/footer/title/resume-line
    bytes pinned in the interactive harness (legacy and TUI shells).

## 7. Docs to update on implementation

- `README.md:51–54` (the "No credentials yet?" paragraph) — add the
  resolution behavior in one sentence.
- `docs/fresh-install-model-hint-design.md` — D2 note text superseded for
  the configured-elsewhere case; D3 print text variants.
- `docs/session-model-restore-design.md` — if OPEN-1 adopted, add the
  narrow exception to the "no credential-driven fallback" clause.
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
- OPEN-4 (§3.5): once-per-session hint state — where should it live
  (CommandContext vs ReplMachine)?
- OPEN-5 (§3.6): exact copy bytes for all new strings (pin table before
  implementation).
- OPEN-6 (§3.2): resolution note once per process (yes) and its exact
  bytes; print-mode silence.
- OPEN-7 (§3.2): source-aware chain shape — extend `defaultModel()` or a
  new `resolveRequestedModel(argv)` in `cli.ts`.

Review round 1: pending.

## 10. Implementation log

Empty — implementation starts only after this review closes.
