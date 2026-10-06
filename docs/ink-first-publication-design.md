# Ink first-publication design: `ink-agent@0.2.0`

Status: **draft — pending fresh-context adversarial review.** No external action
(registry write, tag push, account or repository-variable change, publisher
binding) is authorized by this document until the review closes and each step
below receives its own explicit owner approval.

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
reviewed commit, with the package/lock/app/tag identity enforced by the
shipped guards, and then hand ordinary releases to the existing tag-push
trusted-publishing path.

**Non-goals (each needs its own approval and is out of scope here).**

- Renaming the GitHub repository `FishInSalt/imp` or updating remotes.
- Deprecating, unpublishing or otherwise touching `imp-agent@0.1.0`.
- Changing the npm account, its 2FA method, or introducing any token.
- Global installation of Ink on any machine.
- Trademark clearance of the name (a separate legal question; registry
  absence is neither reservation nor clearance).

## 1. Preconditions and owner inputs

1. **Owner confirms publishability of `ink-agent`.** As of 2026-10-06 the
   name returns `E404` on the registry and is therefore not held by another
   account; recheck immediately before publishing (see §11 race). Name
   availability is not a reservation and does not address trademark.
2. **Owner npm account** with publish rights and 2FA (npm's current scheme is
   security-key/passkey WebAuthn; there is no 6-digit authenticator option,
   and a non-interactive agent channel cannot complete WebAuthn). The manual
   first publish in §7 is therefore performed by the owner in their own
   terminal.
3. **Repository state**: `main == origin/main`, working tree clean, CI green
   at the reviewed commit `R` (see §3). No uncommitted changes and no stale
   `dist/` (rebuild before verification).
4. **Legacy capability already retired**: repository variable
   `NPM_PUBLISH_ENABLED` is deleted (done 2026-10-06) and the old
   `imp-agent` trusted-publisher binding is assessed for retirement by the
   owner on npmjs.com. No historical ref is dispatched or rerun before these
   hold.

## 2. Identity contract

The released identity is fixed and already enforced by
`scripts/release-guards.mjs::assertIdentity`:

| Artifact | Required value |
| --- | --- |
| `package.json` `name` | `ink-agent` (never `imp-agent`, never plain `ink`) |
| `package.json` `version` | `0.2.0` |
| `package-lock.json` root `name`/`version` | `ink-agent` / `0.2.0` |
| `src/format.ts` `VERSION` | `0.2.0` |
| `bin` | exactly one entry: `ink` → `bin/ink.js` |
| release tag | `v0.2.0`, annotated, pointing at `R` |

`assertIdentity` rejects `imp-agent`, plain `ink`, the published `0.1.0`, and
any bin shape other than the single `ink` launcher. `release.yml` additionally
rejects a tag whose version does not equal `package.json.version`, and
requires the tagged commit to be an ancestor of `origin/main`.

The CHANGELOG is finalized as part of release preparation (§7 step R): the
`## [Unreleased]` section becomes `## [0.2.0] - <release date>`. This is a
content change and therefore its own reviewed batch, not part of this design.

## 3. Artifact freeze and offline verification

At the reviewed commit `R` (the merge of the release-preparation batch, on
`main`, with CI green), run the offline gates and freeze the artifact:

```bash
npm run typecheck
npm run lint
npm run build
npm test
node scripts/release-guards.mjs identity
node scripts/release-guards.mjs npm-version "$(npm --version)"
node scripts/package-smoke.mjs --cache-source "$HOME/.npm"
git diff --check
```

`package-smoke.mjs` already: takes the single `npm pack --json` filename,
checks packed metadata, every tar path and regular-file mode against the
source allowlist, all header checksums/octal fields, file bodies and padding,
two zero end blocks and a zero-only remainder; rejects any old launcher,
runtime roots, `.env`, credentials, source, tests, docs or unexpected
artifacts; installs into a private temporary prefix with temporary HOME/cache,
offline and without install scripts; and asserts `ink --help` and the exact
`Ink 0.2.0` version, plus single-bin `npm exec` inference from a neutral cwd.
It prints the scratch paths and the artifact path.

**Freeze step:** record the produced tarball's `filename` and its SHA-256
(`shasum -a 256 <artifact>`). The published bytes must be that artifact. The
frozen SHA-256 is the reference for the post-publish comparison in §8.

Local checks on a non-CI Node version do not substitute for the CI runs at the
exact supported floor (Node 22.19.0) and current major (24).

## 4. First-publication authentication and provenance (honest statement)

The first publish is manual, because npm's trusted-publisher form lives on the
package settings page, which only exists after the package exists
(chicken-and-egg; npm community discussion #176761).

- **Method:** the owner runs `npm publish --access public` in their own
  terminal from a clean checkout at `R`, using their 2FA-protected session.
- **Provenance honesty:** a manual publish is **not** a tag-push
  trusted-publishing event and **cannot** carry npm provenance. `ink-agent@0.2.0`
  will therefore be published **without** a provenance attestation, and its
  package page will show no provenance badge. This is a known, accepted
  property of the bootstrap, not a defect. Provenance begins with the first
  OIDC tag-push publish (a later version, §7 step L).
- **No `--provenance` locally:** do not attempt to fake provenance by passing
  `--provenance` outside CI; it cannot be produced without an OIDC identity.
- **No token:** no long-lived npm token and no repository secret is
  introduced or stored.

## 5. Trusted-publisher binding

After the package exists (§7 step 5), the owner binds its trusted publisher on
the npmjs.com package settings page:

- Provider: **GitHub Actions**
- Repository: **`FishInSalt/imp`**
- Workflow filename: **`release.yml`** (the form takes the file name, not the
  `.github/workflows/` path)
- Environment: **left blank**, because the `publish` job in `release.yml`
  declares no `environment:`. If a GitHub Environment is ever added to that
  job, the binding and the workflow must be changed together so they match.

The binding is what makes the ordinary OIDC path verifiable; it must exist and
be correct **before** the new repository variables are enabled.

## 6. Repository variables

Set only after the binding in §5 is verified:

- `INK_NPM_PUBLISH_ENABLED=true`
- `INK_NPM_PACKAGE=ink-agent`

While `INK_NPM_PUBLISH_ENABLED` is anything other than `true`, the revised
workflow publishes nothing; it is also the emergency brake (set it back to
anything else to stop publication without editing code). The legacy
`NPM_PUBLISH_ENABLED` variable is ignored by the revised workflow and has been
deleted.

## 7. Ordered bootstrap procedure

Each lettered step is a separate external action requiring its own explicit
owner approval. Do not batch them.

1. **D — design review.** This document passes a fresh-context adversarial
   review; findings are folded; merged to `main` with `--no-ff`.
2. **R — release preparation.** On a dedicated branch: finalize the CHANGELOG
   (`## [Unreleased]` → `## [0.2.0] - <date>`); confirm `package.json`,
   lockfile and `src/format.ts` all read `0.2.0`; run the full gates. Review,
   merge `--no-ff`. The resulting `main` HEAD is the reviewed commit `R`.
3. **Freeze.** At `R`, run §3 and record the tarball filename and SHA-256.
4. **Tag.** Create and push the annotated tag at `R`:
   `git tag -a v0.2.0 -m "ink-agent v0.2.0" R && git push origin v0.2.0`.
   The release workflow runs its gate; because the new variables are unset, the
   publish step is skipped and must show the explicit publication-skipped
   warning and summary. Verify that visible skip (green-without-publish is an
   accepted but must-be-inspected state).
5. **First publish (owner).** In a clean checkout at `R`:
   `npm publish --access public`. Then verify registry visibility
   (`npm view ink-agent version` → `0.2.0`, allowing for propagation delay).
6. **Bind publisher.** Perform §5.
7. **Enable variables.** Perform §6 only now that the binding is verified.
8. **GitHub Release page (separate approval).** Publish the `v0.2.0` release
   with notes taken from the CHANGELOG's `0.2.0` section (single source of
   truth; do not use auto-generated notes).
9. **L — first OIDC publish (later, separate approval).** The OIDC path can
   only be exercised by an actual subsequent version publish, so the next
   release is the first to run end-to-end with provenance. Until then, the
   tag-push path is validated only to the point of the gate and the skip
   notice.

## 8. Post-publish verification

- `npm view ink-agent@0.2.0 version dist.tarball dist.integrity` succeeds.
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
- Never reuse a tag or overwrite a package version.

## 10. Approval gates

The following are each separately approved and are not implied by merging this
design:

1. merge the reviewed release-preparation batch (`R`);
2. push tag `v0.2.0`;
3. perform the manual first publish;
4. bind the trusted publisher on npmjs.com;
5. enable `INK_NPM_PUBLISH_ENABLED` / `INK_NPM_PACKAGE`;
6. create the GitHub Release page;
7. any repository rename, remote change, or first OIDC publish;
8. any `imp-agent` deprecation/unpublication.

## 11. Risks and open questions

- **Name race.** `ink-agent` could be registered by someone else between now
  and the manual publish. Re-check `npm view ink-agent` immediately before
  publishing; if taken, stop and redesign the package name (this becomes a
  rename-design amendment, not an ad-hoc change).
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
| Identity | `release-guards.mjs identity` passes; tag `v0.2.0` == package version and is an ancestor of `origin/main` |
| Artifact | `package-smoke.mjs` passes at `R`; frozen SHA-256 recorded and matched after publish |
| Gate visibility | Tag push with variables unset is green and shows the publication-skipped warning + summary |
| First publish | `ink-agent@0.2.0` visible; published SHA-256 == frozen; no provenance badge (expected) |
| Binding | npm trusted publisher = GitHub Actions / `FishInSalt/imp` / `release.yml` / no environment |
| Variables | `INK_NPM_PUBLISH_ENABLED=true`, `INK_NPM_PACKAGE=ink-agent`, set only after binding |
| Legacy | `NPM_PUBLISH_ENABLED` absent; `imp-agent@0.1.0` untouched; no historical-ref dispatch |
| Ordinary path | A later version's tag push publishes with provenance (verified at that release) |

## 13. Review record

Pending — to be filled after the fresh-context adversarial review closes. No
implementation begins before this record shows the findings closed.
