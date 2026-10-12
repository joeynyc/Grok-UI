import type {
  UsageMetric,
  UsagePeriod,
  UsageReport,
  UsageReportGroup,
  UsageScope,
  UsageSource,
} from '../types'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const USAGE_PERIODS: UsagePeriod[] = ['24h', '7d', '30d', '90d', 'all']
export const USAGE_SCOPES: Array<{ id: UsageScope; label: string }> = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'workflow-agents', label: 'Workflow agents' },
  { id: 'all', label: 'Session + agent mix' },
]
export const USAGE_GROUPS: Array<{ id: UsageReport['groupBy']; label: string }> = [
  { id: 'project', label: 'Project' },
  { id: 'model', label: 'Model' },
  { id: 'session', label: 'Session' },
  { id: 'agent', label: 'Agent' },
]

export function metricValue(metric: UsageMetric): string {
  if (metric.value === null) return '—'
  return metric.value >= 10_000 ? compact.format(metric.value) : metric.value.toLocaleString()
}

export function costValue(report: UsageReport | null): string | null {
  if (!report) return null
  const costs = report.totals.costs.filter((cost) => cost.value !== null)
  if (!costs.length) return null
  return costs.map((cost) =>
    `${cost.value?.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${cost.currency}`,
  ).join(' + ')
}

export function allUnavailable(report: UsageReport): boolean {
  return (report.coverage['grok-reported'] || 0)
    + (report.coverage.derived || 0)
    + (report.coverage.incomplete || 0) === 0
}

export function sourceLabel(source: UsageSource): string {
  if (source === 'grok-reported') return 'Reported'
  if (source === 'derived') return 'Derived'
  if (source === 'incomplete') return 'Incomplete'
  return 'Unavailable'
}

export function periodLabel(period: UsagePeriod): string {
  return period === 'all' ? 'All' : period.toUpperCase()
}

export interface LedgerColumns {
  tokens: boolean
  input: boolean
  output: boolean
  cost: boolean
  source: boolean
}

export function ledgerColumns(groups: UsageReportGroup[]): LedgerColumns {
  return {
    tokens: groups.some((group) => group.totalTokens.value !== null),
    input: groups.some((group) => group.inputTokens.value !== null),
    output: groups.some((group) => group.outputTokens.value !== null),
    cost: groups.some((group) => group.costs.some((item) => item.value !== null)),
    source: groups.some((group) => group.totalTokens.source !== 'unavailable'),
  }
}

export function groupCostValue(group: UsageReportGroup): string {
  const costs = group.costs.filter((cost) => cost.value !== null)
  if (!costs.length) return '—'
  return costs.map((cost) =>
    `${cost.value?.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${cost.currency}`,
  ).join(' + ')
}

export function usageNote(report: UsageReport, scope: UsageScope): string | null {
  if (scope === 'all') {
    return 'Session totals and workflow-agent rows can describe the same work, so this mix is incomplete.'
  }
  if (!report.entries.length) return null
  if (allUnavailable(report)) {
    return 'Terminal sessions don’t report cumulative tokens or cost. Totals appear for sessions started from Grok UI.'
  }
  const missing = report.coverage.unavailable || 0
  if (missing > 0) {
    return 'Some sessions are CLI-only and have no cumulative usage, so this total is incomplete.'
  }
  return null
}
