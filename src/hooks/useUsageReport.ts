import { useCallback, useEffect, useRef, useState } from 'react'
import { getUsageBudgets, getUsageReport } from '../api'
import type { UsageBudgetSnapshot, UsageGroupDimension, UsagePeriod, UsageReport, UsageScope } from '../types'

/** Usage owns its report's freshness; the shell's connection is not a report timestamp. */
export function useUsageReport({ period, scope, groupBy, refreshVersion, activityVersion }: {
  period: UsagePeriod
  scope: UsageScope
  groupBy: UsageGroupDimension
  refreshVersion: number
  activityVersion: string
}) {
  const key = `${period}:${scope}:${groupBy}`
  const [result, setResult] = useState<{ key: string; report: UsageReport } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [budgets, setBudgets] = useState<UsageBudgetSnapshot | null>(null)
  const [budgetError, setBudgetError] = useState('')
  const budgetRevision = useRef(0)
  const scheduleLiveRefresh = useRef<() => void>(() => {})
  const previousActivity = useRef(activityVersion)

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | null = null
    let running = false
    let pending = false
    const schedule = () => {
      pending = true
      if (running || timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        void refresh()
      }, 1_000)
    }
    const refresh = async () => {
      running = true
      pending = false
      const currentBudgetRevision = ++budgetRevision.current
      setLoading(true)
      setError('')
      const reportRequest = getUsageReport({ period, scope, groupBy }, controller.signal)
        .then((report) => {
          if (!controller.signal.aborted) setResult({ key, report })
        })
        .catch((requestError) => {
          if (!controller.signal.aborted) {
            setError(requestError instanceof Error ? requestError.message : 'Unable to read usage ledger.')
          }
        })
      const budgetRequest = getUsageBudgets(controller.signal)
        .then((snapshot) => {
          if (controller.signal.aborted || budgetRevision.current !== currentBudgetRevision) return
          setBudgets(snapshot)
          setBudgetError('')
        })
        .catch(() => {
          if (!controller.signal.aborted && budgetRevision.current === currentBudgetRevision) {
            setBudgetError('Unable to refresh local limits.')
          }
        })
      await Promise.all([reportRequest, budgetRequest])
      if (controller.signal.aborted) return
      running = false
      setLoading(false)
      if (pending) schedule()
    }
    // Live events coalesce behind an active request, so slow responses can finish.
    scheduleLiveRefresh.current = schedule
    void refresh()
    return () => {
      scheduleLiveRefresh.current = () => {}
      if (timer !== null) window.clearTimeout(timer)
      controller.abort()
    }
  }, [key, period, scope, groupBy, refreshVersion])

  useEffect(() => {
    if (previousActivity.current !== activityVersion) scheduleLiveRefresh.current()
    previousActivity.current = activityVersion
  }, [activityVersion])

  const acceptBudgets = useCallback((snapshot: UsageBudgetSnapshot) => {
    // A response started before a budget edit must not overwrite the saved edit.
    budgetRevision.current += 1
    setBudgets(snapshot)
    setBudgetError('')
  }, [])

  return {
    report: result?.key === key ? result.report : null,
    loading,
    error,
    budgets,
    budgetError,
    acceptBudgets,
  }
}
