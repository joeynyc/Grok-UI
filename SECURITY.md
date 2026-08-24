# Security policy

## Supported versions

Security fixes are applied to the latest release candidate on the default branch.

## Reporting

Do not open a public issue for a suspected vulnerability. Use GitHub’s private vulnerability reporting for this repository, or contact the maintainer privately.

Include the affected version, deployment topology, reproduction steps, and impact. Do not include real Grok credentials, prompts, source code, or session archives.

## Deployment guidance

- Keep the default loopback-only bind whenever possible.
- Use an SSH tunnel or a private Tailscale network for access from another
  device or for host-agent links.
- Set a long, random `GROK_UI_TOKEN` before any non-loopback bind.
- Terminate TLS in front of the server on untrusted networks.
- Treat authenticated access as equivalent to local developer access: the UI can display conversations and source diffs and can instruct Grok to use tools.
- Run Grok UI as the same unprivileged user who owns the intended `~/.grok` directory.
- Do not expose port `4310` directly to the public internet.
- Treat generated preview applications as untrusted local development code.
  Inspect the displayed package command before starting it, and stop previews
  when they are no longer needed.


## Multi-machine monitoring

The v0.10 host agent is a read-only monitoring boundary. Its credential is
separate from the central browser login and from Grok or ACP credentials.
Protect it like a developer credential and never place it in a browser URL,
repository, screenshot, issue, or log.

- Prefer a loopback-bound agent reached through SSH port forwarding. Grok UI's
  SSH transport starts the system `ssh` executable with a fixed argument array,
  disables a remote command, and does not use a shell. When an agent is
  reachable over Tailscale, keep it on the intended private interface, require
  agent authentication, and use TLS when traffic may leave a trusted device
  boundary.
- Tailscale reachability does not by itself grant Grok UI access. The
  application authentication requirement still applies.
- Register only agents you control. The central monitor contacts only the
  configured agent origin and documented read-only paths; it does not scan the
  network, follow an agent to arbitrary endpoints, probe discovered services,
  invoke `tailscale`, run a remote SSH command, or use a shell.
- Keep host-agent credentials server-side. They must not appear in fleet API
  responses, browser state, errors, or diagnostics.
- Treat an authenticated agent response as untrusted input until it passes the
  protocol parser, version check, field limits, response-size limit, and record
  caps.
- Do not add remote start, prompt, permission, pause, resume, interrupt, stop,
  shell, arbitrary fetch, file mutation, or destructive routes in v0.10.

The central connector accepts only fixed `/agent/v1/` protocol paths. It uses
authenticated `GET` requests, a 3.5-second request timeout, a 2 MiB response
limit, a global four-read concurrency limit, and manual redirect handling that
rejects redirects. Central browser and SSE snapshots are capped at 4 MiB. The
registry is limited to 32 hosts. Direct URLs are loopback-only; Tailscale URLs
must use a `.ts.net` name or an address from Tailscale's IPv4 or IPv6 ranges.
URL credentials, arbitrary paths, queries, and fragments are rejected.

Fleet registry configuration, including dedicated agent tokens, is written
atomically to `fleet.json` in the Grok UI state directory. The directory and
file use user-only permissions. Do not copy this file into issue reports,
support bundles, or shared repositories.

## Secure remote sessions

v0.11 adds an optional control plane beside the v0.10 read-only monitoring
plane. It is disabled unless the host has a
`GROK_UI_AGENT_CONTROL_TOKEN` and the central Fleet entry has both the matching
token and Remote Sessions enabled.

- The control token must be different from `GROK_UI_AGENT_TOKEN`. Monitoring
  credentials cannot call control routes, and control credentials are not
  accepted by monitoring routes.
- Keep both credentials server-side. They are excluded from Fleet API
  responses, SSE data, browser state, and public configuration.
- Prefer a private Tailscale network or loopback SSH forwarding. Tailscale
  provides reachability, not application authorization; both agent
  authentication layers still apply.
- The connector accepts only documented `/agent/control/v1/` session routes,
  rejects redirects, limits requests to 64 KiB and responses to 2 MiB, and uses
  the same bounded timeout and global connection concurrency as monitoring.
- Remote Start is restricted to workspaces already observed on that host.
  There is no arbitrary shell, arbitrary fetch, raw file-write, privilege
  escalation, or generic command endpoint.
- The host is the final authority. It may deny a command or omit any remote
  capability. Permission decisions must match a request and option currently
  advertised by Grok.
- The central server refuses mutation unless the host is enabled, compatible,
  healthy, fresh, and advertising the exact action capability. This check is
  server-side and does not rely on a browser button being disabled.
- Each mutation uses a durable command ID and payload fingerprint. An ambiguous
  operation after host restart becomes `unknown` and is reconciled; it is never
  replayed automatically. Commands carry a bounded expiry, and an expired
  delivery is rejected rather than treated as new after retention compaction.
- Existing CLI-observed sessions remain read-only. Follow-up, permission, and
  interruption routes accept only sessions already owned by the host's managed
  ACP controller.

The host stores bounded command and audit evidence in
`remote-commands.json` under the private Grok UI state directory. Records
contain command metadata, token fingerprints, timestamps, and outcomes—not
prompts, transcripts, credentials, or raw provider error messages. Do not
include this file in routine support bundles.

## Session previews

Preview applications run as separate loopback processes and origins. They do
not receive Grok credentials, host-agent credentials, or the Grok UI access
token, but they still run with the operating-system permissions of the current
user. Grok UI detects commands only inside the workspace of a known local
session, uses argument-separated process spawning without a shell, strips
sensitive Grok and credential environment variables, and retains only a
bounded log tail.

Preview origins are isolated on `preview.localhost` behind a cookie-stripping
proxy so dashboard `Cookie` and `Authorization` headers are not forwarded to
generated applications. Generic `HOST`/`PORT` recipes are best-effort and may
bind more widely if the script ignores those variables.

The embedded iframe is sandboxed and allowed only from `preview.localhost` by
the Content Security Policy. That iframe sandbox is a browser boundary, not an
operating-system sandbox.

## Trust boundary

The browser never receives Grok credentials. The server owns the local ACP connection and passes explicit permission decisions back to Grok. A valid Grok UI token grants access to that control surface, so it must be protected like a developer credential.

The central server is the only fleet client visible to the browser. It
authenticates each configured agent, bounds every remote read, isolates one
host's failure from the rest of the fleet, and reports compatibility and
freshness rather than silently presenting old data as current. Agent
credentials never cross that browser boundary.

For remote sessions, the local host agent also remains the ACP authority. The
central server carries constrained intent; it does not gain a remote shell or
the ability to invent permission options.

Privacy Mode is a presentation safeguard for recordings, demos, and screen
sharing. It replaces sensitive values in rendered views but does not redact API
responses or remove operational values from browser memory. Do not treat Privacy
Mode as a substitute for authentication or trusted-device access.
