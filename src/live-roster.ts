import type {
  ControlSession,
  ControlSnapshot,
  LiveAgent,
  LiveFeedItem,
  LiveSnapshot,
} from './types'

export type RosterState = 'attention' | 'working' | 'waiting' | 'idle' | 'failed'

export interface RosterRow {
  id: string
  title: string
  cwd: string
  state: RosterState
  source: 'live' | 'managed'
  parentId: string
  pid: number
  peek: LiveFeedItem[]
  children: RosterRow[]
}

export const ROSTER_GROUPS: Array<{ id: RosterState; label: string }> = [
  { id: 'attention', label: 'Needs input' },
  { id: 'working', label: 'Working' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'idle', label: 'Idle' },
  { id: 'failed', label: 'Failed' },
]

export function buildRoster(
  live: LiveSnapshot | null,
  control: ControlSnapshot | null,
): RosterRow[] {
  const rows = new Map<string, RosterRow>()
  for (const agent of live?.agents || []) {
    rows.set(agent.id, fromLive(agent))
  }
  for (const session of control?.sessions || []) {
    const existing = rows.get(session.id)
    if (existing) {
      existing.source = 'managed'
      existing.parentId = existing.parentId || session.parentSessionId
      if (session.feed.length) existing.peek = session.feed.slice(-4)
      if (session.state === 'attention' || session.state === 'failed' || pendingApproval(control, session.id)) {
        existing.state = session.state === 'failed' ? 'failed' : 'attention'
      }
      continue
    }
    rows.set(session.id, fromManaged(session, control))
  }
  const roots: RosterRow[] = []
  for (const row of rows.values()) {
    const parent = row.parentId ? rows.get(row.parentId) : undefined
    if (parent && parent.id !== row.id) parent.children.push(row)
    else roots.push(row)
  }
  return roots.sort(byAttention)
}

export function permissionsForSession(
  control: ControlSnapshot | null,
  sessionId: string,
) {
  return (control?.permissions || []).filter((permission) => permission.sessionId === sessionId)
}

export function shouldShowFirstRun(input: {
  setupReady?: boolean
  hasRoster: boolean
  archivedSessions: number
}) {
  if (input.setupReady === false) return true
  return !input.hasRoster && input.archivedSessions === 0
}

export function groupedRoster(rows: RosterRow[]): Array<{ id: RosterState; label: string; rows: RosterRow[] }> {
  return ROSTER_GROUPS
    .map((group) => ({
      ...group,
      rows: rows.filter((row) => row.state === group.id),
    }))
    .filter((group) => group.rows.length > 0)
}

function fromLive(agent: LiveAgent): RosterRow {
  return {
    id: agent.id,
    title: agent.title,
    cwd: agent.cwd,
    state: agent.state === 'attention' ? 'attention' : agent.state === 'working' ? 'working' : agent.state === 'waiting' ? 'waiting' : 'idle',
    source: 'live',
    parentId: '',
    pid: agent.pid,
    peek: agent.feed.slice(-4),
    children: [],
  }
}

function pendingApproval(control: ControlSnapshot | null | undefined, sessionId: string): boolean {
  return Boolean(control?.permissions.some((permission) => permission.sessionId === sessionId))
}

function fromManaged(session: ControlSession, control: ControlSnapshot | null): RosterRow {
  const state: RosterState = session.state === 'failed'
    ? 'failed'
    : session.state === 'attention' || pendingApproval(control, session.id)
      ? 'attention'
      : session.state === 'working' || session.state === 'starting' || session.state === 'stopping'
        ? 'working'
        : 'idle'
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    state,
    source: 'managed',
    parentId: session.parentSessionId,
    pid: 0,
    peek: session.feed.slice(-4),
    children: [],
  }
}

function byAttention(left: RosterRow, right: RosterRow): number {
  const rank = (state: RosterState) => ROSTER_GROUPS.findIndex((group) => group.id === state)
  return rank(left.state) - rank(right.state) || left.title.localeCompare(right.title)
}
