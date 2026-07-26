import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  CornerDownLeft,
  FileCode2,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Pencil,
  Radio,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  cancelWorkbenchSession,
  getSessionWorkbench,
  getWorkspaceDiff,
  getWorkspaceSnapshot,
  promptControlSession,
  resolveControlPermission,
  updateSession,
} from '../api'
import type {
  ControlSnapshot,
  LiveFeedItem,
  LiveSnapshot,
  SessionRow,
  SessionWorkbenchData,
  WorkspaceDiff,
  WorkspaceSnapshot,
} from '../types'
import { usePrivacy } from '../privacy'

type WorkbenchTab = 'timeline' | 'changes' | 'specs'

interface SessionWorkbenchProps {
  sessionId: string
  fallback: SessionRow | null
  live: LiveSnapshot | null
  control: ControlSnapshot | null
  onClose: () => void
  onUpdated: () => Promise<void>
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function time(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function elapsed(value: string): string {
  const difference = Math.max(0, Date.now() - new Date(value).getTime())
  if (difference < 60_000) return 'now'
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h`
  return `${Math.floor(difference / 86_400_000)}d`
}

function statusLabel(data: SessionWorkbenchData | null): string {
  if (data?.control?.state === 'stopping') return 'STOPPING'
  if (data?.control?.state === 'cancelled') return 'CANCELLED'
  if (data?.control?.cancellationStatus === 'timed_out') return 'STOP NOT CONFIRMED'
  if (data?.control?.state === 'attention' || data?.live?.state === 'attention') return 'NEEDS INPUT'
  if (data?.control?.state === 'working' || data?.live?.state === 'working') return 'WORKING'
  if (data?.live) return 'CLI ATTACHED'
  if (data?.control) return data.control.state.toUpperCase()
  return 'RECORDED'
}

export function SessionWorkbench({
  sessionId,
  fallback,
  live,
  control,
  onClose,
  onUpdated,
}: SessionWorkbenchProps) {
  const privacy = usePrivacy()
  const [data, setData] = useState<SessionWorkbenchData | null>(null)
  const [tab, setTab] = useState<WorkbenchTab>('timeline')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(fallback?.title || '')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [selectedFile, setSelectedFile] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      const next = await getSessionWorkbench(sessionId)
      setData(next)
      setTitle(next.session.title)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to open the session.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [sessionId])

  const refreshWorkspace = useCallback(async () => {
    const cwd = data?.session.cwd || fallback?.cwd
    if (!cwd) return
    try {
      const next = await getWorkspaceSnapshot(cwd)
      setWorkspace(next)
      if (selectedFile && !next.files.some((file) => file.path === selectedFile)) {
        setSelectedFile('')
        setDiff(null)
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to inspect workspace.')
    }
  }, [data?.session.cwd, fallback?.cwd, selectedFile])

  useEffect(() => {
    setData(null)
    setWorkspace(null)
    setDiff(null)
    setSelectedFile('')
    setLoading(true)
    setError('')
    setMessage('')
    void refresh()
  }, [refresh])

  const liveSignal = live?.agents.find((item) => item.id === sessionId)?.updatedAt
  const controlSession = control?.sessions.find((item) => item.id === sessionId)
  const controlSignal = controlSession?.updatedAt
  const permissionSignal = control?.permissions
    .filter((item) => item.sessionId === sessionId)
    .map((item) => item.id)
    .join(':')

  useEffect(() => {
    if (!liveSignal && !controlSignal && !permissionSignal) return
    const timer = window.setTimeout(() => void refresh(true), 120)
    return () => window.clearTimeout(timer)
  }, [controlSignal, liveSignal, permissionSignal, refresh])

  useEffect(() => {
    if (tab !== 'changes') return
    const timer = window.setTimeout(() => void refreshWorkspace(), 220)
    return () => window.clearTimeout(timer)
  }, [controlSignal, liveSignal, refreshWorkspace, tab])

  useEffect(() => {
    if (!feedRef.current) return
    feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [data?.transcript.at(-1)?.id])

  const openDiff = async (file: string) => {
    const cwd = data?.session.cwd || fallback?.cwd
    if (!cwd) return
    setSelectedFile(file)
    try {
      setDiff(await getWorkspaceDiff(cwd, file))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to read the diff.')
    }
  }

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const session = data?.session || fallback
    if (!session || !prompt.trim()) return
    setSending(true)
    setError('')
    setMessage('')
    try {
      await promptControlSession(session.id, { cwd: session.cwd, prompt })
      setPrompt('')
      setMessage(data?.managed ? 'Follow-up sent.' : 'Session attached to ACP control and resumed.')
      await refresh(true)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send the follow-up.')
    } finally {
      setSending(false)
    }
  }

  const cancel = async () => {
    setError('')
    try {
      await cancelWorkbenchSession(sessionId)
      setMessage('Stop requested. Waiting for Grok to confirm cancellation.')
      await refresh(true)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Unable to cancel this turn.')
    }
  }

  const saveTitle = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    try {
      await updateSession(sessionId, { title })
      setRenaming(false)
      setMessage('Session renamed in Grok UI.')
      await Promise.all([refresh(true), onUpdated()])
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Unable to rename session.')
    }
  }

  const toggleArchive = async () => {
    const session = data?.session || fallback
    if (!session) return
    try {
      await updateSession(session.id, { archived: !session.archived })
      setMessage(session.archived ? 'Session restored to the active archive.' : 'Session archived.')
      await Promise.all([refresh(true), onUpdated()])
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : 'Unable to change archive state.')
    }
  }

  const decide = async (permissionId: string, optionId?: string) => {
    try {
      await resolveControlPermission(permissionId, optionId)
      await refresh(true)
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Unable to resolve permission.')
    }
  }

  const session = data?.session || fallback
  const isWorking = data?.control?.state === 'working'
    || data?.control?.state === 'starting'
    || data?.live?.state === 'working'
  const canCancel = Boolean(
    data?.managed
    && (
      ['working', 'starting', 'attention'].includes(data.control?.state || '')
      || ['timed_out', 'failed'].includes(data.control?.cancellationStatus || '')
    )
  )
  const cancellationNotice = data?.control?.state === 'cancelled'
    ? `Cancelled by user at ${time(data.control.cancelledAt || data.control.updatedAt)}.`
    : data?.control?.state === 'stopping'
      ? 'Stop requested. Waiting for Grok to confirm cancellation.'
      : ''
  const cancellationError = ['timed_out', 'failed'].includes(data?.control?.cancellationStatus || '')
    ? data?.control?.error || ''
    : ''
  const transcript = data?.transcript || []
  const toolCount = useMemo(() => transcript.filter((item) => item.type === 'tool').length, [transcript])
  const turnCount = useMemo(() => transcript.filter((item) => item.type === 'user').length, [transcript])

  return (
    <div
      className="workbench-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`Session console: ${privacy.sessionTitle(session?.title || sessionId, sessionId)}`}
    >
      <button className="workbench-scrim" onClick={onClose} aria-label="Close session console" />
      <section className="session-workbench">
        <header className="workbench-head">
          <div className="workbench-identity">
            <span className={`workbench-state ${isWorking ? 'is-working' : data?.permissions.length ? 'is-attention' : ''}`}>
              <i /> {statusLabel(data)}
            </span>
            {renaming ? (
              <form className="workbench-title-form" onSubmit={saveTitle}>
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} autoFocus aria-label="Session title" />
                <button type="submit" aria-label="Save session title"><Check size={16} /></button>
                <button type="button" onClick={() => setRenaming(false)} aria-label="Cancel rename"><X size={16} /></button>
              </form>
            ) : (
              <div className="workbench-title">
                <div>
                  <span>SESSION CONSOLE / {privacy.identifier(sessionId)}</span>
                  <h1>{privacy.sessionTitle(session?.title || `Session ${sessionId.slice(0, 8)}`, sessionId)}</h1>
                </div>
                <button onClick={() => setRenaming(true)} aria-label="Rename session"><Pencil size={15} /></button>
              </div>
            )}
            <div className="workbench-context">
              <p>
                <FolderGit2 size={14} />
                <span>{session?.cwd ? privacy.path(session.cwd) : 'Resolving workspace…'}</span>
              </p>
              <span>Chat with this agent, review its activity, and inspect changes.</span>
            </div>
          </div>
          <div className="workbench-head-actions">
            <button
              className="workbench-archive"
              onClick={() => void toggleArchive()}
              aria-label={session?.archived ? 'Restore session' : 'Archive session'}
            >
              {session?.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
              <span>{session?.archived ? 'Restore' : 'Archive'}</span>
            </button>
            {canCancel && (
              <button
                className="workbench-stop"
                onClick={() => void cancel()}
                aria-label={data?.control?.cancellationStatus === 'timed_out' ? 'Retry stop' : 'Stop turn'}
              >
                <CircleStop size={16} />
                <span>{data?.control?.cancellationStatus === 'timed_out' ? 'Retry stop' : 'Stop turn'}</span>
              </button>
            )}
            <button className="icon-button" onClick={onClose} aria-label="Close session console"><X size={19} /></button>
          </div>
        </header>

        <div className="workbench-instruments">
          <div><span>STATUS</span><strong>{statusLabel(data)}</strong></div>
          <div><span>TURNS</span><strong>{compact(session?.turns || turnCount)}</strong></div>
          <div><span>TOOLS</span><strong>{compact(session?.toolCalls || toolCount)}</strong></div>
          <div><span>CONTEXT</span><strong>{Math.round((data?.live?.contextUsage || session?.contextUsage || 0) * 100)}%</strong></div>
          <div><span>COST</span><strong>{data?.control?.costAmount || data?.live?.costAmount
            ? `${(data?.control?.costAmount || data?.live?.costAmount || 0).toFixed(3)} ${data?.control?.costCurrency || data?.live?.costCurrency}`
            : '—'}</strong></div>
          <div><span>UPDATED</span><strong>{elapsed(session?.updatedAt || '')}</strong></div>
        </div>

        <nav className="workbench-tabs" aria-label="Session console sections">
          <button className={tab === 'timeline' ? 'is-active' : ''} onClick={() => setTab('timeline')}>
            <Radio size={15} /> Timeline <span>{transcript.length}</span>
          </button>
          <button className={tab === 'changes' ? 'is-active' : ''} onClick={() => setTab('changes')}>
            <FileCode2 size={15} /> Changes <span>{workspace?.files.length || session?.filesTouched || 0}</span>
          </button>
          <button className={tab === 'specs' ? 'is-active' : ''} onClick={() => setTab('specs')}>
            <TerminalSquare size={15} /> Details
          </button>
          <button className="workbench-refresh" onClick={() => void refresh()} aria-label="Refresh session">
            <RefreshCw className={refreshing ? 'is-spinning' : ''} size={15} />
          </button>
        </nav>

        {error || cancellationError
          ? <div className="workbench-banner is-error"><ShieldAlert size={16} /><span>{privacy.content(error || cancellationError)}</span></div>
          : cancellationNotice || message
            ? <div className="workbench-banner is-success"><Check size={16} /><span>{cancellationNotice || message}</span></div>
            : <div className="workbench-banner-placeholder" aria-hidden="true" />}

        <div className="workbench-body">
          {loading && !data ? (
            <div className="workbench-loading"><LoaderCircle size={25} className="is-spinning" /><span>Assembling session record…</span></div>
          ) : tab === 'timeline' ? (
            <Timeline
              items={transcript}
              permissions={data?.permissions || []}
              feedRef={feedRef}
              onDecide={decide}
            />
          ) : tab === 'changes' ? (
            <Changes
              workspace={workspace}
              diff={diff}
              selected={selectedFile}
              onOpen={openDiff}
              onRefresh={refreshWorkspace}
            />
          ) : (
            <Details session={session} data={data} />
          )}
        </div>

        <form className="workbench-composer" onSubmit={send}>
          <div className="composer-mode">
            {data?.managed ? <Bot size={16} /> : <Sparkles size={16} />}
            <span>{data?.managed ? 'CONTINUE MANAGED SESSION' : 'ATTACH TO ACP + RESUME'}</span>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') event.currentTarget.form?.requestSubmit()
            }}
            placeholder="Send a follow-up to this session…"
            rows={2}
            maxLength={32_000}
            required
          />
          <button disabled={sending || !control?.connected || !prompt.trim() || data?.control?.state === 'stopping'}>
            {sending ? <LoaderCircle className="is-spinning" size={17} /> : <CornerDownLeft size={17} />}
            <span>{sending ? 'SENDING' : data?.managed ? 'SEND' : 'ATTACH'}</span>
          </button>
          <small>{control?.connected ? '⌘ ↵ to send' : 'ACP control offline'}</small>
        </form>
      </section>
    </div>
  )
}

function Timeline({
  items,
  permissions,
  feedRef,
  onDecide,
}: {
  items: LiveFeedItem[]
  permissions: SessionWorkbenchData['permissions']
  feedRef: React.RefObject<HTMLDivElement | null>
  onDecide: (permissionId: string, optionId?: string) => Promise<void>
}) {
  const privacy = usePrivacy()
  return (
    <div className="workbench-timeline" ref={feedRef}>
      {permissions.map((permission) => (
        <article className="workbench-permission" key={permission.id}>
          <div><ShieldAlert size={18} /><span><small>PERMISSION REQUIRED</small><strong>{privacy.content(permission.title)}</strong></span></div>
          <div>
            {permission.options.map((option) => (
              <button
                key={option.id}
                className={option.kind.includes('reject') ? 'is-reject' : ''}
                onClick={() => void onDecide(permission.id, option.id)}
              >
                {option.name}
              </button>
            ))}
            <button className="is-reject" onClick={() => void onDecide(permission.id)}>Cancel turn</button>
          </div>
        </article>
      ))}
      {items.length ? items.map((item, index) => (
        <article className={`workbench-event event-${item.type}`} key={item.id}>
          <div className="workbench-event-rail">
            <span>{String(index + 1).padStart(3, '0')}</span>
            <i />
          </div>
          <div className="workbench-event-content">
            <header>
              <span>{item.type === 'assistant' ? 'GROK' : item.type.toUpperCase()}</span>
              <strong>{privacy.content(item.title)}</strong>
              {item.status && <em>{item.status}</em>}
              <time>{time(item.timestamp)}</time>
            </header>
            {item.text && <p>{privacy.content(item.text)}</p>}
          </div>
        </article>
      )) : (
        <div className="workbench-empty">
          <div><Radio size={23} /><span /></div>
          <strong>No structured events recorded yet.</strong>
          <p>Send a follow-up below. New messages, reasoning, and tool calls will stream here.</p>
        </div>
      )}
      {items.length > 8 && <button className="jump-latest" onClick={() => feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })}><ArrowDown size={14} /> Latest</button>}
    </div>
  )
}

function Changes({
  workspace,
  diff,
  selected,
  onOpen,
  onRefresh,
}: {
  workspace: WorkspaceSnapshot | null
  diff: WorkspaceDiff | null
  selected: string
  onOpen: (file: string) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const privacy = usePrivacy()
  if (!workspace) {
    return <div className="workbench-loading"><LoaderCircle size={22} className="is-spinning" /><span>Reading session workspace…</span></div>
  }
  if (!workspace.repository) {
    return (
      <div className="workbench-empty">
        <FolderGit2 size={24} />
        <strong>No Git repository</strong>
        <p>{privacy.content(workspace.error)}</p>
      </div>
    )
  }
  return (
    <div className="workbench-changes">
      <header>
        <div>
          <GitBranch size={16} />
          <span><strong>{privacy.content(workspace.branch)}</strong><small>{privacy.path(workspace.root)}</small></span>
        </div>
        <div><strong>+{workspace.additions}</strong><em>−{workspace.deletions}</em></div>
        <button onClick={() => void onRefresh()} aria-label="Refresh session changes"><RefreshCw size={15} /></button>
      </header>
      <div className="workbench-change-grid">
        <aside>
          {workspace.files.length ? workspace.files.map((file) => (
            <button className={selected === file.path ? 'is-active' : ''} onClick={() => void onOpen(file.path)} key={file.path}>
              <span>{file.status}</span>
              <strong>{privacy.file(file.path)}</strong>
              <small><b>+{file.additions}</b><em>−{file.deletions}</em></small>
              <ChevronRight size={14} />
            </button>
          )) : <div className="workbench-clean"><Check size={18} /><span>Working tree clean</span></div>}
        </aside>
        <section>
          {diff ? (
            <>
              <header><span>{privacy.file(diff.path)}</span>{diff.truncated && <em>TRUNCATED</em>}</header>
              <pre>{privacy.enabled ? privacy.content(diff.diff) : diff.diff || 'No textual diff available.'}</pre>
            </>
          ) : (
            <div className="workbench-empty"><FileCode2 size={24} /><strong>Select a changed file</strong><p>Its bounded patch will appear here.</p></div>
          )}
        </section>
      </div>
    </div>
  )
}

function Details({ session, data }: { session: SessionRow | null; data: SessionWorkbenchData | null }) {
  const privacy = usePrivacy()
  if (!session) return null
  const details = [
    ['Session ID', privacy.identifier(session.id)],
    ['Workspace', privacy.path(session.cwd)],
    ['Model', session.model],
    ['Agent', privacy.capability(session.agent, 'Agent')],
    ['Reasoning', session.reasoningEffort],
    ['Sandbox', session.sandboxProfile],
    ['Created', new Date(session.createdAt).toLocaleString()],
    ['Updated', new Date(session.updatedAt).toLocaleString()],
    ['Runtime source', data?.live ? privacy.enabled ? 'CLI PID ••••' : `CLI PID ${data.live.pid}` : data?.managed ? 'Grok UI ACP' : 'Local archive'],
    ['Managed', data?.managed ? 'Yes — durable control record' : 'No — attach with a follow-up'],
    ['Archive state', session.archived ? 'Archived in Grok UI' : 'Active'],
    ['Disk footprint', `${compact(session.diskBytes)} bytes`],
  ]
  return (
    <div className="workbench-details">
      <section>
        <div className="detail-mark"><Clock3 size={21} /><span /></div>
        <div><span>SESSION SUMMARY</span><p>{privacy.content(session.summary || 'No generated summary is available yet.')}</p></div>
      </section>
      <dl>
        {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </div>
  )
}
