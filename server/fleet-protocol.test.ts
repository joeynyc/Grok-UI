import { describe, expect, it } from 'vitest'
import {
  FLEET_PROTOCOL_VERSION,
  MAX_AGENT_SESSIONS,
  MAX_AGENT_USAGE_ENTRIES,
  MAX_AGENT_WORKFLOWS,
  hostScopeSnapshot,
  normalizeAgentSnapshot,
  protocolCompatible,
  normalizeAgentHello,
} from './fleet-protocol.js'

function rawSnapshot() {
  return {
    protocolVersion: FLEET_PROTOCOL_VERSION,
    generatedAt: 'not-a-date',
    host: {
      id: 'remote',
      label: 'Remote\0 host',
      hostname: 'remote.local',
      platform: 'linux',
      arch: 'arm64',
    },
    grokUiVersion: '0.10.0',
    agentVersion: '0.10.0',
    grokVersion: 'grok-test',
    capabilities: ['sessions.list', 'workflows.list', 'remote.control', 'sessions.list'],
    health: { status: 'healthy', detail: '' },
    sessions: Array.from({ length: 250 }, (_, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: index === 0 ? 'live' : 'idle',
    })),
    workflows: Array.from({ length: 120 }, (_, index) => ({
      id: `workflow-${index}`,
      sessionId: `session-${index}`,
      controlHandle: 'do-not-expose',
      status: 'running',
      canPause: true,
      canResume: true,
      canStop: true,
      phases: [],
      agents: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    runtime: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      available: true,
      partial: false,
      error: '',
      roots: [{ pid: 10, managed: false, sessionIds: ['session-0'], workspaces: ['/tmp/a'] }],
      processes: [],
      ports: [],
      services: [],
      tests: [],
      externalCalls: [],
    },
    usage: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      period: '30d',
      scope: 'sessions',
      from: '2025-12-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
      groupBy: 'project',
      entries: Array.from({ length: 1_100 }, (_, index) => ({
        id: `usage-${index}`,
        kind: 'cli-session',
        sessionId: `session-${index}`,
        sessionTitle: `Session ${index}`,
        workflowId: '',
        project: 'project',
        cwd: '/tmp/project',
        model: 'grok',
        agent: 'Grok CLI',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        inputTokens: { value: null, source: 'unavailable' },
        outputTokens: { value: null, source: 'unavailable' },
        totalTokens: { value: null, source: 'unavailable' },
        cost: { value: null, source: 'unavailable', currency: '' },
      })),
      totals: {},
      groups: [],
      coverage: {},
    },
    sections: {
      sessions: 'available',
      workflows: 'available',
      runtime: 'available',
      usage: 'available',
    },
    truncated: {},
  }
}

describe('fleet protocol normalization', () => {
  it('caps and safely normalizes untrusted snapshots while stripping remote controls', () => {
    const snapshot = normalizeAgentSnapshot(rawSnapshot())
    expect(snapshot.sessions).toHaveLength(MAX_AGENT_SESSIONS)
    expect(snapshot.workflows).toHaveLength(MAX_AGENT_WORKFLOWS)
    expect(snapshot.usage?.entries).toHaveLength(MAX_AGENT_USAGE_ENTRIES)
    expect(snapshot.capabilities).toEqual(['sessions.list', 'workflows.list'])
    expect(snapshot.generatedAt).toBe(new Date(0).toISOString())
    expect(snapshot.host.label).toBe('Remote host')
    expect(snapshot.workflows[0]).toMatchObject({
      controlHandle: '',
      canPause: false,
      canResume: false,
      canStop: false,
    })
    expect(snapshot.truncated).toEqual({
      sessions: true,
      workflows: true,
      usageEntries: true,
    })
  })

  it('namespaces all cross-host identities before aggregation', () => {
    const snapshot = hostScopeSnapshot('host-a', normalizeAgentSnapshot(rawSnapshot()))
    expect(snapshot.sessions[0].id).toBe('host-a:session-0')
    expect(snapshot.workflows[0]).toMatchObject({
      id: 'host-a:workflow-0',
      sessionId: 'host-a:session-0',
    })
    expect(snapshot.runtime?.roots[0].sessionIds).toEqual(['host-a:session-0'])
    expect(snapshot.usage?.entries[0]).toMatchObject({
      id: 'host-a:usage-0',
      sessionId: 'host-a:session-0',
    })
  })

  it('negotiates compatibility by overlapping protocol ranges', () => {
    expect(protocolCompatible(normalizeAgentHello({
      protocolVersion: 1,
      protocolMin: 1,
      protocolMax: 2,
      host: {},
      capabilities: [],
    }))).toBe(true)
    expect(protocolCompatible(normalizeAgentHello({
      protocolVersion: 2,
      protocolMin: 2,
      protocolMax: 3,
      host: {},
      capabilities: [],
    }))).toBe(false)
  })
})
