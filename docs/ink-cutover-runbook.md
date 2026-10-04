# Ink operator cutover runbook

- Date: 2026-10-04
- Revision: r2
- Status: **APPROVED DESIGN r2 — independent Gate D closed; not operational approval**. Fixture helper implementation may proceed; Gate T and all real-path approvals remain outstanding.
- Governing design: [Ink rename design](ink-rename-design.md), approved r3.
- Owner-selected identity: **`ink-agent@0.2.0`**, sole command **`ink`**.
- Authoring worktree: `/Users/z/Z/Agent_demo/ink-rename-implementation`,
  branch `feature/ink-rename`.
- Scope: reviewed operator specification and separately verified synthetic helpers.
  No migration, home writes, global installation, source integration or external
  actions are authorized by this document.

This is a stopped-process, single-user, **operator-controlled** cutover, not an
`ink migrate` feature. Ink must never discover, merge, or automatically consume
real `~/.imp`. Proposed test helpers accept only explicit synthetic fixture roots.
The owner/operator performs a later migration under separate authorizations.

## 1. Gates and authorization boundaries

**Gate D:** a fresh-context, adversarial reviewer must approve this runbook,
including publication, privacy, quiescence, guardian and rollback semantics,
before implementing even the workspace-only helpers in §9. Approval of design
r3 does not close this more concrete gate. Record reviewer identity, revision,
findings and closure in §11; any material change reopens the gate.

**Gate T:** independently review helper/code changes and pass all applicable
fixtures before any operator uses the primitives on real paths. Report Darwin
and Linux execution separately; a specification or skipped test is not evidence
that a particular filesystem supports exclusive rename.

**Gate O:** for every sensitive operation, present a standalone request containing
its exact absolute paths, existing types/targets, intended changes, reason,
expected result, stop condition and recovery step. Wait for explicit approval.
Do not combine requests into a general "perform the migration" approval, and do
not execute other sensitive work while waiting. Missing approval means stopped.

| Operation | Current boundary / later required authorization |
| --- | --- |
| Write this runbook | Authorized only in the named worktree on `feature/ink-rename`; leave all other in-progress changes and approved design untouched. |
| Inspect local installation | Read-only metadata and approved code only now. Do not read credential values, private configuration contents or conversation contents. No production CLI invocation merely to inspect it. |
| Implement helpers | Gate D first, then a separately scoped workspace code task; no real-home defaults, crawling, import or migration. |
| Stop processes / suspend restart sources | Owner/operator ends the present agent session first. Any agent-issued signals, supervisor/config edits or externally effective shutdown need their own exact-process/resource approval. Never signal a process group of uncertain ownership. |
| Create private home backup/stage/rollback enclosures | Separately approve each named enclosure under `/Users/z`, mode `0700`, no reuse; these are outside the workspace. |
| Copy real state, runtime or approved configuration | Separately authorize opaque private backup and staging of the named resources. Credentials may be copied byte-for-byte by the operator, never decoded, printed, put into fixtures or sent to a provider. Current document work does not authorize this access. |
| Adapt staged code/config/links or permissions | Approve the exact diff/path map and permission exceptions; no unrestricted text replacement or unknown-module execution. |
| Retire either global registration, create a new one | Separate request for each actual executable/module path. No global package-manager mutation, lifecycle scripts, fetching or upgrade is implied. |
| Integrate source / rebuild authoritative installation | Separate explicit operational approval even though source is inside the wider workspace: it changes live link targets. Integrate reviewed code into main only with `--no-ff`; do not move source directories. |
| Change `.env`, shell exports, MCP or other external configuration | Separate per-file/resource request. No shell profile editing, reload or credential-store change by implication. |
| Publish state / migrate a selected project | Separate request for each exact source/destination pair. Never scan-and-mutate repositories or overwrite an existing root. |
| Production acceptance startup | Only the reviewed quick-exit plan in §7 initially. Normal startup, extension loading, notifications, MCP connections and provider calls require their own side-effect approval. No paid-provider verification in this runbook. |
| Rollback / retention cleanup | New approvals at the time; preserve all post-Ink writable targets, including external auth/settings/extension data, before any restoration. Repository recovery edits start on a dedicated recovery branch/worktree; tracked recovery is independently reviewed and integrated only with `--no-ff`, even when the runtime is recovered from a snapshot. Never automatic downgrade, deletion, history merge or destructive Git reset. |

No broad global migration shell commands are provided. No publication, upload,
push, dispatch, repository rename, account change, registry bootstrap or old
package retirement is part of this runbook. See [RELEASING.md](../RELEASING.md)
for the separately gated release design; do not run release probes here.

## 2. Observed installation and source dependencies

These are **read-only observations on 2026-10-04**, not future preflight results:

| Resource | Observed metadata / consequence |
| --- | --- |
| Authoritative installation `I` | `/Users/z/Z/Agent_demo/imp`; clean on `design/ink-rename`, revision `20dad07`. Do not assume it is on main or switch it during development. |
| Old executable | `/opt/homebrew/bin/imp` is a symlink with text `../lib/node_modules/imp/bin/imp.js`. |
| Old registration | `/opt/homebrew/lib/node_modules/imp` links to `../../../../Users/z/Z/Agent_demo/imp`. Its installed package is `imp-agent@0.1.0`; registration basename is actually `imp`, not inferred from package name. |
| Proposed executable / registration | `/opt/homebrew/bin/ink` and `/opt/homebrew/lib/node_modules/ink-agent` absent. Recheck all executable resolution paths at cutover, not just this prefix. |
| Source state `O` | `/Users/z/.imp`, regular directory mode `0755`; destination `/Users/z/.ink` absent. Auth and active guardian log are mode `0600`; history and some archived logs are less restrictive. |
| Installation dotenv | `I/.env` absent; do not assume it remains absent. No dotenv values or private settings were read. |
| Installed guardian | `O/extensions/guardian.mjs` is a regular file, mode `0644`; a code-only comparison found it byte-identical to `I/examples/extensions/guardian.mjs`. Its current config/rules were not read. Recompare later. |
| Mutable installed links | `notify.mjs`, `task-timer.mjs`, `tool-colors.mjs` point to the corresponding absolute files under `I/examples/extensions/`; `web-search` points to that example directory. Their text must not be redirected to the development worktree. |
| Unknown/archival entries | Guardian backups and archived logs exist. Copy them inertly as unknown/history entries; do not treat a backup filename as an active guardian. |
| Development dependencies | This worktree's `node_modules` is `../imp/node_modules`, a shared symlink. Read-only reuse is permitted; `npm ci` or other mutation through it is not. |
| Host | Darwin arm64; `/Users/z` and `I` on local `/dev/disk3s5`, mounted at `/System/Volumes/Data`. Linux behavior has not been executed. |

### Source references that determine order and validation

- [Launcher](../bin/ink.js) imports `../dist/cli.js`. Git integration does not
  deploy ignored `dist/`; a source-linked installation needs a fresh build.
- [CLI](../src/cli.ts), `main()`: dotenv and `loadCatalogCache()` run **before**
  `sessions`, `--help` and `--version`. Those paths return before extension/run
  setup and catalog refresh in the inspected implementation. Re-audit after
  integration; flags alone are not an isolation boundary.
- [Dotenv](../src/env.ts), `loadDotEnv()`: reads the installation root, not cwd
  or temporary HOME. Existing environment wins; changing HOME is insufficient.
- [Catalog](../src/provider/catalog.ts), `catalogPath()`/`loadCatalogCache()`:
  `INK_CATALOG_PATH` or `.ink/models-catalog.json`; run modes can refresh it.
- [Auth store](../src/provider/auth-store.ts), `authFilePath()`/`writeStore()`,
  and [settings](../src/core/settings.ts), `settingsFilePath()`/`saveScope()`:
  explicit `INK_AUTH_PATH` and `INK_SETTINGS_PATH` targets are writable, even
  outside either state root. Calling a file "configuration" does not make its
  post-Ink bytes disposable. [Notes](../examples/extensions/notes.mjs) likewise
  persists state independently of the extension module's location.
- [Extension loader](../src/extensions/loader.ts), `discoverCandidates()`:
  explicit CLI, project, then global discovery; follows linked modules and
  package directories. `--no-extensions` does not cancel explicit `-e` paths.
- [Guardian](../examples/extensions/guardian.mjs): config/log paths are fixed
  from `os.homedir()`. Missing config is **valid zero rules**, not a safe
  operational default; `compileEntry()` defaults a string rule or omitted
  `tool` to **bash only**. Write/edit matching requires an explicit applicable
  tool rule; supporting those event names does not protect them by default.
  Matching uses bash command text or resolved write/edit paths. It is not a
  filesystem sandbox or a symlink-aware access-control layer.
- [Web-search config](../examples/extensions/web-search/_lib/config.mjs):
  `INK_WEB_SEARCH_CONFIG` or `.ink/web-search/config.json`; final component
  must be a private regular file, not a symlink. Parent paths must be trusted.
- [Sessions](../src/core/session/manager.ts), `sessionsDirFor()`/`listSessions()`:
  cwd keys stay unchanged, ordinary listing sorts by file mtime, children are
  under `children/`. [Trust](../src/core/trust.ts) uses canonical project paths.
- [Child lease](../src/core/child-lease.ts): `.imp-machine-id` remains historical
  identity; heartbeat `20,000 ms`, stale grace `60,000 ms`. Do not invoke lease
  acquisition or stale cleanup to establish operator quiescence.
- [Bash process groups](../src/core/process-tree.ts) and
  [bash tool](../src/core/tools/bash.ts): POSIX bash jobs run detached; shutdown
  group cleanup is best effort, not proof of absence of surviving descendants.
- [Stdio MCP](../src/mcp/stdio-transport.ts), `shutdown()`: stdin close, TERM at
  `3,000 ms`, KILL at `5,000 ms`; `close()` schedules shutdown rather than
  proving exit of descendants. [REPL](../src/repl/repl.ts) also has force exits.
- [Logger](../src/core/logger.ts): asynchronous `appendFile()` calls;
  `close()` is not a flush barrier. Process exit plus stable manifests is needed.

## 3. Operator record, private paths and dependency map

Use a **private operator record**, never a repository file or package artifact.
Record full revision IDs, filesystem identity, approvals, process identities,
manifest comparisons and each completed phase. Public output is aggregate pass /
fail counts only, not contents, digests of secret files, session titles or rule
text. No `set -x`, environment dumps, `cat` of auth/config, command-line secrets,
or credential-bearing process argument dumps.

For this host, the proposed path binding is:

| Symbol | Exact path template; replace `<id>` before requesting approval |
| --- | --- |
| `O` | `/Users/z/.imp` — original state, untouched through successful activation |
| `N` | `/Users/z/.ink` — absent until the single publication step |
| `B` | `/Users/z/.ink-cutover-backup-<id>` — exclusive private enclosure |
| `S` | `/Users/z/.ink-cutover-stage-<id>` — separate exclusive private enclosure |
| `C` | `S/state-root` — candidate, copied whole, never executed in place |
| `R` | `/Users/z/.ink-cutover-rollback-<new-id>` — created only if rollback approved |
| `I` | `/Users/z/Z/Agent_demo/imp` — unchanged source installation and project cwd |
| `F` | An exclusive private fixture root inside this worktree or designated scratch; synthetic data only |

Choose a fresh `<id>` (UTC timestamp plus random suffix), expand every path in
the private record, and use `lstat`, not an existence test that follows links.
For `N` and fresh enclosure/candidate paths required to be absent, any existing
entry, including a **dangling symlink**, is a conflict. A known original selected
project `.imp` root is not required absent: validate and recover it according to
its recorded phase in §8. Do not reuse, empty, resume or silently clean up old
enclosures. Reject source root links,
files instead of directories, missing source, destination beneath source,
equal paths, and containment/aliasing between `O`, `N`, `B`, `S`, `R` and `I`.
Resolve existing parents to establish the absent leaf's identity; inspect path
components before following unexpected links. Symlink-free canonical parent
bindings must be approved and recorded. Inspect mount boundaries too.

`S` and `N` must be on the same mounted local filesystem for rename. `B` and
rollback hold paths are placed on that filesystem here as well. Stop on network
or shared storage, untrusted writable parents, different owners, or uncertain
mount identity. Source/candidate changes by another same-user process are outside
the guarantee of the native rename; disable writers and check identities. The
primitive guarantees destination nonreplacement, not protection against a
malicious process controlling the operator's directories.

Create `B` and `S` separately and exclusively with mode `0700`, using a private
umask and verifying ownership, mode and absence of ACL grants. No symlink
aliases, inherited broad ACLs, Git tracking, archive uploads or package inclusion.
**An enclosing directory**, not the original root's `0755`, supplies backup
privacy. Raw copies retain original modes inside it. Propose an explicit staged
root-only mode adaptation `C: 0755 -> 0700`, to keep the published `N` private
after it leaves `S`; obtain owner approval and record this metadata exception.
No blanket recursive chmod. Preserve child file modes unless an exact additional
private-permission correction is independently approved. ACLs, extended
attributes, immutable flags or unsupported metadata must be inventoried and
preserved by a reviewed operator method, or block cutover pending a decision.

### Required dependency map

For every active link, import, override or standard-file reference, privately
record origin, link text/type, ultimate approved target, transitive dependencies,
old/new writer and read/write access, canonical old/new targets and aliases,
new target, behavior-test substitute and rollback target. State whether the
old/new bindings share one target or relocate to distinct targets. Classify
control configuration separately from runtime-mutable data; a writable auth,
settings, catalog or extension file is runtime data even if it also configures
the program. Classify entries:

1. **Internal state:** relative/absolute links or path settings resolving inside
   `O`. Translate active targets to `N` by an exact allowlist, including nested
   links and chains. Test resolution from the **final** `N` path, not from `S`.
   A self-contained relative link may already work unchanged; prove it.
2. **Mutable source modules:** the four observed example links and all their
   imported files/assets. For web-search, include `index.mjs` and the full
   reviewed `_lib` closure. Snapshot old bytes separately, and validate copied
   new modules in fixtures. Production link text may remain pointed at `I`
   only after coherent new source/runtime is deployed. Backup link text alone
   does not preserve executable behavior.
3. **Approved external dependencies:** keep unchanged targets only after
   ownership and old/new compatibility are established. Inventory the full
   writable state closure of every approved module/override, not merely its
   entry module or referring configuration. Map external auth, settings,
   catalog/cache, audit/log, notes and custom extension data outside `O`, `N`
   and selected project roots, including unknown ordinary files within each
   declared writable directory. Do not dereference arbitrary home/project links.
4. **Installed copies:** guardian and any custom module/config require a code
   comparison, exact reviewed adaptation and old-byte snapshot. Unknown active
   modules block startup; never automatically import them for inspection.
5. **Historical references:** session launch fields, task-result paths, log text,
   trust canonical keys, saved IDs/cwd/branch/hashes, `impVersion` and machine ID
   remain byte-identical. Do not translate these merely because they name imp.

### Writable-target preservation contract

Give every unique writable canonical target a private target ID and an exact
preservation entry; deduplicate aliases so two referring links cannot trigger
conflicting restores. Record target type/ownership, whether it was originally
absent, writer ownership/quiescence evidence, old snapshot location, approved
activation changes and post-Ink preservation location. A directory's manifest
includes unknown files and declared temporary/sidecar writes; a single-file
binding must also account for its writer's temporary/sidecar namespace. A
control file that the runtime can modify is classified as runtime-mutable in
full, not split by presumed JSON keys. Unknown write targets or uncontrolled
shared writers block activation and rollback.

- **Control configuration:** shell/installation `.env`/MCP/reference documents
  restored by an approved configuration diff. Preserve their post-Ink bytes
  too before restoration; these snapshots do not preserve data at the paths
  they reference.
- **Runtime-mutable shared target:** old and Ink bindings resolve to the same
  external auth/settings/extension data. Post-Ink writes can occur without any
  path change. Preserve that current target completely before reverting config,
  link bindings or its data; never let an old backup silently replace it.
- **Runtime-mutable relocated target:** record both old and new canonical paths,
  preserve both current states before restoration (including an originally
  absent/newly created target), and retain new data when the old binding returns.
  An apparently inactive old target is not assumed unchanged; verify it.

Before activation, capture opaque old bytes/metadata or verified absence under
`B/external-old/<target-id>` (§5.1). Before any rollback restoration, preserve
current bytes/metadata or verified absence for **every** mapped writable target
under `R/external-post-ink/<target-id>` (§8), not only targets inside `.ink`.
The operator must approve each external read/copy/move separately and keep
credentials opaque and private. No preservation entry means no rollback startup.
Compatibility, reuse of current shared data or restoration to an occupied path
requires a separate reviewed decision; no automatic merge or reconciliation.

Inventory shell override **names**, the 19 core and 3 example `IMP_*` suffixes
from design r3, explicit CLI resource paths, settings path arrays, agents/skills,
notes, standard MCP filenames and placeholders. Provider-owned variable names
stay unchanged. Do not strip unrelated inherited `IMP` or generic MCP expansion.
Active configuration values/path adaptations require the operator's later
private review; no values are needed for drafting this document. `AGENTS.md`,
`.agents/skills`, `.mcp.json` and other standard filenames stay unchanged, but
approved active references inside them may need adaptation. No new dependency
may still read/write `O` by default. Unknown links, dangling active targets,
link cycles, unsupported special files, unknown executable links, external
hard-link aliases or unreviewed mount traversal block the procedure. Unknown
ordinary files, dotfiles and inactive backups are retained, not discarded.

## 4. Preflight and quiescence evidence

The owner appoints an operator **outside the session being migrated**. Finish
workspace implementation, offline acceptance and independent code review first.
Identify a reviewed integration commit and exact approved paths/diffs. Arrange
all anticipated approvals, but still request each sensitive operation separately
at its execution point. An unavailable approval can prolong the outage.

1. Recheck §2 metadata, command/module targets, root conflicts, source worktrees,
   dependency ownership and free space for state backup, stage, old runtime,
   example/dependency snapshots and possible post-Ink preservation. Do not use
   `ink`, `imp`, `login`, `logout` or normal startup for preflight.
2. Record parent PIDs, start times, UID, PPID and PGID, owned child/bash groups,
   owned MCP server PIDs/descendants, known leases, and restart sources **before**
   stopping. Do not log arguments or environments, which may contain secrets.
   A name match or `node` executable alone does not identify ownership.
3. Operator requests graceful exits and waits for actual process termination.
   Account for detached groups, reparented children, extensions' subprocesses,
   MCP servers and queued logger writes. Suspend only explicitly approved
   restart sources. Any required forced signal needs an exact ownership review
   and separate approval; failure or uncertainty means stop, not `pkill`.
4. After the last confirmed writer exits, wait **at least 10 seconds** before
   taking the first stability sample, covering the inspected five-second stdio
   teardown schedule with margin. This is not a promise that ten seconds alone
   proves drainage. If forced termination occurred, also review integrity and
   unfinished writes before accepting a baseline.
5. Establish a **75-second quiet interval**: samples at `t=0,15,30,45,60,75 s`.
   At all six samples, compare private no-follow manifests of `O`, selected
   project resources, every mapped writable external target/sidecar namespace,
   old runtime/known mutable example targets and relevant leases. Confirm the
   process ownership ledger has no surviving mapped writers/servers, including
   writers sharing external data with other programs; uncertain ownership blocks.
   All entry/type/mode/mtime/link-text/regular-byte results must be stable.
   Reset the interval on any change; uncertain ownership blocks rather than
   being interpreted as a stale lease. Do not delete or repair any lease.
6. Darwin process evidence: UID/PID/PPID/PGID/start-time/`comm` fields from `ps`,
   plus read-only `lsof` cwd/open-file identity on the recorded processes and
   paths. Linux evidence: those process fields and `/proc/<pid>/cwd`, `exe` and
   fd-link metadata. Do not read `cmdline`, `environ` or fd contents. Repeat
   enumeration to detect reparenting and PID reuse. If permissions/tool support
   prevent ownership evidence, obtain operator evidence or stop.

Lease absence and a closed UI are insufficient: new children need not hold a
resume lease. Dead, aged, confidently owned artifacts are copied unchanged;
malformed, live or foreign claims are unresolved blockers until the operator
establishes a safe explanation. The interval exceeds the inspected `60 s` grace,
but **age never substitutes for process identity**. No stale-cleanup API is run.

Maintain the no-start/no-writer condition through activation. Repeat the full
interval after any suspected writer, unexpected source change, loss of operator
control, or long interruption with uncertain ownership. Immediately before
publication require a fresh complete integrity comparison and process/lease
check. Build activity may change new `I/dist`, not original state or captured
snapshots; distinguish declared deployment changes from unexpected writes.

## 5. Private backup, staging and exact adaptations

### 5.1 Capture recoverable old behavior

After enclosure approvals and quiescence, separately approve each copy set.
Build an inactive raw backup `B/state-original` and private manifest. Copy whole
`O` with no arbitrary link dereference, including unknown files, archives,
children, leases and `.imp-machine-id`. Capture original root mode separately.
No hard links back to production files: backup writes must not modify originals.

Also create a **closed, immutable-by-procedure** old installation snapshot:

- `B/install-old`: actual old `dist/`, `bin/imp.js`, package/lock metadata,
  controlled installation-root `.env` (or its confirmed absence) and the
  required dependency closure, copied without mutable links back to `I`.
  Record Node executable/version and dependency identity; an old Git commit
  alone does not recover the ignored built runtime or installed dependencies.
- `B/examples-old`: approved old modules plus all local imported files/assets;
  no mutable references to the now-changeable example tree. Keep the regular
  installed guardian's exact old bytes/config in the state backup as well.
- `B/project-old/<project-id>`: exact pre-cutover resources for each selected
  project, including tracked `I/.imp/settings.json` and any approved local state
  not represented by Git. Record project cwd/canonical identity, original root
  existence/type/full manifest and which entries are tracked or untracked.
  Record approved phase-specific expected manifests: before A3, after A3's
  tracked removals and after any A7 project operation. Git removing a tracked
  file need not remove its parent `.imp` or unknown untracked contents. Old
  runtime recovery must recover the effective resources too: an old snapshot
  runtime does not discover `I/.ink/settings.json`.
- `B/external-old/<target-id>`: opaque old bytes/metadata or verified absence
  for every approved writable external target from §3, including shared or
  relocated auth/settings/catalog/extension data and their declared sidecars.
  Preserve target bytes, not just override names or the files referring to them.
  Keep these separate from the shell/MCP/control-configuration snapshots.
- Approved selected-project safety/context snapshots: exact pre-cutover bytes,
  tracked status and revision, including `AGENTS.md` when its active paths change.
  These are recovery inputs, not permission to overwrite tracked files on main.
- Private registration/environment record: actual old executable/module link
  text, modes and canonical targets, source revision/worktree status and approved
  shell/override/MCP configuration snapshots. An absent `.env` is a recorded
  fact; never fill it from credentials found elsewhere.

Use a reviewed byte copy preserving regular bytes, symlink text, permissions
and filesystem-supported mtimes. Set directory times after copying children.
Inventory hard-link topology and metadata requiring special handling; never use
hard links to live data or treat a generic recursive copy as proof. Compare
unchanged regular-byte digests internally, link text and metadata against the
source before accepting each snapshot. Record filesystem timestamp precision;
fail if rounding changes ordinary continue order. Inode IDs and ctime are not
preservation promises. Reads may change atime; it is not a quiescence criterion.

Once verified, do not write or execute from the raw state backup. Snapshot
content is immutable by procedure and reverified before rollback; do not
silently rebuild it from changed source. Do not recursively change saved modes
or add filesystem immutable flags without separate approval. Any rehearsal runs
from a distinct synthetic/copied installation fixture, not these raw snapshots.
A missing old runtime/extension dependency blocks cutover, not just rollback.

### 5.2 Stage whole state without exposing it

Copy `O` into absent `C` under private `S` on the destination filesystem. Verify
source, raw backup and untouched candidate against the manifest before adapting.
Preserve JSONL, trust/auth, history/logs and unknown bytes verbatim. No rewriting
session formats, provider credentials, launch fingerprints or canonical cwd.

Apply only the approved stage diff: root privacy mode; named active `.imp`
paths/`IMP_*` references; installed module paths/content; owner-selected current
instruction text; allowed active links. Preserve other files and session mtimes.
Keep a before/after allowlist of paths, reason, byte/metadata differences and
approval. Standard external configurations are **not edited during staging**;
prepare their separately approved deployment diffs instead. Selected project
resources get their own records; the tracked `I/.imp/settings.json ->
I/.ink/settings.json` change preserves `autoCompact: false`. Do not merge an
untracked preexisting project `.ink`, and do not touch other project roots.

Do not import `C/extensions`, follow its mutable links for behavior validation,
or run the installed web-search resolver on production keys. Stage integrity
and dependency/mode checks are read-only. Testing a relocated relative link
requires a fixture reflecting final directory depth and canonical targets.

### 5.3 Guardian installed-copy acceptance

Today the installed guardian matches the old example; recompare without importing
it. If it differs, review local changes before proposing a replacement. Produce
an approved adapted **regular installed copy**, not an assumption that updating
the repository example updates home. Preserve matcher behavior, deny precedence,
reason strings, tool lists, confirmation behavior, reload behavior and the exact
configured `askTimeoutMs`. Change config/log discovery to `N` explicitly.

Privately review the installed rule config without secret output. Derive a
baseline **rule/tool/call/outcome matrix** from the original installed policy:
rule identity/order, deny or ask class, pattern/regex and flags, original
explicit or default tool set, inert call text/path, match/allow/deny/ask outcome,
confirm result and timeout. Include overlapping rules and unmatched tool/call
cases, not just rule counts. No assumption is made that the installed policy
protects bash, write and edit equally; omitted `tool` and string rules are
bash-only in the inspected source.

For each literal old-root protection, retain its existing scope at `O` and add
the corresponding approved `N` path adaptation with the **same tool set and
rule class**. Include exact old/new resource pairs for selected projects and
approved overrides, not only home-root paths. The adapted matrix must preserve
original old-path and unrelated-call outcomes; mapped new-path calls must equal
original counterpart outcomes. Compare the effective combined policy, including
rule ordering/overlap, confirmations and unchanged `askTimeoutMs`. Unprotected
write/edit calls stay unprotected unless a distinct policy change is explicitly
reviewed and approved; adding tool names is not a rename adaptation.

Record additions by rule identity. Do not simply replace `.imp` and thereby
make the rollback state writable. Do not change unrelated allow outcomes, regex
flags, wildcard semantics, deny/ask class or timeout. Any new tool-scope or
root/backup enclosure protection beyond original policy is a separately reviewed
policy change. Literal paths in global safety/context instructions also require
an approved current-path adaptation preserving the external-write approval rule;
`.ink` is not an unapproved scratch exception.

Missing/unreadable/invalid config, zero rules caused by relocation, lost old/new
protections, unresolved custom rules or a changed timeout **block cutover** even
if the example accepts them at runtime. Tests in §6 distinguish synthetic
repository fixtures from the later separately authorized private test of exact
installed policy using inert path strings. Both use a distinct module copy and
private disposable logs. No real guardian logs or staged files are changed.

Verify web-search's staged config by metadata (private regular file and trusted
parents), not by printing/parsing the real key. Validate format/behavior using a
synthetic key and copied resolver. Notes/custom agents/skills/extensions need
separate exact dependency decisions; unknown discovery entries cannot be waved
through because the root was copied successfully.

## 6. Exclusive publication primitive and offline rehearsal

### 6.1 Required native calls — no fallback

Publication is one directory rename from `C` to absent `N`, anchored in verified
parent directory descriptors. These are **API requirements**, not shell commands:

| Platform | Only allowed directory publication primitive |
| --- | --- |
| Darwin | `renameatx_np(stage_parent_fd, "state-root", home_fd, ".ink", RENAME_EXCL)`; `<stdio.h>` and Darwin declarations in `<sys/stdio.h>`. `RENAME_EXCL` is `0x00000004` in the inspected SDK and returns `EEXIST` if the destination entry already exists. |
| Linux | `renameat2(stage_parent_fd, "state-root", home_fd, ".ink", RENAME_NOREPLACE)` with `_GNU_SOURCE` and platform headers. The kernel/filesystem must support the flag; an unavailable libc symbol/kernel primitive blocks, not a reason to call `renameat()`. |

Source: Darwin SDK `rename(2)` / `renameatx_np(2)`, inspected locally under
`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/share/man/man2/`, and
[Linux rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html).

Use platform constants, not hardcoded syscall numbers. Reject absolute operand
names, slashes, dot/dot-dot, trailing slashes, equal identities and nested roots
in the runner. Open canonical parents component-by-component with no-follow
directory checks, retain descriptors, verify owner/device/inode identities and
use `fstatat(..., AT_SYMLINK_NOFOLLOW)` for source/destination checks. Source must
be the validated real candidate directory; destination must have no entry.
Immediately before the syscall, recheck that the approved canonical parent
names still resolve to the retained descriptor identities. A parent alias/swap
present before this final check refuses without publication. **The exclusive
syscall**, not an absence check, enforces destination nonreplacement. Anchored
descriptors do not freeze directory names: a parent namespace rename after the
final check can let the syscall mutate the retained directory under a changed
path. There is no guarantee of no mutation or continued path containment in
that race. Recheck parent namespace bindings as well as descriptor-relative
source/destination identity after the syscall. If any binding changed or the
postcheck is unavailable, diagnose actual identities read-only and keep startup
disabled, even after native return `0`; never claim unchanged manifests, retry
publication or move data back automatically. Exclusive rename does not make the
runner a sandbox against same-user namespace changes.

Do not add ordinary rename, Node `fs.rename`, `mv`, `mv -n`, copy-to-destination,
exchange or merge fallbacks. Do not precreate an empty destination directory.

Only native return `0` followed by verified parent namespace bindings,
destination identity/manifest and missing candidate name counts as successful
publication. `EEXIST`, empty-dir conflict, dangling-link conflict, `EXDEV`,
`ENOSYS`, `EINVAL`, `ENOTSUP`, permission
failure or any unknown error mean stopped; record the native error privately.
No retry, alternate flags, overwriting or conflict removal. If publication may
have occurred but result/postcheck is unavailable (interruption/I/O ambiguity),
classify actual source/destination by identity and manifest **read-only**; mark
an uncertain state and keep startup disabled. Never infer failure means safe to
retry. Exactly once means one authorized attempt in this activation; a later
attempt requires a new reviewed plan/authorization after diagnosis.

Fixture-test on the target platform and filesystem first. Workspace/scratch tests
on a different filesystem are not production-filesystem evidence. Creating a
private synthetic probe under the approved staging filesystem/enclosure requires
its own later owner approval; the test must not use real `O` or `N`. No automatic
helper gains home access merely because it passed workspace tests. The future
operator must separately review/approve an exact path-bound use of the tested
native primitive; this document does not supply a production migration program.
Atomic nonreplacement is not a power-loss durability guarantee. Record the
operator's reviewed file/directory sync method and recovery assumptions before
real cutover; unsupported durability semantics require a decision, not a promise.

### 6.2 Controlled offline boundary

Use a copied build/launcher fixture, neutral cwd, fresh fixture HOME/cache/state,
absent or synthetic installation-root `.env`, explicit fixture auth/settings /
catalog paths, sanitized child environment and a pinned fake model/provider.
No real credentials/config/history, production `.env` inheritance, global command
resolution or package fetch. Use [CLI fixture](../test/helpers/cli-fixture.ts)
and [network blocker](../test/helpers/network-blocker.cjs) only after verifying
their current guarantees; every spawned CLI needs the guard, not only Vitest.
Catalog/provider endpoints are local test servers or injected fakes; any nonlocal
attempt fails even if application code catches it. Node interception is not an
OS sandbox for arbitrary native child programs: unknown modules never execute,
and approved extension subprocess effects must be fake/dry or separately blocked.

Guardian uses a copied approved module/config with fake API, controlled confirms,
fixture audit logs and cleaned-up timers. Synthetic repository fixtures prove the
adaptation method but cannot certify an unknown installed policy. Later, under
separate operator approval, test a private disposable copy of the **exact adapted
installed module and noncredential guardian policy**: retain its literal patterns,
flags, tool lists and timeout unchanged, and pass the exact old/new absolute paths
as inert fake tool-call strings. HOME and audit output remain fixture-local; no
actual tool command/write/edit is dispatched. If policy contains private values,
keep them out of test reports and tracked fixtures; any credential-bearing policy
requires a separate decision, not reading credentials for acceptance.

Execute the policy-derived matrix from §5.3: assert old-path and unrelated-call
outcomes unchanged, and mapped new-path outcomes equal their original
counterparts for each rule's actual tool scope. Exercise deny-before-ask,
approve/decline/timeout (never truthy approval), unchanged `askTimeoutMs`,
reload errors and missing-config operator rejection as applicable. Include a
**bash-only fixture** with string and omitted-tool rules: bash old/new outcomes
match after path adaptation, while write/edit old/new calls remain unmatched
unless another explicit original rule applies. No silent tool-scope broadening.
Notifications use an explicit dry sink; web-search uses synthetic private config
and local/mocked endpoints.

Ordinary v1 restoration fixtures prove list/continue/resume, mtimes, names,
branch/compaction, model/thinking and usage with the **same canonical project
cwd**. Old children remain inspectable with v1 `impVersion`; valid owned/custom
prompt cases reach version-drift before lease/repair/child-provider execution;
earlier safe refusals remain valid. Verify child bytes unchanged and zero child
calls. New Ink child create/resume works; retain `.imp-machine-id` unchanged.

Compare original/stage manifests before and after validation: zero mutation
beyond the approved operator stage diff. Behavioral validation must use synthetic
state copies, never mutate candidate history/logs or follow links to live source.
Do not solve an unexpected provider choice by silently accepting a default model.

## 7. Ordered source-linked activation

All phases keep parents/children/MCP/writers stopped. Requests are sequential,
one sensitive operation at a time. There is no normal old or new startup between
retirement and the coherence check. Record completion privately after verification.

| Phase | Separately authorized operation and required evidence |
| --- | --- |
| A0 — ready | Gates D/T closed; reviewed implementation and artifact checks; disjoint private verified backups/stage, external writable-target old snapshots and preservation plan, phase-aware selected-project root expectations; approved policy-derived guardian/path diffs; filesystem primitive probe; quiescence evidence; rollback rehearsal. Freshly reject any `N` or unrelated `ink` executable/registration. |
| A1 — retire old command | Remove only the verified `/opt/homebrew/bin/imp` link, after exact target recheck and approval. Preserve its link record; never unlink the source launcher as a substitute. |
| A2 — retire old module registration | Remove only verified `/opt/homebrew/lib/node_modules/imp` link, separately approved; preserve source `I` and dependencies. No broad npm uninstall or recursive deletion. Both historical global entry points are now disabled. |
| A3 — integrate | In authoritative `I`, integrate the independently reviewed branch into main using `--no-ff`, under a separately approved integration plan accounting for its current `design/ink-rename` branch and other worktrees. Record merge/review revisions, verify expected tracked state, and record actual selected `.imp` root manifests after approved tracked removals, including retained untracked entries; do not assume parent directories disappeared. No destructive reset, source move or implicit push. Source integration changes example targets and removes the old launcher. |
| A4 — build real installation | Build fresh `I/dist` from the integrated revision using the reviewed `npm run build` script and verified read-only/owned dependencies. No dependency install through a shared link. Account for and remove/quarantine obsolete output only by an exact reviewed operation; do not leave stale files accidentally. Record compiler/runtime/version inputs and a private manifest of fresh output. |
| A5 — verify build and adapt external references | Test a **copied** build/launcher offline; verify `ink-agent@0.2.0`, only `bin/ink.js`, `dist/cli.js`, Node shebang/mode and exact `Ink 0.2.0` output. Separately apply each approved installation `.env`, shell export, standard MCP and external active-reference diff; preserve rollback snapshots. Distinguish control-file adaptations from shared/relocated runtime data and record each target binding and approved data change. No shell profile `source` or unknown startup hooks. Source/example dependency map must now describe the new bytes. |
| A6 — final state check / publish once | Reverify original-state and snapshot integrity, candidate approved diff, integrated source/fresh dist/example manifests against A4/A5, dependency resolution from `N`, guardian config/modes, stopped processes/leases and destination `lstat` absence. Request approval for precisely `C -> N`, then invoke only §6.1's tested primitive once. Verify destination identity/manifest and candidate absence; keep command disabled if any check fails. |
| A7 — selected project resources | Verify tracked `I/.ink` and original cwd/trust identity, including `autoCompact: false`. Perform only planned per-project operations after individual approvals/conflict checks; record actual remaining original `.imp` roots and full phase-specific manifests, including untracked entries, without automatic retirement. If a required project resource is not ready or differs unexpectedly, remain stopped. Never crawl other repositories. |
| A8 — create new module registration | Independently approve a no-overwrite registration `/opt/homebrew/lib/node_modules/ink-agent -> I` after confirming destination absent and metadata coherent. The path-bound link operation must fail on any existing entry; do not run an uncontrolled global link/install lifecycle. |
| A9 — expose new command last | Reconfirm quiescence and expected state/runtime/example/environment manifests after A7/A8. Separately approve exclusive creation of `/opt/homebrew/bin/ink -> ../lib/node_modules/ink-agent/bin/ink.js`. Recheck all resolution locations and no unrelated `ink`. No `imp` alias. Old state is inactive, not a fallback. |

If a phase fails or awaits approval, keep startup disabled. If A8/A9 partially
succeed, do not pretend the completed entries are harmless: separately authorize
retirement of the exact new entries before recovery as needed. Existing direct
source launch paths and cached shell command resolutions also remain under the
operator no-start condition; disabling global links alone cannot stop them.
`dist`, launcher, package/version, state, installed guardian, environment and
source-linked examples must all be coherent before any normal invocation.

### Acceptance and retention

First recheck registrations and build/state metadata without starting the app.
Then separately approve a bounded quick-exit plan for `ink --help`, `ink --version`
and, if requested, `ink sessions` from the unchanged selected project cwd.
Re-audit the integrated `main()`/dotenv/catalog behavior first: help/version
still load installation dotenv and catalog cache; sessions prints private titles
and reads transcripts. Review that no startup imports perform side effects.
Keep session output in a private terminal/record, not repository logs or chat;
use aggregate counts for reports. Unexpected extension/network/write activity
fails acceptance and returns to a stopped condition. Do not run login/logout,
resume/continue with production providers or a prompt as a quick-exit check.

Restoration/trust/guardian/extension behavioral acceptance stays in §6 fixtures.
Any subsequent production normal startup has a separate reviewed side-effect
plan (known extension imports, possible notifications/MCP/catalog/provider calls
and quota). A live provider smoke is optional and separately authorized, not a
prerequisite substituted for offline proof. Preserve the Codex `originator:
"imp"` compatibility header for this cutover.

Owner acceptance records exact installed revision/version, evidence and chosen
backup retention date. Leave `O`, `B`, failed stages and the private record intact;
cleanup, archiving elsewhere or deletion is a new sensitive operation. No push,
release tag, registry publication or automated old-state cleanup follows acceptance.

## 8. Rollback using captured old runtime and examples

Rehearse this sequence with synthetic old/new roots **before** cutover. The old
raw state links may now target Ink code: never execute `B/state-original` or
restore it unchanged and assume that it runs the old behavior. Rollback covers
all mapped writable targets, not merely the home and project roots. A preserved
referring config file is not preservation of the data it references.

1. Stop Ink and **all mapped target writers**, including separately owned shared
   target writers, using §4; request rollback approvals independently and keep
   both entry points disabled. Verify frozen snapshot digests. Capture the actual
   completed A phase and per-project operation: read-only identity checks
   distinguish an unpublished candidate, published `N`, expected original project
   roots and foreign conflicts. Never touch a foreign conflict to enable recovery.
2. Create private, disjoint `R` under its own approval. **Before restoring any
   data, configuration, context, link binding or registration**, complete a
   post-Ink preservation manifest covering:
   - The entire published `N`, unknown files included, even if only quick-exit
     acceptance ran; record actual existence and whether it changed. A separately
     approved exclusive move to absent `R/post-ink-root` preserves it intact on
     the same filesystem. Ambiguity is diagnosed without retry.
   - Every selected project's current `.ink` and `.imp` resources, plus current
     safety/context files; preserve unknown files and record verified absence.
     Post-Ink `.ink` data is never discarded to restore `.imp`.
   - **Every writable external target** and declared temporary/sidecar namespace
     from §3, whether still shared with old bindings or relocated. Preserve the
     current shared target once by canonical target ID; for relocated bindings
     preserve both old and new targets. Capture complete opaque current bytes /
     modes/mtimes or verified absence under `R/external-post-ink/<target-id>`.
     This includes external auth/settings/catalog/cache and extension logs/notes /
     private data outside home/project roots. Originally absent targets created
     by Ink are new data too. Each external capture needs separate authorization,
     no secret output and stable-writer evidence. Do not infer unchanged data
     from unchanged override names or module code.
   - Current shell/dotenv/MCP/control-configuration bytes and reference bindings
     separately from runtime data, before their approved restoration.

   A byte-verified independent copy can preserve a target still in place; any
   later replacement requires separately approved nonoverwriting preservation
   and publication, not an in-place write over the current target. Cross-filesystem
   targets need a reviewed private copy/restore method; never ordinary-rename
   fallback. Missing preservation entries/manifests, unexpected target absence,
   uncertain aliases or uncontrolled writers block rollback startup; a verified
   absence matching the recorded phase is itself a valid preservation entry.
   No new sessions/auth/trust are merged, discarded or
   overwritten. Private reconciliation remains a separate decision.
3. Prepare `R/old-state-root` from frozen raw state. Restore original guardian
   module/config there; translate only approved executable dependency links for
   notify, timer, colors, web-search and other known mutable source targets to
   **captured old closure in `B/examples-old`**, never current `I/examples`.
   Historical text/lease/session bytes remain unchanged. Account for the external
   target dispositions below before finalizing old override/link bindings. Rehearse
   final `.imp` resolution and original policy outcomes with equivalent fixture
   copies; record exact recovery diffs. Snapshot bytes stay immutable.
4. Preserve existing `O` intact by a separately authorized exclusive move to
   absent `R/preserved-imp-root`, after identity/integrity checks. Unexpected
   change blocks automatic restoration and requires a private reconciliation
   decision. Publish the verified candidate to now-absent `/Users/z/.imp` with
   the native exclusive primitive under a **new** approval. Do not overwrite or
   merge a present root. Failure between moves leaves entry disabled and roots
   retained. A whole-root replacement is unnecessary if review proves original
   runtime/link bindings and root are already coherent; authorize retention
   explicitly instead, without executing the raw backup.
5. Recover selected project resources **according to the completed phase**, not
   an assumption that `.imp` vanished. Compare `lstat` identity and full manifest
   to the recorded phase expectation and old effective resources (§5.1), using
   the disposition table below. This applies to `I` and every selected project,
   including untracked `.imp` contents before or after A3. Keep the same cwd and
   new `.ink` data intact. Recover effective `autoCompact: false` through verified
   retained or approved restored old settings; no automatic runtime alias.

   Before **any repository recovery edit**, including an untracked resource
   restoration under `I`, create a dedicated recovery branch or worktree and
   execute repository mutations only under that recovery plan. If tracked
   safety/context files such as `I/AGENTS.md` need old-root
   adaptations, prepare the minimal recovery diff on that branch, independently
   review it, obtain integration approval and integrate with **`--no-ff`** before
   exposing the recovered command. Preserve current tracked bytes/revisions in
   the recovery record. This requirement applies to the **preferred snapshot
   rollback**, not only an old-source restoration. Do not edit tracked files
   directly on main, silently copy old `AGENTS.md` over Ink's tracked file, or
   bypass the branch rule for small recovery edits. If a policy file is already
   suitable and unchanged, verify and retain it; if approval/review is pending,
   stay stopped. New tracked `.ink` resources are not deleted just to recover old
   local `.imp` state; recheck phase expectations after any reviewed recovery
   integration.
6. Apply each approved external runtime-data disposition and then restore the
   corresponding shell/override/MCP/control-configuration references **only after
   step 2 preservation**. Use the table below to distinguish unchanged shared
   data from changed data or relocated targets. No blanket restoration of
   "configuration" may overwrite external mutable settings/auth. Retire verified
   new `ink` executable and `ink-agent` registration individually if present.
   Do not delete `I`, rewind Git with `reset --hard`, or rebuild old dist from
   current Ink source. `I` may remain integrated Ink software plus reviewed
   recovery-policy changes; it is not the old runtime or mutable-example target.
7. Preferred recovery binding: recreate an `imp` module registration targeting
   **`B/install-old`**, and the historical executable link through that registration,
   each exclusively and separately approved. The module target intentionally
   differs from recorded original `I`: this is private snapshot recovery, not
   exact source-linked restoration. Before exposure, verify closed old runtime /
   dependencies/installation dotenv, all root and external-target dispositions,
   policy/guardian compatibility, completed recovery branch review/integration,
   and post-Ink preservation manifest. Snapshot installation bytes stay unchanged;
   any required alternative installation/configuration is a separate reviewed
   recovery candidate, not an edit to the immutable snapshot. The project cwd
   remains `I`, preserving session/trust identity. Accept old help/version under
   a reviewed quick-exit plan before separately approving old normal startup.

### Selected original project-root dispositions

| Actual root at rollback | Required disposition |
| --- | --- |
| Present and unchanged from the recorded phase expectation, with complete old effective resources | Verify bytes/modes/mtimes/link map and **retain unchanged**. Before A3 this may include tracked old settings; after A3 another selected root or `I`'s untracked resources may still remain complete. No unnecessary move, copy or conflict refusal merely because it exists. |
| Present and unchanged from phase expectation, but old effective resources need approved restoration | For example A3 removed tracked settings while leaving an untracked `I/.imp` directory. Prepare a complete approved candidate from `B/project-old`, separately approve exclusive move of the existing whole root to absent `R/project-preserved/<project-id>`, then approve exclusive candidate publication to its now-absent original `.imp` path. Do not merge into or overwrite the existing root; failure between moves remains stopped. |
| Absent as recorded for that phase | Separately approve publication of the verified complete candidate to absent original `.imp` using the exclusive primitive. Verified absence is not inferred from removal of one tracked file. |
| Changed from recorded phase expectation, unknown/foreign contents, unexpected disappearance, file/symlink/dangling link or uncertain ownership | **Block restoration/startup** and preserve evidence; require a separate reviewed reconciliation/disposition. Capturing changed data in step 2 does not authorize replacing it. |

### External writable-target dispositions

| Target binding/current state | Required disposition after preservation |
| --- | --- |
| Shared old/Ink target, byte/metadata unchanged from approved old baseline | Verify closure/compatibility and retain under an explicit approved old binding; no replacement necessary. |
| Shared target changed by Ink | Preserve all post-Ink bytes first. Separately review compatibility and either explicitly retain current data for the old runtime or prepare old working data from `B/external-old` in an approved private recovery location and rebind, or authorize exact preservation move plus exclusive restore to the original path. No automatic decision or silent old-byte overwrite. |
| Relocated distinct old/new targets | Preserve both actual current targets first. Retain new post-Ink target/data. Verify the old target against baseline; retain if unchanged and compatible, otherwise stop for its own reviewed replacement/rebinding decision. Restoring a referring override is not permission to mutate either target. |
| Originally absent target now present, unknown mutation, unsupported/escaping alias or shared writer not controlled | Retain/preserve current data and **block** any conflicting restoration until separately reviewed; no deletion to reestablish absence. |

If the owner requires the old registration to point back to `I`, that is a
**different recovery design**: restore captured old source/runtime/example closure
on a dedicated recovery branch with independent review and `--no-ff` integration,
not an improvised overwrite. Snapshot recovery is unavailable until the owner
approves the private target binding, complete data dispositions and retention.

Failures before source integration can use captured recovery or original
registrations only after proving old `I` runtime/examples, policies and all
project/external writable targets coherent. Failures after integration/build /
publication require captured old closure plus phase-aware resource recovery.
Interrupted/repeated cutovers are not helper-resumable: diagnose, preserve all
new data and obtain new approvals. Reconciliation is manual and separately
reviewed; child version refusal never authorizes rewriting launch records.

## 9. Minimal helper requirements and planned fixtures

These workspace/scratch-only surfaces were implemented after Gate D and
independently reviewed (see §11). They are test fixtures, not operator tools.

| Synthetic test surface | Minimal contract |
| --- | --- |
| `test/helpers/cutover-fixture.ts` | Create private synthetic disjoint roots and typed no-follow manifests; copy/compare bytes, modes, supported mtimes and link text; explicit adaptation allowlist. Require an explicit validated fixture root. No home lookup, env-derived production path, credential parsing, automatic migration or arbitrary link dereference. Reject escaping roots/targets and unsupported metadata rather than pretending to preserve it. |
| `test/helpers/exclusive-directory-rename.c` | Small native runner calling only the platform API in §6.1, explicit fixture parent paths/leaf names, anchored descriptors, identity checks and native status. Bound all paths to a caller-created workspace/scratch fixture root; no default home, scanning, config loading, copy, removal, retry or fallback. Compile only into fixture/scratch; do not add a dependency/global package or application CLI command. Unsupported OS/compiler/runtime/filesystem produces explicit unavailable/failure evidence. |
| `test/cutover-runbook.test.ts` | Synthetic adaptation/copy/activation/rollback state-machine tests and independent-process publication races. A fixture-only wrapper supplies deterministic barriers; do not add race hooks to production startup. Reuse reviewed CLI/network isolation and guardian fake-API patterns where sufficient. |

The helper scope deliberately excludes production migration tooling. The later
operator binding of a native primitive to real staging/home paths must be reviewed
and authorized independently; do not remove fixture restrictions to save time.
Use no output containing contents of even synthetic credential fields; fixtures
must never be generated from the owner's auth, settings, conversations or private
rules. A documentation structure check is not a native syscall/copy test.

| Fixture group | Required cases and observable evidence |
| --- | --- |
| Root/path conflicts | Existing `N` regular file, empty/nonempty directory, valid and dangling symlink; source symlink/file/absent; same source/destination; nested destination/backup/stage; parent alias or swapped parent identity **present before the final namespace check**; escaping relative link and link cycle. Pre-call validation refuses without publication; runner causes no additional original/stage/conflict mutation. Concurrent fixture setup mutations are reported separately, not attributed to the runner. |
| Native publication | Nonempty candidate to absent destination succeeds once. Separate process inserts an empty directory, file or dangling link **after precheck but before syscall**; no replacement and native failure. Two publishers to one absent destination: exactly one success and intact loser. Rename a parent namespace **after the final namespace check**: descriptor-anchored publication may already mutate the retained directory; require postcheck failure/uncertainty, read-only identity diagnosis and startup disabled, not unchanged manifests or automatic undo. Unsupported flags/kernel/filesystem, permission failure, cross-mount and interruption/postcheck failure: no fallback/retry. Actual Darwin and Linux filesystem results reported separately. |
| Copy integrity | Dotfiles, unknown opaque regular files, archives, directory/file modes (`0700`, `0600`, `0644`, executable file), symlink text, nanosecond/rounded timestamp probes and directory mtimes. Verify bytes/metadata, independent storage and continue-order preservation. Unknown special files/executable links/hard-link escape block; approved root-only `0700` exception is explicit. No secret output. |
| Internal dependencies | Relative and absolute old-root links, nested chains, settings overrides and standard MCP command/cwd/path/`${IMP_*}` references. Approved active paths resolve to fixture `.ink`; historical JSONL/trust fields stay identical; unchanged external approved paths stay unchanged. Unknown active modules remain inert/blocking. |
| Quiescence | Writer/heartbeat during interval, new child without a lease, surviving detached/reparented group/MCP descendant, PID reuse, foreign or malformed claim and pending async append. Each blocks; stable empty process ledger plus six stable samples succeeds. No killing or lease cleanup by helper. |
| Isolation | Controlled/absent install `.env`, neutral cwd, sanitized children, local catalog/provider and pinned model; attempted nonlocal request fails despite caught exception. Original/candidate validation sentinels stay unchanged; mutable live links never imported. |
| Guardian installed copy | A locally changed regular module cannot be blindly replaced. Derive original rule/tool/call/outcome matrix and prove adapted old-path/unrelated outcomes unchanged and mapped new-path outcomes equal original counterparts, including rule overlap, deny precedence and applicable confirm/timeout behavior. **Bash-only string/omitted-tool fixture** preserves bash outcomes while write/edit remain unmatched; a separate explicit write/edit fixture preserves only its original scope. No silent tool-scope broadening. Keep timeout, missing/unreadable-config operator refusal and fixture-only audit `0600`; no empty-rule acceptance caused by missing migrated config. |
| Mutable-symlink rollback | Old state links to example A; deploy example B at same mutable source target, including changed web-search `_lib`; fail at activation phases. Rollback uses captured old runtime **and A's whole import closure**, proving old behavior rather than B, without touching snapshot bytes. Keep installed-copy guardian's old policy and recover the old project's `autoCompact: false` while preserving post-Ink `.ink` resources. |
| Activation/repeat/data | Inject failure between every A1–A9 phase; entry stays disabled until coherent. Rehearse ambiguous publication by read-only identity diagnosis. Repeat invocation refuses existing publication paths, not verified unchanged selected old roots. Ink creates new history/unknown data; rollback preserves it privately before old publication, keeps cwd identity and never merges/deletes it. |
| External writable rollback | Synthetic auth/settings/custom-extension data outside both home state roots and selected project roots; shared aliases and relocated old/new targets. Ink changes bytes or creates an originally absent file. Before any config/data restoration, preserve every unique current target and declared sidecar/unknown directory file. Verify old snapshot alone is insufficient, shared changed data blocks automatic overwrite, relocated new data remains intact and uncontrolled shared writer blocks. Credential fixture bytes are synthetic/opaque and never printed. |
| Phase-aware project rollback | Before A3, an unchanged original `.imp` with complete old resources is verified/retained. After A3, `I/.imp` can remain with untracked files after tracked settings removal; exact recorded phase manifest permits only approved exclusive whole-root preservation move plus candidate publication if replacement is needed. Other selected roots may remain complete and are retained; changed/foreign/dangling roots block. Cover absent-as-recorded, unexpected absence and failure between moves; preserve post-Ink `.ink`. |
| Snapshot recovery tracked policy | Ink has a tracked `AGENTS.md` requiring recovery adaptation while old executable runs from `B/install-old`. Recovery edit must start on a dedicated branch/worktree, pass independent review and approved `--no-ff` integration before exposure; no direct main edits or whole-file copy. Already suitable unchanged tracked policy is verified/retained. Pending review/integration keeps startup disabled. |
| Legacy history | Ordinary v1 mtime-sensitive continue/name/branch/compaction/model/thinking/usage; old-child safe refusal before lease/repair/provider; preserved `impVersion`/`.imp-machine-id`; new Ink children resume. Synthetic only. |

For helper implementation, run targeted fixtures, typecheck/lint/build/full offline
tests as applicable, artifact checks and `git diff --check`, then independent code
review. Missing Linux/target-filesystem execution remains explicit evidence debt;
it cannot be replaced by a passing Darwin test or a mock of a rename function.

## 10. Outstanding operator decisions

These remain **blockers before their corresponding later phase**, not permission
to improvise:

1. Runbook r2 design and synthetic helper code reviews are closed (see §11).
   Actual Darwin scratch execution passed; Linux, cross-mount, unsupported-operation
   and production-path execution remain unverified. Do not infer them from Darwin.
2. Named operator, exact revision/integration plan from current branch to main,
   process/restart-source ownership ledger and approval requests for each phase.
3. Expanded fresh private paths, size/space budget, ACL/extended metadata method,
   target-filesystem probe, root-only `0700` adaptation, timestamp/durability method
   and retention policy. No home enclosures exist by action of this task.
4. Complete private active dependency/writable-target map, opaque old/current
   data preservation and shared/relocated external-target dispositions; original
   guardian rule/tool/call/outcome matrix and equal-scope adaptation, unchanged
   timeout, environment/MCP/safety-text edits, unknown modules, and finite selected
   project list with phase-aware original-root manifests.
5. Exact independently reviewed operator invocation for exclusive state rename
   and no-overwrite global registrations; fixture runners have no production
   access. No global npm install/link/uninstall recipe is authorized.
6. Approval of snapshot-based old-runtime registration at `B/install-old` and
   immutable example closure, full project/external-data recovery dispositions,
   and dedicated recovery branch/review/`--no-ff` integration for any tracked
   policy changes even with snapshot runtime; otherwise separate source restoration.
7. Quick-exit/private session-list acceptance plan and any later normal startup's
   explicit external-side-effect/quota boundaries. Public release remains outside
   this procedure and blocked on its separate design/approvals.

## 11. Review and verification record

- r1 authoring: metadata/code inspection only; no private configuration,
  credential values or conversations read; no production command executed.
- r1 independent design reviewer `e412...` (abbreviated identity supplied by the
  caller): **NEEDS-FIXES — 1 P1, 3 P2**, plus a parent-namespace race clarification.
  No full reviewer ID or approval is inferred from the abbreviation.
- r2 responses (subsequently closed by independent review):
  - P1: complete writable external-target closure, old/post-Ink opaque captures,
    control configuration versus runtime data, shared/relocated target dispositions
    and external-data rollback fixtures (§3, §5.1, §8, §9).
  - P2: phase-aware original selected `.imp` roots, unchanged complete retention,
    approved exclusive whole-root move before replacement, changed-root blockers
    and pre/post-A3 untracked-root fixtures (§5.1, §7, §8, §9).
  - P2: original guardian rule/tool/call/outcome baseline, equal-scope path
    adaptation and bash-only fixture; no implicit write/edit protection (§2,
    §5.3, §6.2, §9).
  - P2: preferred snapshot recovery also requires dedicated recovery branch /
    worktree, independent tracked-policy review and approved `--no-ff` integration
    before exposing the recovered command (§1, §8, §9).
  - Clarification: pre-final-check parent swaps refuse before publication; a
    namespace rename after that check may permit descriptor-relative mutation,
    requiring read-only diagnosis and disabled startup, not an unchanged-tree
    guarantee (§6.1, §9).
- r2 authoring: source and document inspection only; no private values read,
  no helper implementation, migration, commits or home/global modification.
- Independent design review closure: **APPROVE r2**, reviewer session
  `e412d5f2-8fdb-4ecf-88d9-d3a7fa0e2641`, 2026-10-04. All R1-R4 and the
  namespace-race clarification closed at specification level. **Gate D closed**;
  fixture-only implementation may proceed. Real cutover remains blocked on
  Gate T, target-filesystem evidence and operation-specific owner approvals.
- Synthetic helper code review: **APPROVE**, session
  `d055e038-b5e6-49ab-b23a-7de8f7a749c4`, after four P2 fixes: conflicting
  writable-target IDs, GID preservation limits, ENOTDIR link traversal, and
  regular-file/declared sibling-sidecar preservation. Activation has coherent
  positive controls and single-missing-gate failures.
- Helper verification: `test/cutover-runbook.test.ts` **79 passed, 1 skipped**;
  native Darwin scratch calls executed, Linux unavailable. Final full suite:
  **141 files passed, 3064 tests passed, 1 skipped**. Typecheck, lint, build,
  native syntax and offline artifact smoke passed; full acceptance is recorded
  in [rename design §10](ink-rename-design.md#10-workspace-implementation-acceptance--2026-10-05).
- Gate T: independent synthetic helper review and Darwin fixture evidence closed;
  production-path/filesystem, cross-mount, unsupported-operation and Linux
  execution evidence remain outstanding. No real migration, home/global writes
  or operational authorization is claimed.
- Documentation checks: links and whitespace verified. Synthetic helpers remain
  test-only and cannot be rebound to production paths under this approval.
