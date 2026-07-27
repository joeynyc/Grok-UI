# Contributing

Thanks for helping improve Grok UI.

## Development

1. Install Node.js 22 or newer and Grok Build.
2. Run `npm install`.
3. Run `npm run dev`.
4. Before submitting a change, run `npm run verify`.
5. For packaging or startup changes, also run `npm run test:package`.
6. For host-agent or fleet changes, also run `npm run test:e2e`,
   `npm run test:soak`, and `npm audit --omit=dev --audit-level=high`.

Keep the server loopback-only during development. Tests must not depend on real Grok credentials or make model requests.

## Pull requests

- Keep changes focused and explain the user-facing impact.
- Add tests for parsing, permissions, path validation, and security boundaries.
- For fleet changes, test protocol compatibility, authentication failures,
  bounded timeouts, disconnect and reconnect, freshness transitions, and the
  absence of remote mutation controls.
- Include desktop and mobile verification for UI changes.
- Never commit `.env`, `~/.grok` data, session transcripts, credentials, or screenshots containing private source or prompts.
- Keep package contents under the release-check size and privacy limits.

## Design principles

- Prefer real Grok/ACP state over simulated UI.
- Preserve explicit user approval for sensitive tools.
- Keep live reads bounded.
- Make offline, empty, and failure states understandable.
- Maintain the black-box flight-recorder visual language.

See [docs/releasing.md](docs/releasing.md) for the tagged release process.
