import { describe, expect, it } from 'vitest'
import {
  FLEET_PROTOCOL_VERSION,
  MAX_AGENT_BODY_BYTES,
} from './fleet-protocol.js'
import { startHostAgent, type HostAgentProvider } from './host-agent.js'

function usage() {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    period: '30d' as const,
    scope: 'sessions' as const,
    from: '2025-12-01T00:00:00.000Z',
    to: '2026-01-01T00:00:00.000Z',
    groupBy: 'project' as const,
    entries: [],
    totals: {
      key: 'all',
      label: 'All usage',
      entries: 0,
      sessions: 0,
      inputTokens: { value: null, source: 'unavailable' as const },
      outputTokens: { value: null, source: 'unavailable' as const },
      totalTokens: { value: null, source: 'unavailable' as const },
      costs: [{ value: null, source: 'unavailable' as const, currency: '' }],
      updatedAt: '',
    },
    groups: [],
    coverage: { 'grok-reported': 0, derived: 0, incomplete: 0, unavailable: 0 },
  }
}

function provider(): HostAgentProvider {
  const workflow = {
    id: 'workflow-1',
    controlHandle: 'unsafe-control',
    displayName: 'Remote workflow',
    sessionId: 'session-1',
    objective: 'Observe only',
    foreground: false,
    status: 'running' as const,
    phases: [],
    currentPhase: '',
    agentBudget: 1,
    agentsUsed: 1,
    agentsReserved: 0,
    agentsRemaining: 0,
    usageIncomplete: false,
    activeAgents: 1,
    currentAgentLabel: 'Observer',
    agents: [],
    totalTokens: 10,
    tokenTelemetryAvailable: true,
    elapsedMs: 100,
    lastEvent: 'running',
    lastEventDetail: '',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    pauseMessage: '',
    resultSummary: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    canPause: true,
    canResume: true,
    canStop: true,
  }
  const session = {
    id: 'session-1',
    title: 'Remote session',
    summary: '',
    cwd: '/workspace',
    workspace: 'workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'grok',
    agent: 'Grok CLI',
    reasoningEffort: 'default',
    sandboxProfile: 'default',
    messages: 1,
    chatMessages: 1,
    turns: 1,
    toolCalls: 0,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: 1,
    contextUsage: 0,
    status: 'live' as const,
    diskBytes: 0,
    archived: false,
  }
  return {
    async hello() {
      return {
        protocolVersion: FLEET_PROTOCOL_VERSION,
        protocolMin: 1,
        protocolMax: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        host: { id: 'remote', label: 'Remote', hostname: 'remote', platform: 'linux', arch: 'arm64' },
        grokUiVersion: '0.10.0',
        agentVersion: '0.10.0',
        grokVersion: 'grok-test',
        capabilities: ['sessions.list', 'sessions.detail', 'workflows.list', 'runtime.snapshot', 'usage.report'],
      }
    },
    async snapshot() {
      return {
        ...(await this.hello()),
        health: { status: 'healthy' as const, detail: '' },
        sessions: [session],
        workflows: [workflow],
        runtime: null,
        usage: usage(),
        sections: {
          sessions: 'available' as const,
          workflows: 'available' as const,
          runtime: 'unavailable' as const,
          usage: 'available' as const,
        },
        truncated: { sessions: false, workflows: false, usageEntries: false },
      }
    },
    async session() {
      return {
        protocolVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        hostId: 'remote',
        session,
        transcript: [],
        live: null,
        control: null,
        workflows: [workflow],
        managed: true,
      }
    },
    async usage() {
      return usage()
    },
  }
}

describe('read-only host agent protocol', () => {
  it('requires its distinct bearer token and exposes only GET/HEAD observation routes', async () => {
    const agent = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'agent-secret',
      provider: provider(),
    })
    try {
      expect((await fetch(`${agent.url}/agent/v1/hello`)).status).toBe(401)
      expect((await fetch(`${agent.url}/agent/v1/hello`, {
        headers: { Authorization: 'Bearer wrong' },
      })).status).toBe(401)
      expect((await fetch(`${agent.url}/agent/v1/hello`, {
        method: 'POST',
        headers: { Authorization: 'Bearer agent-secret' },
      })).status).toBe(405)
      expect((await fetch(`${agent.url}/agent/v1/control`, {
        headers: { Authorization: 'Bearer agent-secret' },
      })).status).toBe(404)
    } finally {
      await agent.close()
    }
  })

  it('strips every workflow control and keeps protocol responses under the body cap', async () => {
    const agent = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'agent-secret',
      provider: provider(),
    })
    try {
      const response = await fetch(`${agent.url}/agent/v1/snapshot`, {
        headers: { Authorization: 'Bearer agent-secret' },
      })
      const body = await response.text()
      const snapshot = JSON.parse(body)
      expect(response.status).toBe(200)
      expect(Buffer.byteLength(body)).toBeLessThan(MAX_AGENT_BODY_BYTES)
      expect(snapshot.workflows[0]).toMatchObject({
        controlHandle: '',
        canPause: false,
        canResume: false,
        canStop: false,
      })
      expect(body).not.toContain('unsafe-control')
      expect(body).not.toContain('permissions')
    } finally {
      await agent.close()
    }
  })
})
