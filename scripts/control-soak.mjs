import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GrokController } from '../dist-server/grok-controller.js'
import { RuntimeInspector } from '../dist-server/runtime-inspector.js'
import { SessionStateStore } from '../dist-server/session-state.js'
import { UsageLedger } from '../dist-server/usage-ledger.js'
import { FleetRegistryStore } from '../dist-server/fleet-registry.js'
import { FleetMonitor } from '../dist-server/fleet-monitor.js'
import { FleetConnectionError } from '../dist-server/fleet-connectors.js'
import { LocalHostAgentProvider, startHostAgent } from '../dist-server/host-agent.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fakeGrok = path.join(projectRoot, 'scripts', 'fake-grok-e2e.mjs')
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-soak-'))
const previousGrokBin = process.env.GROK_BIN
const state = new SessionStateStore(path.join(workspace, 'state'))
await state.load()
const grokHome = path.join(workspace, 'grok-home')
await fs.mkdir(grokHome)
const controller = new GrokController(state)
await controller.restore()
const runtime = new RuntimeInspector()
const usage = new UsageLedger(state)
const agentToken = 'soak-host-agent-token'
const agent = await startHostAgent({
  host: '127.0.0.1',
  port: 0,
  token: agentToken,
  provider: new LocalHostAgentProvider(path.join(workspace, 'state'), grokHome),
})
const registry = new FleetRegistryStore(path.join(workspace, 'fleet-state'))
await registry.load()
const fleetHost = await registry.create({
  label: 'Soak host',
  transport: 'direct',
  baseUrl: agent.url.replace('localhost', '127.0.0.1'),
  token: agentToken,
})
const fleet = new FleetMonitor(registry)
await fleet.start()
const mockRegistry = new FleetRegistryStore(path.join(workspace, 'mock-fleet-state'))
await mockRegistry.load()
const mockHosts = []
for (let index = 0; index < 8; index += 1) {
  mockHosts.push(await mockRegistry.create({
    label: `Mock soak host ${index + 1}`,
    transport: 'direct',
    baseUrl: `http://127.0.0.1:${44_000 + index}`,
    token: `mock-soak-token-${index + 1}`,
  }))
}

function mockUsage() {
  const now = new Date().toISOString()
  return {
    generatedAt: now,
    period: '30d',
    scope: 'sessions',
    from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    to: now,
    groupBy: 'project',
    entries: [],
    totals: {},
    groups: [],
    coverage: {},
  }
}

function mockHello(host) {
  return {
    protocolVersion: 1,
    protocolMin: 1,
    protocolMax: 1,
    generatedAt: new Date().toISOString(),
    host: {
      id: `agent-${host.id}`,
      label: host.label,
      hostname: `${host.id}.soak.test`,
      platform: 'linux',
      arch: 'arm64',
    },
    grokUiVersion: '0.10.0-soak',
    agentVersion: '0.10.0-soak',
    grokVersion: 'grok-soak',
    capabilities: [
      'sessions.list',
      'sessions.detail',
      'workflows.list',
      'runtime.snapshot',
      'usage.report',
    ],
  }
}

function mockSnapshot(host) {
  const greeting = mockHello(host)
  return {
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    host: greeting.host,
    grokUiVersion: greeting.grokUiVersion,
    agentVersion: greeting.agentVersion,
    grokVersion: greeting.grokVersion,
    capabilities: greeting.capabilities,
    health: { status: 'healthy', detail: '' },
    sessions: [{
      id: 'session-1',
      title: `${host.label} observation`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'live',
    }],
    workflows: [],
    runtime: null,
    usage: mockUsage(),
    sections: {
      sessions: 'available',
      workflows: 'available',
      runtime: 'available',
      usage: 'available',
    },
    truncated: {},
  }
}

class MockSoakConnector {
  modes = new Map()
  active = 0
  maximumActive = 0
  calls = 0

  async getJson(host, fixedPath) {
    this.calls += 1
    this.active += 1
    this.maximumActive = Math.max(this.maximumActive, this.active)
    try {
      await delay(35)
      if (this.modes.get(host.id) === 'offline') {
        throw new FleetConnectionError('offline', 'Simulated soak disconnect.')
      }
      if (fixedPath.endsWith('/hello')) return mockHello(host)
      if (fixedPath.endsWith('/snapshot')) return mockSnapshot(host)
      throw new Error(`Unexpected mock fleet path: ${fixedPath}`)
    } finally {
      this.active -= 1
    }
  }
}

const mockConnector = new MockSoakConnector()
const recoveringHost = mockHosts[0]
const observedRecoveryStates = new Set()
let mockFleetEvents = 0
const mockFleet = new FleetMonitor(mockRegistry, mockConnector, () => Date.now(), 1_000)
mockFleet.on('fleet', (snapshot) => {
  mockFleetEvents += 1
  const host = snapshot.hosts.find((item) => item.id === recoveringHost.id)
  if (host) observedRecoveryStates.add(host.status)
})
await mockFleet.start()
let disconnectTimer
let reconnectTimer

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for soak state.')
    await delay(25)
  }
}

try {
  process.env.GROK_BIN = fakeGrok
  const session = await controller.createSession({
    cwd: workspace,
    prompt: 'Run the long-running cancellation verification',
  })
  await waitFor(() => controller.snapshot().sessions.find((item) => item.id === session.id)
    ?.feed.some((item) => item.title === 'Long-running cancellation fixture'))
  const usageBefore = state.usageEntries().length
  await usage.sync({ sessions: [], live: [], managed: controller.snapshot().sessions })
  const usageAfter = state.usageEntries().length
  if (usageAfter <= usageBefore) throw new Error('Usage ledger did not grow during the soak.')

  runtime.update({ generatedAt: new Date().toISOString(), agents: [] }, controller.snapshot())
  await runtime.refresh()
  const initialRuntime = runtime.snapshot()
  const managedRoot = initialRuntime.roots.find((root) => root.managed)
  if (!managedRoot
    || !initialRuntime.processes.some((process) => process.rootPid === managedRoot.pid)) {
    throw new Error(`Runtime inspector did not retain the managed process root: ${JSON.stringify(initialRuntime)}`)
  }

  const startedAt = Date.now()
  const firstFleetSeen = fleet.snapshot().hosts.find((host) => host.id === fleetHost.id)?.lastSeen
  disconnectTimer = setTimeout(() => {
    mockConnector.modes.set(recoveringHost.id, 'offline')
    void mockFleet.refresh(recoveringHost.id)
  }, 5_000)
  reconnectTimer = setTimeout(() => {
    mockConnector.modes.delete(recoveringHost.id)
    void mockFleet.refresh(recoveringHost.id)
  }, 28_000)
  await delay(75_000)
  const snapshot = controller.snapshot()
  const active = snapshot.sessions.find((item) => item.id === session.id)
  if (!snapshot.connected || active?.state !== 'working' || snapshot.error) {
    throw new Error(`Managed session did not survive the soak: ${JSON.stringify({
      connected: snapshot.connected,
      state: active?.state,
      error: snapshot.error,
    })}`)
  }
  await usage.sync({ sessions: [], live: [], managed: snapshot.sessions })
  runtime.update({ generatedAt: new Date().toISOString(), agents: [] }, snapshot)
  await runtime.refresh()
  const refreshedRuntime = runtime.snapshot()
  const refreshedRoot = refreshedRuntime.roots.find((root) => root.managed)
  if (!refreshedRoot
    || !refreshedRuntime.processes.some((process) => process.rootPid === refreshedRoot.pid)) {
    throw new Error('Runtime process root disappeared during the soak.')
  }
  const soakedHost = fleet.snapshot().hosts.find((host) => host.id === fleetHost.id)
  if (
    !soakedHost
    || !['healthy', 'degraded'].includes(soakedHost.status)
    || !soakedHost.lastSeen
    || soakedHost.lastSeen === firstFleetSeen
  ) {
    throw new Error(`Fleet observer did not remain fresh during the soak: ${JSON.stringify(soakedHost)}`)
  }
  const mockSnapshotAfterSoak = mockFleet.snapshot()
  const recoveredHost = mockSnapshotAfterSoak.hosts.find((host) => host.id === recoveringHost.id)
  if (mockSnapshotAfterSoak.hosts.length !== mockHosts.length) {
    throw new Error(`Mock fleet host count grew during the soak: ${mockSnapshotAfterSoak.hosts.length}`)
  }
  if (mockConnector.maximumActive > 4) {
    throw new Error(`Mock fleet exceeded its concurrency cap: ${mockConnector.maximumActive}`)
  }
  if (mockConnector.calls > 2_000 || mockFleetEvents > 2_000) {
    throw new Error(`Mock fleet observation grew without a bound: ${JSON.stringify({
      calls: mockConnector.calls,
      events: mockFleetEvents,
    })}`)
  }
  if (
    !observedRecoveryStates.has('stale')
    || !recoveredHost
    || !['healthy', 'degraded'].includes(recoveredHost.status)
    || recoveredHost.consecutiveFailures !== 0
  ) {
    throw new Error(`Mock fleet did not disconnect and recover cleanly: ${JSON.stringify({
      observed: [...observedRecoveryStates],
      recoveredHost,
    })}`)
  }

  await controller.cancelSession(session.id)
  await waitFor(() => controller.snapshot().sessions.find((item) => item.id === session.id)
    ?.cancellationStatus === 'confirmed')

  console.log('\nGROK UI / CONTROL SOAK\n')
  console.log(`✓ Sustained session   ${Math.round((Date.now() - startedAt) / 1_000)} seconds`)
  console.log('✓ ACP channel         remained connected')
  console.log('✓ Managed turn        remained working')
  console.log('✓ Usage ledger        persisted managed observations')
  console.log('✓ Runtime discovery   retained the managed process root')
  console.log('✓ Fleet observer      remained fresh and read-only')
  console.log(`✓ Multi-host fleet    ${mockHosts.length} hosts stayed bounded at ${mockConnector.maximumActive} concurrent requests`)
  console.log('✓ Fleet reconnect     observed stale state and recovered without registry growth')
  console.log('✓ Interruption        confirmed after soak')
} finally {
  if (disconnectTimer) clearTimeout(disconnectTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  await mockFleet.stop()
  await fleet.stop()
  await agent.close()
  await runtime.stop()
  await controller.stop()
  if (previousGrokBin === undefined) delete process.env.GROK_BIN
  else process.env.GROK_BIN = previousGrokBin
  await fs.rm(workspace, { recursive: true, force: true })
}
