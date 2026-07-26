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
  ControlSession,
  LiveAgent,
  SessionRow,
  UsageGroupDimension,
  UsagePeriod,
  UsageScope,
} from './types.js'
import { APP_VERSION } from './app-version.js'
import { inspectSetup } from './setup-diagnostics.js'
import { UsageLedger } from './usage-ledger.js'

const app = express()
const sessionState = new SessionStateStore()
await sessionState.load()
const store = new GrokStore(undefined, sessionState)
const liveMonitor = new LiveMonitor(store)
const controller = new GrokController(sessionState)
await controller.restore()
const workspaceInspector = new WorkspaceInspector()
const sessionReader = new SessionReader(store.grokHome)
const usageLedger = new UsageLedger(sessionState)
const port = Number(process.env.PORT || 4310)
const host = process.env.HOST || '127.0.0.1'
const security = new SecurityGate(host)
const eventClients = new Set<express.Response>()
let usageSyncTimer: NodeJS.Timeout | null = null

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
  scheduleUsageSync()
})
liveMonitor.on('dashboard', (payload) => broadcast('dashboard', payload))
controller.on('control', (payload) => {
  broadcast('control', payload)
  scheduleUsageSync()
})
workspaceInspector.on('change', (payload) => broadcast('workspace', payload))

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

const USAGE_PERIODS = new Set<UsagePeriod>(['24h', '7d', '30d', '90d', 'all'])
const USAGE_SCOPES = new Set<UsageScope>(['sessions', 'workflow-agents', 'all'])
const USAGE_GROUPS = new Set<UsageGroupDimension>(['project', 'model', 'session', 'agent'])

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

function controlRow(session: ControlSession): SessionRow {
  return {
    id: session.id,
    title: session.title,
    summary: '',
    cwd: session.cwd,
    workspace: path.basename(session.cwd) || session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model || 'Grok default',
    agent: 'Grok UI',
    reasoningEffort: 'default',
    sandboxProfile: 'native permissions',
    messages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    chatMessages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    turns: session.feed.filter((item) => item.type === 'user').length,
    toolCalls: session.feed.filter((item) => item.type === 'tool').length,
    errors: session.state === 'failed' ? 1 : 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: Math.max(0, (Date.now() - new Date(session.createdAt).getTime()) / 1_000),
    contextUsage: 0,
    status: session.state === 'attention'
      ? 'attention'
      : session.state === 'working' || session.state === 'starting' ? 'live' : 'recent',
    diskBytes: 0,
    archived: false,
  }
}

function liveRow(session: LiveAgent): SessionRow {
  return {
    id: session.id,
    title: session.title,
    summary: '',
    cwd: session.cwd,
    workspace: session.workspace,
    createdAt: session.openedAt,
    updatedAt: session.updatedAt,
    model: session.model,
    agent: 'Grok CLI',
    reasoningEffort: 'default',
    sandboxProfile: 'CLI process',
    messages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    chatMessages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    turns: session.turns,
    toolCalls: session.toolCalls,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: Math.max(0, (Date.now() - new Date(session.openedAt).getTime()) / 1_000),
    contextUsage: session.contextUsage,
    status: session.state === 'attention'
      ? 'attention'
      : session.state === 'working' || session.state === 'waiting' ? 'live' : 'recent',
    diskBytes: 0,
    archived: false,
  }
}

async function resolveSession(sessionId: string): Promise<SessionRow | null> {
  const recorded = await store.session(sessionId)
  if (recorded) return recorded
  const controlled = controller.snapshot().sessions.find((session) => session.id === sessionId)
  if (controlled) return sessionState.apply(controlRow(controlled))
  const live = liveMonitor.snapshot().agents.find((session) => session.id === sessionId)
  return live ? sessionState.apply(liveRow(live)) : null
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

app.get('/api/events', (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders()
  eventClients.add(response)
  response.write(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`)
  response.write(`event: live\ndata: ${JSON.stringify(liveMonitor.snapshot())}\n\n`)
  response.write(`event: control\ndata: ${JSON.stringify(controller.snapshot())}\n\n`)
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
await syncUsage()

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
  await Promise.all([liveMonitor.stop(), controller.stop(), workspaceInspector.close()])
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
