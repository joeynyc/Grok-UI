import { Check, ListTodo, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import {
  deleteRecordedSession,
  exportSessionMarkdown,
  reviewControlPlan,
  runControlCommand,
  setControlMode,
} from '../api'
import { usePrivacy } from '../privacy'
import type { ControlSession, PlanAction, SessionSlash } from '../types'

export function SessionPlanPanel({
  session,
  onUpdated,
  onDeleted,
}: {
  session: ControlSession
  onUpdated: () => Promise<void>
  onDeleted?: () => void
}) {
  const privacy = usePrivacy()
  const [note, setNote] = useState('')
  const [workflow, setWorkflow] = useState('')
  const [error, setError] = useState('')
  const plan = session.plan

  const act = async (action: PlanAction) => {
    setError('')
    try {
      await reviewControlPlan(session.id, action, note)
      setNote('')
      await onUpdated()
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Unable to review plan.')
    }
  }

  const command = async (name: SessionSlash, argument = '') => {
    setError('')
    try {
      await runControlCommand(session.id, name, argument)
      await onUpdated()
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : 'Unable to run command.')
    }
  }

  return (
    <section className="session-plan-panel">
      {error && <p className="launch-form-status is-error" role="alert">{privacy.content(error)}</p>}
      {plan && plan.status !== 'none' && (
        <article className="plan-review">
          <header>
            <ShieldAlert size={16} />
            <div>
              <small>Plan {plan.status}</small>
              <strong>{privacy.content(plan.title)}</strong>
            </div>
          </header>
          {plan.markdown && <pre>{privacy.content(plan.markdown)}</pre>}
          {plan.entries.map((entry) => (
            <p key={entry.id}><em>{entry.status}</em> {privacy.content(entry.content)}</p>
          ))}
          {plan.status === 'review' && (
            <>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Request changes or comment…" rows={3} />
              <div className="plan-actions">
                <button type="button" onClick={() => void act('approve')}><Check size={14} /> Approve</button>
                <button type="button" onClick={() => void act('request-changes')}>Request changes</button>
                <button type="button" onClick={() => void act('comment')}>Comment</button>
                <button type="button" className="is-reject" onClick={() => void act('quit')}>Quit plan</button>
              </div>
            </>
          )}
        </article>
      )}
      {session.todos.length > 0 && (
        <article className="session-todos">
          <header><ListTodo size={15} /> Todos</header>
          {session.todos.map((todo) => (
            <p key={todo.id}><em>{todo.status}</em> {privacy.content(todo.content)}</p>
          ))}
        </article>
      )}
      {session.queue.length > 0 && (
        <article className="session-queue">
          <header>Queued prompts</header>
          {session.queue.map((item) => <p key={item.id}>{privacy.content(item.text)}</p>)}
        </article>
      )}
      <div className="session-commands">
        {session.availableModes.length > 0 && (
          <label>
            Mode
            <select
              value={session.currentModeId}
              onChange={(event) => void setControlMode(session.id, event.target.value).then(onUpdated)}
            >
              {session.availableModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
            </select>
          </label>
        )}
        <button type="button" onClick={() => void command('compact')}>Compact</button>
        <button type="button" onClick={() => void command('rewind')}>Rewind</button>
        <button type="button" onClick={() => void command('fork')}>Fork</button>
        <button type="button" onClick={() => void exportSessionMarkdown(session.id)}>Export</button>
        <button type="button" className="is-reject" onClick={() => void deleteRecordedSession(session.id).then(onDeleted)}>Delete</button>
      </div>
      <form className="workflow-author" onSubmit={(event) => {
        event.preventDefault()
        void command('create-workflow', workflow).then(() => setWorkflow(''))
      }}>
        <input value={workflow} onChange={(event) => setWorkflow(event.target.value)} placeholder="Create a workflow…" />
        <button type="submit">Author</button>
      </form>
    </section>
  )
}
