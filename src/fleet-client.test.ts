import { describe, expect, it } from 'vitest'
import {
  parseFleetSessionDetail,
  parseFleetSnapshot,
  parseRemoteSessionSnapshot,
} from './api'

function host(overrides: Record<string, unknown> = {}) {
  return {
    id: 'host-1',
    label: 'Studio Mac',
    transport: 'tailscale',
    status: 'healthy',
    statusDetail: 'Fresh telemetry.',
    freshness: 'fresh',
    latencyMs: 12,
    lastSeen: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    consecutiveFailures: 0,
    host: null,
    grokUiVersion: '0.10.0',
    agentVersion: '0.10.0',
    grokVersion: 'test',
    capabilities: [],
    snapshot: null,
    config: {
      id: 'host-1',
      label: 'Studio Mac',
      transport: 'tailscale',
      baseUrl: 'https://studio.example.ts.net:4311',
      sshTarget: '',
      sshPort: 22,
      localPort: 0,
      remotePort: 4311,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasToken: true,
      controlEnabled: false,
      hasControlToken: false,
    },
    ...overrides,
  }
}

function fleet(hosts: unknown[]) {
  return {
    generatedAt: new Date().toISOString(),
    protocolVersion: 1,
    registryError: '',
    pollIntervalMs: 5_000,
    staleAfterMs: 15_000,
    offlineAfterMs: 45_000,
    hosts,
    totals: {
      hosts: hosts.length,
      healthy: hosts.length,
      degraded: 0,
      stale: 0,
      offline: 0,
      sessions: 0,
      workflows: 0,
    },
  }
}

describe('fleet client boundary', () => {
  it('accepts a bounded public fleet snapshot', () => {
    const parsed = parseFleetSnapshot(fleet([host()]))
    expect(parsed.hosts[0].label).toBe('Studio Mac')
    expect(parsed.hosts[0].config.hasToken).toBe(true)
    expect(parsed.registryError).toBe('')
  })

  it('rejects registry payloads above the host cap', () => {
    expect(() => parseFleetSnapshot(fleet(
      Array.from({ length: 33 }, (_, index) => host({ id: `host-${index}` })),
    ))).toThrow(/invalid snapshot/i)
  })

  it('rejects a public config that leaks a host token', () => {
    const exposed = host()
    const exposedRecord = exposed as unknown as { config: Record<string, unknown> }
    exposedRecord.config = { ...exposedRecord.config, token: 'must-not-reach-browser-state' }
    expect(() => parseFleetSnapshot(fleet([exposed]))).toThrow(/public host record/i)
  })

  it('rejects remote collections above negotiated caps', () => {
    expect(() => parseFleetSnapshot(fleet([host({
      snapshot: {
        sessions: Array.from({ length: 201 }, () => ({})),
        workflows: [],
        usage: null,
      },
    })]))).toThrow(/collection caps/i)
  })

  it('accepts bounded read-only session detail and rejects controls or oversized transcripts', () => {
    const detail = {
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      hostId: 'host-1',
      session: { id: 'host-1:session-1' },
      transcript: [{ id: 'event-1', text: 'Observed output' }],
      live: null,
      control: null,
      workflows: [{
        id: 'host-1:workflow-1',
        controlHandle: '',
        canPause: false,
        canResume: false,
        canStop: false,
        phases: [],
        agents: [],
      }],
      managed: false,
    }
    expect(parseFleetSessionDetail(detail).session.id).toBe('host-1:session-1')
    expect(() => parseFleetSessionDetail({
      ...detail,
      workflows: [{ ...detail.workflows[0], canStop: true }],
    })).toThrow(/read-only protocol bounds/i)
    expect(() => parseFleetSessionDetail({
      ...detail,
      transcript: Array.from({ length: 201 }, (_, index) => ({ id: String(index), text: '' })),
    })).toThrow(/invalid bounded detail/i)
  })

  it('accepts bounded remote permissions while rejecting secrets and oversized queues', () => {
    const snapshot = {
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      revision: 'revision-1',
      hostId: 'host-1',
      session: { id: 'host-1:session-1' },
      transcript: [],
      live: null,
      control: null,
      workflows: [],
      permissions: [{
        id: 'host-1:permission-1',
        sessionId: 'host-1:session-1',
        options: [{ id: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      }],
      managed: true,
    }
    expect(parseRemoteSessionSnapshot(snapshot).permissions[0].options[0].id).toBe('allow-once')
    expect(() => parseRemoteSessionSnapshot({
      ...snapshot,
      controlToken: 'must-not-reach-the-browser',
    })).toThrow(/invalid control snapshot/i)
    expect(() => parseRemoteSessionSnapshot({
      ...snapshot,
      permissions: Array.from({ length: 51 }, () => snapshot.permissions[0]),
    })).toThrow(/invalid control snapshot/i)
  })
})
