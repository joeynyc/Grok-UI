import { constants as fsConstants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ControlSession,
  SessionRow,
  UsageBudget,
  UsageBudgetAlert,
  UsageLedgerEntry,
  UsageMetric,
  UsageSource,
  WorkflowRun,
} from './types.js'
import { interruptRestoredWorkflow } from './workflow-state.js'

export interface SessionAnnotation {
  title?: string
  archived: boolean
  updatedAt: string
}

interface PersistedState {
  version: 3
  sessions: Record<string, SessionAnnotation>
  managedSessions: ControlSession[]
  usageEntries: UsageLedgerEntry[]
  usageBudgets: UsageBudget[]
  usageAlerts: UsageBudgetAlert[]
}

const EMPTY_STATE: PersistedState = {
  version: 3,
  sessions: {},
  managedSessions: [],
  usageEntries: [],
  usageBudgets: [],
  usageAlerts: [],
}

const USAGE_SOURCES = new Set<UsageSource>([
  'grok-reported',
  'derived',
  'incomplete',
  'unavailable',
])
const MAX_USAGE_ENTRIES = 10_000
const MAX_USAGE_BUDGETS = 100
const MAX_USAGE_ALERTS = 500

function safeId(id: string): boolean {
  return Boolean(id) && /^[a-zA-Z0-9-]+$/.test(id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, limit = 512): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function normalizedDate(value: unknown): string {
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN)
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

function normalizeUsageMetric(value: unknown): UsageMetric {
  if (!value || typeof value !== 'object') return { value: null, source: 'unavailable' }
  const metric = value as Partial<UsageMetric>
  const source = USAGE_SOURCES.has(metric.source as UsageSource)
    ? metric.source as UsageSource
    : 'unavailable'
  const numeric = typeof metric.value === 'number' && Number.isFinite(metric.value) && metric.value >= 0
    ? metric.value
    : null
  return {
    value: numeric,
    source: numeric === null ? 'unavailable' : source,
  }
}

function normalizeUsageEntry(value: unknown): UsageLedgerEntry | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<UsageLedgerEntry>
  const id = boundedString(item.id)
  const sessionId = boundedString(item.sessionId)
  if (!id || !sessionId || !/^[a-zA-Z0-9:._-]+$/.test(id)) return null
  if (!['managed-session', 'cli-session', 'workflow-agent'].includes(item.kind || '')) return null
  const cost = normalizeUsageMetric(item.cost)
  return {
    id,
    kind: item.kind as UsageLedgerEntry['kind'],
    sessionId,
    sessionTitle: boundedString(item.sessionTitle, 256),
    workflowId: boundedString(item.workflowId),
    project: boundedString(item.project, 256),
    cwd: boundedString(item.cwd, 2_048),
    model: boundedString(item.model, 256),
    agent: boundedString(item.agent, 256),
    startedAt: normalizedDate(item.startedAt),
    updatedAt: normalizedDate(item.updatedAt),
    inputTokens: normalizeUsageMetric(item.inputTokens),
    outputTokens: normalizeUsageMetric(item.outputTokens),
    totalTokens: normalizeUsageMetric(item.totalTokens),
    cost: {
      ...cost,
      currency: boundedString(item.cost?.currency, 16).toUpperCase(),
    },
  }
}

function normalizeUsageBudget(value: unknown): UsageBudget | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<UsageBudget>
  const id = boundedString(item.id, 80)
  const dimension = item.dimension
  const metric = item.metric
  const period = item.period
  if (!id || !/^[a-zA-Z0-9:._-]+$/.test(id)) return null
  if (!['global', 'project', 'model', 'session', 'agent'].includes(dimension || '')) return null
  if (!['tokens', 'cost'].includes(metric || '')) return null
  if (!['24h', '7d', '30d', '90d', 'all'].includes(period || '')) return null
  const limit = Number(item.limit)
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1_000_000_000_000) return null
  const key = dimension === 'global' ? '*' : boundedString(item.key, 2_048)
  const currency = metric === 'cost' ? (boundedString(item.currency, 16) || 'USD').toUpperCase() : ''
  if (dimension !== 'global' && !key) return null
  if (metric === 'cost' && !/^[A-Z]{3,8}$/.test(currency)) return null
  return {
    id,
    dimension: dimension as UsageBudget['dimension'],
    key,
    label: boundedString(item.label, 256) || (dimension === 'global' ? 'All usage' : key.slice(0, 256)),
    metric: metric as UsageBudget['metric'],
    limit,
    period: period as UsageBudget['period'],
    currency,
    enabled: item.enabled !== false,
    createdAt: normalizedDate(item.createdAt),
    updatedAt: normalizedDate(item.updatedAt),
  }
}

function normalizeUsageAlert(value: unknown): UsageBudgetAlert | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<UsageBudgetAlert>
  const id = boundedString(item.id, 160)
  const budgetId = boundedString(item.budgetId, 80)
  const threshold = Number(item.threshold)
  const observed = Number(item.observed)
  const limit = Number(item.limit)
  if (!id || !budgetId
    || ![0.8, 1].includes(threshold)
    || !Number.isFinite(observed) || observed < 0
    || !Number.isFinite(limit) || limit <= 0) {
    return null
  }
  return {
    id,
    budgetId,
    threshold,
    observed,
    limit,
    source: USAGE_SOURCES.has(item.source as UsageSource) ? item.source as UsageSource : 'unavailable',
    periodFrom: normalizedDate(item.periodFrom),
    createdAt: normalizedDate(item.createdAt),
    acknowledgedAt: item.acknowledgedAt ? normalizedDate(item.acknowledgedAt) : '',
  }
}

function normalizeControlSession(value: unknown): ControlSession | null {
  if (!isRecord(value)) return null
  const item = value as Partial<ControlSession>
  if (typeof item.id !== 'string' || !safeId(item.id) || typeof item.cwd !== 'string') return null
  if (item.state !== undefined
    && !['working', 'starting', 'attention', 'stopping', 'idle', 'cancelled', 'failed'].includes(item.state)) return null
  for (const field of ['feed', 'workflows', 'availableModes', 'availableCommands', 'todos', 'queue']) {
    if (value[field] !== undefined && !Array.isArray(value[field])) return null
  }
  if (item.workflows?.some((workflow) => !isRecord(workflow)
    || !Array.isArray(workflow.phases) || !Array.isArray(workflow.agents)
    || workflow.phases.some((phase) => !isRecord(phase))
    || workflow.agents.some((agent) => !isRecord(agent)))) return null
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
    tokenTelemetryAvailable: item.tokenTelemetryAvailable === true
      || Number(item.inputTokens) > 0
      || Number(item.outputTokens) > 0
      || Number(item.totalTokens) > 0,
    costAmount: Number(item.costAmount) || 0,
    costCurrency: typeof item.costCurrency === 'string' ? item.costCurrency : '',
    costTelemetryAvailable: item.costTelemetryAvailable === true
      || Number(item.costAmount) > 0
      || Boolean(item.costCurrency),
    feed: Array.isArray(item.feed) ? item.feed.slice(-120) : [],
    workflows: Array.isArray(item.workflows)
      ? item.workflows
        .filter((workflow) => workflow && typeof workflow === 'object')
        .map((workflow) => interruptRestoredWorkflow(workflow as WorkflowRun))
      : [],
    permissionMode: item.permissionMode === 'auto' || item.permissionMode === 'always-approve'
      ? item.permissionMode
      : 'ask',
    planMode: item.planMode === true,
    worktree: item.worktree === true,
    parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : '',
    currentModeId: typeof item.currentModeId === 'string' ? item.currentModeId : '',
    availableModes: Array.isArray(item.availableModes) ? item.availableModes : [],
    availableCommands: Array.isArray(item.availableCommands) ? item.availableCommands : [],
    plan: item.plan && typeof item.plan === 'object' ? item.plan : null,
    todos: Array.isArray(item.todos) ? item.todos : [],
    queue: [],
    awaitingPlanApproval: false,
  }
}

// A malformed collection means the file is not ours to rewrite, but a single
// unreadable record should not keep the whole dashboard from starting. Such
// records are counted so the loader can back up the original before dropping them.
interface SkippedRecords { count: number }

function normalizeStateCollection<T>(
  value: unknown,
  normalize: (item: unknown) => T | null,
  skipped: SkippedRecords,
): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid state collection.')
  return value.flatMap((item) => {
    const normalized = normalize(item)
    if (normalized === null) {
      skipped.count += 1
      return []
    }
    return [normalized]
  })
}

function normalizeState(raw: Record<string, unknown>, skipped: SkippedRecords): PersistedState {
  if (!isRecord(raw.sessions)) throw new Error('Invalid session annotations.')
  const annotations: Record<string, SessionAnnotation> = {}
  Object.entries(raw.sessions).forEach(([id, annotation]) => {
    if (!safeId(id) || !isRecord(annotation)
      || (annotation.title !== undefined && typeof annotation.title !== 'string')
      || typeof annotation.archived !== 'boolean'
      || typeof annotation.updatedAt !== 'string') {
      skipped.count += 1
      return
    }
    annotations[id] = {
      title: annotation.title,
      archived: annotation.archived,
      updatedAt: annotation.updatedAt,
    }
  })
  // Only collections introduced after the file's version may be absent.
  const usageEntries = raw.usageEntries === undefined && raw.version === 1 ? [] : raw.usageEntries
  const usageBudgets = raw.usageBudgets === undefined && raw.version !== 3 ? [] : raw.usageBudgets
  const usageAlerts = raw.usageAlerts === undefined && raw.version !== 3 ? [] : raw.usageAlerts
  return {
    version: 3,
    sessions: annotations,
    managedSessions: normalizeStateCollection(raw.managedSessions, normalizeControlSession, skipped),
    usageEntries: normalizeStateCollection(usageEntries, normalizeUsageEntry, skipped).slice(0, MAX_USAGE_ENTRIES),
    usageBudgets: normalizeStateCollection(usageBudgets, normalizeUsageBudget, skipped).slice(0, MAX_USAGE_BUDGETS),
    usageAlerts: normalizeStateCollection(usageAlerts, normalizeUsageAlert, skipped).slice(0, MAX_USAGE_ALERTS),
  }
}

function stateLoadError(reason: string): Error {
  return new Error(`Grok UI state could not be loaded: ${reason} The existing state.json was preserved and writes are disabled. Repair the file or restore a valid backup, then restart.`)
}

export class SessionStateStore {
  readonly directory: string
  readonly file: string
  private state: PersistedState = structuredClone(EMPTY_STATE)
  private loadPromise: Promise<void> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private lastWriteError: unknown = null

  constructor(directory = process.env.GROK_UI_STATE_DIR || path.join(os.homedir(), '.grok-ui')) {
    this.directory = path.resolve(directory)
    this.file = path.join(this.directory, 'state.json')
  }

  async load(): Promise<void> {
    this.loadPromise ??= this.readState()
    await this.loadPromise
  }

  private async readState(): Promise<void> {
    let content: string
    try {
      content = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw stateLoadError('The file could not be read.')
    }
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch {
      throw stateLoadError('The file contains invalid JSON.')
    }
    if (!isRecord(raw)) throw stateLoadError('The state schema is invalid.')
    if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) {
      throw stateLoadError('The state version is unsupported by this Grok UI release.')
    }
    const skipped: SkippedRecords = { count: 0 }
    let state: PersistedState
    try {
      state = normalizeState(raw, skipped)
    } catch {
      throw stateLoadError('The state schema contains invalid collections.')
    }
    if (skipped.count > 0) {
      const backup = `${this.file}.invalid-${Date.now()}`
      try {
        await fs.copyFile(this.file, backup, fsConstants.COPYFILE_EXCL)
      } catch {
        throw stateLoadError(`The file contains ${skipped.count} invalid record(s) and a backup could not be written.`)
      }
      console.warn(`[grok-ui] Skipped ${skipped.count} invalid record(s) in ${this.file}; the original was copied to ${backup}.`)
    }
    this.state = state
  }

  annotation(id: string): SessionAnnotation | null {
    const annotation = this.state.sessions[id]
    return annotation ? { ...annotation } : null
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
    return structuredClone(this.state.managedSessions)
  }

  async annotate(
    id: string,
    patch: { title?: string; archived?: boolean },
  ): Promise<SessionAnnotation> {
    if (!safeId(id)) throw new Error('Invalid session identifier.')
    const requestedTitle = patch.title?.trim()
    const requestedArchived = patch.archived
    if (requestedTitle && requestedTitle.length > 160) throw new Error('Session title exceeds 160 characters.')
    return this.mutate((next) => {
      const existing = next.sessions[id]
      const annotation: SessionAnnotation = {
        title: requestedTitle === undefined ? existing?.title : requestedTitle || undefined,
        archived: requestedArchived === undefined ? existing?.archived === true : requestedArchived,
        updatedAt: new Date().toISOString(),
      }
      next.sessions[id] = annotation
      return { ...annotation }
    })
  }

  async saveManagedSessions(sessions: ControlSession[]): Promise<void> {
    // Persist only records the loader will accept on the next start.
    const snapshot = structuredClone(sessions)
      .map((session) => ({ ...session, feed: session.feed.slice(-120) }))
      .filter((session) => normalizeControlSession(session) !== null)
    await this.mutate((next) => { next.managedSessions = snapshot })
  }

  usageEntries(): UsageLedgerEntry[] {
    return this.state.usageEntries.map((entry) => ({
      ...entry,
      inputTokens: { ...entry.inputTokens },
      outputTokens: { ...entry.outputTokens },
      totalTokens: { ...entry.totalTokens },
      cost: { ...entry.cost },
    }))
  }

  async mergeUsageEntries(entries: UsageLedgerEntry[]): Promise<void> {
    const normalizedEntries = entries.map(normalizeUsageEntry)
      .filter((item): item is UsageLedgerEntry => item !== null)
    await this.mutate((next) => {
      const merged = new Map(next.usageEntries.map((entry) => [entry.id, entry]))
      normalizedEntries.forEach((entry) => {
        const previous = merged.get(entry.id)
        merged.set(entry.id, {
          ...previous,
          ...entry,
          startedAt: previous && previous.startedAt < entry.startedAt ? previous.startedAt : entry.startedAt,
        })
      })
      next.usageEntries = [...merged.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
        .slice(0, MAX_USAGE_ENTRIES)
    }, true)
  }

  usageBudgets(): UsageBudget[] {
    return this.state.usageBudgets.map((budget) => ({ ...budget }))
  }

  usageAlerts(): UsageBudgetAlert[] {
    return this.state.usageAlerts.map((alert) => ({ ...alert }))
  }

  async saveUsageBudgets(budgets: UsageBudget[]): Promise<void> {
    const normalized = budgets
      .map(normalizeUsageBudget)
      .filter((item): item is UsageBudget => item !== null)
      .slice(0, MAX_USAGE_BUDGETS)
    await this.mutate((next) => { next.usageBudgets = normalized })
  }

  async saveUsageAlerts(alerts: UsageBudgetAlert[]): Promise<void> {
    const normalized = alerts
      .map(normalizeUsageAlert)
      .filter((item): item is UsageBudgetAlert => item !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_USAGE_ALERTS)
    await this.mutate((next) => { next.usageAlerts = normalized })
  }

  async flush(): Promise<void> {
    await this.writeQueue
    await this.load()
    if (this.lastWriteError) throw this.lastWriteError
  }

  private async mutate<T>(change: (state: PersistedState) => T, skipUnchanged = false): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      await this.load()
      const next = structuredClone(this.state)
      const result = change(next)
      if (!skipUnchanged || JSON.stringify(next) !== JSON.stringify(this.state)) await this.persist(next)
      this.state = next
      return result
    })
    this.writeQueue = operation.then(
      () => { this.lastWriteError = null },
      (error) => { this.lastWriteError = error },
    )
    return operation
  }

  private async persist(state: PersistedState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2)
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.directory, `.state.${process.pid}.${Date.now()}.tmp`)
    let renamed = false
    try {
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.file)
      renamed = true
    } finally {
      if (!renamed) await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }
}
