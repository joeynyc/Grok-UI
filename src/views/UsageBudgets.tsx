import { BellRing, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  acknowledgeUsageAlert,
  deleteUsageBudget,
  getUsageBudgets,
  saveUsageBudget,
} from '../api'
import type { PrivacyTools } from '../privacy'
import type {
  UsageBudgetDimension,
  UsageBudgetMetric,
  UsageBudgetSnapshot,
  UsageGroupDimension,
  UsagePeriod,
  UsageReport,
} from '../types'
import { USAGE_PERIODS, periodLabel, sourceLabel } from './usage-display'

export function UsageBudgets({
  report,
  period,
  groupBy,
  privacy,
  budgets,
  onBudgets,
  onGroupBy,
}: {
  report: UsageReport | null
  period: UsagePeriod
  groupBy: UsageGroupDimension
  privacy: PrivacyTools
  budgets: UsageBudgetSnapshot | null
  onBudgets: (snapshot: UsageBudgetSnapshot) => void
  onGroupBy: (dimension: UsageGroupDimension) => void
}) {
  const [open, setOpen] = useState(false)
  const [dimension, setDimension] = useState<UsageBudgetDimension>('global')
  const [key, setKey] = useState('')
  const [metric, setMetric] = useState<UsageBudgetMetric>('tokens')
  const [limit, setLimit] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [limitPeriod, setLimitPeriod] = useState<UsagePeriod>(period)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const statuses = budgets?.statuses || []
  const alerts = (budgets?.alerts || []).filter((alert) => !alert.acknowledgedAt)

  const openForm = () => {
    setLimitPeriod(period)
    setOpen(true)
  }

  const create = async () => {
    const value = Number(limit)
    if (!Number.isFinite(value) || value <= 0) return
    setBusy(true)
    try {
      const result = await saveUsageBudget({
        dimension,
        key: dimension === 'global' ? undefined : key,
        label: dimension === 'global'
          ? 'All usage'
          : report?.groups.find((group) => group.key === key)?.label || key,
        metric,
        limit: value,
        period: limitPeriod,
        currency: metric === 'cost' ? currency : undefined,
      })
      onBudgets(result.snapshot)
      setLimit('')
      setKey('')
      setError('')
      setOpen(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save usage budget.')
    } finally {
      setBusy(false)
    }
  }

  if (!statuses.length && !open && !alerts.length) {
    return (
      <button type="button" className="usage-set-limit" onClick={openForm}>
        Set a limit
      </button>
    )
  }

  return (
    <section className="usage-budget-panel section-gap">
      {statuses.length > 0 && (
        <>
          <header>
            <h2>Limits</h2>
            {alerts.length > 0 && (
              <small><BellRing size={13} /> {alerts.length} active</small>
            )}
          </header>
          <div className="usage-budget-list">
            {statuses.map((status) => {
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
                    <small>{status.budget.dimension} · {periodLabel(status.budget.period)} · {sourceLabel(status.observed.source)}</small>
                  </span>
                  <span>
                    <strong>{observed}</strong>
                    <small>of {status.budget.limit.toLocaleString()} {status.budget.metric === 'cost' ? status.budget.currency : 'tokens'}</small>
                  </span>
                  <span className="usage-budget-meter"><i style={{ width: `${Math.min((status.percent || 0) * 100, 100)}%` }} /></span>
                  <button
                    aria-label={`Delete budget ${budgetLabel}`}
                    onClick={() => void deleteUsageBudget(status.budget.id)
                      .then(() => getUsageBudgets())
                      .then(onBudgets)}
                  ><Trash2 size={14} /></button>
                </article>
              )
            })}
          </div>
        </>
      )}

      {alerts.length > 0 && (
        <div className="usage-alert-list">
          {alerts.map((alert) => (
            <button key={alert.id} onClick={() => void acknowledgeUsageAlert(alert.id).then(onBudgets)}>
              <BellRing size={14} />
              <span>{Math.round(alert.threshold * 100)}% threshold reached · {alert.observed.toLocaleString()} observed</span>
              <small>Acknowledge</small>
            </button>
          ))}
        </div>
      )}

      {open ? (
        <>
          <div className="usage-budget-form">
            <label>
              <span>Scope</span>
              <select value={dimension} onChange={(event) => {
                const next = event.target.value as UsageBudgetDimension
                setDimension(next)
                setKey('')
                if (next !== 'global') onGroupBy(next)
              }}>
                {(['global', 'project', 'model', 'session', 'agent'] as UsageBudgetDimension[])
                  .map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            {dimension !== 'global' && (
              <label>
                <span>Target</span>
                <select value={key} onChange={(event) => setKey(event.target.value)}>
                  <option value="">Select {dimension}</option>
                  {groupBy === dimension && report?.groups.map((group) =>
                    <option key={group.key} value={group.key}>
                      {dimension === 'project'
                        ? privacy.workspace(group.label)
                        : dimension === 'session'
                          ? privacy.sessionTitle(group.label, group.key)
                          : dimension === 'agent'
                            ? privacy.capability(group.label, 'Agent')
                            : group.label}
                    </option>)}
                </select>
              </label>
            )}
            <label>
              <span>Metric</span>
              <select value={metric} onChange={(event) => setMetric(event.target.value as UsageBudgetMetric)}>
                <option value="tokens">Tokens</option>
                <option value="cost">Reported cost</option>
              </select>
            </label>
            <label>
              <span>Window</span>
              <select value={limitPeriod} onChange={(event) => setLimitPeriod(event.target.value as UsagePeriod)}>
                {USAGE_PERIODS.map((item) => <option key={item} value={item}>{periodLabel(item)}</option>)}
              </select>
            </label>
            <label>
              <span>Limit</span>
              <input type="number" min="0.0001" step="any" value={limit} onChange={(event) => setLimit(event.target.value)} />
            </label>
            {metric === 'cost' && (
              <label>
                <span>Currency</span>
                <input maxLength={16} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
              </label>
            )}
            <button
              className="usage-budget-add"
              disabled={busy || !limit || (dimension !== 'global' && !key)}
              onClick={() => void create()}
            >
              <Plus size={14} /> Add budget
            </button>
            <button type="button" className="usage-set-limit" onClick={() => {
              setOpen(false)
              setError('')
            }}>
              Cancel
            </button>
          </div>
          {error && <p className="usage-budget-error">{error}</p>}
        </>
      ) : (
        <button className="usage-set-limit" onClick={openForm}>
          {statuses.length ? 'Add a limit' : 'Set a limit'}
        </button>
      )}
    </section>
  )
}
