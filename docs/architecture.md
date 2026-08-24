# Architecture

Grok UI is a local-first developer tool. Its existing runtime, control, usage,
durable-state, workspace, and browser-security planes remain authoritative on
each machine. v0.10 adds a read-only fleet plane over those projections. v0.11
adds an optional, separately authenticated remote-session plane while keeping
each host's local ACP controller authoritative.

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

## Preview plane

`PreviewSupervisor` detects package scripts only inside the workspace
associated with a known local session. The browser cannot provide an arbitrary
working directory or command.

Starting a preview binds the child on `127.0.0.1` and publishes it through a
cookie-stripping proxy at `http://preview.localhost:<port>`. That hostname is
a different cookie host from `127.0.0.1` and `localhost`. Readiness probes the
IPv4 loopback bind because `preview.localhost` can resolve to `::1`. The proxy
also drops `Cookie` and `Authorization` before they reach generated code. Known
frameworks receive explicit loopback host flags. Other scripts only get
`HOST`/`PORT` as a best-effort bind; they may still listen on `0.0.0.0` if
they ignore `HOST`.

Spawn uses argument separation and `shell: false`. Package managers may still
invoke a shell internally to run the script body. Start and stop are serialized
per session and terminate with `SIGTERM`, a short wait, then `SIGKILL`. Grok,
token, secret, password, credential, and API-key environment variables are
excluded. Output is stripped of terminal control sequences and kept as a bounded
in-memory tail. Preview processes are not restored after a restart and are
stopped during graceful server shutdown.

The application iframe uses the `preview.localhost` origin and a sandbox.
Grok UI credentials and authentication cookies are not forwarded to the child
process.

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

Registry changes are serialized as complete transactions. A candidate registry
is validated and written through a temporary file before it replaces the
in-memory view. A failed write therefore cannot expose state that was never
durable, and the write queue recovers for the next operation. Enabled SSH hosts
must use distinct loopback forwarding ports.

`fleet.json` uses schema version 1 and is capped at 32 entries. If the file is
malformed, contains an invalid entry, or uses a future version, Grok UI
preserves it instead of replacing it, loads an empty fleet so the local
dashboard remains available, reports `registryError` in the Fleet view, and
blocks registry mutations until the file is repaired.

Freshness is derived from the last successful sample: fresh below 10 seconds,
aging below 15 seconds, stale from 15 to below 45 seconds, and expired at 45
seconds. The status layer keeps connection, health, compatibility, and
authentication failures explicit rather than collapsing them into one offline
state.

Manual refreshes coalesce with an in-flight poll and wait for that observation
to finish. Poll completion emits only when the fleet projection changes; normal
polls do not force duplicate full-fleet SSE frames. Aggregate compaction tracks
per-host serialized deltas instead of repeatedly serializing the growing fleet.
SSH polling begins only after the forwarded loopback port accepts a connection,
within the original bounded request deadline.

Each poll is stamped with the host connection generation. Changing credentials,
transport, endpoint, forwarding ports, or enabled state invalidates older
in-flight results; a refresh waiting on the older request then polls the current
configuration. Cached snapshots retained during reconnect, disablement,
incompatibility, or failure are explicitly labeled historical in both section
panels and the overview.

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

## Remote session plane

The v0.11 control plane is parallel to, not an expansion of, the read-only
`/agent/v1/` surface. A host advertises remote-session capabilities only when
started with a dedicated control token. The central registry independently
stores that token and an explicit enable flag. The monitoring and control
tokens must differ and neither reaches the browser.

The control connector accepts only these versioned operations:

| Method and route | Purpose |
| --- | --- |
| `GET /agent/control/v1/sessions/:id` | Read a bounded managed-session snapshot |
| `POST /agent/control/v1/sessions` | Start in a previously observed workspace |
| `POST /agent/control/v1/sessions/:id/prompt` | Send a natural-language follow-up |
| `POST /agent/control/v1/sessions/:id/interrupt` | Interrupt the active turn |
| `POST /agent/control/v1/sessions/:id/permissions/:permissionId` | Select an option advertised by Grok |

There is no generic command, shell, file-write, arbitrary fetch, or workflow
mutation route. The host's `GrokController` owns session attachment, ACP
messages, pending permission promises, and cancellation. The central
`FleetMonitor` carries constrained intent only after checking registry opt-in,
healthy connection, fresh observation, compatibility, and the action-specific
capability. Each remote session and permission identifier is namespaced by host
at the browser boundary.

Each mutation includes a command ID and bounded expiry. `RemoteCommandStore`
hashes the canonical payload, persists acceptance before execution, joins
concurrent retries, and returns the stored outcome for the same command. Reusing
an ID for another action, target, actor, expiry, or payload is rejected.
Expired deliveries are rejected even after detailed records are compacted, and
the host applies backpressure rather than evicting unexpired replay protection.
Commands that were accepted or executing when the host restarts become
`unknown`; they are never automatically replayed.

The versioned, bounded `remote-commands.json` file is atomic and user-private.
Its audit transitions contain identifiers, action, target, credential
fingerprint, time, and outcome, but not prompts or transcripts.
Raw ACP/provider errors are reduced to a stable public failure message before
they enter either the file or command receipt.

The Remote Session Console uses a dedicated SSE stream. The central server
polls the host on a bounded cadence, emits changed session revisions and
heartbeats, and reloads the full bounded snapshot after reconnect. Existing
transcript remains visible as historical context, but server-side mutation
gates prevent a stale browser from acting blindly.

## Repository ownership

The canonical architecture document remains this lowercase file. Do not create
a second `ARCHITECTURE.md`; update this map when ownership moves.

| Responsibility | Owner |
| --- | --- |
| Browser shell, navigation, local and fleet SSE lifecycle | `src/App.tsx` |
| Fleet page coordination, selection, filters, and registry actions | `src/views/FleetView.tsx` |
| Fleet selectors, caps, formatting, and availability derivation | `src/views/fleet/model.ts` |
| Fleet status and freshness presentation | `src/views/fleet/status.tsx` |
| Fleet host registry editor | `src/views/fleet/HostEditor.tsx` |
| Read-only remote telemetry panels | `src/views/fleet/panels/` |
| Fleet-only visual rules | `src/styles/fleet.css` |
| Host-agent HTTP boundary and local observer composition | `server/host-agent.ts` |
| Durable remote command reconciliation and audit evidence | `server/remote-command-store.ts` |
| Shared local session-to-row projection | `server/session-projection.ts` |
| Wire parsing, caps, namespacing, and control stripping | `server/fleet-protocol.ts` |
| Atomic registry persistence and registry validation | `server/fleet-registry.ts` |
| Fixed-path HTTP/Tailscale/SSH connectivity | `server/fleet-connectors.ts` |
| Polling, compatibility, health, freshness, and aggregation | `server/fleet-monitor.ts` |
| Central authenticated routes and local composition root | `server/index.ts` |
| Local loopback preview lifecycle and bounded logs | `server/preview-supervisor.ts` |
| Remote managed-session console | `src/views/RemoteSessionWorkbench.tsx` |
| Durable local session/usage state | `server/session-state.ts`, `server/usage-ledger.ts` |

Dependencies flow from page and panel rendering into shared client types and
API helpers; rendering never owns network policy. The fleet monitor depends on
the registry, connector, and protocol layers; those layers do not import the
browser. The host agent and central server share local projections rather than
copying their mapping logic.

Generated `dist/`, `dist-server/`, Playwright reports, coverage output, package
archives, and temporary state directories are disposable and must not be
treated as source.

## Verification

Use the narrowest relevant checks while editing, then run the complete gate:

```text
npm run check
npm test
npm run verify
npm run test:e2e
npm run test:soak
npm run test:package
npm audit --omit=dev --audit-level=high
```
