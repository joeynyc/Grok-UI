import { promises as fs } from 'node:fs'
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
        version: 3,
        sessions: annotations,
        managedSessions: Array.isArray(raw.managedSessions)
          ? raw.managedSessions.map(normalizeControlSession).filter((item): item is ControlSession => item !== null)
          : [],
        usageEntries: Array.isArray(raw.usageEntries)
          ? raw.usageEntries
            .map(normalizeUsageEntry)
            .filter((item): item is UsageLedgerEntry => item !== null)
            .slice(0, MAX_USAGE_ENTRIES)
          : [],
        usageBudgets: Array.isArray(raw.usageBudgets)
          ? raw.usageBudgets
            .map(normalizeUsageBudget)
            .filter((item): item is UsageBudget => item !== null)
            .slice(0, MAX_USAGE_BUDGETS)
          : [],
        usageAlerts: Array.isArray(raw.usageAlerts)
          ? raw.usageAlerts
            .map(normalizeUsageAlert)
            .filter((item): item is UsageBudgetAlert => item !== null)
            .slice(0, MAX_USAGE_ALERTS)
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
    const previousSnapshot = JSON.stringify(this.state.usageEntries)
    const merged = new Map(this.state.usageEntries.map((entry) => [entry.id, entry]))
    entries.forEach((entry) => {
      const normalized = normalizeUsageEntry(entry)
      if (!normalized) return
      const previous = merged.get(normalized.id)
      merged.set(normalized.id, {
        ...previous,
        ...normalized,
        startedAt: previous && previous.startedAt < normalized.startedAt
          ? previous.startedAt
          : normalized.startedAt,
      })
    })
    this.state.usageEntries = [...merged.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, MAX_USAGE_ENTRIES)
    if (JSON.stringify(this.state.usageEntries) === previousSnapshot) return
    await this.persist()
  }

  usageBudgets(): UsageBudget[] {
    return this.state.usageBudgets.map((budget) => ({ ...budget }))
  }

  usageAlerts(): UsageBudgetAlert[] {
    return this.state.usageAlerts.map((alert) => ({ ...alert }))
  }

  async saveUsageBudgets(budgets: UsageBudget[]): Promise<void> {
    this.state.usageBudgets = budgets
      .map(normalizeUsageBudget)
      .filter((item): item is UsageBudget => item !== null)
      .slice(0, MAX_USAGE_BUDGETS)
    await this.persist()
  }

  async saveUsageAlerts(alerts: UsageBudgetAlert[]): Promise<void> {
    this.state.usageAlerts = alerts
      .map(normalizeUsageAlert)
      .filter((item): item is UsageBudgetAlert => item !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_USAGE_ALERTS)
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
