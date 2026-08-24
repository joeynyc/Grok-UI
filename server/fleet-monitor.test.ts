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
  controlEnabled = false
  controlRequests: Array<{ token: string; path: string; body?: unknown }> = []
  controlReceiptOverride: Record<string, unknown> | null = null

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
      if (fixedPath.endsWith('/hello')) {
        const value = mode === 'incompatible' ? hello(2, 3) : hello()
        return this.controlEnabled ? {
          ...value,
          capabilities: [
            ...value.capabilities,
            'remote.sessions',
            'remote.sessions.create',
            'remote.sessions.prompt',
            'remote.sessions.interrupt',
            'remote.permissions.resolve',
          ],
        } : value
      }
      if (fixedPath.endsWith('/snapshot')) {
        const value = snapshot(mode === 'degraded', mode === 'large', this.snapshotRevision)
        return this.controlEnabled ? {
          ...value,
          capabilities: [...value.capabilities, 'remote.sessions'],
        } : value
      }
      if (fixedPath.startsWith('/agent/v1/usage')) return usage()
      throw new Error(`Unexpected path ${fixedPath}`)
    } finally {
      this.active -= 1
    }
  }

  async getControlJson(host: FleetHostConfig, fixedPath: string): Promise<unknown> {
    this.controlRequests.push({ token: host.controlToken, path: fixedPath })
    return {
      protocolVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      revision: 'remote-revision-1',
      hostId: 'agent-host',
      session: snapshot().sessions[0],
      transcript: [{ id: 'event-1', type: 'assistant', text: 'Remote reply' }],
      live: null,
      control: null,
      workflows: [],
      permissions: [],
      managed: true,
    }
  }

  async postControlJson(
    host: FleetHostConfig,
    fixedPath: string,
    body: unknown,
  ): Promise<unknown> {
    this.controlRequests.push({ token: host.controlToken, path: fixedPath, body })
    return {
      commandId: (body as { commandId: string }).commandId,
      kind: 'session.prompt',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'session-1',
      error: '',
      ...this.controlReceiptOverride,
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

  it('allows only fresh, healthy, explicitly authorized remote session commands', async () => {
    let time = 1_000
    const { registry, hosts } = await setup()
    await registry.update(hosts[0].id, {
      controlToken: 'control-token',
      controlEnabled: true,
    })
    const connector = new MockConnector()
    connector.controlEnabled = true
    const monitor = new FleetMonitor(registry, connector, () => time)
    await monitor.start()
    try {
      const session = await monitor.remoteSession(hosts[0].id, `${hosts[0].id}:session-1`)
      expect(session).toMatchObject({
        hostId: hosts[0].id,
        session: { id: `${hosts[0].id}:session-1` },
        transcript: [{ id: 'event-1', text: 'Remote reply' }],
      })
      const receipt = await monitor.promptRemoteSession(
        hosts[0].id,
        `${hosts[0].id}:session-1`,
        { commandId: 'prompt-1', expiresAt: '2026-01-01T00:10:00.000Z', prompt: 'Continue' },
      )
      expect(receipt).toMatchObject({
        commandId: 'prompt-1',
        sessionId: `${hosts[0].id}:session-1`,
        status: 'completed',
      })
      expect(connector.controlRequests).toContainEqual({
        token: 'control-token',
        path: `/agent/control/v1/sessions/session-1/prompt`,
        body: { commandId: 'prompt-1', expiresAt: '2026-01-01T00:10:00.000Z', prompt: 'Continue' },
      })

      time += 16_000
      await expect(monitor.promptRemoteSession(
        hosts[0].id,
        `${hosts[0].id}:session-1`,
        { commandId: 'stale-prompt', expiresAt: '2026-01-01T00:10:00.000Z', prompt: 'Do not send' },
      )).rejects.toThrow(/fresh, healthy/i)
    } finally {
      await monitor.stop()
    }
  })

  it('rejects unscoped and cross-host resource substitution before transport', async () => {
    const { registry, hosts } = await setup(2)
    for (const host of hosts) {
      await registry.update(host.id, {
        controlToken: `control-${host.id}`,
        controlEnabled: true,
      })
    }
    const connector = new MockConnector()
    connector.controlEnabled = true
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      const expiresAt = new Date(Date.now() + 60_000).toISOString()
      connector.controlRequests = []
      await expect(monitor.promptRemoteSession(
        hosts[0].id,
        `${hosts[1].id}:session-1`,
        { commandId: 'cross-host-prompt', expiresAt, prompt: 'Do not send' },
      )).rejects.toThrow(/does not belong/i)
      await expect(monitor.interruptRemoteSession(
        hosts[0].id,
        'session-1',
        { commandId: 'unscoped-interrupt', expiresAt },
      )).rejects.toThrow(/does not belong/i)
      await expect(monitor.resolveRemotePermission(
        hosts[0].id,
        `${hosts[0].id}:session-1`,
        `${hosts[1].id}:permission-1`,
        { commandId: 'cross-host-permission', expiresAt, optionId: 'allow-once' },
      )).rejects.toThrow(/does not belong/i)
      expect(connector.controlRequests).toEqual([])
    } finally {
      await monitor.stop()
    }
  })

  it('rejects receipts substituted by a remote host for another command or session', async () => {
    const { registry, hosts } = await setup()
    await registry.update(hosts[0].id, {
      controlToken: 'control-token',
      controlEnabled: true,
    })
    const connector = new MockConnector()
    connector.controlEnabled = true
    const monitor = new FleetMonitor(registry, connector)
    await monitor.start()
    try {
      const expiresAt = new Date(Date.now() + 60_000).toISOString()
      const sessionId = `${hosts[0].id}:session-1`
      for (const receiptOverride of [
        { commandId: 'different-command' },
        { kind: 'session.interrupt' },
        { sessionId: 'session-2' },
        { status: 'invented-status' },
        { sessionId: '../other-host' },
      ]) {
        connector.controlReceiptOverride = receiptOverride
        await expect(monitor.promptRemoteSession(
          hosts[0].id,
          sessionId,
          {
            commandId: `receipt-test-${connector.controlRequests.length}`,
            expiresAt,
            prompt: 'Do not trust a substituted receipt',
          },
        )).rejects.toThrow(/invalid command receipt|different request/i)
      }
    } finally {
      await monitor.stop()
    }
  })
})
