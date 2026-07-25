import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ControlSession, SessionRow, WorkflowRun } from './types.js'
import { interruptRestoredWorkflow } from './workflow-state.js'

export interface SessionAnnotation {
  title?: string
  archived: boolean
  updatedAt: string
}

interface PersistedState {
  version: 1
  sessions: Record<string, SessionAnnotation>
  managedSessions: ControlSession[]
}

const EMPTY_STATE: PersistedState = {
  version: 1,
  sessions: {},
  managedSessions: [],
}

function safeId(id: string): boolean {
  return Boolean(id) && /^[a-zA-Z0-9-]+$/.test(id)
}

function normalizeControlSession(value: unknown): ControlSession | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<ControlSession>
  if (!item.id || !safeId(item.id) || typeof item.cwd !== 'string') return null
  const restoredState = ['working', 'starting', 'attention', 'stopping'].includes(item.state || '')
    ? 'idle'
    : item.state || 'idle'
  return {
    id: item.id,
    cwd: item.cwd,
    title: typeof item.title === 'string' ? item.title : `Session ${item.id.slice(0, 8)}`,
    model: typeof item.model === 'string' ? item.model : '',
    state: restoredState,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    lastPrompt: typeof item.lastPrompt === 'string' ? item.lastPrompt : '',
    stopReason: ['working', 'starting', 'attention', 'stopping'].includes(item.state || '')
      ? 'server_restarted'
      : typeof item.stopReason === 'string' ? item.stopReason : '',
    error: typeof item.error === 'string' ? item.error : '',
    cancellationStatus: item.cancellationStatus === 'confirmed' ? 'confirmed' : 'none',
    cancelRequestedAt: typeof item.cancelRequestedAt === 'string' ? item.cancelRequestedAt : '',
    cancelledAt: typeof item.cancelledAt === 'string' ? item.cancelledAt : '',
    inputTokens: Number(item.inputTokens) || 0,
    outputTokens: Number(item.outputTokens) || 0,
    totalTokens: Number(item.totalTokens) || 0,
    costAmount: Number(item.costAmount) || 0,
    costCurrency: typeof item.costCurrency === 'string' ? item.costCurrency : '',
    feed: Array.isArray(item.feed) ? item.feed.slice(-120) : [],
    workflows: Array.isArray(item.workflows)
      ? item.workflows
        .filter((workflow) => workflow && typeof workflow === 'object')
        .map((workflow) => interruptRestoredWorkflow(workflow as WorkflowRun))
      : [],
  }
}

export class SessionStateStore {
  readonly directory: string
  readonly file: string
  private state: PersistedState = structuredClone(EMPTY_STATE)
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(directory = process.env.GROK_UI_STATE_DIR || path.join(os.homedir(), '.grok-ui')) {
    this.directory = path.resolve(directory)
    this.file = path.join(this.directory, 'state.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PersistedState>
      const annotations: Record<string, SessionAnnotation> = {}
      Object.entries(raw.sessions || {}).forEach(([id, value]) => {
        if (!safeId(id) || !value || typeof value !== 'object') return
        const annotation = value as Partial<SessionAnnotation>
        annotations[id] = {
          title: typeof annotation.title === 'string' ? annotation.title : undefined,
          archived: annotation.archived === true,
          updatedAt: typeof annotation.updatedAt === 'string'
            ? annotation.updatedAt
            : new Date().toISOString(),
        }
      })
      this.state = {
        version: 1,
        sessions: annotations,
        managedSessions: Array.isArray(raw.managedSessions)
          ? raw.managedSessions.map(normalizeControlSession).filter((item): item is ControlSession => item !== null)
          : [],
      }
    } catch {
      this.state = structuredClone(EMPTY_STATE)
    }
    this.loaded = true
  }

  annotation(id: string): SessionAnnotation | null {
    return this.state.sessions[id] || null
  }

  apply(row: SessionRow): SessionRow {
    const annotation = this.annotation(row.id)
    if (!annotation) return row
    return {
      ...row,
      title: annotation.title || row.title,
      archived: annotation.archived,
    }
  }

  managedSessions(): ControlSession[] {
    return this.state.managedSessions.map((session) => ({
      ...session,
      feed: [...session.feed],
      workflows: session.workflows.map((workflow) => ({
        ...workflow,
        phases: workflow.phases.map((phase) => ({ ...phase })),
        agents: workflow.agents.map((agent) => ({ ...agent })),
      })),
    }))
  }

  async annotate(
    id: string,
    patch: { title?: string; archived?: boolean },
  ): Promise<SessionAnnotation> {
    if (!safeId(id)) throw new Error('Invalid session identifier.')
    const existing = this.annotation(id)
    const title = patch.title === undefined ? existing?.title : patch.title.trim()
    if (title && title.length > 160) throw new Error('Session title exceeds 160 characters.')
    const annotation: SessionAnnotation = {
      title: title || undefined,
      archived: patch.archived === undefined ? existing?.archived === true : patch.archived,
      updatedAt: new Date().toISOString(),
    }
    this.state.sessions[id] = annotation
    await this.persist()
    return annotation
  }

  async saveManagedSessions(sessions: ControlSession[]): Promise<void> {
    this.state.managedSessions = sessions.map((session) => ({
      ...session,
      feed: session.feed.slice(-120),
      workflows: session.workflows.map((workflow) => ({
        ...workflow,
        phases: workflow.phases.map((phase) => ({ ...phase })),
        agents: workflow.agents.map((agent) => ({ ...agent })),
      })),
    }))
    await this.persist()
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = path.join(this.directory, `.state.${process.pid}.${Date.now()}.tmp`)
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.file)
    })
    await this.writeQueue
  }
}
