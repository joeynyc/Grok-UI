<div align="center">

<img src="https://raw.githubusercontent.com/joeynyc/Grok-UI/main/docs/grok-ui-red-mark.png" width="128" alt="Grok UI red command mark"/>

# Grok UI

**Every Grok session — one living command center.**

An unofficial, local-first dashboard for Grok Build:
watch active agents, control sessions over ACP, inspect Git changes,
and move through your complete local history without leaving the browser.

![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=nodedotjs&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![Grok Build](https://img.shields.io/badge/Grok%20Build-native-111318)
![Local first](https://img.shields.io/badge/privacy-local--first-D9FF43?labelColor=111318)
![License: MIT](https://img.shields.io/badge/license-MIT-E44738)

<img src="docs/grok-ui-dashboard.png" width="900" alt="Grok UI Event Horizon dashboard with live runtime telemetry"/>

[**Watch the 24-second product tour**](https://github.com/joeynyc/Grok-UI/releases/download/v0.5.1/grok-ui-dashboard-tour-final-white-logo.mp4)
· [**See what’s new in v0.9.0**](https://github.com/joeynyc/Grok-UI/releases/tag/v0.9.0)
· [**Quickstart**](#quickstart) · [**What it does**](#what-it-does)
· [**Architecture**](#architecture) · [**Security**](#privacy-and-security)

</div>

> [!NOTE]
> Grok UI is an independent community project. It is not affiliated with or endorsed by xAI.

## What it does

<table>
<tr>
<td width="50%" valign="top">

**◉ A runtime that tells the truth**

Active agents come from Grok’s real process registry. Turns, phases,
reasoning, responses, tools, context, and cost updates flow into the
dashboard over one live event stream.

</td>
<td width="50%" valign="top">

**⌘ Native session control**

Create, resume, prompt, approve, and cancel Grok sessions through the
Agent Client Protocol. Permission choices are rendered exactly as Grok
provides them—never guessed or auto-approved.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**◇ One Session Console per agent**

Open any recorded CLI session or managed lane in a clearly labeled Session
Console to chat with the agent, review its activity, inspect changes, manage
permissions, and send follow-ups. Managed sessions survive dashboard restarts.

</td>
<td width="50%" valign="top">

**↗ Git changes as they happen**

The selected repository is watched live. Staged, unstaged, and untracked
files update automatically, with bounded diffs and no manual refresh
required.

</td>
</tr>
<tr>
<td colspan="2" valign="top">

**⌁ Cross-session workflow command field**

Grok Build v0.2.112+ workflow updates become one live run field: phase
progression, per-agent token usage, models, duration, budget use, failures,
results, and safe Pause, Resume, or Stop controls. Searchable, paginated rosters
stay usable as a workflow scales. Failed runs expose recovery only when Grok
reports that the current process can resume them.

</td>
</tr>
<tr>
<td colspan="2" valign="top">

**◎ Read-only multi-machine monitoring**

Register trusted Grok UI host agents over managed SSH forwarding or a private
Tailscale network. The Fleet view shows identity, versions, capabilities,
health, latency, last seen, freshness, and bounded remote sessions, workflows,
runtime state, and usage—without adding remote controls.

</td>
</tr>
</table>

## Architecture

<div align="center">
<a href="https://raw.githubusercontent.com/joeynyc/Grok-UI/main/docs/architecture.svg">
<img src="docs/architecture.svg" width="820" alt="Browser connected to a local Grok UI supervisor, local state and ACP control, plus authenticated read-only remote host agents"/>
</a>
</div>

Grok UI runs as one local Express supervisor. The browser receives runtime,
control, dashboard, workspace, and fleet events over SSE; commands return
through authenticated API routes. Optional host agents reuse the same bounded
local projections and expose a separate authenticated, read-only protocol.
Grok credentials and host-agent tokens never enter the browser.

## Quickstart

### Requirements

- Node.js 22 or newer
- A working [`grok`](https://github.com/xai-org/grok-build) installation
- Grok Build account access

### One-command launch

The packaged release checks its environment, starts the local server, and opens
the dashboard:

```bash
npx --yes grok-ui
```

Run diagnostics without starting the dashboard:

```bash
npx --yes grok-ui doctor
```

Start the read-only agent on a machine you want to monitor:

```bash
GROK_UI_AGENT_TOKEN='<separate-long-random-token>' \
npx --yes grok-ui agent
```

The agent always requires its own token, including on loopback, and defaults to
`127.0.0.1:4311`. Use `--host`, `--port`, `--grok-home`, or `--state-dir` after
`agent` when that machine needs an override. The central Fleet view stores the
matching token server-side when you register the host.

### Run from source

```bash
git clone https://github.com/joeynyc/Grok-UI.git
cd Grok-UI
npm ci
npm run doctor
npm start
```

`npm start` creates the production build automatically when it is missing.
For file-watching development, use `npm run dev`.

The versioned delivery plan is maintained in
[`docs/roadmap.md`](docs/roadmap.md).

The first launch opens a live setup diagnostic that distinguishes a missing
CLI, an unauthenticated account, and a profile that simply has not created its
first session yet. Machine-specific paths are never included in those checks.

### CLI options

| Option | Purpose |
| --- | --- |
| `doctor` | Check Node, Grok CLI, authentication, and local state |
| `agent` | Start the authenticated read-only host agent |
| `--port <number>` | Override dashboard port `4310` or agent port `4311` |
| `--host <address>` | Override the loopback bind address |
| `--grok-home <path>` | Use a specific Grok state directory |
| `--state-dir <path>` | Use a specific private Grok UI state directory |
| `--no-open` | Start without opening a browser |
| `--version` | Print the installed Grok UI version |

## Live runtime

Start `grok` in any workspace and the session appears as soon as its live
process registers. The runtime view projects:

- agent state: working, waiting, idle, or needs input
- current phase and active tool
- structured user, assistant, reasoning, plan, and tool events
- turns, tool calls, context usage, and reported cost
- process identity and workspace

Process liveness is rechecked continuously, so “live now” means an open Grok
process—not a recently modified history file.

## Session control

Grok UI supervises `grok agent --no-leader stdio` and communicates through
the official [Agent Client Protocol](https://agentclientprotocol.com/).

It supports new sessions, `session/load`, prompts, permission requests,
confirmed cancellation, and independently running managed lanes. Stop also
cancels pending permissions, preserves final tool updates, surfaces a retry when
Grok does not confirm, and leaves the lane ready to resume. Rename and archive
actions are local Grok UI overlays; Grok’s own session files are never rewritten.

## Workflow runs

The Runs view listens for Grok’s structured `workflow_updated` notifications on
UI-managed ACP sessions and aggregates them across the command field. Each run
can show:

- current status, objective, phase progression, and latest event
- per-agent state, phase, model, duration, and token usage
- active, used, reserved, and total agent allocation
- derived run-wide token totals with explicit incomplete-usage states
- pause context and final result summary
- Pause, Resume, and Stop controls when the run state supports them

Controls use Grok’s documented `/workflow pause|resume|stop <display-name>`
commands and accept only validated display handles. Persisted snapshots remain
visible after a dashboard restart, but their controls are disabled because Grok
only resumes failed or paused workflows inside the process that owns them.

Grok UI intentionally does not scrape the terminal dashboard or imply visibility
into historical CLI-only workflow runs. A run appears after a UI-managed session
emits its first workflow update.

## Usage ledger

The v0.9 Usage view extends the existing token and cost telemetry with a
durable local ledger. It reports by project, model, session, agent, and time
period, while keeping session totals separate from workflow-agent detail.

Every value says whether it is Grok-reported, derived, incomplete, or
unavailable. Grok UI does not substitute context-window occupancy for
cumulative CLI token usage, and explicitly mixed observation scopes are never
presented as precise spend.

Optional token or reported-cost budgets can be scoped globally or to a project,
model, session, or workflow agent. They are evaluated only against a
non-overlapping ledger scope, and local alerts are deduplicated at 80% and
100%. JSON and CSV exports are capped, authenticated, and redacted on the
server before download whenever Privacy Mode is active.

## Runtime intelligence

The Live view projects bounded process trees from active Grok and UI-managed
process IDs. It discovers listening TCP ports only for that selected process
set, classifies common databases and development services without connecting
to them, and shows structured test status and external-call categories from the
existing safe tool lifecycle.

Inspection uses fixed timeouts, output, process-count, and tree-depth caps. Raw
command arguments, tool input, credentials, headers, terminal history, and
unrelated host processes are never included in the browser contract.

## Multi-machine monitoring

The v0.10 Fleet view monitors up to 32 explicitly registered hosts. Each host
reports a stable identity, Grok UI, agent, and Grok versions, negotiated read
capabilities, health, round-trip latency, last-seen time, and freshness.
Bounded tabs show remote sessions, workflow runs, runtime state, and
provenance-aware usage.

Hosts can be reached in three constrained ways:

- **SSH** — Grok UI manages a fixed loopback forwarding process with
  argument-separated `ssh` options, batch mode, no shell, and no remote command.
- **Tailscale** — the registry accepts only `.ts.net` names or addresses from
  Tailscale's IPv4 or IPv6 ranges.
- **Direct** — an advanced/test transport restricted to HTTP or HTTPS loopback
  origins.

The monitor polls every 5 seconds with a 3.5-second request timeout and at most
four concurrent remote reads globally, including explicit refresh and detail
requests. Per-agent responses are capped at 2 MiB and the central fleet
projection at 4 MiB. A sample becomes stale after 15 seconds and offline after
45 seconds. Connecting, healthy, degraded, stale, offline, incompatible,
unauthorized, and unavailable states remain distinct in the UI.

v0.10 is strictly read-only on remote machines. It cannot remotely start work,
send prompts, approve permissions, pause, resume, interrupt, stop, execute a
shell, write files, or probe arbitrary endpoints. Registering, editing,
refreshing, or removing a host changes only the central monitor configuration
or triggers a read.

## Themes

Two complete visual systems ship with the dashboard:

- **Operator** — carbon black, signal lime, and a precision HUD grid
- **Event Horizon** — deep-space red, cold starlight, and glass command surfaces

Theme selection stays in local browser storage and never changes session data.

## Privacy and security

- The server binds to the loopback interface by default.
- Non-loopback binding requires `GROK_UI_TOKEN`.
- Grok credentials never pass through the browser.
- Persistent Privacy Mode replaces visible session names, paths, identifiers,
  event content, file names, remote host names, and endpoints with stable
  presentation-safe aliases.
- Privacy Mode protects recordings and screen shares; it is not an access-control
  boundary. Authorized browser clients can still receive the underlying local data.
- Authentication cookies are `HttpOnly` and `SameSite=Strict`.
- API responses are non-cacheable and include restrictive security headers.
- Raw system prompts and durable-memory bodies are not indexed.
- File, diff, and event reads are bounded.
- Host-agent reads require a dedicated bearer token, reject redirects, time out
  after 3.5 seconds, and cap responses at 2 MiB.
- Fleet URLs are restricted by transport, and the connector accepts only fixed
  `/agent/v1/` protocol paths.
- Diff access is restricted to workspaces associated with known sessions.
- Grok UI contains no analytics or product telemetry.
- Repository screenshots and diagrams use sanitized demo data only.

For remote use, set a long random token, place TLS or a private tunnel in
front of the server, and bind only to the interface you intend to expose:

```bash
HOST='<bind-address>' \
GROK_UI_TOKEN='<long-random-token>' \
npm start
```

See [SECURITY.md](SECURITY.md) for the full deployment and reporting guidance.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | loopback | API bind interface |
| `PORT` | `4310` | API port |
| `GROK_HOME` | `~/.grok` | Grok state directory |
| `GROK_BIN` | `grok` | Grok executable used by the ACP controller |
| `GROK_UI_TOKEN` | empty | Required for non-loopback binding |
| `GROK_UI_STATE_DIR` | `~/.grok-ui` | Private annotations and managed-session state |
| `GROK_UI_AGENT_TOKEN` | empty | Required dedicated bearer token for host-agent mode |
| `GROK_UI_AGENT_HOST` | `127.0.0.1` | Host-agent bind interface |
| `GROK_UI_AGENT_PORT` | `4311` | Host-agent port |
| `GROK_UI_AGENT_LABEL` | system hostname | Optional host label advertised by the agent |

## Commands

```bash
npm run dev       # Run API and Vite with file watching
npm run doctor    # Check Node, Grok CLI, authentication, and local state
npm run setup     # Run preflight checks and create a production build
npm run check     # Type-check client and server
npm test          # Run unit and integration tests
npm run test:e2e  # Run production browser onboarding and control tests
npm run build     # Produce client and server builds
npm run verify    # Check, test, and build
npm run release:check # Audit the exact package contents
npm run test:package  # Install and launch the packed artifact in isolation
npm start         # Build when needed, then serve the production app
npm run agent     # Serve the built read-only host agent
npm run serve     # Serve an existing production build without rebuilding
```

## Repository map

```text
server/
  grok-controller.ts      ACP lifecycle, prompts, approvals, cancellation
  workflow-state.ts       workflow notification projection and safe controls
  live-monitor.ts         active process and runtime event projection
  usage-ledger.ts         provenance-aware durable usage reporting
  session-projection.ts   shared local session-to-row projection
  host-agent.ts           authenticated read-only host protocol
  fleet-protocol.ts       versioned parsing, caps, and host namespacing
  fleet-registry.ts       atomic private connection registry
  fleet-connectors.ts     bounded direct, Tailscale, and SSH transports
  fleet-monitor.ts        polling, compatibility, health, and freshness
  grok-store.ts           historical metadata aggregation
  session-reader.ts       bounded conversation and tool timeline
  session-state.ts        durable managed lanes and local annotations
  workspace-inspector.ts  live Git status and bounded diff inspection
  security.ts             local and remote access gate
src/
  views/ControlView.tsx   command deck and approval queue
  views/WorkflowsView.tsx cross-session workflow command field
  views/UsageView.tsx     time- and dimension-based usage ledger
  views/FleetView.tsx     fleet page coordination and registry actions
  views/fleet/            status, editor, selectors, and telemetry panels
  views/ChangesView.tsx   live repository change workbench
  views/SessionWorkbench.tsx
                            session timeline and operations
  App.tsx                 dashboard shell and event-stream client
  styles/fleet.css        Fleet-only presentation
```

The longer design and trust-boundary notes live in
[docs/architecture.md](docs/architecture.md). Concrete edit routing and safety
invariants live in [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md).

## Project status

Grok UI is a community project. Its local monitor, control, workbench, runtime,
usage, and Git inspection paths are functional and covered by automated tests.
v0.10 multi-machine monitoring is under verification and remains unreleased
until its completion matrix passes and the user explicitly approves merge,
tag, and publication. Packed releases are installed and launched in isolation
on macOS and Linux CI. Grok Build, ACP, and the fleet protocol can evolve, so
compatibility fixes may be needed for future releases.

## License

MIT — see [LICENSE](LICENSE).
