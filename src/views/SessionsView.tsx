import { Archive, ChevronRight, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatNumber, timeAgo } from '../format'
import { usePrivacy } from '../privacy'
import { EmptyBlock, PageIntro, SearchField, StatusGlyph } from '../shell/primitives'
import type { DashboardPayload, LiveSnapshot, SessionRow } from '../types'

/** Overlay the live monitor's state on an archived row so the table matches Live. */
export function liveSessionStatus(session: SessionRow, live: LiveSnapshot | null): SessionRow['status'] {
  const agent = live?.agents.find((item) => item.id === session.id)
  if (!agent) return session.status === 'live' || session.status === 'attention' ? 'recent' : session.status
  if (agent.state === 'attention') return 'attention'
  if (agent.state === 'working' || agent.state === 'waiting') return 'live'
  return 'recent'
}

export function SessionsView({
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
        index="04"
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
