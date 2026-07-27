# Grok UI roadmap

Grok UI v0.9.0 provides local session discovery, ACP control, confirmed
interruption, workflow orchestration, Git and runtime inspection, a persistent
usage ledger, budgets, and privacy-aware exports. The roadmap extends those
foundations instead of replacing them.

## v0.8.2 — Release and recovery

- Keep GitHub, npm, package metadata, and the CLI version aligned.
- Build production assets before every browser run.
- Recover the ACP control channel with bounded exponential backoff.
- Preserve the reason an interrupted turn stopped and reload it before resume.
- Exercise forced SSE and ACP disconnects in browser coverage.
- Gate tagged releases with a sustained managed-session soak.

## v0.9 — Runtime intelligence

- Inspect process trees, open ports, test state, databases, local services, and
  external tool calls. The bounded runtime inspector and Live panels are
  implemented without shell execution, endpoint probing, or raw command input.
- Persist usage across CLI sessions, managed sessions, workflows, projects,
  models, agents, and time periods. The provenance-aware ledger and reporting
  API shipped in v0.9.0.
- Identify each usage value as Grok-reported, derived, incomplete, or
  unavailable. The first Usage view now exposes those labels directly.
- Add optional budgets, alerts, and exports. Budgets now persist locally,
  evaluate non-overlapping ledger scopes, deduplicate 80%/100% alerts, and
  export bounded JSON/CSV with server-side Privacy Mode redaction.

The staged design, security constraints, and release gate are tracked in
[`v0.9-runtime-intelligence.md`](./v0.9-runtime-intelligence.md).

## v0.10 — Multi-machine monitoring

- Introduce a lightweight host agent and transactional central host registry.
- Support authenticated SSH-forwarded and Tailscale-oriented connectivity
  without invoking a shell or probing arbitrary endpoints. SSH readiness,
  duplicate local-forward prevention, fixed-path parsing, and bounded reads are
  implemented on the unreleased v0.10 branch.
- Report host identity, Grok UI and agent versions, capabilities, health,
  latency, last seen, and freshness.
- Make connecting, healthy, degraded, stale, offline, incompatible,
  unauthorized, and unavailable behavior explicit.
- Aggregate remote sessions, workflows, runtime state, and usage while keeping
  the first multi-machine release strictly read-only. The Fleet page is split
  into independently owned status, editor, selector, and telemetry modules so
  the release boundary can be reviewed without a monolithic UI surface.

The protocol, security constraints, verification matrix, and approval-gated
release plan are tracked in
[`v0.10-multi-machine-monitoring.md`](./v0.10-multi-machine-monitoring.md).

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
