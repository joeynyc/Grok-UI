import {
  CircleDollarSign,
  DatabaseZap,
  RefreshCw,
  Sigma,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getUsageReport } from '../api'
import { usePrivacy } from '../privacy'
import type {
  UsageGroupDimension,
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

  const totalCost = useMemo(() => costValue(report), [report])
  const visibleLabel = (label: string, key: string) => {
    if (groupBy === 'project') return privacy.workspace(label)
    if (groupBy === 'session') return privacy.sessionTitle(label, key)
    if (groupBy === 'agent') return privacy.capability(label, 'Agent')
    return label
  }

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
