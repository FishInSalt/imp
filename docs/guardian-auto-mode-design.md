# guardian auto mode — classifier-assisted approval (design)

Status: **rev 3.2 — REVISED, awaiting verification review (R12).** Folds three
second-opinion rounds (R7 provenance/association/shadow samples; R8 the
context-presence channel; R11 the input-boundary and invalidation rules — §12).
Branch: `design/guardian-auto-mode`. Base: `1d097a0` (main).

The owner experienced Claude Code's auto-approval and asked for the same shape
in imp: *let a model judge first, hand only the suspicious calls to the human*
(“让模型先判一轮，只把可疑的递给你”). This document specifies the batch.

## 0. Owner decisions (locked in conversation; D4/D8 amended by R4)

| # | Decision |
|---|---|
| D1 | Reference implementation is Claude Code 2.1.88's **auto mode / YOLO classifier** (§10.1). |
| D2 | Model: **session model by default**, overridable — through **guardian's config file**, not an environment variable. The override is **global-only**; a project config may only tighten (never pick the model). |
| D3 | Switch: the **`/guardian` command** (no args toggles; with an arg sets). Custom keybindings are **deliberately deferred**. |
| D4 | **Three modes — `manual` (default), `shadow`, `auto`** (shadow added in R4). Manual = today's behavior, byte for byte; shadow = classify + record, the human still decides; auto = the classifier may allow. |
| D5 | User-defined filter rules (Claude Code's allowlist analog) are **Phase B**, layered *below* the classifier; Phase A ships modes + classifier + minimal config. |
| D6 | Exactly **one new host seam member** (`api.classify`). Policy stays with the extension; model resolution, auth, accounting (deferred in Phase A — §11.5), timeouts and the audit record stay with the host. |
| D7 | Phase A verdict set is `{allow, ask}` — **the model cannot write the block path**; blocking stays with the deterministic floor. |
| D8 | Failure posture is **fail-to-ask**; in **auto mode** every fallback (`ask` / unavailable / manual-only) is a **fresh** confirmation with no session-memory reuse (D13), and **shadow's evaluation path is fresh too** (D16) — its samples must be real human judgments. Manual keeps today's confirm options. A host without an interactive prompt never serves the seam, so non-interactive runs keep today's block behavior. |
| D9 | The verdict record is a property of the **seam call**, not of the extension's next action. |
| D10 | Circuit breaker: N=3 consecutive non-`allow` results flip the session back to manual (auto mode only). |
| D11 | **Positioning (R4 #1; amended by R7 #1 and R11 #1)**: task-aware with **provenance-verified** context — the host's **user-input log**. **Capture point (R11 #1)**: the human submission boundary *before* any dispatch — `handleLine` (`repl.ts:442`, the funnel both shells wire their input to: TUI `:1606`, legacy `:1622`) and the steering/follow-up queues. The log records the raw submission (typed text verbatim; a slash-command/skill invocation as `/<name> <args>`), **never expansion products**: command- and skill-file bodies reach the model via `submitPrompt`→`enqueuePrompt`→`submitTurn` (`commands-md.ts:151-158`, `skills.ts:525-527`, `repl.ts:491-506,685-686`) and never through `handleLine` — they are *not* user attestation. Never derived from message roles either (summaries and child task prompts are stored as `role: "user"`: `store.ts:973-988`, `task.ts:621`). Children inherit the same session snapshot — never their own history. The classifier may allow only when safety *and* fit with that evidence are clear; otherwise ask. **No provenance-verified snapshot ⇒ auto does not classify (fresh confirm); shadow may still classify for observation, with an explicit no-verified-context marker.** Invalidation rules: D18. |
| D12 | **Scope honesty (R4 #2)**: the floor is **known-dangerous-shape detection, not an enforcement boundary** (no sandbox, no completeness claim). A matched command whose affected target cannot be statically resolved is **manual-only** — never classified (§5.5). |
| D13 | **Fresh fallback (R4 #3, scope extended by R7 #3)**: auto-mode fallbacks (`ask` / unavailable / manual-only) must perform a *fresh* confirmation — the call carries **no `sessionKey`**, so a remembered “don't ask again” cannot approve behind the classifier's back. **Shadow's evaluation confirm is fresh for the same reason** (D16); only manual keeps today's session memory. |
| D14 | **Observation before trust (R4 validation gap)**: `shadow` classifies and records while the human still decides; the recommended rollout is manual → shadow → auto, with `/guardian status` counters for the review. Auto is never the default. Shadow's numbers are **observational data, not an independent safety proof** (R11 note). |
| D15 | **Per-call association (R7 #2)**: the host freezes the evidence snapshot **at the tool-gate entry** and carries it to the seam through a **call-scoped** mechanism (AsyncLocalStorage around the registry dispatch — no shared mutable “current run” state). The chain is `run → tool call → handler → classify`, one snapshot per call; two children with the same agent+cwd cannot cross-contaminate. No association (e.g. a handler calls `classify` outside its dispatch) ⇒ `undefined` ⇒ fresh confirm. |
| D16 | **Shadow measurement integrity (R7 #3, extended by R8)**: shadow's counters distinguish `allow + human approved`, `allow + human denied`, the ask-rate, and the **manual-only rate** (how often the target detector blocks auto-classification — the metric that tells the owner whether auto is worth trusting). Cache hits cannot pollute samples (fresh confirm by construction). Honest limitation: the current `confirm` contract returns a bare boolean, so a cancel is indistinguishable from a denial and counts as `humanDenied` (conservative). |
| D17 | **The context-presence fact travels on the event (R8 P1)**: the runner sets `verifiedUserContext: boolean` on every emitted `tool_call` event (a host fact, like `cwd`/`subagent`). Auto mode checks it **before** calling classify — `false` ⇒ fresh confirm, never classified; shadow calls regardless (the host's context block then carries an explicit “no verified context available” marker). The gate is **extension policy**; the host's guarantees are the fact, the marker and the record. This keeps D6's “one new member” (no second API member). |
| D18 | **Log invalidation (R11 #2, anchors corrected in R12)**: the verified log is cleared when the conversation's identity or history position changes — `/new` (`runner.ts:830`), a successful `/resume` (`:1018`), and a `/tree`/`/fork` whose target **actually moves the position** (`positionMoves`, `:992-993`; history rebuild `:1007`). Clearing keys on **positionMoves / identity change, not on a summary's outcome**: a branch summary that fails still moves the position (`:993`), and the log must clear anyway. Startup that restores an old session begins with an **empty** log (no inference from roles). Operations that fail, are cancelled, or move nothing clear nothing. Only new, clearly-sourced submissions append afterwards — a rewound-away authorization can never enter a new call's snapshot. |

## 1. Context

Today (see `docs/m4-extensions-design.md` §13.1) guardian has two tiers in one
`tool_call` handler: a hard floor that blocks without asking, and an ask tier
that calls `api.confirm(...)` for every matched risky command. The human is the
only decision-maker on the ask tier.

The goal is to insert a model judgment *between* the rule match and the human:

```
floor hit ────────────────────────────────► block (never classified)
matched + manual ─────────────────────────► confirm (today, unchanged)
matched + shadow  ─► classify ────────────► record the verdict, then **fresh** confirm
                                             (D16: samples are real human judgments)
matched + auto:
  no verified user context (D11) ─────────► fresh confirm (never classified)
  target unresolvable (§5.5) ─────────────► fresh confirm (never classified)
  else ─► classify ─ allow ───────────────► run (recorded)
                      ask ────────────────► fresh confirm, reason attached
                      unavailable ────────► fresh confirm (recorded once/session)
```

imp's extension API deliberately has no model access
(`src/extensions/types.ts:88-89`: “three read-only facts, three registration
methods, one subscriber, one ask-the-human method — **eight members**.
Anything an extension cannot do with this, it cannot do.”). This batch grows it
to **nine**, with one purpose-built member, and amends that docstring **and**
the stale prologue in `docs/m4-extensions-design.md:227` (“Seven members
total”). `ToolCallEvent` additionally gains one field,
`verifiedUserContext: boolean` (D17) — a field on an existing event, not a new
event name (the normative event set, `types.ts:200`, is unchanged).

## 2. Ownership

The existing three-way split still governs:

- **Invariants → host**: credentials, provider auth, accounting *when it lands*
  (Phase A defers it — §11.5), timeouts, output-contract enforcement,
  sanitization, the audit record, the **provenance-verified user-input log and
  the per-call snapshot** (host-extracted; the extension can neither see nor
  alter them — only the presence fact, `verifiedUserContext`, D17), and whether
  the seam exists at all on a given surface (D8).
- **Policy → extension**: which calls get classified, the policy framing, what
  each verdict means, the mode state, the manual-only class, the breaker.
- **Rendering → host**: record lines go through the existing `▪` note channel
  and the host-owned caller label (D9 of the confirm-prompt design, `loader.ts:233`).

Why not let the extension call the provider directly: extension code holding
credentials, choosing models and spending tokens with no accounting is exactly
the “zero-injection” line this project drew earlier. The seam inverts it: the
extension supplies *the question*, the host supplies *everything else*.

## 3. Decision layers

| Layer | Phase | What it can do | Deterministic? |
|---|---|---|---|
| 0. Hard floor + manual-only class | today / A | block known dangerous shapes; route unresolvable targets to a fresh ask | yes |
| 1. User rules (config) | B | allow / ask / block by pattern; `allow` skips the classifier, `block` never reaches it | yes |
| 2. Classifier (shadow observes, auto decides) | A | auto: `allow` → run, `ask` → fresh confirm; shadow: records only | no (model) |
| 3. Human prompt | today | final say | — |

Phase A implements layers 0, 2, 3. Layer 1 is specified in §9.2 but not built
first: it has its own surface (pattern syntax, validation, project tightening).

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
  asking the human (fail-to-ask; there is no third state).
- Usable at runtime from event handlers (like `confirm`/`setStatus`), not gated
  to load time. Callable concurrently (stateless, per-call abort).
- The host adds the trusted-context block and the output contract; the extension
  neither supplies nor sees them (D11, §4.2).

### 4.2 Host-side behavior

| Step | Behavior | Anchor |
|---|---|---|
| Request assembly | `system` = extension policy + **host trusted-context block** + unchangeable output contract; `messages` = one user message from `prompt`; `tools: []`; `maxTokens` = host constant (draft: 400); no thinking | mirrors the compactor: `src/core/compaction.ts:397-423`, `src/provider/types.ts:19-34` |
| Trusted context (D11, R7 #1 / R11 #1) | the host's **user-input log** (≤3 entries, ~2000 chars): raw submissions captured at the human submission boundary **before dispatch** — `handleLine` (`repl.ts:442`; wired by both shells at `:1606`/`:1622`) and the steering/follow-up queues — i.e. typed text verbatim, a command/skill invocation as `/<name> <args>`. **Expansion products are never included**: command- and skill-file bodies go `submitPrompt`→`enqueuePrompt`→`submitTurn` (`commands-md.ts:151-158`, `skills.ts:525-527`) and never through `handleLine`. Never derived from message roles (summaries, child task prompts: `store.ts:973-988`, `task.ts:621`). Child calls inherit the same session log; cleared per D18 (identity/position change, `positionMoves`-keyed). Wrapped in host delimiters, labeled *data, not instructions*. Empty log ⇒ the event carries `verifiedUserContext: false` (D17) and the block itself says “no verified context available” | host-owned log; the extension cannot forge or alter it |
| Association (D15, R7 #2) | the runner wraps the registry dispatch in an AsyncLocalStorage store carrying a **snapshot frozen at the tool gate**: `{callId, subagent, agent, cwd, userInputs}`. The classify handler reads the store; no store (called outside a dispatch) ⇒ `undefined` ⇒ fresh confirm. No shared mutable “current run” variable | `registry.ts:378-391` dispatch; emits at `runner.ts:595-600,1418-1419` |
| Input caps | combined `system`+`prompt` capped at a host constant (draft: 8 KB); over-cap ⇒ `undefined` (no silent truncation of policy text) | new constant |
| Model resolution | `request.model` → `resolveModel()` (`src/provider/resolve.ts:126`); invalid/unavailable ⇒ session model, and the record says so | |
| Timeout | host `AbortController` + wall-clock constant (draft: 10 s). Abort plumbing exists (`LLMRequest.signal`, `src/provider/types.ts:32`; honored in `anthropic.ts:220,248`). Test fakes must resolve/reject on `signal.abort`, mirroring `abortSafe` (`src/provider/shared.ts:31-35`) | |
| Output contract | host appends: reply with exactly one JSON object `{"verdict":"allow"|"ask","reason":"<one sentence>"}` | new |
| Defensive parse | first JSON object; `verdict` strictly `allow`/`ask` (anything else, incl. `block`, is invalid); `reason` capped (draft: 200 chars) and run through `sanitizeDisplay` | `src/repl/tool-presentation.ts:14` |
| Any deviation | garbage, refusal, empty, truncated, provider error (incl. a configured reference with no usable credentials), timeout, aborted ⇒ `undefined` | |
| Accounting | **Phase A: no ledger attribution — documented limitation.** The totals tracker derives from session entries (`src/core/usage-totals.ts:219`); per-attempt buckets are fixed (`src/core/usage-ledger.ts:17-30,59`). Follow-up in §11.5. The record line names the model actually used | |
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
  classify handler is created beside the confirm host in the repl layer
  (which is also where `sanitizeDisplay` lives, `tool-presentation.ts:14` — no
  module move). It needs no session-shaped binding: the evidence arrives
  through the **call-scoped snapshot** the runner attaches to each dispatch
  (D15), and the user-input log lives with the runner. The classifier itself
  prompts nobody: only the *fallback* differs between TUI (picker) and legacy
  ([y/N]); records go through `renderer.note` on both.
- **Non-interactive — print mode (`cli.ts:1005`) and test harnesses.** Nothing
  is passed; `api.classify` returns `undefined` without touching the network —
  auto/shadow degrade to today's behavior exactly (classify unavailable →
  confirm → false → block).

This is the design's cheapest safety property: a headless `imp -p` run can
never auto-approve, no matter what the config says.

### 4.4 The record is a property of the call (D9)

The host writes the verdict record when the call completes, before the
extension returns its decision. The extension cannot suppress it, and cannot
make the transcript claim a verdict the model did not give. (An extension can
still ignore an `ask` verdict and run the tool — that power is inherent to
`tool_call` handlers; what the seam guarantees is that the *consultation and
verdict are on the record*. Same honesty principle as D9 of the confirm-prompt
design.)

### 4.5 Concurrency and mid-flight changes

- An in-flight classify call keeps the parameters it started with; a mode flip
  or `/guardian reload` applies to the next gated call only.
- A classify call can overlap an open confirm picker (e.g. a child run's gated
  call). Records write through the `▪` note channel — the same channel
  confirm's own record uses before its picker appears.
- The config file is **read-only** in Phase A, so symlinks/ownership are a
  non-issue.

## 5. The guardian consumer

### 5.1 Mode state

Session-scoped `manual | shadow | auto`; initial value from config (§5.2,
default `manual`). Not persisted by the command.

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

- `auto.mode` — startup mode: `manual` (default) | `shadow` | `auto`.
- `auto.model` — provider/model reference for classify calls; absent ⇒ session
  model. Invalid values ⇒ session model + one diagnostic line at load.
  **Privacy note in the config docs**: pointing this at another provider sends
  that provider the command and the provenance-verified user context (D11).
- Read at extension load and by `/guardian reload`.
- Tolerance follows guardian's standing philosophy: unreadable/invalid JSON ⇒
  defaults + one diagnostic, never fatal, the gate stands.
- **Global-only by construction** (D2): Phase A has no project file. Phase B
  introduces `.imp/guardian.json` restricted to tightening keys; it can never
  set `model` or `mode: auto|shadow`.
- The existing `IMP_GUARDIAN_BLOCK` env var keeps working unchanged.

### 5.3 `/guardian` command

| Invocation | Effect |
|---|---|
| `/guardian` | cycle manual → shadow → auto → manual (three states now) |
| `/guardian manual` / `shadow` / `auto` | set the mode |
| `/guardian status` | mode, model (resolved), breaker state, config path, **session counters (D16)**: classify calls, allow/ask/unavailable, `allow + human approved`, `allow + human denied`, ask-rate, manual-only rate |
| `/guardian reload` | re-read the config file, report what changed |

Registered via `api.registerCommand` (`src/repl/commands.ts:129-137`). Allowed
during runs (a local state flip). Every change writes a record line (§7) and
updates the footer via `setStatus`.

### 5.4 Call site

Inside the existing **bash** ask tier (`guardian.mjs:225`). The write/edit tier
(`:246`) keeps its unconditional confirm in Phase A (§9.1).

```
if (mode === "manual")            → confirm with today's options (sessionKey kept)
if (mode === "shadow"):
  verdict = await api.classify(...)        // record only; counters updated (D16)
  → **fresh confirm** — the human decides, and the sample is a real judgment
if (mode === "auto"):
  if (event.verifiedUserContext === false) → fresh confirm (D17; never classified)
  if (!targetStaticallyResolvable(command)) → fresh confirm (§5.5; breaker counts)
  verdict = await api.classify({ system, prompt, model: config.model })
  undefined → fresh confirm(detail + "\nclassifier unavailable")   [breaker counts]
  ask       → fresh confirm(detail + "\nclassifier: " + reason)    [breaker counts]
  allow     → return undefined (run)                                [breaker resets]
```

**Fresh confirm** means: `api.confirm(message, detail)` **without
`sessionKey`/`rememberLabel`** — the host has nothing cached for that call, so
it always asks (D13). Only the manual path keeps today's options.

The hard-floor branch (`guardian.mjs:192-193` bash; `:241-242` write/edit) is
untouched and never reaches this code.

### 5.5 Manual-only operations — never classified (D12)

A matched command whose affected target cannot be **statically resolved** never
feeds an auto-allow decision: in auto it goes straight to a fresh human
confirmation (never classified); in shadow it is still classified and recorded
for observation (data only, with a marker in the prompt). Conservative
syntactic detector over the matched command text: shell expansion (`$`,
backticks, `$(`, `<(`/`>(`) or glob metacharacters (`* ? [ ] { }`) in
target/argument positions. Motivation (R4): the floor's own analysis cannot
resolve

```bash
target="$HOME/.ssh"; rm -rf "$target"
```

— today it reaches `confirm` (not the floor), and this design must not turn
that path into a classifier decision. Over-triggering is the safe direction
(more asks); the class is a **deliberate admission of the detector's limits**,
not a promise to close them. Strong protection (a real boundary) needs
execution-layer constraints — out of scope, recorded in §9.3.

### 5.6 What the classifier sees

In `prompt` (extension-authored):
1. `cwd: <caller cwd>` (M6b — children resolve against their own worktree);
2. `subagent: true` when the call comes from a child (`event.subagent`);
3. the matched rule's teaching reason (guardian already holds it);
4. the candidate command, verbatim.

In `system`: the extension's policy framing, **plus** the host's
provenance-verified context block (D11) and the output contract — none of which
the extension writes. When the log is empty (shadow only; auto never gets
here, D17), the block says so explicitly instead of pretending to carry
evidence.

Policy framing says: what guardian is; that a human is always available as the
fallback; that `ask` is the safe answer under uncertainty; that the floor and
the manual-only class are not the classifier's business; and that the user's
stated intent (the context block) is the authorization evidence, not the
command's apparent usefulness.

**Withheld**: the conversation transcript (beyond the host's D11 block), file
contents, the audit log, other tool calls, and **every model-authored message
regardless of its stored role** (summaries, delegation prompts, tool results).

### 5.7 Circuit breaker (D10)

Auto mode only. Count consecutive non-`allow` results (`ask`, unavailable, or a
manual-only skip). On the 3rd: flip the session to manual, write a record line,
update the status. Any `allow` resets the counter. Shadow never flips (it does
not decide); its counters are observational only.

### 5.8 Audit log

`~/.imp/guardian.log` gains one line per auto/shadow decision: timestamp, tool,
verdict, model, first line of the reason. Blocked/error lines keep their
current format (append-only, never fatal — unchanged contract).

## 6. Invariants

| # | Invariant | Why |
|---|---|---|
| I1 | The floor branch **precedes** the classifier branch and returns before any classify call can happen (`guardian.mjs:192-193` bash; `:241-242` write/edit) — pinned by test 14. | Code shape is the only guard against re-ordering. |
| I2 | Any classifier failure **or an `ask` verdict** ⇒ a **fresh** human confirmation: the auto fallback **and shadow's evaluation confirm** carry no `sessionKey`, so remembered approvals cannot bypass them (D13/D16, pinned by tests 23, 24). | “Hand it to the human” must mean *this time*, not “whatever the cache says”. |
| I3 | A surface without an interactive prompt (print mode, test harnesses) does not serve the seam. The legacy readline shell **is** interactive and therefore does serve it. | Headless runs keep today's block behavior. |
| I4 | Phase A verdicts are `{allow, ask}`; the model cannot block. | A hallucinating classifier must not silently kill legitimate work. |
| I5 | The verdict record is written by the host at call completion, before the extension's decision is known. | Auditability is a property of the seam, not of extension good behavior. |
| I6 | Manual is the default; mode changes are explicit, recorded, session-scoped; auto is never reached without an explicit step. | A feature that loosens a gate must be opted into, visibly. |
| I7 | The classifier's context is **provenance-verified**: only raw submissions captured at the human submission boundary (before dispatch), never expansion products, never derived from stored message roles; model-authored text is never evidence regardless of its stored role (D11), and the log is invalidated on session/history changes (D18). | A model cannot manufacture its own authorization — not via a summary, not via a child's task prompt, not via a command file. |
| I8 | A matched command whose target is not statically resolvable never feeds an auto-allow: auto never classifies it (fresh confirm); shadow may classify it for observation with a marker (§5.5), pinned by test 22. | The classifier must not decide what the gate cannot even identify. |
| I9 | **Scope honesty**: the floor detects known dangerous *shapes*; it is not a sandbox and this design claims no completeness for protected paths (D12). Anything unresolved lands in the manual-only class or the human prompt. | A weak detector must not be presented as a boundary. |
| I10 | Every classify call is associated with exactly one tool call via a snapshot frozen at gate entry (D15); no association ⇒ `undefined` ⇒ fresh confirm. | Evidence must belong to *this* call — two same-name children cannot share an ambiguous “current run”. |
| I11 | Shadow's counters are built only from real human judgments (fresh confirm by construction, D16); cache hits never enter the samples. | The observation phase exists to find false-allows; cached approvals would hide exactly those. |

## 7. User-visible surfaces (drafts — owner eyeballs these at acceptance)

| Event | Draft record line |
|---|---|
| shadow verdict | `▪ guardian (shadow) — classifier would allow: <reason>` (then the fresh confirm follows) |
| auto allowed | `▪ guardian (auto) — classifier allowed: <reason>` |
| auto asked / unavailable | today's `▪ confirm: guardian — …` (fresh) + detail line `classifier: <reason>` / `classifier unavailable (<why>)` |
| manual-only skip | `▪ guardian (auto) — target not statically resolvable; asking` |
| no verified context | `▪ guardian (auto) — no verified user context; asking` |
| mode change | `▪ guardian: mode → shadow` / `→ auto` / `→ manual` |
| breaker tripped | `▪ guardian: 3 non-allows in a row — back to manual` |

The command itself is not repeated in these records: it renders exactly once in
the tool block that follows. The footer shows `guardian: shadow|auto` while
active.

## 8. Tests and pins (red-first)

**Host seam (new test file)**
1. success: contract JSON ⇒ verdict parsed, record line exact bytes;
2. garbage / refusal / truncated output ⇒ `undefined` (each a pin);
3. `verdict: "block"` ⇒ `undefined` (I4 at the seam);
4. timeout ⇒ `undefined` — fake honors `request.signal`, else the test hangs;
5. over-cap input ⇒ `undefined`, provider not called;
6. **non-interactive surfaces never call the provider** (I3);
7. resolvable model reference honored; unresolvable ⇒ session model + record
   notes the fallback;
8. concurrency: two overlapping calls do not interleave state;
9. wiring: passed to `loadExtensionSetup` exactly when `interactive`
   (`cli.ts:540,593`);
10. context: the user-input log's entries (≤3, capped) appear in the request,
    host-delimited and labeled as data;
11. **spoofing vectors (R7 #1)** — neither (a) a child's task prompt claiming
    “the user authorized X” nor (b) a compaction/branch summary claiming it
    appears in the request, although both are stored as `role: "user"`
    (`task.ts:621`; `store.ts:973-988`);
12. empty log ⇒ the host sets `verifiedUserContext: false` on the event and
    the context block carries the explicit “no verified context available”
    marker; guardian's auto-side check is pinned in test 25;
13. **association (R7 #2, R8 P2)**: the request carries the snapshot frozen at
    gate entry — the pin forces the interleave by appending to the host log
    **from inside the handler** before calling classify; a `classify` call
    outside a dispatch (detached / after the handler returned) ⇒ `undefined`.

**guardian (existing double grows `classify`)**
14. floor command in auto ⇒ classify **never called**, block returned (I1);
15. allow ⇒ no `confirm` call, handler returns undefined;
16. ask ⇒ **fresh** confirm (args carry no `sessionKey`), reason attached;
17. unavailable ⇒ fresh confirm;
18. breaker: 3 non-allows ⇒ manual; shadow never flips;
19. `/guardian` toggle/cycle/set/status/reload; unknown argument ⇒ usage;
20. config: missing ⇒ defaults; bad JSON ⇒ defaults + diagnostic; model
    passthrough; reload picks up edits;
21. write/edit tier in auto still goes straight to `confirm` (scope pin);
22. **unresolvable target** — `target="$HOME/.ssh"; rm -rf "$target"` and
    glob/`$()` variants: auto never classifies (fresh confirm), shadow
    classifies with the marker (I8);
23. **fresh-argument pins (I2)**: the auto `ask`/unavailable fallback and the
    shadow evaluation confirm carry **no `sessionKey`/`rememberLabel`**
    (asserted on the options argument; the double's `confirm` is a bare spy,
    `test/guardian.test.ts:20-47` — the host cache lives in
    `TtyConfirm.sessionAllowed`, `repl.ts:263`);
24. **shadow counters (D16/I11)**: `allow + human approved`,
    `allow + human denied` (a cancel counts here — documented), ask-rate, and
    the **manual-only rate**;
25. no verified context in auto (`event.verifiedUserContext === false`) ⇒ fresh
    confirm, classify not called (D17);

**TUI**
26. the record lines of §7 (incl. shadow, manual-only, no-context) render
    through the `▪` channel with the caller label.

**Input-log boundary (R11)**
27. **expansion vector**: a slash command or skill whose file body contains
    “the user authorized X” contributes only the invocation line
    (`/inspect …`) to the request — the body never appears
    (`commands-md.ts:151-158`, `skills.ts:525-527`);
28. **invalidation (D18)**: `/new` and a successful `/resume` start the log
    empty; a `/tree`/`/fork` whose target moves the position clears it
    (`runner.ts:830,1018,992-993,1007`), including when the branch summary
    subsequently fails; a rewound-away authorization does not enter the next
    call's snapshot;
29. **no-op preservation**: a failed/cancelled/no-op session operation clears
    nothing; subsequent submissions append normally.

**Mutation checks** (after green): drop the floor short-circuit; make a failure
path return `allow`; remove the breaker; parse `"block"` as allow; skip the
sanitize/cap step; **pass `sessionKey` in the auto fallback or shadow** (test
23); **classify an unresolvable target in auto** (test 22); **feed the context
block a summary or a child task prompt** (test 11); **read the live log instead
of the frozen snapshot** (test 13); **log an expanded command body instead of
the invocation** (test 27); **skip the invalidation on a position-moving
`/tree`** (test 28); **keep the log across a rewind because the summary
failed** (test 28); **skip clearing when nothing moved** (test 29).

## 9. Phases and non-goals

### 9.1 Phase A (this batch)
Seam (+ provenance-verified context, D11 — capture at the submission boundary,
D18 invalidation) + the runner-side **user-input log**
and the call-scoped snapshot (D15) + global config + `/guardian` (three modes)
+ breaker + the **bash ask tier only** (`guardian.mjs:225`) + the manual-only
class (§5.5) + shadow counters (D16) + records + tests. The write/edit tier
(`:246`) keeps its unconditional confirm — pinned by test 21.

**Rollout is part of the batch**: manual → **shadow on real commands** →
auto. The owner reviews shadow records and `/guardian status` counters
(false-allows that would have run, ask-rate, the **manual-only rate** — R8's
warning: an over-triggering target detector would silently defeat auto) before
flipping auto; the config ships `manual` as the default.

### 9.2 Phase B (specified then, not now)
User rules file (project tightening, global rules with `allow`/`ask`/`block`),
write-gate classification, classifier `block` verdict, classifier cost
attribution (§11.5), a consulted-and-ignored “mismatch line” (§11.8).

### 9.3 Not doing
- Custom keybindings (D3) — its own batch if ever.
- Persisting the mode beyond the config's startup value.
- Env-var model override (D2).
- Any change to manual-mode behavior, to the floor, or to the existing
  `confirm` contract.
- **Any execution-layer boundary (sandbox)** — I9 states what the floor is
  not; building a real boundary is its own design.

## 10. Reference notes

### 10.1 Claude Code 2.1.88 (`/Users/z/Z/claude-code-sourcemap`, unofficial sourcemap restore)
- Auto mode entry: only when the normal pipeline returns `ask` and the mode is
  `auto` (`utils/permissions/permissions.ts:519-522`).
- A real model call (`yoloClassifier.ts:1012`), input = **full transcript** +
  candidate action + CLAUDE.md + settings-driven rules (`:302-459,484-565`);
  fast paths skip the model (acceptEdits re-check `permissions.ts:596-643`;
  safe-tool allowlist `classifierDecision.ts:56-97`).
- Server-gated (`tengu_auto_mode_config`, default `disabled`,
  `permissionSetup.ts:1099-1160`), **fail-closed** when unavailable.
- Denial tracking: 3 consecutive / 20 total ⇒ back to prompting
  (`permissions.ts:879-881,995-1002`). Entering auto strips dangerous broad
  rules (`permissionSetup.ts:510`). Marked ANT-ONLY in places
  (`bashClassifier.ts:1`).
- **Borrowed**: two-layer shape, breaker, skip-fast-paths, and — per R4 — the
  idea that the judge needs conversation context (we take a bounded,
  user-only slice instead of the full transcript).
- **Rejected**: fail-closed (we ask instead), full-transcript input (privacy),
  server-side gating (no server here).

### 10.2 pi (`/Users/z/Z/Agent_demo/pi`, packages/coding-agent)
- Extensions *do* get model access, host-resolved:
  `ctx.modelRegistry.complete(model, context, options)`
  (`src/core/model-registry.ts:119`), documented (`docs/extensions.md:1021`),
  with a shipped one-shot example (`examples/extensions/summarize.ts:163-190`).
- **Borrowed**: host-resolved auth + one-shot shape; `hasConfiguredAuth`-style
  graceful failure (ours: session-model fallback + ask).
- **Rejected**: extension-chosen models (D2), raw input / big API surface.
- Config conventions, from the local `permission-gate` v3 extension
  (`/Users/z/Z/pi/permission-gate`, reference only): global file + project file
  that can only tighten; `PI_PERMISSION_GATE_HOME`-style test isolation (ours:
  `IMP_GUARDIAN_HOME`).

## 11. Open questions (for R5/owner acceptance)

1. Member name: `classify` vs `adjudicate`/`judge`?
2. Record wording (§7 drafts) — owner eyeballs at acceptance.
3. Failure-record dedupe: “first per session” (draft) vs every failure vs none?
4. `auto.model` reference syntax — the exact `provider/model` grammar, and the
   “unavailable” diagnostics.
5. Cost accounting deferred (Phase A reports nothing; `usage-totals.ts:219`);
   follow-up needs a session-entry kind.
6. Constants: 10 s timeout, 400 max tokens, 200-char reason, 8 KB input cap,
   ≤3 user messages / ~2000 chars of context — all drafts.
7. Footer: show the mode only when not `manual` (draft)?
8. Consulted-and-ignored: a later phase could record a *mismatch* line
   (per-call verdict state). Phase B candidate (R2 note).
9. R4 leftovers for R8 to weigh: should shadow counters also count “would-allow
   but human denied” separately (the false-allow signal the validation phase
   exists to find)? Resolved in D16: yes — the `allow + human denied` count.
10. Shadow's anchoring risk (R7 suggestion, optional): showing the classifier
    verdict *before* the human answers could bias the judgment; deferring the
    record line until after the confirm would protect the samples. The host
    writes the record at call completion (D9/I5), so deferral needs a seam
    hint or a guardian-side buffered display. Phase A draft: show it
    immediately, record the caveat, revisit if the samples look biased.
11. R7's cancel-vs-deny limitation: `api.confirm` returns a bare boolean, so a
    cancel counts as `humanDenied` in shadow. Distinguishing them would change
    the confirm contract — out of scope (§9.3).
12. Child calls stay eligible for auto-allow with the inherited session
    snapshot (D11/D15). The conservative alternative — never auto-allow
    subagent calls, always fresh confirm — remains available if R8 or the
    owner prefers it.

## 12. Review log

- R1: **NEEDS REVISION** (8 findings, adversarial, base `1a16b75`). P0: §4.3's
  surface list wrongly claimed the legacy shell is non-interactive — it builds
  the same `TtyConfirm` host (`cli.ts:540,593`) and has a real `[y/N]` prompt
  (`repl.ts:319`), so by I3 it must serve the seam. P1: accounting wrongly
  implied a simple ledger-kind extension (fixed-shape per-attempt buckets,
  totals derived from session entries) ⇒ documented deferral; §5.4 now wires
  the bash ask tier only. P2: I1 weakened to the provable claim; timeout row
  exercises `LLMRequest.signal`; `sanitizeDisplay` layering resolved by placing
  the handler in the repl layer. P3: anchors corrected; both stale member
  counts amended; concurrency/symlink/no-auth specified. All folded.
- R2: **CONFIRMED WITH NOTES** (2 P3 + one opinion). Floor anchors corrected to
  `:192-193`/`:241-242`; D6/§2 gained the accounting-deferral pointer; the
  consulted-and-ignored limitation recorded as open question 8. Everything else
  re-verified against the code.
- R3: **CONFIRMED** — micro-verification of the two folded notes and open
  question 8; review closed.
- R4: **owner second-opinion review — NEEDS REVISION before implementation**
  (three substantive findings + one validation gap). #1 the classifier lacked
  the evidence to judge “should this be allowed *this time*” (task fit,
  explicit authorization) ⇒ D11 (host-supplied trusted context; assistant
  claims are not evidence) and a narrowed allow criterion. #2 the floor is not
  an enforcement boundary (`target="$HOME/.ssh"; rm -rf "$target"` reaches
  confirm today; auto would have classified it) ⇒ D12/I8/I9: scope honesty +
  the manual-only class. #3 auto fallbacks would hit guardian's `sessionKey`
  cache and be approved without asking ⇒ D13/I2: fresh fallback confirmations.
  Validation gap: chain tests cannot show answer quality ⇒ D14: shadow mode +
  counters + the manual → shadow → auto rollout. All folded in rev 2.
- R5: **CONFIRMED WITH NOTES** — all four folds verified present with mechanisms
  and pins; the new feasibility claims checked against code (post-startup
  binding precedent `repl.ts:324-330,1643`; child `history`
  `subagent.ts:176`; detector data at `guardian.mjs:190,115,138`); nothing from
  R1-R3 broken. N1: test 23 reworded to the arg-negation observable (the double
  models no cache). N2: D8 scoped to auto-mode fallbacks (shadow/manual keep
  session memory). Both folded.
- R6: **CONFIRMED** — micro-verification of N1/N2 and the R5 log entry: all accurate; review closed on rev 2. *(Test numbers cited in R1-R6 entries follow the rev-2 numbering; the rev-3 additions shifted guardian's pins to tests 14-25.)*
- R7: **owner second-opinion review round 2 — NEEDS REVISION before implementation** (three findings). #1 `role: "user"` ≠ “the real user said it”: summaries and child task prompts are stored that way (`store.ts:973-988`, `task.ts:621`), so role-filtered context is spoofable ⇒ D11 amended to provenance by input boundary + the runner-side user-input log; children inherit the session snapshot; no verified context ⇒ auto does not classify. #2 the snapshot must bind to the call, not to a shared “live session” (two same-name children) ⇒ D15: freeze at gate entry, carry via AsyncLocalStorage around the registry dispatch, no association ⇒ fresh confirm. #3 shadow's sessionKey hits make cache approvals masquerade as human judgments ⇒ D16: shadow's evaluation confirm is fresh; split counters; cancels count as `humanDenied` (honest limitation). Folds: D8/D11/D13/D15/D16, §4.2/§4.3/§5.3-§5.6, I2/I7/I10/I11, tests 11/13/22-25, §11.10-12. Folded in rev 3.
- R8: **NEEDS REVISION** (fresh reviewer; 1 P1 + 3 minor). P1: the empty-log
  rule had **no channel** — the extension cannot see the host log, and
  `undefined` is contractually “unavailable”, so auto's “don't classify without
  verified context” and shadow's marker were both unevaluable ⇒ **D17**: the
  host puts `verifiedUserContext: boolean` on the emitted `tool_call` event
  (a fact, like `cwd`), the extension applies policy against it; the block
  carries the none-marker. Keeps one new API member. P2: the ALS leak path
  (post-return classify ⇒ `undefined`) now pinned in test 13. P3: D-list order
  fixed; test 13 names the artificial interleave. R8's attack-next note folded:
  shadow also counts the **manual-only rate**, and the rollout gate includes it.
  Folds: D15/D16/D17, §5.4, tests 12/13/24/25, §9.1. Folded in rev 3.1.
- R9: **CONFIRMED WITH NOTES** — D17's extension-policy/host-fact split verified
  coherent everywhere and the `undefined`-means-unavailable collision genuinely
  avoided; ALS leak pin, interleave wording, manual-only rate and the R8 log all
  verified. N1 (botched fold): D14 was left outside the §0 table as an orphan
  row after `## 1. Context` — restored into numeric order between D13 and D15.
- R10: **CONFIRMED** — D14 back in numeric order, no other structural defects, log matches. Review closed on rev 3.1 (this reviewer). The owner's second-opinion reviewer may want to verify rev 3.1 independently before implementation starts.
- R11: **owner second-opinion review round 3 — NEEDS REVISION** (two boundaries
  of the evidence log; everything else accepted as-is: floor scope, shadow
  cancel=deny, shadow display caveat — "don't call the statistics an
  independent safety proof" folded into D14). #1: `runTurn.userMessage` is not
  the human boundary — command/skill expansions ride it (`commands-md.ts:151-158`,
  `skills.ts:525-527`, `repl.ts:491-506,685-686`), so a command file saying "the
  user authorized X" would have entered the log ⇒ D11 amended: capture at the
  editor submission boundary pre-dispatch (`shell.ts:310,512`), raw submissions
  only, expansion products never. #2: no invalidation rules for session
  switches/rewinds ⇒ D18: `/new`, successful `/resume`, position-moving
  `/tree`//`/fork` clear the log (`runner.ts:830,1018,876,910,1538`); restored
  sessions start empty; failed/no-op operations clear nothing. Folds: D11/D14/D18,
  §4.2, I7, tests 27-29 + mutation list, §9.1. Folded in rev 3.2.
- R12: **NEEDS REVISION** (limited scope; 2 P2 + 1 P3, all accuracy — fold
  direction sound). N1: the capture point named only the TUI hop — both shells
  converge on `handleLine` (`repl.ts:442`; wired `:1606`/`:1622`), which is now
  the named funnel; the expansion-exclusion proof (via
  `submitPrompt`→`enqueuePrompt`→`submitTurn`, never through `handleLine`) was
  verified. N2: `:1538` is the compaction splice, not the tree/fork rebuild
  (`:1007`); and clearing must key on `positionMoves` (`:992-993`), not on a
  summary's success — a failed branch summary still moves the position. N3: the
  mutation list gained the test-29 entry. Folded.
- R13: *(pending — micro-verification of the R12 fold)*
