import { Activity, AlertTriangle, ChevronRight, LoaderCircle, X } from 'lucide-react'
import { useState } from 'react'
import { getFleetSessionDetail } from '../../../api'
import { usePrivacy } from '../../../privacy'
import type { AgentSessionDetail, FleetHostView, SessionRow } from '../../../types'
import { FleetPanelEmpty, SectionState } from '../SectionState'
import { elapsedLabel, exactTime, integer, sessions } from '../model'

export function FleetSessions({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const observed = sessions(host)
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null)
  const [loadingId, setLoadingId] = useState('')
  const [error, setError] = useState('')

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

  return (
    <SectionState host={host} section="sessions">
      {observed.length ? (
        <>
          {error && <div className="fleet-partial-note" role="alert"><AlertTriangle size={14} /> {privacy.content(error)}</div>}
          <div className="fleet-table-wrap">
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
                      <button
                        className="fleet-inspect-session"
                        type="button"
                        onClick={() => void inspect(session)}
                        disabled={loadingId === session.id}
                        aria-label={`Inspect read-only session ${privacy.sessionTitle(session.title, `${host.id}:${session.id}`)}`}
                      >
                        {loadingId === session.id ? <LoaderCircle className="is-spinning" size={13} /> : <ChevronRight size={13} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
