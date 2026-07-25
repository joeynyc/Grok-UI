import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  CircleStop,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Satellite,
  Workflow,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { controlWorkflow } from '../api'
import { usePrivacy } from '../privacy'
import type {
  ControlSnapshot,
  WorkflowControlAction,
  WorkflowRun,
  WorkflowRunStatus,
} from '../types'

type Filter = 'all' | 'active' | 'failed' | 'complete'

function displayStatus(status: WorkflowRunStatus): string {
  return status === 'budget-limited' ? 'budget limited' : status
}

function eventTime(input: string): string {
  if (!input) return 'No event timestamp'
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function matchesFilter(run: WorkflowRun, filter: Filter): boolean {
  if (filter === 'active') return run.status === 'running' || run.status === 'paused'
  if (filter === 'failed') return run.status === 'failed' || run.status === 'budget-limited'
  if (filter === 'complete') return run.status === 'completed' || run.status === 'cancelled'
  return true
}

function phaseProgress(run: WorkflowRun): number {
  if (!run.phases.length) return run.status === 'completed' ? 100 : 0
  const finished = run.phases.filter((phase) =>
    ['completed', 'complete', 'succeeded', 'success', 'done'].includes(phase.status.toLowerCase())).length
  return Math.round((finished / run.phases.length) * 100)
}

function runKey(run: WorkflowRun): string {
  return `${run.sessionId}:${run.id}`
}

function cssToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

function statusIcon(status: WorkflowRunStatus) {
  if (status === 'failed' || status === 'budget-limited') return <AlertTriangle size={15} />
  if (status === 'completed') return <CheckCircle2 size={15} />
  if (status === 'paused') return <Pause size={15} />
  if (status === 'cancelled' || status === 'interrupted') return <CircleStop size={15} />
  return <Satellite size={15} />
}

export function WorkflowsView({
  control,
  connected,
  onRefresh,
  onOpenSession,
}: {
  control: ControlSnapshot | null
  connected: boolean
  onRefresh: () => Promise<void>
  onOpenSession: (sessionId: string) => void
}) {
  const privacy = usePrivacy()
  const runs = control?.workflows || []
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState(runs[0] ? runKey(runs[0]) : '')
  const [pendingAction, setPendingAction] = useState<WorkflowControlAction | ''>('')
  const [error, setError] = useState('')

  const filtered = useMemo(
    () => runs.filter((run) => matchesFilter(run, filter)),
    [filter, runs],
  )

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId('')
      return
    }
    if (!filtered.some((run) => runKey(run) === selectedId)) setSelectedId(runKey(filtered[0]))
  }, [filtered, selectedId])

  const selected = filtered.find((run) => runKey(run) === selectedId) || filtered[0]
  const session = selected
    ? control?.sessions.find((item) => item.id === selected.sessionId)
    : undefined
  const active = runs.filter((run) => run.status === 'running' || run.status === 'paused').length
  const failed = runs.filter((run) => run.status === 'failed' || run.status === 'budget-limited').length
  const agentsActive = runs.reduce((sum, run) => sum + run.activeAgents, 0)
  const agentsUsed = runs.reduce((sum, run) => sum + run.agentsUsed, 0)
  const agentBudget = runs.reduce((sum, run) => sum + run.agentBudget, 0)

  const act = async (action: WorkflowControlAction) => {
    if (!selected) return
    setPendingAction(action)
    setError('')
    try {
      await controlWorkflow(selected.sessionId, selected.id, action)
      await onRefresh()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Unable to ${action} workflow.`)
    } finally {
      setPendingAction('')
    }
  }

  return (
    <>
      <header className="page-intro">
        <div className="intro-index">03 / 10</div>
        <div>
          <div className="kicker">Cross-session orchestration</div>
          <h1>Every run.<br /><em>One command field.</em></h1>
        </div>
        <p>Track Grok workflow phases, agent allocation, failures, and recoverable controls across every UI-managed session.</p>
        <div className="intro-rule"><span /></div>
      </header>

      <section className="live-summary-strip workflow-summary-strip">
        <div className={`live-summary-metric ${active ? 'live-tone-lime' : 'live-tone-paper'}`}>
          <span>Active runs</span><strong>{active}</strong><small>running or paused</small>
        </div>
        <div className={`live-summary-metric ${failed ? 'live-tone-coral' : 'live-tone-paper'}`}>
          <span>Recovery queue</span><strong>{failed}</strong><small>failed or budget limited</small>
        </div>
        <div className="live-summary-metric live-tone-paper">
          <span>Agents live</span><strong>{agentsActive}</strong><small>across managed workflows</small>
        </div>
        <div className="live-summary-metric live-tone-paper">
          <span>Agent budget</span><strong>{agentBudget ? `${agentsUsed}/${agentBudget}` : '—'}</strong>
          <small>{agentBudget ? `${Math.round((agentsUsed / agentBudget) * 100)}% deployed` : 'waiting for telemetry'}</small>
        </div>
      </section>

      {!runs.length ? (
        <section className="workflow-empty section-gap">
          <div className="workflow-radar" aria-hidden="true"><span /><span /><i /><b /></div>
          <div>
            <div className="kicker">Telemetry channel open</div>
            <h2>No managed workflow runs yet.</h2>
            <p>
              Launch <code>/workflow &lt;name&gt;</code> from a Grok UI-managed session. Grok Build
              v0.2.112+ runs appear here when their live workflow update arrives.
            </p>
            <small>
              This view does not scrape terminal output or claim historical CLI-only runs it cannot observe.
            </small>
          </div>
          <button className="text-button" type="button" onClick={() => void onRefresh()}>
            Refresh channel <RefreshCw size={14} />
          </button>
        </section>
      ) : (
        <>
          <div className="workflow-toolbar section-gap">
            <div className="workflow-filter" role="group" aria-label="Workflow status filter">
              {(['all', 'active', 'failed', 'complete'] as Filter[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={filter === item ? 'is-active' : ''}
                  onClick={() => setFilter(item)}
                >
                  {item}
                  <span>{runs.filter((run) => matchesFilter(run, item)).length}</span>
                </button>
              ))}
            </div>
            <div className={`workflow-link-state ${connected && control?.connected ? 'is-live' : ''}`}>
              <i />
              {connected && control?.connected ? 'Grok workflow stream linked' : 'Workflow stream reconnecting'}
            </div>
          </div>

          {selected ? (
            <section className="workflow-console">
              <aside className="workflow-run-list">
                <header>
                  <span>RUN FIELD / {String(filtered.length).padStart(2, '0')}</span>
                  <Workflow size={15} />
                </header>
                <div>
                  {filtered.map((run, index) => (
                    <button
                      key={`${run.sessionId}:${run.id}`}
                      type="button"
                      className={runKey(run) === runKey(selected) ? 'is-active' : ''}
                      onClick={() => setSelectedId(runKey(run))}
                    >
                      <span className="workflow-run-index">R{String(index + 1).padStart(2, '0')}</span>
                      <span className={`workflow-status-glyph workflow-status-${run.status}`}>
                        {statusIcon(run.status)}
                      </span>
                      <span className="workflow-run-copy">
                        <strong>{privacy.capability(run.displayName, 'Run')}</strong>
                        <small>{privacy.content(run.objective || run.lastEventDetail || 'Workflow objective unavailable')}</small>
                      </span>
                      <span className={`workflow-status-label workflow-status-${run.status}`}>
                        {displayStatus(run.status)}
                      </span>
                    </button>
                  ))}
                </div>
              </aside>

              <article className="workflow-mission">
                <header className="workflow-mission-head">
                  <div>
                    <span className={`workflow-status-label workflow-status-${selected.status}`}>
                      {statusIcon(selected.status)} {displayStatus(selected.status)}
                    </span>
                    <h2>{privacy.capability(selected.displayName, 'Run')}</h2>
                    <p>{privacy.content(selected.objective || 'No workflow objective was reported.')}</p>
                  </div>
                  <div className="workflow-parent">
                    <span>Parent session</span>
                    <strong>{session ? privacy.sessionTitle(session.title, session.id) : 'Managed session'}</strong>
                    <small>{session ? privacy.workspace(session.cwd) : privacy.identifier(selected.sessionId)}</small>
                    <button type="button" onClick={() => onOpenSession(selected.sessionId)}>
                      Open workbench <ArrowUpRight size={13} />
                    </button>
                  </div>
                </header>

                {(selected.status === 'failed' || selected.status === 'budget-limited') && (
                  <div className="workflow-recovery">
                    <span><RotateCcw size={17} /></span>
                    <div>
                      <strong>{selected.status === 'failed' ? 'Recovery point available' : 'Agent budget exhausted'}</strong>
                      <p>{privacy.content(selected.lastEventDetail || selected.pauseMessage || 'The run stopped before completion.')}</p>
                    </div>
                    {selected.canResume ? (
                      <button
                        className="workflow-primary-action"
                        type="button"
                        disabled={Boolean(pendingAction)}
                        onClick={() => void act('resume')}
                      >
                        <Play size={14} fill="currentColor" />
                        {pendingAction === 'resume' ? 'Resuming…' : 'Resume run'}
                      </button>
                    ) : <small>Resume is unavailable for this run state.</small>}
                  </div>
                )}

                <section className="workflow-phase-panel">
                  <header>
                    <div>
                      <span>PHASE PROGRESSION</span>
                      <strong>{selected.currentPhase || 'Awaiting phase signal'}</strong>
                    </div>
                    <em>{phaseProgress(selected)}%</em>
                  </header>
                  <div className="workflow-progress-track">
                    <span style={{ width: `${phaseProgress(selected)}%` }} />
                  </div>
                  {selected.phases.length ? (
                    <div className="workflow-phase-rail">
                      {selected.phases.map((phase, index) => (
                        <div className={`workflow-phase workflow-phase-${cssToken(phase.status)}`} key={phase.id}>
                          <i>{String(index + 1).padStart(2, '0')}</i>
                          <span />
                          <div><strong>{phase.label}</strong><small>{phase.status.replaceAll('_', ' ')}</small></div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="workflow-muted">Grok has not reported a phase roster for this run.</p>}
                </section>

                <div className="workflow-detail-grid">
                  <section className="workflow-agent-panel">
                    <header>
                      <div><Bot size={15} /><span>AGENT ROSTER</span></div>
                      <strong>{selected.activeAgents} active / {selected.agentsUsed} used</strong>
                    </header>
                    {selected.agents.length ? (
                      <div className="workflow-agent-list">
                        {selected.agents.map((agent, index) => (
                          <div key={agent.id}>
                            <span className="workflow-agent-index">A{String(index + 1).padStart(2, '0')}</span>
                            <i className={`workflow-agent-dot agent-${cssToken(agent.status)}`} />
                            <span>
                              <strong>{privacy.capability(agent.label, 'Agent')}</strong>
                              <small>{privacy.content(agent.detail || 'No current detail')}</small>
                            </span>
                            <em>{agent.status.replaceAll('_', ' ')}</em>
                          </div>
                        ))}
                      </div>
                    ) : <p className="workflow-muted">No per-agent roster was included in the latest update.</p>}
                  </section>

                  <section className="workflow-event-panel">
                    <header><Satellite size={15} /><span>LATEST EVENT</span></header>
                    <strong>{selected.lastEvent ? selected.lastEvent.replaceAll('_', ' ') : 'workflow update'}</strong>
                    <p>{privacy.content(selected.lastEventDetail || selected.pauseMessage || 'No event detail was reported.')}</p>
                    <time>{eventTime(selected.lastEventAt || selected.updatedAt)}</time>
                    <div className="workflow-budget">
                      <span>Agent budget</span>
                      <strong>{selected.agentsUsed} / {selected.agentBudget || '—'}</strong>
                      <div><i style={{ width: `${selected.agentBudget ? Math.min(100, (selected.agentsUsed / selected.agentBudget) * 100) : 0}%` }} /></div>
                      {selected.usageIncomplete && <small>Usage total is still settling.</small>}
                    </div>
                  </section>
                </div>

                {selected.resultSummary && (
                  <section className="workflow-result">
                    <span>RESULT SUMMARY</span>
                    <p>{privacy.content(selected.resultSummary)}</p>
                  </section>
                )}

                <footer className="workflow-controls">
                  <span>Run controls</span>
                  <div>
                    <button type="button" disabled={!selected.canPause || Boolean(pendingAction)} onClick={() => void act('pause')}>
                      <Pause size={14} /> {pendingAction === 'pause' ? 'Pausing…' : 'Pause'}
                    </button>
                    <button type="button" disabled={!selected.canResume || Boolean(pendingAction)} onClick={() => void act('resume')}>
                      <Play size={14} /> {pendingAction === 'resume' ? 'Resuming…' : 'Resume'}
                    </button>
                    <button className="is-danger" type="button" disabled={!selected.canStop || Boolean(pendingAction)} onClick={() => void act('stop')}>
                      <CircleStop size={14} /> {pendingAction === 'stop' ? 'Stopping…' : 'Stop'}
                    </button>
                  </div>
                  {error && <p role="alert">{error}</p>}
                </footer>
              </article>
            </section>
          ) : (
            <section className="workflow-filter-empty">
              No workflow runs match this filter.
            </section>
          )}
        </>
      )}
    </>
  )
}
