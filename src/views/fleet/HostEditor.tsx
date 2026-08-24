import { AlertTriangle, LoaderCircle, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { createFleetHost, deleteFleetHost, updateFleetHost } from '../../api'
import { usePrivacy } from '../../privacy'
import type {
  FleetHostInput,
  FleetHostView,
  FleetSnapshot,
  FleetTransportKind,
} from '../../types'

export function HostEditor({
  host,
  onClose,
  onSaved,
  onRemoved,
}: {
  host: FleetHostView | null
  onClose: () => void
  onSaved: (fleet: FleetSnapshot, hostId: string) => void
  onRemoved: (id: string) => void
}) {
  const privacy = usePrivacy()
  const [label, setLabel] = useState(privacy.enabled && host ? '' : host?.label || '')
  const [transport, setTransport] = useState<FleetTransportKind>(host?.transport || 'tailscale')
  const [baseUrl, setBaseUrl] = useState(privacy.enabled && host ? '' : host?.config.baseUrl || '')
  const [sshTarget, setSshTarget] = useState(privacy.enabled && host ? '' : host?.config.sshTarget || '')
  const [sshPort, setSshPort] = useState(String(host?.config.sshPort || 22))
  const [localPort, setLocalPort] = useState(String(host?.config.localPort || 4312))
  const [remotePort, setRemotePort] = useState(String(host?.config.remotePort || 4311))
  const [enabled, setEnabled] = useState(host?.config.enabled !== false)
  const [token, setToken] = useState('')
  const [controlEnabled, setControlEnabled] = useState(host?.config.controlEnabled === true)
  const [controlToken, setControlToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const editorRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const editor = editorRef.current
    const focusable = () => [...(editor?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || [])].filter((element) => element.offsetParent !== null)
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onClose])

  useEffect(() => {
    if (!privacy.enabled || !host) return
    setLabel('')
    setBaseUrl('')
    setSshTarget('')
    setToken('')
    setControlToken('')
  }, [host, privacy.enabled])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!host && !label.trim()) return
    setBusy(true)
    setError('')
    const input: FleetHostInput = {
      transport,
      enabled,
    }
    if (label.trim()) input.label = label.trim()
    if (transport === 'ssh') {
      if (sshTarget.trim()) input.sshTarget = sshTarget.trim()
      input.sshPort = Number(sshPort)
      input.localPort = Number(localPort)
      input.remotePort = Number(remotePort)
    } else if (baseUrl.trim()) {
      input.baseUrl = baseUrl.trim()
    }
    if (token) input.token = token
    input.controlEnabled = controlEnabled
    if (controlToken) input.controlToken = controlToken
    try {
      const result = host
        ? await updateFleetHost(host.id, input)
        : await createFleetHost(input)
      onSaved(result.fleet, result.host.id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save host.')
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!host) return
    setBusy(true)
    setError('')
    try {
      await deleteFleetHost(host.id)
      onRemoved(host.id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to remove host.')
      setBusy(false)
    }
  }

  return createPortal((
    <div className="fleet-editor-layer" role="dialog" aria-modal="true" aria-labelledby="fleet-editor-title">
      <button className="fleet-editor-scrim" type="button" onClick={onClose} aria-label="Close host registry editor" />
      <form className="fleet-editor" onSubmit={submit} ref={editorRef}>
        <header>
          <div>
            <span>LOCAL HOST REGISTRY</span>
            <h2 id="fleet-editor-title">{host ? 'Edit monitor link' : 'Register a host'}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close host registry editor"><X size={18} /></button>
        </header>
        <p>
          Connection settings stay on this central machine. Monitoring remains read-only;
          secure remote sessions require a separate host-issued control token.
        </p>
        {privacy.enabled && host && (
          <div className="fleet-editor-privacy"><ShieldCheck size={14} /> Sensitive values are hidden. Leave a field blank to keep its current value.</div>
        )}
        <div className="fleet-editor-grid">
          <label>
            <span>Display name</span>
            <input
              name="label"
              autoComplete="off"
              value={label}
              required={!host}
              maxLength={160}
              placeholder={privacy.enabled && host ? 'Unchanged while Privacy Mode is active' : 'Build workstation…'}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            <span>Transport</span>
            <select name="transport" value={transport} onChange={(event) => setTransport(event.target.value as FleetTransportKind)}>
              <option value="tailscale">Tailscale</option>
              <option value="ssh">SSH tunnel</option>
              <option value="direct">Direct (advanced / test)</option>
            </select>
          </label>
          {transport !== 'ssh' ? (
            <label className="fleet-editor-wide">
              <span>{transport === 'tailscale' ? 'Tailscale agent URL' : 'Loopback agent URL'}</span>
              <input
                name="baseUrl"
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={baseUrl}
                required={!host}
                placeholder={privacy.enabled && host
                  ? 'Unchanged while Privacy Mode is active'
                  : transport === 'tailscale'
                    ? 'https://studio-node.tailnet.ts.net:4311…'
                    : 'http://127.0.0.1:4311…'}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="fleet-editor-wide">
                <span>SSH target</span>
                <input
                  name="sshTarget"
                  autoComplete="off"
                  spellCheck={false}
                  value={sshTarget}
                  required={!host}
                  placeholder={privacy.enabled && host ? 'Unchanged while Privacy Mode is active' : 'operator@build-host…'}
                  onChange={(event) => setSshTarget(event.target.value)}
                />
              </label>
              <label>
                <span>SSH port</span>
                <input name="sshPort" type="number" min="1" max="65535" inputMode="numeric" value={sshPort} onChange={(event) => setSshPort(event.target.value)} />
              </label>
              <label>
                <span>Local tunnel port</span>
                <input name="localPort" type="number" min="1" max="65535" inputMode="numeric" value={localPort} onChange={(event) => setLocalPort(event.target.value)} />
              </label>
              <label>
                <span>Remote agent port</span>
                <input name="remotePort" type="number" min="1" max="65535" inputMode="numeric" value={remotePort} onChange={(event) => setRemotePort(event.target.value)} />
              </label>
            </>
          )}
          <label>
            <span>Agent token {host ? '(optional replacement)' : ''}</span>
            <input
              name="token"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={token}
              required={!host}
              placeholder={host ? 'Leave blank to keep current token' : 'Paste a host-agent token…'}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            <span>Control token {host ? '(optional replacement)' : ''}</span>
            <input
              name="controlToken"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={controlToken}
              required={controlEnabled && !host?.config.hasControlToken}
              placeholder={host
                ? 'Leave blank to keep current control token'
                : 'Paste the separate remote-control token…'}
              onChange={(event) => setControlToken(event.target.value)}
            />
          </label>
          <label className="fleet-enabled-toggle">
            <input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span><strong>Monitor enabled</strong><small>Poll this host on the registry schedule.</small></span>
          </label>
          <label className="fleet-enabled-toggle">
            <input
              name="controlEnabled"
              type="checkbox"
              checked={controlEnabled}
              onChange={(event) => setControlEnabled(event.target.checked)}
            />
            <span>
              <strong>Secure remote sessions</strong>
              <small>Allow chat, exact permission decisions, and turn interruption.</small>
            </span>
          </label>
        </div>
        {error && (
          <div className="fleet-editor-error" role="alert">
            <AlertTriangle size={14} /> {privacy.content(error)}
          </div>
        )}
        <footer>
          {host && (
            confirmRemove ? (
              <div className="fleet-remove-confirm">
                <span>Remove this local registry entry?</span>
                <button type="button" onClick={() => setConfirmRemove(false)}>Keep host</button>
                <button className="is-danger" type="button" onClick={() => void remove()} disabled={busy}><Trash2 size={14} /> Remove</button>
              </div>
            ) : (
              <button className="fleet-remove-trigger" type="button" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={14} /> Remove entry
              </button>
            )
          )}
          <div>
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="fleet-save-host" disabled={busy}>
              {busy ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}
              {host ? 'Save registry entry' : 'Register host'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  ), document.body)
}
