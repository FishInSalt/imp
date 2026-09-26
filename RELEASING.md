# Releasing imp

Design: [`docs/publishing-design.md`](docs/publishing-design.md). Two paths:

- **Bootstrap (v0.1.0, one time)** — the very first publish is manual. npm's
  trusted-publisher configuration lives on the package's settings page, which
  only exists once the package does.
- **Regular releases** — tag-driven, published by
  [`.github/workflows/release.yml`](.github/workflows/release.yml) with
  provenance through npm trusted publishing (OIDC, no long-lived tokens).

The repo variable `NPM_PUBLISH_ENABLED` is the publish gate: while it is not
`true`, a tag push runs the gates and prints a "publish skipped" warning
instead of publishing. Check for that warning (and the job summary) — a green
run does not necessarily mean something was published.

## Prerequisites

- npm account with 2FA enabled and email verified, logged in locally
  (`npm login`).
- Push access to `FishInSalt/imp`.

## Bootstrap release (v0.1.0 — one time)

Run from a clean `main` checkout where `HEAD` is the commit to release:

```bash
TAG=v0.1.0
test "$(node -p 'require("./package.json").version')" = "${TAG#v}"  # version guard
git tag -a "$TAG" -m "imp-agent $TAG"
git push origin "$TAG"    # gates run; the publish stays gated off
npm publish --access public
npm view imp-agent version  # expect 0.1.0 (allow ~30s to propagate)
```

Then:

1. Smoke-test the published package: `npm install -g imp-agent@0.1.0` and
   `imp --version`.
2. On npmjs.com: package settings → Trusted Publisher → GitHub Actions →
   repository `FishInSalt/imp`, workflow file name `release.yml`.
3. In the GitHub repo: Settings → Secrets and variables → Actions →
   Variables → set `NPM_PUBLISH_ENABLED` to `true`.
4. Publish the GitHub Release with the changelog section as the notes:

```bash
gh release create v0.1.0 --verify-tag --title "imp-agent v0.1.0" --notes-file notes.md
```

## Regular release

1. Branch from `main` and bump the version in **both** `package.json` and
   `src/format.ts` (`VERSION`) — `test/package-metadata.test.ts` fails when
   they disagree.
2. Move the `[Unreleased]` changelog entries into a
   `## [x.y.z] - YYYY-MM-DD` section.
3. Merge to `main` (`--no-ff`) once the CI gates pass.
4. Tag and push:

```bash
TAG=v0.1.1   # the version being released
test "$(node -p 'require("./package.json").version')" = "${TAG#v}"
git tag -a "$TAG" -m "imp-agent $TAG"
git push origin "$TAG"
```

5. Watch the release workflow: `gate` must pass; `publish` runs only for tag
   refs with `NPM_PUBLISH_ENABLED=true`. It verifies registry visibility and
   prints the provenance link.
6. Verify locally: `npm view imp-agent version`, then
   `npm i -g imp-agent@x.y.z` and smoke-test.
7. Create the GitHub Release as above.

## Dry runs

```bash
gh workflow run release.yml --ref main -f dry_run=true
```

Runs the gates plus `npm publish --dry-run` without writing to the registry.
Dispatch on `main` — the tag-on-main check runs for every ref. A dispatched
run can never publish: the real publish step requires a `refs/tags/v*` ref.

## Troubleshooting

- **"publish skipped" warning on a tag push** — `NPM_PUBLISH_ENABLED` is not
  `true` (or was cleared). Nothing was published; set the variable and re-run
  the workflow.
- **Auth / token errors after binding trusted publishing** — check the npm
  version in the publish job log first: trusted publishing needs npm >=
  11.5.1 (the workflow upgrades npm explicitly). Then re-check the
  trusted-publisher fields (repository + workflow file name `release.yml`).
- **"cannot publish over existing version"** — the tag points at an already
  published version. Cut a new patch version; do not reuse the tag.
- **A broken release** — prefer a patch release with the fix. `npm unpublish`
  works only for 24 hours after publishing and permanently burns the version
  number; for a defective version that stays up, `npm deprecate` it with a
  pointer to the replacement.

## Why not a token?

Trusted publishing exchanges a short-lived GitHub OIDC token for publish
rights, so there is no npm token to store, rotate, or leak. Provenance
attestations are generated automatically on publish.
