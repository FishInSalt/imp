# SA-06 design: child launch record — persist and validate resumable launch state

> Identifier note (2026-10-06): new launch records write `inkVersion` (~~the
> legacy `impVersion` key remains readable~~; see
> [ink-rename-design](ink-rename-design.md) §11, Amendment A1). The
> historical text below keeps the original field name. That readable-legacy
> claim was superseded on 2026-10-09 — see the Track C update below.
>
> Update (2026-10-09, test-fixture-hygiene Track C): the legacy read arm
> has since been REMOVED — `inkVersion` is the sole accepted key and any
> record carrying `impVersion` now parses as invalid. See
> [test-fixture-hygiene-design](test-fixture-hygiene-design.md) §4.

Task list item: SA-06 ("Persist and validate resumable child launch state") —
`design/subagent-delegation-task-list.md` §SA-06. Branch:
`feat/sa-06-child-launch-record`. Date: 2026-09-28. Baseline: `848632a`.

Owner decisions confirmed before this draft (session 2026-09-28, in prose):

- **O1** Carrier: the launch record is a versioned `launch` block in the
  **child session header** (additive; unknown header fields are ignored by
  existing readers, a documented convention since M5). No new entry types, no
  parent-side entry, no sidecar file.
- **O2** imp-version drift is an incompatibility: a child launched under a
  different imp version than the resuming build is **not resumable**
  (explicit, actionable diagnostics; the transcript stays readable). The
  version string is coarse by design; a behavior-surface fingerprint is a
  documented possible refinement, not v1.

Design decisions introduced by this document (flagged for review):

- **L1** One source of truth per fact: the launch block carries creation-time
  facts, SA-03's `TaskRecord` carries terminal facts, and validation combines
  the two without guessing across them.
- **L2** A missing environment fingerprint is not an error — it is stated as
  `missing-launch` and the child is non-resumable. This covers legacy children
  (pre-SA-06), hosts that never wire the fingerprint getter, and attempts
  whose session file never materialized.
- **L3** The child-visible system prompt is fingerprinted **by source
  component** (files, extension modules, version) for actionable diagnostics,
  plus a **normalized whole-text hash** as the coverage check (L6) — the
  assembled text embeds a volatile `Date:` line
  (`src/core/system-prompt.ts:58`) by design, so raw-text hashing is off the
  table and normalizing exactly that line is the correct move (L6).
- **L4** Validation is a pure policy comparison (recorded vs current). It has
  no side effects, stores no approvals, and never weakens current permission
  checks; nothing in the record can re-grant anything.
- **L5** Worktree resumability is bounded by SA-01: an auto-removed (or
  otherwise vanished) worktree means the child is not resumable in place.
  Nothing is recreated, and no worktree is kept alive merely to manufacture
  resumability.
- **L6** Coverage check: `system.sha256` is the SHA-256 of the parent's
  assembled system text with exactly the `- Date: YYYY-MM-DD` line normalized
  (one pure function, used at launch and at validation). This catches every
  model-visible prompt channel the per-component fingerprints could otherwise
  miss (agent roster descriptions, tool-catalog text, MCP-provided
  descriptions, late-connected MCP servers) while never refusing on the one
  line that legitimately changes daily. Components remain the source of
  actionable diagnostics; `system-drift` is the catch-all code.

## 1. Problem (source-verified)

### 1.1 What exists today

- **Child session creation** (`src/core/session/manager.ts:58`): the file
  lives under `<sessions-dir>/children/`, the header links `parent` and keeps
  `cwd` = the **parent's** cwd. There is no launch record: not the agent role,
  not the model binding, not the tool contract, not the real execution cwd.
- **Lazy persistence** (`src/core/session/store.ts:307` `create` allocates
  only; `:414-446` `writeRecords` writes `header + "\n" + entry` on the first
  write at `:424`, exclusive-create). A child that never writes has no file.
- **Live spawn options** (`src/core/tools/task.ts:450-459`): provider, model,
  `modelReference`, system, tools are handed to `runSubagent` as runtime
  objects read at spawn. The child's system is assembled inside the engine
  (`src/core/subagent.ts:311-315`): parent system + `CHILD_SUFFIX` +
  `# Agent profile` + agent body.
- **What the task tool knows at spawn** (all before the session is created):
  the resolved agent definition (`task.ts:290`: name, `system` body, `source`),
  the SA-02 binding (`task.ts:333-339`), the final tool list (after narrowing,
  `task.ts:352-360`), the execution cwd and the worktree identity
  (`src/core/worktree.ts:16-33`: `RepoState.root`, `RepoState.head` baseline,
  `ChildWorktree.path/branch`).
- **Terminal facts exist** (SA-03 `TaskRecord`, `src/core/task-record.ts`):
  `childId`, `binding`, `cwd`, `tools` (names only), `transcript`,
  `worktree` disposition, `status`. Nothing reads a children file after the
  run, and the header cwd is the parent's cwd even for worktree children.

### 1.2 Failure scenarios if SA-07 resumed on this data

A transcript is conversation history, not a restart recipe. Reopening it in
the current parent directory with current defaults can silently change:

- the **role** (the agent file was edited or deleted — the old body is gone);
- the **working directory** (a worktree child would run in the parent's
  project because the header says so);
- the **model/provider** (no binding recorded — the current default would be
  used, so one child would run its two attempts on two different models);
- the **tool contract** (a child limited to read-only tools would silently
  gain writers);
- the **system context** (AGENTS.md / SYSTEM.md / extension sections changed);
- nothing can detect a **replaced or vanished worktree**; nothing can even
  find the child **safely** (no managed lookup; a caller-supplied filename
  would be an arbitrary-path read).

### 1.3 Why not hash the assembled system string

`buildSystemPrompt` embeds the current date (`system-prompt.ts:58`), so
hashing the assembled text verbatim would make every child non-resumable the
next day. The record therefore stores (a) the **normalized** whole-text hash
(L6: exactly the `- Date: YYYY-MM-DD` line is replaced before hashing — the
resumed child legitimately sees the new date) and (b) the **components** the
prompt is built from, for actionable diagnostics (§2.1). The binary-controlled
layer (base template, `CHILD_SUFFIX`, catalog assembly, builtin tool
semantics) is covered by the imp version gate (O2).

## 2. The launch record

### 2.1 Schema v1

Stored as `header.launch`, one JSON object:

```jsonc
{
  "version": 1,
  "parentSessionId": "<parent header id>",
  "childId": "<this file's header id>",
  "impVersion": "0.1.0",
  // Absent for generic children (no `agent` argument).
  "agent": {
    "name": "reviewer",
    "source": "/home/u/.imp/agents/reviewer.md",
    "roleSha256": "<64 lowercase hex of the agent body bytes>"
  },
  // SA-02 binding: the child's own model, family-exact.
  "model": { "providerName": "anthropic", "wireModelId": "claude-sonnet-4-6",
             "reference": "anthropic/claude-sonnet-4-6" },
  "cwd": "/abs/actual/execution/cwd",
  // Absent for shared-cwd children; worktree identity when isolation was active.
  "worktree": { "repoRoot": "/abs/repo", "baseline": "<40 hex commit>",
                "path": "/tmp/imp-worktree-x", "branch": "imp/task-x",
                "creationReflog": ["<sha> <subject>", "…"] }, // when capturable
  // Final child tool set, sorted by name; mcpServer only on MCP bridge tools.
  "tools": [ { "name": "read" }, { "name": "web_search", "mcpServer": "searx" } ],
  "system": {
    // SHA-256 of the parent's assembled system text, normalized (L6).
    "sha256": "…",
    // AS LOADED into this spawn's prompt, in load order (see §5.2/§5.3).
    "contextFiles": [ { "path": "/abs/AGENTS.md", "sha256": "…" } ],
    "promptFiles": [ { "kind": "override", "path": "/abs/.imp/SYSTEM.md", "sha256": "…" } ],
    "extensionContexts": [ { "id": "lint-rules", "sha256": "…" } ]
  },
  "extensions": [ { "name": "foo", "origin": "global", "path": "/abs/foo.mjs", "sha256": "…" } ]
}
```

Field requirements (all enforced by the parser):

- `version === 1`; unknown extra fields are tolerated by the parser
  (readers-ignore convention) but the builder never writes any — the exact key
  set of builder output is pinned by a test (no secrets, no runtime objects
  can ever enter by construction: every field is a scalar or an array of
  plain objects of scalars). The **session header `version` and the launch
  `version` are independent gates**: lookup refuses `header.version !== 1`
  (`unknown-version`) regardless of the launch block, and the launch block is
  refused on its own version (checked in `parseChildLaunch`, `invalid-launch`);
  a future bump of either is a refusal, never a guess.
- The L6 normalization is exact and test-pinned: the line matching
  `/^- Date: \d{4}-\d{2}-\d{2}$/m` is replaced with `- Date: <normalized>`; no
  other rewrite exists (override-mode prompts have no such line — the text
  hashes as-is).
- `parentSessionId` is validated to equal `header.parent`; `childId` to equal
  `header.id` at lookup time (a file copied into another parent's directory
  is refused).
- Strings are plain; hashes are 64 hex chars; paths are absolute;
  `tools` is sorted by `name` (set semantics for comparison, stable bytes for
  diagnostics); arrays may be empty but must be present when their block is.
- Deliberately absent: created-at (the header's `timestamp` already is the
  creation time), timeout/autoCompact/settings (SA-07 resets policy per
  attempt), approvals, credentials, provider instances, tool closures, any
  environment snapshot.

### 2.2 Storage and write timing

- `SessionStore.create(filePath, cwd, id?, parent?, launch?)` sets
  `header.launch`; `createChildSession(parent, baseDir?, launch?)` passes it
  through. The type lives in `src/core/child-launch.ts`; `store.ts` imports it
  **type-only** (intended to keep the runtime edge one-way —
  `child-launch.ts` → `store.ts`). Cycle-freedom under `tsc`/`biome` is an
  implementation-step check (UNVERIFIED in review; fallback if tooling
  objects: declare the record types in `store.ts` and re-export).
- The record is persisted **atomically with the first entry**
  (`store.ts:414-446`; the single header-serialization site is `:424`,
  `header + "\n" + entry` under `wx`). Invariant: `create` populates
  `header.launch` **at construction** — the header is only ever serialized
  once, at `:424`, so no write path can emit the header without the launch
  block (red test: seed a model before the first append — the seeded
  `session_model` prepend path — and assert line 1 still carries `launch`).
  No eager flush: lazy creation keeps SA-03's observable transcript semantics
  exactly (a zero-write attempt still has no file → `transcript.why =
  "no-content"`), and the launch record lands on disk at the same moment as
  the first child message — which the child loop appends before its first
  provider call (`src/core/loop.ts:141`).
- A write failure is observed by the existing `observeSessionWrites` wrapper
  (`task.ts:196-205`) and reported through SA-03's `transcript.writeFailed`
  exactly as today; a partially written or unreadable file simply fails
  lookup/validation (containment: **resumable requires a validly parsed
  launch block AND a readable file** — no record can be advertised as
  resumable without it).

## 3. Managed lookup

`findChildByLaunch(parent: SessionStore, childId: string)` in
`src/core/child-launch.ts`:

1. Search directory: `join(dirname(parent.filePath), "children")` — derived
   from the parent **file's actual location**, not from `header.cwd` or a
   `baseDir` argument, so restore-after-restart uses the same directory the
   child was written to and a moved parent file cannot reach foreign children.
   Precondition (explicit): for every flow that writes children,
   `createChildSession` writes beside the parent file's own directory
   (`sessionsDirFor(parent.header.cwd, baseDir)/children` — the same
   directory `createSession` put the parent file in when both used the same
   `cwd` + `baseDir`). `baseDir` is **not re-derivable** from the parent file,
   and lookup never tries: a parent file that lives outside its cwd-keyed
   directory simply has no reachable children (refused, never guessed).
2. Enumerate `*.jsonl`; for each candidate read only the **first line**
   (bounded read; no full-file parse for enumeration). Requirements:
   - `lstat` says regular file — symlinks are refused (`symlink`);
   - first line parses as JSON, `type === "session"`, `version === 1`
     (`unknown-version` otherwise — future header versions are refused, not
     guessed);
   - `header.id === childId` is the only match rule (filename is never
     trusted — "managed lookup reads the header id");
   - >1 matches for the same id → `ambiguous` (hand-copied files are possible).
3. On a match: containment (realpath of the file must sit inside the realpath
   of the children directory), then `header.parent === parent.header.id`
   (`not-owned` otherwise). The **launch identity binding (§2.1)** is then
   enforced: `launch.childId === header.id` (`invalid-launch` otherwise) and
   `launch.parentSessionId === header.parent` (`not-owned` otherwise) — a
   record for a different child or parent can never donate its settled
   status (acceptance round 1: this check was specified but missing).
4. Full `SessionStore.open` (validates the entry stream), then **corruption
   probes** scoped to this boundary: an **explicit structural validation**
   of the effective branch (acceptance round 2 — every message checked per
   role for its required fields/types, `retainedTail` must be an array of
   valid messages, compaction/branchSummary summaries must be strings; a
   `buildContext()` success is NOT proof — a string `retainedTail` spreads
   into garbage without throwing), the traversal guard (`getBranch()`:
   a broken parent chain OR a parentId cycle — guarded in the store's walk
   since acceptance round 1, where a cycle used to hang forever — is
   `malformed`) and `buildContext()` as a catch-all; ordinary history reads
   keep their lenient rules. Then
   `parseChildLaunch(header.launch)` (`missing-launch`
   when absent — L2; `invalid-launch` when off-schema).
5. Result: `{ filePath, header, launch, store, messageCount }` — `store` is
   the opened `SessionStore`, handed to SA-07 for the effective-history build
   (no re-open); `messageCount` counts `message` entries over the whole file
   and is the basis of the `empty-transcript` check (documented basis, same
   as check 1: the child file is branch-independent). Any `getBranch()` use is
   wrapped: a broken parent chain in the child file ⇒ `malformed`, never a
   throw. Alternative result: `{ code, message }` with codes:
   `not-found`, `symlink`, `malformed`, `unknown-version`, `ambiguous`,
   `not-owned`, `missing-launch`, `invalid-launch`.

## 4. Validation

`validateChildContinuation(file, parent, current): Promise<Verdict>` — async
because worktree probing runs git. `current` is the **currently resolved
environment**, supplied by SA-07's wiring (all inputs are plain data; §5.4):

```ts
interface CurrentChildEnvironment {
  impVersion: string;
  cwd: string | undefined;                      // the parent's current cwd
  agentResolver: (name: string) => AgentDefinition | undefined;
  systemSources: LaunchSystemSources;           // contextFiles + promptFiles + extensionContexts
  extensions: ExtensionModuleIdentity[];
  childTools: ToolContractEntry[];              // built with the same selection rules as at spawn
  binding: ChildModelBinding;                   // the now-resolved child model binding
}
```

### 4.1 Checks (all run; every failure appends a reason)

Check 1 basis (explicit decision): the records are collected over
`parent.getEntries()` — **all entries, file order** — not `getBranch()`. The
child's own session file is branch-independent, append order is time order,
and an attempt recorded on a branch the parent later left is still a real,
settled attempt of this parent session (the same whole-session precedent
SA-05 set for cost). `getBranch()` is used only for the `onCurrentBranch`
diagnostic (§4.3), wrapped so a broken parent chain can never throw out of
validation. Review round 1 recommended the branch basis; kept all-entries
with this rationale, documented and pinned by the fork-away red test (§8).

| # | Check | Failure code |
|---|-------|--------------|
| 1 | Parent-side history: `collectTaskRecords(parent.getEntries())` filtered by `childId` is non-empty; at least one `launched: true`; the last record (file order) gives `lastStatus` | `no-record` |
| 2 | `messageCount > 0` | `empty-transcript` |
| 3 | `impVersion` equals the launching version (O2) | `version-drift` |
| 4 | Named agent still resolves; `roleSha256` matches the current body (source path is diagnostics-only — see §4.4) | `agent-missing` / `agent-drift` |
| 5 | `system.sha256` (normalized, L6) equals the current assembly's | `system-drift` |
| 6 | `contextFiles` equal (paths + hashes, in order; a now-missing/unreadable file yields the same code with a distinct message) | `context-files-drift` |
| 7 | `promptFiles` equal (kind + path + hash) | `prompt-files-drift` |
| 8 | `extensionContexts` equal (ids + hashes, in order) | `extension-contexts-drift` |
| 9 | `extensions` equal (name + origin + path + hash, in order) | `extension-drift` |
| 10 | `tools` equal (canonical projection, `name` + `mcpServer`) | `tools-drift` |
| 11 | `model` binding equal | `model-drift` |
| 12 | Shared-cwd child: `cwd === launch.cwd` and it exists | `cwd-drift` / `cwd-missing` |
| 13 | Worktree child: probe (§4.2) | `worktree-unregistered` / `worktree-branch-swapped` / `worktree-missing` / `worktree-repo-missing` / `worktree-replaced` / `worktree-history-replaced` |

Reason messages are actionable (they name the changed files/modules, both
versions, both model references, the diffing tool names, the worktree path and
what was found). Ordered, stable codes; SA-07 branches on codes, never prose.

Check 1 defines execution state: a record exists ⇒ the attempt **settled**
(SA-03 writes records only at settle; `finish()` paths). No record ⇒
`executionState: "unknown"` — this covers both "still running somewhere" and
"SIGKILL before any parent-side write" (SA-05's L3) without guessing which.
Invariant, pinned by test: `executionState === "unknown"` ⇒
`resumable === false` (no-record is always a reason). In-process running
children have no record yet, so validation refuses them by construction; SA-07
must AND its own lease verdict on top (§5.4) — `resumable` never authorizes
execution by itself.

### 4.2 Worktree probe

New `probeWorktreeIdentity()` in `src/core/worktree.ts` (uses the existing
private `git` helper; no new runner). Order and codes:

- **path-side identity first (acceptance round 1, P1)**: the repository-side
  registration alone cannot prove the directory still IS the recorded
  checkout. From the child path: `git rev-parse --git-common-dir` must
  resolve to a directory whose parent is the recorded `repoRoot` (else
  `worktree-replaced` — e.g. the `.git` link removed, or an unrelated
  repository initialized in place), `git rev-parse --show-toplevel` must
  equal the recorded path, and `git symbolic-ref -q HEAD` must be the
  recorded branch (else `worktree-branch-swapped`);
- `repoRoot` missing/unresolvable → `worktree-repo-missing`; the recorded
  `path` missing → `worktree-missing`;
- `git worktree list --porcelain` (run at `repoRoot`): the recorded `path`
  (realpath-compared) must be registered — else `worktree-unregistered`; if
  registered but under a different branch than `refs/heads/<branch>` →
  `worktree-branch-swapped` (distinct remediation: wrong branch vs no
  registration);
- the recorded `baseline` must be an **ancestor of (or equal to) the branch
  tip** (`git merge-base --is-ancestor`; an unreachable/GC'd baseline maps to
  `worktree-history-replaced`, never to a raw exit-code guess) — ordinary
  commits made by the child on its own branch are expected work, not drift;
- when the launch record carries the SA-01 `creationReflog` snapshot (folded
  in from `ChildWorktree`, §2.1: it is recorded when capturable), the branch
  reflog must still **end with** that snapshot — `git reflog show` lists
  newest first, so the child's own commits prepend entries and the creation
  snapshot stays the oldest tail (SA-01 D2 step 3 verbatim); a
  rewritten/recreated log is `worktree-history-replaced`. When the snapshot
  was unavailable at launch, the verdict says so in its diagnostics and
  relies on the ancestry check alone (documented weaker case);
- **no cleanliness checks** — uncommitted, staged and new work are all fine
  (resume is not a requirement that the tree stay at its creation commit).
  "No cleanliness checks" does **not** mean "no identity checks": the
  identity is the (repoRoot, path, branch, baseline, reflog-when-available)
  tuple, and every element present is verified;
- a vanished path (SA-01 auto-removal, `/worktrees` handback, manual removal)
  is `worktree-missing` — non-resumable in place, per L5.

### 4.3 Verdict

```ts
interface ChildContinuationVerdict {
  resumable: boolean;                       // reasons.length === 0
  executionState: "settled" | "unknown";    // unknown ⇒ resumable === false
  attempts: number;                         // SA-03 records for this childId (all entries)
  lastStatus?: TaskRecordStatus;            // SA-07 applies per-status policy
  onCurrentBranch?: boolean;                // diagnostic only (see §4.1 basis)
  reasons: Array<{ code: ContinuationCode; message: string }>;
}
```

`resumable` is the environment+state verdict only; SA-07 owns the final
decision (per-status policy, explicit caller choices, leases; §5.4). The
opened child `store` travels in the lookup descriptor (§3), not here.

### 4.4 Deliberately not compared (documented policy)

- Approvals/permissions: current checks always rule; nothing in the record can
  re-grant (L4). This is also SA-06's explicit answer to the task-list bullet
  "current permission restrictions are not weakened": the record cannot
  express a permission, so it cannot weaken one.
- `timeoutMs` / `autoCompact` / compaction settings: SA-07 resets policy for
  the new attempt.
- Provider credentials/instances: only the binding is identity.
- The parent's current model: irrelevant — only the child's recorded binding
  is compared against the now-resolved binding.
- Tool order: canonicalized (`tools` sorted). Builtin tool text/semantics:
  covered by the version gate — **coarse and over-broad** (any upgrade
  refuses, harmless ones included), not a precise per-tool check.
- Agent `source` path: recorded for diagnostics, deliberately **not** gated —
  behavioral identity is name + body hash + the resulting tool/model/worktree
  facts; a moved/renamed file with identical behavior is not an
  incompatibility. (Review round 1 suggested comparing it; kept
  diagnostics-only with this rationale.)
- Extension **transitive imports**: not fingerprinted — a changed import is
  **resumed silently** (recorded limit, §7; pinned by a limit test).
- MCP: the model-visible description text is covered indirectly by the L6
  system hash; runtime behavior changes under identical names/descriptions
  are not detectable.

## 5. Write path and plumbing

### 5.1 task.ts

After agent resolution (`task.ts:288-290`), model binding
(`task.ts:333-339`), tool narrowing (`task.ts:352-358`) and cwd/worktree
resolution (`task.ts:363-431`) — everything is known **before** the session
creation block (`task.ts:437-449`, `createChildSession` at `:444`) — the tool
assembles `ChildLaunchInput` and calls
`createChildSession(parentStore, options.sessionBaseDir, launch)`. When
`options.getLaunchEnvironment` is absent (hosts/tests without full wiring),
**no launch block is written** (L2; conservative non-resumable). SA-03's
`rec`/result contract is untouched.

### 5.2 Runner

`assembleSystem` retains the sources it used (`this.systemSources =
{ contextFiles, promptFiles }`; refreshed whenever the prompt is re-assembled,
e.g. MCP sync `refreshSystemPrompt`). New TaskToolOptions member:

```ts
getLaunchEnvironment?: () => {
  impVersion: string;
  systemText: string;       // the parent's assembled system text as of this spawn (L6; hashed by child-launch.ts)
  contextFiles: LaunchFileFingerprint[];
  promptFiles: LaunchPromptFileFingerprint[];
  extensions: ExtensionModuleIdentity[];
  extensionContexts: ExtensionContextIdentity[];
};
```

The runner returns the retained sources plus
`this.options.extensions?.moduleIdentities()` /
`.contextSectionIdentities()`. No re-reads at spawn: the record describes the
prompt inputs that actually produced `this.system`.

### 5.3 Extension module identity

`src/extensions/loader.ts` computes `sha256` of each candidate's entry module
file bytes at load (files are small; the loader already resolves the exact
entry path). `LoadedExtensions.summaries` gains additive `path` + `sha256`;
`ExtensionRegistry.beginExtension(name, origin, identity?)` stores it and the
registry exposes `moduleIdentities()` and `contextSectionIdentities()`
(ordered by load order — handler chain order is load order, so order is part
of the identity). A failed-to-load extension contributes nothing at launch;
if its loadability changed by resume time, the set difference refuses.

### 5.4 SA-07's side of the contract

SA-07 supplies `CurrentChildEnvironment` from the live runner (agent roster,
system sources incl. the **current assembled system text** for L6, extension
identities, the child tool pool built with the same selection rules, the
resolved child binding) and consumes `findChildByLaunch` +
`validateChildContinuation`. SA-06 provides no locks/leases, no resume tool,
no UI: **SA-07 must AND its own lease/ownership verdict with `resumable`** —
SA-06 makes no cross-process claim, and `resumable: true` never authorizes
execution by itself. For the effective-history build, SA-07 reuses the
already-opened `store` from the lookup descriptor instead of re-parsing.

## 6. Interactions and non-goals

### 6.1 SA-06 acceptance bullets → owner

| Task-list acceptance bullet | Owner |
|---|---|
| Identity/environment persisted (generic/named, shared-cwd/worktree) | SA-06 (record + e2e tests) |
| Parent restart resolves its eligible child; unrelated parents cannot | SA-06 (managed lookup tests) |
| Missing/corrupt/legacy/disabled/unknown-version safely rejected, history readable | SA-06 (§3 codes, §8 cases) |
| Worktree replaced/missing never falls back to parent cwd; child commits fine; unexpected-history detection defined | SA-06 (§4.2 probe; no-fallback is the refusal itself) |
| Profile/model/tool/extension drift policy; permissions not weakened | SA-06 (checks 4–6, 9–11) + **permissions**: current checks at the SA-07 boundary, never the record (§4.4) |
| Partial launch/metadata-write failure never advertises resumability | SA-06 (§2.2 invariant + §8 injected-failure cases) |
| No secrets or executable runtime objects in records | SA-06 (§2.1 schema lock + types) |

### 6.2 Interactions

- **SA-03**: observable semantics preserved (transcript fields, `no-content`,
  `writeFailed`); the launch block is additive and SA-03's parser ignores it.
  No new entry types; `collectTaskRecords` unaffected.
- **SA-04/05**: the SA-05 tracker reads parent entries only; nothing changes.
- **SA-01**: cleanup rules unchanged; removed worktrees = non-resumable.
- **Non-goals**: resume tool/UX (SA-07); cross-process leases; worktree
  recreation or keep-alive; migration of legacy children; extension
  import-graph hashing; MCP server internals beyond tool names + server names;
  cross-project resume; any storage of approvals.

## 7. Recorded limits

- Extension fingerprint covers the **entry module bytes** only — a changed
  transitive import is **resumed silently** (unsafe direction, pinned by a
  limit test; import-graph hashing is deferred).
- MCP: tool names + `mcpServer` names are compared; description text is
  covered by the L6 system hash, but runtime behavior changes under identical
  names/descriptions are not detectable.
- L6's catch-all is deliberately over-strict: any model-visible prompt change
  since the launch (a roster description edit, a late-connected MCP server)
  refuses the resume with `system-drift`. Conservative by choice;
  revisitable.
- imp version gate is coarse (O2): harmless upgrades also refuse; the
  behavior-surface fingerprint remains a possible future refinement.
- A moved parent session file loses lookup access to its children (children
  stay beside the file's original directory) — refused, never guessed.
- No migration: pre-SA-06 children stay readable and permanently
  non-resumable.

## 8. Test plan (red evidence first)

New `test/child-launch.test.ts`:

- builder output schema lock (exact key set; scalars only);
- parser accepts the builder, rejects every off-schema variant (wrong
  version, missing required field, wrong types, non-hex hash);
- lookup: found by header id despite a mismatched filename; symlinked file
  refused; path outside containment refused; foreign-parent copy refused;
  duplicate ids → ambiguous; unknown header version refused; malformed first
  line refused; legacy child (no launch) → `missing-launch`.

New `test/child-launch-validation.test.ts` (each drift = one red case):
version, agent (edited body / removed file), context files, prompt files,
extension contexts, extension module (edited bytes), extension set (added
one), tools (added/removed/renamed/mcpServer change), model binding, shared
cwd drift, no-record, empty transcript; worktree: kept and committed-to
(resumable), vanished, unregistered, branch recreated at an unrelated commit,
dirty-but-present (resumable).

E2E (task harness, fake providers, tmp dirs):

- a generic child, a named child, and a worktree child each persist the
  actual identity/environment (assert the header block);
- restart: a fresh `SessionStore.open(parent)` resolves the child; another
  parent (same cwd, different file) does not;
- persistence disabled / zero-write attempt → no launch block anywhere →
  refused; injected first-write failure → child still runs, validation
  refuses, `transcript.writeFailed` unchanged.

Additional red cases (review round 1, track B F5):

- legacy child whose parent has a settled record → `missing-launch`, with
  `executionState: "settled"` while `resumable: false` (the L2 intersection);
- header v2 with an otherwise valid launch block → `unknown-version`;
- empty/whitespace-only first line; torn first line; torn **appended** line →
  `malformed` (pinning whatever `SessionStore.open` does today — the design
  must not assume tolerance);
- `children/` directory absent → `not-found`, no throw;
- a tampered launch block (extra tool names, an `"approved": true` field) →
  unknown fields are ignored, the verdict is unaffected, tools are still
  compared against the current pool;
- broken parent chain inside the child file → `malformed`, never a throw;
- fork-away case (F1): the only records for the child live on an abandoned
  branch → stays resumable (documented basis), `onCurrentBranch: false`;
- context file now unreadable → `context-files-drift` with the distinct
  "missing or unreadable" message;
- extension that previously failed to load now loads (set difference) →
  `extension-drift`;
- worktree: path present but branch swapped → `worktree-branch-swapped`;
  branch recreated at the baseline via a reflog rewrite →
  `worktree-history-replaced`; `repoRoot` deleted while the path survives →
  `worktree-repo-missing`;
- seeded-model-first-write → line 1 still carries `launch` (§2.2 invariant);
- limit pin: extension transitive import changed → still resumable
  (documents the unsafe direction of §7).

Regression: SA-03/04/05 suites and the existing task/tool suites stay green
(no observable change to existing records; any test pinning exact child
header JSON, if one exists, is updated consciously in the red-evidence
commit).

## 9. Affected files

- new: `src/core/child-launch.ts`, `test/child-launch.test.ts`,
  `test/child-launch-validation.test.ts`, this document;
- `src/core/session/store.ts` (type-only `launch` in `SessionHeader`;
  `create` parameter),
- `src/core/session/manager.ts` (`createChildSession` parameter),
- `src/core/tools/task.ts` (assembly + wiring),
- `src/runner.ts` (system-source retention + `getLaunchEnvironment`),
- `src/extensions/loader.ts` + `src/extensions/registry.ts` + types if needed
  (module identity),
- `src/core/worktree.ts` (`probeWorktreeIdentity`),
- task-tool e2e test file (chosen at implementation).

## 10. Process notes

Red evidence first (the failing acceptance cases above, committed before the
implementation), then implementation, independent implementation review, owner
acceptance, `--no-ff` merge. Review records are appended below as they close.

Implementation first steps (the review's UNVERIFIED list — verify before
building on it): (1) `runner.ts assembleSystem` can retain
`contextFiles`/`promptFiles` as data at assembly/refresh sites; (2) the
type-only-import cycle-freedom under `tsc`/`biome` (fallback in §2.2);
(3) extension loader/registry shapes accept the additive identity fields;
(4) `git merge-base --is-ancestor` edge behavior for unreachable baselines
(mapped to a reason code, never exit-code guessing); (5) no existing test
pins exact child header JSON.

## 11. Review records

### Round 1 — two-track independent adversarial review (2026-09-28)

Two fresh-context reviewers (track A: facts/completeness/storage contract;
track B: validation semantics/SA-07 contract/test plan) each returned
**APPROVE WITH CORRECTIONS**. Folded:

- citation fixes (§1.1, §1.3, §2.2, §5.1 ranges);
- the single-serialization invariant for `header.launch` + the
  seeded-first-write red test (§2.2);
- the lookup precondition (`baseDir` not re-derivable; §3);
- independent gates for header vs launch version (§2.1);
- L6: normalized whole-text system hash as the coverage check (closes the
  roster/catalog/MCP-description channels);
- lookup returns the opened store for SA-07's history build; `messageCount`
  basis documented (§3);
- check-1 basis pinned and documented, `onCurrentBranch` diagnostic added
  (§4.1/§4.3); the invariant `unknown ⇒ not resumable` (§4.1);
- worktree probe: `worktree-branch-swapped`, SA-01 reflog snapshot reuse,
  ancestry edge mapping, "no cleanliness ≠ no identity" (§4.2);
- cwd split into `cwd-drift` / `cwd-missing` (§4.1);
- lease AND-ing made explicit for SA-07 (§5.4);
- acceptance-bullet ownership table (§6.1);
- limits reworded (transitive imports resumed silently; MCP description
  coverage; L6 over-strictness) (§7);
- the F5 red-case list folded into §8; implementation first steps (§10).

Recommendations considered and NOT adopted (with rationale, no silent
ignore): (a) track B proposed `getBranch()` as the authoritative basis for
settled/`lastStatus` — kept all-entries (the child file is
branch-independent; attempts recorded on a later-abandoned branch are still
real; SA-05's whole-session precedent; append order is time order), with the
`onCurrentBranch` diagnostic and a pinning test instead; (b) track B proposed
gating on the agent `source` path — kept diagnostics-only (behavioral
identity is the body hash + tool/model/worktree facts; a path move with
identical behavior is not an incompatibility).

### Implementation review — round 2 (implementation, 2026-09-28)

Fresh-context adversarial review of the implementation (f7b4e40):
**APPROVE WITH CORRECTIONS**; all findings folded:

- (P2) the §2.2 first-write invariant is now pinned for BOTH paths —
  `seedModel` (the model rides the header on the same first write) and
  `setModel` (header + `session_model` line) — plus lookup visibility;
- (P2) the `outside` containment branch is annotated as
  defense-in-depth: unreachable for readdir-derived candidates (symlinked
  child files are refused by `lstat` earlier), kept for future callers;
- (P2) the reviewer's symlinked-children probe had placed the symlink
  beside the sessions BASE rather than beside the parent file. With the
  design's precondition (children co-located with the parent file) the
  flow works end-to-end after mounting the symlink at the right level;
  pinned by a regression test;
- (P3) `canonicalTools` now deduplicates by name (set semantics, as §2.1
  states), pinned by a duplicate-tools no-drift test;
- (P3) added pins: whitespace-only first line, torn first line (both
  `malformed`), torn appended line (the store's documented final-line
  tolerance — the parsed view drops it), and the extension
  transitive-import limit (entry bytes unchanged => identical identity =>
  resumed silently; pinned so a future fix flips a known expectation);
- (P3) a real-Runner test now drives `getLaunchEnvironment` retention
  (the §8 e2e previously injected the getter and could not see runner
  drift).

### Acceptance round 1 — fixes (2026-09-29)

Owner verification (11 suites, 301 passed / 1 skipped; typecheck/lint/build
green) returned 4 blocking findings; all fixed with rejection tests:

- **P1 identity binding**: lookup and enumeration now enforce
  `launch.childId === header.id` (`invalid-launch`) and
  `launch.parentSessionId === header.parent` (`not-owned`) — the §2.1 text
  was right; the code had skipped it, so a transcript could borrow another
  child's settled record. Rejection tests added for both halves; the
  enumeration marks the childId-tampered file `invalid-launch`.
- **P1 worktree replacement**: the probe now verifies the checkout FROM the
  child path (common git directory → repo root, `--show-toplevel`, current
  branch) before trusting the repository-side registration; `.git` removed
  or an unrelated repo initialized in place now refuses as
  `worktree-replaced`. Two tests added.
- **P1 corrupt transcripts**: `SessionStore.getBranch` gained a parentId-cycle
  guard (a cycle used to hang forever — the test doubles as a no-hang pin)
  and the lookup now probes `buildContext()`, so a compaction without
  `retainedTail` refuses as `malformed` instead of crashing downstream.
  Two tests added.
- **P2 path schema**: absolute-path validation now covers `agent.source`,
  `worktree.repoRoot`/`worktree.path`, `contextFiles[].path` and
  `promptFiles[].path` (the §2.1 contract); five rejection cases added.
- The acceptance runner had skipped one test because its fixture ran
  `git reset --hard`; the scenario now repoints the branch with
  `update-ref` (equivalent, non-destructive), so every test can run
  unattended.

### Acceptance round 2 — fixes (2026-09-29)

Owner re-verification confirmed the four round-1 fixes and found one
remaining P2: `buildContext()` succeeding does not prove structural
validity. Three owner repros passed through: `retainedTail: "bad"` (spread
into single-character "messages"), `retainedTail: [null]` (crash occurs
later in estimation), and a user message with only `{role:"user"}`
(`content is not iterable`). Fixed by an explicit structural validator at
the continuation boundary (`effectiveHistoryProblem`): every message is
checked per role for its required fields and types (user content must be a
string or content-block array; assistant blocks/usage/stopReason;
toolResult results), `retainedTail` must be an array of structurally valid
messages, summaries must be strings. The check is scoped to the managed
lookup / continuation boundary — ordinary history reads keep their lenient
compatibility rules (per the owner's guidance). Three regression tests
added; the normal-compaction suites and the torn-final-line tolerance test
stay green. `buildContext()` remains as a catch-all probe after the
explicit checks.

Delta-review notes folded: the per-role usage check now also rejects
non-finite token values (cosmetic consistency), and a **recorded
pre-existing gap** (NOT fixed here, provider-side): `anthropic.ts` casts a
raw wire `stop_reason` to the `StopReason` union without a runtime check, so
a transcript could hold a value outside the union (e.g. `refusal`) and the
structural validator would conservatively refuse `malformed`. Faithful to
the declared type; a future provider-side normalization closes it.

## 12. Implementation record

Landed on `feat/sa-06-child-launch-record` after the red-evidence commit
(`2881d39`). Concrete deviations from the sketches above (all deliberate,
each with its reason; behavior is what the reviewed text describes):

1. `createChildSession(parent, baseDir?, launchFor?)` takes a **factory**
   `launchFor(childId)` instead of a prebuilt record: the launch block must
   be set at construction with the freshly allocated child id (§2.2's
   single-serialization invariant), which a prebuilt value cannot carry.
2. The builder and the validator take **raw source content**
   (`{path, content}`, `{kind, path, text}`, `{id, text}`, module identities
   as hashed by the loader) and hash internally — one hashing authority keeps
   launch and validation bit-identical. The doc's "fingerprint" shapes are the
   internal comparison form.
3. `findChildByLaunch` reports pre-match anomalies (symlinks, malformed
   first lines, unknown header versions in files that do **not** match the
   requested id) as diagnostics inside `not-found`; the stable codes
   themselves are returned for the **matched** file where applicable and by
   the new `listChildLaunches(parent)` enumeration (SA-07's diagnostics
   surface). One added code: `outside` (realpath containment failure).
4. Root cause found while implementing: `git reflog show` lists newest
   first, so the child's own commits PREPEND entries. The creation snapshot
   therefore must remain the listing's **tail** — SA-01 D2 step 3 verbatim
   (`worktree.ts probeWorktreeIdentity`); §4.2 and the schema comment carry
   this wording. A "prefix" misreading would have refused every worktree
   child that committed (caught by the kept+committed red case).
5. `SessionStore.create`'s `id` parameter is explicitly typed `string`
   (widened from the `randomUUID()` UUID literal type) for explicit-id
   callers — tests pin ids like `"child-1"`; the child header id is not
   required to be a UUID by any reader.

Consequences verified by the red cases turning green: 40 new unit tests
(child-launch.test.ts, child-launch-validation.test.ts) + 3 e2e cases in
task-tool.test.ts; full suite 118 files / 2244 tests; lint 223 files.
