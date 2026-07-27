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

## Trust boundary

The browser never receives Grok credentials. The server owns the local ACP connection and passes explicit permission decisions back to Grok. A valid Grok UI token grants access to that control surface, so it must be protected like a developer credential.

The central server is the only fleet client visible to the browser. It
authenticates each configured agent, bounds every remote read, isolates one
host's failure from the rest of the fleet, and reports compatibility and
freshness rather than silently presenting old data as current. Agent
credentials never cross that browser boundary.

Privacy Mode is a presentation safeguard for recordings, demos, and screen
sharing. It replaces sensitive values in rendered views but does not redact API
responses or remove operational values from browser memory. Do not treat Privacy
Mode as a substitute for authentication or trusted-device access.
