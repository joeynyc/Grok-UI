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
  normalizeRemoteSessionSnapshot,
  normalizeSession,
  normalizeUsageReport,
  stripRemoteWorkflow,
} from './fleet-protocol.js'
import { GrokStore } from './grok-store.js'
import { GrokController } from './grok-controller.js'
import { LiveMonitor } from './live-monitor.js'
import { RemoteCommandStore, type RemoteCommandResult } from './remote-command-store.js'
import { RuntimeInspector } from './runtime-inspector.js'
import { SessionReader, mergeSessionFeed } from './session-reader.js'
import { SessionStateStore } from './session-state.js'
import type {
  AgentCapability,
  AgentHello,
  AgentHostIdentity,
  AgentSessionDetail,
  AgentSnapshot,
  RemoteCommandKind,
  RemoteCommandReceipt,
  RemoteSessionSnapshot,
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
const COMMAND_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

const CONTROL_CAPABILITIES: AgentCapability[] = [
  'remote.sessions',
  'remote.sessions.create',
  'remote.sessions.prompt',
  'remote.sessions.interrupt',
  'remote.permissions.resolve',
]

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
  remoteSession?(id: string): Promise<RemoteSessionSnapshot | null>
  createRemoteSession?(input: {
    cwd: string
    prompt: string
    model?: string
    reasoningEffort?: string
  }): Promise<string>
  promptRemoteSession?(id: string, prompt: string): Promise<void>
  interruptRemoteSession?(id: string): Promise<void>
  resolveRemotePermission?(sessionId: string, permissionId: string, optionId?: string): Promise<void>
  close?(): Promise<void>
}

export class LocalHostAgentProvider implements HostAgentProvider {
  private readonly sessionState: SessionStateStore
  private readonly store: GrokStore
  private readonly live: LiveMonitor
  private readonly runtime: RuntimeInspector
  private readonly sessionReader: SessionReader
  private readonly controller: GrokController | null
  private identity: AgentHostIdentity | null = null
  private started = false

  constructor(
    private readonly stateDirectory = process.env.GROK_UI_STATE_DIR || path.join(os.homedir(), '.grok-ui'),
    grokHome = process.env.GROK_HOME,
    private readonly remoteControlEnabled = false,
  ) {
    this.sessionState = new SessionStateStore(this.stateDirectory)
    this.store = new GrokStore(grokHome, this.sessionState)
    this.live = new LiveMonitor(this.store)
    this.runtime = new RuntimeInspector()
    this.sessionReader = new SessionReader(this.store.grokHome)
    this.controller = remoteControlEnabled ? new GrokController(this.sessionState) : null
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.sessionState.load()
    await this.controller?.restore()
    this.identity = await readIdentity(this.stateDirectory)
    this.live.on('live', (snapshot) => this.runtime.update(snapshot, this.controller?.snapshot() || emptyControl()))
    this.controller?.on('control', (snapshot) => this.runtime.update(this.live.snapshot(), snapshot))
    await this.live.start()
    this.runtime.update(this.live.snapshot(), this.controller?.snapshot() || emptyControl())
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
      capabilities: this.capabilities(),
    }
  }

  async snapshot(): Promise<AgentSnapshot> {
    await this.start()
    const dashboard = await this.store.dashboard()
    const observationState = await this.readState()
    const managed = this.controller?.snapshot().sessions || observationState.managedSessions()
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
      capabilities: this.capabilities(),
      managedSessionIds: managed.map((session) => session.id).slice(0, MAX_AGENT_SESSIONS),
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
    const managed = (
      this.controller?.snapshot().sessions
      || observationState.managedSessions()
    ).find((session) => session.id === id) || null
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
      managed: this.controller?.snapshot().sessions || observationState.managedSessions(),
    }, { period, scope, groupBy }))
  }

  async remoteSession(id: string): Promise<RemoteSessionSnapshot | null> {
    this.assertRemoteControl()
    if (!SESSION_ID.test(id) || !this.controller!.hasSession(id)) {
      throw new Error('Only a host-managed remote session can be controlled.')
    }
    const detail = await this.session(id)
    if (!detail) return null
    const control = this.controller!.snapshot()
    const managed = control.sessions.find((session) => session.id === id) || null
    const permissions = control.permissions.filter((permission) => permission.sessionId === id)
    const snapshot = normalizeRemoteSessionSnapshot({
      ...detail,
      control: managed ? { ...managed, workflows: undefined } : detail.control,
      permissions,
      revision: crypto.createHash('sha256').update(JSON.stringify({
        transcript: detail.transcript.map((item) => [item.id, item.status, item.text]),
        control: managed ? [
          managed.updatedAt,
          managed.state,
          managed.cancellationStatus,
          managed.totalTokens,
        ] : null,
        permissions: permissions.map((permission) => permission.id),
      })).digest('base64url'),
    })
    return snapshot
  }

  async createRemoteSession(input: {
    cwd: string
    prompt: string
    model?: string
    reasoningEffort?: string
  }): Promise<string> {
    this.assertRemoteControl()
    await this.assertObservedWorkspace(input.cwd)
    const session = await this.controller!.createSession(input)
    return session.id
  }

  async promptRemoteSession(id: string, prompt: string): Promise<void> {
    this.assertRemoteControl()
    if (!SESSION_ID.test(id) || !this.controller!.hasSession(id)) {
      throw new Error('Only a host-managed remote session can receive follow-ups.')
    }
    const detail = await this.session(id)
    if (!detail) throw new Error('Remote session was not found.')
    await this.controller!.promptSession({
      sessionId: id,
      cwd: detail.session.cwd,
      prompt,
    })
  }

  async interruptRemoteSession(id: string): Promise<void> {
    this.assertRemoteControl()
    if (!SESSION_ID.test(id) || !this.controller!.hasSession(id)) {
      throw new Error('Only an attached remote session can be interrupted.')
    }
    await this.controller!.cancelSession(id)
  }

  async resolveRemotePermission(
    sessionId: string,
    permissionId: string,
    optionId?: string,
  ): Promise<void> {
    this.assertRemoteControl()
    const permission = this.controller!.snapshot().permissions.find((candidate) =>
      candidate.id === permissionId && candidate.sessionId === sessionId)
    if (!permission) throw new Error('Remote permission request is no longer pending.')
    if (optionId && !permission.options.some((option) => option.id === optionId)) {
      throw new Error('Remote permission option was not offered by Grok.')
    }
    if (!this.controller!.resolvePermission(permissionId, optionId)) {
      throw new Error('Remote permission request is no longer pending.')
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.live.stop(), this.runtime.stop(), this.controller?.stop()])
  }

  private async readState(): Promise<SessionStateStore> {
    const state = new SessionStateStore(this.stateDirectory)
    await state.load()
    return state
  }

  private capabilities(): AgentCapability[] {
    return this.remoteControlEnabled
      ? [...CAPABILITIES, ...CONTROL_CAPABILITIES]
      : [...CAPABILITIES]
  }

  private assertRemoteControl(): void {
    if (!this.remoteControlEnabled || !this.controller) {
      throw new Error('Remote session control is not enabled on this host.')
    }
  }

  private async assertObservedWorkspace(cwd: string): Promise<void> {
    const resolved = path.resolve(cwd)
    const dashboard = await this.store.dashboard()
    const observed = new Set([
      ...dashboard.sessions.map((session) => path.resolve(session.cwd)),
      ...this.live.snapshot().agents.map((session) => path.resolve(session.cwd)),
      ...(this.controller?.snapshot().sessions || []).map((session) => path.resolve(session.cwd)),
    ])
    if (!observed.has(resolved)) {
      throw new Error('Remote Start is limited to a workspace already observed on this host.')
    }
  }
}

interface HostAgentControlOptions {
  controlToken?: string
  commandStore?: RemoteCommandStore
  stateDirectory?: string
}

function commandId(value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_ID.test(value)) {
    throw new Error('A valid commandId is required.')
  }
  return value
}

function resourceId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new Error(`A valid ${label} is required.`)
  }
  return value
}

function commandExpiresAt(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('A valid expiresAt is required.')
  }
  return value
}

function commandReceipt(
  id: string,
  kind: RemoteCommandKind,
  sessionId: string,
  result: RemoteCommandResult,
): RemoteCommandReceipt {
  const timestamp = new Date().toISOString()
  const resultSessionId = result.result && typeof result.result === 'object'
    && typeof (result.result as { sessionId?: unknown }).sessionId === 'string'
    ? (result.result as { sessionId: string }).sessionId
    : sessionId
  return {
    commandId: id,
    kind,
    status: result.outcome,
    createdAt: timestamp,
    updatedAt: timestamp,
    sessionId: resultSessionId,
    error: result.error || '',
  }
}

export function createHostAgentApp(
  provider: HostAgentProvider,
  token: string,
  options: HostAgentControlOptions = {},
): express.Express {
  if (!token) throw new Error('GROK_UI_AGENT_TOKEN is required for the host agent.')
  const controlToken = options.controlToken || ''
  if (controlToken && equalSecret(controlToken, token)) {
    throw new Error('Remote control must use a token separate from the read-only agent token.')
  }
  const commandStore = options.commandStore || (controlToken
    ? new RemoteCommandStore(
      options.stateDirectory
      || process.env.GROK_UI_STATE_DIR
      || path.join(os.homedir(), '.grok-ui'),
    )
    : null)
  const actorFingerprint = controlToken
    ? crypto.createHash('sha256').update(controlToken).digest('hex').slice(0, 24)
    : ''
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
  app.use('/agent/control/v1', express.json({ limit: '64kb' }), (request, response, next) => {
    if (!controlToken || !commandStore) {
      response.status(404).json({ error: 'Remote session control is not enabled on this host.' })
      return
    }
    const authorization = request.headers.authorization || ''
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!candidate || !equalSecret(candidate, controlToken)) {
      response.status(401).json({ error: 'Remote-control authentication required.' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      response.status(405).setHeader('Allow', 'GET, HEAD, POST').json({
        error: 'Remote-control method is not supported.',
      })
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
      const id = resourceId(request.params.id, 'session ID')
      const session = await provider.session(id)
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
  app.get('/agent/control/v1/sessions/:id', async (request, response, next) => {
    try {
      if (!provider.remoteSession) throw new Error('Remote sessions are unavailable.')
      const id = resourceId(request.params.id, 'session ID')
      const session = await provider.remoteSession(id)
      if (!session) {
        response.status(404).json({ error: 'Remote session was not found.' })
        return
      }
      response.json(normalizeRemoteSessionSnapshot(session))
    } catch (error) {
      next(error)
    }
  })
  app.post('/agent/control/v1/sessions', async (request, response, next) => {
    try {
      if (!provider.createRemoteSession || !commandStore) throw new Error('Remote Start is unavailable.')
      const id = commandId(request.body?.commandId)
      const expiresAt = commandExpiresAt(request.body?.expiresAt)
      const cwd = typeof request.body?.cwd === 'string' ? request.body.cwd : ''
      const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : ''
      const model = typeof request.body?.model === 'string' ? request.body.model : ''
      const reasoningEffort = typeof request.body?.reasoningEffort === 'string'
        ? request.body.reasoningEffort
        : ''
      const result = await commandStore.execute({
        commandId: id,
        kind: 'session.create',
        target: 'new-session',
        actorFingerprint,
        expiresAt,
        payload: { cwd, prompt, model, reasoningEffort },
      }, async () => ({
        sessionId: await provider.createRemoteSession!({ cwd, prompt, model, reasoningEffort }),
      }))
      response.status(202).json(commandReceipt(id, 'session.create', '', result))
    } catch (error) {
      next(error)
    }
  })
  app.post('/agent/control/v1/sessions/:id/prompt', async (request, response, next) => {
    try {
      if (!provider.promptRemoteSession || !commandStore) throw new Error('Remote follow-up is unavailable.')
      const sessionId = resourceId(request.params.id, 'session ID')
      const id = commandId(request.body?.commandId)
      const expiresAt = commandExpiresAt(request.body?.expiresAt)
      const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : ''
      const result = await commandStore.execute({
        commandId: id,
        kind: 'session.prompt',
        target: sessionId,
        actorFingerprint,
        expiresAt,
        payload: { sessionId, prompt },
      }, async () => {
        await provider.promptRemoteSession!(sessionId, prompt)
        return { sessionId }
      })
      response.status(202).json(commandReceipt(id, 'session.prompt', sessionId, result))
    } catch (error) {
      next(error)
    }
  })
  app.post('/agent/control/v1/sessions/:id/interrupt', async (request, response, next) => {
    try {
      if (!provider.interruptRemoteSession || !commandStore) throw new Error('Remote interrupt is unavailable.')
      const sessionId = resourceId(request.params.id, 'session ID')
      const id = commandId(request.body?.commandId)
      const expiresAt = commandExpiresAt(request.body?.expiresAt)
      const result = await commandStore.execute({
        commandId: id,
        kind: 'session.interrupt',
        target: sessionId,
        actorFingerprint,
        expiresAt,
        payload: { sessionId },
      }, async () => {
        await provider.interruptRemoteSession!(sessionId)
        return { sessionId }
      })
      response.status(202).json(commandReceipt(id, 'session.interrupt', sessionId, result))
    } catch (error) {
      next(error)
    }
  })
  app.post(
    '/agent/control/v1/sessions/:id/permissions/:permissionId',
    async (request, response, next) => {
      try {
        if (!provider.resolveRemotePermission || !commandStore) {
          throw new Error('Remote permission decisions are unavailable.')
        }
        if (!provider.remoteSession) throw new Error('Remote sessions are unavailable.')
        const sessionId = resourceId(request.params.id, 'session ID')
        const permissionId = resourceId(request.params.permissionId, 'permission ID')
        const id = commandId(request.body?.commandId)
        const expiresAt = commandExpiresAt(request.body?.expiresAt)
        const optionId = typeof request.body?.optionId === 'string'
          ? request.body.optionId
          : undefined
        const result = await commandStore.execute({
          commandId: id,
          kind: 'permission.resolve',
          target: sessionId,
          actorFingerprint,
          expiresAt,
          payload: {
            sessionId,
            permissionId,
            optionId: optionId || '',
          },
        }, async () => {
          const current = await provider.remoteSession!(sessionId)
          const permission = current?.permissions.find((candidate) =>
            candidate.id === permissionId && candidate.sessionId === sessionId)
          if (!permission) {
            throw new Error('Remote permission request is no longer pending.')
          }
          if (optionId && !permission.options.some((option) => option.id === optionId)) {
            throw new Error('Remote permission option was not offered by Grok.')
          }
          await provider.resolveRemotePermission!(
            sessionId,
            permissionId,
            optionId,
          )
          return { sessionId }
        })
        response.status(202).json(commandReceipt(
          id,
          'permission.resolve',
          sessionId,
          result,
        ))
      } catch (error) {
        next(error)
      }
    },
  )
  app.use('/agent/control/v1', (_request, response) => {
    response.status(404).json({ error: 'Unknown remote-control route.' })
  })
  app.use('/agent/v1', (_request, response) => {
    response.status(404).json({ error: 'Unknown host-agent route.' })
  })
  app.use((
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    response.status(503).json({
      error: process.env.GROK_UI_E2E === '1' && error instanceof Error
        ? error.message
        : 'Host-agent observation is temporarily unavailable.',
    })
  })
  return app
}

export async function startHostAgent(input: {
  host: string
  port: number
  token: string
  controlToken?: string
  stateDirectory?: string
  provider?: HostAgentProvider
}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const provider = input.provider || new LocalHostAgentProvider(
    input.stateDirectory,
    process.env.GROK_HOME,
    Boolean(input.controlToken),
  )
  const app = createHostAgentApp(provider, input.token, {
    controlToken: input.controlToken,
    stateDirectory: input.stateDirectory,
  })
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
