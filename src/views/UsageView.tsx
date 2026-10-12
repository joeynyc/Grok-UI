import { ChevronDown, DatabaseZap, Download, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { downloadUsageExport } from '../api'
import { useUsageReport } from '../hooks/useUsageReport'
import { usePrivacy } from '../privacy'
import { PageIntro } from '../shell/primitives'
import type {
  UsageGroupDimension,
  UsagePeriod,
  UsageScope,
} from '../types'
import { UsageBudgets } from './UsageBudgets'
import {
  USAGE_GROUPS,
  USAGE_PERIODS,
  USAGE_SCOPES,
  costValue,
  groupCostValue,
  ledgerColumns,
  metricValue,
  periodLabel,
  sourceLabel,
  usageNote,
} from './usage-display'

export function UsageView({ refreshVersion, activityVersion }: { refreshVersion: number; activityVersion: string }) {
  const privacy = usePrivacy()
  const [period, setPeriod] = useState<UsagePeriod>('30d')
  const [scope, setScope] = useState<UsageScope>('sessions')
  const [groupBy, setGroupBy] = useState<UsageGroupDimension>('project')
  const { report, loading, error, budgets, budgetError, acceptBudgets } = useUsageReport({
    period, scope, groupBy, refreshVersion, activityVersion,
  })
  const [showFilters, setShowFilters] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const filtersOpen = showFilters || scope !== 'sessions' || groupBy !== 'project'

  const totalCost = useMemo(() => costValue(report), [report])
  const columns = useMemo(() => ledgerColumns(report?.groups || []), [report])
  const note = report ? usageNote(report, scope) : null
  const groupLabel = USAGE_GROUPS.find((item) => item.id === groupBy)?.label || 'Project'
  const visibleLabel = (label: string, key: string) => {
    if (groupBy === 'project') return privacy.workspace(label)
    if (groupBy === 'session') return privacy.sessionTitle(label, key)
    if (groupBy === 'agent') return privacy.capability(label, 'Agent')
    return label
  }
  const exportReport = (format: 'json' | 'csv') =>
    downloadUsageExport({ period, scope, groupBy, format, privacy: privacy.enabled })

  return (
    <>
      <PageIntro
        index="06"
        eyebrow="Usage"
        title={<>What this host used.</>}
        description="Token and cost totals for work last active in this window. Blank means Grok did not report cumulative usage."
      />

      <section className="usage-toolbar" aria-label="Usage report controls">
        <div>
          <span>Last active</span>
          <div className="usage-segment" role="group" aria-label="Last active window">
            {USAGE_PERIODS.map((item) => (
              <button
                key={item}
                type="button"
                className={period === item ? 'is-active' : ''}
                onClick={() => setPeriod(item)}
              >
                {periodLabel(item)}
              </button>
            ))}
          </div>
        </div>
        <div className="usage-toolbar-actions">
          <button
            type="button"
            className={filtersOpen ? 'is-active' : ''}
            aria-expanded={filtersOpen}
            onClick={() => setShowFilters((open) => !open)}
          >
            Filters <ChevronDown size={13} />
          </button>
          <button
            type="button"
            className={showExport ? 'is-active' : ''}
            aria-expanded={showExport}
            onClick={() => setShowExport((open) => !open)}
          >
            Export <ChevronDown size={13} />
          </button>
        </div>
      </section>

      {report && (
        <p className="usage-updated">
          Updated <time dateTime={report.generatedAt}>{new Date(report.generatedAt).toLocaleTimeString()}</time>
          {loading && <span> · Refreshing</span>}
        </p>
      )}

      {filtersOpen && (
        <section className="usage-filters" aria-label="Usage filters">
          <label>
            <span>Show</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as UsageScope)}>
              {USAGE_SCOPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>Group by</span>
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as UsageGroupDimension)}>
              {USAGE_GROUPS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </section>
      )}

      {showExport && (
        <section className="usage-export-actions" aria-label="Export usage">
          <button type="button" onClick={() => void exportReport('json')}><Download size={13} /> JSON</button>
          <button type="button" onClick={() => void exportReport('csv')}><Download size={13} /> CSV</button>
        </section>
      )}

      {error ? (
        <section className="usage-state is-error">
          <DatabaseZap size={22} />
          <div><strong>Usage unavailable</strong><span>{error}</span></div>
        </section>
      ) : (
        <>
          <section className="usage-total" aria-live="polite">
            <strong>{metricValue(report?.totals.totalTokens || { value: null, source: 'unavailable' })}</strong>
            <span>tokens</span>
            {totalCost && <span className="usage-total-cost">{totalCost}</span>}
            {report && report.totals.totalTokens.source !== 'unavailable' && (
              <small className={`usage-source source-${report.totals.totalTokens.source}`}>
                {sourceLabel(report.totals.totalTokens.source)}
              </small>
            )}
          </section>

          {note && <p className="usage-note" role="note">{note}</p>}

          <section className="usage-ledger section-gap">
            <header>
              <h2>By {groupLabel.toLowerCase()}</h2>
              <small>
                {loading
                  ? <><RefreshCw className="is-spinning" size={13} /> Syncing</>
                  : `${report?.groups.length || 0} ${groupLabel.toLowerCase()}${(report?.groups.length || 0) === 1 ? '' : 's'}`}
              </small>
            </header>
            {report?.groups.length ? (
              <table className="usage-table">
                <caption className="sr-only">Usage grouped by {groupLabel.toLowerCase()}</caption>
                <thead>
                  <tr>
                    <th>{groupLabel}</th>
                    <th>Sessions</th>
                    {columns.input && <th>Input</th>}
                    {columns.output && <th>Output</th>}
                    {columns.tokens && <th>Tokens</th>}
                    {columns.cost && <th>Cost</th>}
                    {columns.source && <th>Source</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.groups.map((group) => (
                    <tr key={group.key}>
                      <th scope="row">{visibleLabel(group.label, group.key)}</th>
                      <td>{group.sessions.toLocaleString()}</td>
                      {columns.input && <td>{metricValue(group.inputTokens)}</td>}
                      {columns.output && <td>{metricValue(group.outputTokens)}</td>}
                      {columns.tokens && <td><strong>{metricValue(group.totalTokens)}</strong></td>}
                      {columns.cost && <td>{groupCostValue(group)}</td>}
                      {columns.source && (
                        <td>
                          <span className={`usage-source source-${group.totalTokens.source}`}>
                            {sourceLabel(group.totalTokens.source)}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="usage-state">
                <div>
                  <strong>{loading ? 'Syncing usage' : 'No usage in this window'}</strong>
                  <span>
                    {loading
                      ? 'Reading session and workflow telemetry.'
                      : 'Try a wider last-active window.'}
                  </span>
                </div>
              </div>
            )}
          </section>

          {budgetError && <p className="usage-budget-error" role="status">{budgetError}</p>}
          <UsageBudgets
            report={report}
            period={period}
            groupBy={groupBy}
            privacy={privacy}
            budgets={budgets}
            onBudgets={acceptBudgets}
            onGroupBy={(next) => {
              setGroupBy(next)
              setShowFilters(true)
            }}
          />
        </>
      )}
    </>
  )
}
