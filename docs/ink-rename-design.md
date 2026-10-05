# Ink rename and single-user cutover

> **Historical design and implementation snapshot.** The branding, configuration,
> trust and protocol decisions remain implemented. The ordinary-history migration,
> full-state copying and live source-linked activation proposal below was abandoned
> in favor of an independent installation with selected configuration only. Use
> [the current installation and acceptance record](ink-local-install.md), not
> sections 4-5 or the old activation matrix, for the local outcome and remaining
> approval boundaries. The obsolete runbook and helpers are available in Git at
> `b1deda4`; their later removal does not invalidate the test results recorded here.
> This document is not a current deployment procedure.

- Date: 2026-10-04
- Revision: r3
- Status: **WORKSPACE IMPLEMENTATION VERIFIED** — approved design r3; runtime, isolation, packaging and synthetic cutover helper code reviews closed. Owner confirmed `ink-agent@0.2.0` on 2026-10-04. Acceptance recorded on 2026-10-05. Global migration, installation, live integration and publication remain separately gated.
- Design branch: `design/ink-rename`
- Inspected base: `d43f09234bcd40413bca122c4ae1e1412b232242`
- Product decision: The owner selected **Ink**, with target command **`ink`**.

## 1. Goal, scope, and authorization

Rename this open-source AI assistant and agent harness from imp to Ink. Prefer a single cutover while there are no external users, not a permanent dual-name installation. Preserve ordinary sessions, credentials, trust decisions, and safety checks. Broaden the product description beyond coding without adding features or weakening workspace/approval instructions.

This document authorizes nothing outside the workspace. Writing/reviewing it is the current task. Implementation, user-home migration, global installation, publication, account changes, and GitHub changes are separate phases. Each sensitive operation requires a standalone description of the affected resources and explicit owner approval before execution. A dry-run CI dispatch is still an external side effect.

No credential values, private configuration contents, or conversation contents are needed for this design. No paid-provider calls are part of verification. Package registry absence is not a reservation or a legal clearance; Ink has known software-name collisions and its trademark availability remains unconfirmed.

### Local observations that change the implementation plan

- The checkout is clean; only `/Users/z/Z/Agent_demo/imp` is currently registered by `git worktree list`. Earlier additional worktrees are not assumed present.
- `/opt/homebrew/bin/imp` links through global `node_modules/imp` to this checkout's `bin/imp.js`. Renaming that file on the live checkout would immediately break the installed command.
- `~/.ink` and an `ink` command are absent on the inspected machine; recheck at cutover.
- `~/.imp/extensions/guardian.mjs` is a regular installed copy. `notify.mjs`, `task-timer.mjs`, `tool-colors.mjs`, and `web-search` are links to this checkout's examples. A guardian backup file is also present; it is not an active `.mjs` entry.
- The checkout has tracked `.imp/settings.json` containing `autoCompact: false`. Preserve that setting.

Implementation must therefore start in a **new isolated worktree inside `/Users/z/Z/Agent_demo`**, based on the reviewed design, not by changing the currently linked checkout. Do not move the existing source directory. Do not redirect installed extension links to the implementation worktree during development. Before any dependency-install command, inspect the worktree's `node_modules` ownership: an automatically shared symlink must not be used for `npm ci` or dependency mutation, since that would modify the live checkout. Either use existing dependencies read-only or create independently owned dependencies under an explicitly safe workspace/scratch path.

The proposed final local installation remains **source-linked to `/Users/z/Z/Agent_demo/imp`**. Artifact installation is for isolated packaging verification and later public distribution, not an implicit replacement of the local arrangement. `dist/` is ignored: a merge does not deploy the runtime. The stopped-process cutover must build the integrated source in this authoritative installation root before exposing `ink`, and must retire both the historical global executable and `node_modules/imp` registration explicitly.

## 2. Decisions and owner inputs

| Surface | Design decision |
| --- | --- |
| Product / executable | `Ink` / `ink`; one bin mapping to `bin/ink.js`, no `imp` command alias |
| Description | `Ink — an open-source AI assistant and agent harness for the terminal` |
| npm package | Owner confirmed `ink-agent`; recheck publishability before release. Never choose plain `ink`, which is an unrelated package. |
| First Ink version | Owner confirmed `0.2.0` in package, lockfile, and `src/format.ts`. Do not reuse published `0.1.0` or its tag. |
| Global / project root | `~/.ink` / `<project>/.ink`, with no automatic `.imp` fallback, merge, or dual discovery |
| Environment | `INK_*` replaces active `IMP_*`, with no aliases; the bash tool injects `INK=1` instead of `IMP=1`. Provider-owned variables and arbitrary inherited environment remain unchanged. |
| Repository | Keep `FishInSalt/imp` and its actual URLs initially. A GitHub rename to `FishInSalt/ink` is optional and requires separate approval. Do not advertise nonexistent URLs. |
| Source / existing worktrees | Do not move or rename their directories or branches. New task worktrees use Ink names. |
| History | Preserve Git history, released tags, historical design/ledger entries and JSONL bytes. Add a new rename changelog entry and supersession pointers where needed. |
| Ordinary sessions | Supported after an approved state migration with original project cwd unchanged; prove using offline fixtures. |
| Historical child sessions | Inspectable but **not resumable under Ink**. Keep the v1 `impVersion` field. Version `0.2.0` supplies version-drift refusal even for unchanged custom prompts when earlier lookup/provider/tool prerequisites pass; earlier safe refusals remain valid. Never rewrite launch records or hashes. |
| Lease identity | Retain `.imp-machine-id` as an opaque historical storage identifier, including for new leases. Preserve contents and lease protocol; no new machine identity from a branding change. |
| Public type | Rename `ImpSettings` to `InkSettings` and update repository consumers; no deprecated alias needed in this single-user breaking release. Explain the deep-import source break. |
| Codex HTTP originator | Retain the existing `originator: "imp"` compatibility identifier for this cutover. Mocked tests cannot establish provider acceptance of a new value. A later change needs independent protocol evidence or separately approved live verification. |

Package name, version and workspace implementation are explicitly owner-approved. External cutover authorization is not included. If an input changes the cutover semantics or release security, review the amendment before implementation.

## 3. Rename inventory and exception policy

Treat references by role, not with an unrestricted replacement. Before implementation regenerate an inventory from tracked files and inspect untracked installation `.env` **keys only**, if its migration is approved. Never copy secrets into docs or fixtures.

### 3.1 Active identity and package

- `package.json`, `package-lock.json`, `bin/imp.js` -> `bin/ink.js`, `src/format.ts`.
- `src/cli.ts`: help/version, errors, examples, login/session hints and trust descriptions.
- `src/core/system-prompt.ts`: Ink identity and general assistant scope; retain existing safety instructions unchanged.
- `src/repl/repl.ts`: new Ink pixel logo, welcome/resume output and terminal title. Update `src/repl/commands.ts`, extension diagnostics and notification title.
- `src/mcp/client.ts`: MCP `clientInfo.name` becomes `ink`; keep protocol/API version semantics unchanged. `examples/extensions/web-search/index.mjs`: descriptive user agent becomes `ink-url-read/...` without a gratuitous protocol-version bump.
- Current README, release instructions, `docs/skills.md`, agreement heading, examples' install instructions and tracked project configuration. All new file contents and code identifiers are English.

Keep the actual repository URLs until the remote repository is renamed. The source folder may continue to be called `imp` without being a second runtime identity.

### 3.2 Runtime state and trust must change together

| State/resource | Primary implementation locations |
| --- | --- |
| Auth, settings, model cache | `src/provider/auth-store.ts`, `src/provider/codex-auth.ts`, `src/core/settings.ts`, `src/provider/catalog.ts` |
| Sessions, logs, input history | `src/core/session/manager.ts`, `src/core/logger.ts`, `src/repl/history.ts` |
| Trust decisions and resource detection | `src/core/trust.ts`, `src/cli.ts` (`resolveProjectTrust` filtering and consumer wiring) |
| Global context and prompt files | `src/core/context-files.ts`, `src/core/system-prompt-files.ts` |
| Agents, commands, skills, extensions | `src/core/agents/registry.ts`, `src/core/commands-md.ts`, `src/core/skills.ts`, `src/extensions/loader.ts` |
| Example private state | Guardian config/log, notes, web-search config and their tests/docs |

Change both the resource detector and every consumer to `.ink` in the same batch. Test settings-only, commands-only, skills-only, prompt-only, agents-only and extensions-only projects. Denied/undecided resources must stay unread/unexecuted. Preserve the special handling of home itself, ancestor skills, symlinks, no-trust/no-extensions/no-skills flags and global/project/explicit-path precedence.

Keep standard `AGENTS.md`, `AGENTS.override.md`, Claude-compatible context names, `.agents/skills`, `.mcp.json`, `mcp.json`, and MCP discovery namespaces unchanged. Do not add renamed duplicates of these standard formats. Their **active contents** still require a dependency audit: a standard MCP file can refer to an old command, cwd, credential path, or `${IMP_*}` placeholder. Preserve standard filenames and generic placeholder expansion while separately approving specific active-reference updates.

### 3.3 Environment variables

Core inventory (19 suffixes): `MODEL`, `THINKING`, `AUTH_PATH`, `SETTINGS_PATH`, `CATALOG_PATH`, `CATALOG_BASE_URL`, `AUTOCOMPACT`, `BRANCH_SUMMARY`, `KEEP_RECENT`, `CONTEXT_WINDOW`, `LOG`, `MCP`, `REPL`, `CHILD_SESSIONS`, `WORKTREE_DIR`, `CODEX_AUTH_BASE`, `HEALTH`, `HEALTH_REPEAT_TURNS`, `HEALTH_MUTATION_FAILURES`.

Example inventory (3 suffixes): `NOTIFY_MIN_SEC`, `NOTIFY_DRY`, `WEB_SEARCH_CONFIG`. `IMP_LOGO` is a source constant, not an environment variable. Test-only and deliberately obsolete names must be classified separately.

Rename to `INK_` without changing values, default semantics or precedence. The additional **bare `IMP=1` marker** injected by `src/core/tools/bash.ts` becomes `INK=1`; a child-shell test must distinguish the injected marker from any unrelated caller-supplied `IMP` variable. Do not strip arbitrary inherited environment or forbid user-requested generic MCP expansion of old-named variables. The no-alias guarantee concerns harness-specific configuration consumers and injected identity, not all strings in user environments.

Update tests' sandbox variables **before** changing defaults. `.env` is loaded from the installation root (`src/env.ts`), even for help/version; temporary HOME alone does not isolate it. Do not move production `.env` into the user's home or infer values from old runtime state. An approved local cutover must account for shell exports, installation `.env`, explicit CLI paths and absolute paths inside settings/extensions. A missing migrated model setting must not silently select a different provider for acceptance tests. The controlled validation boundary is specified in §5.4.

### 3.4 Deliberately retained history and formats

Retain `ChildLaunchRecord.version: 1`, `impVersion`, all saved IDs/cwd/branch/path fields, launch fingerprints, credentials and trust canonical-path keys. Package/app version changes, session format version does not.

Keep prior Git tags, released changelog sections and ledger/design records describing imp. Add a clear current-name pointer to archival onboarding material rather than replacing old events. An implementation audit must explain each remaining active `imp` match; an empty search result is not the success criterion.

New worktree directories/branches become `ink-worktree-*` / `ink/task-*`. Listing accepts both current and historical directory prefixes, so retained work is not hidden. This is recognition of historical artifacts, **not** an old command/config alias. Do not automatically delete or rename historical worktrees; destructive manual cleanup still requires approval and existing safety checks.

## 4. History restoration and safety

Ordinary session directory keys encode cwd. Copy them verbatim and preserve file mtimes, which affect `--continue` ordering. Do not relocate `/Users/z/Z/Agent_demo/imp`, or trust/session lookup will change independently of branding. Session v1 ordinary restoration assembles the current prompt and should retain tree branches, names, compaction, model/thinking selections and usage.

Children remain under the corresponding parent's `children/` directory. Existing launch v1 readers stay intact. A valid owned `0.1.0` fixture whose current-provider/tool-pool prerequisites pass must reach actionable `version-drift` refusal under `0.2.0`, before lease acquisition, transcript repair or child-provider execution. Other old records may be safely refused earlier for malformed ownership, missing facts, provider mismatch or unavailable tool reconstruction; do not reorder those checks just for a uniform diagnostic. Every historical-child attempt must refuse before child execution/mutation. Preserve other ownership, prompt, extension-content, model, worktree and tool-contract drift checks. Tests must prove no child transcript mutation or child-provider call. A parent's attempted task result may be recorded normally; refusal does not mean the parent's transcript is immutable.

Historical absolute paths embedded in task results may be stale after migration; preserve them as historical facts, and document how to locate the copied child history. Never rewrite conversation content to make paths look current. Custom context mentioning imp is not permission to rewrite a historical launch fingerprint. New Ink child creation/resume must work within the new unchanged version/environment.

## 5. Migration is an operator procedure, not automatic startup behavior

No `ink migrate` feature or automatic home mutation is included. The implementation supplies a reviewed cutover runbook and fixture-based validation; actual migration is owner-authorized operator work later. Each sensitive step is requested separately with concrete paths. Stop old and new processes/children before state mutation; the present interactive session must end before its own configuration/install cutover.

### 5.1 Preflight and private backup

1. Inventory exact roots and overrides, active binaries, installed extension copies/links, retained worktrees, `.env` keys, retained standard MCP configurations, known leases and active processes. Do not assume old summary snapshots are current. Build a **private active dependency/path map**: unchanged approved external targets; nested link/override targets in the old root requiring approved destination adaptation; mutable source-linked module targets; and historical paths that must remain untouched. An unchanged destination link pointing into `~/.imp` is not compatible with an inactive old root. Do not print secrets from MCP/settings/configuration values.
2. Resolve source/destination paths without following an unexpected root symlink. Any existing `.ink` destination, dangling link, file in place of a directory, or destination nested inside source **blocks** the operation. Source, destination, backup and stage must be mutually disjoint by resolved paths. Do not merge trust, extensions, or credentials from two roots.
3. Request approval for exclusive creation of private backup/staging enclosing directories (mode `0700`). The original root is not necessarily private; merely preserving its mode is insufficient. Neither enclosure may be Git-tracked or exposed by package contents. Inventory every source entry with lstat, preserving unknown files, dotfiles and link text. Reject unsupported special files or unknown executable links pending inspection. Do not dereference arbitrary links into other projects/home locations.
4. Create an inactive state backup and private integrity manifest, plus a **recoverable old installation snapshot**: old Git revision, built `dist`/launcher bytes and modes, actual global command/module registrations, approved environment/config files and bytes of known mutable extension targets. A state backup containing links is not a snapshot of target behavior. Use separate snapshot entries for approved known targets without following arbitrary links; keep secrets private. Record a rollback method that reconnects old state to old extension bytes, not changed source targets. For unchanged regular state files compare byte digests internally; report only aggregate verification. Preserve mtimes, link text and permissions (auth/web-search/guardian logs as applicable); record filesystem timestamp precision and do not promise preservation of inode IDs or ctime.

**Quiescence is a prerequisite, not just a lease scan.** Fresh children may have no resume lease, subprocesses can outlive a terminal, and MCP/logger shutdown is asynchronous. The operator must establish that relevant parent/child processes, detached process groups and owned MCP servers have stopped and pending writes have drained; inspect ownership and stable source manifests over a declared quiet interval. Absence of leases or a closed UI alone is not proof. Uncertain process/lease ownership blocks migration; do not kill or discard uncertain claims. Repeat checks before activation. The reviewed runbook must specify concrete evidence and timing for the local process model.

### 5.2 Stage and validate without overwriting

5. Copy the complete old root inside the private staging enclosure on the destination filesystem, preserving bytes/links/modes/mtimes. Preserve all session/lease bytes including `.imp-machine-id`. Keep `~/.imp` untouched at this point. Validation must not import staged links to live pre-integration source.
6. Apply only reviewed active configuration edits in the stage: explicit `.imp` resource paths, environment references, owner-selected instruction text and installed extension code/configuration. Allowlist destination-link changes for active targets inside the old root while leaving original link text in the backup. Update retained MCP/other external active configuration only as a separately approved operation. Do not globally replace strings in JSONL, trust records, auth, logs or unknown files. Prove adapted default resources cannot read/write the inactive old root, while intentional historical text remains unchanged.
7. Specifically compare the regular installed guardian against the repository implementation. Do not assume it is current or overwrite local changes blindly. Adopt an approved Ink-path-aware module preserving existing rule behavior and `askTimeoutMs`, **except for explicitly approved path adaptations**. Rules with literal `.imp` paths may otherwise lose protection: preserve rollback-root protection where applicable and approve corresponding `.ink` protection without broadening unrelated permissions. Validate the exact adapted installed copy/config, old/new protected paths and deny/ask/timeout behavior using isolated fixture audit output (§5.4). A missing/unreadable config or lost rule blocks cutover; missing config can currently mean empty rules.
8. Validate web-search private config location/mode without transmitting its key, and verify notes/custom extensions/agents/skills paths. Retain only approved dependency-map links; unknown external targets require a separate decision. Source-linked example paths can keep their text only once coherent new source/runtime is deployed. Do not execute unknown installed modules merely to inspect them.
9. Migrate only the explicitly selected project roots (`imp/.imp` becomes tracked `imp/.ink` during implementation). Projects outside the workspace require separate approval. Make a dry inventory first; never scan-and-mutate arbitrary repositories.
10. Establish publication readiness and fixture-test the **exclusive directory publication primitive** (for example, Darwin exclusive rename or Linux no-replace rename), with no ordinary-rename fallback. **Do not publish `.ink` during staging: actual publication occurs exactly once, at its ordered position in step 11.** The reviewed runbook must name and test the actual primitive before use, including a destination appearing between checks/publication, an empty directory and dangling link. An absence check plus ordinary rename is insufficient; a skipped `mv -n` is not success. If the filesystem/runtime cannot provide the guarantee, stop. Any later publication failure leaves original plus stage/manifest for diagnosis; never silently merge, resume an uncertain stage, or delete failed stages without approval.

All unchanged files must remain byte-identical; only the listed active config/extension edits differ. Preserve ordinary session mtimes even when editing separate active files. The manifest captures pre/post paths and permitted modifications privately. The source and destination must remain quiescent for the whole procedure; recheck leases/processes before activation.

### 5.3 Activate and rollback

11. With processes stopped, approved snapshots complete and stage validated, execute this dependency order, requesting each sensitive operation separately: retire `/opt/homebrew/bin/imp` and the old global `node_modules/imp` registration without deleting the linked source; integrate reviewed source to main with `--no-ff`; build and verify **fresh `dist/` in `/Users/z/Z/Agent_demo/imp`** against the integrated revision; adapt approved installation-root `.env`/shell and external active-reference configuration; immediately revalidate source-state integrity, quiescence and destination absence, then publish the validated `.ink` root exactly once using the tested step-10 primitive; establish the selected new package registration linked to this source and its `ink` executable. Migrate only selected project resources as planned. Source integration changes example targets and removes the old launcher, so no old/new normal startup is allowed between these steps. `dist`, launcher, package/version, active env, state and installed guardian must be coherent before the new command is enabled. If any step fails or awaits approval, stay stopped and leave entry disabled; do not improvise a partly deployed startup.
12. Recheck global executable/module target, installed package metadata, built version and default state paths. Use one authoritative `.ink` root and `INK_*` environment; no active dependency link/override may point into old state. The old root is inactive, not a fallback discovered by Ink. No active `imp` alias remains. Existing source/worktree paths and repository remote remain unchanged. Never force-overwrite any unrelated `ink` executable or reuse its config.
13. Verify production quick-exit help/version/session-list only after reviewing startup `.env` and resource-loading behavior; keep behavioral restoration/trust/guardian/extension tests in controlled fixtures (§5.4). Loading approved production extensions is an operational startup with possible side effects, not a harmless inspection; require a reviewed startup plan and separate approval for any paid/external actions. No unknown modules are loaded for validation. Optional live-provider smoke needs separate quota approval. Codex originator remains unchanged.
14. Keep backups until the owner accepts the cutover; deletion is a separate sensitive request. Rehearse rollback on fixtures **before cutover**, including mutable link targets and failure between activation steps. Restoration must use the captured old runtime and extension bytes/registrations or a separately reviewed code restoration, never a state backup whose links now execute Ink modules. After Ink writes new state, stop and preserve that root before any separately approved rollback; reconcile new data manually. Do not overwrite it with old state. No automatic downgrade, destructive Git reset or history merge.

### 5.4 Controlled offline validation boundary

Temporary HOME and a dummy API key do not make tests offline. Create a copied build/launcher **installation fixture with absent or explicitly controlled `.env`**, a neutral cwd, sanitized subprocess environment, temporary auth/settings/catalog/home/cache paths and a pinned fixture model. Do not read the developer installation's private `.env` into subprocesses. Production dotenv loading stays unchanged; no undocumented test bypass is added.

All model and catalog endpoints use local test servers/fake providers; block nonlocal network requests and fail if attempted. Convert `test/cli-run-start.test.ts`, which currently sends a dummy key to the default Anthropic endpoint, in the initial isolation batch. Audit every CLI subprocess test, not just Vitest's parent setup. Package execution starts from a neutral directory and cannot resolve an existing global command or fetch plain `ink`.

Run guardian/known-extension behavior in a **separate fixture copy** of the approved adapted module/config, with temporary audit logs and timers cleaned up. Static dependency/mode/config checks may inspect the stage read-only, but behavioral tests must not mutate stage/original logs/history or follow mutable links to the live checkout. Unknown installed extensions need inspection and a separate decision, not automatic import. Compare original and stage manifests before/after validation; only declared operator adaptations may differ. Synthetic session restoration tests may write their own fixture transcripts, never production snapshots.

## 6. Packaging and release safety

Update both workflows' packaging smoke tests to consume the single artifact filename from `npm pack --json`, not a package-name glob. Assert packed metadata, Node shebang, executable mode, `dist/cli.js` and `bin/ink.js`; reject `bin/imp.js`, runtime roots, `.env`, credentials, source, tests, docs and unexpected top-level artifacts. Check all packed files against the intentional allowlist.

Build/pack/install smoke follows §5.4 and uses temporary HOME, cache and installation prefix, so it cannot install into `/opt/homebrew` or touch real user config. Prefer offline/cached dependencies and stop/report a missing cache rather than trigger unapproved install scripts or global upgrades. Run `ink --help` and assert exact version. Assert the intended single bin and test `npm exec` inference against the local artifact from a neutral directory without fetching the occupied `ink` package. README commands name the selected npm package, not `npx ink`. CI continues Node 20/24 coverage.

### 6.1 Revised CI publication contract

Do not publish under the old package by accident. **Ordinary real CI publication from refs containing the revised workflow** requires all of:

- A tag ref whose version matches package/app/lockfile, and ancestry on main.
- The selected Ink package name, with an explicit rejection of `imp-agent` and `ink`.
- New repo variable `INK_NPM_PUBLISH_ENABLED == 'true'` **and** `INK_NPM_PACKAGE` matching package.json. Do not inherit the existing `NPM_PUBLISH_ENABLED` gate, which read-only inspection found enabled.
- A tag push event; `workflow_dispatch` is always dry-run **in the revised workflow**, including tag refs and `dry_run=false`. Document this truth table and eliminate the current comment/behavior mismatch.
- Exact npm trusted-publishing prerequisites; use a patch-aware `>=11.5.1` guard. No local global npm upgrade is authorized by editing a workflow.

Registry checks/provenance URLs derive from the selected package. Gate-disabled tag runs must explicitly say publication was skipped.

### 6.2 Retained historical workflows and first-package bootstrap

Changing current YAML does **not** change workflows at historical refs. The retained `v0.1.0` workflow can reach its legacy publish path on a tag dispatch with `dry_run=false` if `NPM_PUBLISH_ENABLED` stays enabled. An already-published-version error is not a safety gate. Before any external release probing/cutover, separately request disabling/removing the legacy `NPM_PUBLISH_ENABLED` variable and assess old trusted-publisher bindings for retirement. Do not probe historical refs or rerun historical publishing events until the legacy capability is disabled. Preserve historical tags; do not rewrite their workflow files. This prerequisite is recorded now, not executed or authorized now.

**First Ink-package bootstrap is outside the ordinary CI contract and requires a separate independently reviewed release design before any publish.** That design must confirm package ownership/publishability, exact package/lock/app/tag identity, reviewed artifact, public access and first-publication authentication method. A manual first publish is not a tag-push CI event and may not carry trusted-publishing provenance; make the actual guarantees explicit. Confirm and bind the selected new package's publisher before enabling its new CI gate/package variables. Do not mechanically rename old bootstrap commands. Reconfirm binding after any repository rename. No token/account configuration changes now. Preserve `imp-agent@0.1.0`; deprecation or unpublication is not part of this change.

## 7. Acceptance matrix

| Area | Required observable checks |
| --- | --- |
| Metadata and branding | Package/lock/app version agreement; selected package; only `ink` bin; Ink help/version/logo/title/prompt; no false repository URLs; mock MCP identity; retained Codex header |
| Isolation | §5.4 fixture install with controlled/absent dotenv, sanitized subprocesses, temporary paths, pinned model, local catalogs/providers and nonlocal network block; original/stage manifests unchanged by validation |
| No dual runtime names | Harness-specific consumers use only `.ink`/`INK_*`; `INK=1` injected by bash; caller environment and generic MCP expansion preserved; conflicting old roots/variables never implicitly loaded |
| Trust | Every renamed resource-only project is gated; deny/undecided do not load; canonical symlink/home/ancestor behavior and explicit disabling flags retain coverage |
| Ordinary history | Legacy v1 fixture copied to `.ink`: identical pre-use bytes/IDs/cwd/mtime; list, continue, resume, branch/compaction/model/thinking/name/usage restored; children excluded from normal listing |
| Child safety | Old launch v1 parseable; valid-prerequisite/custom-prompt fixtures reach version-drift; earlier safe refusals allowed; all refuse before lease/repair/child calls; new Ink resume works; lease/drift tests unchanged in strength |
| Historical identifiers | `impVersion` and `.imp-machine-id` retained and tested; old worktrees remain listed; new worktrees use Ink names; no historical automatic deletion |
| Migration runbook | Synthetic trees cover integrity/modes/mtime precision/unknown files; nested old-root links and MCP references; exclusive directory publication with racing empty directory/dangling link; changed source/interruption/repeat refusal; private disjoint enclosures; approved edits only; no secret output |
| Activation/rollback | Fresh live-root dist matches integrated revision; entry remains disabled through incomplete steps; old executable and module registration retired; rollback fixtures recover old runtime/extension behavior despite mutable target links and preserve new Ink data |
| Extensions | Exact adapted installed-copy guardian and symlink cases; old/new protected paths and timeout behavior; isolated audit output; web-search private mode; notes/custom dependencies; no accidental empty-rule acceptance |
| Distribution | Actual tarball allowlist/secret exclusion, isolated offline install and local npm-exec smoke; Node 20/24 in CI; old bin absent |
| Release | Revised-ref identity/version/ancestry guards, old gate ignored, new gate/package match, dispatch always dry-run, patch-aware npm minimum, visible skip; historical capabilities flagged and disabled only with approval; bootstrap blocked pending separate reviewed release design |

Target current test files include `test/package-metadata.test.ts`, `test/repl*.test.ts`, `test/codex-responses.test.ts`, `test/mcp-client.test.ts`, `test/session-*.test.ts`, `test/child-*.test.ts`, `test/trust*.test.ts`, `test/guardian.test.ts` and web-search tests. Add narrowly scoped migration/release regression tests where missing. Do not remove old-format fixtures or weaken assertions merely to make the rename pass.

Implementation gates: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, artifact smoke, reference classification audit, `git diff --check`, then independent code review. Tests use fake providers/local servers, never the owner's real provider credentials. Report exact counts and any unavailable platform/runtime checks. Documentation-only changes use link/structure checks and `git diff --check`; that does not claim runtime tests passed.

## 8. Sequencing and exit conditions

1. **Design now:** write this document on its dedicated branch; obtain fresh-context adversarial review, revise and close findings. No production implementation before review closure.
2. **Owner inputs:** confirm exact package name and first Ink version. Obtain implementation approval; unresolved external cutover authorization stays separate.
3. **Isolated implementation:** create dedicated worktree and check dependency ownership; fix §5.4 test isolation first, then package/runtime/trust/env/branding, historical compatibility, examples/docs, workflow guards and runbook. Independently review and fixture-test the concrete operator primitives/process checks before any real migration. Do not execute global migration or source integration during this phase.
4. **Verification/review:** run the full acceptance matrix and independent code review; fix findings before declaring code ready. If a code change alters this design, review the amendment first.
5. **Local cutover later:** present exact authorized operations one at a time, end active processes, preserve state and switch safely. Merge to main only with `--no-ff`; do not push implicitly.
6. **Optional public identity/release later:** disable legacy publishing capability with approval before release probes; independently design/review the new package bootstrap. GitHub rename, remote updates, publisher binding, push/tag/publish and any old-package deprecation each need explicit approval. Trademark clearance remains a separate unresolved legal question.

Success is a single usable Ink installation with preserved ordinary history and protections, not elimination of every occurrence of the word imp.

## 9. Independent review record

- r1 runtime/migration reviewer: session `a1c977e9-e064-490c-8361-5433a042becd`, NEEDS-FIXES (3 P1, 3 P2). r2 addresses nested dependencies/MCP, offline isolation, guardian protection semantics, deployment model, bare shell marker and honest child-refusal diagnostics. Additional no-clobber/privacy/quiescence suggestions are now runbook requirements.
- r1 package/deployment/release reviewer: session `e7c9135b-2c9c-47c8-974a-1985071ee740`, NEEDS-FIXES (3 P1, 1 P2). r2 specifies source-linked build/deployment, recoverable runtime/extension rollback snapshots, historical publish-capability retirement and separate reviewed bootstrap. Offline subprocess, dependency-link ownership and neutral npm-exec comments are included.
- r2 runtime/migration review: APPROVE; all six original findings and runbook obligations closed at specification level.
- r2 package/deployment/release review: original R1-R4 closed; one new P2 sequencing contradiction (state published in both steps 10 and 11). r3 makes step 10 readiness-only and performs publication exactly once in step 11 with immediate integrity/quiescence/destination revalidation.
- r3 final closure: **APPROVE from both reviewers**, 2026-10-04. Package/deployment reviewer closed the final sequencing P2; runtime/migration reviewer confirmed the amendment preserves r2 closure. No remaining design blockers. Concrete migration runbook/primitives and first-package bootstrap remain subject to their later independent review and test gates.
- Documentation verification: 14/14 r2 structure/safety checks and 7/7 r3 sequencing checks passed; `git diff --check` passed. No runtime test/build was run for this documentation-only change.

Owner package/version decisions and external approvals are not replaceable by reviewer approval.

## 10. Workspace implementation acceptance — 2026-10-05

Implementation worktree: `/Users/z/Z/Agent_demo/ink-rename-implementation`, branch `feature/ink-rename`, based on approved design commit `20dad07`. The live checkout remains on `design/ink-rename`, with `imp-agent@0.1.0`; no live source integration or home/global migration was performed.

Independent code-review closures:

- Runtime and compatibility: `52c8f9b8-afe8-4ca1-a020-44997fe33937`, **APPROVE**; preserved schemas/hashes, trust, ordinary history and child refusal.
- Isolation: `eda83f73-f132-4f38-9ef8-e980befeb198`, **APPROVE** after fixing falsey socket paths, custom DNS/UDP lookup, subprocess package lookup and exit-status masking.
- Package/release: `44983187-dfda-44c4-b4d8-71aad92f2ec3`, **APPROVE** after exact version-contract and complete tar-stream validation fixes.
- Concrete runbook design: `e412d5f2-8fdb-4ecf-88d9-d3a7fa0e2641`, r2 **APPROVE** before helper implementation.
- Synthetic cutover helpers: `d055e038-b5e6-49ab-b23a-7de8f7a749c4`, **APPROVE** after target-ID, group metadata, filesystem link traversal and external file/sidecar fixes.
- Adjacent test safety: `07d56e76-7cd0-4b1e-b22d-50820186c586`, **APPROVE**; removed pre-existing pattern-based `pkill` cleanup in `test/bash-tool.test.ts`, replacing it with cooperative test-owned markers and a bounded worker lifetime.

Final commands/results on Darwin arm64, Node **25.5.0**, npm **11.8.0**:

- `npm run typecheck`, `npm run lint`, `npm run build`: passed; Biome checked **262 files**.
- `node test/helpers/check-isolation.mjs`: passed; **0 checkJs diagnostics**, **2 files** checked.
- `/usr/bin/clang -std=c11 -Wall -Wextra -Werror -fsyntax-only test/helpers/exclusive-directory-rename.c`: passed.
- `npm test`: **141 test files passed; 3064 tests passed, 1 skipped**. The skip is Linux native filesystem execution unavailable on this Darwin host.
- `node scripts/package-smoke.mjs --cache-source "$HOME/.npm"`: passed offline, **340 allowed artifact files**, modes, isolated local installation, exact help/version and local npm-exec inference. Existing cache was read-only; writes remained in private scratch.
- `git diff --check`: passed. `.ink/settings.json` matches the original **26 bytes**; non-root lockfile dependency entries are unchanged. Remaining legacy identifiers are deliberate schema/lease/protocol/history references, not runtime aliases.

Evidence limits: Node 20/24 were not installed locally and CI was not triggered. The existing `@earendil-works/pi-tui@0.82.0` dependency declares a newer Node floor than the package's retained `>=20`; this pre-existing support discrepancy needs actual target-runtime verification, not a compatibility claim from Node 25. Linux, cross-mount, unsupported native-operation and production-path evidence remain unavailable. Synthetic quiescence/activation ledgers do not prove real process shutdown. No model/provider quota, global installation, GitHub/account changes, push or npm publication occurred. At that snapshot, the full-state cutover runbook described remaining approvals;
it is now superseded by [the local installation record](ink-local-install.md).
