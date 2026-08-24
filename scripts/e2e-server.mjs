import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(os.tmpdir(), 'grok-ui-e2e')
const grokHome = path.join(fixtureRoot, 'grok-home')
const stateDirectory = path.join(fixtureRoot, 'ui-state')
const workspace = path.join(fixtureRoot, 'secret-client')
const fleetControlFile = path.join(fixtureRoot, 'fleet-control.json')

await fs.rm(fixtureRoot, { recursive: true, force: true })
await Promise.all([
  fs.mkdir(grokHome, { recursive: true }),
  fs.mkdir(stateDirectory, { recursive: true }),
  fs.mkdir(workspace, { recursive: true }),
])
await fs.writeFile(fleetControlFile, JSON.stringify({ healthy: 'online' }))

const { startHostAgent } = await import('../dist-server/host-agent.js')

function timestamp() {
  return new Date().toISOString()
}

function metric(value, source = value === null ? 'unavailable' : 'grok-reported') {
  return { value, source }
}

function usage() {
  const now = timestamp()
  const group = {
    key: '/remote/secret-phoenix',
    label: 'secret-phoenix',
    entries: 1,
    sessions: 1,
    inputTokens: metric(700),
    outputTokens: metric(534),
    totalTokens: metric(1_234),
    costs: [{ ...metric(0.42), currency: 'USD' }],
    updatedAt: now,
  }
  return {
    generatedAt: now,
    period: '30d',
    scope: 'sessions',
    from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    to: now,
    groupBy: 'project',
    entries: [{
      id: 'remote-usage-1',
      kind: 'cli-session',
      sessionId: 'remote-session-1',
      sessionTitle: 'Remote Confidential Phoenix',
      workflowId: '',
      project: 'secret-phoenix',
      cwd: '/remote/secret-phoenix',
      model: 'grok-fleet-e2e',
      agent: 'Grok CLI',
      startedAt: now,
      updatedAt: now,
      inputTokens: metric(700),
      outputTokens: metric(534),
      totalTokens: metric(1_234),
      cost: { ...metric(0.42), currency: 'USD' },
    }],
    totals: { ...group, key: 'all', label: 'All usage' },
    groups: [group],
    coverage: { 'grok-reported': 4, derived: 0, incomplete: 0, unavailable: 0 },
  }
}

function session() {
  const now = timestamp()
  return {
    id: 'remote-session-1',
    title: 'Remote Confidential Phoenix',
    summary: 'Fleet work for Example Operator at 100.64.0.9',
    cwd: '/remote/secret-phoenix',
    workspace: 'secret-phoenix',
    createdAt: now,
    updatedAt: now,
    model: 'grok-fleet-e2e',
    agent: 'Grok CLI',
    reasoningEffort: 'high',
    sandboxProfile: 'remote-observer',
    messages: 3,
    chatMessages: 2,
    turns: 2,
    toolCalls: 1,
    errors: 0,
    filesTouched: 2,
    linesAdded: 8,
    linesRemoved: 1,
    durationSeconds: 42,
    contextUsage: 0.22,
    status: 'live',
    diskBytes: 512,
    archived: false,
  }
}

function workflow() {
  const now = timestamp()
  return {
    id: 'remote-workflow-1',
    controlHandle: 'must-never-reach-browser',
    displayName: 'Remote Fleet Workflow',
    sessionId: 'remote-session-1',
    objective: 'Coordinate the confidential Phoenix verification.',
    foreground: false,
    status: 'running',
    phases: [
      { id: 'observe', label: 'Observe fleet', status: 'in_progress' },
      { id: 'report', label: 'Report result', status: 'pending' },
    ],
    currentPhase: 'observe',
    agentBudget: 4,
    agentsUsed: 2,
    agentsReserved: 0,
    agentsRemaining: 2,
    usageIncomplete: false,
    activeAgents: 1,
    currentAgentLabel: 'Remote Verifier',
    agents: [{
      id: 'remote-agent-1',
      label: 'Remote Verifier',
      status: 'running',
      detail: 'Reading bounded state',
      phase: 'observe',
      model: 'grok-fleet-e2e',
      tokensUsed: 1_234,
      durationMs: 42_000,
      tokenTelemetryAvailable: true,
    }],
    totalTokens: 1_234,
    tokenTelemetryAvailable: true,
    elapsedMs: 42_000,
    lastEvent: 'workflow_progress',
    lastEventDetail: 'Bounded remote observation is active.',
    lastEventAt: now,
    pauseMessage: '',
    resultSummary: '',
    updatedAt: now,
    canPause: true,
    canResume: true,
    canStop: true,
  }
}

function runtime(partial = false) {
  const now = timestamp()
  return {
    generatedAt: now,
    available: true,
    partial,
    error: partial ? 'One observer adapter is unavailable.' : '',
    roots: [{
      pid: 4242,
      managed: false,
      sessionIds: ['remote-session-1'],
      workspaces: ['/remote/secret-phoenix'],
    }],
    processes: [{
      pid: 4242,
      parentPid: 1,
      rootPid: 4242,
      depth: 0,
      name: 'secret-remote-dev-server',
      state: 'running',
      elapsed: '42s',
      sessionIds: ['remote-session-1'],
      workspaces: ['/remote/secret-phoenix'],
      ports: [5173],
    }],
    ports: [{ pid: 4242, port: 5173, protocol: 'tcp', bind: 'loopback' }],
    services: [{
      id: 'service-4242-5173',
      pid: 4242,
      name: 'Phoenix dev server',
      kind: 'dev-server',
      port: 5173,
      bind: 'loopback',
      status: 'listening',
    }],
    tests: [{
      id: 'remote-test-1',
      sessionId: 'remote-session-1',
      title: 'Remote Fleet Vitest',
      framework: 'Vitest',
      status: 'passed',
      startedAt: now,
      updatedAt: now,
      incomplete: false,
    }],
    externalCalls: [],
  }
}

async function healthyMode() {
  try {
    const control = JSON.parse(await fs.readFile(fleetControlFile, 'utf8'))
    return control.healthy === 'offline' ? 'offline' : 'online'
  } catch {
    return 'online'
  }
}

function provider({ id, label, degraded = false, incompatible = false, controlled = false }) {
  const capabilities = [
    'sessions.list',
    'sessions.detail',
    'workflows.list',
    'runtime.snapshot',
    'usage.report',
    ...(controlled ? [
      'remote.sessions',
      'remote.sessions.create',
      'remote.sessions.prompt',
      'remote.sessions.interrupt',
      'remote.permissions.resolve',
    ] : []),
  ]
  const remoteTranscript = [{
    id: 'remote-transcript-1',
    type: 'assistant',
    title: 'Remote response',
    text: 'Remote transcript for Example Operator at 100.64.0.9',
    status: 'completed',
    timestamp: timestamp(),
  }]
  let remoteState = 'idle'
  let remoteUpdatedAt = timestamp()
  let remotePermissions = controlled ? [{
    id: 'remote-permission-1',
    sessionId: 'remote-session-1',
    title: 'Allow the remote verification tool?',
    toolKind: 'execute',
    toolCallId: 'remote-tool-1',
    createdAt: timestamp(),
    options: [{ id: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  }] : []
  async function online() {
    if (controlled && await healthyMode() === 'offline') {
      throw new Error('Simulated host disconnect.')
    }
  }
  async function hello() {
    await online()
    const version = incompatible ? 9 : 1
    return {
      protocolVersion: version,
      protocolMin: version,
      protocolMax: version,
      generatedAt: timestamp(),
      host: { id, label, hostname: `${id}.test`, platform: 'linux', arch: 'arm64' },
      grokUiVersion: '0.10.0-e2e',
      agentVersion: '0.10.0-e2e',
      grokVersion: 'grok-fleet-e2e',
      capabilities,
    }
  }
  return {
    hello,
    async snapshot() {
      await online()
      return {
        ...(await hello()),
        protocolVersion: incompatible ? 9 : 1,
        managedSessionIds: controlled ? ['remote-session-1'] : [],
        health: {
          status: degraded ? 'degraded' : 'healthy',
          detail: degraded ? 'Runtime observer is partial.' : '',
        },
        sessions: [session()],
        workflows: [workflow()],
        runtime: runtime(degraded),
        usage: usage(),
        sections: {
          sessions: 'available',
          workflows: 'available',
          runtime: degraded ? 'partial' : 'available',
          usage: 'available',
        },
        truncated: { sessions: false, workflows: false, usageEntries: false },
      }
    },
    async session() {
      await online()
      const current = session()
      return {
        protocolVersion: 1,
        generatedAt: timestamp(),
        hostId: id,
        session: current,
        transcript: remoteTranscript,
        live: null,
        control: null,
        workflows: [workflow()],
        managed: false,
      }
    },
    async usage() {
      await online()
      return usage()
    },
    async remoteSession() {
      await online()
      const detail = await this.session()
      return {
        ...detail,
        revision: `${remoteUpdatedAt}:${remoteTranscript.length}:${remotePermissions.length}:${remoteState}`,
        control: {
          id: 'remote-session-1',
          cwd: '/remote/secret-phoenix',
          title: 'Remote Confidential Phoenix',
          model: 'grok-fleet-e2e',
          state: remoteState,
          createdAt: remoteUpdatedAt,
          updatedAt: remoteUpdatedAt,
          lastPrompt: '',
          stopReason: remoteState === 'cancelled' ? 'cancelled' : '',
          error: '',
          cancellationStatus: remoteState === 'cancelled' ? 'confirmed' : 'none',
          cancelRequestedAt: '',
          cancelledAt: remoteState === 'cancelled' ? remoteUpdatedAt : '',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          tokenTelemetryAvailable: false,
          costAmount: 0,
          costCurrency: '',
          costTelemetryAvailable: false,
          feed: [],
        },
        permissions: remotePermissions,
        managed: true,
      }
    },
    async promptRemoteSession(_sessionId, prompt) {
      remoteState = 'working'
      remoteUpdatedAt = timestamp()
      remoteTranscript.push({
        id: `remote-user-${remoteTranscript.length}`,
        type: 'user',
        title: 'Remote follow-up',
        text: prompt,
        status: 'completed',
        timestamp: remoteUpdatedAt,
      }, {
        id: `remote-assistant-${remoteTranscript.length + 1}`,
        type: 'assistant',
        title: 'Grok',
        text: `Remote host accepted: ${prompt}`,
        status: 'streaming',
        timestamp: remoteUpdatedAt,
      })
    },
    async interruptRemoteSession() {
      remoteState = 'cancelled'
      remoteUpdatedAt = timestamp()
    },
    async resolveRemotePermission(_sessionId, permissionId, optionId) {
      if (permissionId !== 'remote-permission-1' || optionId !== 'allow-once') {
        throw new Error('Unexpected remote permission decision.')
      }
      remotePermissions = []
      remoteUpdatedAt = timestamp()
    },
    async createRemoteSession() {
      return 'remote-session-1'
    },
  }
}

const healthyAgent = await startHostAgent({
  host: '127.0.0.1',
  port: 0,
  token: 'healthy-agent-token',
  controlToken: 'healthy-control-token',
  stateDirectory: path.join(fixtureRoot, 'healthy-agent-state'),
  provider: provider({
    id: 'healthy-agent',
    label: 'Healthy Secret Workstation',
    controlled: true,
  }),
})
const degradedAgent = await startHostAgent({
  host: '127.0.0.1',
  port: 0,
  token: 'degraded-agent-token',
  provider: provider({
    id: 'degraded-agent',
    label: 'Degraded Build Host',
    degraded: true,
  }),
})
const incompatibleAgent = await startHostAgent({
  host: '127.0.0.1',
  port: 0,
  token: 'incompatible-agent-token',
  provider: provider({
    id: 'incompatible-agent',
    label: 'Future Protocol Host',
    incompatible: true,
  }),
})

await fs.writeFile(path.join(fixtureRoot, 'fixture.json'), JSON.stringify({
  fixtureRoot,
  grokHome,
  stateDirectory,
  workspace,
  fleetControlFile,
  fleetHosts: {
    healthy: {
      url: healthyAgent.url,
      token: 'healthy-agent-token',
      controlToken: 'healthy-control-token',
    },
    degraded: { url: degradedAgent.url, token: 'degraded-agent-token' },
    incompatible: { url: incompatibleAgent.url, token: 'incompatible-agent-token' },
    unauthorized: { url: healthyAgent.url, token: 'intentionally-wrong-token' },
  },
}))

process.env.PORT = '4399'
process.env.HOST = '127.0.0.1'
process.env.GROK_HOME = grokHome
process.env.GROK_UI_STATE_DIR = stateDirectory
process.env.GROK_BIN = path.join(projectRoot, 'scripts', 'fake-grok-e2e.mjs')
process.env.GROK_UI_E2E = '1'

await import('../dist-server/index.js')
