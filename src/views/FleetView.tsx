import {
  Activity,
  Braces,
  Check,
  ChevronRight,
  Database,
  Gauge,
  Laptop,
  Network,
  Pencil,
  Plus,
  RadioTower,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  ShieldCheck,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { refreshFleetHost } from '../api'
import { usePrivacy } from '../privacy'
import type { FleetHostView, FleetSnapshot, SessionRow } from '../types'
import { HostEditor } from './fleet/HostEditor'
import {
  emptyFleet,
  hostEndpoint,
  integer,
  matchesFilter,
  sectionAvailability,
  sessions,
  type FleetFilter,
  type FleetSectionId,
  type FleetTab,
} from './fleet/model'
import { FleetOverview } from './fleet/panels/Overview'
import { FleetRuntime } from './fleet/panels/Runtime'
import { FleetSessions } from './fleet/panels/Sessions'
import { FleetUsage } from './fleet/panels/Usage'
import { FleetWorkflows } from './fleet/panels/Workflows'
import { FleetStatusBadge, HostStatusNarrative } from './fleet/status'

type FleetNotice =
  | { kind: 'refreshed'; hostId: string; hostLabel: string }
  | { kind: 'saved'; hostId: string; hostLabel: string }
  | { kind: 'removed' }

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

export function FleetView({
  fleet,
  streamConnected,
  error: fleetError,
  onReload,
  onFleetChange,
  onOpenRemoteSession,
}: {
  fleet: FleetSnapshot | null
  streamConnected: boolean
  error: string
  onReload: () => Promise<void>
  onFleetChange: (fleet: FleetSnapshot) => void
  onOpenRemoteSession: (host: FleetHostView, session: SessionRow) => void
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
  const visibleError = fleetError || fleet?.registryError || actionError

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
          Monitor every trusted host, then continue opted-in Grok Build sessions through
          an authenticated Tailscale or SSH connection.
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
          <span><strong>HOST-AUTHORIZED</strong> Monitoring stays read-only unless a host explicitly enables secure remote sessions.</span>
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

      {(visibleError || noticeText) && (
        <div
          className={`fleet-notice ${visibleError ? 'is-error' : 'is-success'}`}
          role={visibleError ? 'alert' : 'status'}
        >
          {visibleError ? <ShieldAlert size={16} /> : <Check size={16} />}
          <span>{visibleError ? privacy.content(visibleError) : noticeText}</span>
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
                <span className="fleet-readonly-lock">
                  <ShieldCheck size={14} />
                  {selected.config.controlEnabled ? 'Remote sessions enabled' : 'Read only'}
                </span>
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
                const availability = section ? sectionAvailability(selected, section) : 'available'
                const available = availability === 'available' || availability === 'partial'
                const historical = availability === 'stale' && Boolean(selected.snapshot)
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
                    {!available && <i aria-label={historical ? 'Historical snapshot' : 'Unavailable'} />}
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
              {tab === 'sessions' && (
                <FleetSessions host={selected} onOpenRemoteSession={onOpenRemoteSession} />
              )}
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
