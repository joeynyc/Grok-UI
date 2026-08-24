import { Activity, Braces, Clock3, Database, Server, ShieldCheck, Workflow, Zap } from 'lucide-react'
import { usePrivacy } from '../../../privacy'
import type { FleetHostView } from '../../../types'
import {
  capabilities,
  elapsedLabel,
  hostVersions,
  isHistoricalHost,
  integer,
  sessions,
  workflows,
} from '../model'

export function FleetOverview({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const versions = hostVersions(host)
  const hostCapabilities = capabilities(host)
  const identity = host.host
  const observedSessions = sessions(host)
  const observedWorkflows = workflows(host)
  const liveCount = observedSessions.filter((session) =>
    session.status === 'live' || session.status === 'attention').length
  const runtime = host.snapshot?.runtime
  const usage = host.snapshot?.usage
  const historical = isHistoricalHost(host)

  return (
    <div className="fleet-overview">
      {historical && (
        <div className="fleet-partial-note is-stale" role="status">
          <Clock3 size={14} />
          Cached overview from {elapsedLabel(host.lastSeen)}. Values are not live.
        </div>
      )}
      <section className="fleet-overview-card fleet-identity-card">
        <header><Server size={15} /><span>HOST IDENTITY</span></header>
        <dl>
          <div><dt>Hostname</dt><dd>{identity ? privacy.host(identity.label || identity.hostname, host.id) : 'Unavailable'}</dd></div>
          <div><dt>Platform</dt><dd>{identity?.platform || '—'}</dd></div>
          <div><dt>Architecture</dt><dd>{identity?.arch || '—'}</dd></div>
          <div><dt>Transport</dt><dd>{host.transport.toUpperCase()}</dd></div>
        </dl>
      </section>
      <section className="fleet-overview-card">
        <header><Braces size={15} /><span>VERSION NEGOTIATION</span></header>
        <dl>
          <div><dt>Grok UI</dt><dd>{versions.grokUi}</dd></div>
          <div><dt>Host agent</dt><dd>{versions.agent}</dd></div>
          <div><dt>Protocol</dt><dd>{versions.protocol}</dd></div>
          <div><dt>Compatibility</dt><dd>{host.status === 'incompatible' ? 'Update required' : 'Negotiated'}</dd></div>
        </dl>
      </section>
      <section className="fleet-overview-card fleet-capabilities-card">
        <header><Zap size={15} /><span>READ CAPABILITIES</span></header>
        <div>
          {(hostCapabilities.length ? hostCapabilities : ['No capabilities advertised']).map((capability) => (
            <span key={capability}><i /> {capability.replaceAll('_', ' ')}</span>
          ))}
        </div>
      </section>
      <section className="fleet-observation-strip" aria-label="Remote telemetry counts">
        <div><Activity size={16} /><span>Sessions</span><strong>{observedSessions.length}</strong><small>{liveCount} active</small></div>
        <div><Workflow size={16} /><span>Runs</span><strong>{observedWorkflows.length}</strong><small>read-only projection</small></div>
        <div><Braces size={16} /><span>Processes</span><strong>{runtime?.processes.length || 0}</strong><small>bounded descendants</small></div>
        <div><Database size={16} /><span>Tokens</span><strong>{usage?.totals.totalTokens.value == null ? '—' : integer.format(usage.totals.totalTokens.value)}</strong><small>{usage?.totals.totalTokens.source || 'unavailable'}</small></div>
      </section>
      <p className="fleet-readonly-explainer">
        <ShieldCheck size={15} />
        This monitor can read negotiated snapshots only. It cannot start work, send prompts,
        resolve permissions, control runs, execute a shell, or probe arbitrary endpoints.
      </p>
    </div>
  )
}
