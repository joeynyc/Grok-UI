import {
  Check,
  CircleStop,
  CornerDownLeft,
  Laptop,
  LoaderCircle,
  Radio,
  RefreshCw,
  ShieldAlert,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  getRemoteSession,
  interruptRemoteSession,
  parseRemoteSessionSnapshot,
  promptRemoteSession,
  remoteSessionEventsUrl,
  resolveRemotePermission,
} from '../api'
import { useModalFocus } from '../hooks/useModalFocus'
import { usePrivacy } from '../privacy'
import type { FleetTransportKind, RemoteSessionSnapshot, SessionRow } from '../types'
import { SessionTimeline } from './SessionTimeline'

interface PendingPrompt {
  commandId: string
  expiresAt: string
  prompt: string
}

interface PendingCommand {
  commandId: string
  expiresAt: string
}

function newCommand(): PendingCommand {
  const commandId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `remote-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { commandId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
}

function status(data: RemoteSessionSnapshot | null): string {
  if (data?.control?.state === 'stopping') return 'INTERRUPTING'
  if (data?.control?.state === 'cancelled') return 'INTERRUPTED'
  if (data?.control?.state === 'attention' || data?.live?.state === 'attention') return 'NEEDS INPUT'
  if (data?.control?.state === 'working' || data?.live?.state === 'working') return 'WORKING'
  if (data?.control) return data.control.state.toUpperCase()
  if (data?.live) return 'CLI ATTACHED'
  return 'RECORDED'
}

export function RemoteSessionWorkbench({
  hostId,
  hostLabel,
  transport,
  sessionId,
  fallback,
  returnFocus,
  onClose,
}: {
  hostId: string
  hostLabel: string
  transport: FleetTransportKind
  sessionId: string
  fallback: SessionRow | null
  returnFocus?: HTMLElement | null
  onClose: () => void
}) {
  const privacy = usePrivacy()
  const [data, setData] = useState<RemoteSessionSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [streamConnected, setStreamConnected] = useState(false)
  const [controlAvailable, setControlAvailable] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [prompt, setPrompt] = useState('')
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const [sending, setSending] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const permissionCommands = useRef(new Map<string, PendingCommand>())
  const interruptCommand = useRef<PendingCommand | null>(null)
  const sessionKey = `${hostId}:${sessionId}`
  const currentSession = useRef(sessionKey)
  currentSession.current = sessionKey
  const sessionRequest = useRef<AbortController | null>(null)
  const dialogRef = useModalFocus<HTMLDivElement>(
    onClose,
    '[aria-label="Close remote session panel"]',
    returnFocus,
  )

  const refresh = useCallback(async (quiet = false) => {
    if (currentSession.current !== sessionKey) return
    sessionRequest.current?.abort()
    const request = new AbortController()
    sessionRequest.current = request
    if (!quiet) setRefreshing(true)
    try {
      const next = await getRemoteSession(hostId, sessionId, request.signal)
      if (request.signal.aborted || currentSession.current !== sessionKey) return
      setData(next)
      setControlAvailable(true)
      setError('')
    } catch (requestError) {
      if (!request.signal.aborted && currentSession.current === sessionKey) {
        setControlAvailable(false)
        setError(requestError instanceof Error ? requestError.message : 'Unable to open the remote session.')
      }
    } finally {
      if (sessionRequest.current === request && !request.signal.aborted) {
        sessionRequest.current = null
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [hostId, sessionId, sessionKey])

  useEffect(() => {
    let active = true
    currentSession.current = sessionKey
    setData(null)
    setLoading(true)
    setControlAvailable(false)
    setStreamConnected(false)
    setPrompt('')
    setPendingPrompt(null)
    setError('')
    setMessage('')
    permissionCommands.current.clear()
    interruptCommand.current = null
    void refresh()
    const events = new EventSource(remoteSessionEventsUrl(hostId, sessionId))
    const supersedeRead = () => {
      sessionRequest.current?.abort()
      sessionRequest.current = null
      setRefreshing(false)
    }
    events.addEventListener('session', (event) => {
      if (!active) return
      try {
        const next = parseRemoteSessionSnapshot(JSON.parse((event as MessageEvent).data))
        // A stream observation received after a GET began supersedes that read.
        supersedeRead()
        setData(next)
        setStreamConnected(true)
        setControlAvailable(true)
        setError('')
        setLoading(false)
      } catch {
        supersedeRead()
        setControlAvailable(false)
        setLoading(false)
        setError('The remote session stream returned an invalid snapshot.')
      }
    })
    events.addEventListener('heartbeat', () => {
      if (active) setStreamConnected(true)
    })
    events.addEventListener('session-error', (event) => {
      if (!active) return
      supersedeRead()
      setStreamConnected(false)
      setControlAvailable(false)
      setLoading(false)
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { error?: string }
        setError(payload.error || 'The remote session connection needs attention.')
      } catch {
        setError('The remote session connection needs attention.')
      }
    })
    events.onerror = () => {
      if (active) setStreamConnected(false)
    }
    return () => {
      active = false
      currentSession.current = ''
      sessionRequest.current?.abort()
      sessionRequest.current = null
      events.close()
    }
  }, [hostId, refresh, sessionId, sessionKey])

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const text = pendingPrompt?.prompt || prompt.trim()
    if (!text || !controlAvailable || sending || stopping) return
    const pending = pendingPrompt || { ...newCommand(), prompt: text }
    setPendingPrompt(pending)
    setSending(true)
    setError('')
    setMessage('')
    try {
      const receipt = await promptRemoteSession(
        hostId,
        sessionId,
        pending.commandId,
        pending.expiresAt,
        pending.prompt,
      )
      if (receipt.status === 'unknown') {
        setMessage('Delivery is being reconciled. Grok UI will not send a duplicate follow-up.')
      } else {
        setMessage('Follow-up accepted by the remote host.')
      }
      setPrompt('')
      setPendingPrompt(null)
      await refresh(true)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send the remote follow-up.')
    } finally {
      setSending(false)
    }
  }

  const interrupt = async () => {
    if (!controlAvailable) return
    const command = interruptCommand.current || newCommand()
    interruptCommand.current = command
    setInterrupting(true)
    setError('')
    try {
      const receipt = await interruptRemoteSession(
        hostId,
        sessionId,
        command.commandId,
        command.expiresAt,
      )
      setMessage(receipt.status === 'unknown'
        ? 'Interrupt outcome is being reconciled; no duplicate command was sent.'
        : 'Interrupt requested. Waiting for Grok to confirm.')
      interruptCommand.current = null
      await refresh(true)
    } catch (interruptError) {
      setError(interruptError instanceof Error
        ? interruptError.message
        : 'Unable to interrupt the remote turn.')
    } finally {
      setInterrupting(false)
    }
  }

  const decide = async (permissionId: string, optionId?: string) => {
    const command = permissionCommands.current.get(permissionId) || newCommand()
    permissionCommands.current.set(permissionId, command)
    setError('')
    try {
      const receipt = await resolveRemotePermission(
        hostId,
        sessionId,
        permissionId,
        command.commandId,
        command.expiresAt,
        optionId,
      )
      setMessage(receipt.status === 'unknown'
        ? 'Permission decision is being reconciled.'
        : 'Permission decision accepted by the remote host.')
      permissionCommands.current.delete(permissionId)
      await refresh(true)
    } catch (decisionError) {
      setError(decisionError instanceof Error
        ? decisionError.message
        : 'Unable to resolve the remote permission.')
    }
  }

  const session = data?.session || fallback
  const stopping = data?.control?.state === 'stopping'
  const working = ['working', 'starting', 'attention'].includes(data?.control?.state || '')
    || data?.live?.state === 'working'
  const canInterrupt = controlAvailable && Boolean(
    data?.managed
    && (
      ['working', 'starting', 'attention'].includes(data.control?.state || '')
      || ['timed_out', 'failed'].includes(data.control?.cancellationStatus || '')
    ),
  )

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
        aria-label="Dismiss remote session"
        tabIndex={-1}
      />
      <section className="session-workbench remote-session-workbench">
        <header className="workbench-head">
          <div className="workbench-identity">
            <span className={`workbench-state ${working ? 'is-working' : data?.permissions.length ? 'is-attention' : ''}`}>
              <i /> {status(data)}
            </span>
            <div className="workbench-title">
              <div>
                <span>Session · {privacy.identifier(sessionId)}</span>
                <h1>{privacy.sessionTitle(session?.title || `Session ${sessionId.slice(0, 8)}`, sessionId)}</h1>
              </div>
            </div>
            <div className="workbench-context">
              <p><Laptop size={14} /><span>{privacy.host(hostLabel, hostId)}</span></p>
              <span>{transport === 'tailscale' ? 'Private Tailscale connection' : 'Authenticated private connection'} · host remains in control</span>
            </div>
          </div>
          <div className="workbench-head-actions">
            <span className={`remote-stream-state ${streamConnected ? 'is-live' : ''}`}>
              {streamConnected ? <Wifi size={15} /> : <WifiOff size={15} />}
              {streamConnected ? 'Live' : 'Reconnecting'}
            </span>
            {canInterrupt && (
              <button
                className="workbench-stop"
                onClick={() => void interrupt()}
                disabled={interrupting}
                aria-label="Interrupt remote turn"
              >
                {interrupting
                  ? <LoaderCircle className="is-spinning" size={16} />
                  : <CircleStop size={16} />}
                <span>Interrupt</span>
              </button>
            )}
            <button className="icon-button" onClick={onClose} aria-label="Close remote session panel"><X size={19} /></button>
          </div>
        </header>

        <div className="workbench-instruments">
          <div><span>STATUS</span><strong>{status(data)}</strong></div>
          <div><span>HOST</span><strong>{privacy.host(hostLabel, hostId)}</strong></div>
          <div><span>TURNS</span><strong>{session?.turns || 0}</strong></div>
          <div><span>TOOLS</span><strong>{session?.toolCalls || 0}</strong></div>
          <div><span>PERMISSIONS</span><strong>{data?.permissions.length || 0}</strong></div>
          <div><span>LINK</span><strong>{streamConnected ? 'LIVE' : 'CHECKING'}</strong></div>
        </div>

        <nav className="workbench-tabs" aria-label="Remote session sections">
          <button className="is-active"><Radio size={15} /> Timeline <span>{data?.transcript.length || 0}</span></button>
          <button
            className="workbench-refresh"
            onClick={() => void refresh()}
            aria-label="Refresh remote session"
          >
            <RefreshCw className={refreshing ? 'is-spinning' : ''} size={15} />
          </button>
        </nav>

        {error
          ? <div className="workbench-banner is-error"><ShieldAlert size={16} /><span>{privacy.content(error)}</span></div>
          : message
            ? <div className="workbench-banner is-success"><Check size={16} /><span>{message}</span></div>
            : <div className="workbench-banner-placeholder" aria-hidden="true" />}

        <div className="workbench-body">
          {loading && !data ? (
            <div className="workbench-loading">
              <LoaderCircle size={25} className="is-spinning" />
              <span>Opening session…</span>
            </div>
          ) : (
            <SessionTimeline
              items={data?.transcript || []}
              permissions={data?.permissions || []}
              onDecide={decide}
            />
          )}
        </div>

        <form className="workbench-composer" onSubmit={send}>
          <div className="composer-mode">
            {streamConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
            <span>Continue session</span>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value)
              if (pendingPrompt && event.target.value !== pendingPrompt.prompt) setPendingPrompt(null)
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={stopping ? 'Wait for Interrupt to finish before sending…' : 'Send a follow-up to this session…'}
            disabled={stopping}
            rows={2}
            maxLength={32_000}
            required
          />
          <button
            disabled={sending || !controlAvailable || !prompt.trim() || stopping}
            aria-label={sending
              ? 'Sending remote follow-up'
              : pendingPrompt
                ? 'Retry remote follow-up'
                : 'Send remote follow-up'}
          >
            {sending
              ? <LoaderCircle className="is-spinning" size={17} />
              : <CornerDownLeft size={17} />}
            <span>{sending ? 'SENDING' : pendingPrompt ? 'RETRY' : 'SEND'}</span>
          </button>
          <small>{stopping ? 'Waiting for Interrupt to finish' : controlAvailable ? '⌘ ↵ to send' : 'Waiting for a fresh, healthy host'}</small>
        </form>
      </section>
    </div>
  )
}
