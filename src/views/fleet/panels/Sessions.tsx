import { Activity, AlertTriangle, ChevronRight, LoaderCircle, MessageSquare, Play, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { getFleetSessionDetail, startRemoteSession } from '../../../api'
import { usePrivacy } from '../../../privacy'
import type { AgentSessionDetail, FleetHostView, SessionRow } from '../../../types'
import { FleetPanelEmpty, SectionState } from '../SectionState'
import { elapsedLabel, exactTime, integer, sessions } from '../model'

interface PendingCommand {
  commandId: string
  expiresAt: string
}

const PHONE_MEDIA_QUERY = '(max-width: 680px)'

function usePhoneLayout() {
  const [phoneLayout, setPhoneLayout] = useState(() => window.matchMedia(PHONE_MEDIA_QUERY).matches)

  useEffect(() => {
    const media = window.matchMedia(PHONE_MEDIA_QUERY)
    const update = () => setPhoneLayout(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return phoneLayout
}

function newCommand(): PendingCommand {
  const commandId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `remote-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { commandId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
}

export function FleetSessions({
  host,
  onOpenRemoteSession,
}: {
  host: FleetHostView
  onOpenRemoteSession: (host: FleetHostView, session: SessionRow) => void
}) {
  const privacy = usePrivacy()
  const phoneLayout = usePhoneLayout()
  const observed = sessions(host)
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null)
  const [loadingId, setLoadingId] = useState('')
  const [error, setError] = useState('')
  const [startPrompt, setStartPrompt] = useState('')
  const [startWorkspace, setStartWorkspace] = useState('')
  const [starting, setStarting] = useState(false)
  const startCommand = useRef<PendingCommand | null>(null)
  const workspaces = useMemo(() => [...new Map(
    observed.filter((session) => session.cwd).map((session) => [session.cwd, session.workspace || session.cwd]),
  )], [observed])
  const canControl = host.status === 'healthy'
    && host.freshness === 'fresh'
    && host.config.controlEnabled
    && host.config.hasControlToken
    && host.capabilities.includes('remote.sessions')
  const canStart = canControl && host.capabilities.includes('remote.sessions.create') && workspaces.length > 0
  const managedSessionIds = new Set(host.snapshot?.managedSessionIds || [])

  const inspect = async (session: SessionRow) => {
    setLoadingId(session.id)
    setError('')
    try {
      setDetail(await getFleetSessionDetail(host.id, session.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to read the remote session.')
    } finally {
      setLoadingId('')
    }
  }

  const start = async (event: FormEvent) => {
    event.preventDefault()
    const cwd = startWorkspace || workspaces[0]?.[0] || ''
    if (!cwd || !startPrompt.trim()) return
    const command = startCommand.current || newCommand()
    startCommand.current = command
    setStarting(true)
    setError('')
    try {
      const receipt = await startRemoteSession(host.id, {
        ...command,
        cwd,
        prompt: startPrompt.trim(),
      })
      if (!receipt.sessionId) throw new Error('The remote host did not identify the new session.')
      startCommand.current = null
      const template = observed.find((session) => session.cwd === cwd) || observed[0]!
      onOpenRemoteSession(host, {
        ...template,
        id: receipt.sessionId,
        title: startPrompt.trim().replace(/\s+/g, ' ').slice(0, 80),
        cwd,
        workspace: workspaces.find(([path]) => path === cwd)?.[1] || cwd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'live',
      })
      setStartPrompt('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to start remote work.')
    } finally {
      setStarting(false)
    }
  }

  return (
    <SectionState host={host} section="sessions">
      {observed.length ? (
        <>
          {canStart && (
            <form className="fleet-remote-start" onSubmit={start}>
              <div>
                <span>START SECURE REMOTE SESSION</span>
                <strong>Launch Grok in an already observed workspace.</strong>
              </div>
              <select
                aria-label="Remote workspace"
                value={startWorkspace || workspaces[0]?.[0] || ''}
                onChange={(event) => {
                  setStartWorkspace(event.target.value)
                  startCommand.current = null
                }}
              >
                {workspaces.map(([cwd, label]) => <option value={cwd} key={cwd}>{privacy.workspace(label)}</option>)}
              </select>
              <input
                aria-label="Remote task"
                value={startPrompt}
                maxLength={32_000}
                placeholder="What should Grok work on?"
                onChange={(event) => {
                  setStartPrompt(event.target.value)
                  startCommand.current = null
                }}
              />
              <button disabled={starting || !startPrompt.trim()}>
                {starting ? <LoaderCircle className="is-spinning" size={14} /> : <Play size={14} />}
                Start
              </button>
            </form>
          )}
          {!canControl && host.config.controlEnabled && (
            <div className="fleet-partial-note">
              <AlertTriangle size={14} /> Remote controls require a fresh, healthy host and negotiated control capability.
            </div>
          )}
          {error && <div className="fleet-partial-note" role="alert"><AlertTriangle size={14} /> {privacy.content(error)}</div>}
          {!phoneLayout && <div className="fleet-table-wrap">
            <table className="fleet-table fleet-session-table">
              <caption className="sr-only">Read-only sessions observed on this host</caption>
              <thead><tr><th>Status</th><th>Session</th><th>Workspace</th><th>Model</th><th>Turns</th><th>Updated</th><th><span className="sr-only">Inspect</span></th></tr></thead>
              <tbody>
                {observed.map((session) => (
                  <tr key={`${host.id}:${session.id}`}>
                    <td><span className={`fleet-session-state state-${session.status}`}><i /> {session.status}</span></td>
                    <td><strong>{privacy.sessionTitle(session.title, `${host.id}:${session.id}`)}</strong><small>{privacy.content(session.summary)}</small></td>
                    <td>{privacy.workspace(session.workspace || session.cwd)}</td>
                    <td>{session.model ? privacy.capability(session.model, 'Model') : '—'}</td>
                    <td>{integer.format(session.turns)}</td>
                    <td title={exactTime(session.updatedAt)}>{elapsedLabel(session.updatedAt)}</td>
                    <td>
                      <span className="fleet-session-actions">
                        {canControl && managedSessionIds.has(session.id) && (
                          <button
                            className="fleet-open-remote-session"
                            type="button"
                            onClick={() => onOpenRemoteSession(host, session)}
                            aria-label={`Continue remote session ${privacy.sessionTitle(session.title, `${host.id}:${session.id}`)}`}
                          >
                            <MessageSquare size={13} />
                          </button>
                        )}
                        <button
                          className="fleet-inspect-session"
                          type="button"
                          onClick={() => void inspect(session)}
                          disabled={loadingId === session.id}
                          aria-label={`Inspect read-only session ${privacy.sessionTitle(session.title, `${host.id}:${session.id}`)}`}
                        >
                          {loadingId === session.id ? <LoaderCircle className="is-spinning" size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          {phoneLayout && <div className="fleet-session-cards" role="list" aria-label="Sessions observed on this host">
            {observed.map((session) => {
              const title = privacy.sessionTitle(session.title, `${host.id}:${session.id}`)
              const managed = canControl && managedSessionIds.has(session.id)
              return (
                <article className="fleet-session-card" role="listitem" key={`mobile:${host.id}:${session.id}`}>
                  <header>
                    <span className={`fleet-session-state state-${session.status}`}><i /> {session.status}</span>
                    <time title={exactTime(session.updatedAt)}>{elapsedLabel(session.updatedAt)}</time>
                  </header>
                  <div className="fleet-session-card-copy">
                    <strong>{title}</strong>
                    <small>{privacy.content(session.summary)}</small>
                  </div>
                  <dl>
                    <div>
                      <dt>Workspace</dt>
                      <dd>{privacy.workspace(session.workspace || session.cwd)}</dd>
                    </div>
                    <div>
                      <dt>Model</dt>
                      <dd>{session.model ? privacy.capability(session.model, 'Model') : '—'}</dd>
                    </div>
                    <div>
                      <dt>Turns</dt>
                      <dd>{integer.format(session.turns)}</dd>
                    </div>
                  </dl>
                  <footer>
                    {managed && (
                      <button
                        className="fleet-card-continue"
                        type="button"
                        onClick={() => onOpenRemoteSession(host, session)}
                        aria-label={`Continue remote session ${title}`}
                      >
                        <MessageSquare size={15} />
                        Continue
                      </button>
                    )}
                    <button
                      className="fleet-card-inspect"
                      type="button"
                      onClick={() => void inspect(session)}
                      disabled={loadingId === session.id}
                      aria-label={`Inspect read-only session ${title}`}
                    >
                      {loadingId === session.id
                        ? <LoaderCircle className="is-spinning" size={15} />
                        : <ChevronRight size={15} />}
                      {loadingId === session.id ? 'Loading' : 'Inspect'}
                    </button>
                  </footer>
                </article>
              )
            })}
          </div>}
          {detail && (
            <section className="fleet-session-detail" aria-label={`Read-only session detail for ${privacy.sessionTitle(detail.session.title, detail.session.id)}`}>
              <header>
                <div><span>REMOTE SESSION / READ ONLY</span><h3>{privacy.sessionTitle(detail.session.title, detail.session.id)}</h3></div>
                <button type="button" onClick={() => setDetail(null)} aria-label="Close remote session detail"><X size={15} /></button>
              </header>
              <div className="fleet-session-detail-meta">
                <span><small>Workspace</small><strong>{privacy.workspace(detail.session.cwd)}</strong></span>
                <span><small>Model</small><strong>{detail.session.model ? privacy.capability(detail.session.model, 'Model') : '—'}</strong></span>
                <span><small>Turns</small><strong>{detail.session.turns}</strong></span>
                <span><small>Tools</small><strong>{detail.session.toolCalls}</strong></span>
              </div>
              <div className="fleet-session-transcript" aria-live="polite">
                {detail.transcript.slice(-80).map((item) => (
                  <article key={item.id}>
                    <header><strong>{item.type}</strong><time>{elapsedLabel(item.timestamp)}</time></header>
                    <p>{privacy.content(item.text || item.title)}</p>
                  </article>
                ))}
                {!detail.transcript.length && <p>No transcript events were included in this bounded detail.</p>}
              </div>
            </section>
          )}
        </>
      ) : (
        <FleetPanelEmpty
          icon={Activity}
          title="No remote sessions observed"
          copy="The host is healthy, but its bounded session snapshot is empty."
        />
      )}
    </SectionState>
  )
}
