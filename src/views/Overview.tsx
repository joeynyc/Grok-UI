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
import { formatBytes, formatNumber, timeAgo } from '../format'
import { usePrivacy } from '../privacy'
import { EmptyInline, PageIntro, Panel, StatusGlyph } from '../shell/primitives'
import type { DashboardPayload, LiveSnapshot, RankedDatum, SessionRow, ViewId } from '../types'
import { ActivityMatrix, RankedBars, SignalMetrics, activityTotals } from './ActivityView'

export function Overview({
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
  const totals = activityTotals(data.activity)
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

      <section className="signal-metrics section-gap">
        <SignalMetrics totals={totals} />
      </section>
      <Panel className="wide-activity section-gap" index="02" title="Last 14 days">
        <ActivityMatrix days={data.activity} />
      </Panel>
      <section className="two-col-grid section-gap lower-grid">
        <Panel
          className="recent-panel"
          index="03"
          title="Recent sessions"
          meta={`${live?.activeCount || 0} live now`}
          action={<button className="text-button" onClick={() => onNavigate('sessions')}>View archive <ArrowRight size={14} /></button>}
        >
          <SessionList sessions={recent} onOpen={onOpenSession} />
        </Panel>
        <div className="side-stack">
          <Panel index="04" title="Tool signature" meta={`${data.tools.length} detected`}>
            <RankedBars data={data.tools.slice(0, 6)} empty="No tool signals recorded yet." />
          </Panel>
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
        <div className="hero-label">Sessions recorded</div>
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
          <small title="Calculated from recorded errors per turn">Health</small>
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
