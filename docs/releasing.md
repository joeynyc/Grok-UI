# Releasing Grok UI

Releases are built from a clean tag and must pass the same packed-artifact
smoke test that users receive.

## Release checklist

1. Update the version in `package.json` and `package-lock.json`.
2. Add the release notes to `CHANGELOG.md`.
3. Run `npm ci --ignore-scripts`.
4. Run `npm run verify`.
5. Run `npm run test:package`.
6. Confirm `npm audit --omit=dev --audit-level=high` passes.
7. Commit the release, create an annotated `vX.Y.Z` tag, and push the tag.

The release workflow rebuilds and re-verifies the project, installs the packed
tarball in an isolated directory, launches its real `grok-ui` executable, and
attaches the verified package to a GitHub release.

## npm publication

The public package is published as
[`grok-ui`](https://www.npmjs.com/package/grok-ui). Verify the tagged version,
registry identity, and current authentication immediately before publication:

```bash
npm view grok-ui version
npm whoami
npm publish
```

Publishing is intentionally separate from GitHub release creation so missing
registry credentials cannot prevent the downloadable release artifact.
