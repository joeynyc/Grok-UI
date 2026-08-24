import { Database } from 'lucide-react'
import { usePrivacy } from '../../../privacy'
import type { FleetHostView, UsageReport } from '../../../types'
import { FleetPanelEmpty, SectionState } from '../SectionState'
import { integer } from '../model'

export function FleetUsage({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const usage: UsageReport | null | undefined = host.snapshot?.usage
  return (
    <SectionState host={host} section="usage">
      {usage ? (
        <div className="fleet-usage">
          <section className="fleet-usage-summary">
            <div><span>Total tokens</span><strong>{usage.totals.totalTokens.value == null ? '—' : integer.format(usage.totals.totalTokens.value)}</strong><small>{usage.totals.totalTokens.source}</small></div>
            <div><span>Observations</span><strong>{integer.format(usage.entries.length)}</strong><small>{usage.scope.replaceAll('-', ' ')}</small></div>
            <div><span>Coverage</span><strong>{integer.format(Object.values(usage.coverage).reduce((sum, value) => sum + value, 0))}</strong><small>provenance labels</small></div>
          </section>
          <div className="fleet-table-wrap">
            <table className="fleet-table fleet-usage-table">
              <caption className="sr-only">Read-only usage groups observed on this host</caption>
              <thead><tr><th>{usage.groupBy}</th><th>Sessions</th><th>Input</th><th>Output</th><th>Total</th><th>Source</th></tr></thead>
              <tbody>
                {usage.groups.slice(0, 100).map((group) => {
                  const label = usage.groupBy === 'project'
                    ? privacy.workspace(group.label)
                    : usage.groupBy === 'session'
                      ? privacy.sessionTitle(group.label, `${host.id}:${group.key}`)
                      : usage.groupBy === 'agent'
                        ? privacy.capability(group.label, 'Agent')
                        : privacy.capability(group.label, 'Model')
                  return (
                    <tr key={`${host.id}:${group.key}`}>
                      <td><strong>{label}</strong><small>{group.entries} observations</small></td>
                      <td>{integer.format(group.sessions)}</td>
                      <td>{group.inputTokens.value == null ? '—' : integer.format(group.inputTokens.value)}</td>
                      <td>{group.outputTokens.value == null ? '—' : integer.format(group.outputTokens.value)}</td>
                      <td><strong>{group.totalTokens.value == null ? '—' : integer.format(group.totalTokens.value)}</strong></td>
                      <td><span className={`fleet-usage-source source-${group.totalTokens.source}`}>{group.totalTokens.source}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="fleet-boundary-note">This is a read-only remote ledger projection. Budgets and alerts remain owned by their local host.</p>
        </div>
      ) : (
        <FleetPanelEmpty
          icon={Database}
          title="No usage snapshot"
          copy="Usage monitoring is advertised, but the host has not delivered a report."
        />
      )}
    </SectionState>
  )
}
