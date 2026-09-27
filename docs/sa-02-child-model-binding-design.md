# SA-02 design: child model binding — one resolution, three consistent consumers

Status: DRAFT — pending independent adversarial design review (AGENTS.md).
Branch: `feat/sa-02-child-model-binding`. Owner-approved contract and scope
(2026-09-27, conversation): priority is two levels only — agent-file `model:`
wins, otherwise inherit the parent at dispatch; cross-provider is rejected,
not silently rerouted; bare IDs stay literal on the parent's provider.

## 1. Problem (source-verified)

The child model is currently a raw string re-interpreted by three different
consumers, which disagree.

**Current resolution site** (`src/core/tools/task.ts:281-299`):

```ts
const parentModel = options.getModel();
const parentReference = options.getModelReference?.() ?? parentModel;
const slash = parentReference.indexOf("/");
const parentProvider = slash > 0 ? parentReference.slice(0, slash) : undefined;
const model = agent?.model ?? parentModel;
const parsedOverride = parseModelRef(model);
const overrideSlash = model.trim().indexOf("/");
const explicitProvider =
  agent?.model !== undefined &&
  overrideSlash > 0 &&
  parsedOverride.modelId === model.trim().slice(overrideSlash + 1);
const crossProvider =
  explicitProvider && (parentProvider === undefined || parsedOverride.provider !== parentProvider);
const modelReference = agent?.model
  ? explicitProvider || parentProvider === undefined
    ? model
    : `${parentProvider}/${model}`
  : parentReference;
```

`model` is passed verbatim as `SubagentOptions.model` and becomes the wire
model of every provider request (loop call at `src/core/subagent.ts:312`);
`provider` is always `options.getProvider()` — the parent's live provider.

### A. Wire-ID defects

- **Recognized same-provider prefix is not stripped.** Parent on OpenAI,
  agent `model: openai/gpt-5.2` → wire request carries `openai/gpt-5.2`;
  the API only accepts `gpt-5.2`.
- **Cross-provider override is neither honored nor rejected.** Parent on
  Anthropic, agent `model: zai/glm-5.3` → the raw string goes to the
  Anthropic provider (delayed 404), with no diagnostic.

### B. Metadata-family mismatch (NOT parent-bound — corrected evidence)

`src/core/subagent.ts` already consumes child parameters:

- `:165` `settings = options.settings ?? compactionSettingsFor(options.modelReference ?? options.model)`
- `:232` / `:248` `modelMaxTokens: modelMaxTokensFor(options.model)`

The defect is **reference qualification**, not parent-binding:

- `modelMaxTokensFor()` reparses a frequently **bare wire ID** through
  `parseModelRef()` (`src/provider/resolve.ts:48-81`), whose bare-ID defaults
  are the main-CLI routing rules (default family `anthropic`; `glm-*` →
  `zai`). Inheritance from a non-Anthropic parent (wire `gpt-5.2`, actual
  provider openai) is therefore looked up in the `anthropic` family —
  a miss — and the summarizer output-token cap silently becomes `undefined`
  (the `glm-*` exception makes the zai direction accidentally work, but by
  coincidence, not by construction).
- `compactionSettingsFor()` receives a **bare** `modelReference` whenever the
  parent reference is bare (Anthropic parents). That is correct only because
  `parseModelRef`'s default family happens to be `anthropic`; with a bare
  `glm-*` override under an Anthropic parent the metadata family becomes
  `zai` while the call actually runs on Anthropic.

The earlier task-list text implied these lookups were parent-bound; commit
`de6398d` corrected that. This design **keeps** the child-parameter lookups
and only unifies the reference they consume.

### C. Vision gate is parent-bound (the one true parent-bound defect)

`src/runner.ts:400-403` (constructor tool pool) and `:443-447`
(`getToolsForCwd`, worktree pool) both build the read tool with:

```ts
modelSupportsVision: () => modelSupportsVision(this.providerName, this.model)
```

`this.model` is the parent's live model. A child whose model differs from
the parent's therefore decides "does the model support images?" with the
parent's capability, in **both** shared-cwd children (which use the
parent's live pool, `task.ts:202`) and worktree children (rebuilt pool).

### Non-issues (verified, kept)

- Inheritance is already live: `getModel()`/`getModelReference()` getters
  are read at dispatch (`runner.ts:425-428`).
- `runSubagent` honors `options.settings` precedence and already takes the
  child reference first (`subagent.ts:165`).
- `parseModelRef` returns `{provider, modelId}` for a qualified reference;
  nothing else consumes `task.ts`'s `modelReference` string as routing.

## 2. Contract (user-approved)

One resolution, three consistent consumers: **API requests use the wire ID;
every metadata/capability lookup uses one canonical `provider/modelId`
reference.**

| # | Input (`agent.model`) | Child provider | Wire ID (API) | Canonical reference (metadata) |
|---|---|---|---|---|
| C1 | absent | parent's current provider at dispatch | parent's current wire model | `parentProvider/parentWireModel` |
| C2 | bare ID | parent's provider | the bare ID | `parentProvider/bareId` |
| C3 | recognized prefix, same provider | parent's provider | prefix stripped | `provider/strippedId` |
| C4 | recognized prefix, other provider | — | — | **reject before launch** |
| C5 | unrecognized slash prefix | parent's provider | whole string (wire IDs may legitimately contain slashes, e.g. OpenRouter/Bedrock style) | `parentProvider/wholeString` |
| C6 | empty / whitespace-only | — | — | **reject before launch** (malformed config) |
| C7 | recognized prefix with empty model ID (`zai/`) | — | — | **reject before launch** (malformed) |

Normalization: the override is trimmed; the provider prefix matches
case-insensitively (`ZAI/glm-5.3`) and is trimmed (`"zai / glm-5.3"` →
`zai/glm-5.3`); the model ID keeps its case. "Reject before launch" means:
an `isError` tool result returned **before** worktree creation, child-session
creation, or any provider call.

**Family-attribution guarantee.** The exact family comes from
`getModelReference()` (always wired by the real runner). Without it the
fallback derives the family from the model string by the main-CLI rule (D1)
— an approximation to be replaced by wiring `getModelReference()`, documented
rather than claimed exact.

Scope boundaries (explicit):

- **No cross-provider children.** Honoring one would require re-examining
  authentication, provider construction, metadata, and tool capabilities —
  a separate design. C4's error text points at the workaround (pick a model
  on the current provider, or switch the session model with `/model` first).
- **The task tool gains no `model` argument** and the child model gains no
  environment layer (M5 design: agent files are the only per-child model
  configuration point).
- **Main-CLI `parseModelRef` semantics are untouched** (see D2 for the
  documented CLI-vs-child divergences).
- **Bare `glm-*` under a non-zai parent stays literal** (runs on the
  parent's provider, likely a provider 404). Owner-approved: no special-case
  rerouting and no pre-launch warning; the contract "bare = parent's
  provider" is worth more than a convenience exception.

## 3. Decisions

### D1 — one pure resolver: `src/core/child-model.ts`

```ts
export interface ChildModelBinding {
  providerName: ProviderName;   // family name of the provider that will run the child
  wireModelId: string;          // exact string for API requests (prefix stripped)
  reference: string;            // `${providerName}/${wireModelId}` — the ONLY metadata key
}
export type ChildModelResolution =
  | { ok: true; binding: ChildModelBinding }
  | { ok: false; error: string };
export function resolveChildModel(input: {
  parentReference: string;   // getModelReference() or getModel() fallback
  override?: string;         // agent?.model
  agentName?: string;        // diagnostics only
}): ChildModelResolution;
```

Parent parsing has two modes, stated without over-claiming:

- **Canonical (the real runner — always wired, `runner.ts:428`):**
  `parentReference = runner.modelReference()`; the family is exact.
- **Fallback (custom wirings/tests without `getModelReference`):**
  `parseModelRef(options.getModel())` — the main-CLI bare-ID rule. This is
  an **approximation, and only for wiring that has no better source**:
  after `setModel("openai/gpt-5.2")` the runner stores family `openai`
  with wire ID `gpt-5.2` (`runner.ts:897-900`), and the wire ID alone
  cannot recover the family (`parseModelRef("gpt-5.2")` → `anthropic`).
  A wiring whose live family can differ from what the CLI rule derives
  from the current string must supply `getModelReference()`. Consequences,
  stated honestly:
  - *inherit*: same family as the pre-SA-02 metadata path (both parse the
    same parent string); no change.
  - *bare override*: the family now follows the derived parent (C2), which
    can differ from pre-SA-02's `parseModelRef(overrideString)` (e.g. bare
    `glm-4.6` under a derived-anthropic parent: was `zai`, now
    `anthropic`). This divergence is the contract working as intended.
  - *recognized-prefix override whose family ≠ derived parent*: now
    rejected (C4). Pre-SA-02 ran it with the raw string against the
    parent's provider — that raw path is the defect being removed.

An empty/blank parent reference is an internal error (`ok: false`), never
a guess.

Error strings (D7) name the agent when known, quote the offending value, and
state the actual provider context, e.g.:

```
agent "scout" requests model "zai/glm-5.3" on provider "zai", but this
session runs on "anthropic". Cross-provider subagents are not supported —
choose a model on the current provider, or switch the session model first.
```

### D2 — `knownProvider()` in `src/provider/resolve.ts`

The known-family list moves into one exported helper
(`knownProvider(prefix): ProviderName | undefined`, trim + lowercase), and
`parseModelRef` is refactored to consume it. This is behavior-preserving for
the CLI: same families, same order, same bare-ID rules, same unknown-prefix
fallback (`anthropic` + whole string) and same known-prefix-empty-ID
fallback (`anthropic` + whole string). Existing `resolve`-level tests plus
new child-model matrix tests pin it.

Documented divergences (intentional, child contract only):

| Input | Main CLI (`parseModelRef`) | Child contract |
|---|---|---|
| `zai/` (known prefix, empty ID) | `anthropic` family, whole string as ID | reject (C7) |
| `glm-5.3` bare | routes to `zai` (default-provider rule) | parent's provider (C2) |

Pin requirement: the refactor is behavior-identical for the CLI, pinned by
new resolve-level tests — `"zai / glm-5.3"` and `"zai /glm-5.3"` (space
before the slash → unknown prefix → `anthropic` + whole string), `"zai/"`
(`anthropic` + whole string), `"OpenAI/gpt"` and `" openai/gpt"` (trim +
case folding that already exists). The child-contract normalization in D1
(`"zai / glm-5.3"` → `zai/glm-5.3`) is implemented ONLY in `child-model.ts`
on top of `knownProvider()`; `parseModelRef` keeps today's exact behavior,
including its use of the untrimmed input in the fallback return.

### D3 — `task.ts`: resolve first, reject early, pass binding through

- The resolution block moves **above** tool narrowing and worktree creation
  (today it sits after both). On `ok: false` the tool returns
  `{ output: error, isError: true }` — same shape as the unknown-agent path —
  and no worktree, child session, or provider call happens.
- `runSubagent` receives `model: binding.wireModelId` and
  `modelReference: binding.reference`.
- The `crossProvider → DEFAULT_COMPACTION_SETTINGS` special case and its
  import are deleted: after C4 that path cannot exist. `SubagentOptions.settings`
  stays (test/profile wiring may still set it).

Ordering proof for the review: agent lookup → **model resolution** → tools
narrowing (validateSubset can only reject) → worktree branch → session →
`runSubagent`.

### D4 — `subagent.ts`: one metadata reference for both lookups

`options.modelReference ?? options.model` is computed once and exported as a
small helper so the acceptance evidence is unit-testable:

```ts
export function childModelMetadata(options: Pick<SubagentOptions, "model" | "modelReference" | "settings">):
  { reference: string; settings: CompactionSettings; modelMaxTokens: number | undefined };
```

- `settings = options.settings ?? compactionSettingsFor(reference)`
- `modelMaxTokens = modelMaxTokensFor(reference)` (fixes `:232`/`:248`; the
  two compaction call sites pass the computed value)
- `SubagentOptions.modelReference` doc comment is updated: always canonical
  from the task tool; consumed by every metadata lookup.

After D3/D4 the ONLY wire consumers of the model string are the provider
request and the summarizer call (`subagent.ts:229/245/312`), which is
correct — the summarizer runs on the same child provider/wire ID.

### D5 — vision binding: a child-scoped tool pool seam

`TaskToolOptions` gains:

```ts
getToolsForChild?: (cwd: string, binding: { providerName: ProviderName; modelId: string }) => Tool[] | undefined;
```

Runner wiring (`runner.ts`):

- **Shared cwd** (child cwd === parent cwd): return the parent's live tool
  list with the runner-owned read instance replaced by a new one bound to
  `modelSupportsVision(binding.providerName, binding.modelId)`. The swap is
  **identity-based** (only the exact instance the runner constructed; never
  by the name `read`), so extension/custom tools — including a user tool
  named `read` — are preserved by reference. Extensions ride along because
  their `api.cwd` never moved (M6b D5).
- **Worktree cwd**: the seven builtins rebuilt at `cwd` with read bound to
  the child (extensions excluded, M6b D5 unchanged).

Both call sites in `task.ts` prefer the new seam (`getToolsForChild(...)`),
falling back to today's wiring when absent (custom embeddings/tests): the
parent pool, and `getToolsForCwd` for worktrees. The fallback keeps its
current parent-bound read gate — documented as "wirings that predate SA-02
own their capability binding". The real runner always provides the seam, so
both shared-cwd and worktree children get the child-bound read tool.

Rejected alternative: threading `(providerName, model)` through
`Tool.execute`'s context from the loop. It changes the core `Tool` contract
and the loop/subagent interfaces for a decision that belongs to one tool;
deferred unless a second model-dependent tool appears.

### D6 — documentation and prompts describe the implemented contract

- `src/core/agents/registry.ts` header comment: `model:` line becomes
  "optional override on the CURRENT provider (bare id, or `provider/id` with
  the same provider; cross-provider is rejected)".
- README agents sample comment updated to the same wording.
- The `<advertised_agents>` block (`registry.ts:46-99`) lists names and
  descriptions only — verified, nothing to change.
- The task tool description makes no model promise — verified, unchanged.

### D7 — failure semantics

Pre-launch rejection is a normal `isError` tool result (the agent sees it
and can correct itself), never a thrown exception. The message includes:
agent name (when known), the offending value, the provider the child would
run on, and the workaround (C4 wording in D1).

### D8 — non-goals

No cross-provider support; no task-arg model; no env layer; no change to
`parseModelRef`'s CLI behavior; no pricing work (SA-04 will consume
`ChildModelBinding.reference` — field names chosen for that reuse; exposure
transport is SA-03/SA-04 work, see §6); no
special-case warning for bare `glm-*` (contract §2).

## 4. Test plan (labels map to SA-02 acceptance items)

New file `test/child-model.test.ts` (pure matrix):

- T1: C1–C7 table + normalization (case, whitespace, `zai/`, empty, blank,
  `/x`, `vendor/models/x`, bare `glm-*` both parents, anthropic bare parent).

`test/task-tool.test.ts` (existing harness):

- A-wire: same-provider prefixed override → provider request `model` is the
  stripped ID; bare override → as-is; inherit → parent's wire model.
- A-reject-cross / A-reject-malformed: cross-provider and malformed values →
  `isError`, message contains agent name + both provider names; provider sink
  empty; `getToolsForCwd`/`getToolsForChild` NOT called under `worktree: true`
  (no worktree created); no child session file written.
- A-slash: `vendor/models/x` accepted, request `model` is the whole string.
- A-vision-wiring: harness `getToolsForChild` records `(cwd, binding)`;
  shared path passes the parent cwd, worktree path the agentCwd, and the
  binding equals `{providerName, modelId: wireModelId}` in both. This
  proves WIRING only — the stubs bypass the runner; the real swap is
  evidenced by A-vision-shared / A-vision-worktree in `runner.test.ts`.

`test/compaction-wiring.test.ts` — **existing rows that pin the removed
raw behavior**; intentional red-before-green updates (they pass on `main`,
are rewritten on the branch, and the rewritten form fails against the old
code):

- Row `["anthropic/shared", "anthropic/small", true]` (`:127-156`): wire
  expectation `"anthropic/small"` → `"small"` (C3); compaction outcome
  (true) and the canonical reference are unchanged.
- Row `["anthropic/shared", "zai/shared", false]`: becomes a dedicated
  rejection test — `isError === true`, zero provider requests, D7 message
  (C4). The old row asserted the raw string ran on the parent's provider.
- Row `[undefined, "anthropic/small", false]`: with the fallback parent
  derived as `anthropic/shared`, the override is same-provider (C3) →
  wire `"small"`; the settings then come from the canonical
  `anthropic/small` catalog window (100k → compacts at 90k tokens), so
  `compacts` flips `false` → `true`.
- All other rows keep today's expectations (verified row by row: inherit,
  bare, `vendor/small`, `undefined` + bare — same wire IDs, same
  compaction choices, canonical reference identical to the old reference
  string).

These rows are the end-to-end evidence that compaction settings follow the
canonical child reference (acceptance item 6), on top of the
`childModelMetadata` unit tests.

Audit of the other `createTaskTool` callers —
`builtin-visual-verification.test.ts`, `child-compaction.test.ts`,
`task-source-identity.test.ts`, `builtin-tool-presentation-integration.test.ts`,
`test/task-tool.test.ts` — found no `modelReference`/override assertions
affected (checked for `modelReference`, `modelMaxTokens`, `model:`).

`test/runner.test.ts` (real wiring, M10 B pattern + `scriptedProvider` sink):

- A-inherit-live: `setModel()` after runner construction, before the parent
  turn → child request `model` equals the NEW wire ID.
- A-vision-shared: parent `zai/glm-5v` (vision true per the frozen prefix
  table), agent override bare `glm-5.3` (vision false via the `glm-` rule),
  child scripted to `read` a PNG in the shared cwd → the child's follow-up
  request (sink) contains no image block; the inverted pair (parent
  `glm-5.3`, child `glm-5v`) contains one. Exercises the real runner's
  identity-based read swap.
- A-vision-worktree: the same scenario in a **git-initialized cwd fixture**
  (init + commit the PNG; the `repoTask` pattern in `test/task-tool.test.ts`
  shows the shape), parent scripted tool call
  `{prompt, agent, worktree: true}` → the child runs in a real worktree and
  its follow-up request matches the CHILD's vision capability. Exercises
  the rebuilt-builtins path with the real runner's swap.

`test/subagent-*` (new or existing file) for D4:

- A-metadata: `childModelMetadata()` with a disk-injected catalog overlay
  (pattern from `test/deepseek.test.ts:91-93`): (a) wire `gpt-5.2` +
  reference `openai/gpt-5.2` → the openai overlay entry supplies
  `maxTokens`; (b) `zai/glm-5.3` → zai family; (c) bare `glm-5.3` under an
  anthropic parent resolves to `anthropic/glm-5.3` (no zai lookup);
  `settings` reflects the reference's context window in each case.

Docs/prompt wording checked by diff (D6) — the error text itself is pinned
by A-reject.

## 5. Verification protocol

- Red-before-green where a pre-fix defect exists (wire cases, vision cases,
  and the rewritten `test/compaction-wiring.test.ts` rows listed in §4):
  the new assertions run against `main` first and must fail for the stated
  reason.
- Gates on the branch: `npm run typecheck`, `npm run lint`, `npm run build`,
  full `npm test` (baseline 2052 tests / 107 files after SA-01; expected
  delta = new tests only).
- A focused adversarial delta review after implementation (fresh context),
  then owner acceptance, then `--no-ff` merge.

## 6. Deferred / explicit non-goals

- Cross-provider children (full design needed: auth, provider construction,
  metadata, tool capabilities).
- Bare `glm-*` under non-zai parents fails at the provider (owner-approved
  literal semantics).
- Custom wirings without `getToolsForChild` keep the parent-bound read gate.
- **Binding exposure / accounting.** `ChildModelBinding` is consumed inside
  one task invocation today: it is not returned by the tool, child sessions
  record no model (`session/manager.ts:58-62` passes `undefined` as the
  model), and no usage/event/presentation consumer of the child model
  exists yet. SA-04 pricing will need the canonical reference; the transport
  is deliberately left to SA-03's structured task-result contract. The
  binding field names are chosen for that reuse, but nothing produces them
  outward yet — this design does not claim it is wired.
- Catalog/overlay-derived model max tokens remain best-effort (`undefined`
  = no model-side bound), unchanged from #derived-budget.

## 7. Review record

### Round 1 (2026-09-27) — REJECT (3×P1, 2×P2)

- R1-P1 fallback equivalence claim: "the same rule the runner itself uses
  at construction" is false after `setModel` (live family field vs bare
  wire ID; `runner.ts:897-900`). Fixed: D1 defines the fallback as a
  documented approximation with the exact-family requirement on
  `getModelReference()`, and §2 carries the family-attribution guarantee.
- R1-P1 fallback vs C2 (bare `glm-*`, `test/task-tool.test.ts:228`): the
  fallback family follows the CLI rule. Fixed: D1 now states the
  consequences per case, including the deliberate bare-override family
  change and the new rejection of mismatched prefixes under fallback
  wiring. The original disposition claimed "no existing test asserts the
  affected metadata" — round 2 showed that false: wire/reject assertions
  in `test/compaction-wiring.test.ts:127-156` pinned the removed raw
  behavior; those rows are now scheduled as intentional red-before-green
  updates in §4.
- R1-P1 A-vision-worktree infeasible as written: the task-tool harness
  stubs bypass the runner, and `runner.test.ts` cwds were not git repos.
  Fixed: the worktree vision case moved to a git-initialized fixture under
  `test/runner.test.ts`; the task-tool stub test now claims wiring only.
- R1-P2 identity-based read swap: reviewer found no false-replacement/
  missed-swap case; kept as designed.
- R1-P2 unconsumed binding / accounting: named explicitly in §6 instead of
  implying SA-04 wiring exists.
- Reviewer residual (pin CLI `"zai / glm"` fallthrough): added to D2's pin
  requirement.

### Round 2 (2026-09-27) — REJECT (1×P1, 2×P2)

- R2-P1 `test/compaction-wiring.test.ts:127-156` pins the removed raw
  behavior (same-provider prefix kept in the wire ID; the cross-provider
  row ran the raw string on the parent's provider). Fixed: §4 names the
  three affected rows with per-row new expected values as red-before-green
  updates, and the round-1 disposition above is corrected.
- R2-P2 incomplete caller enumeration: the round-1 audit listed only four
  files. Fixed: all other `createTaskTool` callers audited (§4) — no
  further `modelReference`/override assertions affected.
- R2-P2 acceptance coverage: the compaction-wiring updates preserve the
  end-to-end settings/reference coverage (acceptance item 6); §4 states
  this explicitly alongside the new `childModelMetadata` unit tests.
- Confirmed in round 2, no action: D1 consequence list and D2 pin outcomes
  (including the untrimmed fallback return), A-vision-worktree
  feasibility, identity swap, §6 accounting honesty.
