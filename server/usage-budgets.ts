import crypto from 'node:crypto'
import type {
  UsageBudget,
  UsageBudgetAlert,
  UsageBudgetDimension,
  UsageBudgetMetric,
  UsageBudgetSnapshot,
  UsageMetric,
  UsagePeriod,
  UsageReport,
  UsageReportGroup,
  UsageScope,
} from './types.js'
import { SessionStateStore } from './session-state.js'
import { UsageLedger } from './usage-ledger.js'

export interface UsageBudgetInput {
  id?: string
  dimension: UsageBudgetDimension
  key?: string
  label?: string
  metric: UsageBudgetMetric
  limit: number
  period: UsagePeriod
  currency?: string
  enabled?: boolean
}

function safeId(): string {
  return `budget:${crypto.randomUUID()}`
}

function scopeFor(dimension: UsageBudgetDimension): UsageScope {
  return dimension === 'agent' ? 'workflow-agents' : 'sessions'
}

function reportFor(ledger: UsageLedger, budget: UsageBudget, now: Date): UsageReport {
  return ledger.report({
    period: budget.period,
    scope: scopeFor(budget.dimension),
    groupBy: budget.dimension === 'global' ? 'project' : budget.dimension,
    now,
  })
}

function selectedGroup(report: UsageReport, budget: UsageBudget): UsageReportGroup | null {
  if (budget.dimension === 'global') return report.totals
  return report.groups.find((group) => group.key === budget.key) || null
}

function observedMetric(group: UsageReportGroup | null, budget: UsageBudget): UsageMetric {
  if (!group) return { value: null, source: 'unavailable' }
  if (budget.metric === 'tokens') return group.totalTokens
  const cost = group.costs.find((item) => item.currency === budget.currency)
  return cost
    ? { value: cost.value, source: cost.source }
    : { value: null, source: 'unavailable' }
}

function alertId(budgetId: string, threshold: number, budgetUpdatedAt: string): string {
  const digest = crypto.createHash('sha256')
    .update(`${budgetId}\u0000${threshold}\u0000${budgetUpdatedAt}`)
    .digest('base64url')
    .slice(0, 24)
  return `alert:${digest}`
}

export class UsageBudgetManager {
  constructor(
    private readonly state: SessionStateStore,
    private readonly ledger: UsageLedger,
  ) {}

  async upsert(input: UsageBudgetInput, now = new Date()): Promise<UsageBudget> {
    const dimension = input.dimension
    if (!['global', 'project', 'model', 'session', 'agent'].includes(dimension)) {
      throw new Error('Budget dimension must be global, project, model, session, or agent.')
    }
    if (!['tokens', 'cost'].includes(input.metric)) {
      throw new Error('Budget metric must be tokens or cost.')
    }
    if (!['24h', '7d', '30d', '90d', 'all'].includes(input.period)) {
      throw new Error('Budget period must be 24h, 7d, 30d, 90d, or all.')
    }
    const limit = Number(input.limit)
    if (!Number.isFinite(limit) || limit <= 0 || limit > 1_000_000_000_000) {
      throw new Error('Budget limit must be greater than zero.')
    }
    const key = dimension === 'global' ? '*' : String(input.key || '').trim().slice(0, 2_048)
    if (dimension !== 'global' && !key) throw new Error('A target key is required for this budget.')
    const currency = input.metric === 'cost'
      ? String(input.currency || 'USD').trim().slice(0, 16).toUpperCase()
      : ''
    if (input.metric === 'cost' && !/^[A-Z]{3,8}$/.test(currency)) {
      throw new Error('Budget currency must be a 3–8 letter code.')
    }
    const budgets = this.state.usageBudgets()
    const existing = input.id ? budgets.find((budget) => budget.id === input.id) : undefined
    if (input.id && !existing) throw new Error('Budget not found.')
    const timestamp = now.toISOString()
    const budget: UsageBudget = {
      id: existing?.id || safeId(),
      dimension,
      key,
      label: String(input.label || '').trim().slice(0, 256)
        || (dimension === 'global' ? 'All usage' : key.slice(0, 256)),
      metric: input.metric,
      limit,
      period: input.period,
      currency,
      enabled: input.enabled !== false,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    }
    const next = existing
      ? budgets.map((item) => item.id === budget.id ? budget : item)
      : [budget, ...budgets]
    await this.state.saveUsageBudgets(next)
    return budget
  }

  async remove(id: string): Promise<boolean> {
    const budgets = this.state.usageBudgets()
    if (!budgets.some((budget) => budget.id === id)) return false
    await this.state.saveUsageBudgets(budgets.filter((budget) => budget.id !== id))
    await this.state.saveUsageAlerts(this.state.usageAlerts().filter((alert) => alert.budgetId !== id))
    return true
  }

  async acknowledge(alertIdToAcknowledge: string, now = new Date()): Promise<boolean> {
    const alerts = this.state.usageAlerts()
    if (!alerts.some((alert) => alert.id === alertIdToAcknowledge)) return false
    await this.state.saveUsageAlerts(alerts.map((alert) =>
      alert.id === alertIdToAcknowledge
        ? { ...alert, acknowledgedAt: now.toISOString() }
        : alert))
    return true
  }

  async snapshot(now = new Date()): Promise<UsageBudgetSnapshot> {
    const budgets = this.state.usageBudgets()
    const statuses = budgets.map((budget) => {
      const report = reportFor(this.ledger, budget, now)
      const observed = observedMetric(selectedGroup(report, budget), budget)
      const percent = observed.value === null ? null : observed.value / budget.limit
      return {
        budget,
        observed,
        percent,
        alertLevel: observed.value === null
          ? 'unavailable' as const
          : percent! >= 1 ? 'exceeded' as const
            : percent! >= 0.8 ? 'warning' as const
              : 'none' as const,
        periodFrom: report.from,
        periodTo: report.to,
      }
    })

    const existing = this.state.usageAlerts()
    const alertsById = new Map(existing.map((alert) => [alert.id, alert]))
    statuses.filter((status) => status.budget.enabled && status.observed.value !== null).forEach((status) => {
      ;[0.8, 1].forEach((threshold) => {
        if (status.percent! < threshold) return
        const id = alertId(status.budget.id, threshold, status.budget.updatedAt)
        if (alertsById.has(id)) return
        const alert: UsageBudgetAlert = {
          id,
          budgetId: status.budget.id,
          threshold,
          observed: status.observed.value!,
          limit: status.budget.limit,
          source: status.observed.source,
          periodFrom: status.periodFrom,
          createdAt: now.toISOString(),
          acknowledgedAt: '',
        }
        alertsById.set(id, alert)
      })
    })
    const alerts = [...alertsById.values()]
      .filter((alert) => budgets.some((budget) => budget.id === alert.budgetId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    if (JSON.stringify(alerts) !== JSON.stringify(existing)) await this.state.saveUsageAlerts(alerts)

    return {
      generatedAt: now.toISOString(),
      statuses,
      alerts,
    }
  }
}
