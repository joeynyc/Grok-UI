import {
  Activity,
  Archive,
  ArrowRight,
  Blocks,
  Bot,
  Box,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleAlert,
  Command,
  Copy,
  Database,
  FileCode2,
  FolderGit2,
  Gauge,
  GitCompareArrows,
  Layers3,
  Menu,
  Palette,
  RefreshCw,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TimerReset,
  ToolCase,
  Workflow,
  WalletCards,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getAuthStatus,
  getControlSnapshot,
  getDashboard,
  getLiveSnapshot,
  getRuntimeSnapshot,
  getSetupStatus,
  login,
} from './api'
import type {
  ActivityDay,
  ControlSnapshot,
  DashboardPayload,
  LiveAgent,
  LiveFeedItem,
  LiveSnapshot,
  RankedDatum,
  RuntimeSnapshot,
  SessionRow,
  SetupCheckState,
  SetupStatus,
  ViewId,
  WorkspaceChangeEvent,
} from './types'
import { ChangesView } from './views/ChangesView'
import { ControlView } from './views/ControlView'
import { SessionWorkbench } from './views/SessionWorkbench'
import { WorkflowsView } from './views/WorkflowsView'
import { UsageView } from './views/UsageView'
import { RuntimeIntelligencePanels } from './views/RuntimeIntelligencePanels'
import { PrivacyProvider, usePrivacy } from './privacy'
import packageJson from '../package.json'

interface NavItem {
  id: ViewId
  index: string
  label: string
  eyebrow: string
  icon: LucideIcon
  shortcut: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'live', index: '01', label: 'Live', eyebrow: 'Runtime', icon: Radio, shortcut: '1' },
  { id: 'control', index: '02', label: 'Control', eyebrow: 'Operate', icon: Command, shortcut: '2' },
  { id: 'runs', index: '03', label: 'Runs', eyebrow: 'Orchestrate', icon: Workflow, shortcut: '3' },
  { id: 'changes', index: '04', label: 'Changes', eyebrow: 'Inspect', icon: GitCompareArrows, shortcut: '4' },
  { id: 'overview', index: '05', label: 'Overview', eyebrow: 'Command', icon: Gauge, shortcut: '5' },
  { id: 'sessions', index: '06', label: 'Sessions', eyebrow: 'Archive', icon: Layers3, shortcut: '6' },
  { id: 'activity', index: '07', label: 'Activity', eyebrow: 'Signals', icon: Activity, shortcut: '7' },
  { id: 'usage', index: '08', label: 'Usage', eyebrow: 'Ledger', icon: WalletCards, shortcut: 'u' },
  { id: 'library', index: '09', label: 'Library', eyebrow: 'Capability', icon: Blocks, shortcut: '8' },
  { id: 'memory', index: '10', label: 'Memory', eyebrow: 'Recall', icon: BrainCircuit, shortcut: '9' },
  { id: 'themes', index: '11', label: 'Themes', eyebrow: 'Appearance', icon: Palette, shortcut: '0' },
]

type ThemeId = 'operator' | 'event-horizon'

const DEFAULT_THEME: ThemeId = 'event-horizon'

const THEMES: Array<{
  id: ThemeId
  name: string
  eyebrow: string
  description: string
}> = [
  {
    id: 'operator',
    name: 'Operator',
    eyebrow: 'Original system',
    description: 'Carbon black, signal lime, and the precision grid that launched Grok UI.',
  },
  {
    id: 'event-horizon',
    name: 'Event Horizon',
    eyebrow: 'Deep-space system',
    description: 'A cinematic red singularity, cold starlight, and glassy command surfaces.',
  },
]

function storedTheme(): ThemeId {
  try {
    const stored = localStorage.getItem('grok-ui-theme')
    return stored === 'operator' || stored === 'event-horizon' ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function storedPrivacy(): boolean {
  try {
    return localStorage.getItem('grok-ui-privacy') === 'on'
  } catch {
    return false
  }
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('en-US')

function formatNumber(value: number): string {
  return value >= 10_000 ? compact.format(value) : integer.format(value)
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`
}

function timeAgo(input: string): string {
  const delta = Math.max(0, Date.now() - new Date(input).getTime())
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`
  return new Date(input).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function liveSessionStatus(session: SessionRow, live: LiveSnapshot | null): SessionRow['status'] {
  const agent = live?.agents.find((item) => item.id === session.id)
  if (!agent) return session.status === 'live' || session.status === 'attention' ? 'recent' : session.status
  if (agent.state === 'attention') return 'attention'
  if (agent.state === 'working' || agent.state === 'waiting') return 'live'
  return 'recent'
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [view, setView] = useState<ViewId>('live')
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [live, setLive] = useState<LiveSnapshot | null>(null)
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null)
  const [control, setControl] = useState<ControlSnapshot | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [streamConnected, setStreamConnected] = useState(false)
  const [workspaceChange, setWorkspaceChange] = useState<WorkspaceChangeEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedSession, setSelectedSession] = useState<{ id: string; fallback: SessionRow | null } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeId>(storedTheme)
  const [privacyMode, setPrivacyMode] = useState(storedPrivacy)
  const lastAttentionRef = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('grok-ui-theme', theme)
    } catch {
      // Theme selection still works when storage is unavailable.
    }
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.privacy = privacyMode ? 'on' : 'off'
    try {
      localStorage.setItem('grok-ui-privacy', privacyMode ? 'on' : 'off')
    } catch {
      // Privacy Mode still works when storage is unavailable.
    }
  }, [privacyMode])

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true)
    try {
      const [payload, livePayload, runtimePayload] = await Promise.all([
        getDashboard(force),
        getLiveSnapshot(),
        getRuntimeSnapshot(force),
      ])
      setData(payload)
      setLive(livePayload)
      setRuntime(runtimePayload)
      setError('')
      if (payload.stats.sessions === 0) {
        void getSetupStatus(force)
          .then(setSetup)
          .catch(() => setSetup(null))
      } else {
        setSetup(null)
      }
      void getControlSnapshot()
        .then(setControl)
        .catch(() => {
          // Dashboard and onboarding stay available if ACP is not ready yet.
        })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to read Grok data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void getAuthStatus()
      .then((status) => setAuthenticated(status.authenticated))
      .catch(() => setAuthenticated(false))
  }, [])

  useEffect(() => {
    if (!authenticated) return
    void load()
    const events = new EventSource('/api/events')
    events.addEventListener('ready', () => setStreamConnected(true))
    events.addEventListener('heartbeat', () => setStreamConnected(true))
    events.addEventListener('live', (event) => {
      setStreamConnected(true)
      setLive(JSON.parse((event as MessageEvent).data) as LiveSnapshot)
    })
    events.addEventListener('dashboard', (event) => {
      setStreamConnected(true)
      setData(JSON.parse((event as MessageEvent).data) as DashboardPayload)
    })
    events.addEventListener('control', (event) => {
      setStreamConnected(true)
      setControl(JSON.parse((event as MessageEvent).data) as ControlSnapshot)
    })
    events.addEventListener('runtime', (event) => {
      setStreamConnected(true)
      setRuntime(JSON.parse((event as MessageEvent).data) as RuntimeSnapshot)
    })
    events.addEventListener('workspace', (event) => {
      setStreamConnected(true)
      setWorkspaceChange(JSON.parse((event as MessageEvent).data) as WorkspaceChangeEvent)
    })
    events.onerror = () => setStreamConnected(false)
    return () => {
      events.close()
      setStreamConnected(false)
    }
  }, [authenticated, load])

  useEffect(() => {
    const attention = (live?.attentionCount || 0) + (control?.permissions.length || 0)
    if (
      attention > lastAttentionRef.current
      && 'Notification' in window
      && Notification.permission === 'granted'
    ) {
      const pending = control?.permissions.at(-1)
      new Notification('Grok needs your input', {
        body: privacyMode
          ? `${attention} session${attention === 1 ? '' : 's'} waiting for attention.`
          : pending?.title || `${attention} session${attention === 1 ? '' : 's'} waiting for attention.`,
        tag: pending?.id || 'grok-ui-attention',
      })
    }
    lastAttentionRef.current = attention
  }, [control?.permissions, live?.attentionCount, privacyMode])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = target.matches('input, textarea, [contenteditable="true"]')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setSelectedSession(null)
        setMobileNavOpen(false)
      }
      if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const navItem = NAV_ITEMS.find((item) => item.shortcut === event.key)
        if (navItem) setView(navItem.id)
        if (event.key === '/') {
          event.preventDefault()
          setPaletteOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const setActiveView = (next: ViewId) => {
    setView(next)
    setQuery('')
    setMobileNavOpen(false)
  }

  const refreshControl = useCallback(async () => {
    setControl(await getControlSnapshot())
  }, [])

  const openSession = useCallback((session: SessionRow | string) => {
    setSelectedSession(typeof session === 'string'
      ? { id: session, fallback: data?.sessions.find((item) => item.id === session) || null }
      : { id: session.id, fallback: session })
  }, [data?.sessions])

  if (authenticated === null) return <BootScreen label="SECURING LOCAL LINK" />
  if (!authenticated) return <AuthScreen onAuthenticated={() => setAuthenticated(true)} />

  return (
    <PrivacyProvider enabled={privacyMode}>
      <div className="app-shell" data-theme={theme} data-privacy={privacyMode ? 'on' : 'off'}>
        <AmbientGrid />
        <Sidebar
          active={view}
          connected={streamConnected}
          version={data?.version || '—'}
          open={mobileNavOpen}
          onNavigate={setActiveView}
          onClose={() => setMobileNavOpen(false)}
        />

        <main className="main-stage">
          <TopBar
            active={view}
            connected={streamConnected}
            generatedAt={live?.generatedAt || data?.generatedAt}
            refreshing={refreshing}
            privacyMode={privacyMode}
            onMenu={() => setMobileNavOpen(true)}
            onPalette={() => setPaletteOpen(true)}
            onRefresh={() => void load(true)}
            onTogglePrivacy={() => setPrivacyMode((enabled) => !enabled)}
          />

        {loading ? (
          <LoadingState />
        ) : error || !data ? (
          <ErrorState message={error} onRetry={() => void load(true)} />
        ) : (
          <div className="view-wrap" key={view}>
            {view === 'live' && (
              <LiveView
                live={live}
                runtime={runtime}
                data={data}
                setup={setup}
                connected={streamConnected}
                onOpenSession={openSession}
                onRefresh={() => void load(true)}
              />
            )}
            {view === 'control' && (
              <ControlView
                data={data}
                live={live}
                control={control}
                onRefresh={refreshControl}
                onOpenSession={openSession}
              />
            )}
            {view === 'runs' && (
              <WorkflowsView
                control={control}
                connected={streamConnected}
                onRefresh={refreshControl}
                onOpenSession={openSession}
              />
            )}
            {view === 'changes' && (
              <ChangesView
                data={data}
                live={live}
                connected={streamConnected}
                workspaceChange={workspaceChange}
              />
            )}
            {view === 'overview' && (
              <Overview
                data={data}
                live={live}
                connected={streamConnected}
                onOpenSession={openSession}
                onNavigate={setActiveView}
              />
            )}
            {view === 'sessions' && (
              <SessionsView
                data={data}
                live={live}
                query={query}
                onQuery={setQuery}
                onOpenSession={openSession}
              />
            )}
            {view === 'activity' && <ActivityView data={data} />}
            {view === 'usage' && <UsageView />}
            {view === 'library' && <LibraryView data={data} query={query} onQuery={setQuery} />}
            {view === 'memory' && <MemoryView data={data} />}
            {view === 'themes' && <ThemesView active={theme} onSelect={setTheme} />}
          </div>
        )}
        </main>

        <MobileNav active={view} onNavigate={setActiveView} />
        {selectedSession && (
          <SessionWorkbench
            sessionId={selectedSession.id}
            fallback={data?.sessions.find((item) => item.id === selectedSession.id) || selectedSession.fallback}
            live={live}
            control={control}
            onClose={() => setSelectedSession(null)}
            onUpdated={() => load(true)}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            data={data}
            onClose={() => setPaletteOpen(false)}
            onNavigate={(next) => {
              setActiveView(next)
              setPaletteOpen(false)
            }}
            onSession={(session) => {
              openSession(session)
              setPaletteOpen(false)
            }}
          />
        )}
      </div>
    </PrivacyProvider>
  )
}

function AmbientGrid() {
  return (
    <div className="ambient-grid" aria-hidden="true">
      <div className="ambient-orb" />
      <div className="scan-beam" />
    </div>
  )
}

function BrandLogo() {
  return (
    <span className="brand-logo-shell" aria-hidden="true">
      <img className="brand-logo" src="/brand/grok-mark.png" alt="" />
      <i />
    </span>
  )
}

function ThemesView({
  active,
  onSelect,
}: {
  active: ThemeId
  onSelect: (theme: ThemeId) => void
}) {
  return (
    <>
      <PageIntro
        index="11"
        eyebrow="Visual systems"
        title={<>Choose your<br /><em>command atmosphere.</em></>}
        description="Switch the entire dashboard aesthetic without changing your data, sessions, or workflow. Your selection stays active on this device."
      />

      <section className="theme-grid section-gap" aria-label="Available themes">
        {THEMES.map((theme, index) => {
          const selected = theme.id === active
          return (
            <button
              className={`theme-card theme-card-${theme.id} ${selected ? 'is-selected' : ''}`}
              key={theme.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(theme.id)}
            >
              <span className="theme-preview" aria-hidden="true">
                <span className="theme-preview-rail" />
                <span className="theme-preview-stage">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="theme-card-copy">
                <span className="theme-card-index">0{index + 1} / 02</span>
                <span className="theme-card-eyebrow">{theme.eyebrow}</span>
                <strong>{theme.name}</strong>
                <small>{theme.description}</small>
              </span>
              <span className="theme-select-state">
                {selected ? <><Check size={14} /> Active theme</> : <>Apply theme <ArrowRight size={14} /></>}
              </span>
            </button>
          )
        })}
      </section>

      <section className="theme-note">
        <span>LOCAL PREFERENCE</span>
        <p>Themes are presentation-only and are stored in your browser. Grok session data never leaves the local dashboard.</p>
      </section>
    </>
  )
}

function Sidebar({
  active,
  connected,
  version,
  open,
  onNavigate,
  onClose,
}: {
  active: ViewId
  connected: boolean
  version: string
  open: boolean
  onNavigate: (id: ViewId) => void
  onClose: () => void
}) {
  return (
    <>
      <button
        className={`nav-scrim ${open ? 'is-open' : ''}`}
        aria-label="Close navigation"
        onClick={onClose}
      />
      <aside className={`sidebar ${open ? 'is-open' : ''}`}>
        <div className="brand-lockup">
          <BrandLogo />
          <div>
            <div className="brand-word">GROK</div>
            <div className="brand-sub">Local command</div>
          </div>
          <button className="icon-button sidebar-close" onClick={onClose} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <div className="rail-label">Navigation / 01</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`nav-item ${active === item.id ? 'is-active' : ''}`}
                onClick={() => onNavigate(item.id)}
              >
                <span className="nav-index">{item.index}</span>
                <Icon size={17} strokeWidth={1.7} />
                <span className="nav-copy">
                  <strong>{item.label}</strong>
                  <small>{item.eyebrow}</small>
                </span>
                <ChevronRight className="nav-arrow" size={15} />
              </button>
            )
          })}
        </nav>

        <div className="sidebar-spacer" />
        <div className="system-chip">
          <div className="system-chip-head">
            <span className={`status-dot ${connected ? 'is-live' : ''}`} />
            <span>{connected ? 'Grok linked' : 'Data offline'}</span>
          </div>
          <div className="system-chip-meta">
            <span>LOCAL FS</span>
            <span>v{version}</span>
          </div>
        </div>
        <div className="sidebar-foot">
          <span>UI / {packageJson.version}</span>
          <span>ACP CONTROL</span>
        </div>
      </aside>
    </>
  )
}

function TopBar({
  active,
  connected,
  generatedAt,
  refreshing,
  privacyMode,
  onMenu,
  onPalette,
  onRefresh,
  onTogglePrivacy,
}: {
  active: ViewId
  connected: boolean
  generatedAt?: string
  refreshing: boolean
  privacyMode: boolean
  onMenu: () => void
  onPalette: () => void
  onRefresh: () => void
  onTogglePrivacy: () => void
}) {
  const activeItem = NAV_ITEMS.find((item) => item.id === active)!
  return (
    <header className="topbar">
      <div className="topbar-title">
        <button className="icon-button mobile-menu" onClick={onMenu} aria-label="Open navigation">
          <Menu size={19} />
        </button>
        <span className="topbar-path">GROK / HUD /</span>
        <strong>{activeItem.label}</strong>
      </div>
      <div className="topbar-actions">
        <div className="sync-state">
          <span className={`status-dot ${connected ? 'is-live' : ''}`} />
          <span className="sync-copy">{connected ? 'Event stream' : 'Reconnecting'}</span>
          <span className="sync-time">{generatedAt ? timeAgo(generatedAt) : '—'}</span>
        </div>
        <button
          className={`privacy-toggle ${privacyMode ? 'is-active' : ''}`}
          type="button"
          aria-pressed={privacyMode}
          onClick={onTogglePrivacy}
          title={privacyMode ? 'Turn Privacy Mode off' : 'Hide local names, paths, and content'}
        >
          <ShieldCheck size={15} />
          <span>{privacyMode ? 'Privacy on' : 'Privacy'}</span>
        </button>
        <button className="command-trigger" onClick={onPalette}>
          <Search size={15} />
          <span>Jump anywhere</span>
          <kbd>⌘ K</kbd>
        </button>
        <button className="icon-button" onClick={onRefresh} aria-label="Refresh data">
          <RefreshCw className={refreshing ? 'is-spinning' : ''} size={17} />
        </button>
      </div>
    </header>
  )
}

function LiveView({
  live,
  runtime,
  data,
  setup,
  connected,
  onOpenSession,
  onRefresh,
}: {
  live: LiveSnapshot | null
  runtime: RuntimeSnapshot | null
  data: DashboardPayload
  setup: SetupStatus | null
  connected: boolean
  onOpenSession: (session: SessionRow | string) => void
  onRefresh: () => void
}) {
  const privacy = usePrivacy()
  const [selectedId, setSelectedId] = useState(live?.agents[0]?.id || '')
  const feedRef = useRef<HTMLDivElement>(null)
  const agents = live?.agents || []

  useEffect(() => {
    if (!agents.length) {
      setSelectedId('')
      return
    }
    if (!agents.some((agent) => agent.id === selectedId)) setSelectedId(agents[0].id)
  }, [agents, selectedId])

  const selected = agents.find((agent) => agent.id === selectedId) || agents[0]
  const selectedSession = selected ? data.sessions.find((session) => session.id === selected.id) : null

  useEffect(() => {
    const feed = feedRef.current
    if (feed) feed.scrollTop = feed.scrollHeight
  }, [selected?.id, selected?.feed.at(-1)?.id])

  return (
    <>
      <PageIntro
        index="01"
        eyebrow="Live runtime"
        title={<>In the loop.<br /><em>Right now.</em></>}
        description="A direct event stream from Grok’s active-session registry, phase engine, ACP updates, and tool lifecycle."
      />
      <section className="live-summary-strip">
        <LiveSummaryMetric
          label="Open agents"
          value={String(live?.activeCount || 0)}
          detail="registered Grok processes"
          tone="lime"
        />
        <LiveSummaryMetric
          label="Working now"
          value={String(live?.workingCount || 0)}
          detail="active turns in flight"
          tone="paper"
        />
        <LiveSummaryMetric
          label="Needs input"
          value={String(live?.attentionCount || 0)}
          detail="permission or user prompt"
          tone={live?.attentionCount ? 'coral' : 'paper'}
        />
        <LiveSummaryMetric
          label="Transport"
          value={connected ? 'SSE' : '—'}
          detail="filesystem events → browser"
          tone={connected ? 'lime' : 'coral'}
        />
      </section>

      {!selected && data.stats.sessions === 0 ? (
        <FirstRunOnboarding connected={connected} setup={setup} onRefresh={onRefresh} />
      ) : !selected ? (
        <section className="no-live-agent section-gap">
          <div className="idle-radar" aria-hidden="true"><span /><span /><i /></div>
          <div className="kicker">Runtime clear</div>
          <h2>No active Grok sessions.</h2>
          <p>Start Grok in any workspace. The session will appear here as soon as it registers under <code>~/.grok/active_sessions.json</code>.</p>
          <code className="launch-command">grok</code>
        </section>
      ) : (
        <section className="live-console-grid section-gap">
          <aside className="agent-roster">
            <header>
              <span>ACTIVE / {String(agents.length).padStart(2, '0')}</span>
              <span className="live-word"><i /> LIVE</span>
            </header>
            <div className="agent-roster-list">
              {agents.map((agent, index) => (
                <button
                  key={agent.id}
                  className={selected.id === agent.id ? 'is-active' : ''}
                  onClick={() => setSelectedId(agent.id)}
                >
                  <span className="agent-number">A{String(index + 1).padStart(2, '0')}</span>
                  <AgentStateGlyph state={agent.state} />
                  <span className="agent-roster-copy">
                    <strong>{privacy.sessionTitle(agent.title, agent.id)}</strong>
                    <small>{privacy.workspace(agent.cwd)} · {privacy.enabled ? 'PID ••••' : `PID ${agent.pid}`}</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
            <div className="roster-foot">
              <span>Registry source</span>
              <strong>active_sessions.json</strong>
            </div>
          </aside>

          <section className="runtime-console">
            <header className="runtime-head">
              <div className="runtime-identity">
                <AgentStateGlyph state={selected.state} />
                <div>
                  <span>{privacy.workspace(selected.cwd)} / {selected.model}</span>
                  <h2>{privacy.sessionTitle(selected.title, selected.id)}</h2>
                </div>
              </div>
              <div className="runtime-actions">
                <AgentStatePill agent={selected} />
                <button className="text-button" onClick={() => onOpenSession(selectedSession || selected.id)}>
                  Open Session <ArrowRight size={14} />
                </button>
              </div>
            </header>

            <div className="runtime-instruments">
              <RuntimeInstrument label="Phase" value={selected.phase.replaceAll('_', ' ')} />
              <RuntimeInstrument label="Turns" value={formatNumber(selected.turns)} />
              <RuntimeInstrument label="Tool calls" value={formatNumber(selected.toolCalls)} />
              <RuntimeInstrument
                label="Context"
                value={selected.contextSize
                  ? `${formatNumber(selected.contextUsed)} / ${formatNumber(selected.contextSize)}`
                  : `${Math.round(selected.contextUsage * 100)}%`}
              />
              <RuntimeInstrument
                label="Cost"
                value={selected.costAmount
                  ? `${selected.costAmount.toFixed(3)} ${selected.costCurrency}`
                  : '—'}
              />
              <RuntimeInstrument label="Process" value={privacy.enabled ? 'PID ••••' : `PID ${selected.pid}`} />
            </div>

            {selected.currentTool && (
              <div className="current-operation">
                <span className="operation-pulse" />
                <span>CURRENT OPERATION</span>
                <strong>{privacy.content(selected.currentTool)}</strong>
              </div>
            )}

            <div className="live-feed-head">
              <span>Structured session stream</span>
              <span>{selected.feed.length} recent events</span>
            </div>
            <div className="live-feed" aria-live="polite" ref={feedRef}>
              {selected.feed.length ? selected.feed.map((item, index) => (
                <LiveFeedRow item={item} index={index} key={item.id} />
              )) : (
                <EmptyInline>The session is open and idle. New ACP updates will appear here instantly.</EmptyInline>
              )}
            </div>
          </section>
        </section>
      )}
      <RuntimeIntelligencePanels runtime={runtime} />
    </>
  )
}

function FirstRunOnboarding({
  connected,
  setup,
  onRefresh,
}: {
  connected: boolean
  setup: SetupStatus | null
  onRefresh: () => void
}) {
  const [copied, setCopied] = useState('')
  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(command)
      window.setTimeout(() => setCopied(''), 1_500)
    } catch {
      setCopied('')
    }
  }
  const cli = setup?.checks.find((check) => check.id === 'cli')
  const auth = setup?.checks.find((check) => check.id === 'auth')
  const state = setup?.checks.find((check) => check.id === 'state')
  const steps: Array<{
    index: string
    label: string
    copy: string
    command: string
    state: SetupCheckState | 'checking'
  }> = [
    {
      index: '01',
      label: 'Verify the CLI',
      copy: cli?.detail || 'Checking whether Grok Build is installed and executable…',
      command: 'grok version',
      state: cli?.state || 'checking',
    },
    {
      index: '02',
      label: 'Connect your account',
      copy: auth?.detail || 'Checking whether the CLI can access your Grok models…',
      command: 'grok login',
      state: auth?.state || 'checking',
    },
    {
      index: '03',
      label: 'Start the first session',
      copy: state?.state === 'ready'
        ? 'Open any project and run Grok. The live agent will register here automatically.'
        : state?.detail || 'Open any project and start a normal Grok CLI session.',
      command: 'grok',
      state: 'action',
    },
  ]
  return (
    <section className="first-run section-gap">
      <div className="first-run-head">
        <div>
          <span className="kicker">
            {setup?.ready
              ? 'FIRST CONTACT / READY'
              : setup ? 'FIRST CONTACT / SETUP REQUIRED' : 'FIRST CONTACT / CHECKING'}
          </span>
          <h2>Zero to live<br /><em>in three moves.</em></h2>
        </div>
        <div className="first-run-status">
          <span className={cli?.state === 'ready' ? 'is-ready' : 'needs-action'}><i /> Grok CLI</span>
          <span className={auth?.state === 'ready' ? 'is-ready' : 'needs-action'}><i /> Account</span>
          <span><i /> First session</span>
        </div>
      </div>
      <div className="first-run-steps">
        {steps.map((step) => (
          <article className={`setup-${step.state}`} key={step.index}>
            <span>{step.index}</span>
            <div>
              <small className={`setup-state setup-state-${step.state}`}>
                {step.state === 'ready'
                  ? <><Check size={11} /> Ready</>
                  : step.state === 'action'
                    ? <><CircleAlert size={11} /> Action needed</>
                    : <><TimerReset size={11} /> Checking</>}
              </small>
              <h3>{step.label}</h3>
              <p>{step.copy}</p>
            </div>
            <button type="button" onClick={() => void copy(step.command)}>
              <code>{step.command}</code>
              {copied === step.command ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </article>
        ))}
      </div>
      <footer>
        <span>
          {setup?.ready && connected
            ? <>Environment ready. Start <code>grok</code> in any project.</>
            : <>Need the full terminal report? Run <code>grok-ui doctor</code>.</>}
        </span>
        <button className="text-button" onClick={onRefresh}>
          Recheck setup <RefreshCw size={14} />
        </button>
      </footer>
    </section>
  )
}

function LiveSummaryMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'lime' | 'paper' | 'coral'
}) {
  return (
    <div className={`live-summary-metric live-tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function AgentStateGlyph({ state }: { state: LiveAgent['state'] }) {
  return (
    <span className={`agent-state-glyph agent-state-${state}`} aria-label={state}>
      <i />
    </span>
  )
}

function AgentStatePill({ agent }: { agent: LiveAgent }) {
  const label = agent.state === 'attention'
    ? 'Needs input'
    : agent.state === 'working'
      ? 'Working'
      : agent.state === 'waiting'
        ? 'Waiting on model'
        : 'Idle / attached'
  return <span className={`agent-state-pill state-pill-${agent.state}`}><i />{label}</span>
}

function RuntimeInstrument({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function LiveFeedRow({ item, index }: { item: LiveFeedItem; index: number }) {
  const privacy = usePrivacy()
  const labels: Record<LiveFeedItem['type'], string> = {
    user: 'YOU',
    assistant: 'GROK',
    thought: 'THOUGHT',
    tool: 'TOOL',
    plan: 'PLAN',
    system: 'SYSTEM',
  }
  return (
    <article className={`live-feed-row feed-${item.type}`}>
      <span className="feed-sequence">{String(index + 1).padStart(2, '0')}</span>
      <div className="feed-rail"><i /></div>
      <div className="feed-content">
        <header>
          <span>{labels[item.type]}</span>
          <strong>{privacy.content(item.title)}</strong>
          {item.status && <em className={`tool-status status-${item.status}`}>{item.status}</em>}
          <time>{item.timestamp && item.timestamp !== new Date(0).toISOString() ? timeAgo(item.timestamp) : 'live'}</time>
        </header>
        {item.text && <p>{privacy.content(item.text)}</p>}
      </div>
    </article>
  )
}

function Overview({
  data,
  live,
  connected,
  onOpenSession,
  onNavigate,
}: {
  data: DashboardPayload
  live: LiveSnapshot | null
  connected: boolean
  onOpenSession: (session: SessionRow) => void
  onNavigate: (view: ViewId) => void
}) {
  const recent = data.sessions.filter((session) => !session.archived).slice(0, 6)
  return (
    <>
      <PageIntro
        index="05"
        eyebrow="Local intelligence"
        title={<>Your Grok,<br /><em>at a glance.</em></>}
        description="A read-only flight recorder for every local Grok Build session, tool run, model, workspace, and durable memory."
      />

      <section className="overview-grid">
        <SystemCard data={data} live={live} connected={connected} />
        <MetricCard
          index="A1"
          label="Total turns"
          value={formatNumber(data.stats.turns)}
          detail={`${formatNumber(data.stats.sessions)} recorded sessions`}
          icon={TimerReset}
          tone="lime"
        />
        <MetricCard
          index="A2"
          label="Tool calls"
          value={formatNumber(data.stats.toolCalls)}
          detail={`${data.stats.errors ? formatNumber(data.stats.errors) : 'No'} flagged errors`}
          icon={ToolCase}
          tone={data.stats.errors ? 'coral' : 'paper'}
        />
        <MetricCard
          index="A3"
          label="Files touched"
          value={formatNumber(data.stats.filesTouched)}
          detail={`${formatNumber(data.stats.linesChanged)} lines changed`}
          icon={FileCode2}
          tone="paper"
        />
        <MetricCard
          index="A4"
          label="Local corpus"
          value={formatBytes(data.stats.dataBytes)}
          detail={`${data.stats.memoryFiles} memory artifacts`}
          icon={Database}
          tone="paper"
        />
      </section>

      <section className="two-col-grid section-gap">
        <Panel
          className="activity-panel"
          index="02"
          title="Fourteen-day signal"
          action={<button className="text-button" onClick={() => onNavigate('activity')}>Full telemetry <ArrowRight size={14} /></button>}
        >
          <ActivityChart days={data.activity} />
        </Panel>
        <Panel index="03" title="Tool signature" meta={`${data.tools.length} detected`}>
          <RankedBars data={data.tools.slice(0, 6)} empty="No tool signals recorded yet." />
        </Panel>
      </section>

      <section className="two-col-grid section-gap lower-grid">
        <Panel
          className="recent-panel"
          index="04"
          title="Recent sessions"
          meta={`${live?.activeCount || 0} live now`}
          action={<button className="text-button" onClick={() => onNavigate('sessions')}>View archive <ArrowRight size={14} /></button>}
        >
          <SessionList sessions={recent} onOpen={onOpenSession} />
        </Panel>
        <div className="side-stack">
          <Panel index="05" title="Model mix" meta={`${data.models.length} in rotation`}>
            <ModelMix data={data.models} />
          </Panel>
          <Panel index="06" title="Workspace pulse" meta={`${data.stats.workspaces} indexed`}>
            <WorkspaceList data={data.workspaces.slice(0, 5)} />
          </Panel>
        </div>
      </section>
    </>
  )
}

function SystemCard({
  data,
  live,
  connected,
}: {
  data: DashboardPayload
  live: LiveSnapshot | null
  connected: boolean
}) {
  const privacy = usePrivacy()
  const health = data.stats.sessions === 0 ? 0 : Math.max(0, 100 - (data.stats.errors / Math.max(data.stats.turns, 1)) * 100)
  return (
    <article className="system-card panel-cut">
      <div className="system-card-grid" aria-hidden="true" />
      <div className="card-index">SYS / 00</div>
      <div className="system-card-copy">
        <div className="kicker"><Zap size={14} fill="currentColor" /> Runtime corpus</div>
        <div className="hero-number">{formatNumber(data.stats.sessions)}</div>
        <div className="hero-label">SESSIONS ON RECORD</div>
        <div className="system-readouts">
          <div><span>Live agents</span><strong>{live?.activeCount || 0}</strong></div>
          <div><span>Capabilities</span><strong>{data.stats.skills}</strong></div>
          <div><span>Context avg.</span><strong>{Math.round(data.stats.contextAverage * 100)}%</strong></div>
        </div>
      </div>
      <div className="system-orbit">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <div className="orbit-center">
          <span>{Math.round(health)}</span>
          <small title="Calculated from recorded errors per turn">DERIVED HEALTH</small>
        </div>
        <div className="orbit-node node-one" />
        <div className="orbit-node node-two" />
        <div className="orbit-node node-three" />
      </div>
      <div className="system-footer">
        <span>
          <span className={`status-dot ${connected ? 'is-live' : ''}`} />
          {connected ? 'EVENT STREAM LINKED' : 'EVENT STREAM RECONNECTING'}
        </span>
        <span>{privacy.path(data.grokHome)}</span>
      </div>
    </article>
  )
}

function MetricCard({
  index,
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  index: string
  label: string
  value: string
  detail: string
  icon: LucideIcon
  tone: 'lime' | 'coral' | 'paper'
}) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-card-top">
        <span>{index}</span>
        <Icon size={18} strokeWidth={1.5} />
      </div>
      <div>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{value}</div>
        <div className="metric-detail">{detail}</div>
      </div>
      <div className="metric-rule"><span /></div>
    </article>
  )
}

function Panel({
  index,
  title,
  meta,
  action,
  className = '',
  children,
}: {
  index: string
  title: string
  meta?: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <div>
          <span className="panel-index">{index}</span>
          <h2>{title}</h2>
        </div>
        <div className="panel-meta">
          {meta && <span>{meta}</span>}
          {action}
        </div>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

function ActivityChart({ days }: { days: ActivityDay[] }) {
  const max = Math.max(1, ...days.map((day) => day.toolCalls))
  const total = days.reduce((sum, day) => sum + day.toolCalls, 0)
  const peak = [...days].sort((a, b) => b.toolCalls - a.toolCalls)[0]
  return (
    <div className="activity-chart">
      <div className="chart-summary">
        <div><strong>{formatNumber(total)}</strong><span>tool events</span></div>
        <div><strong>{formatNumber(days.reduce((sum, day) => sum + day.turns, 0))}</strong><span>turns</span></div>
        <div><strong>{peak?.label || '—'}</strong><span>peak day</span></div>
      </div>
      <div className="bar-chart" role="img" aria-label="Tool calls by day over the last fourteen days">
        {days.map((day, index) => (
          <div className="bar-column" key={day.date} title={`${day.date}: ${day.toolCalls} tool calls`}>
            <div className="bar-track">
              <div
                className={`bar-fill ${day.errors ? 'has-error' : ''}`}
                style={{ height: `${Math.max(4, (day.toolCalls / max) * 100)}%`, animationDelay: `${index * 35}ms` }}
              />
            </div>
            <span>{day.label}</span>
          </div>
        ))}
      </div>
      <div className="chart-legend">
        <span><i className="legend-lime" /> Tool volume</span>
        <span><i className="legend-coral" /> Error present</span>
      </div>
    </div>
  )
}

function RankedBars({ data, empty }: { data: RankedDatum[]; empty: string }) {
  const privacy = usePrivacy()
  const max = Math.max(1, ...data.map((item) => item.value))
  if (!data.length) return <EmptyInline>{empty}</EmptyInline>
  return (
    <div className="ranked-bars">
      {data.map((item, index) => (
        <div className="rank-row" key={item.name}>
          <span className="rank-number">{String(index + 1).padStart(2, '0')}</span>
          <div className="rank-main">
            <div className="rank-copy">
              <strong>{privacy.capability(item.name, 'Signal')}</strong>
              <span>{formatNumber(item.value)}</span>
            </div>
            <div className="rank-track"><span style={{ width: `${(item.value / max) * 100}%` }} /></div>
          </div>
        </div>
      ))}
    </div>
  )
}

function SessionList({ sessions, onOpen }: { sessions: SessionRow[]; onOpen: (session: SessionRow) => void }) {
  const privacy = usePrivacy()
  if (!sessions.length) return <EmptyInline>No Grok sessions have been indexed yet.</EmptyInline>
  return (
    <div className="session-list">
      {sessions.map((session) => (
        <button className="session-row" key={session.id} onClick={() => onOpen(session)}>
          <StatusGlyph status={session.status} />
          <div className="session-copy">
            <strong>{privacy.sessionTitle(session.title, session.id)}</strong>
            <span>{privacy.workspace(session.cwd)} / {session.model}</span>
          </div>
          <div className="session-metrics">
            <span>{formatNumber(session.toolCalls)} tools</span>
            <span>{formatNumber(session.turns)} turns</span>
          </div>
          <time>{timeAgo(session.updatedAt)}</time>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  )
}

function StatusGlyph({ status }: { status: SessionRow['status'] }) {
  return (
    <span className={`status-glyph status-${status}`} aria-label={status}>
      <span />
    </span>
  )
}

function ModelMix({ data }: { data: RankedDatum[] }) {
  const privacy = usePrivacy()
  const total = data.reduce((sum, item) => sum + item.value, 0)
  if (!data.length) return <EmptyInline>No model usage recorded.</EmptyInline>
  return (
    <div className="model-mix">
      <div className="segmented-track">
        {data.slice(0, 4).map((item, index) => (
          <span
            key={item.name}
            className={`segment segment-${index}`}
            style={{ width: `${(item.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="model-list">
        {data.slice(0, 4).map((item, index) => (
          <div key={item.name}>
            <i className={`model-dot segment-${index}`} />
            <span>{privacy.capability(item.name, 'Model')}</span>
            <strong>{Math.round((item.value / total) * 100)}%</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspaceList({ data }: { data: RankedDatum[] }) {
  const privacy = usePrivacy()
  if (!data.length) return <EmptyInline>No workspace metadata available.</EmptyInline>
  return (
    <div className="workspace-list">
      {data.map((item, index) => (
        <div key={item.name}>
          <span className="workspace-index">W{String(index + 1).padStart(2, '0')}</span>
          <FolderGit2 size={15} />
          <strong>{privacy.workspace(item.name)}</strong>
          <span>{item.value} session{item.value === 1 ? '' : 's'}</span>
        </div>
      ))}
    </div>
  )
}

function SessionsView({
  data,
  live,
  query,
  onQuery,
  onOpenSession,
}: {
  data: DashboardPayload
  live: LiveSnapshot | null
  query: string
  onQuery: (value: string) => void
  onOpenSession: (session: SessionRow) => void
}) {
  const privacy = usePrivacy()
  const [archiveScope, setArchiveScope] = useState<'active' | 'archived'>('active')
  const sessions = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return data.sessions.filter((session) => {
      if (archiveScope === 'active' ? session.archived : !session.archived) return false
      if (!normalized) return true
      return [session.title, session.summary, session.cwd, session.model, session.agent]
        .some((value) => value.toLowerCase().includes(normalized))
    })
  }, [archiveScope, data.sessions, query])
  const archivedCount = data.sessions.filter((session) => session.archived).length

  return (
    <>
      <PageIntro
        index="06"
        eyebrow="Conversation archive"
        title={<>Every run.<br /><em>Nothing buried.</em></>}
        description="Search local session metadata without sending conversation content anywhere."
      />
      <div className="view-toolbar">
        <SearchField value={query} onChange={onQuery} placeholder="Filter title, workspace, model, agent…" />
        <div className="archive-switch" role="group" aria-label="Session archive filter">
          <button className={archiveScope === 'active' ? 'is-active' : ''} onClick={() => setArchiveScope('active')}>
            Active <span>{data.sessions.length - archivedCount}</span>
          </button>
          <button className={archiveScope === 'archived' ? 'is-active' : ''} onClick={() => setArchiveScope('archived')}>
            Archived <span>{archivedCount}</span>
          </button>
        </div>
        <div className="toolbar-stat"><strong>{sessions.length}</strong><span>of {data.sessions.length} sessions</span></div>
      </div>
      <section className="data-table-wrap">
        <div className="session-table session-table-head" aria-hidden="true">
          <span>Status</span><span>Session</span><span>Workspace</span><span>Model</span><span>Turns</span><span>Tools</span><span>Updated</span><span />
        </div>
        {sessions.length ? sessions.map((session) => {
          const status = liveSessionStatus(session, live)
          return (
            <button className="session-table session-table-row" key={session.id} onClick={() => onOpenSession(session)}>
              <span><StatusGlyph status={status} /><small>{status}</small></span>
              <span className="table-title">
                <strong>{privacy.sessionTitle(session.title, session.id)}</strong>
                <small>{privacy.identifier(session.id)}</small>
              </span>
              <span>{privacy.workspace(session.cwd)}</span>
              <span className="model-pill">{session.model}</span>
              <span>{formatNumber(session.turns)}</span>
              <span>{formatNumber(session.toolCalls)}</span>
              <span>{timeAgo(session.updatedAt)}</span>
              <span><ChevronRight size={16} /></span>
            </button>
          )
        }) : <EmptyBlock
          icon={archiveScope === 'archived' ? Archive : Search}
          title={archiveScope === 'archived' ? 'No archived sessions' : 'No matching sessions'}
          copy={archiveScope === 'archived'
            ? 'Archive a session from its Session Console and it will appear here.'
            : 'Try a broader title, workspace, model, or agent name.'}
        />}
      </section>
    </>
  )
}

function ActivityView({ data }: { data: DashboardPayload }) {
  const totals = data.activity.reduce((acc, day) => ({
    turns: acc.turns + day.turns,
    tools: acc.tools + day.toolCalls,
    errors: acc.errors + day.errors,
    lines: acc.lines + day.linesChanged,
  }), { turns: 0, tools: 0, errors: 0, lines: 0 })
  return (
    <>
      <PageIntro
        index="07"
        eyebrow="Operational telemetry"
        title={<>The shape of<br /><em>the work.</em></>}
        description="A two-week read on agent velocity, tool intensity, code movement, and friction."
      />
      <section className="signal-metrics">
        <SignalMetric label="Turns" value={formatNumber(totals.turns)} icon={TimerReset} />
        <SignalMetric label="Tool calls" value={formatNumber(totals.tools)} icon={ToolCase} />
        <SignalMetric label="Lines moved" value={formatNumber(totals.lines)} icon={FileCode2} />
        <SignalMetric label="Errors" value={formatNumber(totals.errors)} icon={CircleAlert} warning={totals.errors > 0} />
      </section>
      <Panel className="wide-activity section-gap" index="03A" title="Daily operating envelope" meta="Last 14 days">
        <ActivityMatrix days={data.activity} />
      </Panel>
      <section className="two-col-grid section-gap">
        <Panel index="03B" title="Tool distribution" meta="Session frequency">
          <RankedBars data={data.tools} empty="No tool activity has been recorded." />
        </Panel>
        <Panel index="03C" title="Model distribution" meta="Session frequency">
          <RankedBars data={data.models} empty="No model activity has been recorded." />
        </Panel>
      </section>
    </>
  )
}

function SignalMetric({ label, value, icon: Icon, warning = false }: { label: string; value: string; icon: LucideIcon; warning?: boolean }) {
  return (
    <div className={`signal-metric ${warning ? 'is-warning' : ''}`}>
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ActivityMatrix({ days }: { days: ActivityDay[] }) {
  const metrics: Array<{ key: keyof Pick<ActivityDay, 'turns' | 'toolCalls' | 'linesChanged' | 'errors'>; label: string }> = [
    { key: 'turns', label: 'Turns' },
    { key: 'toolCalls', label: 'Tools' },
    { key: 'linesChanged', label: 'Code Δ' },
    { key: 'errors', label: 'Errors' },
  ]
  return (
    <div className="activity-matrix">
      <div className="matrix-dates">
        <span />
        {days.map((day) => <span key={day.date}>{day.label}<small>{day.date.slice(8)}</small></span>)}
      </div>
      {metrics.map((metric) => {
        const max = Math.max(1, ...days.map((day) => day[metric.key]))
        return (
          <div className="matrix-row" key={metric.key}>
            <strong>{metric.label}</strong>
            {days.map((day) => {
              const value = day[metric.key]
              const intensity = value / max
              return (
                <div
                  key={day.date}
                  className={`matrix-cell ${metric.key === 'errors' && value ? 'is-error' : ''}`}
                  style={{ '--intensity': intensity } as React.CSSProperties}
                  title={`${day.date} · ${metric.label}: ${value}`}
                >
                  <span>{value ? formatNumber(value) : '·'}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function LibraryView({
  data,
  query,
  onQuery,
}: {
  data: DashboardPayload
  query: string
  onQuery: (value: string) => void
}) {
  const privacy = usePrivacy()
  const filtered = data.library.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
  const groups = [
    { kind: 'skill' as const, label: 'Skills', icon: Sparkles, copy: 'Reusable instruction packages available to Grok.' },
    { kind: 'agent' as const, label: 'Agent profiles', icon: Bot, copy: 'Specialized operating roles for delegated work.' },
    { kind: 'plugin' as const, label: 'Marketplace manifests', icon: Box, copy: 'Plugin packages discovered in the local cache.' },
  ]
  return (
    <>
      <PageIntro
        index="09"
        eyebrow="Capability library"
        title={<>What Grok can<br /><em>reach for.</em></>}
        description="The local skills, agent profiles, and marketplace packages shaping every run."
      />
      <div className="view-toolbar">
        <SearchField value={query} onChange={onQuery} placeholder="Filter the capability index…" />
        <div className="toolbar-stat"><strong>{filtered.length}</strong><span>capabilities visible</span></div>
      </div>
      <section className="library-grid">
        {groups.map((group, groupIndex) => {
          const Icon = group.icon
          const items = filtered.filter((item) => item.kind === group.kind)
          return (
            <Panel key={group.kind} index={`04${String.fromCharCode(65 + groupIndex)}`} title={group.label} meta={`${items.length} found`}>
              <div className="library-intro"><Icon size={20} /><p>{group.copy}</p></div>
              <div className="capability-list">
                {items.length ? items.map((item) => (
                  <div key={`${item.kind}:${item.name}`}>
                    <span className="capability-icon">{item.kind === 'skill' ? 'S' : item.kind === 'agent' ? 'A' : 'P'}</span>
                    <strong>{privacy.capability(item.name, group.label.slice(0, -1))}</strong>
                    <span className={`source-tag source-${item.source}`}>{item.source}</span>
                  </div>
                )) : <EmptyInline>No matching {group.label.toLowerCase()}.</EmptyInline>}
              </div>
            </Panel>
          )
        })}
      </section>
    </>
  )
}

function MemoryView({ data }: { data: DashboardPayload }) {
  const privacy = usePrivacy()
  const scopes = ['global', 'workspace', 'session']
  return (
    <>
      <PageIntro
        index="10"
        eyebrow="Durable recall"
        title={<>Memory without<br /><em>the mystery.</em></>}
        description="A privacy-conscious inventory of Grok’s durable Markdown memory. Content stays on disk and is not rendered here."
      />
      <section className="memory-hero">
        <div className="memory-symbol"><BrainCircuit size={44} strokeWidth={1.2} /><span /></div>
        <div>
          <span className="kicker">Experimental memory index</span>
          <strong>{data.memory.length}</strong>
          <p>local artifacts across {new Set(data.memory.map((item) => item.scope)).size} scopes</p>
        </div>
        <div className="privacy-badge"><ShieldCheck size={18} /><span><strong>Metadata only</strong><small>Prompts and memory body text stay hidden.</small></span></div>
      </section>
      <section className="memory-columns section-gap">
        {scopes.map((scope, scopeIndex) => {
          const items = data.memory.filter((item) => item.scope === scope)
          return (
            <Panel key={scope} index={`05${String.fromCharCode(65 + scopeIndex)}`} title={`${scope[0].toUpperCase()}${scope.slice(1)} memory`} meta={`${items.length} files`}>
              <div className="memory-file-list">
                {items.length ? items.map((item) => (
                  <div key={item.name}>
                    <Archive size={15} />
                    <span><strong>{privacy.memory(item.name)}</strong><small>{timeAgo(item.updatedAt)}</small></span>
                    <em>{formatBytes(item.bytes)}</em>
                  </div>
                )) : <EmptyInline>No {scope} memory files found.</EmptyInline>}
              </div>
            </Panel>
          )
        })}
      </section>
    </>
  )
}

function PageIntro({
  index,
  eyebrow,
  title,
  description,
}: {
  index: string
  eyebrow: string
  title: React.ReactNode
  description: string
}) {
  return (
    <header className="page-intro">
      <div className="intro-index">{index} / 11</div>
      <div>
        <div className="kicker">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      <p>{description}</p>
      <div className="intro-rule"><span /></div>
    </header>
  )
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="search-field">
      <Search size={17} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {value && <button onClick={() => onChange('')} aria-label="Clear search"><X size={15} /></button>}
      <kbd>/</kbd>
    </label>
  )
}

function CommandPalette({
  data,
  onClose,
  onNavigate,
  onSession,
}: {
  data: DashboardPayload | null
  onClose: () => void
  onNavigate: (view: ViewId) => void
  onSession: (session: SessionRow) => void
}) {
  const privacy = usePrivacy()
  const [value, setValue] = useState('')
  const normalized = value.toLowerCase()
  const navResults = NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(normalized))
  const sessionResults = (data?.sessions || []).filter((session) =>
    !session.archived
    && [session.title, session.workspace, session.model].some((item) => item.toLowerCase().includes(normalized)),
  ).slice(0, 5)

  return (
    <div className="palette-layer" role="dialog" aria-modal="true" aria-label="Command palette">
      <button className="palette-scrim" onClick={onClose} aria-label="Close command palette" />
      <div className="command-palette">
        <label>
          <Command size={18} />
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="Jump to a view or local session…" />
          <kbd>ESC</kbd>
        </label>
        <div className="palette-results">
          {navResults.length > 0 && <div className="palette-label">Views</div>}
          {navResults.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} onClick={() => onNavigate(item.id)}>
                <Icon size={16} /><span><strong>{item.label}</strong><small>{item.eyebrow}</small></span><kbd>{item.shortcut}</kbd>
              </button>
            )
          })}
          {sessionResults.length > 0 && <div className="palette-label">Recent sessions</div>}
          {sessionResults.map((session) => (
            <button key={session.id} onClick={() => onSession(session)}>
              <TerminalSquare size={16} />
              <span>
                <strong>{privacy.sessionTitle(session.title, session.id)}</strong>
                <small>{privacy.workspace(session.cwd)} · {session.model}</small>
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
          {!navResults.length && !sessionResults.length && <EmptyInline>No matching destination.</EmptyInline>}
        </div>
        <footer><span>↑↓ Navigate</span><span>↵ Open</span><span>Local metadata only</span></footer>
      </div>
    </div>
  )
}

function MobileNav({ active, onNavigate }: { active: ViewId; onNavigate: (view: ViewId) => void }) {
  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
      {NAV_ITEMS.filter((item) => item.id !== 'themes').map((item) => {
        const Icon = item.icon
        return <button key={item.id} className={active === item.id ? 'is-active' : ''} onClick={() => onNavigate(item.id)}><Icon size={18} /><span>{item.label}</span></button>
      })}
    </nav>
  )
}

function LoadingState() {
  return (
    <div className="loading-state">
      <div className="loader-orbit"><div /><div /><span>G</span></div>
      <div className="kicker">Reading local Grok state</div>
      <h1>Indexing the flight recorder.</h1>
      <p>Sessions, signals, capabilities, memory, and workspace metadata.</p>
    </div>
  )
}

function BootScreen({ label }: { label: string }) {
  return (
    <main className="access-screen">
      <AmbientGrid />
      <div className="access-card boot-card">
        <BrandLogo />
        <div className="loading-bars"><i /><i /><i /><i /></div>
        <strong>{label}</strong>
      </div>
    </main>
  )
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  return (
    <main className="access-screen">
      <AmbientGrid />
      <form
        className="access-card"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitting(true)
          setError('')
          void login(token)
            .then(onAuthenticated)
            .catch((loginError) => setError(loginError instanceof Error ? loginError.message : 'Sign in failed.'))
            .finally(() => setSubmitting(false))
        }}
      >
        <div className="brand-lockup access-brand">
          <BrandLogo />
          <div><div className="brand-word">GROK</div><div className="brand-sub">Secure command</div></div>
        </div>
        <div className="kicker"><ShieldCheck size={14} /> Remote access gate</div>
        <h1>Local power.<br /><em>One key in.</em></h1>
        <p>This instance is protected. Enter the token configured in <code>GROK_UI_TOKEN</code>.</p>
        <label>
          <span>ACCESS TOKEN</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoFocus
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="access-error">{error}</div>}
        <button className="launch-button" disabled={submitting}>
          <span>{submitting ? 'VERIFYING' : 'OPEN COMMAND DECK'}</span>
          <ArrowRight size={16} />
        </button>
      </form>
    </main>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-state">
      <CircleAlert size={38} />
      <div className="kicker">Link interrupted</div>
      <h1>Grok data is out of reach.</h1>
      <p>{message || 'The local API did not return a dashboard payload.'}</p>
      <button className="primary-button" onClick={onRetry}><RefreshCw size={16} /> Try again</button>
    </div>
  )
}

function EmptyInline({ children }: { children: React.ReactNode }) {
  return <div className="empty-inline">{children}</div>
}

function EmptyBlock({ icon: Icon, title, copy }: { icon: LucideIcon; title: string; copy: string }) {
  return <div className="empty-block"><Icon size={28} /><strong>{title}</strong><p>{copy}</p></div>
}

export default App
