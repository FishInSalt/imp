# Ink first-publication design: `ink-agent@0.2.0`

Status: **draft — pending fresh-context adversarial review closure.** No external
action (registry write, tag push, account or repository-variable change,
publisher binding) is authorized by this document until the review closes and
each step below receives its own explicit owner approval.

- Branch: `design/ink-first-publication`
- Contract references: [`RELEASING.md`](../RELEASING.md),
  [`docs/ink-rename-design.md`](ink-rename-design.md) §6.1/§6.2/§8.6,
  [`.github/workflows/release.yml`](../.github/workflows/release.yml).
- [`docs/publishing-design.md`](publishing-design.md) is the historical imp
  design and is not the current procedure; this document replaces its
  bootstrap section for Ink and must not be produced by mechanically renaming
  its commands.

## 0. Goal and non-goals

**Goal.** Publish `ink-agent@0.2.0` publicly to npm exactly once, from a
reviewed commit, uploading exactly the reviewed artifact, with the
package/lock/app/tag identity enforced by the shipped guards, and then hand
ordinary releases to the existing tag-push trusted-publishing path.

**Non-goals (each needs its own approval and is out of scope here).**

- Renaming the GitHub repository `FishInSalt/imp` or updating remotes.
- Deprecating, unpublishing or otherwise touching `imp-agent@0.1.0`.
- Changing the npm account, its 2FA method, or introducing any token.
- Global installation of Ink on any machine.
- Trademark clearance of the name (a separate legal question; registry
  absence is neither reservation nor clearance).

## 1. Preconditions and owner inputs

1. **Owner confirms publishability of `ink-agent`.** As of this writing the
   name returns `E404` on the registry and is therefore not held by another
   account; recheck immediately before publishing (see §11 race). Name
   availability is not a reservation and does not address trademark.
2. **Owner npm account** with publish rights and 2FA (npm's current scheme is
   security-key/passkey WebAuthn; there is no 6-digit authenticator option,
   and a non-interactive agent channel cannot complete WebAuthn). The manual
   first publish in §7 is therefore performed by the owner in their own
   terminal.
3. **Repository state**: `main == origin/main`, working tree clean, CI green
   at the reviewed commit `R` (see §3), no stale `dist/`. (Equality is the
   precondition for the freeze; at tag time only `R`'s ancestry on
   `origin/main` is required — see §7 step 7.)
4. **Legacy capability already retired**: the repository variable
   `NPM_PUBLISH_ENABLED` has been deleted (verified during design
   preparation), and the old `imp-agent` trusted-publisher binding is assessed
   for retirement by the owner on npmjs.com. No historical ref is dispatched
   or rerun before these hold.

## 2. Identity contract

The release identity is fixed as follows. Note precisely which parts are
enforced by code and which are owner/process decisions:

| Artifact | Required value | Enforced by |
| --- | --- | --- |
| `package.json` `name` | `ink-agent` (never `imp-agent`, never plain `ink`) | `release-guards.mjs::assertIdentity` |
| `package.json` `version` | `0.2.0` | `assertIdentity` only rejects `0.1.0`/non-semver; the exact value is a **release decision**, asserted again in §3 |
| `package-lock.json` `name`/`version` (top level) | `ink-agent` / `0.2.0` | `assertIdentity` |
| `package-lock.json` `packages[""].name`/`.version` | `ink-agent` / `0.2.0` | `assertIdentity` |
| `src/format.ts` `VERSION` | `0.2.0` | `assertIdentity` (must equal `package.json.version`) |
| `bin` (both `pkg.bin` and `packages[""].bin`) | exactly one: `ink` → `bin/ink.js` | `assertIdentity` |
| release tag | `v0.2.0`, annotated | tag == version checked by `releaseDecision` (`plan`); ancestry by `release.yml`'s "ref must be on main" step |

`assertIdentity` rejects `imp-agent`, plain `ink`, `0.1.0`, and any bin shape
other than the single `ink` launcher, and requires pkg/lock/app agreement. It
does **not** pin the exact version `0.2.0` and does not inspect the tag; the
`plan` mode compares the tag to the version, and `release.yml` requires the
tagged commit to be an ancestor of `origin/main`.

Because the exact `0.2.0` is not a guard invariant, §3 adds an explicit
exact-version assertion to the freeze step.

The CHANGELOG is finalized as part of release preparation (§7 step R): the
`## [Unreleased]` section becomes `## [0.2.0] - <release date>`. That is a
content change and therefore its own reviewed batch, not part of this design.

## 3. Artifact freeze and offline verification

Perform this in an **owned checkout** at `R` — a checkout whose dependency
tree it owns, never a shared `node_modules` symlink (per `RELEASING.md`). If
the tree is not already owned/correct, run `npm ci` there first.

```bash
test "$(node -p 'require("./package.json").version')" = "0.2.0"   # exact-version assertion
npm run typecheck
npm run lint
npm run build
npm test
node scripts/release-guards.mjs identity
node scripts/release-guards.mjs npm-version "$(npm --version)"
node scripts/package-smoke.mjs --cache-source "$HOME/.npm"
git diff --check
```

`package-smoke.mjs` takes the single `npm pack --json` filename and checks
packed metadata, every tar path and regular-file mode against the source
allowlist, all header checksums/octal fields, file bodies and padding, two zero
end blocks and a zero-only remainder; it rejects any old launcher, runtime
roots, `.env`, credentials, source, tests, docs or unexpected artifacts; it
installs into a private temporary prefix with temporary HOME/cache, offline
and without install scripts; and asserts `ink --help` and the exact `Ink 0.2.0`
version, plus single-bin `npm exec` inference from a neutral cwd. It prints its
scratch paths and the artifact path.

**Freeze step:**

1. Copy the produced `.tgz` out of the smoke scratch directory
   (`/tmp/ink-package-smoke-*`, whose cleanup is an operator decision) to a
   stable path that survives until publication.
2. Record the artifact filename and its SHA-256 (`shasum -a 256 <artifact>`),
   plus the toolchain versions used (`node --version`, `npm --version`, and
   the `typescript` version from the lockfile).
3. This frozen file is the *only* thing published in §7 step 4; §8 compares the
   registry artifact against its SHA-256.
4. Immediately before publishing (§7 step 4), re-run
   `shasum -a 256 "<stable path>/<artifact>.tgz"` and confirm it still equals
   the recorded value.

Local checks on a non-CI Node version do not substitute for CI. `ci.yml` runs
the exact supported floor (Node 22.19.0) and current major (24);
`release.yml`'s gate runs on Node 24 only, so the release gate itself does not
re-exercise the floor.

## 4. First-publication authentication and provenance (honest statement)

The first publish is manual, because npm's trusted-publisher form lives on the
package settings page, which only exists after the package exists (npm's
initial-publish constraint; see npm/cli issue #8544).

- **Method:** the owner publishes **the frozen artifact** with
  `npm publish --ignore-scripts "<stable path>/<artifact>.tgz"`. Publishing a
  tarball path uploads those exact bytes and does not run `prepare`, so the
  uploaded artifact is the frozen one. `--ignore-scripts` matches
  `release.yml`'s real-publish step and is belt-and-suspenders here.
- **Do not** run a bare `npm publish` from the source tree: `prepare` would
  rebuild `dist` and repack, uploading bytes that differ from the frozen
  artifact.
- **Provenance honesty:** a manual publish is **not** a tag-push
  trusted-publishing event and **cannot** carry npm provenance (provenance
  requires a supported CI provider's OIDC environment). `ink-agent@0.2.0` will
  therefore be published **without** a provenance attestation; its package
  page will show no provenance badge. This is a known, accepted property of
  the bootstrap, not a defect. Provenance begins with the first OIDC tag-push
  publish (a later version, §7 step L).
- **No local `--provenance`:** it cannot be produced outside a supported CI
  OIDC environment; do not attempt it.
- **No token:** no long-lived npm token and no repository secret is introduced
  or stored.
- Public access: `ink-agent` is unscoped and therefore public by default;
  `--access public` is optional and, for an unscoped package, a no-op. The
  consumer install path is `npm install -g ink-agent` / `npx ink-agent`;
  this procedure does not perform any global install.

## 5. Trusted-publisher binding

After the package exists (§7 step 4), the owner binds its trusted publisher on
the npmjs.com package settings page:

- Provider: **GitHub Actions**
- Repository: **`FishInSalt/imp`**
- Workflow filename: **`release.yml`** (the form takes the file name, not the
  `.github/workflows/` path)
- Environment: **left blank**, because the `publish` job in `release.yml`
  declares no `environment:`. If a GitHub Environment is ever added to that
  job, the binding and the workflow must be changed together so they match.

The binding is what makes the ordinary OIDC path work; it must exist and be
correct before the new repository variables are enabled (§6).

## 6. Repository variables

Set only after the binding in §5 is verified, and — to avoid arming the
already-pushed `v0.2.0` tag (see the hard rule below and §11) — as late as possible:
immediately before the next version's tag push (§7 step L), not during this
bootstrap.

- `INK_NPM_PUBLISH_ENABLED=true`
- `INK_NPM_PACKAGE=ink-agent`

While `INK_NPM_PUBLISH_ENABLED` is anything other than `true`, the revised
workflow publishes nothing; it is also the emergency brake (set it back to
anything else to stop publication without editing code). The legacy
`NPM_PUBLISH_ENABLED` variable is ignored by the revised workflow and has been
deleted.

**Hard rule:** once these variables are enabled, the `v0.2.0` tag event must
never be re-run or dispatched — `releaseDecision` would then return `publish`
for `refs/tags/v0.2.0`, attempting a real OIDC publish of an already-published
version. This is why enabling is deferred to step L.

## 7. Ordered bootstrap procedure

Each lettered step is a separate external action requiring its own explicit
owner approval. Do not batch them.

1. **D — design review.** This document passes a fresh-context adversarial
   review; findings are folded; merged to `main` with `--no-ff`.
2. **R — release preparation.** On a dedicated branch: finalize the CHANGELOG
   (`## [Unreleased]` → `## [0.2.0] - <date>`); confirm `package.json`,
   lockfile and `src/format.ts` all read `0.2.0`; run the full gates. Obtain an
   **independent code review of `R`** (§10 gate 2), then merge `--no-ff`. The
   resulting `main` HEAD is the reviewed commit `R`.
3. **Freeze.** At `R`, in an owned checkout, run §3; copy the artifact to a
   stable path and record filename, SHA-256 and toolchain. Then obtain an
   **independent review of the frozen tarball** (§10 gate 3) before publishing.
4. **First publish (owner).** Re-verify the stable-path artifact's SHA-256
   against the §3 record, then publish the frozen tarball:
   `npm publish --ignore-scripts "<stable path>/<artifact>.tgz"`. Then verify
   registry visibility with `npm view ink-agent@0.2.0 version dist.integrity`
   (retry briefly; a fresh publish can lag — `release.yml` itself retries up to
   6×10s).
5. **Post-publish verification.** Perform §8.
6. **Bind publisher.** Perform §5. (Package now exists; the settings page is
   available.)
7. **Tag.** Create and push the annotated tag at `R`:
   `git tag -a v0.2.0 -m "ink-agent v0.2.0" R && git push origin v0.2.0`.
   Pushing after publication means an aborted publish leaves no orphan tag.
   The release workflow runs its gate; because the new variables are unset, the
   publish step is skipped and must show the explicit publication-skipped
   warning and summary. Verify that visible skip. If this tag push fails, retry
   it (content is unchanged); never move or reuse the tag. Only ancestry on
   `origin/main` is required at tag time — `main` may have advanced past `R`
   between freeze and tagging.

   If the publish (step 4) succeeds but verification (5) or binding (6) fails,
   **still push the tag (7)**: the tag records the already-published commit, and
   a verification/binding failure does not invalidate the published bytes.
   Before any retry of a failed publish, run `npm view ink-agent@0.2.0 version`
   to determine whether the version already exists; never re-publish a version
   that exists.
8. **GitHub Release page (separate approval).** Publish the `v0.2.0` release
   with notes taken from the CHANGELOG's `0.2.0` section (single source of
   truth; do not use auto-generated notes).
9. **L — first OIDC publish (later, separate approval).** Immediately before
   the *next* version's tag push, enable the variables (§6), then publish that
   version by tag push. This is the first release that runs the OIDC path
   end-to-end with provenance; it is also the first real verification of the
   binding. Until then the tag-push path is validated only to the point of the
   gate and the skip notice.

## 8. Post-publish verification

- `npm view ink-agent@0.2.0 version dist.tarball dist.integrity` succeeds and
  reports `0.2.0`.
- Download `dist.tarball` and confirm its SHA-256 equals the frozen §3 value
  (the published bytes are the reviewed bytes).
- The package page renders README, points at `FishInSalt/imp`, and shows the
  intended public access. No provenance badge is expected on `0.2.0` (§4).
- Installing `ink-agent@0.2.0` in a throwaway prefix yields the single `ink`
  command and prints `Ink 0.2.0` (smoke already covers this offline).

## 9. Rollback and withdrawal

- Prefer a **patch release** for fixes.
- `npm deprecate` for a defective published version, with replacement guidance.
- `npm unpublish` only within the 24-hour window and only with explicit
  approval; the version number is permanently voided and it is disruptive to
  downstream consumers.
- A manual publish can fail *after* the registry has created the version, so
  before any retry run `npm view ink-agent@0.2.0 version` and never re-publish
  an existing version.
- If the publish aborts before step 7 and `0.2.0` is not on the registry,
  nothing has been published; stop and re-plan.
- If `0.2.0` is public, still complete step 7 (push the tag) even if
  verification or binding failed — the tag must record the published commit.
- Never reuse a tag or overwrite a package version.

## 10. Approval gates

The following are each separately approved and are not implied by merging this
design:

This list is unordered for approval purposes; §7 governs the actual sequence.

1. merge the reviewed release-preparation batch (`R`);
2. independent code review of `R`;
3. independent review of the frozen tarball (after freeze, before publish);
4. perform the manual first publish of the frozen tarball;
5. bind the trusted publisher on npmjs.com;
6. push tag `v0.2.0`;
7. create the GitHub Release page;
8. enable `INK_NPM_PUBLISH_ENABLED` / `INK_NPM_PACKAGE` (deferred to step L);
9. any repository rename, remote change, or first OIDC publish;
10. any `imp-agent` deprecation/unpublication.

## 11. Risks and open questions

- **Name race.** `ink-agent` could be registered by someone else between now
  and the manual publish. Re-check `npm view ink-agent` immediately before
  publishing; if taken, stop and redesign the package name (this becomes a
  rename-design amendment, not an ad-hoc change).
- **Armed tag after enabling gates.** Once the variables are enabled, a re-run
  of the `v0.2.0` tag event could attempt a real publish. Mitigated by pushing
  the tag after publication and by deferring variable enablement to step L,
  plus the §6 hard rule.
- **No provenance on `0.2.0`** (§4). Accepted; documented so downstream is not
  misled.
- **Environment matching.** The repository currently has no GitHub
  Environments. If one is added to the `publish` job later, update the npm
  binding in the same, separately approved change.
- **Repository rename ordering.** Any future GitHub rename must be followed by
  re-verifying the trusted-publisher repository field (§5), since the binding
  names the repository explicitly.
- **`npm trust` / staged publishing.** npm has introduced a `npm trust` CLI and
  staged publishing; before executing §7, check whether a not-yet-published
  package can be pre-bound to a trusted publisher. If so, that removes the
  manual-provenance gap — but adopting it is itself a design change requiring
  its own review, and is not assumed here.
- **Dependency-link/source.** This design performs no `npm ci` against a shared
  `node_modules` symlink and no global npm upgrade; the release workflow's
  runner-provided npm must satisfy `>=11.5.1` (already guarded patch-aware).

## 12. Acceptance matrix

| Area | Required observable |
| --- | --- |
| Identity | `release-guards.mjs identity` passes; explicit `0.2.0` assertion passes; tag `v0.2.0` == package version and is an ancestor of `origin/main` |
| Artifact | `package-smoke.mjs` passes at `R`; frozen tarball SHA-256 recorded; uploaded tarball path (not a source-tree repack) used for publish |
| Independent review | `R` code-reviewed before merge; frozen tarball independently reviewed after freeze and before publish |
| Gate visibility | Tag push with variables unset is green and shows the publication-skipped warning + summary |
| First publish | `ink-agent@0.2.0` visible; downloaded SHA-256 == frozen; no provenance badge (expected) |
| Binding | npm trusted publisher = GitHub Actions / `FishInSalt/imp` / `release.yml` / no environment |
| Variables | `INK_NPM_PUBLISH_ENABLED=true`, `INK_NPM_PACKAGE=ink-agent`, set only after binding and deferred to step L; `v0.2.0` tag event never re-run afterward |
| Legacy | `NPM_PUBLISH_ENABLED` absent; `imp-agent@0.1.0` untouched; no historical-ref dispatch |
| Ordinary path | A later version's tag push publishes with provenance (verified at that release) |

## 13. Review record

- r1 fresh-context adversarial review (child session `908262bb-3aec-4073-bbb8-02362bcbb444`),
  verdict **NEEDS-FIXES**: B×2, S×4, N×7. All findings folded in this revision:
  B1/B2 publish the frozen tarball via a tarball path with `--ignore-scripts`
  and state the owned-checkout/`npm ci`/`build` prerequisites; S1 defers
  variable enablement to step L and adds the no-re-run hard rule; S2 moves the
  tag after publication and adds abort handling; S3 adds an independent
  review gate for `R` and the artifact; S4 corrects the enforcement
  attribution and adds an exact-version assertion; N1–N7 addressed (dates,
  citation, lock fields, `--access`, provenance wording, specific-version
  check, CI floor note).
- r2 re-review (same child session): NEEDS-FIXES. B1/B2 closed, S1/S2/S4
  closed, N1–N7 closed; found S3 still open (artifact review sequenced before
  the artifact existed) and NEW-1..NEW-7. Folded in this revision: S3 splits
  into a code review of `R` before merge and an independent review of the
  frozen tarball after freeze; NEW-1 adds post-publish/tag handling and a
  never-re-publish-existing-version rule; NEW-2 reorders §10; NEW-3 fixes the
  §6 cross-reference; NEW-4 adds a propagation-retry note; NEW-5 re-verifies
  the frozen SHA immediately before publish; NEW-6 labels the `-g` line as
  downstream usage; NEW-7 clarifies ancestry at tag time.
- r3 re-review: pending.
