import { describe, expect, it } from 'vitest'
import type { FleetHostView } from './types'
import { isHistoricalHost, sectionAvailability } from './views/fleet/model'

function host(status: FleetHostView['status'], withSnapshot: boolean): FleetHostView {
  return {
    id: 'host-1',
    label: 'Host',
    transport: 'direct',
    status,
    statusDetail: '',
    freshness: withSnapshot ? 'fresh' : 'unknown',
    latencyMs: null,
    lastSeen: withSnapshot ? new Date().toISOString() : '',
    lastAttemptAt: '',
    consecutiveFailures: 0,
    host: null,
    grokUiVersion: '',
    agentVersion: '',
    grokVersion: '',
    capabilities: [],
    snapshot: withSnapshot
      ? {
          protocolVersion: 1,
          generatedAt: new Date().toISOString(),
          host: { id: 'remote', label: 'Remote', hostname: 'remote', platform: 'test', arch: 'test' },
          grokUiVersion: '0.10.0',
          agentVersion: '0.10.0',
          grokVersion: '',
          capabilities: [],
          managedSessionIds: [],
          health: { status: 'healthy', detail: '' },
          sessions: [],
          workflows: [],
          runtime: null,
          usage: null,
          sections: {
            sessions: 'available',
            workflows: 'available',
            runtime: 'available',
            usage: 'available',
          },
          truncated: { sessions: false, workflows: false, usageEntries: false },
        }
      : null,
    config: {
      id: 'host-1',
      label: 'Host',
      transport: 'direct',
      baseUrl: 'http://127.0.0.1:4311',
      sshTarget: '',
      sshPort: 22,
      localPort: 0,
      remotePort: 4311,
      enabled: status !== 'unavailable',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasToken: true,
    },
  }
}

describe('fleet section availability', () => {
  it('labels cached snapshots as historical while connecting or unavailable', () => {
    expect(sectionAvailability(host('connecting', true), 'sessions')).toBe('stale')
    expect(sectionAvailability(host('unavailable', true), 'sessions')).toBe('stale')
    expect(sectionAvailability(host('incompatible', true), 'sessions')).toBe('stale')
    expect(sectionAvailability(host('unauthorized', true), 'sessions')).toBe('stale')
  })

  it('keeps first-contact connecting distinct from unavailable data', () => {
    expect(sectionAvailability(host('connecting', false), 'sessions')).toBe('connecting')
    expect(sectionAvailability(host('unavailable', false), 'sessions')).toBe('unavailable')
    expect(sectionAvailability(host('incompatible', false), 'sessions')).toBe('incompatible')
    expect(sectionAvailability(host('unauthorized', false), 'sessions')).toBe('unauthorized')
  })

  it('marks incompatible and disabled prior observations as historical', () => {
    expect(isHistoricalHost(host('incompatible', true))).toBe(true)
    expect(isHistoricalHost(host('unavailable', true))).toBe(true)
    expect(isHistoricalHost(host('healthy', true))).toBe(false)
  })

  it('labels a retained sample historical after a recent degraded failure', () => {
    const failed = host('degraded', true)
    failed.consecutiveFailures = 1
    expect(sectionAvailability(failed, 'sessions')).toBe('stale')
    expect(isHistoricalHost(failed)).toBe(true)
  })
})
