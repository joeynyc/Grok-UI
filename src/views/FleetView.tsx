import {
  Activity,
  AlertTriangle,
  Braces,
  Check,
  ChevronRight,
  CircleOff,
  Clock3,
  Database,
  Gauge,
  KeyRound,
  Laptop,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RadioTower,
  RefreshCw,
  Route,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unplug,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  createFleetHost,
  deleteFleetHost,
  getFleetSessionDetail,
  refreshFleetHost,
  updateFleetHost,
} from '../api'
import { usePrivacy } from '../privacy'
import type {
  AgentSessionDetail,
  FleetHostInput,
  FleetHostStatus,
  FleetHostView,
  FleetSnapshot,
  FleetTransportKind,
  RuntimeSnapshot,
  SessionRow,
  UsageReport,
  WorkflowRun,
} from '../types'

type FleetTab = 'overview' | 'sessions' | 'workflows' | 'runtime' | 'usage'
type FleetFilter = 'all' | 'healthy' | 'attention' | 'offline'
type FleetSectionId = 'sessions' | 'workflows' | 'runtime' | 'usage'
type SectionAvailability = 'available' | 'partial' | 'unavailable' | 'stale' | 'incompatible' | 'unauthorized'
type FleetNotice =
  | { kind: 'refreshed'; hostId: string; hostLabel: string }
  | { kind: 'saved'; hostId: string; hostLabel: string }
  | { kind: 'removed' }

const STATUS_META: Record<FleetHostStatus, {
  label: string
  detail: string
  icon: LucideIcon
}> = {
  connecting: {
    label: 'Connecting',
    detail: 'Establishing the authenticated monitor link.',
    icon: LoaderCircle,
  },
  healthy: {
    label: 'Healthy',
    detail: 'Fresh telemetry is arriving inside the expected latency window.',
    icon: Check,
  },
  degraded: {
    label: 'Degraded',
    detail: 'The host is reachable, but some telemetry is delayed or incomplete.',
    icon: AlertTriangle,
  },
  stale: {
    label: 'Stale',
    detail: 'Showing the last known snapshot while the monitor link catches up.',
    icon: Clock3,
  },
  offline: {
    label: 'Offline',
    detail: 'The host is not reachable. Cached data is labeled as historical.',
    icon: Unplug,
  },
  incompatible: {
    label: 'Incompatible',
    detail: 'The host responded with an unsupported protocol version.',
    icon: Braces,
  },
  unauthorized: {
    label: 'Unauthorized',
    detail: 'The host responded, but rejected the configured credential.',
    icon: KeyRound,
  },
  unavailable: {
    label: 'Unavailable',
    detail: 'Monitoring data is not available from this host.',
    icon: CircleOff,
  },
}

const FILTERS: Array<{ id: FleetFilter; label: string }> = [
  { id: 'all', label: 'All hosts' },
  { id: 'healthy', label: 'Healthy' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'offline', label: 'Offline' },
]

const TABS: Array<{ id: FleetTab; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'sessions', label: 'Sessions', icon: Activity },
  { id: 'workflows', label: 'Runs', icon: Workflow },
  { id: 'runtime', label: 'Runtime', icon: Braces },
  { id: 'usage', label: 'Usage', icon: Database },
]

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const integer = new Intl.NumberFormat()
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function elapsedLabel(value?: string | null): string {
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

function exactTime(value?: string | null): string {
  if (!value) return 'No successful observation'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
}

function emptyFleet(): FleetSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    protocolVersion: 1,
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

function hostEndpoint(host: FleetHostView): string {
  if (host.transport === 'ssh') {
    return `${host.config.sshTarget || 'SSH target unavailable'} → 127.0.0.1:${host.config.localPort || '—'}`
  }
  return host.config.baseUrl || 'Address unavailable'
}

function hostVersions(host: FleetHostView) {
  return {
    grokUi: host.grokUiVersion || '—',
    agent: host.agentVersion || '—',
    protocol: host.snapshot?.protocolVersion == null ? '—' : String(host.snapshot.protocolVersion),
  }
}

function capabilities(host: FleetHostView): string[] {
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

function sectionAvailability(host: FleetHostView, section: FleetSectionId): SectionAvailability {
  if (host.status === 'unauthorized') return 'unauthorized'
  if (host.status === 'incompatible') return 'incompatible'
  if (host.status === 'stale' || host.status === 'offline') return 'stale'
  const declared = host.snapshot?.sections[section]
  if (declared) return declared
  return hasCapability(host, section) ? 'available' : 'unavailable'
}

function sessions(host: FleetHostView): SessionRow[] {
  return (host.snapshot?.sessions || []).slice(0, 100)
}

function workflows(host: FleetHostView): WorkflowRun[] {
  return (host.snapshot?.workflows || []).slice(0, 100)
}

function matchesFilter(host: FleetHostView, filter: FleetFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'healthy') return host.status === 'healthy'
  if (filter === 'offline') return host.status === 'offline'
  return ['connecting', 'degraded', 'stale', 'incompatible', 'unauthorized', 'unavailable'].includes(host.status)
}

export function FleetView({
  fleet,
  streamConnected,
  error: fleetError,
  onReload,
  onFleetChange,
}: {
  fleet: FleetSnapshot | null
  streamConnected: boolean
  error: string
  onReload: () => Promise<void>
  onFleetChange: (fleet: FleetSnapshot) => void
}) {
  const privacy = usePrivacy()
  const hosts = fleet?.hosts || []
  const [selectedId, setSelectedId] = useState(hosts[0]?.id || '')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FleetFilter>('all')
  const [tab, setTab] = useState<FleetTab>('overview')
  const [editorHost, setEditorHost] = useState<FleetHostView | 'new' | null>(null)
  const [refreshingId, setRefreshingId] = useState('')
  const [notice, setNotice] = useState<FleetNotice | null>(null)
  const [actionError, setActionError] = useState('')

  const visibleHosts = useMemo(() => {
    const normalized = privacy.enabled ? '' : query.trim().toLowerCase()
    return hosts.filter((host) => {
      const identity = host.host
      const searchable = [
        host.label,
        host.config.baseUrl,
        host.config.sshTarget,
        identity?.hostname || '',
        identity?.label || '',
        host.transport,
        host.status,
      ]
      return matchesFilter(host, filter)
        && (!normalized || searchable.some((item) => item.toLowerCase().includes(normalized)))
    })
  }, [filter, hosts, privacy.enabled, query])

  useEffect(() => {
    if (!hosts.length) {
      setSelectedId('')
      return
    }
    if (!hosts.some((host) => host.id === selectedId)) setSelectedId(hosts[0].id)
  }, [hosts, selectedId])

  useEffect(() => {
    if (!privacy.enabled) return
    setQuery('')
  }, [privacy.enabled])

  const selected = hosts.find((host) => host.id === selectedId) || visibleHosts[0] || hosts[0]
  const healthy = hosts.filter((host) => host.status === 'healthy').length
  const attention = hosts.filter((host) =>
    ['degraded', 'stale', 'incompatible', 'unauthorized', 'unavailable'].includes(host.status)).length
  const activeSessions = hosts.reduce((total, host) =>
    total + sessions(host).filter((session) => session.status === 'live' || session.status === 'attention').length, 0)

  const refreshHost = async (host: FleetHostView) => {
    setRefreshingId(host.id)
    setActionError('')
    try {
      const next = await refreshFleetHost(host.id)
      onFleetChange(next)
      setNotice({ kind: 'refreshed', hostId: host.id, hostLabel: host.label })
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : 'Unable to refresh host.')
    } finally {
      setRefreshingId('')
    }
  }
  const noticeText = notice?.kind === 'removed'
    ? 'Host removed from the local registry. No remote data was changed.'
    : notice?.kind === 'saved'
      ? `${privacy.host(notice.hostLabel, notice.hostId)} saved to the local registry.`
      : notice?.kind === 'refreshed'
        ? `Refresh requested for ${privacy.host(notice.hostLabel, notice.hostId)}.`
        : ''

  return (
    <>
      <header className="page-intro fleet-intro">
        <div className="intro-index">09 / 12</div>
        <div>
          <div className="kicker"><Network size={14} /> Multi-machine monitoring</div>
          <h1>Every host.<br /><em>One quiet orbit.</em></h1>
        </div>
        <p>
          Authenticated, read-only telemetry across trusted SSH and Tailscale links.
          Remote commands stay outside this release.
        </p>
        <div className="intro-rule"><span /></div>
      </header>

      <section className="fleet-constellation" aria-label="Fleet health summary">
        <div className="constellation-field" aria-hidden="true">
          <i className="constellation-orbit orbit-one" />
          <i className="constellation-orbit orbit-two" />
          <i className="constellation-link link-one" />
          <i className="constellation-link link-two" />
          <span className="constellation-core"><Network size={22} /></span>
          {hosts.slice(0, 8).map((host, index) => (
            <span
              className={`constellation-node node-${index + 1} status-${host.status}`}
              key={host.id}
            />
          ))}
        </div>
        <div className="fleet-summary-grid">
          <FleetMetric label="Registered" value={hosts.length} detail="trusted monitor entries" />
          <FleetMetric label="Healthy" value={healthy} detail="fresh authenticated links" tone="healthy" />
          <FleetMetric label="Needs attention" value={attention} detail="degraded, stale, or blocked" tone={attention ? 'attention' : ''} />
          <FleetMetric label="Active sessions" value={activeSessions} detail="observed across the fleet" />
        </div>
        <div className="fleet-trust-note">
          <ShieldCheck size={16} />
          <span><strong>REMOTE / READ ONLY</strong> Session, workflow, runtime, and usage snapshots only.</span>
        </div>
      </section>

      <section className="fleet-toolbar" aria-label="Fleet registry controls">
        <label className="fleet-search">
          <span className="sr-only">Search registered hosts</span>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            name="fleet-search"
            autoComplete="off"
            value={privacy.enabled ? '' : query}
            placeholder="Search hosts, status, or transport…"
            onChange={(event) => setQuery(event.target.value)}
          />
          {!privacy.enabled && query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear fleet search">
              <X size={14} />
            </button>
          )}
        </label>
        <div className="fleet-filter" role="group" aria-label="Filter hosts by health">
          {FILTERS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={filter === item.id ? 'is-active' : ''}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button className="fleet-add-host" type="button" onClick={() => setEditorHost('new')}>
          <Plus size={15} /> Register host
        </button>
      </section>

      {(fleetError || actionError || noticeText) && (
        <div
          className={`fleet-notice ${fleetError || actionError ? 'is-error' : 'is-success'}`}
          role={fleetError || actionError ? 'alert' : 'status'}
        >
          {fleetError || actionError ? <ShieldAlert size={16} /> : <Check size={16} />}
          <span>{fleetError || actionError ? privacy.content(fleetError || actionError) : noticeText}</span>
        </div>
      )}

      <section className="fleet-layout section-gap">
        <aside className="fleet-registry" aria-label="Registered hosts">
          <header>
            <div><span>HOST REGISTRY</span><strong>{visibleHosts.length} / {hosts.length}</strong></div>
            <small className={streamConnected ? 'is-live' : ''}><i /> {streamConnected ? 'Fleet stream live' : 'Stream reconnecting'}</small>
          </header>
          <div className="fleet-host-list">
            {visibleHosts.map((host) => (
              <button
                type="button"
                className={`fleet-host-row ${selected?.id === host.id ? 'is-active' : ''}`}
                aria-pressed={selected?.id === host.id}
                onClick={() => {
                  setSelectedId(host.id)
                  setTab('overview')
                }}
                key={host.id}
              >
                <span className="fleet-host-icon"><Laptop size={16} /></span>
                <span className="fleet-host-copy">
                  <strong>{privacy.host(host.label, host.id)}</strong>
                  <small>{privacy.endpoint(hostEndpoint(host))}</small>
                </span>
                <FleetStatusBadge status={host.status} compact />
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ))}
            {!visibleHosts.length && (
              <div className="fleet-empty-list">
                <RadioTower size={23} />
                <strong>{hosts.length ? 'No hosts match this filter.' : 'No remote hosts registered.'}</strong>
                <span>{hosts.length ? 'Adjust the search or health filter.' : 'Register a trusted SSH or Tailscale host to begin.'}</span>
              </div>
            )}
          </div>
        </aside>

        {selected ? (
          <article className="fleet-inspector">
            <header className="fleet-host-head">
              <div className="fleet-host-identity">
                <FleetStatusBadge status={selected.status} />
                <span>REMOTE HOST / {privacy.identifier(selected.id)}</span>
                <h2>{privacy.host(selected.label, selected.id)}</h2>
                <p>
                  <Route size={14} />
                  {selected.transport.toUpperCase()} · {privacy.endpoint(hostEndpoint(selected))}
                </p>
              </div>
              <div className="fleet-host-actions">
                <span className="fleet-readonly-lock"><ShieldCheck size={14} /> Read only</span>
                <button
                  type="button"
                  onClick={() => void refreshHost(selected)}
                  aria-label={`Refresh ${privacy.host(selected.label, selected.id)}`}
                  disabled={refreshingId === selected.id}
                >
                  <RefreshCw className={refreshingId === selected.id ? 'is-spinning' : ''} size={15} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => setEditorHost(selected)}
                  aria-label={`Edit registry entry for ${privacy.host(selected.label, selected.id)}`}
                >
                  <Pencil size={15} /> Edit
                </button>
              </div>
            </header>

            <HostStatusNarrative host={selected} />

            <nav className="fleet-tabs" role="tablist" aria-label="Remote host telemetry">
              {TABS.map((item) => {
                const Icon = item.icon
                const section = item.id === 'overview' ? null : item.id as FleetSectionId
                const available = !section || sectionAvailability(selected, section) === 'available'
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === item.id}
                    aria-controls={`fleet-panel-${item.id}`}
                    className={tab === item.id ? 'is-active' : ''}
                    onClick={() => setTab(item.id)}
                    key={item.id}
                  >
                    <Icon size={14} />
                    {item.label}
                    {!available && <i aria-label="Unavailable" />}
                  </button>
                )
              })}
            </nav>

            <div
              className="fleet-panel"
              id={`fleet-panel-${tab}`}
              role="tabpanel"
              aria-label={`${TABS.find((item) => item.id === tab)?.label} for ${privacy.host(selected.label, selected.id)}`}
            >
              {tab === 'overview' && <FleetOverview host={selected} />}
              {tab === 'sessions' && <FleetSessions host={selected} />}
              {tab === 'workflows' && <FleetWorkflows host={selected} />}
              {tab === 'runtime' && <FleetRuntime host={selected} />}
              {tab === 'usage' && <FleetUsage host={selected} />}
            </div>
          </article>
        ) : (
          <div className="fleet-inspector fleet-inspector-empty">
            <Network size={32} />
            <h2>The constellation is ready.</h2>
            <p>Choose a registered host or add the first trusted monitor link.</p>
            <button type="button" onClick={() => setEditorHost('new')}><Plus size={15} /> Register host</button>
          </div>
        )}
      </section>

      {editorHost && (
        <HostEditor
          host={editorHost === 'new' ? null : editorHost}
          onClose={() => setEditorHost(null)}
          onSaved={(next, hostId) => {
            onFleetChange(next)
            setSelectedId(hostId)
            setEditorHost(null)
            const saved = next.hosts.find((item) => item.id === hostId)
            setNotice({ kind: 'saved', hostId, hostLabel: saved?.label || 'Host' })
          }}
          onRemoved={(id) => {
            const current = fleet || emptyFleet()
            onFleetChange({ ...current, hosts: current.hosts.filter((host) => host.id !== id) })
            setEditorHost(null)
            setNotice({ kind: 'removed' })
            void onReload()
          }}
        />
      )}
    </>
  )
}

function FleetMetric({
  label,
  value,
  detail,
  tone = '',
}: {
  label: string
  value: number
  detail: string
  tone?: string
}) {
  return (
    <div className={`fleet-metric ${tone ? `is-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{integer.format(value)}</strong>
      <small>{detail}</small>
    </div>
  )
}

function FleetStatusBadge({ status, compact = false }: { status: FleetHostStatus; compact?: boolean }) {
  const meta = STATUS_META[status] || STATUS_META.unavailable
  const Icon = meta.icon
  return (
    <span className={`fleet-status status-${status} ${compact ? 'is-compact' : ''}`} role="status">
      <Icon className={status === 'connecting' ? 'is-spinning' : ''} size={compact ? 12 : 13} />
      <span>{meta.label}</span>
    </span>
  )
}

function HostStatusNarrative({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const meta = STATUS_META[host.status] || STATUS_META.unavailable
  const detail = host.statusDetail || meta.detail
  return (
    <div className={`fleet-status-narrative status-${host.status}`} role="status" aria-live="polite">
      <div>
        <strong>{meta.label}</strong>
        <span>{privacy.content(detail)}</span>
      </div>
      <div>
        <span>Last seen</span>
        <strong title={exactTime(host.lastSeen)}>{elapsedLabel(host.lastSeen)}</strong>
      </div>
      <div>
        <span>Latency</span>
        <strong>{host.latencyMs === null ? '—' : `${decimal.format(host.latencyMs)} ms`}</strong>
      </div>
      <div>
        <span>Freshness</span>
        <strong>{host.freshness}</strong>
      </div>
    </div>
  )
}

function FleetOverview({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const versions = hostVersions(host)
  const hostCapabilities = capabilities(host)
  const identity = host.host
  const observedSessions = sessions(host)
  const observedWorkflows = workflows(host)
  const liveCount = observedSessions.filter((session) =>
    session.status === 'live' || session.status === 'attention').length
  const runtime = host.snapshot?.runtime
  const usage = host.snapshot?.usage

  return (
    <div className="fleet-overview">
      <section className="fleet-overview-card fleet-identity-card">
        <header><Server size={15} /><span>HOST IDENTITY</span></header>
        <dl>
          <div><dt>Hostname</dt><dd>{identity ? privacy.host(identity.label || identity.hostname, host.id) : 'Unavailable'}</dd></div>
          <div><dt>Platform</dt><dd>{identity?.platform || '—'}</dd></div>
          <div><dt>Architecture</dt><dd>{identity?.arch || '—'}</dd></div>
          <div><dt>Transport</dt><dd>{host.transport.toUpperCase()}</dd></div>
        </dl>
      </section>
      <section className="fleet-overview-card">
        <header><Braces size={15} /><span>VERSION NEGOTIATION</span></header>
        <dl>
          <div><dt>Grok UI</dt><dd>{versions.grokUi}</dd></div>
          <div><dt>Host agent</dt><dd>{versions.agent}</dd></div>
          <div><dt>Protocol</dt><dd>{versions.protocol}</dd></div>
          <div><dt>Compatibility</dt><dd>{host.status === 'incompatible' ? 'Update required' : 'Negotiated'}</dd></div>
        </dl>
      </section>
      <section className="fleet-overview-card fleet-capabilities-card">
        <header><Zap size={15} /><span>READ CAPABILITIES</span></header>
        <div>
          {(hostCapabilities.length ? hostCapabilities : ['No capabilities advertised']).map((capability) => (
            <span key={capability}><i /> {capability.replaceAll('_', ' ')}</span>
          ))}
        </div>
      </section>
      <section className="fleet-observation-strip" aria-label="Remote telemetry counts">
        <div><Activity size={16} /><span>Sessions</span><strong>{observedSessions.length}</strong><small>{liveCount} active</small></div>
        <div><Workflow size={16} /><span>Runs</span><strong>{observedWorkflows.length}</strong><small>read-only projection</small></div>
        <div><Braces size={16} /><span>Processes</span><strong>{runtime?.processes.length || 0}</strong><small>bounded descendants</small></div>
        <div><Database size={16} /><span>Tokens</span><strong>{usage?.totals.totalTokens.value == null ? '—' : integer.format(usage.totals.totalTokens.value)}</strong><small>{usage?.totals.totalTokens.source || 'unavailable'}</small></div>
      </section>
      <p className="fleet-readonly-explainer">
        <ShieldCheck size={15} />
        This monitor can read negotiated snapshots only. It cannot start work, send prompts,
        resolve permissions, control runs, execute a shell, or probe arbitrary endpoints.
      </p>
    </div>
  )
}

function SectionState({
  host,
  section,
  children,
}: {
  host: FleetHostView
  section: FleetSectionId
  children: React.ReactNode
}) {
  const availability = sectionAvailability(host, section)
  if (availability === 'available') return children
  if (availability === 'partial') {
    return (
      <>
        <div className="fleet-partial-note" role="status">
          <AlertTriangle size={14} />
          This host reported a partial {section} snapshot. Displayed values may be incomplete.
        </div>
        {children}
      </>
    )
  }
  if (availability === 'stale' && host.snapshot) {
    return (
      <>
        <div className="fleet-partial-note is-stale" role="status">
          <Clock3 size={14} />
          Cached {section} snapshot from {elapsedLabel(host.lastSeen)}. Values are not live.
        </div>
        {children}
      </>
    )
  }
  const detail = availability === 'stale'
      ? 'The live link is unavailable. This section has no fresh snapshot to display.'
      : availability === 'unauthorized'
        ? 'The host rejected the configured monitor credential.'
        : availability === 'incompatible'
          ? 'This section uses a protocol version the central monitor cannot read.'
          : `The host agent did not advertise the ${section} capability.`
  return (
    <div className={`fleet-section-state is-${availability}`}>
      <CircleOff size={25} />
      <strong>{section[0].toUpperCase() + section.slice(1)} unavailable</strong>
      <span>{detail}</span>
    </div>
  )
}

function FleetSessions({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const observed = sessions(host)
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null)
  const [loadingId, setLoadingId] = useState('')
  const [error, setError] = useState('')
  const inspect = async (session: SessionRow) => {
    setLoadingId(session.id)
    setError('')
    try {
      setDetail(await getFleetSessionDetail(host.id, session.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to read the remote session.')
    } finally {
      setLoadingId('')
    }
  }
  return (
    <SectionState host={host} section="sessions">
      {observed.length ? (
        <>
          {error && <div className="fleet-partial-note" role="alert"><AlertTriangle size={14} /> {privacy.content(error)}</div>}
          <div className="fleet-table-wrap">
            <table className="fleet-table fleet-session-table">
              <caption className="sr-only">Read-only sessions observed on this host</caption>
              <thead><tr><th>Status</th><th>Session</th><th>Workspace</th><th>Model</th><th>Turns</th><th>Updated</th><th><span className="sr-only">Inspect</span></th></tr></thead>
              <tbody>
                {observed.map((session) => (
                  <tr key={`${host.id}:${session.id}`}>
                    <td><span className={`fleet-session-state state-${session.status}`}><i /> {session.status}</span></td>
                    <td><strong>{privacy.sessionTitle(session.title, `${host.id}:${session.id}`)}</strong><small>{privacy.content(session.summary)}</small></td>
                    <td>{privacy.workspace(session.workspace || session.cwd)}</td>
                    <td>{session.model ? privacy.capability(session.model, 'Model') : '—'}</td>
                    <td>{integer.format(session.turns)}</td>
                    <td title={exactTime(session.updatedAt)}>{elapsedLabel(session.updatedAt)}</td>
                    <td>
                      <button
                        className="fleet-inspect-session"
                        type="button"
                        onClick={() => void inspect(session)}
                        disabled={loadingId === session.id}
                        aria-label={`Inspect read-only session ${privacy.sessionTitle(session.title, `${host.id}:${session.id}`)}`}
                      >
                        {loadingId === session.id ? <LoaderCircle className="is-spinning" size={13} /> : <ChevronRight size={13} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail && (
            <section className="fleet-session-detail" aria-label={`Read-only session detail for ${privacy.sessionTitle(detail.session.title, detail.session.id)}`}>
              <header>
                <div><span>REMOTE SESSION / READ ONLY</span><h3>{privacy.sessionTitle(detail.session.title, detail.session.id)}</h3></div>
                <button type="button" onClick={() => setDetail(null)} aria-label="Close remote session detail"><X size={15} /></button>
              </header>
              <div className="fleet-session-detail-meta">
                <span><small>Workspace</small><strong>{privacy.workspace(detail.session.cwd)}</strong></span>
                <span><small>Model</small><strong>{detail.session.model || '—'}</strong></span>
                <span><small>Turns</small><strong>{detail.session.turns}</strong></span>
                <span><small>Tools</small><strong>{detail.session.toolCalls}</strong></span>
              </div>
              <div className="fleet-session-transcript" aria-live="polite">
                {detail.transcript.slice(-80).map((item) => (
                  <article key={item.id}>
                    <header><strong>{item.type}</strong><time>{elapsedLabel(item.timestamp)}</time></header>
                    <p>{privacy.content(item.text || item.title)}</p>
                  </article>
                ))}
                {!detail.transcript.length && <p>No transcript events were included in this bounded detail.</p>}
              </div>
            </section>
          )}
        </>
      ) : <FleetPanelEmpty icon={Activity} title="No remote sessions observed" copy="The host is healthy, but its bounded session snapshot is empty." />}
    </SectionState>
  )
}

function FleetWorkflows({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const observed = workflows(host)
  return (
    <SectionState host={host} section="workflows">
      {observed.length ? (
        <div className="fleet-run-grid">
          {observed.map((run) => (
            <article className="fleet-run-card" key={`${host.id}:${run.sessionId}:${run.id}`}>
              <header>
                <span className={`fleet-run-status status-${run.status}`}><i /> {run.status.replaceAll('-', ' ')}</span>
                <small title={exactTime(run.updatedAt)}>{elapsedLabel(run.updatedAt)}</small>
              </header>
              <h3>{privacy.capability(run.displayName, 'Run')}</h3>
              <p>{privacy.content(run.objective || run.lastEventDetail || 'No objective was reported.')}</p>
              <div className="fleet-run-progress">
                <span><i style={{ width: `${run.phases.length ? Math.round((run.phases.filter((phase) => phase.status === 'completed').length / run.phases.length) * 100) : 0}%` }} /></span>
                <small>{run.currentPhase ? privacy.capability(run.currentPhase, 'Phase') : 'No active phase'}</small>
              </div>
              <dl>
                <div><dt>Agents</dt><dd>{run.activeAgents} active / {run.agentsUsed} used</dd></div>
                <div><dt>Tokens</dt><dd>{run.tokenTelemetryAvailable ? integer.format(run.totalTokens) : 'Unavailable'}</dd></div>
                <div><dt>Last event</dt><dd>{privacy.content(run.lastEvent.replaceAll('_', ' ') || 'workflow update')}</dd></div>
              </dl>
              {run.agents.length > 0 && (
                <div className="fleet-agent-roster">
                  {run.agents.slice(0, 8).map((agent) => (
                    <span key={agent.id}>
                      <i className={`state-${agent.status.replaceAll('_', '-')}`} />
                      <strong>{privacy.capability(agent.label, 'Agent')}</strong>
                      <small>{agent.model ? privacy.capability(agent.model, 'Model') : agent.status}</small>
                    </span>
                  ))}
                  {run.agents.length > 8 && <em>+{run.agents.length - 8} more agents</em>}
                </div>
              )}
            </article>
          ))}
        </div>
      ) : <FleetPanelEmpty icon={Workflow} title="No workflow runs observed" copy="The agent reported no workflow telemetry in its current bounded snapshot." />}
    </SectionState>
  )
}

function FleetRuntime({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const runtime: RuntimeSnapshot | null | undefined = host.snapshot?.runtime
  return (
    <SectionState host={host} section="runtime">
      {runtime ? (
        <div className="fleet-runtime">
          {runtime.error && <div className="fleet-runtime-warning"><AlertTriangle size={14} /> {privacy.content(runtime.error)}</div>}
          <section className="fleet-runtime-counts">
            <div><Braces size={15} /><span>Processes</span><strong>{runtime.processes.length}</strong></div>
            <div><RadioTower size={15} /><span>Ports</span><strong>{runtime.ports.length}</strong></div>
            <div><Server size={15} /><span>Services</span><strong>{runtime.services.length}</strong></div>
            <div><Activity size={15} /><span>Tests</span><strong>{runtime.tests.length}</strong></div>
          </section>
          <div className="fleet-runtime-grid">
            <section>
              <header><span>BOUNDED DESCENDANTS</span><small>{runtime.partial ? 'Partial' : runtime.available ? 'Available' : 'Unavailable'}</small></header>
              {runtime.processes.slice(0, 24).map((process) => (
                <div className="fleet-process-row" key={`${host.id}:${process.pid}`}>
                  <i className={`state-${process.state}`} />
                  <span><strong>{privacy.capability(process.name, 'Process')}</strong><small>{process.elapsed} · depth {process.depth}</small></span>
                  <em>{privacy.enabled ? 'PID ••••' : `PID ${process.pid}`}</em>
                </div>
              ))}
              {!runtime.processes.length && <p>No descendant processes reported.</p>}
            </section>
            <section>
              <header><span>SERVICES & SIGNALS</span><small>Metadata only</small></header>
              {runtime.services.slice(0, 12).map((service) => (
                <div className="fleet-service-row" key={`${host.id}:${service.id}`}>
                  <Server size={14} />
                  <span><strong>{privacy.capability(service.name, 'Service')}</strong><small>{service.kind} · {service.bind}</small></span>
                  <em>{privacy.enabled ? 'PORT ••••' : service.port ? `:${service.port}` : service.status}</em>
                </div>
              ))}
              {runtime.tests.slice(0, 8).map((test) => (
                <div className="fleet-service-row" key={`${host.id}:${test.id}`}>
                  <Activity size={14} />
                  <span><strong>{privacy.content(test.title)}</strong><small>{privacy.capability(test.framework, 'Framework')}</small></span>
                  <em>{test.status}</em>
                </div>
              ))}
              {!runtime.services.length && !runtime.tests.length && <p>No services or structured test signals reported.</p>}
            </section>
          </div>
          <p className="fleet-boundary-note">Remote runtime data is supplied by the bounded host agent. This browser does not connect to discovered ports or services.</p>
        </div>
      ) : <FleetPanelEmpty icon={Braces} title="No runtime snapshot" copy="Runtime monitoring is advertised, but the host has not delivered a snapshot." />}
    </SectionState>
  )
}

function FleetUsage({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const usage: UsageReport | null | undefined = host.snapshot?.usage
  return (
    <SectionState host={host} section="usage">
      {usage ? (
        <div className="fleet-usage">
          <section className="fleet-usage-summary">
            <div><span>Total tokens</span><strong>{usage.totals.totalTokens.value == null ? '—' : integer.format(usage.totals.totalTokens.value)}</strong><small>{usage.totals.totalTokens.source}</small></div>
            <div><span>Observations</span><strong>{integer.format(usage.entries.length)}</strong><small>{usage.scope.replaceAll('-', ' ')}</small></div>
            <div><span>Coverage</span><strong>{integer.format(Object.values(usage.coverage).reduce((sum, value) => sum + value, 0))}</strong><small>provenance labels</small></div>
          </section>
          <div className="fleet-table-wrap">
            <table className="fleet-table fleet-usage-table">
              <caption className="sr-only">Read-only usage groups observed on this host</caption>
              <thead><tr><th>{usage.groupBy}</th><th>Sessions</th><th>Input</th><th>Output</th><th>Total</th><th>Source</th></tr></thead>
              <tbody>
                {usage.groups.slice(0, 100).map((group) => {
                  const label = usage.groupBy === 'project'
                    ? privacy.workspace(group.label)
                    : usage.groupBy === 'session'
                      ? privacy.sessionTitle(group.label, `${host.id}:${group.key}`)
                      : usage.groupBy === 'agent'
                        ? privacy.capability(group.label, 'Agent')
                        : privacy.capability(group.label, 'Model')
                  return (
                    <tr key={`${host.id}:${group.key}`}>
                      <td><strong>{label}</strong><small>{group.entries} observations</small></td>
                      <td>{integer.format(group.sessions)}</td>
                      <td>{group.inputTokens.value == null ? '—' : integer.format(group.inputTokens.value)}</td>
                      <td>{group.outputTokens.value == null ? '—' : integer.format(group.outputTokens.value)}</td>
                      <td><strong>{group.totalTokens.value == null ? '—' : integer.format(group.totalTokens.value)}</strong></td>
                      <td><span className={`fleet-usage-source source-${group.totalTokens.source}`}>{group.totalTokens.source}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="fleet-boundary-note">This is a read-only remote ledger projection. Budgets and alerts remain owned by their local host.</p>
        </div>
      ) : <FleetPanelEmpty icon={Database} title="No usage snapshot" copy="Usage monitoring is advertised, but the host has not delivered a report." />}
    </SectionState>
  )
}

function FleetPanelEmpty({ icon: Icon, title, copy }: { icon: LucideIcon; title: string; copy: string }) {
  return (
    <div className="fleet-section-state">
      <Icon size={25} />
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  )
}

function HostEditor({
  host,
  onClose,
  onSaved,
  onRemoved,
}: {
  host: FleetHostView | null
  onClose: () => void
  onSaved: (fleet: FleetSnapshot, hostId: string) => void
  onRemoved: (id: string) => void
}) {
  const privacy = usePrivacy()
  const [label, setLabel] = useState(privacy.enabled && host ? '' : host?.label || '')
  const [transport, setTransport] = useState<FleetTransportKind>(host?.transport || 'tailscale')
  const [baseUrl, setBaseUrl] = useState(privacy.enabled && host ? '' : host?.config.baseUrl || '')
  const [sshTarget, setSshTarget] = useState(privacy.enabled && host ? '' : host?.config.sshTarget || '')
  const [sshPort, setSshPort] = useState(String(host?.config.sshPort || 22))
  const [localPort, setLocalPort] = useState(String(host?.config.localPort || 4312))
  const [remotePort, setRemotePort] = useState(String(host?.config.remotePort || 4311))
  const [enabled, setEnabled] = useState(host?.config.enabled !== false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const editorRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const editor = editorRef.current
    const focusable = () => [...(editor?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || [])].filter((element) => element.offsetParent !== null)
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onClose])

  useEffect(() => {
    if (!privacy.enabled || !host) return
    setLabel('')
    setBaseUrl('')
    setSshTarget('')
    setToken('')
  }, [host, privacy.enabled])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!host && !label.trim()) return
    setBusy(true)
    setError('')
    const input: FleetHostInput = {
      transport,
      enabled,
    }
    if (label.trim()) input.label = label.trim()
    if (transport === 'ssh') {
      if (sshTarget.trim()) input.sshTarget = sshTarget.trim()
      input.sshPort = Number(sshPort)
      input.localPort = Number(localPort)
      input.remotePort = Number(remotePort)
    } else if (baseUrl.trim()) {
      input.baseUrl = baseUrl.trim()
    }
    if (token) input.token = token
    try {
      const result = host
        ? await updateFleetHost(host.id, input)
        : await createFleetHost(input)
      onSaved(result.fleet, result.host.id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save host.')
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!host) return
    setBusy(true)
    setError('')
    try {
      await deleteFleetHost(host.id)
      onRemoved(host.id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to remove host.')
      setBusy(false)
    }
  }

  return createPortal((
    <div className="fleet-editor-layer" role="dialog" aria-modal="true" aria-labelledby="fleet-editor-title">
      <button className="fleet-editor-scrim" type="button" onClick={onClose} aria-label="Close host registry editor" />
      <form className="fleet-editor" onSubmit={submit} ref={editorRef}>
        <header>
          <div>
            <span>LOCAL HOST REGISTRY</span>
            <h2 id="fleet-editor-title">{host ? 'Edit monitor link' : 'Register a host'}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close host registry editor"><X size={18} /></button>
        </header>
        <p>
          Connection settings stay on this central machine. The host agent exposes negotiated,
          read-only telemetry only.
        </p>
        {privacy.enabled && host && (
          <div className="fleet-editor-privacy"><ShieldCheck size={14} /> Sensitive values are hidden. Leave a field blank to keep its current value.</div>
        )}
        <div className="fleet-editor-grid">
          <label>
            <span>Display name</span>
            <input
              name="label"
              autoComplete="off"
              value={label}
              required={!host}
              maxLength={160}
              placeholder={privacy.enabled && host ? 'Unchanged while Privacy Mode is active' : 'Build workstation…'}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            <span>Transport</span>
            <select name="transport" value={transport} onChange={(event) => setTransport(event.target.value as FleetTransportKind)}>
              <option value="tailscale">Tailscale</option>
              <option value="ssh">SSH tunnel</option>
              <option value="direct">Direct (advanced / test)</option>
            </select>
          </label>
          {transport !== 'ssh' ? (
            <label className="fleet-editor-wide">
              <span>{transport === 'tailscale' ? 'Tailscale agent URL' : 'Loopback agent URL'}</span>
              <input
                name="baseUrl"
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={baseUrl}
                required={!host}
                placeholder={privacy.enabled && host
                  ? 'Unchanged while Privacy Mode is active'
                  : transport === 'tailscale'
                    ? 'https://studio-node.tailnet.ts.net:4311…'
                    : 'http://127.0.0.1:4311…'}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="fleet-editor-wide">
                <span>SSH target</span>
                <input
                  name="sshTarget"
                  autoComplete="off"
                  spellCheck={false}
                  value={sshTarget}
                  required={!host}
                  placeholder={privacy.enabled && host ? 'Unchanged while Privacy Mode is active' : 'operator@build-host…'}
                  onChange={(event) => setSshTarget(event.target.value)}
                />
              </label>
              <label>
                <span>SSH port</span>
                <input name="sshPort" type="number" min="1" max="65535" inputMode="numeric" value={sshPort} onChange={(event) => setSshPort(event.target.value)} />
              </label>
              <label>
                <span>Local tunnel port</span>
                <input name="localPort" type="number" min="1" max="65535" inputMode="numeric" value={localPort} onChange={(event) => setLocalPort(event.target.value)} />
              </label>
              <label>
                <span>Remote agent port</span>
                <input name="remotePort" type="number" min="1" max="65535" inputMode="numeric" value={remotePort} onChange={(event) => setRemotePort(event.target.value)} />
              </label>
            </>
          )}
          <label>
            <span>Agent token {host ? '(optional replacement)' : ''}</span>
            <input
              name="token"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={token}
              required={!host}
              placeholder={host ? 'Leave blank to keep current token' : 'Paste a host-agent token…'}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label className="fleet-enabled-toggle">
            <input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span><strong>Monitor enabled</strong><small>Poll this host on the registry schedule.</small></span>
          </label>
        </div>
        {error && <div className="fleet-editor-error" role="alert"><AlertTriangle size={14} /> {error}</div>}
        <footer>
          {host && (
            confirmRemove ? (
              <div className="fleet-remove-confirm">
                <span>Remove this local registry entry?</span>
                <button type="button" onClick={() => setConfirmRemove(false)}>Keep host</button>
                <button className="is-danger" type="button" onClick={() => void remove()} disabled={busy}><Trash2 size={14} /> Remove</button>
              </div>
            ) : (
              <button className="fleet-remove-trigger" type="button" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={14} /> Remove entry
              </button>
            )
          )}
          <div>
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="fleet-save-host" disabled={busy}>
              {busy ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}
              {host ? 'Save registry entry' : 'Register host'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  ), document.body)
}
