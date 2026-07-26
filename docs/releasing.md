# Releasing Grok UI

Releases are built from a clean tag and must pass the same packed-artifact
smoke test that users receive.

## Release checklist

1. Update the version in `package.json` and `package-lock.json`.
2. Add the release notes to `CHANGELOG.md`.
3. Run `npm ci --ignore-scripts`.
4. Run `npm run verify`.
5. Run `npm run test:e2e`.
6. Run `npm run test:soak`.
7. Run `npm run test:package`.
8. Confirm `npm audit --omit=dev --audit-level=high` passes.
9. Commit the release, create an annotated `vX.Y.Z` tag, and push the tag.

The release workflow rebuilds and re-verifies the project, installs the packed
tarball in an isolated directory, launches its real `grok-ui` executable, and
publishes the same verified tarball to npm and the GitHub release.

## npm publication

The public package is published as
[`grok-ui`](https://www.npmjs.com/package/grok-ui) through npm trusted
publishing. Configure the package once with this GitHub Actions publisher:

- GitHub owner: `joeynyc`
- Repository: `Grok-UI`
- Workflow: `release.yml`
- Allowed action: `npm publish`

The tagged workflow requires OIDC and does not use a long-lived npm token. It
rejects a tag that does not match `package.json`, runs the full release gate,
publishes to npm, and only then creates the GitHub release.

To publish an existing GitHub tag that predates npm publication, open the
Release workflow in GitHub Actions, choose **Run workflow**, and enter the
existing `vX.Y.Z` tag. The manual path publishes npm only and does not recreate
the GitHub release.
