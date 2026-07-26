import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionStateStore } from './session-state.js'
import { UsageLedger } from './usage-ledger.js'
import type { ControlSession, LiveAgent, SessionRow } from './types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })))
})

async function stateStore(): Promise<SessionStateStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-usage-'))
  cleanup.push(directory)
  const state = new SessionStateStore(directory)
  await state.load()
  return state
}

function row(id: string, cwd: string): SessionRow {
  return {
    id,
    title: id,
    summary: '',
    cwd,
    workspace: path.basename(cwd),
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
    model: 'grok-code',
    agent: 'Grok CLI',
    reasoningEffort: 'medium',
    sandboxProfile: 'default',
    messages: 1,
    chatMessages: 1,
    turns: 1,
    toolCalls: 0,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: 60,
    contextUsage: 0.5,
    status: 'recent',
    diskBytes: 0,
    archived: false,
  }
}

function live(session: SessionRow): LiveAgent {
  return {
    id: session.id,
    pid: process.pid,
    title: session.title,
    cwd: session.cwd,
    workspace: session.workspace,
    openedAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model,
    phase: 'idle',
    state: 'idle',
    turns: 1,
    toolCalls: 0,
    contextUsage: 0.5,
    currentTool: '',
    contextUsed: 8_000,
    contextSize: 16_000,
    costAmount: 0.04,
    costCurrency: 'usd',
    costTelemetryAvailable: true,
    feed: [],
  }
}

function managed(session: SessionRow): ControlSession {
  return {
    id: session.id,
    cwd: session.cwd,
    title: session.title,
    model: 'grok-code-fast',
    state: 'idle',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastPrompt: 'Implement it',
    stopReason: 'end_turn',
    error: '',
    cancellationStatus: 'none',
    cancelRequestedAt: '',
    cancelledAt: '',
    inputTokens: 200,
    outputTokens: 100,
    totalTokens: 300,
    tokenTelemetryAvailable: true,
    costAmount: 0.08,
    costCurrency: 'usd',
    costTelemetryAvailable: true,
    feed: [],
    workflows: [{
      id: 'workflow-1',
      controlHandle: 'runtime',
      displayName: 'runtime',
      sessionId: session.id,
      objective: 'Inspect runtime',
      foreground: false,
      status: 'running',
      phases: [],
      currentPhase: 'inspect',
      agentBudget: 4,
      agentsUsed: 1,
      agentsReserved: 0,
      agentsRemaining: 3,
      usageIncomplete: true,
      activeAgents: 1,
      currentAgentLabel: 'Inspector',
      agents: [{
        id: 'agent-1',
        label: 'Inspector',
        status: 'working',
        detail: '',
        phase: 'inspect',
        model: 'grok-code-fast',
        tokensUsed: 125,
        durationMs: 2_000,
        tokenTelemetryAvailable: true,
      }],
      totalTokens: 125,
      tokenTelemetryAvailable: true,
      elapsedMs: 2_000,
      lastEvent: 'agent_working',
      lastEventDetail: '',
      lastEventAt: session.updatedAt,
      pauseMessage: '',
      resultSummary: '',
      updatedAt: session.updatedAt,
      canPause: true,
      canResume: false,
      canStop: true,
    }],
  }
}

describe('UsageLedger', () => {
  it('normalizes existing session and workflow telemetry without treating context occupancy as usage', async () => {
    const state = await stateStore()
    const ledger = new UsageLedger(state)
    const cli = row('cli-session', '/tmp/project-a')
    const controlledRow = row('managed-session', '/tmp/project-b')
    const controlled = managed(controlledRow)

    await ledger.sync({
      sessions: [cli, controlledRow],
      live: [live(cli)],
      managed: [controlled],
    })

    const sessions = ledger.report({
      period: 'all',
      scope: 'sessions',
      groupBy: 'project',
      now: new Date('2026-07-26T10:00:00.000Z'),
    })
    expect(sessions.entries).toHaveLength(2)
    expect(sessions.entries.find((entry) => entry.sessionId === 'cli-session')).toMatchObject({
      kind: 'cli-session',
      totalTokens: { value: null, source: 'unavailable' },
      cost: { value: 0.04, source: 'grok-reported', currency: 'USD' },
    })
    expect(sessions.entries.find((entry) => entry.sessionId === 'managed-session')).toMatchObject({
      kind: 'managed-session',
      inputTokens: { value: 200, source: 'grok-reported' },
      outputTokens: { value: 100, source: 'grok-reported' },
      totalTokens: { value: 300, source: 'grok-reported' },
    })
    expect(sessions.totals.totalTokens).toEqual({ value: 300, source: 'incomplete' })
    expect(sessions.coverage).toEqual({
      'grok-reported': 1,
      derived: 0,
      incomplete: 0,
      unavailable: 1,
    })

    const agents = ledger.report({
      period: 'all',
      scope: 'workflow-agents',
      groupBy: 'agent',
      now: new Date('2026-07-26T10:00:00.000Z'),
    })
    expect(agents.groups[0]).toMatchObject({
      label: 'Inspector',
      totalTokens: { value: 125, source: 'incomplete' },
    })
    expect(agents.entries[0].totalTokens.source).toBe('incomplete')
  })

  it('persists observations atomically and restores them after a restart', async () => {
    const first = await stateStore()
    const ledger = new UsageLedger(first)
    const cli = row('durable-cli', '/tmp/durable-project')
    await ledger.sync({ sessions: [cli], live: [live(cli)], managed: [] })
    await first.flush()

    const second = new SessionStateStore(first.directory)
    await second.load()
    const restored = new UsageLedger(second).report({
      period: 'all',
      scope: 'sessions',
      groupBy: 'session',
      now: new Date('2026-07-26T10:00:00.000Z'),
    })

    expect(restored.entries).toHaveLength(1)
    expect(restored.entries[0]).toMatchObject({
      sessionId: 'durable-cli',
      project: 'durable-project',
      cost: { value: 0.04, currency: 'USD' },
    })
    const persisted = JSON.parse(await fs.readFile(first.file, 'utf8'))
    expect(persisted.version).toBe(2)
    expect((await fs.stat(first.file)).mode & 0o777).toBe(0o600)
  })

  it('loads v1 UI state and upgrades it on the next atomic write', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-usage-v1-'))
    cleanup.push(directory)
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({
      version: 1,
      sessions: {
        legacy: {
          title: 'Legacy session',
          archived: false,
          updatedAt: '2026-07-25T10:00:00.000Z',
        },
      },
      managedSessions: [],
    }), { mode: 0o600 })

    const state = new SessionStateStore(directory)
    await state.load()
    expect(state.annotation('legacy')?.title).toBe('Legacy session')
    expect(state.usageEntries()).toEqual([])

    await state.annotate('legacy', { archived: true })
    const upgraded = JSON.parse(await fs.readFile(state.file, 'utf8'))
    expect(upgraded).toMatchObject({
      version: 2,
      usageEntries: [],
    })
  })
})
