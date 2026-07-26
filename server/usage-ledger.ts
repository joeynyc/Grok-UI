import crypto from 'node:crypto'
import path from 'node:path'
import type {
  ControlSession,
  LiveAgent,
  SessionRow,
  UsageCostMetric,
  UsageGroupDimension,
  UsageLedgerEntry,
  UsageMetric,
  UsagePeriod,
  UsageReport,
  UsageReportGroup,
  UsageScope,
  UsageSource,
} from './types.js'
import { SessionStateStore } from './session-state.js'

interface UsageInputs {
  sessions: SessionRow[]
  live: LiveAgent[]
  managed: ControlSession[]
}

interface UsageReportOptions {
  period?: UsagePeriod
  scope?: UsageScope
  groupBy?: UsageGroupDimension
  now?: Date
}

const PERIODS: Record<Exclude<UsagePeriod, 'all'>, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '90d': 90 * 24 * 60 * 60_000,
}

function unavailable(): UsageMetric {
  return { value: null, source: 'unavailable' }
}

function observed(value: number, available: boolean, incomplete = false): UsageMetric {
  if (!available || !Number.isFinite(value) || value < 0) return unavailable()
  return {
    value,
    source: incomplete ? 'incomplete' : 'grok-reported',
  }
}

function safeDate(value: string, fallback: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function stableId(...parts: string[]): string {
  const digest = crypto.createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 24)
  return `usage:${digest}`
}

function projectName(cwd: string): string {
  return path.basename(cwd) || cwd || 'Unknown project'
}

function sessionEntry(
  session: SessionRow,
  live: LiveAgent | undefined,
  managed: ControlSession | undefined,
): UsageLedgerEntry {
  if (managed) {
    return {
      id: stableId('session', session.id),
      kind: 'managed-session',
      sessionId: session.id,
      sessionTitle: managed.title || session.title,
      workflowId: '',
      project: projectName(managed.cwd || session.cwd),
      cwd: managed.cwd || session.cwd,
      model: managed.model || session.model || 'unknown',
      agent: 'Grok UI',
      startedAt: safeDate(managed.createdAt, session.createdAt),
      updatedAt: safeDate(managed.updatedAt, session.updatedAt),
      inputTokens: observed(managed.inputTokens, managed.tokenTelemetryAvailable),
      outputTokens: observed(managed.outputTokens, managed.tokenTelemetryAvailable),
      totalTokens: observed(managed.totalTokens, managed.tokenTelemetryAvailable),
      cost: {
        ...observed(managed.costAmount, managed.costTelemetryAvailable),
        currency: managed.costCurrency.toUpperCase(),
      },
    }
  }

  const cwd = live?.cwd || session.cwd
  return {
    id: stableId('session', session.id),
    kind: 'cli-session',
    sessionId: session.id,
    sessionTitle: session.title,
    workflowId: '',
    project: projectName(cwd),
    cwd,
    model: live?.model || session.model || 'unknown',
    agent: session.agent || 'Grok CLI',
    startedAt: safeDate(live?.openedAt || session.createdAt, session.createdAt),
    updatedAt: safeDate(live?.updatedAt || session.updatedAt, session.updatedAt),
    inputTokens: unavailable(),
    outputTokens: unavailable(),
    // Live context occupancy is not cumulative usage and must not be counted as spend.
    totalTokens: unavailable(),
    cost: {
      ...observed(live?.costAmount || 0, live?.costTelemetryAvailable === true),
      currency: (live?.costCurrency || '').toUpperCase(),
    },
  }
}

function syntheticRow(session: ControlSession): SessionRow {
  return {
    id: session.id,
    title: session.title,
    summary: '',
    cwd: session.cwd,
    workspace: projectName(session.cwd),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model,
    agent: 'Grok UI',
    reasoningEffort: '',
    sandboxProfile: '',
    messages: 0,
    chatMessages: 0,
    turns: 0,
    toolCalls: 0,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: 0,
    contextUsage: 0,
    status: 'recent',
    diskBytes: 0,
    archived: false,
  }
}

function workflowEntries(session: ControlSession): UsageLedgerEntry[] {
  return session.workflows.flatMap((workflow) =>
    workflow.agents
      .map((agent): UsageLedgerEntry => ({
        id: stableId('workflow-agent', session.id, workflow.id, agent.id),
        kind: 'workflow-agent',
        sessionId: session.id,
        sessionTitle: session.title,
        workflowId: workflow.id,
        project: projectName(session.cwd),
        cwd: session.cwd,
        model: agent.model || session.model || 'unknown',
        agent: agent.label || agent.id || 'Workflow agent',
        startedAt: safeDate(session.createdAt, new Date(0).toISOString()),
        updatedAt: safeDate(workflow.updatedAt, session.updatedAt),
        inputTokens: unavailable(),
        outputTokens: unavailable(),
        totalTokens: observed(
          agent.tokensUsed,
          agent.tokenTelemetryAvailable,
          workflow.usageIncomplete,
        ),
        cost: { ...unavailable(), currency: '' },
      })),
  )
}

function metricAggregate(entries: UsageLedgerEntry[], select: (entry: UsageLedgerEntry) => UsageMetric): UsageMetric {
  if (!entries.length) return unavailable()
  const metrics = entries.map(select)
  const values = metrics.flatMap((metric) => metric.value === null ? [] : [metric.value])
  if (!values.length) return unavailable()
  const incomplete = metrics.some((metric) =>
    metric.source === 'incomplete' || metric.source === 'unavailable')
  const mixesObservationLevels = entries.some((entry) => entry.kind === 'workflow-agent')
    && entries.some((entry) => entry.kind !== 'workflow-agent')
  return {
    value: values.reduce((sum, value) => sum + value, 0),
    source: incomplete || mixesObservationLevels ? 'incomplete' : 'derived',
  }
}

function costAggregate(entries: UsageLedgerEntry[]): UsageCostMetric[] {
  const currencies = [...new Set(entries.map((entry) => entry.cost.currency).filter(Boolean))].sort()
  if (!currencies.length) return [{ ...unavailable(), currency: '' }]
  return currencies.map((currency) => {
    const matching = entries.filter((entry) => entry.cost.currency === currency)
    const values = matching.flatMap((entry) => entry.cost.value === null ? [] : [entry.cost.value])
    const missing = entries.some((entry) =>
      entry.cost.currency !== currency || entry.cost.value === null || entry.cost.source === 'incomplete')
    return {
      value: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      source: values.length ? missing ? 'incomplete' : 'derived' : 'unavailable',
      currency,
    }
  })
}

function groupValue(entry: UsageLedgerEntry, dimension: UsageGroupDimension): { key: string; label: string } {
  if (dimension === 'project') return { key: entry.cwd || entry.project, label: entry.project }
  if (dimension === 'model') return { key: entry.model || 'unknown', label: entry.model || 'Unknown model' }
  if (dimension === 'session') {
    return { key: entry.sessionId, label: entry.sessionTitle || entry.sessionId }
  }
  return { key: entry.agent || 'unknown', label: entry.agent || 'Unknown agent' }
}

function summarize(key: string, label: string, entries: UsageLedgerEntry[]): UsageReportGroup {
  return {
    key,
    label,
    entries: entries.length,
    sessions: new Set(entries.map((entry) => entry.sessionId)).size,
    inputTokens: metricAggregate(entries, (entry) => entry.inputTokens),
    outputTokens: metricAggregate(entries, (entry) => entry.outputTokens),
    totalTokens: metricAggregate(entries, (entry) => entry.totalTokens),
    costs: costAggregate(entries),
    updatedAt: entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, ''),
  }
}

export class UsageLedger {
  constructor(private readonly state: SessionStateStore) {}

  async sync(inputs: UsageInputs): Promise<void> {
    const managedById = new Map(inputs.managed.map((session) => [session.id, session]))
    const liveById = new Map(inputs.live.map((session) => [session.id, session]))
    const sessionsById = new Map(inputs.sessions.map((session) => [session.id, session]))
    inputs.managed.forEach((session) => {
      if (!sessionsById.has(session.id)) sessionsById.set(session.id, syntheticRow(session))
    })
    inputs.live.forEach((session) => {
      if (!sessionsById.has(session.id)) {
        sessionsById.set(session.id, {
          ...syntheticRow({
            id: session.id,
            cwd: session.cwd,
            title: session.title,
            model: session.model,
            state: 'idle',
            createdAt: session.openedAt,
            updatedAt: session.updatedAt,
            lastPrompt: '',
            stopReason: '',
            error: '',
            cancellationStatus: 'none',
            cancelRequestedAt: '',
            cancelledAt: '',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            tokenTelemetryAvailable: false,
            costAmount: 0,
            costCurrency: '',
            costTelemetryAvailable: false,
            feed: [],
            workflows: [],
          }),
          agent: 'Grok CLI',
          status: 'live',
        })
      }
    })

    const entries = [...sessionsById.values()].map((session) =>
      sessionEntry(session, liveById.get(session.id), managedById.get(session.id)))
    entries.push(...inputs.managed.flatMap(workflowEntries))
    await this.state.mergeUsageEntries(entries)
  }

  report(options: UsageReportOptions = {}): UsageReport {
    const period = options.period || '30d'
    const scope = options.scope || 'sessions'
    const groupBy = options.groupBy || 'project'
    const now = options.now || new Date()
    const to = now.toISOString()
    const from = period === 'all'
      ? new Date(0).toISOString()
      : new Date(now.getTime() - PERIODS[period]).toISOString()
    const entries = this.state.usageEntries()
      .filter((entry) => entry.updatedAt >= from && entry.updatedAt <= to)
      .filter((entry) => scope === 'all'
        || (scope === 'workflow-agents') === (entry.kind === 'workflow-agent'))

    const grouped = new Map<string, { label: string; entries: UsageLedgerEntry[] }>()
    entries.forEach((entry) => {
      const value = groupValue(entry, groupBy)
      const current = grouped.get(value.key) || { label: value.label, entries: [] }
      current.entries.push(entry)
      grouped.set(value.key, current)
    })
    const groups = [...grouped.entries()]
      .map(([key, value]) => summarize(key, value.label, value.entries))
      .sort((left, right) =>
        (right.totalTokens.value || 0) - (left.totalTokens.value || 0)
        || right.updatedAt.localeCompare(left.updatedAt)
        || left.label.localeCompare(right.label))
    const coverage: Record<UsageSource, number> = {
      'grok-reported': 0,
      derived: 0,
      incomplete: 0,
      unavailable: 0,
    }
    entries.forEach((entry) => {
      coverage[entry.totalTokens.source] += 1
    })

    return {
      generatedAt: new Date().toISOString(),
      period,
      scope,
      from,
      to,
      groupBy,
      entries,
      totals: summarize('all', 'All usage', entries),
      groups,
      coverage,
    }
  }
}
