import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionStateStore } from './session-state.js'
import { UsageBudgetManager } from './usage-budgets.js'
import { usageExport } from './usage-export.js'
import { UsageLedger } from './usage-ledger.js'
import type { UsageLedgerEntry } from './types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })))
})

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-budgets-'))
  cleanup.push(directory)
  const state = new SessionStateStore(directory)
  await state.load()
  const entry: UsageLedgerEntry = {
    id: 'usage:test',
    kind: 'managed-session',
    sessionId: 'secret-session',
    sessionTitle: 'Secret launch',
    workflowId: '',
    project: 'secret-project',
    cwd: '/private/secret-project',
    model: 'grok-code',
    agent: 'Grok UI',
    startedAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-26T10:00:00.000Z',
    inputTokens: { value: 700, source: 'grok-reported' },
    outputTokens: { value: 300, source: 'grok-reported' },
    totalTokens: { value: 1_000, source: 'grok-reported' },
    cost: { value: 12, source: 'grok-reported', currency: 'USD' },
  }
  await state.mergeUsageEntries([entry])
  const ledger = new UsageLedger(state)
  return { directory, state, ledger, manager: new UsageBudgetManager(state, ledger) }
}

describe('UsageBudgetManager', () => {
  it('persists optional budgets and deduplicates local warning and exceeded alerts', async () => {
    const { directory, manager } = await setup()
    const now = new Date('2026-07-26T12:00:00.000Z')
    await manager.upsert({
      dimension: 'global',
      metric: 'tokens',
      limit: 900,
      period: '30d',
    }, now)

    const first = await manager.snapshot(now)
    expect(first.statuses[0]).toMatchObject({
      observed: { value: 1_000, source: 'derived' },
      alertLevel: 'exceeded',
    })
    expect(first.alerts.map((alert) => alert.threshold)).toEqual([0.8, 1])

    const second = await manager.snapshot(new Date('2026-07-26T12:05:00.000Z'))
    expect(second.alerts).toHaveLength(2)

    const restoredState = new SessionStateStore(directory)
    await restoredState.load()
    const restored = await new UsageBudgetManager(restoredState, new UsageLedger(restoredState)).snapshot(now)
    expect(restored.statuses).toHaveLength(1)
    expect(restored.alerts).toHaveLength(2)
  })

  it('uses workflow-agent observations for agent budgets and reports missing targets unavailable', async () => {
    const { manager } = await setup()
    await manager.upsert({
      dimension: 'agent',
      key: 'missing-agent',
      metric: 'tokens',
      limit: 100,
      period: 'all',
    })
    const snapshot = await manager.snapshot(new Date('2026-07-26T12:00:00.000Z'))
    expect(snapshot.statuses[0]).toMatchObject({
      observed: { value: null, source: 'unavailable' },
      percent: null,
      alertLevel: 'unavailable',
    })
    expect(snapshot.alerts).toEqual([])
  })

  it('upgrades v2 ledger state to v3 without losing existing usage', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-budget-v2-'))
    cleanup.push(directory)
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({
      version: 2,
      sessions: {},
      managedSessions: [],
      usageEntries: [{
        id: 'usage:legacy',
        kind: 'managed-session',
        sessionId: 'legacy-session',
        sessionTitle: 'Legacy',
        workflowId: '',
        project: 'legacy',
        cwd: '/tmp/legacy',
        model: 'grok-code',
        agent: 'Grok UI',
        startedAt: '2026-07-25T10:00:00.000Z',
        updatedAt: '2026-07-26T10:00:00.000Z',
        inputTokens: { value: 5, source: 'grok-reported' },
        outputTokens: { value: 5, source: 'grok-reported' },
        totalTokens: { value: 10, source: 'grok-reported' },
        cost: { value: null, source: 'unavailable', currency: '' },
      }],
    }), { mode: 0o600 })
    const state = new SessionStateStore(directory)
    await state.load()
    const ledger = new UsageLedger(state)
    const manager = new UsageBudgetManager(state, ledger)
    await manager.upsert({
      dimension: 'global',
      metric: 'tokens',
      limit: 20,
      period: 'all',
    })

    expect(ledger.report({ period: 'all' }).entries).toHaveLength(1)
    const persisted = JSON.parse(await fs.readFile(state.file, 'utf8'))
    expect(persisted).toMatchObject({
      version: 3,
      usageEntries: [{ id: 'usage:legacy' }],
      usageBudgets: [{ metric: 'tokens', limit: 20 }],
      usageAlerts: [],
    })
  })
})

describe('usageExport', () => {
  it('redacts sensitive report dimensions before producing JSON or CSV', async () => {
    const { ledger } = await setup()
    const report = ledger.report({
      period: 'all',
      scope: 'sessions',
      groupBy: 'project',
      now: new Date('2026-07-26T12:00:00.000Z'),
    })
    const json = usageExport(report, 'json', true)
    const csv = usageExport(report, 'csv', true)
    expect(json.body).toContain('"privacyApplied": true')
    expect(json.body).not.toContain('secret-project')
    expect(json.body).not.toContain('Secret launch')
    expect(csv.body).not.toContain('/private/secret-project')
    expect(csv.body).toContain('Workspace ')
  })
})
