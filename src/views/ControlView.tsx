import {
  Bell,
  Bot,
  Check,
  CircleStop,
  Command,
  CornerDownLeft,
  FolderGit2,
  Radio,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  cancelControlSession,
  createControlSession,
  promptControlSession,
  resolveControlPermission,
} from '../api'
import type {
  ControlSession,
  ControlSnapshot,
  DashboardPayload,
  LiveSnapshot,
} from '../types'
import { usePrivacy } from '../privacy'

interface ControlViewProps {
  data: DashboardPayload
  live: LiveSnapshot | null
  control: ControlSnapshot | null
  onRefresh: () => Promise<void>
  onOpenSession: (sessionId: string) => void
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function uniqueWorkspaces(data: DashboardPayload, live: LiveSnapshot | null): string[] {
  return [...new Set([
    ...(live?.agents.map((agent) => agent.cwd) || []),
    ...data.sessions.map((session) => session.cwd),
  ].filter(Boolean))]
}

function cancellationTime(session: ControlSession): string {
  const value = session.cancelledAt || session.cancelRequestedAt
  if (!value) return '—'
  return controlTime(value)
}

function controlTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function lastCompletedTool(session: ControlSession): string {
  return [...session.feed].reverse().find((item) =>
    item.type === 'tool' && ['completed', 'success', 'done'].includes(item.status.toLowerCase()),
  )?.title || 'No tool completed'
}

export function ControlView({ data, live, control, onRefresh, onOpenSession }: ControlViewProps) {
  const privacy = usePrivacy()
  const workspaces = useMemo(() => uniqueWorkspaces(data, live), [data, live])
  const resumable = useMemo(() => {
    const seen = new Set<string>()
    return [
      ...(control?.sessions || []).map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
      })),
      ...data.sessions.filter((session) => !session.archived),
    ].filter((session) => {
      if (seen.has(session.id)) return false
      seen.add(session.id)
      return true
    })
  }, [control, data.sessions])
  const [mode, setMode] = useState<'new' | 'resume'>('new')
  const [cwd, setCwd] = useState(workspaces[0] || '')
  const [sessionId, setSessionId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [selectedLane, setSelectedLane] = useState(control?.sessions[0]?.id || '')

  useEffect(() => {
    if (!control?.sessions.length) {
      setSelectedLane('')
      return
    }
    if (!control.sessions.some((session) => session.id === selectedLane)) {
      setSelectedLane(control.sessions[0].id)
    }
  }, [control?.sessions, selectedLane])

  const activeLane = control?.sessions.find((session) => session.id === selectedLane)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!prompt.trim()) return
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      if (mode === 'resume') {
        const selected = resumable.find((session) => session.id === sessionId)
        if (!selected) throw new Error('Choose a session to resume.')
        await promptControlSession(selected.id, { cwd: selected.cwd, prompt })
        setMessage(`Prompt sent to ${privacy.sessionTitle(selected.title, selected.id)}.`)
      } else {
        await createControlSession({ cwd, prompt, model, reasoningEffort })
        setMessage('New Grok lane launched.')
      }
      setPrompt('')
      await onRefresh()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Command failed.')
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async (id: string) => {
    setError('')
    try {
      await cancelControlSession(id)
      setMessage('Stop requested. Waiting for Grok to confirm cancellation.')
      await onRefresh()
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Unable to stop the session.')
    }
  }

  const resume = (session: ControlSession) => {
    setMode('resume')
    chooseSession(session.id)
    setMessage(`Ready to resume ${privacy.sessionTitle(session.title, session.id)}.`)
    window.requestAnimationFrame(() => {
      document.querySelector('.composer-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const decide = async (permissionId: string, optionId?: string) => {
    try {
      await resolveControlPermission(permissionId, optionId)
      await onRefresh()
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Unable to resolve permission.')
    }
  }

  const chooseSession = (id: string) => {
    setSessionId(id)
    const selected = resumable.find((session) => session.id === id)
    if (selected) setCwd(selected.cwd)
  }

  return (
    <>
      <section className="page-intro command-intro">
        <div className="page-intro-index">02 / 10</div>
        <div className="page-intro-copy">
          <div className="kicker"><Command size={14} /> Command deck</div>
          <h1>Don’t just watch.<br /><em>Run the room.</em></h1>
        </div>
        <p>Launch concurrent Grok agents, resume any conversation, approve sensitive work, and stop a turn without returning to the terminal.</p>
      </section>

      <section className="control-health-strip">
        <div>
          <span className={`status-dot ${control?.connected ? 'is-live' : ''}`} />
          <strong>{control?.connected
            ? 'ACP CONTROL LINKED'
            : control?.reconnecting
              ? `RECONNECTING CONTROL · ${control.reconnectAttempt}`
              : control?.starting
                ? 'STARTING CONTROL'
                : 'CONTROL OFFLINE'}</strong>
          <small>{control?.agentName || 'Grok'} {control?.agentVersion}</small>
        </div>
        <div><span>MANAGED LANES</span><strong>{control?.sessions.length || 0}</strong></div>
        <div className={control?.permissions.length ? 'is-attention' : ''}>
          <span>PENDING APPROVALS</span><strong>{control?.permissions.length || 0}</strong>
        </div>
        <button
          className="text-button"
          onClick={() => void Notification.requestPermission()}
          disabled={!('Notification' in window)}
        >
          <Bell size={14} /> Enable alerts
        </button>
      </section>

      {control?.error && (
        <div className="control-banner is-error"><ShieldAlert size={17} /><span>{privacy.content(control.error)}</span></div>
      )}
      {error && <div className="control-banner is-error"><X size={17} /><span>{privacy.content(error)}</span></div>}
      {message && <div className="control-banner is-success"><Check size={17} /><span>{message}</span></div>}

      <section className="command-deck-grid section-gap">
        <form className="composer-panel panel-cut" onSubmit={submit}>
          <header>
            <div>
              <span className="panel-index">01</span>
              <h2>Issue a command</h2>
            </div>
            <span className="composer-shortcut">⌘ ↵</span>
          </header>

          <div className="mode-switch" role="tablist" aria-label="Command target">
            <button type="button" className={mode === 'new' ? 'is-active' : ''} onClick={() => setMode('new')}>
              <Sparkles size={15} /> New agent
            </button>
            <button type="button" className={mode === 'resume' ? 'is-active' : ''} onClick={() => setMode('resume')}>
              <Radio size={15} /> Resume session
            </button>
          </div>

          {mode === 'resume' ? (
            <label className="control-field">
              <span>SESSION</span>
              <select value={sessionId} onChange={(event) => chooseSession(event.target.value)} required>
                <option value="">Choose a recorded session…</option>
                {resumable.map((session) => (
                  <option value={session.id} key={session.id}>
                    {privacy.sessionTitle(session.title, session.id)} — {privacy.identifier(session.id)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="control-field">
                <span>WORKSPACE</span>
                <input
                  list="grok-workspaces"
                  value={privacy.enabled ? '' : cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder={privacy.enabled ? 'Workspace path hidden — turn Privacy Mode off to edit' : '/absolute/path/to/project'}
                  readOnly={privacy.enabled}
                  required={!privacy.enabled}
                />
                <datalist id="grok-workspaces">
                  {!privacy.enabled && workspaces.map((workspace) => <option value={workspace} key={workspace} />)}
                </datalist>
              </label>
              <div className="control-field-row">
                <label className="control-field">
                  <span>MODEL <em>optional</em></span>
                  <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Use Grok default" />
                </label>
                <label className="control-field">
                  <span>REASONING</span>
                  <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
                    {['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => <option key={effort}>{effort}</option>)}
                  </select>
                </label>
              </div>
            </>
          )}

          <label className="prompt-field">
            <span>INSTRUCTION</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') event.currentTarget.form?.requestSubmit()
              }}
              placeholder="What should Grok do next?"
              rows={7}
              maxLength={32_000}
              required
            />
            <small>{compact(prompt.length)} / 32K</small>
          </label>

          <button
            className="launch-button"
            disabled={submitting || !control?.connected || (mode === 'new' && !cwd)}
          >
            <span>{submitting ? 'DISPATCHING' : mode === 'new' ? 'LAUNCH AGENT' : 'SEND PROMPT'}</span>
            <CornerDownLeft size={17} />
          </button>
          <p className="composer-note">Tool executions still pass through Grok’s native permission system. Nothing is silently auto-approved.</p>
        </form>

        <aside className="approval-panel">
          <header>
            <div>
              <span className="panel-index">02</span>
              <h2>Approval queue</h2>
            </div>
            <span className={`approval-count ${control?.permissions.length ? 'has-items' : ''}`}>
              {String(control?.permissions.length || 0).padStart(2, '0')}
            </span>
          </header>
          {control?.permissions.length ? (
            <div className="approval-list">
              {control.permissions.map((permission) => (
                <article className="approval-card" key={permission.id}>
                  <div className="approval-card-head">
                    <ShieldAlert size={18} />
                    <div>
                      <span>{permission.toolKind} / {privacy.identifier(permission.toolCallId)}</span>
                      <h3>{privacy.content(permission.title)}</h3>
                    </div>
                  </div>
                  <div className="approval-options">
                    {permission.options.map((option) => (
                      <button
                        key={option.id}
                        className={option.kind.includes('reject') ? 'is-reject' : ''}
                        onClick={() => void decide(permission.id, option.id)}
                      >
                        {option.kind.includes('reject') ? <X size={14} /> : <Check size={14} />}
                        {option.name}
                      </button>
                    ))}
                    <button className="is-reject" onClick={() => void decide(permission.id)}>
                      <CircleStop size={14} /> Cancel turn
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="approval-empty">
              <div className="approval-radar"><span /><i /></div>
              <strong>No decisions waiting.</strong>
              <p>Permission prompts appear here the moment Grok requests a protected tool.</p>
            </div>
          )}
        </aside>
      </section>

      <section className="managed-lanes section-gap">
        <header>
          <div><span className="panel-index">03</span><h2>Managed lanes</h2></div>
          <span>PARALLEL ACP SESSIONS</span>
        </header>
        {control?.sessions.length ? (
          <div className="lane-grid">
            {control.sessions.map((session, index) => (
              <article className={`lane-card state-${session.state} ${selectedLane === session.id ? 'is-selected' : ''}`} key={session.id}>
                <div className="lane-index">L{String(index + 1).padStart(2, '0')}</div>
                <div className="lane-main">
                  <div className="lane-state"><i /> {session.state}</div>
                  <h3>{privacy.sessionTitle(session.title, session.id)}</h3>
                  <p><FolderGit2 size={13} /> {privacy.path(session.cwd)}</p>
                </div>
                <div className="lane-telemetry">
                  <div><span>TOKENS</span><strong>{compact(session.totalTokens)}</strong></div>
                  <div><span>COST</span><strong>{session.costAmount ? `${session.costAmount.toFixed(3)} ${session.costCurrency}` : '—'}</strong></div>
                  <div>
                    <span>STOP</span>
                    <strong>{session.stopReason === 'stop_requested' ? 'requested' : session.stopReason || '—'}</strong>
                  </div>
                </div>
                <div className="lane-actions">
                  {['working', 'starting', 'attention'].includes(session.state) && (
                    <button className="stop-lane" onClick={() => void cancel(session.id)}>
                      <CircleStop size={15} /> Stop
                    </button>
                  )}
                  {session.state === 'stopping' && (
                    <button className="stop-lane" disabled>
                      <CircleStop size={15} /> Stop requested
                    </button>
                  )}
                  {session.state === 'failed' && ['timed_out', 'failed'].includes(session.cancellationStatus) && (
                    <button className="stop-lane" onClick={() => void cancel(session.id)}>
                      <CircleStop size={15} /> Retry stop
                    </button>
                  )}
                  {(
                    ['idle', 'cancelled'].includes(session.state)
                    || (session.state === 'failed' && session.stopReason === 'control_disconnected')
                  ) && (
                    <button className="resume-lane" onClick={() => resume(session)}>
                      <Radio size={15} /> Resume
                    </button>
                  )}
                  <button className="open-lane" onClick={() => setSelectedLane(session.id)}>
                    Open stream
                  </button>
                  <button className="open-lane" onClick={() => onOpenSession(session.id)}>
                    Open Session
                  </button>
                </div>
                {session.cancellationStatus !== 'none' && (
                  <div className={`lane-cancellation is-${session.cancellationStatus}`}>
                    <div>
                      <span>
                        {session.cancellationStatus === 'confirmed'
                          ? 'CANCELLED BY USER'
                          : session.cancellationStatus === 'requested'
                            ? 'STOP REQUESTED'
                            : 'STOP NOT CONFIRMED'}
                      </span>
                      <strong>
                        {session.error || (session.cancellationStatus === 'confirmed'
                          ? 'Grok confirmed the turn stopped.'
                          : 'Waiting for Grok to finish cancelling active work.')}
                      </strong>
                    </div>
                    <div><span>TIME</span><strong>{cancellationTime(session)}</strong></div>
                    <div><span>LAST COMPLETED TOOL</span><strong>{privacy.content(lastCompletedTool(session))}</strong></div>
                  </div>
                )}
                {session.error && session.cancellationStatus === 'none' && (
                  <div className="lane-cancellation is-failed">
                    <div>
                      <span>CONTROL INTERRUPTED</span>
                      <strong>{privacy.content(session.error)}</strong>
                    </div>
                    <div><span>TIME</span><strong>{controlTime(session.updatedAt)}</strong></div>
                    <div><span>RECOVERY</span><strong>Control reconnected; resume when ready</strong></div>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-lanes"><Bot size={22} /><span>Launch the first agent from the command deck.</span></div>
        )}
      </section>

      {activeLane && (
        <section className="managed-stream section-gap">
          <header>
            <div>
              <span className="panel-index">04</span>
              <div><span>MANAGED SESSION STREAM</span><h2>{privacy.sessionTitle(activeLane.title, activeLane.id)}</h2></div>
            </div>
            <span>{activeLane.feed.length} EVENTS</span>
          </header>
          <div className="managed-stream-feed" aria-live="polite">
            {activeLane.feed.length ? activeLane.feed.map((item, index) => (
              <article className={`managed-event event-${item.type}`} key={item.id}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <header>
                    <strong>{item.type}</strong>
                    <em>{item.status}</em>
                    <time>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </header>
                  <p>{privacy.content(item.text || item.title)}</p>
                </div>
              </article>
            )) : (
              <div className="stream-empty">Waiting for the first ACP session update.</div>
            )}
          </div>
        </section>
      )}
    </>
  )
}
