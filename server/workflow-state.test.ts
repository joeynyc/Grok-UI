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
        agents: [{
          agent_id: 'agent-1',
          label: 'Verifier',
          state: 'failed',
          detail: 'Check failed',
          phase: 'verify',
          model: 'grok-code-fast-1',
          tokens_used: 12_480,
          duration_ms: 84_000,
        }],
        elapsed_ms: 102_000,
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
      totalTokens: 12_480,
      tokenTelemetryAvailable: true,
      elapsedMs: 102_000,
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
      phase: 'verify',
      model: 'grok-code-fast-1',
      tokensUsed: 12_480,
      durationMs: 84_000,
      tokenTelemetryAvailable: true,
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
    expect(second?.run).toMatchObject({
      totalTokens: 0,
      tokenTelemetryAvailable: false,
    })
  })

  it('preserves agent metrics across partial updates and derives the run token total', () => {
    const first = parseWorkflowNotification({
      sessionId: 'session-3',
      update: {
        sessionUpdate: 'workflow_updated',
        run_id: 'run-3',
        status: 'running',
        agent_usage_incomplete: true,
        agents_remaining: 98,
        agents: [
          { agent_id: 'a', label: 'Researcher', state: 'running', tokens_used: 2_500, duration_ms: 9_000, model: 'grok-4', phase: 'research' },
          { agent_id: 'b', label: 'Reviewer', state: 'pending', tokens_used: 750, duration_ms: 1_500, model: 'grok-4-fast', phase: 'review' },
        ],
      },
    })
    const second = parseWorkflowNotification({
      sessionId: 'session-3',
      update: {
        sessionUpdate: 'workflow_updated',
        run_id: 'run-3',
        agents: [
          { agent_id: 'a', label: 'Researcher', state: 'completed' },
          { agent_id: 'b', label: 'Reviewer', state: 'running', tokens_used: 1_250, duration_ms: 4_000 },
        ],
      },
    }, first?.run)

    expect(second?.run).toMatchObject({
      totalTokens: 3_750,
      tokenTelemetryAvailable: true,
      usageIncomplete: true,
      agentsRemaining: 98,
    })
    expect(second?.run.agents[0]).toMatchObject({
      model: 'grok-4',
      phase: 'research',
      tokensUsed: 2_500,
      durationMs: 9_000,
      tokenTelemetryAvailable: true,
    })
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
