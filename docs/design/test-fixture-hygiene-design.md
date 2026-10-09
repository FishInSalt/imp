# Test Fixture Hygiene & Zero-imp New Artifacts — Design

Status: IMPLEMENTED and MERGED (385d2fb, 2026-10-09); followup review A1-B5/C1-C4 folded in fix/fixture-hygiene-followup
Branch: `feat/test-fixture-hygiene`
Date: 2026-10-09

## 0. Context and motivation

Two independent investigations this week converged on the same root cause:

1. The readonly-parallel round-2 review child burned ~112 minutes in 19
   `ls -lT $TMPDIR` calls (4–13 min each). Cause: ~1.30M directory entries in
   the user's TMPDIR, of which ~1.28M were this repo's leaked test fixtures
   (`imp-*`) plus 2,107 `ink-*` and 1,234 `parent-wt-*` (subagent worktree
   placeholders). One `ls -lT` measured 3m51s before cleanup, 0.02s after.
2. `/tmp` held 735 `imp-builtin-visual-*` snapshot dirs (47MB) from
   `test/builtin-visual-verification.test.ts`, which hardcodes `/tmp` and
   never cleans.

Measured leak rate today: **~1,200–2,500 new TMPDIR entries per full-suite
run** (two full runs during verification on 10-09 produced 2,488 `imp-*` +
28 `ink-*` in ~20 minutes).

The owner additionally ruled: **all NEW artifacts must be ink-named — no
`imp` anywhere in bytes this repo writes** (except the explicit read-arm /
test-input exceptions in §5).

This batch therefore has two tracks that share one code touch:
- **Track A** — stop the leaks (fixture lifecycle + stale-root sweep +
  /tmp de-hardcode);
- **Track B** — rename every `imp-` fixture prefix this repo writes to
  `ink-`, plus `IMP_LEASE_*` → `INK_LEASE_*` IPC markers, plus removal of
  the now-unreachable `impVersion` read arm (Track C, folded here because
  its deletion test lives in the same files).

## 1. Inventory (facts, verified 2026-10-09)

### 1.1 Writers this repo owns

| Writer | Count | Files |
|---|---|---|
| `mkdtemp*("imp-…")` | 298 calls (295 quoted + 3 template literals) | 72 files |
| `mkdtemp*("ink-…")` | 15 calls | — |
| TMPDIR top-level FILE writers via template literals (no mkdtemp): `imp-ds-catalog-*` deepseek:98, `imp-ms-catalog-*` moonshotai:124, `imp-fresh-auth-*` fresh-install-hint:53, `imp-smr-auth-*` startup-model-resolution:53, `imp-fresh-tui-*` repl-tui:2335/2363/2393/2424, `imp-auth-test-*` codex-auth:43 | 9 sites / 6 files | **Currently leaking** (5 of 6 files have no cleanup; codex-auth unlinks at :44/:96/:160) — renamed + lifecycle'd in A1/B; invisible to the draft's quote-only inventory (round-2 MAJOR-1, split corrected round-3 MINOR-A) |
| worktree-base dirs via template literals: `imp-wt-*` task-tool.test (16), worktree + child-launch-validation (1 each) | 18 sites | routed through mkTempDir (startup-model-resolution's writer is a FILE, not a wt-base — MINOR-A). NOTE: child-launch-validation:389 stays a §5 survivor (test INPUT forging legacy names; has its own afterEach cleanup — round-3 MINOR-B), so 17 of 18 rename, 1 survives |
| non-mkdtemp `imp-` dir writers (`freshDir`/`setup("imp-…")`) | ~30 | child-lease-scripts.test.ts (4), child-lease.test.ts (26) |
| `IMP_LEASE_WORKER` / `IMP_LEASE_SCRIPT` env IPC markers | 10 lines | 5 files (settings-setup.ts :15/:21, both lease-worker helpers ×2 sites, multiprocess :17, scripts :16) |
| `/tmp` hardcoded snapshot writer | 2 sites (:331 sentinel-only, :396 real) | builtin-visual-verification.test.ts |
| `impVersion` write arm | 0 (already ink-only; builder writes `inkVersion`) | — |

Distinct tmpdir fixture prefixes: authoritative count = generated
`fixture-prefixes.ts` (the draft's "225" was a double-quote-era tally;
regenerate at implementation and record in the file header).

### 1.2 Prefix provenance (corrected after review M-1)

An earlier draft claimed `imp-policy`/`imp-auth`/`imp-settings`/`imp-tui`/
`imp-home`/`imp-catalog` were foreign contamination. Only `imp-policy` is
foreign (0 hits at any revision). The other five bulk prefixes **are this
repo's own fixtures** (auth-store.test.ts, settings/settings-panel,
repl-tui, model-catalog, settings-setup). Consequences for §A2:

- The sweep list IS the repo's own committed inventory
  (`fixture-prefixes.ts`, generated + audited), and it necessarily
  includes prefixes an old globally-installed imp binary also used. The
  old binary is no longer installed (`npm ls -g` = ink-agent only); a
  future reinstall's fresh dirs would be <24h and survive the sweep.
  Accepted residual: a reinstalled old binary's >24h tmp dirs would be
  swept. Owner sign-off required on this acceptance.
- Match semantics: prefix entries carry their trailing `-` and match with
  `startsWith`; nested repo prefixes (`imp-lease` vs `imp-lease19a`) are
  both in the list, so ordering is irrelevant. The generator regex
  matches ALL quoting styles — double, single, AND backtick template
  literals (round-2 MAJOR-1: the draft's double-quote-only regex was
  structurally blind to ~27 backtick writers, incl. real current leakers
  deepseek/moonshotai/fresh-install-hint). Generated output + a manual
  audit delta (documented in the file header) are committed as
  `test/helpers/fixture-prefixes.ts`, never hand-maintained; §7.3's gate
  regex carries the same quote-class.

### 1.3 Historical objects backing the rename survivors

- `imp/` branches: 0. `imp-worktree-*` dirs: 0 (worktree list = main only).
- Structured `impVersion` child-launch records: 12 child files, all 10-06,
  last write 10-06 19:24. **All 4 referenced parent FILES exist**
  (verified by header.id read-back, review M-3 — an earlier draft claimed
  orphaning; that was a filename-matching artifact: session FILENAME uuids
  are independent randomUUID() calls, never equal to header ids; "exists"
  here means reachable, distinct from "finished" = work done). The
  records are therefore REACHABLE: resuming one of those 3 parents and
  resuming its child exercises the read arm. Owner decision 2026-10-09:
  the 3 parents are finished (56–77h idle, deliverables merged) — arm
  removal + their deletion approved (§4).
- Chat-text `impVersion` mentions: 7 files (prose; uncontrolled by design —
  the owner's rule governs code-written structured bytes, not conversation
  transcripts).
- `.lease` sidecars under children/: 15 entries, 64 bytes each — that
  number is the inode size; emptiness must be determined by CONTENT, and
  liveness must reuse child-lease.ts's own semantics (`isAlive(pid)` +
  freshness), not a fresh mtime heuristic (§6).

## 2. Track A — leak elimination

### A1. `mkTemp` helper with lifecycle

New `test/helpers/mktemp.ts`:

```ts
export function mkTempDir(prefix: string): string;          // sync
export async function mkTempDirAsync(prefix: string): Promise<string>;
```

Behavior:
- `prefix` MUST start with `ink-` (assert; hard error otherwise — this is
  the enforcement point for Track B, so a stray `imp-` prefix fails loudly
  at authoring time rather than in review).
- Creates via `mkdtempSync(join(tmpdir(), prefix))` and registers
  `onTestFinished(() => rmSync(dir, { recursive: true, force: true }))`.
- Works when called inside `it`/`beforeEach`/helper functions invoked from
  them (the 95% case). Module/describe-scope consumers needing migration:
  auth-store.test.ts:22, trust.test.ts:21, child-model-metadata.test.ts:16
  — each already has a `beforeEach` to move the call into. NOT migrated:
  mcp-config.test.ts:21 (beforeAll + existing afterAll rmSync — already
  clean, review m-4).
- Idempotent-safe: double registration is harmless (rmSync force).

Replacement scope: all 295+12 mkdtemp call sites + the 34 non-mkdtemp
writers get the same treatment (freshDir-family helpers route through
mkTempDir internally).

**Explicit exception — `builtin-visual-verification.test.ts`**: keeps
intentional post-run snapshots for human inspection (its designed purpose:
`VISUAL_ARTIFACT <path>` is printed for manual review). It moves to
`tmpdir()` + `ink-` prefix (:396) but does NOT register immediate cleanup;
its lifecycle is §A2's 24h sweep. To keep the human-inspection window
honest (m-9), the test prints one extra line on first snapshot of a run:
`snapshots auto-removed after ~24h — copy out anything you want to keep`.
:331 stays as-is (sentinel path, setup fails before any disk write —
nothing to move; recorded as A3's noted exception, n-1).

### A2. Stale-root sweep in settings-setup.ts

At setup (once per worker, before tests run), best-effort synchronous:

- ONE worker per run performs the sweep. Guard (empirically verified
  2026-10-09, round-2 MINOR-2 — the draft's `VITEST_POOL_ID ===
  undefined` example was wrong: pool workers DO set it, measured =1):
  sweep runs iff `process.env.VITEST_WORKER_ID === "0"` (main worker;
  probe measured WORKER=0 inside the suite) AND no
  `INK_LEASE_WORKER`/`INK_LEASE_SCRIPT` marker present (lease-spawned
  vitest subprocesses inherit the marker — they skip entirely; m-8).
  Kills the concurrent-sweep race AND the repeated-scan cost.
- Race with a parallel FULL test invocation (two humans, two terminals):
  impossible to fully exclude; the 24h mtime threshold makes deleting the
  other run's fresh dirs structurally impossible (they're seconds old).
- Enumerate `tmpdir()` depth-1; delete entries matching a
  `fixture-prefixes.ts` prefix AND mtime older than 24h; `try/catch` per
  entry (ENOENT/EBUSY → skip); never follow symlinks; never fail the run.
- Enumeration cost honesty: on a still-polluted TMPDIR the first sweep is
  minutes-long (readdir of 1M entries). Accepted one-time cost, visible
  via a single console log line (`swept N stale fixture roots`); after
  the first run TMPDIR is at baseline and the sweep is O(dir) fast.
- Purpose: (1) one-time recovery of already-polluted TMPDIRs; (2)
  backstop for killed workers (which skip `onTestFinished` by
  construction).

### A3. /tmp de-hardcode

Covered in A1's exception: `"/tmp"` → `tmpdir()`, `imp-builtin-visual-`
→ `ink-builtin-visual-`. Effect: single jurisdiction (TMPDIR) for all
fixture bytes; /tmp stops growing (735 dirs already manually removed).

## 3. Track B — zero-imp new bytes

### 3.1 Fixture prefixes

All 295 `imp-` mkdtemp sites + 34 non-mktemp writers rename to `ink-…`
in the same pass as A1 (same files, same edit window). The mkTempDir
prefix assert makes regression structurally impossible.

### 3.2 `IMP_LEASE_*` → `INK_LEASE_*`

Rename the two IPC markers, the settings-setup.ts:21 whitelist arm AND
its :15 comment in lockstep (n-2). Risk (review checkpoint): a missed consumer makes lease
multiprocess tests silently slower (env filtered as unknown config) —
mitigated by a grep gate in CI-less verification (§7) and by tests that
assert lease worker env passthrough.

### 3.3 Design-doc amendment

`docs/design/ink-rename-design.md` §11.5 survivor list gets an amendment
section: cosmetic fixture names moved from survivors to renamed; records
the 0-physical-object data reality (§1.3); references this batch. Any
cross-referenced doc describing the legacy read arm as current (sa-06/
sa-07) gets a one-line pointer noting Track C's status (n-4). This is
the document's own sanctioned path ("owner-approved follow-up amendment
changing only what new code writes; historical bytes never rewritten").

## 4. Track C — `impVersion` read arm removal (owner decision 2026-10-09: option 1)

Earlier drafts justified removal by orphaned unreachable records. That
rationale was REFUTED (§1.3): the records are reachable through live
parents. Fresh liveness data closes the question:

- The 12 `impVersion` records hang off exactly 3 parents
  (`0a76cdd5`/`13fc2fa3`/`9e7ba78e`), which FINISHED their work 56–77h
  ago (last writes 10-06 13:38 / 10-07 10:26 / 10-06 17:42; each ends on
  a message/compaction event, not a kill; deliverables — the rename
  batch b1deda4 etc. — are merged).
- The 4th parent (`a2b206ba`, this batch's own session) is live but its
  12 children are ink-era (`inkVersion`) — read-arm-irrelevant.

**Chosen: remove the arm + delete the 3 finished parent sessions and
their 12 imp-era children** (one-time script, §7.8; not Track D's
mechanism). Session bytes deleted: 3 parent jsonl + 12 child jsonl +
matching .lease sidecars. The transcripts' conclusions live on in
git/docs.

Behavior after removal: `inkVersion` required (absent → `invalid`); any
record carrying an `impVersion` key → `invalid`. The blacklist is
EXPLICIT (special-cased key), NOT the readers-ignore convention — which
would leave dual-key-equal records valid (review m-5).

Test changes: the whole version-drift block at ink-rename.test.ts
:370-403 flips (not just :376) — every legacy record that parsed ok now
rejects as invalid; child-launch.test.ts legacy-arm fixtures flip the
same way (any `impVersion`-bearing record → invalid).

Retained read arms (unchanged, NOT in this batch's scope to remove):
`worktree.ts:383` `imp-worktree-*` recognition (tests exercise it; 0
physical objects but zero harm; removal is a separate decision) — see
§5 survivors.

## 5. Survivor list after this batch (the complete imp-bytes census)

| Survivor | Kind | Reason |
|---|---|---|
| `worktree.ts:383` `imp-worktree-*` read arm | production read | Recognizing historical dirs; tests cover it; removal is a separate decision with its own evidence bar |
| `ink-rename.test.ts:468` `imp-worktree-historical` | test INPUT | Forges old-named disk objects to prove the read arm recognizes them — renaming defeats the test's purpose |
| repl-commands `imp-worktree-task-*` (:82, :703) | test INPUT | Same (also exercises the "main checkout named imp-* is never a handback" edge) |
| `.imp-machine-id` seeded fixtures | test INPUT | Prove the new binary never adopts the legacy file |
| release-guards `imp-agent` samples | test INPUT | Prove the guard REJECTS the legacy package identity |
| historical session jsonl bytes (7 prose files mentioning impVersion) | data | Conversation prose, uncontrolled by design; the 12 structured imp-era records are DELETED by Track C's §7.8 script, not survived |
| ink-rename-design.md §11.5 text | docs | Historical record of the rename decision + this batch's amendment |
| `IMP_MODEL` / `IMP_HEALTH_TOOL_OPEN_MS` / `IMP_AUTH_PATH` etc. env-var TEST INPUTS | test INPUT | Prove obsolete config is ignored/cleared (settings-setup.ts env scrub); they are inputs naming the LEGACY env, not artifacts this repo writes |
| child-launch-validation.test.ts:389 `imp-wt-` | test INPUT | Forges legacy-named child fixture |
| `/nonexistent-imp-auth.json` literals | test INPUT | Nonexistent-path sentinel |
| (removed — renamed in this batch) | — | Round-3 MINOR-C: verified no assertion on the literal; definitively renamed to `ink-auth-test-*`, not a survivor |
| package-smoke.mjs:396 `.bin/imp` absence check | test INPUT (anti-regression) | Asserts the OLD executable alias is NOT installed — renaming defeats the purpose (followup C4) |
| fixture git identities | renamed | `t@imp.dev`/`"imp test"` (15 sites) → `t@ink.invalid`/`"ink test"` (followup C4; no assertion referenced the imp forms) |

Everything else this repo writes is `ink-` after this batch (codex-auth's
disk-written sentinel is renamed, not exempted). The §7.3 gate's allowlist
is exactly the table above — additions require a design amendment.

## 6. Track D — orphan child sweep

New capability (suggested `/sessions prune`, interactive confirm of the
count first; NOT automatic on startup — deletion-like operations get
explicit user control, matching the project's interaction style):

- Scan `~/.ink/sessions/*/children/*.jsonl(+.lease)` — children/ nests
  per-cwd session dirs (manager.ts:13-17, 68); parent lookup crosses
  `*/*.jsonl` (round-2 NIT).
- A child is orphaned iff NO parent file's **header.id** (first-line
  session event `id`) equals its `launch.parentSessionId`. NEVER match by
  filename: session filename uuids are independent randomUUID() calls
  (manager.ts:47-48, 68-69) and never equal header ids — the same trap
  this design's own draft fell into (review M-2; it would have classified
  every child as an orphan).
- Delete orphan jsonl + sidecar `.lease` entry. Liveness exemption reuses
  child-lease.ts's own semantics verbatim (`isAlive(pid)` + its freshness
  rule) — a live child mid-run must never be deleted.
- Current data (review M-3, verified): **0 orphans exist today**. The
  feature's value is future-proofing against external/manual parent
  deletion — the mechanism that would produce orphans like the earlier
  miscount alleged. Track C's §7.8 script (deleting 3 parents) MUST
  delete their children in the same operation, else it manufactures the
  first real orphans.

Design constraint recorded for the future: any session-deletion feature
MUST cascade children/ from its first version.

Out of scope: no general retention/GC policy (none exists today; this
batch adds none).

## 7. Verification

1. Full suite green (`npx vitest run`) — 143 files / 3040+ tests.
2. **Leak gate**: before/after TMPDIR snapshot — a full-suite run adds 0
   entries that OUTLIVE the 24h sweep (fixture dirs are removed
   per-test; visual snapshots carry a 24h TTL; ink-output logs are swept
   at 24h via the inventory's manual adds). Within-24h transient entries:
   6 visual snapshots + 2 clipboard captures per run, all
   designed-retention or sweep-covered.
3. **imp gate**: `git grep -nE "[\"\`']\.?imp-|IMP_" -- test/ src/
   scripts/` — the quote-class includes backticks (round-2 MAJOR-1; the
   draft's `'"imp-'` regex was blind to template-literal writers) —
   matches ONLY the enumerated §5 survivor sites; the gate script
   carries the site list verbatim; any new match fails. The inventory is
   authoritative via committed `fixture-prefixes.ts`.
4. biome, `tsc` ×2, build — 0.
5. Track D: unit test with seeded orphan + alive-lease child; prune
   removes only the orphan.
6. §A2 sweep test: seed fake old-mtime dirs with inventory prefixes +
   decoy prefixes (foreign `imp-policy-*` must SURVIVE — §1.2 rule) +
   fresh mtime inventory dir (must survive).
7. Reviewer-process note (no code): subagent review prompts must carry
   per-command timeouts and forbid unbounded directory listing — recorded
   in the readonly-parallel review log; this batch's own review prompts
   follow it.
8. Track C deletion script (one-time, reviewed in this batch, executed
   post-merge): deletes exactly the enumerated files — 3 parents
   (`0a76cdd5-f943-42df-84ac-9e20836b98d2`,
   `13fc2fa3-4684-44bb-82bd-5f69c9fe41b5`,
   `9e7ba78e-c604-4715-b9bc-f465a8c41bfd`) by header.id, their 12
   imp-era children by parentSessionId link, and matching .lease
   sidecars. Dry-run prints the file list; refuses to run if any target
   was modified within 48h (liveness belt).

## 8. Sequencing

1. This design → independent adversarial review (fresh context, read-only).
2. Implement A1+B (§3.1/3.2 renames in the same pass over ~80 files) →
   A2 → A3 → C → D.
3. Code review round → fold → full gate → merge `--no-ff`.
4. Post-merge: sweep effectiveness watch — next day's first full run
   should clean any stragglers from killed-worker scenarios.

## 9. Risks

| Risk | Mitigation |
|---|---|
| A1's beforeEach migration breaks module-scope consumers (3 files) | Each already has beforeEach; verified §2 (m-4). |
| onTestFinished registered from beforeEach misbehaves | Minimal probe test in this batch (n-3): beforeEach-registered cleanup fires per-test; pattern already used in loop-concurrency.test.ts |
| A2 deletes a foreign tool's dir (name collision with our prefixes) | Prefix list = repo inventory only; accepted residual: a REINSTALLED old imp binary's >24h dirs get swept (owner sign-off §1.2); decoy test §7.6 |
| A2 sweep races across workers/processes | Single-sweeper guard (main worker only); 24h threshold makes fresh-dir deletion impossible; lease subprocesses skip |
| §3.2 (IMP_LEASE_* rename) misses a consumer → silent slow lease tests | grep gate §7.3 + env passthrough test |
| C flips behavior some hidden consumer relies on | Census §1.3: 12 records on 3 owner-approved-deleted finished sessions; grep gate; dry-run script refuses on fresh mtime |
| D deletes a live child | Active-lease exemption + interactive confirm + unit test |
| Massive edit window (~80 files) conflicts with in-flight branches | No other in-flight branches exist today; single-batch policy per AGENTS.md |
