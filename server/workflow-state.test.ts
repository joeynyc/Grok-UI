import { describe, expect, it } from 'vitest'
import { parseWorkflowNotification, workflowControlCommand } from './workflow-state.js'

describe('workflow telemetry', () => {
  it('normalizes Grok snake_case workflow updates and enables failed-run recovery', () => {
    const parsed = parseWorkflowNotification({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'workflow_updated',
        run_id: 'run-1',
        display_name: 'release-check',
        objective: 'Verify the release',
        status: 'failed',
        phases: [
          { id: 'plan', name: 'Plan', status: 'completed' },
          { id: 'verify', name: 'Verify', status: 'failed' },
        ],
        current_phase: 'verify',
        agent_budget: 8,
        agents_used: 4,
        active_agents: 0,
        agents: [{ id: 'agent-1', label: 'Verifier', status: 'failed', detail: 'Check failed' }],
        last_event: 'workflow_failed',
        last_event_detail: 'Recoverable verification failure',
        last_event_timestamp: '2026-07-25T12:00:00.000Z',
      },
    })

    expect(parsed).not.toBeNull()
    expect(parsed?.run).toMatchObject({
      id: 'run-1',
      controlHandle: 'release-check',
      displayName: 'release-check',
      sessionId: 'session-1',
      status: 'failed',
      currentPhase: 'verify',
      agentBudget: 8,
      agentsUsed: 4,
      canPause: false,
      canResume: true,
      canStop: false,
    })
    expect(parsed?.run.phases[1]).toEqual({ id: 'verify', label: 'Verify', status: 'failed' })
    expect(parsed?.run.agents[0]).toEqual({
      id: 'agent-1',
      label: 'Verifier',
      status: 'failed',
      detail: 'Check failed',
    })
  })

  it('merges partial camelCase updates without losing the run roster', () => {
    const first = parseWorkflowNotification({
      session_id: 'session-2',
      update: {
        session_update: 'workflow_updated',
        runId: 'run-2',
        displayName: 'migration',
        status: 'running',
        phases: ['Plan', 'Execute'],
        agents: ['Planner'],
      },
    })
    const second = parseWorkflowNotification({
      session_id: 'session-2',
      update: {
        session_update: 'workflow_updated',
        runId: 'run-2',
        status: 'completed',
        resultSummary: 'Migration complete',
      },
    }, first?.run)

    expect(second?.run).toMatchObject({
      status: 'completed',
      displayName: 'migration',
      resultSummary: 'Migration complete',
      canPause: false,
      canResume: false,
      canStop: false,
    })
    expect(second?.run.phases).toHaveLength(2)
    expect(second?.run.agents).toHaveLength(1)
  })

  it('ignores unrelated notifications and refuses unsafe command handles', () => {
    expect(parseWorkflowNotification({
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk' },
    })).toBeNull()
    expect(workflowControlCommand('resume', 'release-check')).toBe('/workflow resume release-check')
    expect(() => workflowControlCommand('resume', 'release check; rm -rf')).toThrow('safe control handle')
  })
})
