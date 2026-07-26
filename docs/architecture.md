# Architecture

Grok UI is a single-user local developer tool with three data planes.

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
