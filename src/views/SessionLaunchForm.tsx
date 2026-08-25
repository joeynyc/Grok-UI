import { CornerDownLeft, Radio, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createControlSession, listControlModels, promptControlSession } from '../api'
import { usePrivacy } from '../privacy'
import type {
  ControlSession,
  ControlSnapshot,
  DashboardPayload,
  LiveSnapshot,
  ModelOption,
  PermissionMode,
} from '../types'

export type LaunchMode = 'new' | 'resume'

export interface ResumableSession {
  id: string
  title: string
  cwd: string
}

export function uniqueWorkspaces(data: DashboardPayload, live: LiveSnapshot | null): string[] {
  return [...new Set([
    ...(live?.agents.map((agent) => agent.cwd) || []),
    ...data.sessions.map((session) => session.cwd),
  ].filter(Boolean))]
}

export function canLaunchSession(control: ControlSnapshot | null): boolean {
  return Boolean(control?.connected)
}

export function listResumable(
  data: DashboardPayload,
  control: ControlSnapshot | null,
): ResumableSession[] {
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
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

interface SessionLaunchFormProps {
  data: DashboardPayload
  live: LiveSnapshot | null
  control: ControlSnapshot | null
  heading?: string
  index?: string
  requestedResumeId?: string
  resumeToken?: number
  onRefresh: () => Promise<void>
  onLaunched?: (session: ControlSession) => void
}

export function SessionLaunchForm({
  data,
  live,
  control,
  heading = 'Issue a command',
  index = '01',
  requestedResumeId = '',
  resumeToken = 0,
  onRefresh,
  onLaunched,
}: SessionLaunchFormProps) {
  const privacy = usePrivacy()
  const workspaces = useMemo(() => uniqueWorkspaces(data, live), [data, live])
  const resumable = useMemo(() => listResumable(data, control), [control, data.sessions])
  const [mode, setMode] = useState<LaunchMode>('new')
  const [cwd, setCwd] = useState(workspaces[0] || '')
  const [sessionId, setSessionId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [planMode, setPlanMode] = useState(false)
  const [worktree, setWorktree] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void listControlModels().then(setModels).catch(() => setModels([]))
  }, [])

  useEffect(() => {
    if (!requestedResumeId) return
    const selected = resumable.find((session) => session.id === requestedResumeId)
    if (!selected) return
    setMode('resume')
    setSessionId(selected.id)
    setCwd(selected.cwd)
    setMessage(`Ready to resume ${privacy.sessionTitle(selected.title, selected.id)}.`)
  }, [privacy, requestedResumeId, resumeToken, resumable])

  const chooseSession = (id: string) => {
    setSessionId(id)
    const selected = resumable.find((session) => session.id === id)
    if (selected) setCwd(selected.cwd)
  }

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
        const created = await createControlSession({
          cwd,
          prompt,
          model,
          reasoningEffort,
          permissionMode,
          planMode,
          worktree,
        })
        setMessage('New Grok lane launched.')
        onLaunched?.(created)
      }
      setPrompt('')
      await onRefresh()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Command failed.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!canLaunchSession(control)) {
    return (
      <section className="composer-panel panel-cut">
        <header>
          <div>
            <span className="panel-index">{index}</span>
            <h2>{heading}</h2>
          </div>
        </header>
        <p className="composer-note">
          {control?.reconnecting
            ? 'Reconnecting control. CLI sessions still appear here.'
            : 'Control is offline. CLI sessions still appear here. Starting a session from the dashboard needs control.'}
        </p>
      </section>
    )
  }

  return (
    <form className="composer-panel panel-cut" onSubmit={submit}>
      <header>
        <div>
          <span className="panel-index">{index}</span>
          <h2>{heading}</h2>
        </div>
        <span className="composer-shortcut">⌘ ↵</span>
      </header>

      {error && <p className="launch-form-status is-error" role="alert">{privacy.content(error)}</p>}
      {message && <p className="launch-form-status is-success">{message}</p>}

      {resumable.length > 0 && (
        <div className="mode-switch" role="tablist" aria-label="Command target">
          <button type="button" className={mode === 'new' ? 'is-active' : ''} onClick={() => setMode('new')}>
            <Sparkles size={15} /> New agent
          </button>
          <button type="button" className={mode === 'resume' ? 'is-active' : ''} onClick={() => setMode('resume')}>
            <Radio size={15} /> Resume session
          </button>
        </div>
      )}

      {mode === 'resume' && resumable.length > 0 ? (
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
              {models.length ? (
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="">Use Grok default</option>
                  {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              ) : (
                <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Use Grok default" />
              )}
            </label>
            <label className="control-field">
              <span>REASONING</span>
              <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
                {['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => <option key={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          <div className="control-field-row">
            <label className="control-field">
              <span>PERMISSIONS</span>
              <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}>
                <option value="ask">Ask</option>
                <option value="auto">Auto</option>
                <option value="always-approve">Always-approve</option>
              </select>
            </label>
            <label className="control-field launch-toggle">
              <span>PLAN FIRST</span>
              <input type="checkbox" checked={planMode} onChange={(event) => setPlanMode(event.target.checked)} />
            </label>
            <label className="control-field launch-toggle">
              <span>WORKTREE</span>
              <input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} />
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
        <span>{submitting ? 'Starting…' : mode === 'new' ? 'Start session' : 'Send'}</span>
        <CornerDownLeft size={17} />
      </button>
      <p className="composer-note">
        Tool executions still pass through Grok’s native permission system. Nothing is silently auto-approved.
      </p>
    </form>
  )
}
