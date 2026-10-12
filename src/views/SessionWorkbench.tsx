import {
  Archive,
  ArchiveRestore,
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  CornerDownLeft,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Monitor,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Tablet,
  TerminalSquare,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  cancelWorkbenchSession,
  getSessionPreview,
  getSessionWorkbench,
  getWorkspaceSnapshot,
  promptControlSession,
  resolveControlPermission,
  startSessionPreview,
  stopSessionPreview,
  updateSession,
} from '../api'
import { useModalFocus } from '../hooks/useModalFocus'
import type {
  ControlSnapshot,
  LiveSnapshot,
  PreviewSnapshot,
  SessionRow,
  SessionWorkbenchData,
  WorkspaceDiff,
  WorkspaceSnapshot,
} from '../types'
import { usePrivacy } from '../privacy'
import { SessionPlanPanel } from './SessionPlanPanel'
import { SessionTimeline } from './SessionTimeline'
import { useWorkspaceDiff } from '../hooks/useWorkspaceDiff'
import { clockTime, compactNumber, elapsed, shortDate } from '../format'

type WorkbenchTab = 'timeline' | 'preview' | 'changes' | 'specs'
type PreviewViewport = 'desktop' | 'tablet' | 'mobile'

interface SessionWorkbenchProps {
  sessionId: string
  fallback: SessionRow | null
  live: LiveSnapshot | null
  control: ControlSnapshot | null
  returnFocus?: HTMLElement | null
  onClose: () => void
  onUpdated: () => Promise<void>
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
  returnFocus,
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
  const [title, setTitle] = useState('')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [workspaceError, setWorkspaceError] = useState('')
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewViewport, setPreviewViewport] = useState<PreviewViewport>('desktop')
  const [previewRevision, setPreviewRevision] = useState(0)
  const [previewError, setPreviewError] = useState('')
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  const sessionRequest = useRef<AbortController | null>(null)
  const refreshQueued = useRef(false)
  const workspaceRequest = useRef<AbortController | null>(null)
  const workspaceStale = useRef(false)
  const previewRequest = useRef<AbortController | null>(null)
  const previewAction = useRef(false)
  const cwd = data?.session.cwd || fallback?.cwd || ''
  const {
    selectedFile,
    openFile,
    diff,
    loading: diffLoading,
    error: diffError,
    reset: resetDiff,
  } = useWorkspaceDiff(cwd, workspaceRevision)
  const dialogRef = useModalFocus<HTMLDivElement>(
    onClose,
    '[aria-label="Close session console panel"]',
    returnFocus,
  )

  const refresh = useCallback(async function loadSession(quiet = false) {
    if (currentSession.current !== sessionId) return
    if (quiet && sessionRequest.current) {
      refreshQueued.current = true
      return
    }
    sessionRequest.current?.abort()
    const request = new AbortController()
    sessionRequest.current = request
    if (!quiet) setRefreshing(true)
    try {
      const next = await getSessionWorkbench(sessionId, request.signal)
      if (request.signal.aborted || currentSession.current !== sessionId) return
      setData(next)
      setError('')
    } catch (requestError) {
      if (!request.signal.aborted && currentSession.current === sessionId) {
        setError(requestError instanceof Error ? requestError.message : 'Unable to open the session.')
      }
    } finally {
      if (sessionRequest.current === request && !request.signal.aborted) {
        sessionRequest.current = null
        setLoading(false)
        setRefreshing(false)
        if (refreshQueued.current) {
          refreshQueued.current = false
          void loadSession(true)
        }
      }
    }
  }, [sessionId])

  // Live updates arrive faster than git can answer on a large repository, so a
  // follow-up marks the in-flight read stale instead of aborting it; the read
  // then repeats once it lands rather than restarting forever.
  const refreshWorkspace = useCallback(async (follow = false) => {
    if (!cwd || currentSession.current !== sessionId) return
    if (follow && workspaceRequest.current) {
      workspaceStale.current = true
      return
    }
    workspaceRequest.current?.abort()
    const request = new AbortController()
    workspaceRequest.current = request
    setWorkspaceError('')
    try {
      do {
        workspaceStale.current = false
        const next = await getWorkspaceSnapshot(cwd, request.signal)
        if (request.signal.aborted || currentSession.current !== sessionId) return
        setWorkspace(next)
        setWorkspaceRevision((value) => value + 1)
      } while (workspaceStale.current)
    } catch (requestError) {
      if (!request.signal.aborted && currentSession.current === sessionId) {
        setWorkspaceError(requestError instanceof Error ? requestError.message : 'Unable to inspect workspace.')
      }
    } finally {
      if (workspaceRequest.current === request) workspaceRequest.current = null
    }
  }, [cwd, sessionId])

  useEffect(() => {
    if (workspace?.cwd === cwd && selectedFile && !workspace.files.some((file) => file.path === selectedFile)) {
      resetDiff()
    }
  }, [cwd, workspace, selectedFile, resetDiff])

  const refreshPreview = useCallback(async (quiet = false) => {
    if (currentSession.current !== sessionId || previewAction.current) return
    if (quiet && previewRequest.current) return
    previewRequest.current?.abort()
    const request = new AbortController()
    previewRequest.current = request
    if (!quiet) setPreviewLoading(true)
    try {
      const next = await getSessionPreview(sessionId, request.signal)
      if (request.signal.aborted || currentSession.current !== sessionId) return
      setPreview(next)
      setPreviewError('')
    } catch (requestError) {
      if (!request.signal.aborted && !quiet && currentSession.current === sessionId) {
        setPreviewError(requestError instanceof Error ? requestError.message : 'Unable to inspect the preview.')
      }
    } finally {
      if (previewRequest.current === request) {
        previewRequest.current = null
        if (!request.signal.aborted) setPreviewLoading(false)
      }
    }
  }, [sessionId])

  useEffect(() => {
    currentSession.current = sessionId
    setData(null)
    setWorkspace(null)
    setWorkspaceError('')
    resetDiff()
    setRenaming(false)
    setTitle('')
    setPrompt('')
    setPreview(null)
    setPreviewViewport('desktop')
    setPreviewRevision(0)
    setPreviewError('')
    setLoading(true)
    setError('')
    setMessage('')
    void refresh()
    return () => {
      currentSession.current = ''
      sessionRequest.current?.abort()
      sessionRequest.current = null
      refreshQueued.current = false
      workspaceRequest.current?.abort()
      previewRequest.current?.abort()
    }
  }, [refresh, resetDiff, sessionId])

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
    const timer = window.setTimeout(() => void refreshWorkspace(true), 220)
    return () => window.clearTimeout(timer)
  }, [controlSignal, liveSignal, refreshWorkspace, tab])

  useEffect(() => {
    if (tab !== 'changes') return
    return () => {
      workspaceRequest.current?.abort()
      workspaceRequest.current = null
    }
  }, [refreshWorkspace, tab])

  useEffect(() => {
    if (tab !== 'preview') return
    void refreshPreview()
    const timer = window.setInterval(() => void refreshPreview(true), 1_000)
    return () => {
      window.clearInterval(timer)
      previewRequest.current?.abort()
      previewRequest.current = null
    }
  }, [refreshPreview, tab])

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const session = data?.session || fallback
    if (!session || !prompt.trim() || sending || !control?.connected || stopping) return
    setSending(true)
    setError('')
    setMessage('')
    try {
      await promptControlSession(session.id, { cwd: session.cwd, prompt })
      setPrompt('')
      setMessage(data?.managed ? 'Follow-up sent.' : 'Session attached and resumed.')
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

  const startPreview = async () => {
    previewRequest.current?.abort()
    previewRequest.current = null
    previewAction.current = true
    setPreviewBusy(true)
    setPreviewError('')
    setMessage('')
    try {
      setPreview(await startSessionPreview(sessionId))
      setMessage('Preview process launched on loopback.')
    } catch (startError) {
      setPreviewError(startError instanceof Error ? startError.message : 'Unable to start preview.')
    } finally {
      previewAction.current = false
      setPreviewBusy(false)
    }
  }

  const stopPreview = async () => {
    previewRequest.current?.abort()
    previewRequest.current = null
    previewAction.current = true
    setPreviewBusy(true)
    setPreviewError('')
    setMessage('')
    try {
      setPreview(await stopSessionPreview(sessionId))
      setMessage('Preview process stopped.')
    } catch (stopError) {
      setPreviewError(stopError instanceof Error ? stopError.message : 'Unable to stop preview.')
    } finally {
      previewAction.current = false
      setPreviewBusy(false)
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
  const stopping = controlSession?.state === 'stopping' || data?.control?.state === 'stopping'
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
    ? `Cancelled by user at ${clockTime(data.control.cancelledAt || data.control.updatedAt)}.`
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
      ref={dialogRef}
      className="workbench-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`Session console: ${privacy.sessionTitle(session?.title || sessionId, sessionId)}`}
      tabIndex={-1}
    >
      <button
        className="workbench-scrim"
        onClick={onClose}
        aria-label="Close session console"
        tabIndex={-1}
      />
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
                  <span>Session · {privacy.identifier(sessionId)}</span>
                  <h1>
                    {session?.title
                      ? privacy.sessionTitle(session.title, sessionId)
                      : loading ? 'Loading session…' : privacy.sessionTitle(`Session ${sessionId.slice(0, 8)}`, sessionId)}
                  </h1>
                </div>
                <button onClick={() => { setTitle(session?.title || ''); setRenaming(true) }} aria-label="Rename session"><Pencil size={15} /></button>
              </div>
            )}
            <div className="workbench-context">
              <p>
                <FolderGit2 size={14} />
                <span>{session?.cwd ? privacy.path(session.cwd) : loading ? 'Resolving workspace…' : 'No workspace recorded'}</span>
              </p>
              <span aria-label="Session context">
                {[
                  session?.model,
                  session?.agent ? privacy.capability(session.agent, 'Agent') : '',
                  session?.createdAt ? `Started ${shortDate(session.createdAt)}` : '',
                ].filter(Boolean).join(' · ') || (loading ? 'Reading session record…' : 'Chat with this agent, review its activity, and inspect changes.')}
              </span>
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
            <button className="icon-button" onClick={onClose} aria-label="Close session console panel"><X size={19} /></button>
          </div>
        </header>

        <div className="workbench-instruments">
          <div><span>MODEL</span><strong className="is-text">{session?.model || '—'}</strong></div>
          <div><span>TURNS</span><strong>{compactNumber(session?.turns || turnCount)}</strong></div>
          <div><span>TOOLS</span><strong>{compactNumber(session?.toolCalls || toolCount)}</strong></div>
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
          <button className={tab === 'preview' ? 'is-active' : ''} onClick={() => setTab('preview')}>
            <Monitor size={15} /> Preview <span>{preview?.status === 'running' ? 'live' : preview?.status || '—'}</span>
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
            <>
              {data?.control && (
                <SessionPlanPanel
                  session={data.control}
                  onUpdated={() => refresh(true)}
                  onDeleted={onClose}
                />
              )}
              <SessionTimeline
                items={transcript}
                permissions={data?.permissions || []}
                onDecide={decide}
              />
            </>
          ) : tab === 'preview' ? (
            <Preview
              preview={preview}
              error={previewError}
              loading={previewLoading}
              busy={previewBusy}
              viewport={previewViewport}
              revision={previewRevision}
              onStart={startPreview}
              onStop={stopPreview}
              onRefresh={refreshPreview}
              onReload={() => setPreviewRevision((value) => value + 1)}
              onViewport={setPreviewViewport}
            />
          ) : tab === 'changes' ? (
            <Changes
              workspace={workspace?.cwd === cwd ? workspace : null}
              error={workspaceError}
              diffLoading={diffLoading}
              diffError={diffError}
              diff={diff}
              selected={selectedFile}
              onOpen={openFile}
              onRefresh={() => refreshWorkspace()}
            />
          ) : (
            <Details session={session} data={data} />
          )}
        </div>

        <form className="workbench-composer" onSubmit={send}>
          <div className="composer-mode">
            {data?.managed ? <Bot size={16} /> : <Sparkles size={16} />}
            <span>{data?.managed ? 'Continue session' : 'Attach and resume'}</span>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') event.currentTarget.form?.requestSubmit()
            }}
            placeholder={stopping ? 'Wait for Stop to finish before sending…' : 'Send a follow-up to this session…'}
            disabled={stopping}
            rows={2}
            maxLength={32_000}
            required
          />
          <button disabled={sending || !control?.connected || !prompt.trim() || stopping}>
            {sending ? <LoaderCircle className="is-spinning" size={17} /> : <CornerDownLeft size={17} />}
            <span>{sending ? 'Sending' : data?.managed ? 'Send' : 'Attach'}</span>
          </button>
          <small>{stopping ? 'Waiting for Stop to finish' : control?.connected ? '⌘ ↵ to send' : 'Control offline'}</small>
        </form>
      </section>
    </div>
  )
}

function Preview({
  preview,
  error,
  loading,
  busy,
  viewport,
  revision,
  onStart,
  onStop,
  onRefresh,
  onReload,
  onViewport,
}: {
  preview: PreviewSnapshot | null
  error: string
  loading: boolean
  busy: boolean
  viewport: PreviewViewport
  revision: number
  onStart: () => Promise<void>
  onStop: () => Promise<void>
  onRefresh: (quiet?: boolean) => Promise<void>
  onReload: () => void
  onViewport: (viewport: PreviewViewport) => void
}) {
  const privacy = usePrivacy()
  if (loading && !preview) {
    return <div className="workbench-loading"><LoaderCircle size={22} className="is-spinning" /><span>Inspecting preview contract…</span></div>
  }
  if (!preview?.available) {
    return (
      <div className="workbench-empty preview-empty">
        <div className="preview-empty-mark"><Monitor size={26} /><span /></div>
        <strong>No preview command detected</strong>
        <p>{preview?.error || error || 'Add a package.json dev or start script to this session workspace.'}</p>
        <button onClick={() => void onRefresh()}><RefreshCw size={14} /> Inspect again</button>
      </div>
    )
  }

  const active = preview.status === 'starting' || preview.status === 'running'
  return (
    <div className="workbench-preview">
      <div className="preview-head">
        {error && (
          <div className="preview-error" role="alert">
            <ShieldAlert size={14} />
            <span>{privacy.content(error)}</span>
          </div>
        )}
        <header className="preview-toolbar">
        <div className="preview-address">
          <span className={`preview-signal status-${preview.status}`} />
          <div>
            <small>{preview.status === 'running' ? 'LOOPBACK PREVIEW' : preview.status.toUpperCase()}</small>
            <strong>{preview.url || 'Waiting to launch'}</strong>
          </div>
        </div>
        <div className="preview-devices" role="group" aria-label="Preview viewport">
          <button className={viewport === 'desktop' ? 'is-active' : ''} onClick={() => onViewport('desktop')} aria-label="Desktop preview"><Monitor size={15} /></button>
          <button className={viewport === 'tablet' ? 'is-active' : ''} onClick={() => onViewport('tablet')} aria-label="Tablet preview"><Tablet size={15} /></button>
          <button className={viewport === 'mobile' ? 'is-active' : ''} onClick={() => onViewport('mobile')} aria-label="Mobile preview"><Smartphone size={15} /></button>
        </div>
        <div className="preview-actions">
          <button onClick={onReload} disabled={preview.status !== 'running'} aria-label="Reload preview"><RefreshCw size={15} /></button>
          <button
            onClick={() => window.open(preview.url, '_blank', 'noopener,noreferrer')}
            disabled={preview.status !== 'running' || privacy.enabled}
            aria-label="Open preview in new tab"
          >
            <ExternalLink size={15} />
          </button>
          {active ? (
            <button className="preview-stop" onClick={() => void onStop()} disabled={busy}>
              <CircleStop size={15} /> Stop
            </button>
          ) : (
            <button className="preview-start" onClick={() => void onStart()} disabled={busy}>
              {busy ? <LoaderCircle className="is-spinning" size={15} /> : <Play size={15} />}
              {preview.status === 'failed' ? 'Restart' : 'Start preview'}
            </button>
          )}
        </div>
        </header>
      </div>

      <div className="preview-stage">
        <div className={`preview-viewport viewport-${viewport}`}>
          {preview.status === 'running' && !privacy.enabled ? (
            <iframe
              key={`${preview.url}:${revision}`}
              src={preview.url}
              title="Session application preview"
              sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
            />
          ) : preview.status === 'running' ? (
            <div className="preview-standby preview-private">
              <ShieldAlert size={28} />
              <strong>Preview hidden by Privacy Mode</strong>
              <p>Turn Privacy Mode off when you are ready to display the generated application.</p>
            </div>
          ) : (
            <div className="preview-standby">
              {preview.status === 'starting' ? <LoaderCircle className="is-spinning" size={28} /> : <Monitor size={28} />}
              <strong>{preview.status === 'starting' ? 'Waiting for the development server' : 'Preview is offline'}</strong>
              <p>{preview.error || 'Start the detected command when you are ready to run generated code.'}</p>
              {!active && (
                <button onClick={() => void onStart()} disabled={busy}>
                  {busy ? <LoaderCircle className="is-spinning" size={15} /> : <Play size={15} />}
                  {preview.status === 'failed' ? 'Restart preview' : 'Start preview'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="preview-console">
        <div>
          <span><TerminalSquare size={13} /> PREVIEW PROCESS</span>
          <code>{privacy.content(preview.displayCommand)}</code>
        </div>
        <pre>{preview.logs.length
          ? privacy.content(preview.logs.slice(-8).join('\n'))
          : 'Command output will appear here after launch.'}</pre>
      </footer>
    </div>
  )
}

function Changes({
  workspace,
  error,
  diffLoading,
  diffError,
  diff,
  selected,
  onOpen,
  onRefresh,
}: {
  workspace: WorkspaceSnapshot | null
  error: string
  diffLoading: boolean
  diffError: string
  diff: WorkspaceDiff | null
  selected: string
  onOpen: (file: string) => void
  onRefresh: () => Promise<void>
}) {
  const privacy = usePrivacy()
  if (!workspace) {
    return error ? (
      <div className="workbench-empty" role="alert"><ShieldAlert size={22} /><strong>Unable to inspect workspace</strong><p>{privacy.content(error)}</p><button onClick={() => void onRefresh()}>Try again</button></div>
    ) : <div className="workbench-loading"><LoaderCircle size={22} className="is-spinning" /><span>Reading session workspace…</span></div>
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
      {error && <div className="workbench-banner is-error" role="alert"><ShieldAlert size={16} /><span>{privacy.content(error)}</span></div>}
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
          {selected ? (
            <>
              <header><span>{privacy.file(selected)}</span>{diff?.truncated && <em>TRUNCATED</em>}</header>
              {diffLoading ? (
                <div className="workbench-loading" role="status"><LoaderCircle size={22} className="is-spinning" /><span>Loading patch…</span></div>
              ) : diffError ? (
                <div className="workbench-empty" role="alert"><ShieldAlert size={22} /><p>{privacy.content(diffError)}</p><button onClick={() => onOpen(selected)}>Try again</button></div>
              ) : diff && <pre>{privacy.enabled ? privacy.content(diff.diff) : diff.diff || 'No textual diff available.'}</pre>}
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
    ['Runtime source', data?.live ? privacy.enabled ? 'CLI PID ••••' : `CLI PID ${data.live.pid}` : data?.managed ? 'Grok UI control' : 'Local archive'],
    ['Managed', data?.managed ? 'Yes — durable control record' : 'No — attach with a follow-up'],
    ['Archive state', session.archived ? 'Archived in Grok UI' : 'Active'],
    ['Disk footprint', `${compactNumber(session.diskBytes)} bytes`],
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
