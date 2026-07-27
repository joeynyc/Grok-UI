import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FleetConnectionError, type FleetConnector } from './fleet-connectors.js'
import {
  FLEET_MAX_CONCURRENCY,
  FleetMonitor,
  MAX_FLEET_SNAPSHOT_BYTES,
} from './fleet-monitor.js'
import { FleetRegistryStore } from './fleet-registry.js'
import type { FleetHostConfig } from './types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })))
})

function usage() {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    period: '30d',
    scope: 'sessions',
    from: '2025-12-01T00:00:00.000Z',
    to: '2026-01-01T00:00:00.000Z',
    groupBy: 'project',
    entries: [],
    totals: {},
    groups: [],
    coverage: {},
  }
}

function hello(protocolMin = 1, protocolMax = 1) {
  return {
    protocolVersion: protocolMin,
    protocolMin,
    protocolMax,
    generatedAt: '2026-01-01T00:00:00.000Z',
    host: { id: 'agent-host', label: 'Agent host', hostname: 'agent', platform: 'linux', arch: 'arm64' },
    grokUiVersion: '0.10.0',
    agentVersion: '0.10.0',
    grokVersion: 'grok-test',
    capabilities: ['sessions.list', 'sessions.detail', 'workflows.list', 'runtime.snapshot', 'usage.report'],
  }
}

function snapshot(degraded = false, large = false, revision = 0) {
  const sessions = Array.from({ length: large ? 200 : 1 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `Remote session ${index + 1}${revision ? ` revision ${revision}` : ''}`,
    summary: large ? 'x'.repeat(4_000) : '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'live',
  }))
  return {
    protocolVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    host: hello().host,
    grokUiVersion: '0.10.0',
    agentVersion: '0.10.0',
    grokVersion: 'grok-test',
    capabilities: hello().capabilities,
    health: { status: degraded ? 'degraded' : 'healthy', detail: degraded ? 'Runtime partial.' : '' },
    sessions,
    workflows: [{
      id: 'workflow-1',
      sessionId: 'session-1',
      controlHandle: 'unsafe',
      status: 'running',
      canPause: true,
      canResume: true,
      canStop: true,
      phases: [],
      agents: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    runtime: null,
    usage: usage(),
    sections: {
      sessions: 'available',
      workflows: 'available',
      runtime: degraded ? 'partial' : 'available',
      usage: 'available',
    },
    truncated: {},
  }
}

type Mode = 'healthy' | 'degraded' | 'offline' | 'unauthorized' | 'incompatible' | 'malformed' | 'slow' | 'large'

class MockConnector implements FleetConnector {
  modes = new Map<string, Mode>()
  active = 0
  maximumActive = 0
  blockedHost = ''
  blocker: Promise<void> | null = null
  snapshotRevision = 0
  rejectedToken = ''
  requests: Array<{ token: string; path: string }> = []

  constructor(private readonly advance?: (milliseconds: number) => void) {}

  async getJson(host: FleetHostConfig, fixedPath: string): Promise<unknown> {
    this.active += 1
    this.maximumActive = Math.max(this.maximumActive, this.active)
    this.requests.push({ token: host.token, path: fixedPath })
    try {
      if (host.id === this.blockedHost && this.blocker) await this.blocker
      await new Promise((resolve) => setTimeout(resolve, 2))
      if (host.token === this.rejectedToken) {
        throw new FleetConnectionError('unauthorized', 'Old token rejected.', 401)
      }
      const mode = this.modes.get(host.id) || 'healthy'
      if (mode === 'offline') throw new FleetConnectionError('offline', 'Disconnected.')
      if (mode === 'unauthorized') throw new FleetConnectionError('unauthorized', 'Token rejected.', 401)
      if (mode === 'malformed') throw new Error('malformed')
      if (mode === 'slow') this.advance?.(1_000)
      if (fixedPath.endsWith('/hello')) return mode === 'incompatible' ? hello(2, 3) : hello()
      if (fixedPath.endsWith('/snapshot')) {
        return snapshot(mode === 'degraded', mode === 'large', this.snapshotRevision)
      }
      if (fixedPath.startsWith('/agent/v1/usage')) return usage()
      throw new Error(`Unexpected path ${fixedPath}`)
    } finally {
      this.active -= 1
    }
  }
}

async function setup(count = 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-monitor-'))
  cleanup.push(directory)
  const registry = new FleetRegistryStore(directory)
  await registry.load()
  const hosts = []
  for (let index = 0; index < count; index += 1) {
    hosts.push(await registry.create({
      label: `Host ${index}`,
      transport: 'direct',
      baseUrl: `http://127.0.0.1:${4311 + index}`,
      token: `token-${index}`,
    }))
  }
  return { registry, hosts }
}

describe('FleetMonitor', () => {
  it('aggregates multiple hosts with scoped IDs, negotiated capabilities, and stripped controls', async () => {
    const { registry, hosts } = await setup(2)
    const connector = new MockConnector()
    connector.modes.set(hosts[1].id, 'degraded')
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      const fleet = monitor.snapshot()
      expect(fleet.hosts.map((host) => host.status).sort()).toEqual(['degraded', 'healthy'])
      expect(fleet.totals).toMatchObject({ hosts: 2, sessions: 2, workflows: 2 })
      expect(fleet.hosts[0].snapshot?.sessions[0].id).toBe(`${fleet.hosts[0].id}:session-1`)
      expect(fleet.hosts[0].snapshot?.workflows[0]).toMatchObject({
        controlHandle: '',
        canPause: false,
        canResume: false,
        canStop: false,
      })
      expect(fleet.hosts[0].config).not.toHaveProperty('token')
    } finally {
      await monitor.stop()
    }
  })

  it('reports unauthorized and incompatible hosts without requesting unsafe data', async () => {
    const { registry, hosts } = await setup(2)
    const connector = new MockConnector()
    connector.modes.set(hosts[0].id, 'unauthorized')
    connector.modes.set(hosts[1].id, 'incompatible')
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      const byId = new Map(monitor.snapshot().hosts.map((host) => [host.id, host]))
      expect(byId.get(hosts[0].id)?.status).toBe('unauthorized')
      expect(byId.get(hosts[1].id)?.status).toBe('incompatible')
      expect(byId.get(hosts[1].id)?.snapshot).toBeNull()
    } finally {
      await monitor.stop()
    }
  })

  it('retains the last good sample across disconnect, stale, offline, and reconnect transitions', async () => {
    let time = 1_000
    const { registry, hosts } = await setup()
    const connector = new MockConnector()
    const monitor = new FleetMonitor(registry, connector, () => time)
    await monitor.start()
    try {
      expect(monitor.snapshot().hosts[0].status).toBe('healthy')
      connector.modes.set(hosts[0].id, 'offline')
      time += 16_000
      await monitor.refresh(hosts[0].id)
      expect(monitor.snapshot().hosts[0]).toMatchObject({
        status: 'stale',
        freshness: 'stale',
      })
      expect(monitor.snapshot().hosts[0].snapshot?.sessions).toHaveLength(1)

      time += 30_000
      await monitor.refresh(hosts[0].id)
      expect(monitor.snapshot().hosts[0]).toMatchObject({
        status: 'offline',
        freshness: 'expired',
      })
      expect(monitor.snapshot().hosts[0].snapshot?.sessions).toHaveLength(1)

      connector.modes.set(hosts[0].id, 'healthy')
      time += 1_000
      await monitor.refresh(hosts[0].id)
      expect(monitor.snapshot().hosts[0]).toMatchObject({
        status: 'healthy',
        freshness: 'fresh',
        consecutiveFailures: 0,
      })
    } finally {
      await monitor.stop()
    }
  })

  it('marks high latency degraded and bounds concurrent host probes', async () => {
    let time = 1_000
    const { registry, hosts } = await setup(6)
    const connector = new MockConnector((milliseconds) => {
      time += milliseconds
    })
    connector.modes.set(hosts[0].id, 'slow')
    const monitor = new FleetMonitor(registry, connector, () => time)
    await monitor.start()
    try {
      const slow = monitor.snapshot().hosts.find((host) => host.id === hosts[0].id)
      expect(slow).toMatchObject({ status: 'degraded', latencyMs: 2_000 })
      expect(connector.maximumActive).toBeLessThanOrEqual(FLEET_MAX_CONCURRENCY)
      connector.maximumActive = 0
      await Promise.all(hosts.map((host) => monitor.refresh(host.id)))
      expect(connector.maximumActive).toBeLessThanOrEqual(FLEET_MAX_CONCURRENCY)
    } finally {
      await monitor.stop()
    }
  })

  it('coalesces an explicit refresh with an in-flight host poll', async () => {
    const { registry, hosts } = await setup()
    const connector = new MockConnector()
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      let release = () => {}
      connector.blockedHost = hosts[0].id
      connector.blocker = new Promise<void>((resolve) => {
        release = resolve
      })
      const background = monitor.refresh(hosts[0].id)
      while (!connector.active) await new Promise((resolve) => setTimeout(resolve, 1))

      let explicitCompleted = false
      const explicit = monitor.refresh(hosts[0].id).then(() => {
        explicitCompleted = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(explicitCompleted).toBe(false)

      release()
      await Promise.all([background, explicit])
      expect(explicitCompleted).toBe(true)
    } finally {
      await monitor.stop()
    }
  })

  it('discards an in-flight result after connection settings change and polls the new config', async () => {
    const { registry, hosts } = await setup()
    const connector = new MockConnector()
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      connector.requests = []
      let release = () => {}
      connector.blockedHost = hosts[0].id
      connector.blocker = new Promise<void>((resolve) => {
        release = resolve
      })
      const background = monitor.refresh(hosts[0].id)
      while (!connector.active) await new Promise((resolve) => setTimeout(resolve, 1))

      await registry.update(hosts[0].id, { token: 'rotated-token' })
      monitor.syncRegistry()
      connector.rejectedToken = hosts[0].token
      const refreshed = monitor.refresh(hosts[0].id)
      release()
      await Promise.all([background, refreshed])

      expect(connector.requests.some((request) => request.token === 'rotated-token')).toBe(true)
      expect(monitor.snapshot().hosts[0]).toMatchObject({
        status: 'healthy',
        consecutiveFailures: 0,
      })
    } finally {
      await monitor.stop()
    }
  })

  it('does not emit unchanged full-fleet SSE snapshots after each poll', async () => {
    const { registry } = await setup()
    const connector = new MockConnector()
    const monitor = new FleetMonitor(registry, connector, () => Date.now(), 10)
    await monitor.start()
    try {
      let events = 0
      monitor.on('fleet', () => {
        events += 1
      })
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(events).toBe(0)
    } finally {
      await monitor.stop()
    }
  })

  it('emits when observed host content changes without a status transition', async () => {
    const { registry, hosts } = await setup()
    const connector = new MockConnector()
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      let events = 0
      monitor.on('fleet', () => {
        events += 1
      })
      connector.snapshotRevision = 2
      await monitor.refresh(hosts[0].id)
      expect(events).toBe(1)
      expect(monitor.snapshot().hosts[0].snapshot?.sessions[0].title)
        .toBe('Remote session 1 revision 2')
    } finally {
      await monitor.stop()
    }
  })

  it('classifies malformed first contact as unavailable', async () => {
    const { registry, hosts } = await setup()
    const connector = new MockConnector()
    connector.modes.set(hosts[0].id, 'malformed')
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      expect(monitor.snapshot().hosts[0]).toMatchObject({
        status: 'unavailable',
        freshness: 'unknown',
      })
    } finally {
      await monitor.stop()
    }
  })

  it('compacts a large multi-host browser aggregate below its global response cap', async () => {
    const { registry, hosts } = await setup(6)
    const connector = new MockConnector()
    hosts.forEach((host) => connector.modes.set(host.id, 'large'))
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      const fleet = monitor.snapshot()
      expect(Buffer.byteLength(JSON.stringify(fleet))).toBeLessThanOrEqual(
        MAX_FLEET_SNAPSHOT_BYTES,
      )
      expect(fleet.hosts.some((host) => host.status === 'degraded')).toBe(true)
      expect(fleet.hosts.some((host) => host.snapshot?.sections.sessions === 'partial')).toBe(true)
    } finally {
      await monitor.stop()
    }
  })
})
