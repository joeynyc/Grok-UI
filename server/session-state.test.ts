import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionStateStore } from './session-state.js'
import type {
  ControlSession,
  LiveFeedItem,
  UsageBudget,
  UsageBudgetAlert,
  UsageLedgerEntry,
  WorkflowRun,
} from './types.js'

const cleanup: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ))
})

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(directory)
  return directory
}

// Rows that deliberately break the schema add their invalid fields here, so the
// cast stays confined to input the store is expected to reject or repair.
function malformed<T>(valid: T, invalid: Record<string, unknown>): T {
  return { ...valid, ...invalid } as T
}

function usageEntry(overrides: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    id: 'usage:entry-1',
    kind: 'managed-session',
    sessionId: 'session-1',
    sessionTitle: 'Entry title',
    workflowId: '',
    project: 'demo',
    cwd: '/tmp/demo',
    model: 'grok-build',
    agent: 'default',
    startedAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T11:00:00.000Z',
    inputTokens: { value: 100, source: 'grok-reported' },
    outputTokens: { value: 50, source: 'derived' },
    totalTokens: { value: 150, source: 'grok-reported' },
    cost: { value: 0.1, source: 'derived', currency: 'usd' },
    ...overrides,
  }
}

describe('SessionStateStore usage entries', () => {
  it('drops entries with unsafe ids, unknown kinds, or missing session ids', async () => {
    const directory = await temporary('grok-ui-usage-invalid-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.mergeUsageEntries([
      usageEntry({ id: 'usage:bad id with spaces' }),
      malformed(usageEntry({ id: 'usage:ok' }), { kind: 'unknown-kind' }),
      usageEntry({ id: 'usage:missing-session', sessionId: '' }),
      'not an object' as unknown as UsageLedgerEntry,
      usageEntry({ id: 'usage:kept.with-dots_and:colons' }),
    ])

    expect(state.usageEntries().map((entry) => entry.id)).toEqual(['usage:kept.with-dots_and:colons'])
  })

  it('keeps the earliest startedAt when merging updates for the same entry', async () => {
    const directory = await temporary('grok-ui-usage-merge-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.mergeUsageEntries([
      usageEntry({ id: 'usage:same', startedAt: '2026-07-24T10:00:00.000Z', updatedAt: '2026-07-24T11:00:00.000Z' }),
    ])
    await state.mergeUsageEntries([
      usageEntry({
        id: 'usage:same',
        sessionTitle: 'Renamed title',
        startedAt: '2026-07-23T09:00:00.000Z',
        updatedAt: '2026-07-25T12:00:00.000Z',
      }),
    ])
    await state.mergeUsageEntries([
      usageEntry({
        id: 'usage:same',
        sessionTitle: 'Final title',
        startedAt: '2026-07-26T08:00:00.000Z',
        updatedAt: '2026-07-26T13:00:00.000Z',
      }),
    ])

    const merged = state.usageEntries()
    expect(merged).toHaveLength(1)
    expect(merged[0].startedAt).toBe('2026-07-23T09:00:00.000Z')
    expect(merged[0].updatedAt).toBe('2026-07-26T13:00:00.000Z')
    expect(merged[0].sessionTitle).toBe('Final title')
  })

  it('lists entries newest first and breaks ties by id', async () => {
    const directory = await temporary('grok-ui-usage-sort-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.mergeUsageEntries([
      usageEntry({ id: 'usage:b', updatedAt: '2026-07-24T12:00:00.000Z' }),
      usageEntry({ id: 'usage:a', updatedAt: '2026-07-24T12:00:00.000Z' }),
      usageEntry({ id: 'usage:newest', updatedAt: '2026-07-25T12:00:00.000Z' }),
      usageEntry({ id: 'usage:oldest', updatedAt: '2026-07-23T12:00:00.000Z' }),
    ])

    expect(state.usageEntries().map((entry) => entry.id))
      .toEqual(['usage:newest', 'usage:a', 'usage:b', 'usage:oldest'])
  })

  it('normalizes unusable metrics to unavailable and uppercases the currency', async () => {
    const directory = await temporary('grok-ui-usage-metric-')
    const state = new SessionStateStore(directory)
    await state.load()
    await state.mergeUsageEntries([
      usageEntry({
        id: 'usage:metrics',
        inputTokens: { value: -5, source: 'grok-reported' },
        outputTokens: { value: Number.NaN, source: 'grok-reported' },
        totalTokens: malformed(usageEntry().totalTokens, { source: 'invented-source' }),
        cost: { value: 0.1, source: 'derived', currency: 'usd' },
      }),
    ])

    const [entry] = state.usageEntries()
    expect(entry.inputTokens).toEqual({ value: null, source: 'unavailable' })
    expect(entry.outputTokens).toEqual({ value: null, source: 'unavailable' })
    expect(entry.totalTokens).toEqual({ value: 150, source: 'unavailable' })
    expect(entry.cost.currency).toBe('USD')
  })

  it('persists normalized entries across a restart', async () => {
    const directory = await temporary('grok-ui-usage-persist-')
    const state = new SessionStateStore(directory)
    await state.load()
    await state.mergeUsageEntries([usageEntry({ id: 'usage:durable' })])
    await state.flush()

    const restored = new SessionStateStore(directory)
    await restored.load()
    expect(restored.usageEntries().map((entry) => entry.id)).toEqual(['usage:durable'])
    const persisted = JSON.parse(await fs.readFile(state.file, 'utf8'))
    expect(persisted.usageEntries[0].cost.currency).toBe('USD')
  })
})
function controlSession(overrides: Partial<ControlSession> = {}): ControlSession {
  return {
    id: 'session-ok-1',
    cwd: '/tmp/managed',
    title: 'Managed lane',
    model: 'grok-build',
    state: 'idle',
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T11:00:00.000Z',
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
    permissionMode: 'ask',
    planMode: false,
    worktree: false,
    parentSessionId: '',
    currentModeId: '',
    availableModes: [],
    availableCommands: [],
    plan: null,
    todos: [],
    queue: [],
    awaitingPlanApproval: false,
    ...overrides,
  }
}

/** Save sessions, then load them in a fresh store as a server restart would. */
async function roundTrip(sessions: ControlSession[]): Promise<ControlSession[]> {
  const directory = await temporary('grok-ui-managed-')
  const state = new SessionStateStore(directory)
  await state.load()
  await state.saveManagedSessions(sessions)
  const restored = new SessionStateStore(directory)
  await restored.load()
  return restored.managedSessions()
}

function byId(sessions: ControlSession[]): Record<string, ControlSession> {
  return Object.fromEntries(sessions.map((session) => [session.id, session]))
}

describe('SessionStateStore managed sessions', () => {
  it('drops sessions with invalid states, unsafe ids, or non-array collections', async () => {
    const directory = await temporary('grok-ui-managed-invalid-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.saveManagedSessions([
      malformed(controlSession({ id: 'bad-state' }), { state: 'exploded' }),
      controlSession({ id: 'not.an.id' }),
      malformed(controlSession({ id: 'bad-feed' }), { feed: 'not-an-array' }),
      malformed(controlSession({ id: 'bad-workflows' }), { workflows: { length: 1 } }),
      malformed(controlSession({ id: 'bad-todos' }), { todos: 'oops' }),
      malformed(controlSession({ id: 'bad-queue' }), { queue: 'oops' }),
      malformed(controlSession({ id: 'bad-modes' }), { availableModes: 'oops' }),
      malformed(controlSession({ id: 'bad-commands' }), { availableCommands: 42 }),
      controlSession({ id: 'ok-session' }),
    ])

    expect(state.managedSessions().map((session) => session.id)).toEqual(['ok-session'])
    const restored = new SessionStateStore(directory)
    await restored.load()
    expect(restored.managedSessions().map((session) => session.id)).toEqual(['ok-session'])
  })

  it('restores in-flight sessions as idle and records the restart reason', async () => {
    const sessions = byId(await roundTrip([
      controlSession({ id: 'was-working', state: 'working' }),
      controlSession({ id: 'was-attention', state: 'attention' }),
      controlSession({ id: 'was-idle', state: 'idle', stopReason: 'user_stopped' }),
      controlSession({ id: 'was-failed', state: 'failed' }),
    ]))

    expect(sessions['was-working']).toMatchObject({ state: 'idle', stopReason: 'server_restarted' })
    expect(sessions['was-attention']).toMatchObject({ state: 'idle', stopReason: 'server_restarted' })
    expect(sessions['was-idle']).toMatchObject({ state: 'idle', stopReason: 'user_stopped' })
    expect(sessions['was-failed']).toMatchObject({ state: 'failed', stopReason: '' })
  })

  it.each([
    { label: 'no recorded usage', overrides: {}, token: false, cost: false },
    { label: 'input tokens only', overrides: { inputTokens: 12 }, token: true, cost: false },
    { label: 'output tokens only', overrides: { outputTokens: 3 }, token: true, cost: false },
    { label: 'total tokens only', overrides: { totalTokens: 9 }, token: true, cost: false },
    { label: 'an explicit token flag without counts', overrides: { tokenTelemetryAvailable: true }, token: true, cost: false },
    { label: 'a cost currency only', overrides: { costCurrency: 'usd' }, token: false, cost: true },
    { label: 'a positive cost amount only', overrides: { costAmount: 0.25 }, token: false, cost: true },
    { label: 'an explicit cost flag without values', overrides: { costTelemetryAvailable: true }, token: false, cost: true },
  ] satisfies Array<{ label: string; overrides: Partial<ControlSession>; token: boolean; cost: boolean }>)(
    'infers telemetry availability from $label',
    async ({ overrides, token, cost }) => {
      const [session] = await roundTrip([controlSession(overrides)])

      expect(session).toMatchObject({ tokenTelemetryAvailable: token, costTelemetryAvailable: cost })
    },
  )

  it.each([
    {
      label: 'auto with plan mode and a worktree',
      session: controlSession({ permissionMode: 'auto', planMode: true, worktree: true }),
      expected: { permissionMode: 'auto', planMode: true, worktree: true },
    },
    {
      label: 'always-approve',
      session: controlSession({ permissionMode: 'always-approve' }),
      expected: { permissionMode: 'always-approve', planMode: false, worktree: false },
    },
    {
      label: 'unknown mode and non-boolean flags',
      session: malformed(controlSession(), { permissionMode: 'yolo', planMode: 'yes', worktree: 1 }),
      expected: { permissionMode: 'ask', planMode: false, worktree: false },
    },
  ])('restores permission, plan, and worktree flags for $label', async ({ session, expected }) => {
    const [restored] = await roundTrip([session])

    expect({
      permissionMode: restored.permissionMode,
      planMode: restored.planMode,
      worktree: restored.worktree,
    }).toEqual(expected)
  })

  it('caps the persisted feed at the last 120 items', async () => {
    const feed: LiveFeedItem[] = Array.from({ length: 130 }, (_, index) => ({
      id: `item-${index}`, type: 'assistant', title: 'Grok response',
      text: `line ${index}`, status: '', timestamp: '2026-07-24T10:00:00.000Z',
    }))

    const [saved] = await roundTrip([controlSession({ feed })])

    expect(saved.feed).toHaveLength(120)
    expect(saved.feed[0].id).toBe('item-10')
    expect(saved.feed.at(-1)?.id).toBe('item-129')
  })

  it('fills missing titles, timestamps, and optional fields with safe defaults', async () => {
    const restoredAt = '2026-08-01T09:30:00.000Z'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(restoredAt))

    const [session] = await roundTrip([
      malformed(controlSession({
        id: 'bare-session',
        queue: [{ id: 'queued-1', text: 'Queued prompt', createdAt: '2026-07-24T10:30:00.000Z' }],
        awaitingPlanApproval: true,
      }), {
        title: undefined, model: undefined, createdAt: undefined, updatedAt: undefined,
        lastPrompt: undefined, error: undefined, cancelledAt: 42,
        cancellationStatus: 'timed_out', permissionMode: undefined,
        parentSessionId: 7, currentModeId: null, plan: 'oops',
        availableModes: undefined, availableCommands: undefined, todos: undefined,
      }),
    ])

    expect(session).toMatchObject({
      title: 'Session bare-ses',
      model: '',
      createdAt: restoredAt,
      updatedAt: restoredAt,
      lastPrompt: '',
      error: '',
      cancellationStatus: 'none',
      cancelledAt: '',
      permissionMode: 'ask',
      parentSessionId: '',
      currentModeId: '',
      availableModes: [],
      availableCommands: [],
      todos: [],
      plan: null,
      queue: [],
      awaitingPlanApproval: false,
    })
  })

  it('coerces numeric-looking token and cost fields and zeroes unparseable ones', async () => {
    const [session] = await roundTrip([
      malformed(controlSession({ id: 'coerced', totalTokens: Number.NaN }), {
        inputTokens: '120', outputTokens: 'x', costAmount: '0.5',
      }),
    ])

    expect(session).toMatchObject({
      inputTokens: 120,
      outputTokens: 0,
      totalTokens: 0,
      costAmount: 0.5,
      tokenTelemetryAvailable: true,
      costTelemetryAvailable: true,
    })
  })

  it('interrupts running workflows on restore and keeps the session', async () => {
    const workflow: WorkflowRun = {
      id: 'wf-1', controlHandle: 'run-1', displayName: 'Run', sessionId: 'managed-workflow',
      objective: 'Do work', foreground: false, status: 'running', phases: [], currentPhase: 'build',
      agentBudget: 2, agentsUsed: 1, agentsReserved: 0, agentsRemaining: 1, usageIncomplete: false,
      activeAgents: 1, currentAgentLabel: 'Builder', agents: [], totalTokens: 0,
      tokenTelemetryAvailable: false, elapsedMs: 0, lastEvent: 'workflow_started',
      lastEventDetail: '', lastEventAt: '2026-07-24T10:01:00.000Z', pauseMessage: '',
      resultSummary: '', updatedAt: '2026-07-24T10:01:00.000Z',
      canPause: true, canResume: false, canStop: true,
    }

    const [session] = await roundTrip([
      controlSession({ id: 'managed-workflow', state: 'idle', workflows: [workflow] }),
    ])

    expect(session.workflows).toHaveLength(1)
    expect(session.workflows[0]).toMatchObject({
      status: 'interrupted', canPause: false, canResume: false, canStop: false,
    })
  })
})

function usageBudget(overrides: Partial<UsageBudget> = {}): UsageBudget {
  return {
    id: 'budget-1',
    dimension: 'project',
    key: 'demo',
    label: 'Demo budget',
    metric: 'tokens',
    limit: 1_000,
    period: '7d',
    currency: '',
    enabled: true,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    ...overrides,
  }
}

describe('SessionStateStore usage budgets', () => {
  it.each([
    { label: 'an unsupported dimension', budget: malformed(usageBudget({ id: 'rejected' }), { dimension: 'workspace' }) },
    { label: 'an unsupported metric', budget: malformed(usageBudget({ id: 'rejected' }), { metric: 'requests' }) },
    { label: 'an unsupported period', budget: malformed(usageBudget({ id: 'rejected' }), { period: '1h' }) },
    { label: 'a zero limit', budget: usageBudget({ id: 'rejected', limit: 0 }) },
    { label: 'a negative limit', budget: usageBudget({ id: 'rejected', limit: -10 }) },
    { label: 'a limit above one trillion', budget: usageBudget({ id: 'rejected', limit: 1_000_000_000_001 }) },
    { label: 'a non-numeric limit', budget: malformed(usageBudget({ id: 'rejected' }), { limit: 'a lot' }) },
    { label: 'an unsafe id', budget: usageBudget({ id: 'bad.id!' }) },
    { label: 'a scoped budget without a key', budget: usageBudget({ id: 'rejected', dimension: 'project', key: '' }) },
    {
      label: 'a cost currency longer than eight letters',
      budget: usageBudget({ id: 'rejected', dimension: 'global', metric: 'cost', currency: 'TOOOLONGGG' }),
    },
    {
      label: 'a non-alphabetic cost currency',
      budget: usageBudget({ id: 'rejected', dimension: 'global', metric: 'cost', currency: '12' }),
    },
  ])('drops a budget with $label', async ({ budget }) => {
    const directory = await temporary('grok-ui-budget-invalid-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.saveUsageBudgets([budget, usageBudget({ id: 'kept' })])

    expect(state.usageBudgets().map((saved) => saved.id)).toEqual(['kept'])
  })

  it('forces the key to * for global budgets and defaults the label', async () => {
    const directory = await temporary('grok-ui-budget-global-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.saveUsageBudgets([
      usageBudget({ id: 'global-cost', dimension: 'global', key: 'ignored', metric: 'cost', label: '', currency: 'eur' }),
      usageBudget({ id: 'scoped', dimension: 'model', key: 'grok-build', label: '' }),
    ])

    const budgets = Object.fromEntries(state.usageBudgets().map((budget) => [budget.id, budget]))
    expect(budgets['global-cost']).toMatchObject({ key: '*', label: 'All usage', currency: 'EUR' })
    expect(budgets.scoped).toMatchObject({ key: 'grok-build', label: 'grok-build', currency: '' })
  })

  it('defaults cost budgets to USD and clears the currency on token budgets', async () => {
    const directory = await temporary('grok-ui-budget-currency-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.saveUsageBudgets([
      usageBudget({ id: 'cost-default', dimension: 'global', metric: 'cost', currency: '' }),
      usageBudget({ id: 'token-currency', metric: 'tokens', currency: 'USD' }),
    ])

    const budgets = Object.fromEntries(state.usageBudgets().map((budget) => [budget.id, budget]))
    expect(budgets['cost-default'].currency).toBe('USD')
    expect(budgets['token-currency'].currency).toBe('')
  })

  it('honors explicit disabled flags and defaults missing ones to enabled', async () => {
    const directory = await temporary('grok-ui-budget-enabled-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.saveUsageBudgets([
      usageBudget({ id: 'disabled', enabled: false }),
      malformed(usageBudget({ id: 'truthy' }), { enabled: 'yes' }),
      malformed(usageBudget({ id: 'implicit' }), { enabled: undefined }),
    ])

    const budgets = Object.fromEntries(state.usageBudgets().map((budget) => [budget.id, budget]))
    expect(budgets.disabled.enabled).toBe(false)
    expect(budgets.truthy.enabled).toBe(true)
    expect(budgets.implicit.enabled).toBe(true)
  })
})

function usageAlert(overrides: Partial<UsageBudgetAlert> = {}): UsageBudgetAlert {
  return {
    id: 'alert-1',
    budgetId: 'budget-1',
    threshold: 0.8,
    observed: 850,
    limit: 1_000,
    source: 'grok-reported',
    periodFrom: '2026-07-24T10:00:00.000Z',
    createdAt: '2026-07-24T10:00:00.000Z',
    acknowledgedAt: '',
    ...overrides,
  }
}

describe('SessionStateStore usage alerts', () => {
  it('drops alerts with unsupported thresholds or non-finite numbers', async () => {
    const directory = await temporary('grok-ui-alert-invalid-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.saveUsageAlerts([
      usageAlert({ id: 'bad-threshold', threshold: 0.5 }),
      usageAlert({ id: 'negative-observed', observed: -1 }),
      usageAlert({ id: 'zero-limit', limit: 0 }),
      malformed(usageAlert({ id: 'nan-observed' }), { observed: 'high' }),
      usageAlert({ id: 'missing-budget', budgetId: '' }),
      usageAlert({ id: 'full', threshold: 1 }),
      usageAlert({ id: 'warning' }),
    ])

    expect(state.usageAlerts().map((alert) => alert.id).sort()).toEqual(['full', 'warning'])
  })

  it('sorts alerts newest first, keeps acknowledgement state, and sanitizes sources', async () => {
    const directory = await temporary('grok-ui-alert-sort-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.saveUsageAlerts([
      usageAlert({ id: 'older', createdAt: '2026-07-24T10:00:00.000Z', acknowledgedAt: '2026-07-24T12:00:00.000Z' }),
      malformed(usageAlert({ id: 'newer', createdAt: '2026-07-25T10:00:00.000Z' }), { source: 'made-up' }),
    ])

    const alerts = state.usageAlerts()
    expect(alerts.map((alert) => alert.id)).toEqual(['newer', 'older'])
    expect(alerts[0].source).toBe('unavailable')
    expect(alerts[1].acknowledgedAt).toBe('2026-07-24T12:00:00.000Z')
  })
})

describe('SessionStateStore annotations', () => {
  it('trims titles and clears empty ones', async () => {
    const directory = await temporary('grok-ui-annotate-title-')
    const state = new SessionStateStore(directory)
    await state.load()

    const annotated = await state.annotate('session-1', { title: '  Padded title  ' })
    expect(annotated.title).toBe('Padded title')
    expect(state.annotation('session-1')?.title).toBe('Padded title')

    const cleared = await state.annotate('session-1', { title: '   ' })
    expect(cleared.title).toBeUndefined()
    expect(state.annotation('session-1')?.title).toBeUndefined()
  })

  it.each([
    { length: 160, outcome: 'fulfilled', stored: 'y'.repeat(160) },
    { length: 161, outcome: 'rejected', stored: 'Existing title' },
  ])('accepts titles up to 160 characters ($length is $outcome)', async ({ length, outcome, stored }) => {
    const directory = await temporary('grok-ui-annotate-limit-')
    const state = new SessionStateStore(directory)
    await state.load()
    await state.annotate('session-1', { title: 'Existing title' })

    const [result] = await Promise.allSettled([state.annotate('session-1', { title: 'y'.repeat(length) })])

    expect(result.status).toBe(outcome)
    expect(state.annotation('session-1')?.title).toBe(stored)
  })

  it('preserves untouched fields on later patches and rejects unsafe ids', async () => {
    const directory = await temporary('grok-ui-annotate-preserve-')
    const state = new SessionStateStore(directory)
    await state.load()
    await state.annotate('session-1', { title: 'Named', archived: true })

    const titleOnly = await state.annotate('session-1', { title: 'Renamed' })
    expect(titleOnly).toMatchObject({ title: 'Renamed', archived: true })

    const archivedOnly = await state.annotate('session-1', { archived: false })
    expect(archivedOnly).toMatchObject({ title: 'Renamed', archived: false })

    await expect(state.annotate('bad id!', { title: 'nope' })).rejects.toThrow()
    await expect(state.annotate('../escape', { archived: true })).rejects.toThrow()
    expect(state.annotation('bad id!')).toBeNull()
    expect(state.annotation('../escape')).toBeNull()
  })
})

describe('SessionStateStore state versions', () => {
  it('loads a version 1 file without usage collections', async () => {
    const directory = await temporary('grok-ui-v1-state-')
    const state = new SessionStateStore(directory)
    await fs.writeFile(state.file, JSON.stringify({ version: 1, sessions: {}, managedSessions: [] }))

    await state.load()
    expect(state.usageEntries()).toEqual([])
    expect(state.usageBudgets()).toEqual([])
    expect(state.usageAlerts()).toEqual([])
  })

  it.each([
    { label: 'a version 2 file missing usageEntries', file: { version: 2, sessions: {}, managedSessions: [] } },
    {
      label: 'a version 3 file missing usageBudgets',
      file: { version: 3, sessions: {}, managedSessions: [], usageEntries: [], usageAlerts: [] },
    },
    {
      label: 'a version 3 file missing usageAlerts',
      file: { version: 3, sessions: {}, managedSessions: [], usageEntries: [], usageBudgets: [] },
    },
  ])('rejects $label without touching the file', async ({ file }) => {
    const directory = await temporary('grok-ui-state-version-')
    const state = new SessionStateStore(directory)
    const original = JSON.stringify(file)
    await fs.writeFile(state.file, original)

    await expect(state.load()).rejects.toThrow()
    expect(await fs.readFile(state.file, 'utf8')).toBe(original)
  })
})

describe('SessionStateStore apply', () => {
  it('overlays titles and archive flags onto dashboard rows', async () => {
    const directory = await temporary('grok-ui-apply-')
    const state = new SessionStateStore(directory)
    await state.load()
    await state.annotate('session-row', { title: 'Overlay title', archived: true })
    await state.annotate('untitled-row', { archived: false })

    const row = {
      id: 'session-row', title: 'Disk title', summary: '', cwd: '/tmp', workspace: 'tmp',
      createdAt: '2026-07-24T10:00:00.000Z', updatedAt: '2026-07-24T10:00:00.000Z',
      model: 'grok-build', agent: 'default', reasoningEffort: 'medium', sandboxProfile: 'default',
      messages: 0, chatMessages: 0, turns: 0, toolCalls: 0, errors: 0, filesTouched: 0,
      linesAdded: 0, linesRemoved: 0, durationSeconds: 0, contextUsage: 0,
      status: 'recent' as const, diskBytes: 0, archived: false,
    }

    expect(state.apply(row)).toMatchObject({ title: 'Overlay title', archived: true })
    expect(state.apply({ ...row, id: 'untitled-row' }).title).toBe('Disk title')
    expect(state.apply({ ...row, id: 'unannotated' })).toEqual({ ...row, id: 'unannotated' })
  })

  it('does not write a file when a merge changes nothing', async () => {
    const directory = await temporary('grok-ui-noop-merge-')
    const state = new SessionStateStore(directory)
    await state.load()

    await state.mergeUsageEntries([])

    expect(await fs.readdir(directory).catch(() => [])).toEqual([])
  })
})
