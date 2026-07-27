# Agent guide

Read `README.md`, `docs/architecture.md`, and the milestone document for the
version being changed before editing. For v0.10, also read
`docs/v0.10-multi-machine-monitoring.md`.

## Edit routing

| Change | Primary files | Keep in sync |
| --- | --- | --- |
| Local session discovery or live projection | `server/grok-store.ts`, `server/live-monitor.ts` | session parser tests and shared types |
| ACP lifecycle, prompts, approvals, or interruption | `server/grok-controller.ts` | controller tests, browser control journeys |
| Workflow projection or local controls | `server/workflow-state.ts` | workflow tests and `src/views/WorkflowsView.tsx` |
| Runtime observation | `server/runtime-inspector.ts` | runtime tests and local/fleet panels |
| Usage projection or provenance | `server/usage-ledger.ts` | state migrations, usage tests and both usage views |
| Host-agent contract | `server/host-agent.ts`, `server/fleet-protocol.ts` | protocol tests, package smoke, architecture docs |
| Fleet registry or transport | `server/fleet-registry.ts`, `server/fleet-connectors.ts` | monitor tests, security docs and package smoke |
| Fleet health state machine | `server/fleet-monitor.ts` | deterministic transition tests and Fleet browser tests |
| Fleet page composition | `src/views/FleetView.tsx` | `src/views/fleet/`, `src/styles/fleet.css` |
| One Fleet telemetry area | matching file in `src/views/fleet/panels/` | parser/types and Privacy Mode browser assertions |
| Browser API contract | `src/api.ts`, `src/types.ts` | client parser tests |
| Milestone behavior | `README.md`, `CHANGELOG.md`, `docs/roadmap.md`, milestone doc | `docs/architecture.md` when boundaries change |

## Invariants

- Local state and controls remain authoritative on each machine.
- v0.10 remote behavior is read-only. Do not add remote prompts, approvals,
  start/pause/resume/interrupt/stop actions, shell execution, arbitrary fetches,
  endpoint discovery, or destructive routes.
- Remote credentials remain server-side. Never return tokens through browser
  APIs, SSE, errors, diagnostics, screenshots, fixtures, or committed state.
- Keep registry persistence transactional and separate from
  `SessionStateStore`.
- Preserve fixed route allowlists, redirect rejection, response caps, bounded
  timeouts, the global read semaphore, and host-scoped identifiers.
- Privacy Mode must cover names, paths, endpoints, content, model/capability
  labels, and error details in every newly reachable UI state.
- Do not edit generated output to implement behavior.

## Risk and approval boundaries

Merging, tagging, publishing to npm, and creating a GitHub release require
explicit user approval. Remote-control work belongs to v0.11 and requires a
separate security design. Do not use destructive Git commands to clean a dirty
worktree or overwrite an existing state file to repair it.

## Expected checks

Run `npm run check` and the closest unit tests during implementation. Before
claiming a milestone complete, run:

```text
npm run verify
npm run test:e2e
npm run test:soak
npm run test:package
npm audit --omit=dev --audit-level=high
git diff --check
```

Review the package contents and final Git diff for credentials, local state,
reports, archives, recordings, and other generated artifacts. Record exact
current results in the milestone verification ledger; do not preserve stale
counts from an earlier commit.
