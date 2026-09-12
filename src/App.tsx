import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getAuthStatus,
  getControlSnapshot,
  getDashboard,
  getFleetSnapshot,
  getLiveSnapshot,
  getRuntimeSnapshot,
  getSetupStatus,
  parseFleetSnapshot,
} from './api'
import { reconcileControlSnapshot } from './control-snapshot'
import { collectAttention, parseHash, writeHash } from './navigation'
import { PrivacyProvider } from './privacy'
import { CommandPalette } from './shell/CommandPalette'
import { HERO_STORAGE_KEY, HeroDensityProvider, storedHeroDensity, type HeroDensity } from './shell/hero'
import { MobileNav, NeedsYouBar } from './shell/MobileNav'
import { NAV_ITEMS } from './shell/nav'
import { AmbientGrid, AuthScreen, BootScreen, ErrorState, LoadingState, UnreachableScreen } from './shell/screens'
import { Sidebar } from './shell/Sidebar'
import { THEME_COLORS, storedPrivacy, storedTheme, type ThemeId } from './shell/themes'
import { TopBar } from './shell/TopBar'
import type {
  ControlSnapshot,
  DashboardPayload,
  FleetHostView,
  FleetSnapshot,
  LiveSnapshot,
  RuntimeSnapshot,
  SessionRow,
  SetupStatus,
  ViewId,
  WorkspaceChangeEvent,
} from './types'
import { ActivityView } from './views/ActivityView'
import { ChangesView } from './views/ChangesView'
import { ControlView } from './views/ControlView'
import { FleetView } from './views/FleetView'
import { LibraryView } from './views/LibraryView'
import { LiveView } from './views/LiveView'
import { MemoryView } from './views/MemoryView'
import { Overview } from './views/Overview'
import { RemoteSessionWorkbench } from './views/RemoteSessionWorkbench'
import { SessionsView } from './views/SessionsView'
import { SessionWorkbench } from './views/SessionWorkbench'
import { ThemesView } from './views/ThemesView'
import { UsageView } from './views/UsageView'
import { WorkflowsView } from './views/WorkflowsView'

// App owns routing, data loading, the event stream, keyboard shortcuts, and
// presentation preferences. Chrome lives in ./shell, rooms live in ./views.

function App() {
  const initialRoute = parseHash(window.location.hash)
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [authCheckError, setAuthCheckError] = useState('')
  const [view, setView] = useState<ViewId>(initialRoute.view)
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [live, setLive] = useState<LiveSnapshot | null>(null)
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null)
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null)
  const [control, setControl] = useState<ControlSnapshot | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [streamConnected, setStreamConnected] = useState(false)
  const [workspaceChange, setWorkspaceChange] = useState<WorkspaceChangeEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [fleetError, setFleetError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedSession, setSelectedSession] = useState<{
    id: string
    fallback: SessionRow | null
    opener: HTMLElement | null
  } | null>(initialRoute.sessionId ? { id: initialRoute.sessionId, fallback: null, opener: null } : null)
  const [remoteSession, setRemoteSession] = useState<{
    host: FleetHostView
    session: SessionRow
    opener: HTMLElement | null
  } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeId>(storedTheme)
  const [privacyMode, setPrivacyMode] = useState(storedPrivacy)
  const [heroDensity, setHeroDensity] = useState<HeroDensity>(storedHeroDensity)
  const lastAttentionRef = useRef(0)
  const lastInteractionRef = useRef<HTMLElement | null>(null)
  const mobileNavTriggerRef = useRef<HTMLElement | null>(null)
  const mobileNavOpenRef = useRef(false)
  const attention = useMemo(() => collectAttention(live, control), [control, live])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', THEME_COLORS[theme])
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

  useEffect(() => {
    try {
      localStorage.setItem(HERO_STORAGE_KEY, heroDensity)
    } catch {
      // The hero toggle still works for this visit when storage is unavailable.
    }
  }, [heroDensity])

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
        .then((next) => setControl((current) => reconcileControlSnapshot(current, next)))
        .catch(() => {
          // Dashboard and onboarding stay available if ACP is not ready yet.
        })
      void getFleetSnapshot()
        .then((next) => {
          setFleet(next)
          setFleetError('')
        })
        .catch((requestError) => {
          setFleetError(requestError instanceof Error ? requestError.message : 'Unable to read the fleet registry.')
        })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to read Grok data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  const checkAuth = useCallback(() => {
    setAuthCheckError('')
    setAuthenticated(null)
    void getAuthStatus()
      .then((status) => setAuthenticated(status.authenticated))
      .catch((checkError) => {
        // A failed status request means the local API is unreachable, not
        // that a token is required. Show a retry instead of the sign-in gate.
        console.warn('Grok UI server unreachable:', checkError)
        setAuthCheckError(checkError instanceof Error ? checkError.message : 'Authentication check failed')
      })
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

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
      const next = JSON.parse((event as MessageEvent).data) as ControlSnapshot
      setControl((current) => reconcileControlSnapshot(current, next))
    })
    events.addEventListener('runtime', (event) => {
      setStreamConnected(true)
      setRuntime(JSON.parse((event as MessageEvent).data) as RuntimeSnapshot)
    })
    events.addEventListener('workspace', (event) => {
      setStreamConnected(true)
      setWorkspaceChange(JSON.parse((event as MessageEvent).data) as WorkspaceChangeEvent)
    })
    events.addEventListener('fleet', (event) => {
      setStreamConnected(true)
      try {
        setFleet(parseFleetSnapshot(JSON.parse((event as MessageEvent).data)))
        setFleetError('')
      } catch {
        setFleetError('The fleet stream returned an invalid snapshot.')
      }
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
    writeHash({ view, sessionId: selectedSession?.id || null })
  }, [selectedSession?.id, view])

  useEffect(() => {
    const onHashChange = () => {
      const route = parseHash(window.location.hash)
      setView(route.view)
      setSelectedSession((current) => {
        if (!route.sessionId) return null
        if (current?.id === route.sessionId) return current
        return {
          id: route.sessionId,
          fallback: data?.sessions.find((item) => item.id === route.sessionId) || null,
          opener: null,
        }
      })
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [data?.sessions])

  const takeInteractionTarget = useCallback(() => {
    const interaction = lastInteractionRef.current?.isConnected
      ? lastInteractionRef.current
      : null
    lastInteractionRef.current = null
    if (interaction) return interaction
    return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
  }, [])

  const openMobileNav = useCallback(() => {
    mobileNavTriggerRef.current = takeInteractionTarget()
    mobileNavOpenRef.current = true
    setMobileNavOpen(true)
  }, [takeInteractionTarget])

  const closeMobileNav = useCallback(() => {
    if (!mobileNavOpenRef.current) return
    mobileNavOpenRef.current = false
    setMobileNavOpen(false)
    requestAnimationFrame(() => {
      const trigger = mobileNavTriggerRef.current
      mobileNavTriggerRef.current = null
      if (trigger?.isConnected) trigger.focus()
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      // Single-key room shortcuts must never fire while the user is entering
      // data. A focused <select> takes letters to pick an option, and a form in
      // a dialog (host editor, launch form) should not navigate away mid-entry.
      const typing = target !== null && (
        target.matches('input, textarea, select, [contenteditable="true"]')
        || target.closest('[role="dialog"]') !== null
      )
      if (selectedSession || remoteSession) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (event.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        else closeMobileNav()
        return
      }
      if (paletteOpen || mobileNavOpenRef.current) return
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
  }, [closeMobileNav, paletteOpen, remoteSession, selectedSession])

  const setActiveView = (next: ViewId) => {
    const focusMain = mobileNavOpenRef.current
    mobileNavOpenRef.current = false
    mobileNavTriggerRef.current = null
    setView(next)
    setQuery('')
    setMobileNavOpen(false)
    if (focusMain) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.main-stage')?.focus()
      })
    }
  }

  const refreshControl = useCallback(async () => {
    const next = await getControlSnapshot()
    setControl((current) => reconcileControlSnapshot(current, next))
  }, [])

  const refreshFleet = useCallback(async () => {
    try {
      const next = await getFleetSnapshot()
      setFleet(next)
      setFleetError('')
    } catch (requestError) {
      setFleetError(requestError instanceof Error ? requestError.message : 'Unable to read the fleet registry.')
    }
  }, [])

  const openSession = useCallback((session: SessionRow | string) => {
    const opener = takeInteractionTarget()
    setSelectedSession(typeof session === 'string'
      ? { id: session, fallback: data?.sessions.find((item) => item.id === session) || null, opener }
      : { id: session.id, fallback: session, opener })
  }, [data?.sessions, takeInteractionTarget])

  if (authCheckError) return <UnreachableScreen onRetry={checkAuth} />
  if (authenticated === null) return <BootScreen label="SECURING LOCAL LINK" />
  if (!authenticated) return <AuthScreen onAuthenticated={() => setAuthenticated(true)} />

  return (
    <PrivacyProvider enabled={privacyMode}>
      <HeroDensityProvider density={heroDensity} onChange={setHeroDensity}>
      <div
        className="app-shell"
        data-theme={theme}
        data-privacy={privacyMode ? 'on' : 'off'}
        data-hero={heroDensity}
        onClickCapture={(event) => {
          if (!(event.target instanceof Element)) return
          lastInteractionRef.current = event.target.closest<HTMLElement>(
            'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )
        }}
      >
        <AmbientGrid />
        <Sidebar
          active={view}
          connected={streamConnected}
          version={data?.version || '—'}
          open={mobileNavOpen}
          attention={attention}
          onNavigate={setActiveView}
          onClose={closeMobileNav}
        />

        <main className="main-stage" tabIndex={-1}>
          <TopBar
            active={view}
            connected={streamConnected}
            generatedAt={live?.generatedAt || data?.generatedAt}
            refreshing={refreshing}
            privacyMode={privacyMode}
            onMenu={openMobileNav}
            onPalette={() => setPaletteOpen(true)}
            onRefresh={() => void load(true)}
            onOpenThemes={() => setActiveView('themes')}
            onTogglePrivacy={() => setPrivacyMode((enabled) => !enabled)}
          />

        {loading ? (
          <LoadingState />
        ) : error || !data ? (
          <ErrorState message={error} onRetry={() => void load(true)} />
        ) : (
          <div className="view-wrap" key={view}>
            {!selectedSession && !remoteSession && (
              <NeedsYouBar
                attention={attention}
                privacyMode={privacyMode}
                onOpen={() => {
                  if (!attention.primary) return
                  openSession(attention.primary.sessionId)
                }}
              />
            )}
            {view === 'live' && (
              <LiveView
                live={live}
                runtime={runtime}
                data={data}
                control={control}
                setup={setup}
                connected={streamConnected}
                onOpenSession={openSession}
                onRefresh={() => void load(true)}
                onRefreshControl={refreshControl}
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
            {view === 'fleet' && (
              <FleetView
                fleet={fleet}
                streamConnected={streamConnected}
                error={fleetError}
                onReload={refreshFleet}
                onFleetChange={setFleet}
                onOpenRemoteSession={(host, session) => {
                  setRemoteSession({ host, session, opener: takeInteractionTarget() })
                }}
              />
            )}
            {view === 'library' && <LibraryView data={data} query={query} onQuery={setQuery} />}
            {view === 'memory' && <MemoryView data={data} />}
            {view === 'themes' && (
              <ThemesView
                active={theme}
                onSelect={setTheme}
                heroDensity={heroDensity}
                onHeroDensity={setHeroDensity}
              />
            )}
          </div>
        )}
        </main>

        {!selectedSession && !remoteSession && !paletteOpen && (
          <MobileNav
            active={view}
            attention={attention}
            onNavigate={setActiveView}
            onMore={openMobileNav}
            suspended={mobileNavOpen}
          />
        )}
        {selectedSession && (
          <SessionWorkbench
            sessionId={selectedSession.id}
            fallback={data?.sessions.find((item) => item.id === selectedSession.id) || selectedSession.fallback}
            live={live}
            control={control}
            returnFocus={selectedSession.opener}
            onClose={() => setSelectedSession(null)}
            onUpdated={() => load(true)}
          />
        )}
        {remoteSession && (
          <RemoteSessionWorkbench
            hostId={remoteSession.host.id}
            hostLabel={remoteSession.host.label}
            transport={remoteSession.host.transport}
            sessionId={remoteSession.session.id}
            fallback={remoteSession.session}
            returnFocus={remoteSession.opener}
            onClose={() => setRemoteSession(null)}
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
      </HeroDensityProvider>
    </PrivacyProvider>
  )
}

export default App
