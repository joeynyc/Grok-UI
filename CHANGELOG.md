# Changelog

## 0.10.0 — 2026-07-28

- Added a lightweight, bearer-authenticated host agent that reuses the existing
  session, workflow, runtime, and usage projections through a versioned
  read-only protocol.
- Added an atomic, private `fleet.json` registry for up to 32 explicitly trusted
  hosts, separate from existing session and usage state.
- Added managed SSH loopback forwarding with fixed argument-separated options,
  constrained Tailscale endpoints, and an advanced loopback-only direct
  transport.
- Added bounded multi-host polling with a 5-second interval, 3.5-second request
  timeout, global four-read concurrency cap, 2 MiB per-agent and 4 MiB central
  aggregate limits, manual redirect rejection, and exponential failure backoff.
- Added explicit connecting, healthy, degraded, stale, offline, incompatible,
  unauthorized, and unavailable host behavior with latency, last-seen, and
  freshness reporting.
- Added the Fleet view for read-only remote sessions, workflow runs, runtime
  state, and provenance-aware usage, with host-scoped identifiers and Privacy
  Mode aliases.
- Removed remote mutation capability from every host-agent projection:
  workflow controls are forced off, workflow control handles and managed-session
  last-prompt fields are omitted, and the agent rejects methods other than
  `GET` and `HEAD`.
- Expanded the release gate to run the production dependency audit and require
  current multi-host integration, browser, 75-second soak, packed-install,
  privacy, and security evidence.
- Hardened the release candidate after independent architecture review:
  registry writes are transactional and recover after failure, standalone
  usage includes current observers without becoming a second state writer,
  explicit refresh waits for in-flight polling, unchanged fleet frames are
  suppressed, SSH waits for forwarding readiness, and remote detail parsing is
  bounded in both server and browser.
- Invalidated old in-flight observations when connection settings change,
  labeled retained snapshots as historical outside live-compatible states, and
  surfaced preserved registry-load failures directly in the Fleet experience.
- Split the Fleet experience into focused status, editor, selector, telemetry,
  and stylesheet modules with an agent-facing ownership and verification guide.

## 0.9.0 — 2026-07-26

- Started the v0.9 Runtime Intelligence milestone with a persistent,
  provenance-aware usage ledger built on the existing session and workflow
  token telemetry.
- Added time-windowed usage reporting by project, model, session, and agent,
  with separate session and workflow-agent scopes to prevent silent double
  counting.
- Added explicit Grok-reported, derived, incomplete, and unavailable labels,
  including a guard that never treats live context occupancy as cumulative
  token usage.
- Added a privacy-aware Usage view, authenticated usage API, atomic v1-to-v2
  state migration, and coverage for persistence and mixed telemetry.
- Added bounded process-tree and listening-port inspection for known Grok
  process roots, with database, cache, queue, emulator, and development-service
  classification that never probes arbitrary endpoints.
- Added structured test-status and external tool-call panels using existing
  safe telemetry titles, including incomplete interruption state after a
  session or event-stream disconnect.
- Added optional local budgets for global, project, model, session, and agent
  scopes; deduplicated 80% and 100% alerts; and atomic v3 state migration.
- Added bounded JSON/CSV usage exports with Privacy Mode redaction applied by
  the authenticated server before download.

## 0.8.2 — 2026-07-26

- Renamed the session “Workbench” entry points to “Open Session” and labeled
  the focused agent view “Session Console,” with a concise explanation of its
  live chat, activity, and change-review capabilities.
- Added automatic ACP control-channel recovery with exponential backoff,
  interrupted-session diagnostics, and safe session reload after reconnection.
- Added forced browser-stream and ACP-child recovery coverage.
- Made local browser tests build production assets before launching, preventing
  stale ignored output from masking source regressions.
- Added a 75-second managed-session soak to the tagged release gate.
- Added npm trusted-publishing support, manual publication for an existing tag,
  and a release guard that rejects tag/package version mismatches.

## 0.8.1 — 2026-07-25

- Replaced scattered 5–10px dashboard typography with a consistent readable
  scale for micro-labels, metadata, body copy, and controls.
- Improved supporting-text contrast in both Operator and Event Horizon themes
  while preserving intentionally dim disabled states.
- Reworked the 390px bottom navigation into a readable horizontal command rail
  instead of compressing nine labels into colliding fixed columns.
- Added browser coverage that audits visible supporting text across all ten
  dashboard sections and the mobile viewport.

## 0.8.0 — 2026-07-25

- Added real per-agent workflow token usage from Grok Build’s structured
  `workflow_updated` telemetry, with an aggregate total for each run.
- Added agent model, phase, duration, remaining capacity, and elapsed-time
  signals without scraping terminal output.
- Added searchable, paginated workflow rosters that stay responsive when Grok
  scales a workflow toward its 1,024-agent ceiling.
- Added explicit unavailable and incomplete-usage states so derived totals do
  not imply precision Grok has not reported.
- Expanded workflow parser, controller, and browser coverage for token
  telemetry, partial updates, and large agent fields.

## 0.7.0 — 2026-07-25

- Added a cross-session Workflow Command Center powered by Grok Build workflow
  telemetry.
- Added live run status, objectives, phase progression, agent rosters, budget
  usage, latest events, result summaries, and parent-workbench navigation.
- Added run filters and safe Pause, Resume, and Stop controls, with failed-run
  recovery enabled only when Grok reports a recoverable display handle.
- Added persisted workflow snapshots with controls disabled after server
  restarts, and extended Privacy Mode to workflow content.
- Added controller, workflow-state, workbench, and browser coverage for live
  workflow behavior and responsive dashboard presentation.

## 0.6.0 — 2026-07-25

- Added confirmed cancellation states for dashboard-managed Grok turns.
- Cancelled pending permission requests when Stop is issued, as required by ACP.
- Preserved the stopping state while Grok sends final tool and message updates.
- Added retryable timeout and delivery-failure feedback when Stop is not confirmed.
- Added cancellation timestamps, last-completed-tool context, and one-click Resume.
- Added browser coverage for cancellation during permission and active-tool work,
  plus controller coverage for unconfirmed cancellation timeouts.

## 0.5.1 — 2026-07-25

- Made Event Horizon the default visual system for first-time launches.
- Updated the application, repository artwork, and package assets to use the
  current red Grok command mark.
- Added a production browser journey for logged-out onboarding and recovery.
- Added a sanitized 24-second public demo covering live session arrival,
  Control, Changes, Overview, Activity, and theme switching.

## 0.5.0 — 2026-07-24

- Added the installable `grok-ui` executable with browser auto-open, help,
  version, port, host, state-directory, and no-open options.
- Added `grok-ui doctor` and safe in-dashboard setup diagnostics for Node,
  Grok CLI availability, authentication, and first-session state.
- Added a persistent presentation Privacy Mode across runtime, archives,
  workbenches, changes, notifications, and search inputs.
- Added artifact content validation and an isolated packed-package smoke test.
- Added Node 22/24 CI, macOS/Linux package verification, tagged GitHub release
  artifacts, structured issue forms, and a pull-request privacy checklist.
- Prevented ACP startup from blocking the read-only dashboard and first-run
  onboarding.

## 0.4.1 — 2026-07-24

- Replaced the placeholder sidebar glyph with a clean Grok symbol derived from the supplied artwork.
- Added theme-aware logo glow treatments across the sidebar and access screens.

## 0.4.0 — 2026-07-24

- Added a persistent Themes section with live, one-click appearance switching.
- Added the original Operator theme and the image-backed Event Horizon theme.
- Added responsive theme previews and browser-local preference persistence.

## 0.3.1 — 2026-07-24

- Fixed live detection for standalone Grok CLI sessions under `~/.grok`.
- Added regression coverage for Grok homes located inside hidden directories.

## 0.3.0 — 2026-07-24

- Added the full-screen Session Workbench for CLI and dashboard-created sessions.
- Added live conversation, reasoning, tool, plan, permission, and status timelines.
- Added in-context follow-up prompting and ACP attachment for recorded CLI sessions.
- Added per-session Git status and bounded diff inspection.
- Added safe local rename, archive, restore, and managed-turn cancellation actions.
- Added durable managed-session recovery across Grok UI server restarts.
- Added active and archived session filters.

## 0.2.0 — 2026-07-24

- Added native ACP session creation, resume, prompt, and cancellation.
- Added a real permission approval queue.
- Added concurrent managed-agent lanes.
- Added repository status and bounded diff inspection.
- Added live context, token, and cost telemetry.
- Added browser notifications for attention states.
- Added authenticated remote mode and security headers.
- Added responsive Command Deck and Changes views.
- Expanded automated coverage and release documentation.

## 0.1.0

- Initial live Grok runtime dashboard and historical metadata views.
