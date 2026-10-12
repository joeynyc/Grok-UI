import { describe, expect, it } from 'vitest'
import type { UsageReport, UsageReportGroup } from '../types'
import {
  allUnavailable,
  costValue,
  ledgerColumns,
  metricValue,
  usageNote,
} from './usage-display'

function metric(value: number | null, source: UsageReportGroup['totalTokens']['source'] = 'unavailable') {
  return { value, source }
}

function group(partial: Partial<UsageReportGroup> = {}): UsageReportGroup {
  return {
    key: 'demo',
    label: 'demo',
    entries: 1,
    sessions: 1,
    inputTokens: metric(null),
    outputTokens: metric(null),
    totalTokens: metric(null),
    costs: [{ ...metric(null), currency: '' }],
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...partial,
  }
}

function report(partial: Partial<UsageReport> = {}): UsageReport {
  const totals = partial.totals || group({ key: 'all', label: 'All usage' })
  return {
    generatedAt: '2026-09-12T00:00:00.000Z',
    period: '30d',
    scope: 'sessions',
    from: '2026-08-13T00:00:00.000Z',
    to: '2026-09-12T00:00:00.000Z',
    groupBy: 'project',
    entries: [{ id: 'usage:1' } as UsageReport['entries'][number]],
    totals,
    groups: [group()],
    coverage: { 'grok-reported': 0, derived: 0, incomplete: 0, unavailable: 1 },
    ...partial,
  }
}

describe('usage display', () => {
  it('hides empty ledger columns and shows them when a row has a value', () => {
    expect(ledgerColumns([group()])).toEqual({
      tokens: false,
      input: false,
      output: false,
      cost: false,
      source: false,
    })
    expect(ledgerColumns([group({
      inputTokens: metric(20, 'grok-reported'),
      outputTokens: metric(10, 'grok-reported'),
      totalTokens: metric(30, 'grok-reported'),
      costs: [{ value: 0.4, source: 'grok-reported', currency: 'USD' }],
    })])).toEqual({
      tokens: true,
      input: true,
      output: true,
      cost: true,
      source: true,
    })
  })

  it('explains blank CLI totals and mixed coverage without inventing spend', () => {
    expect(allUnavailable(report())).toBe(true)
    expect(usageNote(report(), 'sessions')).toMatch(/don’t report cumulative tokens/i)
    expect(usageNote(report({
      totals: group({ totalTokens: metric(300, 'incomplete') }),
      coverage: { 'grok-reported': 1, derived: 0, incomplete: 0, unavailable: 3 },
    }), 'sessions')).toMatch(/incomplete/i)
    expect(usageNote(report(), 'all')).toMatch(/same work/i)
    expect(costValue(report())).toBeNull()
    expect(metricValue(metric(null))).toBe('—')
    expect(metricValue(metric(16, 'grok-reported'))).toBe('16')
  })
})
