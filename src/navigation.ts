import type { ControlSnapshot, LiveSnapshot, ViewId } from './types'

export interface AppRoute {
  view: ViewId
  sessionId: string | null
}

export interface AttentionTarget {
  kind: 'permission' | 'live'
  sessionId: string
  title: string
}

export interface AttentionState {
  permissionCount: number
  liveCount: number
  primary: AttentionTarget | null
}

export const VIEW_IDS: ViewId[] = [
  'live',
  'control',
  'runs',
  'changes',
  'overview',
  'sessions',
  'activity',
  'usage',
  'fleet',
  'library',
  'memory',
  'themes',
]

export const NAV_GROUPS: Array<{ id: string; label: string; items: ViewId[] }> = [
  { id: 'work', label: 'Work', items: ['live', 'runs', 'changes', 'sessions'] },
  { id: 'look-back', label: 'Look back', items: ['overview', 'usage'] },
  { id: 'system', label: 'System', items: ['fleet'] },
]

export function isViewId(value: string): value is ViewId {
  return VIEW_IDS.includes(value as ViewId)
}

export function parseHash(hash: string): AppRoute {
  const raw = hash.replace(/^#\/?/, '')
  if (!raw) return { view: 'live', sessionId: null }

  const slash = raw.indexOf('/')
  const viewPart = decodeURIComponent(slash === -1 ? raw : raw.slice(0, slash))
  const sessionPart = slash === -1 ? '' : raw.slice(slash + 1)
  const view = isViewId(viewPart) ? viewPart : 'live'
  const sessionId = sessionPart ? decodeURIComponent(sessionPart) : null
  return { view, sessionId }
}

export function formatHash(route: AppRoute): string {
  const view = isViewId(route.view) ? route.view : 'live'
  if (!route.sessionId) return `#/${view}`
  return `#/${view}/${encodeURIComponent(route.sessionId)}`
}

export function writeHash(route: AppRoute): void {
  const next = formatHash(route)
  if (window.location.hash !== next) {
    history.replaceState(null, '', next)
  }
}

export function collectAttention(
  live: LiveSnapshot | null,
  control: ControlSnapshot | null,
): AttentionState {
  const permissions = control?.permissions || []
  const agents = (live?.agents || []).filter((agent) => agent.state === 'attention')
  const permission = permissions[0]
  const agent = agents[0]

  return {
    permissionCount: permissions.length,
    liveCount: live?.attentionCount || agents.length,
    primary: permission
      ? { kind: 'permission', sessionId: permission.sessionId, title: permission.title }
      : agent
        ? { kind: 'live', sessionId: agent.id, title: agent.title }
        : null,
  }
}

export function navBadgeCount(view: ViewId, attention: AttentionState): number {
  if (view === 'live') return attention.permissionCount + attention.liveCount
  return 0
}
