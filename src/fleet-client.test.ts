import { describe, expect, it } from 'vitest'
import { parseFleetSnapshot } from './api'

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
    },
    ...overrides,
  }
}

function fleet(hosts: unknown[]) {
  return {
    generatedAt: new Date().toISOString(),
    protocolVersion: 1,
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
})
