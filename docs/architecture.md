# Architecture

Grok UI is a local-first developer tool. Its existing runtime, control, usage,
durable-state, workspace, and browser-security planes remain authoritative on
each machine. v0.10 adds a read-only fleet plane over those projections.

## Runtime plane

`LiveMonitor` watches `active_sessions.json` plus bounded tails of active `events.jsonl` and `updates.jsonl` files. Filesystem events are debounced and projected into a small `LiveSnapshot`, then delivered through server-sent events.

Historical aggregate views use `summary.json` and `signals.json`. The Session Workbench reads bounded tails of `updates.jsonl` and, for older sessions without structured updates, `chat_history.jsonl`. Memory bodies, system prompts, raw terminal history, and authentication files are not read.

## Control plane

`GrokController` supervises one `grok agent --no-leader stdio` child process and uses the official TypeScript ACP SDK.

The connection supports:

- ACP initialization and cached Grok authentication
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/update`
- `session/request_permission`

Each permission request stays pending as a server-side promise until an authenticated user selects one of Grok’s options or cancels the turn. The browser cannot manufacture an option that Grok did not advertise.

## Usage plane

`UsageLedger` normalizes the token and cost telemetry already owned by
`LiveMonitor`, `GrokController`, and the workflow projection. It stores
cumulative observations rather than replaying or duplicating raw events.

Every metric carries provenance: `grok-reported`, `derived`, `incomplete`, or
`unavailable`. Session totals and workflow-agent detail are separate reporting
scopes because they can describe overlapping work. Live context occupancy is
never treated as cumulative token usage.

Reports are time-bounded and can group by project, model, session, or agent.
The ledger is local-only and uses the same authenticated API boundary as the
rest of the dashboard.

## Durable UI state

`SessionStateStore` atomically persists Grok UI-owned annotations and managed ACP lanes to `~/.grok-ui/state.json` with user-only file permissions. It never mutates Grok’s session directories. Rename and archive are therefore reversible UI overlays.

Managed lanes retain a bounded event tail and usage totals. The same versioned
state file retains at most 10,000 normalized usage observations and migrates
older state in place. If the server exits during a turn, the lane restores as
idle with a `server_restarted` stop reason; the user can explicitly resume it
through `session/load` and `session/prompt`.

## Workspace plane

`WorkspaceInspector` runs argument-separated Git commands against workspaces associated with recorded or controlled Grok sessions. It never invokes a shell.

Diff paths are resolved beneath the repository root. Reads are bounded, binary content is not rendered, and untracked files are represented without leaving the repository.

## Network boundary

The production server binds to the loopback interface by default. A non-loopback host requires `GROK_UI_TOKEN`.

Authenticated browsers receive an in-memory session ID through an `HttpOnly`, `SameSite=Strict` cookie. Mutations using that cookie are same-origin checked. API clients may use the configured token as a bearer credential.

No browser request contains Grok credentials. No product analytics are emitted.

## Fleet plane

The lightweight host agent runs beside the same local projections described
above. It does not rescan Grok state or introduce a remote ACP controller.
Instead, it publishes a versioned, bounded monitoring contract containing:

- stable host identity, Grok UI and agent versions, and negotiated capabilities
- host health plus collection and freshness timestamps
- bounded session, workflow, runtime, and usage snapshots

The central `FleetMonitor` reads only explicitly registered hosts. An agent may
be reached through a managed loopback SSH forwarding process or on an intended
private Tailscale interface. The SSH transport starts the system `ssh`
executable with a fixed argument array and `shell: false`; it cannot append a
remote command. Grok UI does not invoke `tailscale`, scan a network, follow
arbitrary targets, or probe the services reported by the runtime inspector.

The connector accepts only fixed `/agent/v1/` paths, uses authenticated `GET`
requests, rejects redirects, times out after 3.5 seconds, and rejects a response
larger than 2 MiB. A global semaphore permits at most four concurrent remote
reads across background polling, explicit refreshes, session detail, and usage.
The central projection compacts oversized hosts to keep browser and SSE fleet
snapshots at or below 4 MiB. Polling normally occurs every 5 seconds and backs
off from 5 to at most 30 seconds after failures; unchanged fleets are not
re-emitted between status or freshness changes.

Each remote workload is namespaced by its host identity before it reaches the
browser. This prevents equal session or workflow identifiers on two machines
from colliding. One host's timeout, authentication failure, incompatible
protocol, or malformed response is isolated from every other host and from the
local dashboard.

The registry persists atomically in a separate user-private `fleet.json`. The
existing `SessionStateStore` schema remains unchanged, so fleet changes cannot
overwrite annotations, managed sessions, usage, budgets, or alerts. Remote
snapshots remain freshness-qualified observations; a cached snapshot is never
silently labeled live after its collection window expires.

`fleet.json` uses schema version 1 and is capped at 32 entries. If the file is
malformed, contains an invalid entry, or uses a future version, Grok UI
preserves it instead of replacing it, loads an empty fleet so the local
dashboard remains available, reports `registryError`, and blocks registry
mutations until the file is repaired.

Freshness is derived from the last successful sample: fresh below 10 seconds,
aging below 15 seconds, stale from 15 to below 45 seconds, and expired at 45
seconds. The status layer keeps connection, health, compatibility, and
authentication failures explicit rather than collapsing them into one offline
state.

### Remote read-only boundary

v0.10 deliberately exposes no remote control plane. The agent contract has no
remote start, prompt, approval, pause, resume, interrupt, stop, shell,
arbitrary-fetch, file-write, or destructive route. Local ACP controls continue
to operate only on the central machine's local controller. Remote control is a
separate v0.11 milestone.

The agent surface is:

| Route | Projection |
| --- | --- |
| `GET /agent/v1/hello` | identity, versions, protocol range, capabilities |
| `GET /agent/v1/snapshot` | health, sessions, workflows, runtime, default usage |
| `GET /agent/v1/sessions/:id` | bounded session detail and transcript |
| `GET /agent/v1/usage` | validated, bounded usage report |

The agent permits `GET` and `HEAD` only. Remote workflow objects have
`canPause`, `canResume`, and `canStop` forced to `false`; managed-session
last-prompt fields and workflow control handles are not exported.

### Authentication and privacy

Agent authentication is independent of the browser `SecurityGate`. Agent
credentials remain on the central server and are not included in the fleet API
contract, SSE frames, UI state, or diagnostic text.

Privacy Mode applies stable presentation aliases to host and remote workload
values in the browser. As with local data, it is a screen-sharing safeguard
rather than an authorization boundary: an authenticated browser can receive
the underlying operational fleet contract.
