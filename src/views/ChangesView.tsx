import {
  ArrowDown,
  ArrowUp,
  Braces,
  FileCode2,
  GitBranch,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getWorkspaceSnapshot } from '../api'
import { useWorkspaceDiff } from '../hooks/useWorkspaceDiff'
import type {
  DashboardPayload,
  LiveSnapshot,
  WorkspaceChangeEvent,
  WorkspaceSnapshot,
} from '../types'
import { usePrivacy } from '../privacy'
import { PageIntro } from '../shell/primitives'

const REPOSITORY_PROBE_LIMIT = 6

interface ChangesViewProps {
  data: DashboardPayload
  live: LiveSnapshot | null
  connected: boolean
  workspaceChange: WorkspaceChangeEvent | null
}

interface WorkspaceState {
  cwd: string
  snapshot: WorkspaceSnapshot | null
  loading: boolean
  error: string
  revision: number
}

export function ChangesView({ data, live, connected, workspaceChange }: ChangesViewProps) {
  const privacy = usePrivacy()
  const workspaces = useMemo(() => [...new Set([
    ...(live?.agents.map((agent) => agent.cwd) || []),
    ...data.sessions.map((session) => session.cwd),
  ].filter(Boolean))], [data.sessions, live])
  const [cwd, setCwd] = useState(workspaces[0] || '')
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>({
    cwd: '', snapshot: null, loading: false, error: '', revision: 0,
  })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [query, setQuery] = useState('')
  const snapshot = workspaceState.cwd === cwd ? workspaceState.snapshot : null
  const loading = Boolean(cwd && (workspaceState.cwd !== cwd || workspaceState.loading))
  const {
    selectedFile, openFile, diff, loading: diffLoading, error: diffError, reset,
  } = useWorkspaceDiff(snapshot?.root || '', workspaceState.revision)
  const error = (workspaceState.cwd === cwd ? workspaceState.error : '') || diffError
  const repositoryCandidates = JSON.stringify(
    cwd === workspaces[0] ? workspaces.slice(1, 1 + REPOSITORY_PROBE_LIMIT) : [],
  )
  useEffect(() => {
    if (!workspaces.includes(cwd)) setCwd(workspaces[0] || '')
  }, [cwd, workspaces])

  useEffect(() => {
    if (workspaceChange?.root && workspaceChange.root === snapshot?.root) {
      setRefreshVersion((current) => current + 1)
    }
  }, [workspaceChange, snapshot?.root])

  useEffect(() => {
    if (!cwd) return
    const controller = new AbortController()
    setWorkspaceState((current) => ({
      cwd,
      snapshot: current.cwd === cwd ? current.snapshot : null,
      loading: true,
      error: '',
      revision: current.revision,
    }))
    const loadWorkspace = async () => {
      try {
        let workspace = cwd
        let payload = await getWorkspaceSnapshot(workspace, controller.signal)
        if (controller.signal.aborted) return
        if (!payload.repository) {
          // Bound fallback Git status reads, and stop probing as soon as this
          // workspace request is replaced by a selection or refresh.
          for (const candidate of JSON.parse(repositoryCandidates) as string[]) {
            const candidatePayload = await getWorkspaceSnapshot(candidate, controller.signal)
            if (controller.signal.aborted) return
            if (candidatePayload.repository) {
              workspace = candidate
              payload = candidatePayload
              setCwd(candidate)
              break
            }
          }
        }
        setWorkspaceState((current) => ({
          cwd: workspace, snapshot: payload, loading: false, error: '', revision: current.revision + 1,
        }))
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setWorkspaceState((current) => ({
            ...current,
            loading: false,
            error: loadError instanceof Error ? loadError.message : 'Unable to inspect workspace.',
          }))
        }
      }
    }
    void loadWorkspace()
    return () => controller.abort()
  }, [cwd, refreshVersion, repositoryCandidates])

  useEffect(() => {
    if (!snapshot || snapshot.files.some((file) => file.path === selectedFile)) return
    if (snapshot.files[0]) openFile(snapshot.files[0].path)
    else reset()
  }, [snapshot, selectedFile, openFile, reset])

  const files = snapshot?.files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase())) || []
  const watching = snapshot ? snapshot.watching !== false && snapshot.repository : true

  return (
    <>
      <PageIntro
        index="03"
        className="changes-intro"
        icon={Braces}
        eyebrow="Change surface"
        title={<>See the work.<br /><em>Before it lands.</em></>}
        description="A repository-aware view of every staged, unstaged, and untracked file in the workspace Grok is operating on."
      />

      <section className="workspace-toolbar">
        <label>
          <span>WORKSPACE</span>
          <select value={cwd} onChange={(event) => setCwd(event.target.value)}>
            {workspaces.map((workspace) => (
              <option value={workspace} key={workspace}>{privacy.path(workspace)}</option>
            ))}
          </select>
        </label>
        <span
          className={`workspace-live-state ${connected && watching ? 'is-connected' : ''}`}
          title={!connected ? 'The event stream is reconnecting.' : watching ? 'Changes update automatically as files change.' : 'Live file watching is unavailable for this workspace. Use Refresh to update.'}
        >
          <span className={`status-dot ${connected && watching ? 'is-live' : ''}`} />
          {!connected ? 'RECONNECTING' : watching ? 'LIVE WATCH' : 'MANUAL REFRESH'}
        </span>
        <button className="icon-button" onClick={() => setRefreshVersion((current) => current + 1)} aria-label="Refresh changes">
          <RefreshCw size={17} className={loading ? 'is-spinning' : ''} />
        </button>
      </section>

      {error && <div className="control-banner is-error"><span>{privacy.content(error)}</span></div>}

      <section className="git-summary-strip">
        <div><GitBranch size={16} /><span>BRANCH</span><strong>{snapshot?.branch ? privacy.content(snapshot.branch) : '—'}</strong></div>
        <div><FileCode2 size={16} /><span>FILES</span><strong>{snapshot?.files.length || 0}</strong></div>
        <div className="git-add"><ArrowUp size={16} /><span>ADDED</span><strong>+{snapshot?.additions || 0}</strong></div>
        <div className="git-delete"><ArrowDown size={16} /><span>REMOVED</span><strong>−{snapshot?.deletions || 0}</strong></div>
        <div><span>AHEAD / BEHIND</span><strong>{snapshot?.ahead || 0} / {snapshot?.behind || 0}</strong></div>
      </section>

      <section className="changes-workbench section-gap">
        <aside className="change-files">
          <header>
            <div><span className="panel-index">01</span><h2>Changed files</h2></div>
            <span>{String(files.length).padStart(2, '0')}</span>
          </header>
          <label className="file-filter">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter paths" />
          </label>
          <div className="change-file-list">
            {files.map((file) => (
              <button className={selectedFile === file.path ? 'is-active' : ''} onClick={() => openFile(file.path)} key={file.path}>
                <span className={`file-status status-${file.status.replaceAll(' ', '')}`}>{file.status}</span>
                <span className="file-path">{privacy.file(file.path)}</span>
                <span className="file-delta"><i>+{file.additions}</i><em>−{file.deletions}</em></span>
              </button>
            ))}
            {!files.length && (
              <p className="files-empty">
                {snapshot?.repository
                  ? (query ? 'No changed files match this filter.' : 'Working tree clean.')
                  : snapshot
                    ? privacy.content(snapshot.error || 'This workspace is not a Git repository.')
                    : workspaces.length
                      ? 'Reading workspace…'
                      : 'No workspace yet. Start a Grok session in a repository to inspect its changes here.'}
              </p>
            )}
          </div>
        </aside>

        <section className="diff-viewer">
          <header>
            <div><span className="panel-index">02</span><h2>{selectedFile ? privacy.file(selectedFile) : 'Select a file'}</h2></div>
            {diff?.truncated && <span className="diff-truncated">TRUNCATED</span>}
          </header>
          {diff ? (
            <pre aria-label={`Diff for ${privacy.file(diff.path)}`}>
              {privacy.enabled ? privacy.content(diff.diff) : diff.diff || 'No textual diff available.'}
            </pre>
          ) : (
            <div className="diff-empty"><Braces size={24} /><span>{diffLoading ? 'Loading diff…' : 'Choose a changed file to inspect its patch.'}</span></div>
          )}
        </section>
      </section>
    </>
  )
}
