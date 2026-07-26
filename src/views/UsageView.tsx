import {
  CircleDollarSign,
  DatabaseZap,
  Download,
  BellRing,
  Plus,
  RefreshCw,
  Sigma,
  Trash2,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  acknowledgeUsageAlert,
  deleteUsageBudget,
  downloadUsageExport,
  getUsageBudgets,
  getUsageReport,
  saveUsageBudget,
} from '../api'
import { usePrivacy } from '../privacy'
import type {
  UsageGroupDimension,
  UsageBudgetDimension,
  UsageBudgetMetric,
  UsageBudgetSnapshot,
  UsageMetric,
  UsagePeriod,
  UsageReport,
  UsageScope,
  UsageSource,
} from '../types'

const PERIODS: UsagePeriod[] = ['24h', '7d', '30d', '90d', 'all']
const SCOPES: Array<{ id: UsageScope; label: string }> = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'workflow-agents', label: 'Workflow agents' },
  { id: 'all', label: 'All observations' },
]
const GROUPS: UsageGroupDimension[] = ['project', 'model', 'session', 'agent']
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

function metricValue(metric: UsageMetric): string {
  if (metric.value === null) return '—'
  return metric.value >= 10_000 ? compact.format(metric.value) : metric.value.toLocaleString()
}

function sourceLabel(source: UsageSource): string {
  return source === 'grok-reported' ? 'Grok-reported' : source
}

function costValue(report: UsageReport | null): string {
  if (!report) return '—'
  const costs = report.totals.costs.filter((cost) => cost.value !== null)
  if (!costs.length) return '—'
  return costs.map((cost) =>
    `${cost.value?.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${cost.currency}`,
  ).join(' + ')
}

export function UsageView() {
  const privacy = usePrivacy()
  const [period, setPeriod] = useState<UsagePeriod>('30d')
  const [scope, setScope] = useState<UsageScope>('sessions')
  const [groupBy, setGroupBy] = useState<UsageGroupDimension>('project')
  const [report, setReport] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [budgets, setBudgets] = useState<UsageBudgetSnapshot | null>(null)
  const [budgetDimension, setBudgetDimension] = useState<UsageBudgetDimension>('global')
  const [budgetKey, setBudgetKey] = useState('')
  const [budgetMetric, setBudgetMetric] = useState<UsageBudgetMetric>('tokens')
  const [budgetLimit, setBudgetLimit] = useState('')
  const [budgetCurrency, setBudgetCurrency] = useState('USD')
  const [budgetBusy, setBudgetBusy] = useState(false)
  const [budgetError, setBudgetError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getUsageReport({ period, scope, groupBy })
      .then((next) => {
        if (cancelled) return
        setReport(next)
        setError('')
      })
      .catch((requestError) => {
        if (cancelled) return
        setError(requestError instanceof Error ? requestError.message : 'Unable to read usage ledger.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, scope, groupBy])

  useEffect(() => {
    void getUsageBudgets().then(setBudgets).catch(() => {
      // The report remains useful if optional budget state cannot be loaded.
    })
  }, [report?.generatedAt])

  const totalCost = useMemo(() => costValue(report), [report])
  const visibleLabel = (label: string, key: string) => {
    if (groupBy === 'project') return privacy.workspace(label)
    if (groupBy === 'session') return privacy.sessionTitle(label, key)
    if (groupBy === 'agent') return privacy.capability(label, 'Agent')
    return label
  }
  const refreshBudgets = async () => setBudgets(await getUsageBudgets())
  const createBudget = async () => {
    const limit = Number(budgetLimit)
    if (!Number.isFinite(limit) || limit <= 0) return
    setBudgetBusy(true)
    try {
      const result = await saveUsageBudget({
        dimension: budgetDimension,
        key: budgetDimension === 'global' ? undefined : budgetKey,
        label: budgetDimension === 'global'
          ? 'All usage'
          : report?.groups.find((group) => group.key === budgetKey)?.label || budgetKey,
        metric: budgetMetric,
        limit,
        period,
        currency: budgetMetric === 'cost' ? budgetCurrency : undefined,
      })
      setBudgets(result.snapshot)
      setBudgetLimit('')
      setBudgetKey('')
      setBudgetError('')
    } catch (requestError) {
      setBudgetError(requestError instanceof Error ? requestError.message : 'Unable to save usage budget.')
    } finally {
      setBudgetBusy(false)
    }
  }
  const exportReport = (format: 'json' | 'csv') =>
    downloadUsageExport({ period, scope, groupBy, format, privacy: privacy.enabled })

  return (
    <>
      <header className="page-intro">
        <div className="intro-index">08 / 11</div>
        <div>
          <div className="kicker">Persistent usage ledger</div>
          <h1>Know what was used,<br /><em>and how we know.</em></h1>
        </div>
        <p>
          Durable token and cost observations across CLI sessions, managed sessions, and workflow agents,
          with provenance attached to every value.
        </p>
        <div className="intro-rule"><span /></div>
      </header>

      <section className="usage-toolbar" aria-label="Usage report controls">
        <div>
          <span>Period</span>
          <div className="usage-segment">
            {PERIODS.map((item) => (
              <button key={item} className={period === item ? 'is-active' : ''} onClick={() => setPeriod(item)}>
                {item.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span>Scope</span>
          <select value={scope} onChange={(event) => setScope(event.target.value as UsageScope)}>
            {SCOPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div>
          <span>Group by</span>
          <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as UsageGroupDimension)}>
            {GROUPS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        <div className="usage-export-actions">
          <span>Export</span>
          <div>
            <button onClick={() => void exportReport('json')}><Download size={13} /> JSON</button>
            <button onClick={() => void exportReport('csv')}><Download size={13} /> CSV</button>
          </div>
        </div>
      </section>

      {error ? (
        <section className="usage-state is-error">
          <DatabaseZap size={22} />
          <div><strong>Usage ledger unavailable</strong><span>{error}</span></div>
        </section>
      ) : (
        <>
          <section className="usage-summary">
            <UsageMetricCard
              icon={Sigma}
              label="Total tokens"
              value={metricValue(report?.totals.totalTokens || { value: null, source: 'unavailable' })}
              source={report?.totals.totalTokens.source || 'unavailable'}
            />
            <UsageMetricCard
              icon={CircleDollarSign}
              label="Reported cost"
              value={totalCost}
              source={report?.totals.costs.some((cost) => cost.source === 'incomplete')
                ? 'incomplete'
                : report?.totals.costs.some((cost) => cost.value !== null) ? 'derived' : 'unavailable'}
            />
            <UsageMetricCard
              icon={WalletCards}
              label="Observations"
              value={report ? report.entries.length.toLocaleString() : '—'}
              source={report?.entries.length ? 'derived' : 'unavailable'}
            />
            <article className="usage-coverage-card">
              <span>Telemetry coverage</span>
              <div>
                {(['grok-reported', 'derived', 'incomplete', 'unavailable'] as UsageSource[]).map((source) => (
                  <small key={source}>
                    <i className={`usage-source-dot source-${source}`} />
                    {sourceLabel(source)}
                    <strong>{report?.coverage[source] || 0}</strong>
                  </small>
                ))}
              </div>
            </article>
          </section>

          <section className="usage-ledger section-gap">
            <header>
              <div>
                <span>08A / REPORT</span>
                <h2>{groupBy[0].toUpperCase() + groupBy.slice(1)} ledger</h2>
              </div>
              <small>{loading ? <><RefreshCw className="is-spinning" size={13} /> Syncing observations</> : `${report?.groups.length || 0} groups`}</small>
            </header>
            <div className="usage-table usage-table-head" aria-hidden="true">
              <span>{groupBy}</span><span>Sessions</span><span>Input</span><span>Output</span><span>Total</span><span>Source</span>
            </div>
            {report?.groups.length ? report.groups.map((group) => (
              <article className="usage-table usage-table-row" key={group.key}>
                <span>
                  <strong>{visibleLabel(group.label, group.key)}</strong>
                  <small>{group.entries} observation{group.entries === 1 ? '' : 's'}</small>
                </span>
                <span>{group.sessions.toLocaleString()}</span>
                <span>{metricValue(group.inputTokens)}</span>
                <span>{metricValue(group.outputTokens)}</span>
                <span><strong>{metricValue(group.totalTokens)}</strong></span>
                <span className={`usage-source source-${group.totalTokens.source}`}>
                  {sourceLabel(group.totalTokens.source)}
                </span>
              </article>
            )) : (
              <div className="usage-state">
                <DatabaseZap size={22} />
                <div>
                  <strong>{loading ? 'Syncing usage observations' : 'No usage in this window'}</strong>
                  <span>
                    {loading
                      ? 'Reading the existing session and workflow telemetry.'
                      : 'Try a wider period or another observation scope.'}
                  </span>
                </div>
              </div>
            )}
          </section>

          <section className="usage-budget-panel section-gap">
            <header>
              <div>
                <span>08B / GUARDRAILS</span>
                <h2>Local budgets & alerts</h2>
              </div>
              <small><BellRing size={13} /> {budgets?.alerts.filter((alert) => !alert.acknowledgedAt).length || 0} active alerts</small>
            </header>
            <div className="usage-budget-form">
              <label>
                <span>Scope</span>
                <select value={budgetDimension} onChange={(event) => {
                  const next = event.target.value as UsageBudgetDimension
                  setBudgetDimension(next)
                  setBudgetKey('')
                  if (next !== 'global') setGroupBy(next)
                }}>
                  {(['global', 'project', 'model', 'session', 'agent'] as UsageBudgetDimension[])
                    .map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              {budgetDimension !== 'global' && (
                <label>
                  <span>Target</span>
                  <select
                    value={budgetKey}
                    onChange={(event) => setBudgetKey(event.target.value)}
                  >
                    <option value="">Select {budgetDimension}</option>
                    {groupBy === budgetDimension && report?.groups.map((group) =>
                      <option key={group.key} value={group.key}>{visibleLabel(group.label, group.key)}</option>)}
                  </select>
                </label>
              )}
              <label>
                <span>Metric</span>
                <select value={budgetMetric} onChange={(event) => setBudgetMetric(event.target.value as UsageBudgetMetric)}>
                  <option value="tokens">Tokens</option>
                  <option value="cost">Reported cost</option>
                </select>
              </label>
              <label>
                <span>Limit</span>
                <input type="number" min="0.0001" step="any" value={budgetLimit} onChange={(event) => setBudgetLimit(event.target.value)} />
              </label>
              {budgetMetric === 'cost' && (
                <label>
                  <span>Currency</span>
                  <input maxLength={16} value={budgetCurrency} onChange={(event) => setBudgetCurrency(event.target.value.toUpperCase())} />
                </label>
              )}
              <button
                className="usage-budget-add"
                disabled={budgetBusy || !budgetLimit || (budgetDimension !== 'global' && !budgetKey)}
                onClick={() => void createBudget()}
              >
                <Plus size={14} /> Add budget
              </button>
            </div>
            <p className="usage-budget-note">
              Evaluated locally against non-overlapping {budgetDimension === 'agent' ? 'workflow-agent' : 'session'} observations.
              Alerts fire once at 80% and 100% for each reporting window.
            </p>
            {budgetError && <p className="usage-budget-error">{budgetError}</p>}
            <div className="usage-budget-list">
              {budgets?.statuses.length ? budgets.statuses.map((status) => {
                const budgetLabel = status.budget.dimension === 'project'
                  ? privacy.workspace(status.budget.label)
                  : status.budget.dimension === 'session'
                    ? privacy.sessionTitle(status.budget.label, status.budget.key)
                    : status.budget.dimension === 'agent'
                      ? privacy.capability(status.budget.label, 'Agent')
                      : status.budget.label
                const observed = status.observed.value === null
                  ? 'Unavailable'
                  : `${status.observed.value.toLocaleString()}${status.budget.metric === 'cost' ? ` ${status.budget.currency}` : ' tokens'}`
                return (
                  <article key={status.budget.id} className={`usage-budget-row is-${status.alertLevel}`}>
                    <span>
                      <strong>{budgetLabel}</strong>
                      <small>{status.budget.dimension} · {status.budget.period.toUpperCase()} · {sourceLabel(status.observed.source)}</small>
                    </span>
                    <span>
                      <strong>{observed}</strong>
                      <small>of {status.budget.limit.toLocaleString()} {status.budget.metric === 'cost' ? status.budget.currency : 'tokens'}</small>
                    </span>
                    <span className="usage-budget-meter"><i style={{ width: `${Math.min((status.percent || 0) * 100, 100)}%` }} /></span>
                    <button
                      aria-label={`Delete budget ${budgetLabel}`}
                      onClick={() => void deleteUsageBudget(status.budget.id).then(refreshBudgets)}
                    ><Trash2 size={14} /></button>
                  </article>
                )
              }) : (
                <div className="usage-state">
                  <BellRing size={22} />
                  <div><strong>No budgets configured</strong><span>Budgets are optional and never leave this host.</span></div>
                </div>
              )}
            </div>
            {budgets?.alerts.some((alert) => !alert.acknowledgedAt) && (
              <div className="usage-alert-list">
                {budgets.alerts.filter((alert) => !alert.acknowledgedAt).map((alert) => (
                  <button key={alert.id} onClick={() => void acknowledgeUsageAlert(alert.id).then(setBudgets)}>
                    <BellRing size={14} />
                    <span>{Math.round(alert.threshold * 100)}% threshold reached · {alert.observed.toLocaleString()} observed</span>
                    <small>Acknowledge</small>
                  </button>
                ))}
              </div>
            )}
          </section>

          {scope === 'all' && (
            <p className="usage-scope-note">
              “All observations” mixes session totals with workflow-agent detail. Grok UI labels mixed rollups
              incomplete so the same work is never presented as a precise spend total.
            </p>
          )}
        </>
      )}
    </>
  )
}

function UsageMetricCard({
  icon: Icon,
  label,
  value,
  source,
}: {
  icon: LucideIcon
  label: string
  value: string
  source: UsageSource
}) {
  return (
    <article className="usage-metric-card">
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={`usage-source source-${source}`}>{sourceLabel(source)}</small>
    </article>
  )
}
