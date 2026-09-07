import { ArrowRight, Check, ChevronRight, CornerDownLeft, ShieldAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { promptControlSession, resolveControlPermission } from '../api'
import { buildRoster, groupedRoster, peekText, permissionsForSession } from '../live-roster'
import { usePrivacy } from '../privacy'
import type { ControlSnapshot, LiveSnapshot, SessionRow } from '../types'

export function LiveRoster({
  live,
  control,
  sessions,
  onOpenSession,
  onRefresh,
}: {
  live: LiveSnapshot | null
  control: ControlSnapshot | null
  sessions: SessionRow[]
  onOpenSession: (session: SessionRow | string) => void
  onRefresh: () => Promise<void>
}) {
  const privacy = usePrivacy()
  const roots = useMemo(() => buildRoster(live, control), [control, live])
  const groups = useMemo(() => groupedRoster(roots), [roots])
  const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const [selectedId, setSelectedId] = useState(flat[0]?.id || '')
  const selected = flat.find((row) => row.id === selectedId) || flat[0]
  const pending = selected ? permissionsForSession(control, selected.id) : []
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!flat.length) {
      setSelectedId('')
      return
    }
    if (!flat.some((row) => row.id === selectedId)) setSelectedId(flat[0].id)
  }, [flat, selectedId])

  const open = (id: string) => {
    const session = sessions.find((item) => item.id === id)
    onOpenSession(session || id)
  }

  const decide = async (permissionId: string, optionId?: string) => {
    setError('')
    try {
      await resolveControlPermission(permissionId, optionId)
      await onRefresh()
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Unable to resolve permission.')
    }
  }

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected || !reply.trim()) return
    setSending(true)
    setError('')
    try {
      await promptControlSession(selected.id, { cwd: selected.cwd, prompt: reply })
      setReply('')
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send reply.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="live-console-grid section-gap">
      <aside className="agent-roster">
        <header>
          <span>ACTIVE / {String(flat.length).padStart(2, '0')}</span>
          <span className="live-word"><i /> LIVE</span>
        </header>
        <div className="agent-roster-list">
          {groups.map((group) => (
            <div className="roster-group" key={group.id}>
              <small>{group.label}</small>
              {group.rows.map((row) => (
                <button
                  key={row.id}
                  className={selected?.id === row.id ? 'is-active' : ''}
                  onClick={() => setSelectedId(row.id)}
                >
                  <span className={`roster-state is-${row.state}`} />
                  <span className="agent-roster-copy">
                    <strong>{privacy.sessionTitle(row.title, row.id)}</strong>
                    <small>
                      {privacy.workspace(row.cwd)}
                      {row.pid ? ` · ${privacy.enabled ? 'PID ••••' : `PID ${row.pid}`}` : ''}
                      {row.children.length ? ` · ${row.children.length} subagents` : ''}
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <section className="runtime-console">
        {selected ? (
          <>
            <header className="runtime-head">
              <div className="runtime-identity">
                <span className={`roster-state is-${selected.state}`} />
                <div>
                  <span>{privacy.workspace(selected.cwd)}</span>
                  <h2>{privacy.sessionTitle(selected.title, selected.id)}</h2>
                </div>
              </div>
              <div className="runtime-actions">
                <button className="text-button" type="button" onClick={() => open(selected.id)}>
                  Open Session <ArrowRight size={14} />
                </button>
              </div>
            </header>
            <div className="roster-peek">
              {pending.map((permission) => (
                <article className="roster-approval" key={permission.id}>
                  <header>
                    <ShieldAlert size={16} />
                    <div>
                      <small>Needs you</small>
                      <strong>{privacy.content(permission.title)}</strong>
                    </div>
                  </header>
                  <div className="approval-options">
                    {permission.options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={option.kind.includes('reject') ? 'is-reject' : ''}
                        onClick={() => void decide(permission.id, option.id)}
                      >
                        {option.kind.includes('reject') ? <X size={14} /> : <Check size={14} />}
                        {option.name}
                      </button>
                    ))}
                    <button type="button" className="is-reject" onClick={() => void decide(permission.id)}>
                      Reject
                    </button>
                  </div>
                </article>
              ))}
              {selected.peek.length ? selected.peek.map((item) => (
                <p key={item.id}>
                  <small>{item.type}</small>
                  {privacy.content(peekText(item.text || item.title))}
                </p>
              )) : pending.length === 0 ? <p>No recent activity to peek yet.</p> : null}
            </div>
            {error && <p className="launch-form-status is-error" role="alert">{privacy.content(error)}</p>}
            <form className="roster-reply" onSubmit={(event) => void send(event)}>
              <textarea
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder={selected.state === 'working' ? 'Queue a follow-up…' : 'Reply from the roster…'}
                rows={3}
              />
              <button disabled={sending || !reply.trim() || !control?.connected}>
                <span>{sending ? 'Sending…' : selected.state === 'working' ? 'Queue' : 'Reply'}</span>
                <CornerDownLeft size={16} />
              </button>
            </form>
          </>
        ) : null}
      </section>
    </section>
  )
}
