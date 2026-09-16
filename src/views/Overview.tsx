import {
  ArrowRight,
  ChevronRight,
  Database,
  FileCode2,
  FolderGit2,
  TimerReset,
  ToolCase,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { countLabel, formatBytes, formatNumber, timeAgo } from '../format'
import { usePrivacy } from '../privacy'
import { EmptyInline, PageIntro, Panel, StatusGlyph } from '../shell/primitives'
import type { DashboardPayload, LiveSnapshot, RankedDatum, SessionRow, ViewId } from '../types'
import { ActivityMatrix, RankedBars } from './ActivityView'
import { liveSessionStatus } from './SessionsView'

export function recentOverviewSessions(sessions: SessionRow[], limit = 6): SessionRow[] {
  return sessions
    .filter((session) => !session.archived && (session.turns > 0 || session.toolCalls > 0))
    .slice(0, limit)
}

export function Overview({
  data,
  live,
  connected,
  onOpenSession,
  onNavigate,
  onSearchSessions,
}: {
  data: DashboardPayload
  live: LiveSnapshot | null
  connected: boolean
  onOpenSession: (session: SessionRow) => void
  onNavigate: (view: ViewId) => void
  onSearchSessions: (query: string) => void
}) {
  const recent = recentOverviewSessions(data.sessions)
  const archivedCount = data.sessions.filter((session) => !session.archived).length
  return (
    <>
      <PageIntro
        index="05"
        eyebrow="Look back"
        title={<>Your Grok,<br /><em>at a glance.</em></>}
        description="All-time totals for local Grok sessions, plus the last two weeks of sessions last active — not a day-by-day work log."
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
          onClick={() => onSearchSessions('')}
        />
        <MetricCard
          index="A2"
          label="Tool calls"
          value={formatNumber(data.stats.toolCalls)}
          detail={`${data.stats.errors ? formatNumber(data.stats.errors) : 'No'} flagged errors`}
          icon={ToolCase}
          tone={data.stats.errors ? 'coral' : 'paper'}
          onClick={() => onNavigate('activity')}
        />
        <MetricCard
          index="A3"
          label="Files touched"
          value={formatNumber(data.stats.filesTouched)}
          detail={`${formatNumber(data.stats.linesChanged)} lines changed`}
          icon={FileCode2}
          tone="paper"
          onClick={() => onNavigate('changes')}
        />
        <MetricCard
          index="A4"
          label="Grok home"
          value={formatBytes(data.stats.dataBytes)}
          detail={`${countLabel(data.stats.memoryFiles, 'memory artifact')}`}
          icon={Database}
          tone="paper"
          onClick={() => onNavigate('memory')}
        />
      </section>

      <Panel
        className="wide-activity section-gap"
        index="02"
        title="Last 14 days"
        meta="Last active that day"
        action={<button className="text-button" onClick={() => onNavigate('activity')}>Activity <ArrowRight size={14} /></button>}
      >
        <ActivityMatrix days={data.activity} />
      </Panel>
      <section className="two-col-grid section-gap lower-grid">
        <Panel
          className="recent-panel"
          index="03"
          title="Recent sessions"
          meta={`${live?.activeCount || 0} live now`}
          action={<button className="text-button" onClick={() => onSearchSessions('')}>View archive <ArrowRight size={14} /></button>}
        >
          <SessionList
            sessions={recent}
            live={live}
            hasArchive={archivedCount > 0}
            onOpen={onOpenSession}
          />
        </Panel>
        <div className="side-stack">
          <Panel index="04" title="Tool signature" meta="Session frequency">
            <RankedBars data={data.tools.slice(0, 6)} empty="No tool signals recorded yet." />
          </Panel>
          <Panel index="05" title="Model mix" meta={`${data.models.length} in rotation`}>
            <ModelMix data={data.models} />
          </Panel>
          <Panel index="06" title="Workspace pulse" meta={`${data.stats.workspaces} indexed`}>
            <WorkspaceList data={data.workspaces.slice(0, 5)} onOpen={onSearchSessions} />
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
  const empty = data.stats.sessions === 0
  return (
    <article className="system-card panel-cut">
      <div className="system-card-grid" aria-hidden="true" />
      <div className="card-index">SYS / 00</div>
      <div className="system-card-copy">
        <div className="kicker"><Zap size={14} fill="currentColor" /> Runtime corpus</div>
        <div className="hero-number">{formatNumber(data.stats.sessions)}</div>
        <div className="hero-label">Sessions recorded</div>
        <div className="system-readouts">
          <div><span>Live agents</span><strong>{live?.activeCount || 0}</strong></div>
          <div><span>Skills</span><strong>{data.stats.skills}</strong></div>
          <div title="Mean of each session's last recorded context occupancy, not live.">
            <span>Avg context</span>
            <strong>{Math.round(data.stats.contextAverage * 100)}%</strong>
          </div>
        </div>
      </div>
      <div className="system-orbit" aria-hidden="true">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <div className="orbit-center">
          <span>{empty ? '—' : formatNumber(data.stats.errors)}</span>
          <small title="Flagged errors and tool failures in session signals">Errors</small>
        </div>
        <div className="orbit-node node-one" />
        <div className="orbit-node node-two" />
        <div className="orbit-node node-three" />
      </div>
      <div className="system-footer">
        <span>
          <span className={`status-dot ${connected ? 'is-live' : ''}`} />
          {connected ? 'Updates connected' : 'Updates reconnecting'}
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
  onClick,
}: {
  index: string
  label: string
  value: string
  detail: string
  icon: LucideIcon
  tone: 'lime' | 'coral' | 'paper'
  onClick: () => void
}) {
  return (
    <button type="button" className={`metric-card tone-${tone}`} onClick={onClick}>
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
    </button>
  )
}

function SessionList({
  sessions,
  live,
  hasArchive,
  onOpen,
}: {
  sessions: SessionRow[]
  live: LiveSnapshot | null
  hasArchive: boolean
  onOpen: (session: SessionRow) => void
}) {
  const privacy = usePrivacy()
  if (!sessions.length) {
    return (
      <EmptyInline>
        {hasArchive
          ? 'No recent sessions with recorded turns or tools.'
          : 'No Grok sessions have been indexed yet.'}
      </EmptyInline>
    )
  }
  return (
    <div className="session-list">
      {sessions.map((session) => {
        const status = liveSessionStatus(session, live)
        return (
          <button className="session-row" key={session.id} onClick={() => onOpen(session)}>
            <StatusGlyph status={status} />
            <div className="session-copy">
              <strong>{privacy.sessionTitle(session.title, session.id)}</strong>
              <span>{privacy.workspace(session.workspace)} / {session.model}</span>
            </div>
            <div className="session-metrics">
              <span>{countLabel(session.toolCalls, 'tool')}</span>
              <span>{countLabel(session.turns, 'turn')}</span>
            </div>
            <time>{timeAgo(session.updatedAt)}</time>
            <ChevronRight size={16} />
          </button>
        )
      })}
    </div>
  )
}

function ModelMix({ data }: { data: RankedDatum[] }) {
  const privacy = usePrivacy()
  const visible = data.slice(0, 4)
  const shown = visible.reduce((sum, item) => sum + item.value, 0)
  const rest = data.slice(4).reduce((sum, item) => sum + item.value, 0)
  const total = shown + rest
  if (!data.length) return <EmptyInline>No model usage recorded.</EmptyInline>
  const segments = rest
    ? [...visible, { name: 'Other', value: rest }]
    : visible
  return (
    <div className="model-mix">
      <div className="segmented-track">
        {segments.map((item, index) => (
          <span
            key={item.name}
            className={`segment segment-${Math.min(index, 3)}`}
            style={{ width: `${total ? (item.value / total) * 100 : 0}%` }}
          />
        ))}
      </div>
      <div className="model-list">
        {segments.map((item, index) => (
          <div key={item.name}>
            <i className={`model-dot segment-${Math.min(index, 3)}`} />
            <span>{item.name === 'Other' ? 'Other' : privacy.capability(item.name, 'Model')}</span>
            <strong>{Math.round((item.value / total) * 100)}%</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspaceList({ data, onOpen }: { data: RankedDatum[]; onOpen: (query: string) => void }) {
  const privacy = usePrivacy()
  if (!data.length) return <EmptyInline>No workspace metadata available.</EmptyInline>
  return (
    <div className="workspace-list">
      {data.map((item, index) => (
        <button type="button" className="workspace-row" key={item.name} onClick={() => onOpen(item.name)}>
          <span className="workspace-index">W{String(index + 1).padStart(2, '0')}</span>
          <FolderGit2 size={15} />
          <strong>{privacy.workspace(item.name)}</strong>
          <span>{countLabel(item.value, 'session')}</span>
        </button>
      ))}
    </div>
  )
}
