import type {
  FleetHostView,
  FleetSnapshot,
  SessionRow,
  WorkflowRun,
} from '../../types'

export type FleetTab = 'overview' | 'sessions' | 'workflows' | 'runtime' | 'usage'
export type FleetFilter = 'all' | 'healthy' | 'attention' | 'offline'
export type FleetSectionId = 'sessions' | 'workflows' | 'runtime' | 'usage'
export type SectionAvailability =
  | 'available'
  | 'partial'
  | 'unavailable'
  | 'stale'
  | 'incompatible'
  | 'unauthorized'
  | 'connecting'

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export const integer = new Intl.NumberFormat()
export const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

export function elapsedLabel(value?: string | null): string {
  if (!value) return 'Never'
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 'Unknown'
  const seconds = Math.round((timestamp - Date.now()) / 1_000)
  if (Math.abs(seconds) < 60) return relativeTime.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relativeTime.format(hours, 'hour')
  return relativeTime.format(Math.round(hours / 24), 'day')
}

export function exactTime(value?: string | null): string {
  if (!value) return 'No successful observation'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
}

export function emptyFleet(): FleetSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    protocolVersion: 1,
    registryError: '',
    pollIntervalMs: 0,
    staleAfterMs: 0,
    offlineAfterMs: 0,
    hosts: [],
    totals: {
      hosts: 0,
      healthy: 0,
      degraded: 0,
      stale: 0,
      offline: 0,
      sessions: 0,
      workflows: 0,
    },
  }
}

export function hostEndpoint(host: FleetHostView): string {
  if (host.transport === 'ssh') {
    return `${host.config.sshTarget || 'SSH target unavailable'} → 127.0.0.1:${host.config.localPort || '—'}`
  }
  return host.config.baseUrl || 'Address unavailable'
}

export function hostVersions(host: FleetHostView) {
  return {
    grokUi: host.grokUiVersion || '—',
    agent: host.agentVersion || '—',
    protocol: host.snapshot?.protocolVersion == null ? '—' : String(host.snapshot.protocolVersion),
  }
}

export function capabilities(host: FleetHostView): string[] {
  return host.capabilities || []
}

function hasCapability(host: FleetHostView, capability: FleetSectionId): boolean {
  const available = capabilities(host)
  const expected = capability === 'sessions'
    ? 'sessions.list'
    : capability === 'workflows'
      ? 'workflows.list'
      : capability === 'runtime'
        ? 'runtime.snapshot'
        : 'usage.report'
  return available.includes(expected)
}

export function sectionAvailability(
  host: FleetHostView,
  section: FleetSectionId,
): SectionAvailability {
  if (host.status === 'unauthorized') return host.snapshot ? 'stale' : 'unauthorized'
  if (host.status === 'incompatible') return host.snapshot ? 'stale' : 'incompatible'
  if (host.status === 'connecting') return host.snapshot ? 'stale' : 'connecting'
  if (host.status === 'unavailable') return host.snapshot ? 'stale' : 'unavailable'
  if (host.status === 'stale' || host.status === 'offline') return 'stale'
  if (host.status === 'degraded' && host.consecutiveFailures > 0 && host.snapshot) return 'stale'
  const declared = host.snapshot?.sections[section]
  if (declared) return declared
  return hasCapability(host, section) ? 'available' : 'unavailable'
}

export function sessions(host: FleetHostView): SessionRow[] {
  return (host.snapshot?.sessions || []).slice(0, 100)
}

export function workflows(host: FleetHostView): WorkflowRun[] {
  return (host.snapshot?.workflows || []).slice(0, 100)
}

export function matchesFilter(host: FleetHostView, filter: FleetFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'healthy') return host.status === 'healthy'
  if (filter === 'offline') return host.status === 'offline'
  return ['connecting', 'degraded', 'stale', 'incompatible', 'unauthorized', 'unavailable']
    .includes(host.status)
}

export function isHistoricalHost(host: FleetHostView): boolean {
  return Boolean(host.snapshot)
    && (
      host.consecutiveFailures > 0
      || ['connecting', 'stale', 'offline', 'incompatible', 'unauthorized', 'unavailable']
        .includes(host.status)
    )
}
