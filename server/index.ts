import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GrokStore } from './grok-store.js'
import { LiveMonitor } from './live-monitor.js'
import { GrokController } from './grok-controller.js'
import { SecurityGate } from './security.js'
import { WorkspaceInspector } from './workspace-inspector.js'
import { SessionStateStore } from './session-state.js'
import { mergeSessionFeed, SessionReader } from './session-reader.js'
import type {
  SessionRow,
  UsageGroupDimension,
  UsageBudgetDimension,
  UsageBudgetMetric,
  UsagePeriod,
  UsageScope,
} from './types.js'
import { APP_VERSION } from './app-version.js'
import { inspectSetup } from './setup-diagnostics.js'
import {
  UsageLedger,
  USAGE_GROUPS,
  USAGE_PERIODS,
  USAGE_SCOPES,
} from './usage-ledger.js'
import { RuntimeInspector } from './runtime-inspector.js'
import { UsageBudgetManager } from './usage-budgets.js'
import { usageExport, type UsageExportFormat } from './usage-export.js'
import { FleetRegistryStore, publicHostConfig } from './fleet-registry.js'
import { FleetMonitor } from './fleet-monitor.js'
import { controlSessionRow, liveAgentRow } from './session-projection.js'
import { PreviewSupervisor } from './preview-supervisor.js'

const app = express()
const sessionState = new SessionStateStore()
await sessionState.load()
const fleetRegistry = new FleetRegistryStore()
await fleetRegistry.load()
const store = new GrokStore(undefined, sessionState)
const liveMonitor = new LiveMonitor(store)
const controller = new GrokController(sessionState)
await controller.restore()
const workspaceInspector = new WorkspaceInspector()
const sessionReader = new SessionReader(store.grokHome)
const previewSupervisor = new PreviewSupervisor()
const usageLedger = new UsageLedger(sessionState)
const usageBudgets = new UsageBudgetManager(sessionState, usageLedger)
const runtimeInspector = new RuntimeInspector()
const fleetMonitor = new FleetMonitor(fleetRegistry)
const port = Number(process.env.PORT || 4310)
const host = process.env.HOST || '127.0.0.1'
const security = new SecurityGate(host)
const eventClients = new Set<express.Response>()
const MAX_REMOTE_SESSION_STREAMS = 16
let remoteSessionStreams = 0
let usageSyncTimer: NodeJS.Timeout | null = null
const REMOTE_COMMAND_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

function remoteControlStatus(message: string): number {
  if (message.includes('not found')) return 404
  if (
    message.includes('not enabled')
    || message.includes('fresh, healthy')
    || message.includes('does not advertise')
    || message.includes('no longer pending')
  ) return 409
  return 503
}

function requiredCommandId(value: unknown): string {
  if (typeof value !== 'string' || !REMOTE_COMMAND_ID.test(value)) {
    throw new Error('A valid commandId is required.')
  }
  return value
}

function requiredCommandExpiry(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('A valid expiresAt is required.')
  }
  return value
}

function broadcast(event: string, payload: unknown) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  eventClients.forEach((client) => client.write(frame))
}

async function syncUsage(): Promise<void> {
  await usageLedger.sync({
    sessions: (await store.dashboard()).sessions,
    live: liveMonitor.snapshot().agents,
    managed: controller.snapshot().sessions,
  })
}

function scheduleUsageSync(): void {
  if (usageSyncTimer) clearTimeout(usageSyncTimer)
  usageSyncTimer = setTimeout(() => {
    usageSyncTimer = null
    void syncUsage().catch(() => {
      // A later session or telemetry event will retry the durable snapshot.
    })
  }, 220)
  usageSyncTimer.unref()
}

liveMonitor.on('live', (payload) => {
  broadcast('live', payload)
  runtimeInspector.update(payload, controller.snapshot())
  scheduleUsageSync()
})
liveMonitor.on('dashboard', (payload) => broadcast('dashboard', payload))
controller.on('control', (payload) => {
  broadcast('control', payload)
  runtimeInspector.update(liveMonitor.snapshot(), payload)
  scheduleUsageSync()
})
workspaceInspector.on('change', (payload) => broadcast('workspace', payload))
runtimeInspector.on('runtime', (payload) => broadcast('runtime', payload))
fleetMonitor.on('fleet', (payload) => broadcast('fleet', payload))

app.disable('x-powered-by')
app.use(express.json({ limit: '64kb' }))
app.use(security.headers)

app.get('/api/health', async (_request, response) => {
  response.json({
    ok: true,
    version: APP_VERSION,
    authRequired: security.authRequired,
    generatedAt: new Date().toISOString(),
  })
})
app.get('/api/auth/status', security.status)
app.post('/api/auth/login', security.login)
app.post('/api/auth/logout', security.logout)
app.use('/api', security.protect)

app.get('/api/dashboard', async (request, response, next) => {
  try {
    response.json(await store.dashboard(request.query.refresh === '1'))
  } catch (error) {
    next(error)
  }
})

app.get('/api/live', (_request, response) => {
  response.json(liveMonitor.snapshot())
})

app.get('/api/runtime', async (request, response, next) => {
  try {
    if (request.query.refresh === '1') await runtimeInspector.refresh()
    response.json(runtimeInspector.snapshot())
  } catch (error) {
    next(error)
  }
})

app.get('/api/fleet', (_request, response) => {
  response.json(fleetMonitor.snapshot())
})

app.post('/api/fleet/hosts', async (request, response) => {
  try {
    const host = await fleetRegistry.create(request.body || {})
    fleetMonitor.syncRegistry()
    void fleetMonitor.refresh(host.id).catch(() => {
      // The fleet snapshot exposes the bounded connection failure.
    })
    response.status(201).json({
      host: publicHostConfig(host),
      fleet: fleetMonitor.snapshot(),
    })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid fleet host.' })
  }
})

app.patch('/api/fleet/hosts/:id', async (request, response) => {
  try {
    const host = await fleetRegistry.update(request.params.id, request.body || {})
    fleetMonitor.syncRegistry()
    void fleetMonitor.refresh(host.id).catch(() => {
      // The fleet snapshot exposes the bounded connection failure.
    })
    response.json({
      host: publicHostConfig(host),
      fleet: fleetMonitor.snapshot(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid fleet host.'
    response.status(message.includes('not found') ? 404 : 400).json({ error: message })
  }
})

app.delete('/api/fleet/hosts/:id', async (request, response) => {
  try {
    if (!(await fleetRegistry.remove(request.params.id))) {
      response.status(404).json({ error: 'Fleet host was not found.' })
      return
    }
    fleetMonitor.syncRegistry()
    response.status(204).end()
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : 'Fleet registry is unavailable.' })
  }
})

app.post('/api/fleet/hosts/:id/refresh', async (request, response) => {
  try {
    response.json(await fleetMonitor.refresh(request.params.id))
  } catch (error) {
    response.status(404).json({ error: error instanceof Error ? error.message : 'Fleet host was not found.' })
  }
})

app.get('/api/fleet/hosts/:id/sessions/:sessionId', async (request, response) => {
  try {
    response.json(await fleetMonitor.sessionDetail(request.params.id, request.params.sessionId))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote session is unavailable.'
    response.status(message.includes('not found') ? 404 : 503).json({ error: message })
  }
})

app.get('/api/fleet/hosts/:id/remote-sessions/:sessionId', async (request, response) => {
  try {
    response.json(await fleetMonitor.remoteSession(request.params.id, request.params.sessionId))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote session is unavailable.'
    response.status(remoteControlStatus(message)).json({ error: message })
  }
})

app.get('/api/fleet/hosts/:id/remote-sessions/:sessionId/events', async (request, response) => {
  if (remoteSessionStreams >= MAX_REMOTE_SESSION_STREAMS) {
    response.status(429).json({ error: 'Too many remote session streams are open.' })
    return
  }
  remoteSessionStreams += 1
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache, no-store')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders()
  let closed = false
  let inFlight = false
  let revision = ''
  let lastError = ''
  let lastHeartbeat = 0
  const send = async () => {
    if (closed || inFlight) return
    inFlight = true
    try {
      const snapshot = await fleetMonitor.remoteSession(request.params.id, request.params.sessionId)
      if (snapshot.revision !== revision) {
        revision = snapshot.revision
        lastError = ''
        response.write(`event: session\ndata: ${JSON.stringify(snapshot)}\n\n`)
      } else if (Date.now() - lastHeartbeat >= 15_000) {
        lastHeartbeat = Date.now()
        response.write(`event: heartbeat\ndata: ${JSON.stringify({ generatedAt: new Date().toISOString() })}\n\n`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Remote session stream is unavailable.'
      if (message !== lastError || Date.now() - lastHeartbeat >= 15_000) {
        lastError = message
        lastHeartbeat = Date.now()
        response.write(`event: session-error\ndata: ${JSON.stringify({ error: message })}\n\n`)
      }
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(() => void send(), 900)
  timer.unref()
  request.once('close', () => {
    closed = true
    clearInterval(timer)
    remoteSessionStreams = Math.max(0, remoteSessionStreams - 1)
  })
  await send()
})

app.post('/api/fleet/hosts/:id/remote-sessions', async (request, response) => {
  try {
    response.status(202).json(await fleetMonitor.createRemoteSession(request.params.id, {
      commandId: requiredCommandId(request.body?.commandId),
      expiresAt: requiredCommandExpiry(request.body?.expiresAt),
      cwd: typeof request.body?.cwd === 'string' ? request.body.cwd : '',
      prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
      model: typeof request.body?.model === 'string' ? request.body.model : '',
      reasoningEffort: typeof request.body?.reasoningEffort === 'string'
        ? request.body.reasoningEffort
        : '',
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start the remote session.'
    response.status(/commandId|expiresAt/.test(message) ? 400 : remoteControlStatus(message)).json({ error: message })
  }
})

app.post('/api/fleet/hosts/:id/remote-sessions/:sessionId/prompt', async (request, response) => {
  try {
    response.status(202).json(await fleetMonitor.promptRemoteSession(
      request.params.id,
      request.params.sessionId,
      {
        commandId: requiredCommandId(request.body?.commandId),
        expiresAt: requiredCommandExpiry(request.body?.expiresAt),
        prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
      },
    ))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to send the remote follow-up.'
    response.status(/commandId|expiresAt/.test(message) ? 400 : remoteControlStatus(message)).json({ error: message })
  }
})

app.post('/api/fleet/hosts/:id/remote-sessions/:sessionId/interrupt', async (request, response) => {
  try {
    response.status(202).json(await fleetMonitor.interruptRemoteSession(
      request.params.id,
      request.params.sessionId,
      {
        commandId: requiredCommandId(request.body?.commandId),
        expiresAt: requiredCommandExpiry(request.body?.expiresAt),
      },
    ))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to interrupt the remote turn.'
    response.status(/commandId|expiresAt/.test(message) ? 400 : remoteControlStatus(message)).json({ error: message })
  }
})

app.post(
  '/api/fleet/hosts/:id/remote-sessions/:sessionId/permissions/:permissionId',
  async (request, response) => {
    try {
      response.status(202).json(await fleetMonitor.resolveRemotePermission(
        request.params.id,
        request.params.sessionId,
        request.params.permissionId,
        {
          commandId: requiredCommandId(request.body?.commandId),
          expiresAt: requiredCommandExpiry(request.body?.expiresAt),
          optionId: typeof request.body?.optionId === 'string'
            ? request.body.optionId
            : undefined,
        },
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to resolve remote permission.'
      response.status(/commandId|expiresAt/.test(message) ? 400 : remoteControlStatus(message)).json({ error: message })
    }
  },
)

app.get('/api/fleet/hosts/:id/usage', async (request, response) => {
  const period = typeof request.query.period === 'string' ? request.query.period : '30d'
  const scope = typeof request.query.scope === 'string' ? request.query.scope : 'sessions'
  const groupBy = typeof request.query.groupBy === 'string' ? request.query.groupBy : 'project'
  if (
    !USAGE_PERIODS.has(period as UsagePeriod)
    || !USAGE_SCOPES.has(scope as UsageScope)
    || !USAGE_GROUPS.has(groupBy as UsageGroupDimension)
  ) {
    response.status(400).json({ error: 'Invalid remote usage report options.' })
    return
  }
  try {
    response.json(await fleetMonitor.usage(
      request.params.id,
      period as UsagePeriod,
      scope as UsageScope,
      groupBy as UsageGroupDimension,
    ))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote usage is unavailable.'
    response.status(message.includes('not found') ? 404 : 503).json({ error: message })
  }
})

app.get('/api/usage', async (request, response, next) => {
  try {
    const period = typeof request.query.period === 'string' ? request.query.period : '30d'
    const scope = typeof request.query.scope === 'string' ? request.query.scope : 'sessions'
    const groupBy = typeof request.query.groupBy === 'string' ? request.query.groupBy : 'project'
    if (!USAGE_PERIODS.has(period as UsagePeriod)) {
      response.status(400).json({ error: 'Usage period must be 24h, 7d, 30d, 90d, or all.' })
      return
    }
    if (!USAGE_SCOPES.has(scope as UsageScope)) {
      response.status(400).json({ error: 'Usage scope must be sessions, workflow-agents, or all.' })
      return
    }
    if (!USAGE_GROUPS.has(groupBy as UsageGroupDimension)) {
      response.status(400).json({ error: 'Usage grouping must be project, model, session, or agent.' })
      return
    }
    await syncUsage()
    response.json(usageLedger.report({
      period: period as UsagePeriod,
      scope: scope as UsageScope,
      groupBy: groupBy as UsageGroupDimension,
    }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/usage/budgets', async (_request, response, next) => {
  try {
    await syncUsage()
    response.json(await usageBudgets.snapshot())
  } catch (error) {
    next(error)
  }
})

app.post('/api/usage/budgets', async (request, response) => {
  try {
    const body = request.body as Record<string, unknown>
    const budget = await usageBudgets.upsert({
      id: typeof body.id === 'string' ? body.id : undefined,
      dimension: body.dimension as UsageBudgetDimension,
      key: typeof body.key === 'string' ? body.key : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      metric: body.metric as UsageBudgetMetric,
      limit: Number(body.limit),
      period: body.period as UsagePeriod,
      currency: typeof body.currency === 'string' ? body.currency : undefined,
      enabled: body.enabled !== false,
    })
    await syncUsage()
    response.status(201).json({ budget, snapshot: await usageBudgets.snapshot() })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid budget.' })
  }
})

app.delete('/api/usage/budgets/:id', async (request, response) => {
  const removed = await usageBudgets.remove(request.params.id)
  if (!removed) {
    response.status(404).json({ error: 'Budget not found.' })
    return
  }
  response.status(204).end()
})

app.post('/api/usage/alerts/:id/acknowledge', async (request, response) => {
  const acknowledged = await usageBudgets.acknowledge(request.params.id)
  if (!acknowledged) {
    response.status(404).json({ error: 'Usage alert not found.' })
    return
  }
  response.json(await usageBudgets.snapshot())
})

app.get('/api/usage/export', async (request, response, next) => {
  try {
    const period = typeof request.query.period === 'string' ? request.query.period : '30d'
    const scope = typeof request.query.scope === 'string' ? request.query.scope : 'sessions'
    const groupBy = typeof request.query.groupBy === 'string' ? request.query.groupBy : 'project'
    const format = typeof request.query.format === 'string' ? request.query.format : 'json'
    if (!USAGE_PERIODS.has(period as UsagePeriod)
      || !USAGE_SCOPES.has(scope as UsageScope)
      || !USAGE_GROUPS.has(groupBy as UsageGroupDimension)
      || !['json', 'csv'].includes(format)) {
      response.status(400).json({ error: 'Invalid usage export options.' })
      return
    }
    await syncUsage()
    const exported = usageExport(usageLedger.report({
      period: period as UsagePeriod,
      scope: scope as UsageScope,
      groupBy: groupBy as UsageGroupDimension,
    }), format as UsageExportFormat, request.query.privacy === '1')
    response.setHeader('Content-Type', exported.contentType)
    response.setHeader('Content-Disposition', `attachment; filename="grok-ui-usage.${exported.extension}"`)
    response.setHeader('Cache-Control', 'no-store')
    response.send(exported.body)
  } catch (error) {
    next(error)
  }
})

let setupCache: { expiresAt: number; payload: Awaited<ReturnType<typeof inspectSetup>> } | null = null
app.get('/api/setup', async (request, response, next) => {
  try {
    const force = request.query.refresh === '1'
    if (force || !setupCache || setupCache.expiresAt < Date.now()) {
      setupCache = {
        expiresAt: Date.now() + 30_000,
        payload: await inspectSetup({ grokHome: store.grokHome }),
      }
    }
    response.json(setupCache.payload)
  } catch (error) {
    next(error)
  }
})

app.get('/api/control', (_request, response) => {
  // Control startup may wait on CLI authentication. Return immediately so a
  // first-time user can still reach onboarding and the read-only dashboard.
  void controller.start().catch(() => {
    // The next control snapshot and SSE event include the startup error.
  })
  response.json(controller.snapshot())
})

app.post('/api/control/sessions', async (request, response) => {
  try {
    const session = await controller.createSession({
      cwd: typeof request.body?.cwd === 'string' ? request.body.cwd : '',
      prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
      model: typeof request.body?.model === 'string' ? request.body.model : '',
      reasoningEffort: typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort : '',
    })
    response.status(202).json(session)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to create session.' })
  }
})

app.post('/api/control/sessions/:id/prompt', async (request, response) => {
  try {
    const session = await controller.promptSession({
      sessionId: request.params.id,
      cwd: typeof request.body?.cwd === 'string' ? request.body.cwd : '',
      prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
    })
    response.status(202).json(session)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to send prompt.' })
  }
})

app.post('/api/control/sessions/:id/cancel', async (request, response) => {
  try {
    await controller.cancelSession(request.params.id)
    response.status(202).json({ cancelled: true })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to cancel session.' })
  }
})

app.post('/api/control/sessions/:sessionId/workflows/:workflowId', async (request, response) => {
  try {
    const action = request.body?.action
    if (action !== 'pause' && action !== 'resume' && action !== 'stop') {
      throw new Error('Workflow action must be pause, resume, or stop.')
    }
    await controller.controlWorkflow(request.params.sessionId, request.params.workflowId, action)
    response.status(202).json({ accepted: true })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to control workflow.' })
  }
})

app.post('/api/control/permissions/:id', (request, response) => {
  const optionId = typeof request.body?.optionId === 'string' ? request.body.optionId : undefined
  if (!controller.resolvePermission(request.params.id, optionId)) {
    response.status(404).json({ error: 'Permission request is no longer pending.' })
    return
  }
  response.json({ resolved: true })
})

async function resolveSession(sessionId: string): Promise<SessionRow | null> {
  const recorded = await store.session(sessionId)
  if (recorded) return recorded
  const controlled = controller.snapshot().sessions.find((session) => session.id === sessionId)
  if (controlled) return sessionState.apply(controlSessionRow(controlled))
  const live = liveMonitor.snapshot().agents.find((session) => session.id === sessionId)
  return live ? sessionState.apply(liveAgentRow(live)) : null
}

async function workspaceAllowed(cwd: string): Promise<boolean> {
  const resolved = path.resolve(cwd)
  if (resolved === process.cwd()) return true
  const dashboard = await store.dashboard()
  if (dashboard.sessions.some((session) => path.resolve(session.cwd) === resolved)) return true
  if (liveMonitor.snapshot().agents.some((session) => path.resolve(session.cwd) === resolved)) return true
  return controller.snapshot().sessions.some((session) => path.resolve(session.cwd) === resolved)
}

app.get('/api/workspace', async (request, response) => {
  const cwd = typeof request.query.cwd === 'string' ? request.query.cwd : ''
  if (!cwd || !(await workspaceAllowed(cwd))) {
    response.status(403).json({ error: 'Workspace is not associated with a Grok session.' })
    return
  }
  response.json(await workspaceInspector.snapshot(cwd))
})

app.get('/api/workspace/diff', async (request, response) => {
  const cwd = typeof request.query.cwd === 'string' ? request.query.cwd : ''
  const file = typeof request.query.file === 'string' ? request.query.file : ''
  if (!cwd || !(await workspaceAllowed(cwd))) {
    response.status(403).json({ error: 'Workspace is not associated with a Grok session.' })
    return
  }
  try {
    response.json(await workspaceInspector.diff(cwd, file))
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to read diff.' })
  }
})

app.get('/api/sessions/:id', async (request, response, next) => {
  try {
    const session = await store.session(request.params.id)
    if (!session) {
      response.status(404).json({ error: 'Session not found' })
      return
    }
    response.json(session)
  } catch (error) {
    next(error)
  }
})

app.get('/api/sessions/:id/workbench', async (request, response, next) => {
  try {
    const session = await resolveSession(request.params.id)
    if (!session) {
      response.status(404).json({ error: 'Session not found' })
      return
    }
    const live = liveMonitor.snapshot().agents.find((item) => item.id === session.id) || null
    const control = controller.snapshot().sessions.find((item) => item.id === session.id) || null
    const permissions = controller.snapshot().permissions.filter((item) => item.sessionId === session.id)
    const transcript = mergeSessionFeed(
      await sessionReader.transcript(session),
      live?.feed || [],
      control?.feed || [],
    )
    response.json({
      generatedAt: new Date().toISOString(),
      session,
      transcript,
      live,
      control,
      permissions,
      managed: Boolean(control),
    })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/sessions/:id', async (request, response) => {
  const session = await resolveSession(request.params.id)
  if (!session) {
    response.status(404).json({ error: 'Session not found' })
    return
  }
  const title = request.body?.title
  const archived = request.body?.archived
  if (title !== undefined && typeof title !== 'string') {
    response.status(400).json({ error: 'Session title must be a string.' })
    return
  }
  if (archived !== undefined && typeof archived !== 'boolean') {
    response.status(400).json({ error: 'Archived state must be a boolean.' })
    return
  }
  try {
    const annotation = await sessionState.annotate(session.id, { title, archived })
    if (annotation.title) controller.renameSession(session.id, annotation.title)
    store.invalidate()
    const updated = await resolveSession(session.id)
    const dashboard = await store.dashboard(true)
    broadcast('dashboard', dashboard)
    response.json(updated)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to update session.' })
  }
})

app.post('/api/sessions/:id/cancel', async (request, response) => {
  if (!controller.hasSession(request.params.id)) {
    response.status(409).json({ error: 'Attach this session by sending a prompt before cancelling it.' })
    return
  }
  try {
    await controller.cancelSession(request.params.id)
    response.status(202).json({ cancelled: true })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to cancel session.' })
  }
})

app.get('/api/sessions/:id/preview', async (request, response) => {
  const session = await resolveSession(request.params.id)
  if (!session) {
    response.status(404).json({ error: 'Session not found' })
    return
  }
  response.json(await previewSupervisor.inspect(session.id, session.cwd))
})

app.post('/api/sessions/:id/preview/start', async (request, response) => {
  const session = await resolveSession(request.params.id)
  if (!session) {
    response.status(404).json({ error: 'Session not found' })
    return
  }
  try {
    response.status(202).json(await previewSupervisor.start(session.id, session.cwd))
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to start preview.' })
  }
})

app.post('/api/sessions/:id/preview/stop', async (request, response) => {
  const session = await resolveSession(request.params.id)
  if (!session) {
    response.status(404).json({ error: 'Session not found' })
    return
  }
  try {
    response.json(await previewSupervisor.stop(session.id))
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to stop preview.' })
  }
})

app.get('/api/events', (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders()
  eventClients.add(response)
  response.write(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`)
  response.write(`event: live\ndata: ${JSON.stringify(liveMonitor.snapshot())}\n\n`)
  response.write(`event: control\ndata: ${JSON.stringify(controller.snapshot())}\n\n`)
  response.write(`event: runtime\ndata: ${JSON.stringify(runtimeInspector.snapshot())}\n\n`)
  response.write(`event: fleet\ndata: ${JSON.stringify(fleetMonitor.snapshot())}\n\n`)
  void store.dashboard().then((payload) => {
    response.write(`event: dashboard\ndata: ${JSON.stringify(payload)}\n\n`)
  })

  const heartbeat = setInterval(() => response.write('event: heartbeat\ndata: {}\n\n'), 20_000)
  request.on('close', () => {
    clearInterval(heartbeat)
    eventClients.delete(response)
  })
})

if (process.env.GROK_UI_E2E === '1') {
  app.post('/api/test/disconnect-events', (_request, response) => {
    response.json({ disconnected: eventClients.size })
    setImmediate(() => {
      eventClients.forEach((client) => client.end())
    })
  })
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = path.join(root, 'dist')
app.use(express.static(staticDir))
app.get('*splat', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')))

app.use((
  error: unknown,
  _request: express.Request,
  response: express.Response,
  _next: express.NextFunction,
) => {
  console.error(error)
  response.status(500).json({ error: 'Unable to read the local Grok data store.' })
})

await liveMonitor.start()
runtimeInspector.update(liveMonitor.snapshot(), controller.snapshot())
await runtimeInspector.start()
await syncUsage()
void fleetMonitor.start().catch((error) => {
  console.error('Fleet monitor failed to start:', error)
})

export const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
  const listener = app.listen(port, host, () => resolve(listener))
  listener.once('error', reject)
})
const address = server.address()
const activePort = typeof address === 'object' && address ? address.port : port
const displayHost = host === '127.0.0.1' || host === '::1'
  ? 'localhost'
  : host.includes(':') ? `[${host}]` : host
export const serverUrl = `http://${displayHost}:${activePort}`

console.log(`Grok UI → ${serverUrl}`)
console.log('Local Grok state linked')
console.log(`Remote authentication ${security.authRequired ? 'enabled' : 'not required on loopback'}`)

async function shutdown() {
  if (usageSyncTimer) clearTimeout(usageSyncTimer)
  server.close()
  await Promise.all([
    liveMonitor.stop(),
    runtimeInspector.stop(),
    fleetMonitor.stop(),
    controller.stop(),
    workspaceInspector.close(),
    previewSupervisor.close(),
  ])
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
