# Releasing Ink

Current contract: this file plus [`docs/design/ink-rename-design.md`](docs/design/ink-rename-design.md)
r3 (its repository-name row was superseded by the executed rename — see
[`docs/design/ink-first-publication-design.md`](docs/design/ink-first-publication-design.md) §14).
The selected package/version is **`ink-agent@0.2.2`**, with the sole `ink`
executable. The repository is **`FishInSalt/ink`** (renamed from
`FishInSalt/imp`; old URLs redirect). Package metadata,
lockfile (including its root package), app `VERSION`, and release tag must
agree. Never publish as `imp-agent` or plain `ink`, and never reuse `v0.1.0`.
No publication, tag push, workflow dispatch, account configuration, or global
installation is authorized by these instructions alone.

## Historical capability: the legacy gate is retired

Changing the current workflow does **not** change workflows at historical
refs. The retained `v0.1.0` workflow could reach its legacy real-publish path
through a tag dispatch with `dry_run=false` **only while** the
`NPM_PUBLISH_ENABLED` repository variable was enabled. That variable has been
**deleted** (2026-10-06), so the legacy path is inert. Do not re-enable it.

The `imp-agent` npm trusted-publisher bindings were **fully retired by the
owner on 2026-10-06**: the first revoke was answered `204` by the registry
after owner web authentication (confirmed in the local npm log); the last
entry (id `8e7aba0e-eeaa-4e88-b28b-9de09e08f109`, bound to the pre-rename
`FishInSalt/imp`) was revoked the same way, and the final
`npm trust list imp-agent` reports **no trust configurations**. The former
caveat — do not dispatch historical refs or re-run historical publishing
events until the binding is retired — accordingly lapses; those actions still
require their ordinary approvals. Preserve historical tags/workflow files and
`imp-agent@0.1.0`; old-package deprecation/unpublication is not included.
[`docs/design/publishing-design.md`](docs/design/publishing-design.md) is an archival design,
not the current release procedure.

## OIDC publication is live (`0.2.2` published); remaining steps

`ink-agent@0.2.0` was published manually from the reviewed artifact (no
provenance); the trusted publisher is bound; the repository is
`FishInSalt/ink`; and tag `v0.2.0` plus its GitHub Release exist. The
bootstrap design and its review record are
[`docs/design/ink-first-publication-design.md`](docs/design/ink-first-publication-design.md)
(§14 records what was executed).

`ink-agent@0.2.1` then shipped through the first OIDC trusted-publishing run:
pushing tag `v0.2.1` (2026-10-06) published the package with provenance
(`gitHead` `23cb91f`, attested on the registry). That run ended red at its
final post-publish registry-visibility check (a 60s window); the window was
raised to 180s in `72f81fc`, and the published artifact was verified manually.
Do not re-run the `v0.2.1` workflow: re-publishing the same version fails.

`ink-agent@0.2.2` shipped on 2026-10-06 as the second OIDC run: tag `v0.2.2`
was pushed from reviewed `main` and the run completed green end to end —
including the post-publish registry-visibility check inside the raised 180s
window — with provenance (`gitHead` `35f34b4`, attested on the registry); the
`v0.2.2` GitHub Release page is published from the dated CHANGELOG section.

Remaining external actions, each requiring explicit approval:

- re-verify the publisher binding after any further repository rename.

The binding must match `release.yml`: GitHub Actions, repository
`FishInSalt/ink`, workflow filename `release.yml`, no environment. Ownership and
publishability of `ink-agent` are established (registry presence is not
reservation or trademark clearance, which remains a separate legal question).

Following these instructions alone performs no external action; every external
step above is separately approved. Global state migration/source-linked cutover
is a separate operation governed by the rename design and reviewed runbook.

## Revised workflow truth table

[`.github/workflows/release.yml`](.github/workflows/release.yml) at revised
refs uses only the new variables:

- `INK_NPM_PUBLISH_ENABLED` must equal the string `true`;
- `INK_NPM_PACKAGE` must exactly equal `package.json.name` (`ink-agent`).

The legacy `NPM_PUBLISH_ENABLED` variable is ignored by this workflow.

| Event/ref | New gates | Input `dry_run` | Revised workflow result |
| --- | --- | --- | --- |
| Push of matching version tag on main ancestry | Enabled + package match | Not applicable | Real publish, after all checks |
| Tag push | Disabled/missing or package mismatch | Not applicable | Explicit publication-skipped warning and summary |
| Dispatch from main/branch | Any | `true` or `false` | Dry-run only, after ancestry and identity checks |
| Dispatch from matching tag | Any | `true` or `false` | Dry-run only, never real publication |
| Any version/identity/ancestry mismatch | Any | Any | Failure, no publish |

A dispatch input of `false` cannot override the event gate. Green gates do
not imply publication: inspect the warning/summary and registry outcome.
Historical refs do not inherit this truth table.

## Offline local gates

Start a dedicated branch/worktree before edits. Bump `package.json`, both
lockfile versions, and `src/format.ts` together for future releases. Move
Unreleased notes into a dated version section only for the actual release.

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

`npm run lint` also runs `lint:scripts`, which syntax-checks both package and
release guard scripts with `node --check`. Both CI workflows use this gate.

Use the controlled offline test boundary in the rename design: no production
credentials or provider endpoints. Never run `npm ci` against a shared
`node_modules` symlink; use dependencies read-only or separately owned
workspace/scratch dependencies. CI uses independently owned checkouts.

The artifact smoke captures the single `npm pack --json` filename rather
than a package-name glob. It checks packed metadata, every tar path and
regular-file mode, strict header checksums and octal fields, complete file
bodies/padding, two zero end blocks and a zero-only remainder. It rejects
entries or nonzero bytes after even a single zero block. It checks the Node
shebang, required `dist/cli.js`/`bin/ink.js`,
and absence of old launcher, runtime roots, dotenv, credentials, source,
tests, docs, or unexpected artifacts. It installs locally in a private
temporary prefix with temporary HOME/cache, no credentials, no install
scripts, and no network. It executes help and exact `Ink 0.2.2` version
(for this release), then checks npm-exec's single-bin inference against the
**local tarball from a neutral cwd**. It never invokes `npx ink` or modifies
shared dependencies. The optional cache source is read-only; missing cached
dependencies fail instead of fetching. Scratch paths are printed for
inspection; their cleanup is a separate operator decision.

`test/package-metadata.test.ts` runs the copied CLI in a controlled fixture
and checks the same exact version assertion used for installed and npm-exec
output. `test/package-tar.test.ts` exercises the exported parser with actual
synthetic tar bytes, including entries/duplicates after one zero block,
checksum and numeric corruption, injected secret paths, and truncation.
After a fresh build, run these regressions without installing dependencies:

```bash
node node_modules/vitest/vitest.mjs run test/package-metadata.test.ts test/package-tar.test.ts test/release-guards.test.ts
```

CI checks the exact Node 22.19.0 minimum and Node 24. Both CI and the release
gate provision `rg`/`fd` and fail if search-test prerequisites are missing.
Local checks on a different Node version do not substitute for those CI runs. Independently review code and
artifact results before declaring a release ready; merge to main only with
`--no-ff`.

## Ordinary releases, after approved bootstrap

After bootstrap and legacy retirement are complete, obtain separate owner
approval for external release actions. The approved matching version tag
must point to a reviewed commit in main's ancestry. The release workflow
runs typecheck, lint, build, tests, artifact smoke, and identity checks.
The publish job repeats ancestry, identity, npm-version and artifact checks
before its publication step. Only a **tag push** plus both new gates can
reach real publishing, with `--provenance --access public`.

Trusted publishing requires **npm >=11.5.1**, including the patch component.
The workflow checks the runner-provided version and fails if too old; it
does not implicitly install a moving `npm@latest` globally. Use a separately
reviewed runner/toolchain update if required. No local global npm upgrade is
authorized by editing a workflow.

Registry visibility checks and provenance URLs derive from the validated
selected package/version. After a real publication, verify the expected
registry version/artifact/provenance; do not infer success from a green
skipped run. Global installation and release-page publication need separate
approval and an appropriate isolated/production acceptance plan.

## Troubleshooting

- **Publication skipped:** confirm event is a tag push, new gate equals
  `true`, and new package variable equals `ink-agent`. Do not enable gates
  before the approved bootstrap/binding or legacy retirement. A rerun of a
  real tag-push event can publish if gates have since been enabled; it is
  still an external action requiring approval.
- **Dispatch did not publish:** expected; dispatch is always dry-run at
  revised refs, even with a tag and `dry_run=false`.
- **npm too old:** `11.5.0` is insufficient. The full minimum is `11.5.1`.
- **Auth/provenance failure:** verify the selected package's trusted-publisher
  fields against the actual repository/workflow, runner npm, and GitHub OIDC
  permissions. Do not introduce a long-lived token as an unreviewed fallback.
- **Offline smoke cache miss:** seed a complete production-dependency cache
  through a separately appropriate dependency-install step, or report that
  smoke verification is unavailable. Do not retry with network access or
  execute install scripts implicitly.
- **Publish succeeded but a later step failed (e.g. the registry-visibility
  check):** do not re-run the tag workflow — republishing an existing version
  fails; verify the registry artifact and provenance manually, record the
  outcome, and carry any fix in the next version.
- **Already-published version/broken release:** use a newly reviewed patch
  release; do not reuse tags or overwrite package versions. Deprecation or
  unpublication is a separate externally visible operation requiring approval.
