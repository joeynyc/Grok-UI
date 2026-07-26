# Grok UI roadmap

Grok UI v0.8.1 already provides local session discovery, ACP control,
confirmed interruption, workflow orchestration, Git inspection, reported
session cost, managed-session token totals, and per-agent workflow tokens.
The roadmap extends those foundations instead of replacing them.

## v0.8.2 — Release and recovery

- Keep GitHub, npm, package metadata, and the CLI version aligned.
- Build production assets before every browser run.
- Recover the ACP control channel with bounded exponential backoff.
- Preserve the reason an interrupted turn stopped and reload it before resume.
- Exercise forced SSE and ACP disconnects in browser coverage.
- Gate tagged releases with a sustained managed-session soak.

## v0.9 — Runtime intelligence

- Inspect process trees, open ports, test state, databases, local services, and
  external tool calls.
- Persist usage across CLI sessions, managed sessions, workflows, projects,
  models, agents, and time periods. The provenance-aware ledger and reporting
  API are now implemented on the v0.9 development branch.
- Identify each usage value as Grok-reported, derived, incomplete, or
  unavailable. The first Usage view now exposes those labels directly.
- Add optional budgets, alerts, and exports.

The staged design, security constraints, and release gate are tracked in
[`v0.9-runtime-intelligence.md`](./v0.9-runtime-intelligence.md).

## v0.10 — Multi-machine monitoring

- Introduce a lightweight host agent and central host registry.
- Support secure SSH- and Tailscale-oriented connectivity.
- Report host identity, version, capabilities, health, latency, and stale
  state.
- Keep the first multi-machine release read-only.

## v0.11 — Secure remote control

- Start, pause, resume, interrupt, and stop remote work.
- Make remote commands idempotent and reconnection-safe.
- Add destructive-action confirmation, per-host authorization, and an audit
  trail.

## v0.12 — VS Code

- Ship a thin extension over the same host, session, control, and event APIs.
- Associate sessions with the current workspace.
- Surface agent state, permissions, changes, notifications, and interruption
  controls without duplicating backend logic.

## v1.0 — Stable platform

- Version the host/client API.
- Guarantee upgrade compatibility and state migrations.
- Complete remote-control security and recovery reviews.
- Document supported extension and host integration points.
