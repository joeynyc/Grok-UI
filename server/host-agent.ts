import crypto from 'node:crypto'
import express from 'express'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { APP_VERSION } from './app-version.js'
import {
  FLEET_PROTOCOL_MAX,
  FLEET_PROTOCOL_MIN,
  FLEET_PROTOCOL_VERSION,
  MAX_AGENT_BODY_BYTES,
  MAX_AGENT_SESSIONS,
  MAX_AGENT_TRANSCRIPT_ITEMS,
  MAX_AGENT_USAGE_ENTRIES,
  MAX_AGENT_WORKFLOWS,
  normalizeAgentHello,
  normalizeAgentSessionDetail,
  normalizeAgentSnapshot,
  normalizeSession,
  normalizeUsageReport,
  stripRemoteWorkflow,
} from './fleet-protocol.js'
import { GrokStore } from './grok-store.js'
import { LiveMonitor } from './live-monitor.js'
import { RuntimeInspector } from './runtime-inspector.js'
import { SessionReader, mergeSessionFeed } from './session-reader.js'
import { SessionStateStore } from './session-state.js'
import type {
  AgentCapability,
  AgentHello,
  AgentHostIdentity,
  AgentSessionDetail,
  AgentSnapshot,
  ControlSnapshot,
  UsageGroupDimension,
  UsagePeriod,
  UsageReport,
  UsageScope,
} from './types.js'
import {
  UsageLedger,
  USAGE_GROUPS,
  USAGE_PERIODS,
  USAGE_SCOPES,
} from './usage-ledger.js'
import { controlSessionRow, liveAgentRow } from './session-projection.js'

const CAPABILITIES: AgentCapability[] = [
  'sessions.list',
  'sessions.detail',
  'workflows.list',
  'runtime.snapshot',
  'usage.report',
]
const SESSION_ID = /^[a-zA-Z0-9._:-]{1,160}$/

function emptyControl(): ControlSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    connected: false,
    processId: 0,
    starting: false,
    reconnecting: false,
    reconnectAttempt: 0,
    lastDisconnectedAt: '',
    agentName: '',
    agentVersion: '',
    error: '',
    sessions: [],
    workflows: [],
    permissions: [],
  }
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function boundedUsage(report: UsageReport): UsageReport {
  const bounded: UsageReport = {
    ...report,
    entries: report.entries.slice(0, MAX_AGENT_USAGE_ENTRIES),
    groups: report.groups.slice(0, 200),
  }
  while (bounded.entries.length && jsonBytes(bounded) > MAX_AGENT_BODY_BYTES - 16_384) {
    bounded.entries.pop()
  }
  while (bounded.groups.length && jsonBytes(bounded) > MAX_AGENT_BODY_BYTES - 16_384) {
    bounded.groups.pop()
  }
  return bounded
}

function boundedSnapshot(input: AgentSnapshot): AgentSnapshot {
  const snapshot: AgentSnapshot = {
    ...input,
    sessions: input.sessions.map((session) => ({ ...session })),
    workflows: input.workflows.map((workflow) => ({
      ...workflow,
      phases: workflow.phases.slice(0, 40),
      agents: workflow.agents.slice(0, 128),
    })),
    usage: input.usage ? boundedUsage(input.usage) : null,
    truncated: { ...input.truncated },
  }
  if (input.workflows.some((workflow) => workflow.agents.length > 128 || workflow.phases.length > 40)) {
    snapshot.truncated.workflows = true
    snapshot.sections.workflows = 'partial'
  }
  if (jsonBytes(snapshot) > MAX_AGENT_BODY_BYTES - 16_384) {
    snapshot.sessions = snapshot.sessions.map((session) => ({ ...session, summary: '' }))
  }
  while (snapshot.workflows.length && jsonBytes(snapshot) > MAX_AGENT_BODY_BYTES - 16_384) {
    snapshot.workflows.pop()
    snapshot.truncated.workflows = true
    snapshot.sections.workflows = 'partial'
  }
  while (snapshot.sessions.length && jsonBytes(snapshot) > MAX_AGENT_BODY_BYTES - 16_384) {
    snapshot.sessions.pop()
    snapshot.truncated.sessions = true
    snapshot.sections.sessions = 'partial'
  }
  if (jsonBytes(snapshot) > MAX_AGENT_BODY_BYTES - 16_384) {
    snapshot.runtime = null
    snapshot.sections.runtime = 'partial'
    snapshot.health = {
      status: 'degraded',
      detail: 'Runtime details were omitted to keep the response within its safety cap.',
    }
  }
  return snapshot
}

function boundedSessionDetail(input: AgentSessionDetail): AgentSessionDetail {
  const detail: AgentSessionDetail = {
    ...input,
    transcript: input.transcript.map((item) => ({ ...item, text: item.text.slice(0, 8_000) })),
    live: input.live ? { ...input.live, feed: [] } : null,
    control: input.control ? { ...input.control, feed: [] } : null,
    workflows: input.workflows.map((workflow) => ({
      ...workflow,
      phases: workflow.phases.slice(0, 40),
      agents: workflow.agents.slice(0, 128),
    })),
  }
  while (detail.transcript.length && jsonBytes(detail) > MAX_AGENT_BODY_BYTES - 16_384) {
    detail.transcript.shift()
  }
  while (detail.workflows.length && jsonBytes(detail) > MAX_AGENT_BODY_BYTES - 16_384) {
    detail.workflows.pop()
  }
  return detail
}

async function readIdentity(stateDirectory: string): Promise<AgentHostIdentity> {
  const directory = path.resolve(stateDirectory)
  const file = path.join(directory, 'host.json')
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<AgentHostIdentity>
    if (typeof value.id === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value.id)) {
      return {
        id: value.id,
        label: typeof value.label === 'string' ? value.label.slice(0, 160) : os.hostname(),
        hostname: os.hostname().slice(0, 255),
        platform: process.platform,
        arch: process.arch,
      }
    }
  } catch {
    // Create a stable local identity below.
  }
  const identity: AgentHostIdentity = {
    id: crypto.randomUUID(),
    label: (process.env.GROK_UI_AGENT_LABEL || os.hostname()).slice(0, 160),
    hostname: os.hostname().slice(0, 255),
    platform: process.platform,
    arch: process.arch,
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  const temporary = path.join(directory, `.host.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(temporary, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
  return identity
}

export interface HostAgentProvider {
  hello(): Promise<AgentHello>
  snapshot(): Promise<AgentSnapshot>
  session(id: string): Promise<AgentSessionDetail | null>
  usage(period: UsagePeriod, scope: UsageScope, groupBy: UsageGroupDimension): Promise<UsageReport>
  close?(): Promise<void>
}

export class LocalHostAgentProvider implements HostAgentProvider {
  private readonly sessionState: SessionStateStore
  private readonly store: GrokStore
  private readonly live: LiveMonitor
  private readonly runtime: RuntimeInspector
  private readonly sessionReader: SessionReader
  private identity: AgentHostIdentity | null = null
  private started = false

  constructor(
    private readonly stateDirectory = process.env.GROK_UI_STATE_DIR || path.join(os.homedir(), '.grok-ui'),
    grokHome = process.env.GROK_HOME,
  ) {
    this.sessionState = new SessionStateStore(this.stateDirectory)
    this.store = new GrokStore(grokHome, this.sessionState)
    this.live = new LiveMonitor(this.store)
    this.runtime = new RuntimeInspector()
    this.sessionReader = new SessionReader(this.store.grokHome)
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.sessionState.load()
    this.identity = await readIdentity(this.stateDirectory)
    this.live.on('live', (snapshot) => this.runtime.update(snapshot, emptyControl()))
    await this.live.start()
    this.runtime.update(this.live.snapshot(), emptyControl())
    await this.runtime.start()
    this.started = true
  }

  async hello(): Promise<AgentHello> {
    await this.start()
    const dashboard = await this.store.dashboard()
    return {
      protocolVersion: FLEET_PROTOCOL_VERSION,
      protocolMin: FLEET_PROTOCOL_MIN,
      protocolMax: FLEET_PROTOCOL_MAX,
      generatedAt: new Date().toISOString(),
      host: this.identity!,
      grokUiVersion: APP_VERSION,
      agentVersion: APP_VERSION,
      grokVersion: dashboard.version,
      capabilities: [...CAPABILITIES],
    }
  }

  async snapshot(): Promise<AgentSnapshot> {
    await this.start()
    const dashboard = await this.store.dashboard()
    const observationState = await this.readState()
    const managed = observationState.managedSessions()
    const sessionsById = new Map(dashboard.sessions.map((session) => [
      session.id,
      normalizeSession(observationState.apply(session)),
    ]))
    managed.forEach((session) => {
      if (!sessionsById.has(session.id)) sessionsById.set(session.id, controlSessionRow(session))
    })
    this.live.snapshot().agents.forEach((agent) => {
      if (!sessionsById.has(agent.id)) {
        sessionsById.set(agent.id, liveAgentRow(agent))
      }
    })
    const allSessions = [...sessionsById.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const allWorkflows = managed
      .flatMap((session) => session.workflows)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const usage = new UsageLedger(observationState).reportFromInputs({
      sessions: allSessions,
      live: this.live.snapshot().agents,
      managed,
    }, {
      period: '30d',
      scope: 'sessions',
      groupBy: 'project',
    })
    const runtime = this.runtime.snapshot()
    const degraded = !runtime.available || runtime.partial
    return boundedSnapshot({
      protocolVersion: FLEET_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      host: this.identity!,
      grokUiVersion: APP_VERSION,
      agentVersion: APP_VERSION,
      grokVersion: dashboard.version,
      capabilities: [...CAPABILITIES],
      health: {
        status: degraded ? 'degraded' : 'healthy',
        detail: degraded ? runtime.error || 'One or more observer capabilities are partial.' : '',
      },
      sessions: allSessions.slice(0, MAX_AGENT_SESSIONS),
      workflows: allWorkflows.slice(0, MAX_AGENT_WORKFLOWS).map(stripRemoteWorkflow),
      runtime,
      usage: boundedUsage(usage),
      sections: {
        sessions: allSessions.length > MAX_AGENT_SESSIONS ? 'partial' : 'available',
        workflows: allWorkflows.length > MAX_AGENT_WORKFLOWS ? 'partial' : 'available',
        runtime: !runtime.available ? 'unavailable' : runtime.partial ? 'partial' : 'available',
        usage: usage.entries.length > MAX_AGENT_USAGE_ENTRIES ? 'partial' : 'available',
      },
      truncated: {
        sessions: allSessions.length > MAX_AGENT_SESSIONS,
        workflows: allWorkflows.length > MAX_AGENT_WORKFLOWS,
        usageEntries: usage.entries.length > MAX_AGENT_USAGE_ENTRIES,
      },
    })
  }

  async session(id: string): Promise<AgentSessionDetail | null> {
    await this.start()
    if (!SESSION_ID.test(id)) return null
    const observationState = await this.readState()
    const managed = observationState.managedSessions().find((session) => session.id === id) || null
    const live = this.live.snapshot().agents.find((session) => session.id === id) || null
    const recorded = await this.store.session(id)
    const session = recorded
      ? observationState.apply(recorded)
      : managed ? controlSessionRow(managed) : null
    if (!session) return null
    const transcript = mergeSessionFeed(
      await this.sessionReader.transcript(session),
      live?.feed || [],
      managed?.feed || [],
    ).slice(-MAX_AGENT_TRANSCRIPT_ITEMS)
    const control = managed ? {
      id: managed.id,
      cwd: managed.cwd,
      title: managed.title,
      model: managed.model,
      state: managed.state,
      createdAt: managed.createdAt,
      updatedAt: managed.updatedAt,
      lastPrompt: '',
      stopReason: managed.stopReason,
      error: managed.error,
      cancellationStatus: managed.cancellationStatus,
      cancelRequestedAt: managed.cancelRequestedAt,
      cancelledAt: managed.cancelledAt,
      inputTokens: managed.inputTokens,
      outputTokens: managed.outputTokens,
      totalTokens: managed.totalTokens,
      tokenTelemetryAvailable: managed.tokenTelemetryAvailable,
      costAmount: managed.costAmount,
      costCurrency: managed.costCurrency,
      costTelemetryAvailable: managed.costTelemetryAvailable,
      feed: managed.feed.slice(-MAX_AGENT_TRANSCRIPT_ITEMS),
    } : null
    return boundedSessionDetail({
      protocolVersion: FLEET_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      hostId: this.identity!.id,
      session: normalizeSession(session),
      transcript,
      live: live ? { ...live, feed: [] } : null,
      control,
      workflows: (managed?.workflows || []).slice(0, MAX_AGENT_WORKFLOWS).map(stripRemoteWorkflow),
      managed: Boolean(managed),
    })
  }

  async usage(
    period: UsagePeriod,
    scope: UsageScope,
    groupBy: UsageGroupDimension,
  ): Promise<UsageReport> {
    await this.start()
    const observationState = await this.readState()
    const dashboard = await this.store.dashboard()
    return boundedUsage(new UsageLedger(observationState).reportFromInputs({
      sessions: dashboard.sessions.map((session) => observationState.apply(session)),
      live: this.live.snapshot().agents,
      managed: observationState.managedSessions(),
    }, { period, scope, groupBy }))
  }

  async close(): Promise<void> {
    await Promise.all([this.live.stop(), this.runtime.stop()])
  }

  private async readState(): Promise<SessionStateStore> {
    const state = new SessionStateStore(this.stateDirectory)
    await state.load()
    return state
  }
}

export function createHostAgentApp(provider: HostAgentProvider, token: string): express.Express {
  if (!token) throw new Error('GROK_UI_AGENT_TOKEN is required for the host agent.')
  const app = express()
  app.disable('x-powered-by')
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use('/agent/v1', (request, response, next) => {
    const authorization = request.headers.authorization || ''
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!candidate || !equalSecret(candidate, token)) {
      response.status(401).json({ error: 'Host-agent authentication required.' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.status(405).setHeader('Allow', 'GET, HEAD').json({ error: 'Host agent is read-only.' })
      return
    }
    next()
  })
  app.get('/agent/v1/hello', async (_request, response, next) => {
    try {
      response.json(normalizeAgentHello(await provider.hello()))
    } catch (error) {
      next(error)
    }
  })
  app.get('/agent/v1/snapshot', async (_request, response, next) => {
    try {
      response.json(boundedSnapshot(normalizeAgentSnapshot(await provider.snapshot())))
    } catch (error) {
      next(error)
    }
  })
  app.get('/agent/v1/sessions/:id', async (request, response, next) => {
    try {
      const session = await provider.session(request.params.id)
      if (!session) {
        response.status(404).json({ error: 'Remote session was not found.' })
        return
      }
      response.json(boundedSessionDetail(normalizeAgentSessionDetail(session)))
    } catch (error) {
      next(error)
    }
  })
  app.get('/agent/v1/usage', async (request, response, next) => {
    try {
      const period = typeof request.query.period === 'string' ? request.query.period : '30d'
      const scope = typeof request.query.scope === 'string' ? request.query.scope : 'sessions'
      const groupBy = typeof request.query.groupBy === 'string' ? request.query.groupBy : 'project'
      if (
        !USAGE_PERIODS.has(period as UsagePeriod)
        || !USAGE_SCOPES.has(scope as UsageScope)
        || !USAGE_GROUPS.has(groupBy as UsageGroupDimension)
      ) {
        response.status(400).json({ error: 'Invalid usage report options.' })
        return
      }
      const report = normalizeUsageReport(await provider.usage(
        period as UsagePeriod,
        scope as UsageScope,
        groupBy as UsageGroupDimension,
      ))
      if (!report) throw new Error('Usage report is unavailable.')
      response.json(boundedUsage(report))
    } catch (error) {
      next(error)
    }
  })
  app.use('/agent/v1', (_request, response) => {
    response.status(404).json({ error: 'Unknown host-agent route.' })
  })
  app.use((
    _error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    response.status(503).json({ error: 'Host-agent observation is temporarily unavailable.' })
  })
  return app
}

export async function startHostAgent(input: {
  host: string
  port: number
  token: string
  provider?: HostAgentProvider
}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const provider = input.provider || new LocalHostAgentProvider()
  const app = createHostAgentApp(provider, input.token)
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(input.port, input.host, () => resolve(listener))
    listener.once('error', reject)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : input.port
  const displayHost = input.host === '127.0.0.1' || input.host === '::1'
    ? 'localhost'
    : input.host.includes(':') ? `[${input.host}]` : input.host
  return {
    server,
    url: `http://${displayHost}:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await provider.close?.()
    },
  }
}
