# Changelog

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
