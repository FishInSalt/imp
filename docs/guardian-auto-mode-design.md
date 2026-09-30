# guardian auto mode — classifier-assisted approval (design)

Status: **DRAFT — awaiting independent adversarial review (round 1).**
Branch: `design/guardian-auto-mode`. Base: `1d097a0` (main).

The owner experienced Claude Code's auto-approval and asked for the same shape
in imp: *let a model judge first, hand only the suspicious calls to the human*
(“让模型先判一轮，只把可疑的递给你”). This document specifies the batch.

## 0. Owner decisions (locked in conversation)

| # | Decision |
|---|---|
| D1 | Reference implementation is Claude Code 2.1.88's **auto mode / YOLO classifier** (§10.1). |
| D2 | Model: **session model by default**, overridable — but through **guardian's config file**, not an environment variable. The override is **global-only**; a project config may only tighten (never pick the model). |
| D3 | Switch: the **`/guardian` command** (no args toggles; with an arg sets). Custom keybindings are **deliberately deferred** — every imp binding is host-owned and context-gated; a keybinding seam is its own batch. |
| D4 | Two modes, **manual is the default**. Manual = today's behavior, byte for byte. |
| D5 | User-defined filter rules (Claude Code's allowlist analog) are **Phase B**, layered *below* the classifier; Phase A ships mode + classifier + minimal config. |
| D6 | Exactly **one new host seam member** (`api.classify`). Policy stays with the extension; model resolution, auth, accounting (deferred in Phase A — §11.5), timeouts and the audit record stay with the host. |
| D7 | Phase A verdict set is `{allow, ask}` — **the model cannot write the block path**; blocking stays with the deterministic floor. |
| D8 | Failure posture is **fail-to-ask**: every classifier failure falls back to the human prompt; a host without an interactive prompt never serves the seam at all, so non-interactive runs keep today's block behavior. |
| D9 | The verdict record is a property of the **seam call**, not of the extension's next action: the transcript shows the consultation and the verdict even if the extension then does something else. |
| D10 | Circuit breaker: N=3 consecutive non-`allow` results flip the session back to manual. |

## 1. Context

Today (see `docs/m4-extensions-design.md` §13.1) guardian has two tiers in one
`tool_call` handler: a hard floor that blocks without asking, and an ask tier
that calls `api.confirm(...)` for every matched risky command. The human is the
only decision-maker on the ask tier.

The goal is to insert a model judgment *between* the rule match and the human:

```
floor hit ────────────────────────────────► block (never classified)
matched + manual ─────────────────────────► confirm (today, unchanged)
matched + auto    ─► classify ─ allow ────► run (recorded)
                      │           ask ─────► confirm, classifier's reason attached
                      └ unavailable ──────► confirm (fail-to-ask, recorded once per session)
```

imp's extension API deliberately has no model access
(`src/extensions/types.ts:88-89`: “three read-only facts, three registration
methods, one subscriber, one ask-the-human method — **eight members**.
Anything an extension cannot do with this, it cannot do.”). This batch grows it
to **nine**, with one purpose-built member, and amends that docstring **and**
the stale prologue in `docs/m4-extensions-design.md:227` (“Seven members
total”) — a reader will trip on the older count otherwise.

## 2. Ownership

The existing three-way split still governs:

- **Invariants → host**: credentials, provider auth, accounting *when it lands*
  (Phase A defers it — §11.5), timeouts, output-contract enforcement,
  sanitization, the audit record, and — critically — whether the seam exists at
  all on a given surface (D8).
- **Policy → extension**: which calls get classified, what the classifier is
  asked, what each verdict means, the mode state, the breaker.
- **Rendering → host**: record lines go through the existing `▪` note channel
  and the host-owned caller label (D9 of the confirm-prompt design, `loader.ts:233`).

Why not let the extension call the provider directly: extension code holding
credentials, choosing models and spending tokens with no accounting is exactly
the “zero-injection” line this project drew earlier. The seam inverts it: the
extension supplies *the question*, the host supplies *everything else*.

## 3. Decision layers

| Layer | Phase | What it can do | Deterministic? |
|---|---|---|---|
| 0. Hard floor | today | block, no ask, no classifier | yes |
| 1. User rules (config) | B | allow / ask / block by pattern; `allow` skips the classifier, `block` never reaches it | yes |
| 2. Classifier (auto only) | A | `allow` → run; `ask` → human | no (model) |
| 3. Human prompt | today | final say | — |

Phase A implements layers 0, 2, 3. Layer 1 is specified in §9.2 but not built
first: it has its own surface (pattern syntax, validation, project tightening)
and must not hold up the classifier core.

## 4. The host seam: `api.classify`

### 4.1 Contract

```ts
export interface ClassifyRequest {
  /** The extension's policy framing (system message). Strategy is the extension's. */
  system: string;
  /** What to judge (one user message): the candidate action and its context. */
  prompt: string;
  /** Optional provider/model reference; absent → the session model.
   *  The host resolves it (auth, availability); an unresolvable reference
   *  falls back to the session model (noted in the record). */
  model?: string;
}

export interface ClassifyResult {
  verdict: "allow" | "ask";
  /** One line the host renders (and the extension may attach to a prompt). */
  reason: string;
  /** The reference actually used, for the record. */
  model: string;
}

api.classify(request: ClassifyRequest): Promise<ClassifyResult | undefined>;
```

Semantics, following `api.confirm`'s promises:

- **Never throws, never hangs.** Every failure is `undefined`.
- `undefined` means *unavailable* — the extension's contract is to fall back to
  asking the human (fail-to-ask is the extension's obligation, but the seam
  makes it the only sensible reading: there is no third state).
- Usable at runtime from event handlers (like `confirm`/`setStatus`), not gated
  to load time. Callable concurrently (stateless, per-call abort).

### 4.2 Host-side behavior

| Step | Behavior | Anchor |
|---|---|---|
| Request assembly | `system` = extension text + a host-appended, unchangeable output contract; `messages` = one user message from `prompt`; `tools: []`; `maxTokens` = host constant (draft: 400); no thinking | mirrors the compactor's one-shot call: `src/core/compaction.ts:397-423`, request shape `src/provider/types.ts:19-34` |
| Input caps | combined `system`+`prompt` capped at a host constant (draft: 8 KB); over-cap ⇒ `undefined` (no silent truncation of policy text) | new constant |
| Model resolution | `request.model` → `resolveModel()` (`src/provider/resolve.ts:126`); invalid/unavailable ⇒ session model, and the record says so | |
| Timeout | host `AbortController` + wall-clock constant (draft: 10 s). The provider layer has no *wall-clock* timeout of its own, but abort plumbing exists (`LLMRequest.signal`, `src/provider/types.ts:32`; honored in `anthropic.ts:220,248`) — the seam drives it. Test fakes must resolve/reject on `signal.abort`, mirroring `abortSafe` (`src/provider/shared.ts:31-35`) | |
| Output contract | host appends: reply with exactly one JSON object `{"verdict":"allow"|"ask","reason":"<one sentence>"}` | new |
| Defensive parse | first JSON object; `verdict` strictly `allow`/`ask` (anything else, incl. `block`, is invalid); `reason` string, capped (draft: 200 chars) and run through `sanitizeDisplay` | `src/repl/tool-presentation.ts:14` |
| Any deviation | garbage, refusal, empty, truncated, provider error (including a configured reference whose provider has no usable credentials — resolution succeeds, the call fails), timeout, aborted ⇒ `undefined` | |
| Accounting | **Phase A: no ledger attribution — documented limitation.** The session totals tracker derives from append-only session entries (`src/core/usage-totals.ts:219`), and per-attempt buckets are fixed (`AttemptUsage.task/summarizer`, `src/core/usage-ledger.ts:17-30,59`); the seam's call has no entry kind, so a classifier bucket is a follow-up (§11.5). The record line still names the model actually used | |
| Audit record | on success: one record line (draft wording in §7); on failure: one line per session (first failure only), then silent | `▪` note channel |

The host does **not** expose: provider choice beyond the reference string,
streaming, tool use, thinking, retries beyond the provider layer's own, or the
raw response text. The seam is one question in, one verdict out.

### 4.3 Serving and injection — the free degradation (D8)

`api.confirm` is injected by the surface: `src/cli.ts:540` builds the confirm
host for **any interactive session** (`interactive ? new TtyConfirm(renderer)
: undefined`) and passes it at `:593`; print mode passes `undefined`
(`cli.ts:1005`). `classify` follows the same pattern, in **both interactive
shells**:

- **Interactive — TUI *and* the legacy readline shell.** The legacy shell has a
  real `[y/N]` prompt (`repl.ts:319`), so by I3 it must serve the seam. The
  classify handler is created the same way as the confirm host, beside it in
  the repl layer — which is also where `sanitizeDisplay` lives
  (`src/repl/tool-presentation.ts:14`), so no module move is needed. The
  classifier itself prompts nobody: only the *fallback* differs between TUI
  (picker) and legacy ([y/N]); records go through `renderer.note` on both.
- **Non-interactive — print mode (`cli.ts:1005`) and test harnesses.** Nothing
  is passed; `api.classify` returns `undefined` without touching the network —
  so auto mode on a non-interactive host degrades to today's behavior exactly
  (classify unavailable → confirm → false → block).

This is the design's cheapest safety property: a headless `imp -p` run can
never auto-approve, no matter what the config says.

### 4.4 The record is a property of the call (D9)

The host writes the verdict record when the call completes, before the
extension returns its decision. The extension cannot suppress it, and cannot
make the transcript claim a verdict the model did not give. (An extension can
still ignore an `ask` verdict and run the tool — that power is inherent to
`tool_call` handlers; what the seam guarantees is that the *consultation and
verdict are on the record*. This is the same honesty principle as D9 of the
confirm-prompt design: the host names what the host saw.)

### 4.5 Concurrency and mid-flight changes

- An in-flight classify call keeps the parameters it started with; a mode flip
  or `/guardian reload` applies to the next gated call only (the mode and the
  breaker are read before the call).
- A classify call can overlap an open confirm picker (e.g. a child run's
  gated call while the parent's picker is up). Records write through the `▪`
  note channel — the same channel confirm's own record uses before its picker
  appears — so the seam introduces no new selector interaction.
- The config file is **read-only** in Phase A (no “remember” feature), so
  symlinks and ownership are a non-issue; reads follow the OS.

## 5. The guardian consumer

### 5.1 Mode state

Session-scoped `manual | auto`; initial value from config (§5.2, default
`manual`). Not persisted by the command (a future explicit “remember” is not
part of this batch).

### 5.2 Config file

Phase A reads one file, **global only**: `~/.imp/guardian.json`.

```json
{
  "auto": {
    "mode": "manual",
    "model": "anthropic/claude-haiku-4-5"
  }
}
```

- `auto.mode` — startup mode (`manual` default; `auto` opts in globally).
- `auto.model` — provider/model reference for classify calls; absent ⇒ session
  model. Invalid values ⇒ session model + one diagnostic line at load.
- The file is read at extension load and by `/guardian reload`.
- Tolerance follows guardian's standing philosophy: unreadable/invalid JSON ⇒
  defaults + one diagnostic, never fatal, the gate stands.
- **Global-only by construction** (D2): Phase A has no project file at all.
  Phase B (§9.2) introduces `.imp/guardian.json` restricted to tightening keys
  (force manual, add block/ask rules); it can never set `model` or `mode: auto`.
- The existing `IMP_GUARDIAN_BLOCK` env var keeps working unchanged.

### 5.3 `/guardian` command

| Invocation | Effect |
|---|---|
| `/guardian` | toggle manual ⇄ auto |
| `/guardian auto` / `/guardian manual` | set the mode |
| `/guardian status` | report mode, model (resolved), breaker state, config path |
| `/guardian reload` | re-read the config file, report what changed |

Registered via `api.registerCommand` (`src/repl/commands.ts:129-137` — `run(args)`
carries the argument string). Allowed during runs (a local state flip; it
affects the *next* gated call). Every change writes a record line (§7) and
updates the footer via `setStatus` (`guardian: auto` / `guardian: manual`;
cleared while manual to keep the footer quiet — draft).

### 5.4 Call site

Inside the existing **bash** ask tier (`guardian.mjs:225`), replacing its
unconditional `await api.confirm`. The write/edit tier (`:246`) keeps its
unconditional confirm in Phase A (§9.1) — the mode check is added only to the
bash branch:

```
if (mode === "manual")            → confirm (today's code path, untouched)
else (bash ask tier only):
  verdict = await api.classify({ system, prompt, model: config.model })
  undefined → confirm(detail + "\nclassifier unavailable")     [breaker counts]
  ask       → confirm(detail + "\nclassifier: " + reason)      [breaker counts]
  allow     → return undefined (run)                            [breaker resets]
```

The hard-floor branch (`guardian.mjs:192-193` for bash; `:241-242` for
write/edit) is untouched and never reaches this code.

### 5.5 What the classifier sees

In `prompt` (ordered):
1. `cwd: <caller cwd>` (M6b — children resolve against their own worktree);
2. `subagent: true` when the call comes from a child (`event.subagent`);
3. the matched rule's teaching reason (guardian already holds it);
4. the candidate command, verbatim.

In `system` (extension-authored policy): what guardian is, that a human is
always available as the fallback, that `ask` is the safe answer under
uncertainty, and that the floor is not the classifier's business.

**Withheld**: the conversation transcript, file contents, the audit log, and
any other tool calls. (The event carries none of these; the design keeps it
that way deliberately — the command text still leaves the machine to the
user's own configured provider, which is inherent to the feature; the memo
should say so in the config docs.)

### 5.6 Circuit breaker (D10)

Count consecutive non-`allow` results (`ask` or unavailable). On the 3rd:
flip the session to manual, write a record line, update the status. Any
`allow` resets the counter. Rationale: when the classifier is not helping
(repeatedly unsure, or broken), stop paying for it and put the human back in
the loop.

### 5.7 Audit log

`~/.imp/guardian.log` gains one line per auto decision: timestamp, tool,
verdict, model, first line of the reason. Blocked/error lines keep their
current format (append-only, never fatal — unchanged contract).

## 6. Invariants

| # | Invariant | Why |
|---|---|---|
| I1 | The floor branch **precedes** the classifier branch and returns before any classify call can happen (`guardian.mjs:192-193` bash; `:241-242` write/edit). The seam cannot enforce this — it is a property of guardian's code shape, pinned by test 10. | A model must not be able to talk the gate out of `/etc`, `~/.ssh`, home-root rm. |
| I2 | Any classifier failure ⇒ ask the human. No fail-open path exists in any branch. | The feature's purpose is to reduce interruptions, not to remove the human. |
| I3 | A surface without an interactive prompt (print mode, test harnesses) does not serve the seam. The legacy readline shell **is** interactive (its `[y/N]` prompt) and therefore does serve it. | Headless runs keep today's block behavior; “auto” can never mean “unattended allow”. |
| I4 | Phase A verdicts are `{allow, ask}`; the model cannot block. | A hallucinating classifier must not silently kill legitimate work; blocking stays deterministic. |
| I5 | The verdict record is written by the host at call completion, before the extension's decision is known. | Auditability is a property of the seam, not of extension good behavior (D9). |
| I6 | Manual is the default; mode changes are explicit, recorded, session-scoped. | A feature that loosens a gate must be opted into, visibly. |
| I7 | The classifier sees only what §5.5 lists. | Privacy surface stays bounded and explainable. |

## 7. User-visible surfaces (drafts — owner eyeballs these at acceptance)

| Event | Draft record line |
|---|---|
| auto allowed | `▪ guardian (auto) — classifier allowed: <reason>` |
| auto asked | today's `▪ confirm: guardian — …` + detail line `classifier: <reason>` |
| classifier unavailable | `▪ guardian (auto) — classifier unavailable (<why>); asking` (first per session only) |
| mode change | `▪ guardian: mode → auto` / `→ manual` |
| breaker tripped | `▪ guardian: 3 classifier asks in a row — back to manual` |

The command itself is not repeated in these records: it renders exactly once in
the tool block that follows (same “shown exactly once” rule as the picker).
The footer shows `guardian: auto` while active.

## 8. Tests and pins (red-first)

**Host seam (new test file)**
1. success: fake provider returns the contract JSON ⇒ verdict parsed, record
   line exact bytes;
2. garbage / refusal / truncated output ⇒ `undefined` (each a pin);
3. `verdict: "block"` ⇒ `undefined` (I4 at the seam);
4. timeout ⇒ `undefined` — the fake provider must honor `request.signal`
   (resolve/reject on abort, like `abortSafe`), else the test itself hangs;
5. over-cap input ⇒ `undefined`, provider not called;
6. **non-interactive surfaces never call the provider** (I3: print mode's
   `undefined` injection and test harnesses);
7. resolvable model reference is honored; unresolvable ⇒ session model + record
   notes the fallback;
8. concurrency: two overlapping classify calls do not interleave state;
9. wiring: the classify handler is passed to `loadExtensionSetup` exactly when
   `interactive` — the same condition as `confirm` (`cli.ts:540,593`).

**guardian (existing double grows `classify`)**
10. floor command in auto mode ⇒ classify **never called**, block returned (I1);
11. allow ⇒ no `confirm` call, handler returns undefined;
12. ask ⇒ `confirm` called, reason attached to detail;
13. unavailable ⇒ `confirm` called;
14. breaker: three non-allows ⇒ mode flips to manual, subsequent matches go
    straight to confirm without classify;
15. `/guardian` toggle/set/status/reload; unknown argument ⇒ usage;
16. config: missing file ⇒ defaults; bad JSON ⇒ defaults + diagnostic; model
    passed through to the request; reload picks up edits;
17. the write/edit tier in auto mode still goes straight to `confirm`
    (no classify) — the Phase A scope pin.

**TUI**
18. the record lines of §7 render through the `▪` channel with the caller label
    (frozen-frame pins, like the confirm-prompt batch).

**Mutation checks** (after green): drop the floor short-circuit; make a failure
path return `allow`; remove the breaker; parse `"block"` as allow; skip the
sanitize/cap step — each must turn at least one pin red.

## 9. Phases and non-goals

### 9.1 Phase A (this batch)
Seam + global config + `/guardian` + modes + breaker + the **bash ask tier only**
(`guardian.mjs:225`) + records + tests. The write/edit tier (`:246`) keeps its
unconditional `confirm` (its risk is context-dependent and its prompt shape
differs; adding it later is additive) — pinned by test 17.

### 9.2 Phase B (specified then, not now)
User rules file (`.imp/guardian.json` project file with tighten-only keys;
global `rules` array with `allow`/`ask`/`block`, pattern syntax to be designed),
write-gate classification, possibly a `block` verdict for the classifier.

### 9.3 Not doing
- Custom keybindings (D3) — its own batch if ever; the command carries the
  ergonomics.
- Persisting the mode beyond the config's startup value.
- Env-var model override (D2).
- Any change to manual-mode behavior, to the floor, or to the existing
  `confirm` contract.

## 10. Reference notes

### 10.1 Claude Code 2.1.88 (`/Users/z/Z/claude-code-sourcemap`, unofficial sourcemap restore)
- Auto mode entry: only when the normal pipeline returns `ask` and the mode is
  `auto` (`utils/permissions/permissions.ts:519-522`).
- A real model call (`yoloClassifier.ts:1012`), input = full transcript +
  candidate action + CLAUDE.md + settings-driven rules (`:302-459,484-565`);
  fast paths skip the model (acceptEdits re-check `permissions.ts:596-643`;
  safe-tool allowlist `classifierDecision.ts:56-97`).
- Server-gated (`tengu_auto_mode_config`, default `disabled`, `permissionSetup.ts:1099-1160`),
  **fail-closed** when unavailable (`tengu_iron_gate_closed`, `permissions.ts:845-868`).
- Denial tracking: 3 consecutive / 20 total ⇒ back to prompting
  (`permissions.ts:879-881,995-1002`).
- Entering auto strips dangerous broad rules (interpreters, `Agent`)
  (`permissionSetup.ts:510`). Marked ANT-ONLY in places (`bashClassifier.ts:1`).
- **Borrowed**: the two-layer shape (rules are the deterministic layer, the
  classifier the fallback), the breaker idea, the skip-fast-path idea.
- **Rejected**: fail-closed (imp asks instead — a personal tool should not
  silently block on a classifier outage), full-transcript input (imp's event
  has none and the privacy surface stays smaller), server-side gating (no
  server here).

### 10.2 pi (`/Users/z/Z/Agent_demo/pi`, packages/coding-agent)
- Extensions *do* get model access, host-resolved: `ctx.modelRegistry.complete(model, context, options)`
  (`src/core/model-registry.ts:119`), documented as the way to call models
  (`docs/extensions.md:1021`), with a shipped one-shot example
  (`examples/extensions/summarize.ts:163-190`). The extension picks the model.
- **Borrowed**: host-resolved auth + one-shot shape (imp's classifier mirrors
  it), `hasConfiguredAuth`-style graceful failure (ours: session-model fallback
  + ask).
- **Rejected**: extension-chosen models (D2 puts the model in guardian's config,
  global-only), raw input/big API surface (imp keeps one purpose-built member).
- Config conventions, from the local `permission-gate` v3 extension
  (`/Users/z/Z/pi/permission-gate`, a reference only): global file + project
  file that can only tighten; a `PI_PERMISSION_GATE_HOME`-style override for
  test isolation (ours: `IMP_GUARDIAN_HOME` for tests).

## 11. Open questions (for review round 1 and owner acceptance)

1. Member name: `classify` vs something narrower (`adjudicate`, `judge`)? The
   contract matters more, but the name lands in the permanent API docstring.
2. Record wording (§7 drafts) — owner eyeballs at acceptance, as with the
   confirm-prompt records.
3. Failure-record dedupe: “first per session” (draft) vs every failure vs none?
4. `auto.model` reference syntax — the exact `provider/model` grammar from
   `resolve.ts`, and what “unavailable” diagnostics look like.
5. Cost accounting for classifier calls is deferred: Phase A reports nothing
   (the totals tracker derives from session entries, `usage-totals.ts:219`);
   the follow-up needs a session-entry kind so `/cost`-style surfaces see it.
6. Constants: 10 s timeout, 400 max tokens, 200-char reason, 8 KB input cap —
   all drafts.
7. Does the footer show `guardian: manual` permanently (noise) or only `auto`
   (draft)?
8. **Consulted-and-ignored (R2 review note)**: an extension may receive `ask`
   and run the tool anyway; §4.4 leaves this as inherent extension power (the
   record still shows the verdict). A later phase could record a *mismatch*
   line — the host keeping the last verdict per tool call and comparing it with
   what the handler returned. It catches only the consulted-and-ignored case
   (an extension that never calls classify is unobservable), at the cost of
   per-call host state. Phase B candidate, not Phase A.

## 12. Review log

- R1: **NEEDS REVISION** (8 findings, adversarial, base `1a16b75`). P0: §4.3's
  surface list wrongly claimed the legacy shell is non-interactive — it builds
  the same `TtyConfirm` host (`cli.ts:540,593`) and has a real `[y/N]` prompt
  (`repl.ts:319`), so by I3 it must serve the seam. P1: the accounting claim
  ignored that the ledger is a fixed-shape per-attempt bucket set
  (`usage-ledger.ts:17-30,59`) and the totals tracker derives from session
  entries (`usage-totals.ts:219`) ⇒ Phase A now documents **no attribution**
  plus a Phase-B follow-up; §5.4 now states the mode check is wired into the
  bash ask tier only (the write tier at `:246` stays manual, pinned by test 17).
  P2: I1 weakened to the provable claim (branch order, pinned by test 10); the
  timeout row now exercises the existing `LLMRequest.signal` abort plumbing and
  requires abort-respecting fakes; §4.3 fixes the `sanitizeDisplay` layering by
  placing the handler in the repl layer (no module move). P3: anchors corrected
  (`resolve.ts:126`; `cli.ts:491-493,502,540,593,1005`); both stale member
  counts amended (`types.ts:88-89`, `m4:227`); concurrency/mid-flight, symlink
  and no-auth cases specified (§4.2, §4.5).
- R2: **CONFIRMED WITH NOTES** (2 P3 precision findings + one design opinion).
  N1: floor anchors cited the whole handler, not the floor branches — now
  `:192-193` (bash) and `:241-242` (write/edit) in §5.4/§6. N2: D6 and §2 still
  claimed accounting as a host invariant without the Phase A deferral — both
  now point at §11.5. The opinion (recorded as open question 8): a
  consulted-then-ignored verdict is invisible to enforcement; a “mismatch line”
  is a Phase B candidate. Everything else re-verified against the code.
