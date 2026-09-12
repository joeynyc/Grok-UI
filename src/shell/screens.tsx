import { ArrowRight, CircleAlert, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { login } from '../api'

// Full-stage states: what renders before the dashboard shell exists (boot,
// auth, unreachable server) and the in-shell loading and error surfaces.

export function AmbientGrid() {
  return (
    <div className="ambient-grid" aria-hidden="true">
      <div className="ambient-orb" />
      <div className="scan-beam" />
    </div>
  )
}

export function BrandLogo() {
  return (
    <span className="brand-logo-shell" aria-hidden="true">
      <img className="brand-logo" src="/brand/grok-mark.png" alt="" />
      <i />
    </span>
  )
}

export function LoadingState() {
  return (
    <div className="loading-state">
      <div className="loader-orbit"><div /><div /><span>G</span></div>
      <div className="kicker">Reading local Grok state</div>
      <h1>Indexing the flight recorder.</h1>
      <p>Sessions, signals, capabilities, memory, and workspace metadata.</p>
    </div>
  )
}

export function BootScreen({ label }: { label: string }) {
  return (
    <main className="access-screen">
      <AmbientGrid />
      <div className="access-card boot-card">
        <BrandLogo />
        <div className="loading-bars"><i /><i /><i /><i /></div>
        <strong>{label}</strong>
      </div>
    </main>
  )
}

export function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  return (
    <main className="access-screen">
      <AmbientGrid />
      <form
        className="access-card"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitting(true)
          setError('')
          void login(token)
            .then(onAuthenticated)
            .catch((loginError) => setError(loginError instanceof Error ? loginError.message : 'Sign in failed.'))
            .finally(() => setSubmitting(false))
        }}
      >
        <div className="brand-lockup access-brand">
          <BrandLogo />
          <div><div className="brand-word">GROK</div><div className="brand-sub">Secure command</div></div>
        </div>
        <div className="kicker"><ShieldCheck size={14} /> Remote access gate</div>
        <h1>Local power.<br /><em>One key in.</em></h1>
        <p>This instance is protected. Enter the token configured in <code>GROK_UI_TOKEN</code>.</p>
        <label>
          <span>ACCESS TOKEN</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoFocus
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="access-error">{error}</div>}
        <button className="launch-button" disabled={submitting}>
          <span>{submitting ? 'Checking…' : 'Sign in'}</span>
          <ArrowRight size={16} />
        </button>
      </form>
    </main>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-state">
      <CircleAlert size={38} />
      <div className="kicker">Link interrupted</div>
      <h1>Grok data is out of reach.</h1>
      <p>{message || 'The local API did not return a dashboard payload.'}</p>
      <button className="primary-button" onClick={onRetry}><RefreshCw size={16} /> Try again</button>
    </div>
  )
}

/** The unreachable-server screen: an ErrorState on the access stage. */
export function UnreachableScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="access-screen">
      <AmbientGrid />
      <ErrorState
        message="The Grok UI server did not respond. Start it with grok-ui or npm start, then try again."
        onRetry={onRetry}
      />
    </main>
  )
}
