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
9. Review the milestone completion matrix and confirm every requirement has
   current unit, integration, browser, soak, package, privacy, and security
   evidence.
10. Obtain the user's explicit approval to merge, tag, or publish the release.
11. After approval, commit the release, create an annotated `vX.Y.Z` tag, and
    push the tag.

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

For v0.10, the release gate must also prove that the installed host agent and
central fleet monitor interoperate, that configured hosts can disconnect and
recover during the 75-second soak, and that every remote surface remains
read-only. A passing build or unit suite alone is not release evidence.

v0.10 passed these gates and received explicit approval before its tag,
npm publication, and GitHub release were created.

For v0.11, the release gate must additionally prove that remote commands are
authenticated, capability- and freshness-gated, idempotent across concurrent
processes, honest after lost acknowledgements and restarts, and constrained to
the documented control routes. The browser matrix must cover the complete
remote session journey and mobile failure behavior in Chromium and WebKit.

To publish an existing GitHub tag that predates npm publication, open the
Release workflow in GitHub Actions, choose **Run workflow**, and enter the
existing `vX.Y.Z` tag. The manual path publishes npm only and does not recreate
the GitHub release.
