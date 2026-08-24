import { Workflow } from 'lucide-react'
import { usePrivacy } from '../../../privacy'
import type { FleetHostView } from '../../../types'
import { FleetPanelEmpty, SectionState } from '../SectionState'
import { elapsedLabel, exactTime, integer, workflows } from '../model'

export function FleetWorkflows({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const observed = workflows(host)
  return (
    <SectionState host={host} section="workflows">
      {observed.length ? (
        <div className="fleet-run-grid">
          {observed.map((run) => (
            <article className="fleet-run-card" key={`${host.id}:${run.sessionId}:${run.id}`}>
              <header>
                <span className={`fleet-run-status status-${run.status}`}><i /> {run.status.replaceAll('-', ' ')}</span>
                <small title={exactTime(run.updatedAt)}>{elapsedLabel(run.updatedAt)}</small>
              </header>
              <h3>{privacy.capability(run.displayName, 'Run')}</h3>
              <p>{privacy.content(run.objective || run.lastEventDetail || 'No objective was reported.')}</p>
              <div className="fleet-run-progress">
                <span><i style={{ width: `${run.phases.length ? Math.round((run.phases.filter((phase) => phase.status === 'completed').length / run.phases.length) * 100) : 0}%` }} /></span>
                <small>{run.currentPhase ? privacy.capability(run.currentPhase, 'Phase') : 'No active phase'}</small>
              </div>
              <dl>
                <div><dt>Agents</dt><dd>{run.activeAgents} active / {run.agentsUsed} used</dd></div>
                <div><dt>Tokens</dt><dd>{run.tokenTelemetryAvailable ? integer.format(run.totalTokens) : 'Unavailable'}</dd></div>
                <div><dt>Last event</dt><dd>{privacy.content(run.lastEvent.replaceAll('_', ' ') || 'workflow update')}</dd></div>
              </dl>
              {run.agents.length > 0 && (
                <div className="fleet-agent-roster">
                  {run.agents.slice(0, 8).map((agent) => (
                    <span key={agent.id}>
                      <i className={`state-${agent.status.replaceAll('_', '-')}`} />
                      <strong>{privacy.capability(agent.label, 'Agent')}</strong>
                      <small>{agent.model ? privacy.capability(agent.model, 'Model') : agent.status}</small>
                    </span>
                  ))}
                  {run.agents.length > 8 && <em>+{run.agents.length - 8} more agents</em>}
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <FleetPanelEmpty
          icon={Workflow}
          title="No workflow runs observed"
          copy="The agent reported no workflow telemetry in its current bounded snapshot."
        />
      )}
    </SectionState>
  )
}
