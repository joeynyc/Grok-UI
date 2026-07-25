# Changelog

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
