import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeSessionFeed, SessionReader } from './session-reader.js'
import { SessionStateStore } from './session-state.js'
import { GrokStore } from './grok-store.js'
import type { ControlSession } from './types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ))
})

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(directory)
  return directory
}

function managedSession(state: ControlSession['state'] = 'working'): ControlSession {
  return {
    id: 'session-durable-1',
    cwd: '/tmp/durable',
    title: 'Durable managed lane',
    model: 'grok-build',
    state,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:01:00.000Z',
    lastPrompt: 'Continue the work',
    stopReason: '',
    error: '',
    cancellationStatus: 'none',
    cancelRequestedAt: '',
    cancelledAt: '',
    inputTokens: 120,
    outputTokens: 80,
    totalTokens: 200,
    tokenTelemetryAvailable: true,
    costAmount: 0.02,
    costCurrency: 'USD',
    costTelemetryAvailable: true,
    workflows: [{
      id: 'workflow-durable-1',
      controlHandle: 'durable-run',
      displayName: 'durable-run',
      sessionId: 'session-durable-1',
      objective: 'Complete durable work',
      foreground: false,
      status: 'running',
      phases: [],
      currentPhase: 'build',
      agentBudget: 4,
      agentsUsed: 2,
      agentsReserved: 0,
      agentsRemaining: 2,
      usageIncomplete: false,
      activeAgents: 1,
      currentAgentLabel: 'Builder',
      agents: [],
      totalTokens: 0,
      tokenTelemetryAvailable: false,
      elapsedMs: 0,
      lastEvent: 'workflow_started',
      lastEventDetail: '',
      lastEventAt: '2026-07-24T10:01:00.000Z',
      pauseMessage: '',
      resultSummary: '',
      updatedAt: '2026-07-24T10:01:00.000Z',
      canPause: true,
      canResume: false,
      canStop: true,
    }],
    feed: [{
      id: 'feed-1',
      type: 'assistant',
      title: 'Grok response',
      text: 'Persistent response',
      status: '',
      timestamp: '2026-07-24T10:01:00.000Z',
    }],
  }
}

describe('Session workbench state', () => {
  it.each([
    ['malformed JSON', '{"version":3,"sessions":'],
    ['future version', JSON.stringify({ version: 4, sessions: { saved: { title: 'Keep me' } } })],
    ['invalid root', 'null'],
    ['missing v3 collections', JSON.stringify({ version: 3, sessions: {}, managedSessions: [] })],
    ['invalid annotations', JSON.stringify({ version: 1, sessions: [], managedSessions: [] })],
    ['invalid usage collection', JSON.stringify({ version: 2, sessions: {}, managedSessions: [], usageEntries: {} })],
  ])('preserves %s and blocks subsequent writes', async (_label, original) => {
    const directory = await temporary('grok-ui-invalid-state-')
    const state = new SessionStateStore(directory)
    await fs.writeFile(state.file, original)

    await expect(state.load()).rejects.toThrow(/state.*preserved.*writes.*disabled/i)
    await expect(state.load()).rejects.toThrow(/restart/i)
    await expect(state.saveManagedSessions([])).rejects.toThrow(/preserved/i)
    await expect(state.annotate('new-session', { title: 'Must not be saved' })).rejects.toThrow(/preserved/i)
    await expect(state.mergeUsageEntries([])).rejects.toThrow(/preserved/i)
    await expect(state.saveUsageBudgets([])).rejects.toThrow(/preserved/i)
    await expect(state.saveUsageAlerts([])).rejects.toThrow(/preserved/i)
    await expect(state.flush()).rejects.toThrow(/preserved/i)

    expect(await fs.readFile(state.file, 'utf8')).toBe(original)
    expect(state.annotation('new-session')).toBeNull()
    expect(await fs.readdir(directory)).toEqual(['state.json'])
  })

  it.each([
    ['invalid annotation', { version: 1, sessions: { saved: { title: 42 } }, managedSessions: [managedSession()] }],
    ['invalid managed session', { version: 1, sessions: {}, managedSessions: [{}, managedSession()] }],
    ['invalid workflow', { version: 1, sessions: {}, managedSessions: [{ ...managedSession(), id: 'broken', workflows: [{}] }, managedSession()] }],
    ['invalid usage entry', { version: 2, sessions: {}, managedSessions: [managedSession()], usageEntries: [{}] }],
  ])('skips an %s, keeps valid neighbours, and backs up the original', async (_label, payload) => {
    const directory = await temporary('grok-ui-invalid-record-')
    const state = new SessionStateStore(directory)
    const original = JSON.stringify(payload)
    await fs.writeFile(state.file, original)

    await state.load()
    expect(state.managedSessions().map((session) => session.id)).toEqual([managedSession().id])
    expect(state.usageEntries()).toEqual([])
    const backups = (await fs.readdir(directory)).filter((name) => name.startsWith('state.json.invalid-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(directory, backups[0]), 'utf8')).toBe(original)

    await state.annotate('new-session', { title: 'Saved after recovery' })
    expect(state.annotation('new-session')?.title).toBe('Saved after recovery')
  })

  it('does not persist a managed session the loader would reject', async () => {
    const directory = await temporary('grok-ui-unloadable-session-')
    const state = new SessionStateStore(directory)
    await state.saveManagedSessions([{ ...managedSession(), id: 'bad.id' }, managedSession()])

    const reloaded = new SessionStateStore(directory)
    await reloaded.load()
    expect(reloaded.managedSessions().map((session) => session.id)).toEqual([managedSession().id])
    expect(await fs.readdir(directory)).toEqual(['state.json'])
  })

  it('rejects an unreadable state path without replacing it', async () => {
    const directory = await temporary('grok-ui-unreadable-state-')
    const state = new SessionStateStore(directory)
    await fs.mkdir(state.file)
    await fs.writeFile(path.join(state.file, 'preserved'), 'existing content')

    await expect(state.load()).rejects.toThrow(/preserved/i)
    await expect(state.annotate('new-session', { archived: true })).rejects.toThrow(/preserved/i)
    expect(await fs.readFile(path.join(state.file, 'preserved'), 'utf8')).toBe('existing content')
    expect(state.annotation('new-session')).toBeNull()
  })

  it('checks existing state before a mutation even when load was not called', async () => {
    const directory = await temporary('grok-ui-unloaded-state-')
    const state = new SessionStateStore(directory)
    const original = '{broken-state'
    await fs.writeFile(state.file, original)

    await expect(state.saveManagedSessions([])).rejects.toThrow(/preserved/i)
    expect(await fs.readFile(state.file, 'utf8')).toBe(original)
  })

  it('reports recovery guidance without exposing invalid state contents', async () => {
    const directory = await temporary('grok-ui-private-state-')
    const state = new SessionStateStore(directory)
    await fs.writeFile(state.file, 'private-session-content is not JSON')

    await expect(state.load()).rejects.toThrow(/repair.*backup.*restart/i)
    await expect(state.load()).rejects.not.toThrow('private-session-content')
  })

  it('upgrades an unchanged legacy session snapshot on save', async () => {
    const directory = await temporary('grok-ui-legacy-state-')
    const state = new SessionStateStore(directory)
    await fs.writeFile(state.file, JSON.stringify({ version: 1, sessions: {}, managedSessions: [] }))
    await state.load()
    await state.saveManagedSessions([])

    expect(JSON.parse(await fs.readFile(state.file, 'utf8'))).toMatchObject({
      version: 3,
      usageEntries: [],
      usageBudgets: [],
      usageAlerts: [],
    })
  })

  it('recovers from a failed write without publishing or later persisting the failed mutation', async () => {
    const directory = await temporary('grok-ui-write-recovery-')
    const state = new SessionStateStore(directory)
    await state.load()
    await state.annotate('saved-session', { title: 'Saved title' })
    const original = await fs.readFile(state.file, 'utf8')
    const backup = path.join(directory, 'state.backup')
    await fs.rename(state.file, backup)
    await fs.mkdir(state.file)

    await expect(state.annotate('saved-session', { title: 'Failed title' })).rejects.toThrow()
    await expect(state.saveManagedSessions([managedSession()])).rejects.toThrow()
    await expect(state.flush()).rejects.toThrow()
    expect(state.annotation('saved-session')?.title).toBe('Saved title')
    expect(state.managedSessions()).toEqual([])
    expect((await fs.readdir(directory)).sort()).toEqual(['state.backup', 'state.json'])
    expect(await fs.readFile(backup, 'utf8')).toBe(original)

    await fs.rmdir(state.file)
    await fs.rename(backup, state.file)
    await state.annotate('saved-session', { archived: true })
    await state.flush()

    const restored = new SessionStateStore(directory)
    await restored.load()
    expect(restored.annotation('saved-session')).toMatchObject({ title: 'Saved title', archived: true })
    expect(restored.managedSessions()).toEqual([])
  })

  it('serializes concurrent annotation patches against the last durable state', async () => {
    const directory = await temporary('grok-ui-concurrent-state-')
    const state = new SessionStateStore(directory)
    await state.load()
    await Promise.all([
      state.annotate('same-session', { title: 'Concurrent title' }),
      state.annotate('same-session', { archived: true }),
    ])

    const restored = new SessionStateStore(directory)
    await restored.load()
    expect(restored.annotation('same-session')).toMatchObject({ title: 'Concurrent title', archived: true })
  })

  it('allows a new write after the filesystem failure has been repaired', async () => {
    const directory = await temporary('grok-ui-retry-state-')
    const state = new SessionStateStore(directory)
    await state.load()
    await fs.mkdir(state.file)
    await expect(state.annotate('retry-session', { title: 'First attempt' })).rejects.toThrow()
    await fs.rmdir(state.file)

    await state.annotate('retry-session', { title: 'Successful retry' })
    await state.flush()
    expect(JSON.parse(await fs.readFile(state.file, 'utf8')).sessions['retry-session'].title)
      .toBe('Successful retry')
  })

  it('persists annotations and safely restores in-flight managed sessions as idle', async () => {
    const directory = await temporary('grok-ui-state-')
    const first = new SessionStateStore(directory)
    await first.load()
    await first.annotate('session-durable-1', { title: 'Renamed session', archived: true })
    await first.saveManagedSessions([managedSession()])
    await first.flush()

    const second = new SessionStateStore(directory)
    await second.load()

    expect(second.annotation('session-durable-1')).toMatchObject({
      title: 'Renamed session',
      archived: true,
    })
    expect(second.managedSessions()[0]).toMatchObject({
      id: 'session-durable-1',
      state: 'idle',
      stopReason: 'server_restarted',
      totalTokens: 200,
    })
    expect(second.managedSessions()[0].feed[0].text).toBe('Persistent response')
    expect(second.managedSessions()[0].workflows[0]).toMatchObject({
      status: 'interrupted',
      canPause: false,
      canResume: false,
      canStop: false,
    })
    expect((await fs.stat(path.join(directory, 'state.json'))).mode & 0o777).toBe(0o600)
  })

  it('applies rename and archive overlays without modifying Grok session files', async () => {
    const root = await temporary('grok-ui-overlay-')
    const grokHome = path.join(root, 'grok')
    const stateDirectory = path.join(root, 'ui-state')
    const sessionDirectory = path.join(grokHome, 'sessions', '%2Ftmp%2Fdemo', 'session-overlay')
    await fs.mkdir(sessionDirectory, { recursive: true })
    await fs.writeFile(path.join(sessionDirectory, 'summary.json'), JSON.stringify({
      info: { id: 'session-overlay', cwd: '/tmp/demo' },
      generated_title: 'Original Grok title',
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:01:00.000Z',
    }))

    const state = new SessionStateStore(stateDirectory)
    await state.load()
    await state.annotate('session-overlay', { title: 'Operator title', archived: true })
    const dashboard = await new GrokStore(grokHome, state).dashboard()

    expect(dashboard.sessions[0]).toMatchObject({
      title: 'Operator title',
      archived: true,
    })
    const source = JSON.parse(await fs.readFile(path.join(sessionDirectory, 'summary.json'), 'utf8'))
    expect(source.generated_title).toBe('Original Grok title')
  })
})

describe('Session transcript reader', () => {
  it('projects user, thought, assistant, and tool updates without exposing raw tool input', async () => {
    const grokHome = await temporary('grok-ui-reader-')
    const sessionDirectory = path.join(grokHome, 'sessions', '%2Ftmp%2Freader', 'session-reader')
    await fs.mkdir(sessionDirectory, { recursive: true })
    await fs.writeFile(path.join(sessionDirectory, 'updates.jsonl'), [
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Build it' } } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting' } } },
      },
      {
        timestamp: 1_784_887_202,
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } },
      },
      {
        timestamp: 1_784_887_203,
        params: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'read_file',
            rawInput: { secret: 'do-not-expose' },
          },
        },
      },
      {
        timestamp: 1_784_887_204,
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            title: 'Read project',
            rawInput: { secret: 'do-not-expose' },
          },
        },
      },
      {
        timestamp: 1_784_887_205,
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            rawOutput: { secret: 'do-not-expose' },
          },
        },
      },
    ].map((item) => JSON.stringify(item)).join('\n'))

    const transcript = await new SessionReader(grokHome).transcript({
      id: 'session-reader',
      title: 'Reader',
      summary: '',
      cwd: '/tmp/reader',
      workspace: 'reader',
      createdAt: '2026-07-24T10:00:00.000Z',
      updatedAt: '2026-07-24T10:01:00.000Z',
      model: 'grok-build',
      agent: 'default',
      reasoningEffort: 'medium',
      sandboxProfile: 'default',
      messages: 3,
      chatMessages: 2,
      turns: 1,
      toolCalls: 1,
      errors: 0,
      filesTouched: 0,
      linesAdded: 0,
      linesRemoved: 0,
      durationSeconds: 60,
      contextUsage: 0.1,
      status: 'recent',
      diskBytes: 0,
      archived: false,
    })

    expect(transcript.map((item) => item.type)).toEqual(['user', 'thought', 'assistant', 'tool'])
    // One tool call and its updates collapse into a single row with the descriptive title and final status.
    expect(transcript[3]).toMatchObject({ title: 'Read project', status: 'completed' })
    expect(JSON.stringify(transcript)).not.toContain('toolCallId')
    expect(JSON.stringify(transcript)).not.toContain('do-not-expose')
  })

  it('deduplicates the same live and on-disk text event while keeping the stable disk label', () => {
    const disk = {
      id: 'disk-1',
      type: 'assistant' as const,
      title: 'Grok response',
      text: 'Same response',
      status: '',
      timestamp: '2026-07-24T10:00:00.000Z',
    }
    const live = {
      ...disk,
      id: 'live-1',
      title: 'agent message chunk',
      timestamp: '2026-07-24T10:00:00.100Z',
    }

    expect(mergeSessionFeed([disk], [live])).toEqual([disk])
  })
})
