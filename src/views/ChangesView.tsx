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
import { getWorkspaceDiff, getWorkspaceSnapshot } from '../api'
import type {
  DashboardPayload,
  LiveSnapshot,
  WorkspaceChangeEvent,
  WorkspaceDiff,
  WorkspaceSnapshot,
} from '../types'
import { usePrivacy } from '../privacy'

interface ChangesViewProps {
  data: DashboardPayload
  live: LiveSnapshot | null
  connected: boolean
  workspaceChange: WorkspaceChangeEvent | null
}

export function ChangesView({ data, live, connected, workspaceChange }: ChangesViewProps) {
  const privacy = usePrivacy()
  const workspaces = useMemo(() => [...new Set([
    ...(live?.agents.map((agent) => agent.cwd) || []),
    ...data.sessions.map((session) => session.cwd),
  ].filter(Boolean))], [data.sessions, live])
  const [cwd, setCwd] = useState(workspaces[0] || '')
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadWorkspace = async (workspace = cwd) => {
    if (!workspace) return
    setLoading(true)
    setError('')
    try {
      let payload = await getWorkspaceSnapshot(workspace)
      if (!payload.repository && workspace === workspaces[0]) {
        for (const candidate of workspaces.slice(1)) {
          const candidatePayload = await getWorkspaceSnapshot(candidate)
          if (candidatePayload.repository) {
            setCwd(candidate)
            payload = candidatePayload
            break
          }
        }
      }
      setSnapshot(payload)
      if (selected && payload.files.some((file) => file.path === selected)) {
        setDiff(await getWorkspaceDiff(payload.root, selected))
      } else if (!payload.files.some((file) => file.path === selected)) {
        setSelected(payload.files[0]?.path || '')
        setDiff(null)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to inspect workspace.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadWorkspace(cwd)
  }, [cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (workspaceChange?.root === snapshot?.root) void loadWorkspace(cwd)
  }, [workspaceChange]) // eslint-disable-line react-hooks/exhaustive-deps

  const openDiff = async (file: string) => {
    setSelected(file)
    setError('')
    try {
      setDiff(await getWorkspaceDiff(cwd, file))
    } catch (diffError) {
      setError(diffError instanceof Error ? diffError.message : 'Unable to load diff.')
    }
  }

  const files = snapshot?.files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase())) || []

  return (
    <>
      <section className="page-intro changes-intro">
        <div className="page-intro-index">04 / 12</div>
        <div className="page-intro-copy">
          <div className="kicker"><Braces size={14} /> Change surface</div>
          <h1>See the work.<br /><em>Before it lands.</em></h1>
        </div>
        <p>A repository-aware view of every staged, unstaged, and untracked file in the workspace Grok is operating on.</p>
      </section>

      <section className="workspace-toolbar">
        <label>
          <span>WORKSPACE</span>
          <select value={cwd} onChange={(event) => setCwd(event.target.value)}>
            {workspaces.map((workspace) => (
              <option value={workspace} key={workspace}>{privacy.path(workspace)}</option>
            ))}
          </select>
        </label>
        <span className={`workspace-live-state ${connected ? 'is-connected' : ''}`}>
          <span className={`status-dot ${connected ? 'is-live' : ''}`} />
          {connected ? 'LIVE WATCH' : 'RECONNECTING'}
        </span>
        <button className="icon-button" onClick={() => void loadWorkspace()} aria-label="Refresh changes">
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
              <button className={selected === file.path ? 'is-active' : ''} onClick={() => void openDiff(file.path)} key={file.path}>
                <span className={`file-status status-${file.status.replaceAll(' ', '')}`}>{file.status}</span>
                <span className="file-path">{privacy.file(file.path)}</span>
                <span className="file-delta"><i>+{file.additions}</i><em>−{file.deletions}</em></span>
              </button>
            ))}
            {!files.length && (
              <p className="files-empty">
                {snapshot?.repository
                  ? 'Working tree clean.'
                  : snapshot?.error
                    ? privacy.content(snapshot.error)
                    : 'No workspace selected.'}
              </p>
            )}
          </div>
        </aside>

        <section className="diff-viewer">
          <header>
            <div><span className="panel-index">02</span><h2>{selected ? privacy.file(selected) : 'Select a file'}</h2></div>
            {diff?.truncated && <span className="diff-truncated">TRUNCATED</span>}
          </header>
          {diff ? (
            <pre aria-label={`Diff for ${privacy.file(diff.path)}`}>
              {privacy.enabled ? privacy.content(diff.diff) : diff.diff || 'No textual diff available.'}
            </pre>
          ) : (
            <div className="diff-empty"><Braces size={24} /><span>Choose a changed file to inspect its patch.</span></div>
          )}
        </section>
      </section>
    </>
  )
}
