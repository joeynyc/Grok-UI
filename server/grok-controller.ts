import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import type {
  ControlPermission,
  ControlSession,
  ControlSnapshot,
  LiveFeedItem,
  WorkflowControlAction,
} from './types.js'
import { SessionStateStore } from './session-state.js'
import { APP_VERSION } from './app-version.js'
import { parseWorkflowNotification, workflowControlCommand } from './workflow-state.js'

interface NewControlSession {
  cwd: string
  prompt: string
  model?: string
  reasoningEffort?: string
}

interface PromptControlSession {
  sessionId: string
  cwd: string
  prompt: string
}

interface PendingPermission {
  public: ControlPermission
  resolve: (response: RequestPermissionResponse) => void
}

function now(): string {
  return new Date().toISOString()
}

function compactPrompt(prompt: string, limit = 96): string {
  const singleLine = prompt.replace(/\s+/g, ' ').trim()
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionSeed(id: string, cwd: string, prompt: string, model = ''): ControlSession {
  const timestamp = now()
  return {
    id,
    cwd,
    title: compactPrompt(prompt) || `Session ${id.slice(0, 8)}`,
    model,
    state: 'starting',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastPrompt: prompt,
    stopReason: '',
    error: '',
    cancellationStatus: 'none',
    cancelRequestedAt: '',
    cancelledAt: '',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costAmount: 0,
    costCurrency: '',
    feed: [],
    workflows: [],
  }
}

function blockText(content: unknown): string {
  if (!content || typeof content !== 'object') return ''
  const block = content as { type?: string; text?: string; uri?: string }
  if (block.type === 'text') return block.text || ''
  return block.uri || ''
}

function feedItem(update: SessionNotification['update']): LiveFeedItem | null {
  const timestamp = now()
  const type = update.sessionUpdate
  if (type === 'user_message_chunk' || type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
    return {
      id: `${timestamp}:${type}:${Math.random()}`,
      type: type === 'user_message_chunk' ? 'user' : type === 'agent_message_chunk' ? 'assistant' : 'thought',
      title: type.replaceAll('_', ' '),
      text: blockText(update.content),
      status: '',
      timestamp,
    }
  }
  if (type === 'tool_call') {
    return {
      id: `${timestamp}:${update.toolCallId}`,
      type: 'tool',
      title: update.title,
      text: '',
      status: update.status || 'pending',
      timestamp,
    }
  }
  if (type === 'tool_call_update') {
    return {
      id: `${timestamp}:${update.toolCallId}:${Math.random()}`,
      type: 'tool',
      title: update.title || 'Tool update',
      text: '',
      status: update.status || '',
      timestamp,
    }
  }
  if (type === 'plan' || type === 'plan_update') {
    return {
      id: `${timestamp}:${type}:${Math.random()}`,
      type: 'plan',
      title: 'Plan updated',
      text: JSON.stringify(update),
      status: '',
      timestamp,
    }
  }
  return null
}

export class GrokController extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null
  private connection: acp.ClientConnection | null = null
  private startPromise: Promise<void> | null = null
  private starting = false
  private connected = false
  private agentName = ''
  private agentVersion = ''
  private error = ''
  private sessions = new Map<string, ControlSession>()
  private loadedSessions = new Set<string>()
  private replayingSessions = new Set<string>()
  private permissions = new Map<string, PendingPermission>()
  private cancellationTimers = new Map<string, NodeJS.Timeout>()
  private stderrTail: string[] = []
  private persistTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private lastDisconnectedAt = ''
  private stopping = false

  constructor(
    private readonly sessionState?: SessionStateStore,
    private readonly cancellationTimeoutMs = 12_000,
    private readonly reconnectDelayMs = 1_000,
  ) {
    super()
  }

  async restore(): Promise<void> {
    if (!this.sessionState) return
    await this.sessionState.load()
    this.sessions = new Map(this.sessionState.managedSessions().map((session) => [
      session.id,
      session,
    ]))
    this.emitSnapshot()
  }

  snapshot(): ControlSnapshot {
    return {
      generatedAt: now(),
      connected: this.connected,
      starting: this.starting,
      reconnecting: Boolean(this.reconnectTimer) || (this.starting && this.reconnectAttempt > 0),
      reconnectAttempt: this.reconnectAttempt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      agentName: this.agentName,
      agentVersion: this.agentVersion,
      error: this.error,
      sessions: [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      workflows: [...this.sessions.values()]
        .flatMap((session) => session.workflows)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      permissions: [...this.permissions.values()]
        .map((item) => item.public)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }
  }

  async start(): Promise<void> {
    if (this.connected) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.cancellationTimers.forEach((timer) => clearTimeout(timer))
    this.cancellationTimers.clear()
    await this.persist()
    this.permissions.forEach((permission) => {
      permission.resolve({ outcome: { outcome: 'cancelled' } })
    })
    this.permissions.clear()
    this.connection?.close()
    this.connection = null
    this.connected = false
    this.process?.kill('SIGTERM')
    this.process = null
    this.emitSnapshot()
    await this.persist()
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  renameSession(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.set(sessionId, {
      ...session,
      title,
      updatedAt: now(),
    })
    this.emitSnapshot()
  }

  async createSession(input: NewControlSession): Promise<ControlSession> {
    this.validatePrompt(input.prompt)
    const cwd = await this.validateCwd(input.cwd)
    await this.start()
    const context = this.context()
    const response = await context.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
      _meta: {
        clientIdentifier: 'grok-ui',
        modelId: input.model || undefined,
        reasoningEffort: input.reasoningEffort || undefined,
        yoloMode: false,
        autoMode: false,
      },
    })
    const session = sessionSeed(response.sessionId, cwd, input.prompt, input.model)
    this.sessions.set(session.id, session)
    this.loadedSessions.add(session.id)
    this.emitSnapshot()
    void this.runPrompt(session.id, input.prompt)
    return session
  }

  async promptSession(input: PromptControlSession): Promise<ControlSession> {
    this.validatePrompt(input.prompt)
    const cwd = await this.validateCwd(input.cwd)
    await this.start()
    if (!this.loadedSessions.has(input.sessionId)) {
      this.replayingSessions.add(input.sessionId)
      try {
        await this.context().request(acp.methods.agent.session.load, {
          sessionId: input.sessionId,
          cwd,
          mcpServers: [],
          _meta: { clientIdentifier: 'grok-ui' },
        })
        this.loadedSessions.add(input.sessionId)
      } finally {
        this.replayingSessions.delete(input.sessionId)
      }
    }
    const existing = this.sessions.get(input.sessionId)
      || sessionSeed(input.sessionId, cwd, input.prompt)
    const session: ControlSession = {
      ...existing,
      cwd,
      title: existing.title || compactPrompt(input.prompt),
      state: 'working',
      updatedAt: now(),
      lastPrompt: input.prompt,
      stopReason: '',
      error: '',
      cancellationStatus: 'none',
      cancelRequestedAt: '',
      cancelledAt: '',
    }
    this.sessions.set(session.id, session)
    this.emitSnapshot()
    void this.runPrompt(session.id, input.prompt)
    return session
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.start()
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Managed session was not found.')
    const canCancel = ['working', 'starting', 'attention', 'stopping'].includes(session.state)
      || ['timed_out', 'failed'].includes(session.cancellationStatus)
    if (!canCancel) throw new Error('This session does not have an active turn to stop.')

    const requestedAt = now()
    this.sessions.set(sessionId, {
      ...session,
      state: 'stopping',
      updatedAt: requestedAt,
      stopReason: 'stop_requested',
      error: '',
      cancellationStatus: 'requested',
      cancelRequestedAt: requestedAt,
      cancelledAt: '',
    })

    for (const [permissionId, pending] of this.permissions) {
      if (pending.public.sessionId !== sessionId) continue
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      this.permissions.delete(permissionId)
    }
    this.scheduleCancellationTimeout(sessionId)
    this.emitSnapshot()

    try {
      await this.context().notify(acp.methods.agent.session.cancel, { sessionId })
    } catch (cancelError) {
      this.clearCancellationTimer(sessionId)
      const current = this.sessions.get(sessionId)
      if (current) {
        this.sessions.set(sessionId, {
          ...current,
          state: 'failed',
          updatedAt: now(),
          error: `Unable to send Stop to Grok: ${safeError(cancelError)}`,
          cancellationStatus: 'failed',
        })
        this.emitSnapshot()
      }
      throw cancelError
    }
  }

  async controlWorkflow(
    sessionId: string,
    workflowId: string,
    action: WorkflowControlAction,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Managed session was not found.')
    const workflow = session.workflows.find((item) => item.id === workflowId)
    if (!workflow) throw new Error('Workflow run was not found.')
    const allowed = action === 'pause'
      ? workflow.canPause
      : action === 'resume'
        ? workflow.canResume
        : workflow.canStop
    if (!allowed) throw new Error(`This workflow cannot ${action} from its current state.`)
    if (['starting', 'working', 'attention', 'stopping'].includes(session.state)) {
      throw new Error('Wait for the parent session turn to settle before controlling this workflow.')
    }
    await this.promptSession({
      sessionId,
      cwd: session.cwd,
      prompt: workflowControlCommand(action, workflow.controlHandle),
    })
  }

  resolvePermission(permissionId: string, optionId?: string): boolean {
    const pending = this.permissions.get(permissionId)
    if (!pending) return false
    const selected = optionId && pending.public.options.some((option) => option.id === optionId)
    pending.resolve(selected
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } })
    this.permissions.delete(permissionId)
    const session = this.sessions.get(pending.public.sessionId)
    if (session) {
      this.sessions.set(session.id, { ...session, state: 'working', updatedAt: now() })
    }
    this.emitSnapshot()
    return true
  }

  private async startInternal(): Promise<void> {
    this.starting = true
    this.error = ''
    this.stderrTail = []
    this.emitSnapshot()
    let child: ChildProcessWithoutNullStreams | null = null
    try {
      const grokPath = process.env.GROK_BIN || 'grok'
      const spawnedChild = spawn(grokPath, ['agent', '--no-leader', 'stdio'], {
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child = spawnedChild
      this.process = spawnedChild
      spawnedChild.stderr.setEncoding('utf8')
      spawnedChild.stderr.on('data', (chunk: string) => {
        this.stderrTail.push(...chunk.split('\n').filter(Boolean))
        this.stderrTail = this.stderrTail.slice(-20)
      })
      spawnedChild.once('exit', (code, signal) => {
        this.handleDisconnect(
          spawnedChild,
          `Grok control process exited (${signal || code || 'unknown'}).`,
        )
      })
      spawnedChild.once('error', (spawnError) => {
        this.handleDisconnect(spawnedChild, `Unable to start Grok: ${safeError(spawnError)}`)
      })

      const stream = acp.ndJsonStream(
        Writable.toWeb(spawnedChild.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(spawnedChild.stdout) as ReadableStream<Uint8Array>,
      )
      const app = acp.client({ name: 'grok-ui' })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
          this.requestPermission(params))
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          this.sessionUpdate(params)
        })
        .onNotification('x.ai/session_notification', (params: unknown) => params, ({ params }) => {
          this.workflowUpdate(params)
        })
      const connection = app.connect(stream)
      this.connection = connection
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          terminal: false,
          plan: {},
          session: {},
          _meta: {
            'x.ai/incrementalBashOutput': true,
            'x.ai/bashOutputNoColor': true,
            'x.ai/gitHeadChanged': true,
          },
        },
        clientInfo: {
          name: 'grok-ui',
          title: 'Grok UI',
          version: APP_VERSION,
        },
      })
      this.agentName = initialized.agentInfo?.title || initialized.agentInfo?.name || 'Grok'
      this.agentVersion = initialized.agentInfo?.version || ''
      if (initialized.authMethods?.length) {
        const preferred = typeof initialized._meta?.defaultAuthMethodId === 'string'
          ? initialized._meta.defaultAuthMethodId
          : ''
        const method = initialized.authMethods.find((item) => item.id === preferred)
          || initialized.authMethods.find((item) => item.id === 'cached_token')
          || initialized.authMethods[0]
        await connection.agent.request(acp.methods.agent.authenticate, { methodId: method.id })
      }
      this.loadedSessions.clear()
      this.replayingSessions.clear()
      this.connected = true
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.reconnectAttempt = 0
      this.error = ''
      void connection.closed.then(() => {
        this.handleDisconnect(spawnedChild, 'Grok control channel disconnected.')
      })
    } catch (startError) {
      const detail = this.stderrTail.at(-1)
      const message = `${safeError(startError)}${detail ? ` — ${detail}` : ''}`
      if (child && this.process === child) {
        child.kill('SIGTERM')
        this.handleDisconnect(child, message)
      } else if (!this.stopping) {
        this.connected = false
        this.error = message
        this.scheduleReconnect()
      }
      throw startError
    } finally {
      this.starting = false
      this.emitSnapshot()
    }
  }

  private handleDisconnect(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.process !== child) return
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    this.process = null
    this.connection = null
    this.connected = false
    this.loadedSessions.clear()
    this.replayingSessions.clear()
    if (this.stopping) return

    this.lastDisconnectedAt = now()
    const detail = this.stderrTail.at(-1)
    this.error = `${message}${detail && !message.includes(detail) ? ` — ${detail}` : ''}`
    this.cancellationTimers.forEach((timer) => clearTimeout(timer))
    this.cancellationTimers.clear()
    this.permissions.forEach((permission) => {
      permission.resolve({ outcome: { outcome: 'cancelled' } })
    })
    this.permissions.clear()
    this.sessions = new Map([...this.sessions].map(([id, session]) => {
      if (!['starting', 'working', 'attention', 'stopping'].includes(session.state)) {
        return [id, session]
      }
      return [id, {
        ...session,
        state: 'failed',
        updatedAt: this.lastDisconnectedAt,
        stopReason: 'control_disconnected',
        error: this.error,
        cancellationStatus: session.cancellationStatus === 'none'
          ? 'none'
          : 'failed',
      }]
    }))
    this.emitSnapshot()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.connected || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.start().catch(() => {
        this.scheduleReconnect()
      })
    }, delay)
    this.emitSnapshot()
  }

  private context(): acp.ClientContext {
    if (!this.connection || !this.connected) throw new Error('Grok control channel is not connected.')
    return this.connection.agent
  }

  private async runPrompt(sessionId: string, prompt: string): Promise<void> {
    const existing = this.sessions.get(sessionId)
    if (!existing) return
    this.sessions.set(sessionId, {
      ...existing,
      state: 'working',
      updatedAt: now(),
      lastPrompt: prompt,
      stopReason: '',
      error: '',
      cancellationStatus: 'none',
      cancelRequestedAt: '',
      cancelledAt: '',
    })
    this.clearCancellationTimer(sessionId)
    this.emitSnapshot()
    try {
      const response = await this.context().request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      this.completePrompt(sessionId, response)
    } catch (promptError) {
      const session = this.sessions.get(sessionId)
      if (!session) return
      this.clearCancellationTimer(sessionId)
      if (!this.connected && session.stopReason === 'control_disconnected') return
      if (['requested', 'timed_out'].includes(session.cancellationStatus)) {
        const timestamp = now()
        this.sessions.set(sessionId, {
          ...session,
          state: 'cancelled',
          updatedAt: timestamp,
          stopReason: 'cancelled',
          error: '',
          cancellationStatus: 'confirmed',
          cancelledAt: timestamp,
        })
        this.emitSnapshot()
        return
      }
      this.sessions.set(sessionId, {
        ...session,
        state: 'failed',
        updatedAt: now(),
        error: safeError(promptError),
      })
      this.emitSnapshot()
    }
  }

  private completePrompt(sessionId: string, response: PromptResponse) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.clearCancellationTimer(sessionId)
    const timestamp = now()
    const cancelled = response.stopReason === 'cancelled'
    this.sessions.set(sessionId, {
      ...session,
      state: cancelled ? 'cancelled' : 'idle',
      updatedAt: timestamp,
      stopReason: response.stopReason,
      error: '',
      cancellationStatus: cancelled ? 'confirmed' : 'none',
      cancelledAt: cancelled ? timestamp : '',
      inputTokens: response.usage?.inputTokens || session.inputTokens,
      outputTokens: response.usage?.outputTokens || session.outputTokens,
      totalTokens: response.usage?.totalTokens || session.totalTokens,
    })
    this.emitSnapshot()
  }

  private requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const current = this.sessions.get(params.sessionId)
    if (current && ['requested', 'confirmed', 'timed_out'].includes(current.cancellationStatus)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    const id = `${params.sessionId}:${params.toolCall.toolCallId}:${Date.now()}`
    return new Promise((resolve) => {
      this.permissions.set(id, {
        resolve,
        public: {
          id,
          sessionId: params.sessionId,
          title: params.toolCall.title || 'Grok tool request',
          toolKind: params.toolCall.kind || 'other',
          toolCallId: params.toolCall.toolCallId,
          createdAt: now(),
          options: params.options.map((option) => ({
            id: option.optionId,
            name: option.name,
            kind: option.kind,
          })),
        },
      })
      const session = this.sessions.get(params.sessionId)
      if (session) {
        this.sessions.set(params.sessionId, { ...session, state: 'attention', updatedAt: now() })
      }
      this.emitSnapshot()
    })
  }

  private sessionUpdate(params: SessionNotification) {
    const session = this.sessions.get(params.sessionId)
    if (!session) return
    const update = params.update
    let next = { ...session, updatedAt: now() }
    if (update.sessionUpdate === 'session_info_update' && update.title) {
      next.title = update.title
    }
    if (update.sessionUpdate === 'usage_update') {
      next.costAmount = update.cost?.amount || next.costAmount
      next.costCurrency = update.cost?.currency || next.costCurrency
    }
    if (
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'agent_message_chunk')
      && next.cancellationStatus === 'none'
    ) {
      next.state = 'working'
    }
    let item = feedItem(update)
    if (item?.type === 'tool' && item.status === 'failed' && next.cancellationStatus === 'requested') {
      item = { ...item, status: 'cancelled' }
    }
    if (item) {
      const replayDuplicate = this.replayingSessions.has(params.sessionId)
        && next.feed.some((existing) => item.text
          ? existing.type === item.type && existing.text.trim() === item.text.trim()
          : existing.type === item.type
            && existing.title === item.title
            && existing.status === item.status)
      if (replayDuplicate) {
        this.sessions.set(params.sessionId, next)
        this.emitSnapshot()
        return
      }
      const previous = next.feed.at(-1)
      if (
        previous
        && previous.type === item.type
        && ['user', 'assistant', 'thought'].includes(item.type)
      ) {
        next.feed = [
          ...next.feed.slice(0, -1),
          { ...previous, text: `${previous.text}${item.text}`, timestamp: item.timestamp },
        ]
      } else {
        next.feed = [...next.feed, item].slice(-80)
      }
    }
    this.sessions.set(params.sessionId, next)
    this.emitSnapshot()
  }

  private workflowUpdate(params: unknown) {
    const initial = parseWorkflowNotification(params)
    if (!initial) return
    const session = this.sessions.get(initial.sessionId)
    if (!session) return
    const existing = session.workflows.find((workflow) => workflow.id === initial.run.id)
    const parsed = existing ? parseWorkflowNotification(params, existing) : initial
    if (!parsed) return
    const workflows = session.workflows.some((workflow) => workflow.id === parsed.run.id)
      ? session.workflows.map((workflow) => workflow.id === parsed.run.id ? parsed.run : workflow)
      : [parsed.run, ...session.workflows]
    this.sessions.set(session.id, {
      ...session,
      updatedAt: parsed.run.updatedAt,
      workflows: workflows.slice(0, 80),
    })
    this.emitSnapshot()
  }

  private scheduleCancellationTimeout(sessionId: string) {
    this.clearCancellationTimer(sessionId)
    const timer = setTimeout(() => {
      this.cancellationTimers.delete(sessionId)
      const session = this.sessions.get(sessionId)
      if (!session || session.cancellationStatus !== 'requested') return
      this.sessions.set(sessionId, {
        ...session,
        state: 'failed',
        updatedAt: now(),
        error: 'Grok did not confirm the stop request in time. Retry Stop or resume when the turn settles.',
        cancellationStatus: 'timed_out',
      })
      this.emitSnapshot()
    }, this.cancellationTimeoutMs)
    timer.unref()
    this.cancellationTimers.set(sessionId, timer)
  }

  private clearCancellationTimer(sessionId: string) {
    const timer = this.cancellationTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.cancellationTimers.delete(sessionId)
  }

  private emitSnapshot() {
    this.emit('control', this.snapshot())
    if (!this.sessionState) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 140)
  }

  private async persist(): Promise<void> {
    if (!this.sessionState) return
    try {
      await this.sessionState.saveManagedSessions([...this.sessions.values()])
    } catch (persistError) {
      this.error = `Unable to persist managed sessions: ${safeError(persistError)}`
    }
  }

  private validatePrompt(prompt: string) {
    if (!prompt.trim()) throw new Error('Prompt is required.')
    if (prompt.length > 32_000) throw new Error('Prompt exceeds the 32,000 character limit.')
  }

  private async validateCwd(cwd: string): Promise<string> {
    const { promises: fs } = await import('node:fs')
    const { default: path } = await import('node:path')
    const resolved = path.resolve(cwd)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('Workspace directory does not exist.')
    return resolved
  }
}
