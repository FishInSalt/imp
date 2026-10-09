# Test Fixture Hygiene & Zero-imp New Artifacts — Design

Status: draft (review round 1 pending)
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
| `mkdtemp*("imp-…")` | 295 calls | 76 files |
| `mkdtemp*("ink-…")` | 12 calls | — |
| non-mkdtemp `imp-` dir writers (`freshDir("imp-lease-…")` etc.) | 34 | 4 files (child-lease*.test.ts, release-guards.test.ts, repl-commands.test.ts payload cases) |
| `IMP_LEASE_WORKER` / `IMP_LEASE_SCRIPT` env IPC markers | ~6 sites | 5 files (settings-setup.ts whitelist :21, lease-worker helpers, child-lease tests) |
| `/tmp` hardcoded snapshot writer | 2 sites (:331 sentinel-only, :396 real) | builtin-visual-verification.test.ts |
| `impVersion` write arm | 0 (already ink-only; builder writes `inkVersion`) | — |

Distinct tmpdir fixture prefixes in test code: **225** (enum used verbatim
for §A2's sweep list).

### 1.2 External contamination (out of scope, documented)

`imp-policy`, `imp-auth`, `imp-settings`, `imp-tui`, `imp-home`,
`imp-catalog` bulk prefixes were **never present in this repo's source**
(`git grep` at any revision: 0 hits; `git log -S`: 0 commits). They come
from the previously globally-installed imp binary / other projects running
against the same TMPDIR. Consequence: §A2 must NEVER sweep a blanket
`imp-*` — only the exact 225-prefix inventory. This is a hard design rule.

### 1.3 Historical objects backing the rename survivors

- `imp/` branches: 0. `imp-worktree-*` dirs: 0 (worktree list = main only).
- Structured `impVersion` child-launch records: 12 files, all 10-06, **all
  orphaned** (their 4 parent sessions were deleted externally — ink has no
  session-deletion feature; nothing in `src/` deletes session jsonl).
  Last write anywhere: 10-06 19:24 (3 days idle).
- Chat-text `impVersion` mentions: 7 files (prose; uncontrolled by design —
  the owner's rule governs code-written structured bytes, not conversation
  transcripts).

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
  them (the 95% case). For the ~5 module-level / `describe`-scope cases
  (auth-store.test.ts:22, trust.test.ts:21, child-model-metadata.test.ts:16,
  mcp-config.test.ts:21, …), the call sites move into their existing
  `beforeEach` (verified: each already has one; where missing, add it).
- Idempotent-safe: double registration is harmless (rmSync force).

Replacement scope: all 295+12 mkdtemp call sites + the 34 non-mkdtemp
writers get the same treatment (freshDir-family helpers route through
mkTempDir internally).

**Explicit exception — `builtin-visual-verification.test.ts`**: keeps
intentional post-run snapshots for human inspection (its designed purpose:
`VISUAL_ARTIFACT <path>` is printed for manual review). It moves to
`tmpdir()` + `ink-` prefix (:396) but does NOT register immediate cleanup;
its lifecycle is §A2's 24h sweep. :331 stays as-is (sentinel path, setup
fails before any disk write — nothing to move).

### A2. Stale-root sweep in settings-setup.ts

At setup (once per worker, before tests run), best-effort synchronous:

- Enumerate `tmpdir()` depth-1 entries.
- Delete entries whose name starts with one of the **225 inventory
  prefixes** AND whose mtime is older than 24h.
- Guard rails: `try/catch` per entry (ENOENT/EBUSY → skip silently);
  bounded work — if the enumeration itself finds > 50k entries, sweep
  anyway but log nothing and never fail the run; total sweep time capped
  by the fact that it only touches our prefixes.
- Never follows symlinks (`rmSync` without follow; entries are dirs/files
  created by our own fixtures).
- Purpose hierarchy: (1) recover TMPDIRs already polluted by pre-fix runs;
  (2) backstop workers killed mid-run (killed workers skip `afterAll`/
  `onTestFinished` by construction — the 10-08 22:00 massacre left 393
  `ink-tests-*` this way).

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

Rename the two IPC markers and the settings-setup.ts:21 whitelist arm in
lockstep. Risk (review checkpoint): a missed consumer makes lease
multiprocess tests silently slower (env filtered as unknown config) —
mitigated by a grep gate in CI-less verification (§7) and by tests that
assert lease worker env passthrough.

### 3.3 Design-doc amendment

`docs/design/ink-rename-design.md` §11.5 survivor list gets an amendment
section: cosmetic fixture names moved from survivors to renamed; records
the 0-physical-object data reality (§1.3); references this batch. This is
the document's own sanctioned path ("owner-approved follow-up amendment
changing only what new code writes; historical bytes never rewritten").

## 4. Track C — `impVersion` read arm removal

`src/core/child-launch.ts:211–232`: delete the legacy arm
(`hasLegacy`, `impVersion` reads, dual-key equality check, the
`delete launch.impVersion` consume-and-drop).

New behavior: `inkVersion` is required (absent → `invalid`), unknown
extra keys still tolerated by readers-ignore convention — but a record
carrying `impVersion` without `inkVersion` now fails as `invalid`,
exactly like any other schema violation.

Rationale (verified): the only consumers of the arm were 12 orphaned
child records whose parents no longer exist (resume resolves children
through the parent store — structurally unreachable). 0 live objects
depend on the arm.

Test changes:
- `test/ink-rename.test.ts:376` — flip from "historical record parses
  ok" to "legacy-only record is rejected as invalid".
- `test/child-launch.test.ts` — drop legacy-arm fixtures; keep
  dual-key-equal acceptance? **No**: dual-key is deleted behavior too;
  its test flips to rejected (both keys present but unequal AND equal —
  both now invalid because `inkVersion`-only is the sole valid form…
  equal-dual is degenerate; simplest honest contract: any record with
  `impVersion` key → invalid).

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
| historical session jsonl bytes (12 orphans + 7 prose) | data | Never rewritten by policy; orphans cleaned by Track D, prose uncontrolled |
| ink-rename-design.md §11.5 text | docs | Historical record of the rename decision + this batch's amendment |

Everything else this repo writes is `ink-` after this batch. New-file
grep gate (§7) enforces it.

## 6. Track D — orphan child sweep

New capability (suggested `/sessions prune`, interactive confirm of the
count first; NOT automatic on startup — deletion-like operations get
explicit user control, matching the project's interaction style):

- Scan `<sessionsDir>/children/*.jsonl(+.lease)`.
- A child is orphaned iff no parent file in the parent dir matches its
  `launch.parentSessionId` (filename uuid match — same resolution
  `findChildByLaunch` already uses).
- Delete orphan jsonl + sidecar `.lease` (empty dirs left in place are
  fine; no rmdir cascade).
- Belt-and-braces: an ACTIVE lease (nonempty `.lease` dir, mtime within
  freshness window per child-lease semantics) exempts the child from
  pruning even if orphaned — a live child mid-run must never be deleted.
  (Current reality: all 21 orphans' lease files are empty.)

Design constraint recorded for the future: any session-deletion feature
MUST cascade children/ from its first version.

Out of scope: no general retention/GC policy (none exists today; this
batch adds none).

## 7. Verification

1. Full suite green (`npx vitest run`) — 143 files / 3040+ tests.
2. **Leak gate**: before/after TMPDIR snapshot — full-suite run adds 0
   new entries matching the 225-prefix inventory (visual snapshots now
   land in TMPDIR with 24h TTL instead of accumulating).
3. **imp gate**: `git grep -nE '"imp-|IMP_' -- test/ src/ scripts/`
   returns only §5 survivors; `git grep -n '"imp-' -- test/` = 0 outside
   the exception files (enumerate them in the gate script).
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

## 8. Sequencing

1. This design → independent adversarial review (fresh context, read-only).
2. Implement A1+B1+B2 (one pass over ~80 files) → A2 → A3 → C → D.
3. Code review round → fold → full gate → merge `--no-ff`.
4. Post-merge: sweep effectiveness watch — next day's first full run
   should clean any stragglers from killed-worker scenarios.

## 9. Risks

| Risk | Mitigation |
|---|---|
| A1's beforeEach migration breaks module-scope consumers (5 files) | Each already has beforeEach; verified §2. |
| A2 deletes a foreign tool's dir (name collision with our prefixes) | 225-prefix exact match only; no blanket `imp-*`; decoy test §7.6 |
| B3 misses a consumer → silent slow lease tests | grep gate §7.3 + env passthrough test |
| C flips behavior some hidden consumer relies on | Census §1.3: 0 reachable objects; grep gate |
| D deletes a live child | Active-lease exemption + interactive confirm + unit test |
| Massive edit window (~80 files) conflicts with in-flight branches | No other in-flight branches exist today; single-batch policy per AGENTS.md |
