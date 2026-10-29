import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GrokStore } from './grok-store.js'
import { LiveMonitor } from './live-monitor.js'
import type { DashboardPayload, LiveSnapshot } from './types.js'

const cleanup: string[] = []
const monitors: LiveMonitor[] = []

afterEach(async () => {
  await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()))
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ))
})

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(directory)
  return directory
}

interface LiveFixture {
  grokHome: string
  sessionId: string
  sessionDir: string
}

async function liveFixture(overrides: {
  events?: string[]
  updates?: unknown[]
  signals?: Record<string, unknown>
} = {}): Promise<LiveFixture> {
  const grokHome = await temporary('grok-ui-live-monitor-')
  const sessionId = 'live-session-1'
  const sessionDir = path.join(grokHome, 'sessions', '%2Ftmp%2Flive', sessionId)
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(path.join(grokHome, 'active_sessions.json'), JSON.stringify([{
    session_id: sessionId,
    pid: process.pid,
    cwd: '/tmp/live',
    opened_at: '2026-07-24T10:00:00.000Z',
  }]))
  await fs.writeFile(path.join(sessionDir, 'summary.json'), JSON.stringify({
    info: { id: sessionId, cwd: '/tmp/live' },
    generated_title: 'Live fixture session',
    created_at: '2026-07-24T10:00:00.000Z',
    updated_at: '2026-07-24T10:01:00.000Z',
    current_model_id: 'grok-build',
  }))
  await fs.writeFile(path.join(sessionDir, 'signals.json'), JSON.stringify({
    turnCount: 2,
    toolCallCount: 3,
    contextWindowUsage: 25,
    ...overrides.signals,
  }))
  await fs.writeFile(path.join(sessionDir, 'events.jsonl'), (overrides.events ?? []).join('\n'))
  await fs.writeFile(
    path.join(sessionDir, 'updates.jsonl'),
    (overrides.updates ?? [])
      .map((line) => typeof line === 'string' ? line : JSON.stringify(line))
      .join('\n'),
  )
  return { grokHome, sessionId, sessionDir }
}

const turnStarted = JSON.stringify({ type: 'turn_started', ts: '2026-07-24T10:01:01.000Z' })
const turnEnded = JSON.stringify({ type: 'turn_ended', ts: '2026-07-24T10:01:05.000Z' })

function phaseChanged(phase: string): string {
  return JSON.stringify({ type: 'phase_changed', phase, ts: '2026-07-24T10:01:02.000Z' })
}

async function startMonitor(grokHome: string): Promise<LiveMonitor> {
  const monitor = new LiveMonitor(new GrokStore(grokHome))
  monitors.push(monitor)
  await monitor.start()
  return monitor
}

describe('LiveMonitor feed projection', () => {
  it('collapses a tool call and its updates into one feed row that keeps its title', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: {
            update: { sessionUpdate: 'tool_call', toolCallId: 'tool-9', title: 'read_file', content: { text: 'Reading src' } },
          },
        },
        {
          timestamp: 1_784_887_201,
          params: {
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-9', status: 'in_progress' },
          },
        },
        {
          timestamp: 1_784_887_202,
          params: {
            update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'tool-9', content: { text: 'Read 3 files' }, status: 'completed',
            },
          },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({
      type: 'tool',
      title: 'read_file',
      text: 'Read 3 files',
      status: 'completed',
      timestamp: new Date(1_784_887_202 * 1_000).toISOString(),
    })
  })

  it('keeps distinct tool calls as separate feed rows and skips unknown update kinds', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-a', title: 'first' } },
        },
        {
          timestamp: 1_784_887_201,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-b', title: 'second' } },
        },
        {
          timestamp: 1_784_887_202,
          params: { update: { sessionUpdate: 'mystery_widget', title: 'ignored' } },
        },
        {
          timestamp: 1_784_887_203,
          params: { update: {} },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed.map((item) => item.title)).toEqual(['first', 'second'])
    expect(feed[0].id).not.toBe(feed[1].id)
  })

  it.each([
    {
      update: { sessionUpdate: 'user_message_chunk', content: { text: 'Ship it' } },
      expected: { type: 'user', title: 'user message chunk', text: 'Ship it' },
    },
    {
      update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'Considering' } },
      expected: { type: 'thought', title: 'agent thought chunk', text: 'Considering' },
    },
    {
      update: { sessionUpdate: 'plan', content: { text: 'Plan body' } },
      expected: { type: 'plan', title: 'plan', text: 'Plan body' },
    },
    {
      update: { sessionUpdate: 'turn_completed', stop_reason: 'max_tokens' },
      expected: { type: 'system', title: 'Turn completed', text: 'max_tokens' },
    },
    {
      update: { sessionUpdate: 'tool_call', toolCallId: 'shell', title: 'run', command: 'npm test' },
      expected: { type: 'tool', title: 'run', text: 'npm test' },
    },
    {
      update: { sessionUpdate: 'task_ended', kind: 'subagent' },
      expected: { type: 'tool', title: 'task ended', text: 'subagent' },
    },
  ])('projects a $update.sessionUpdate update into a typed, titled feed row', async ({ update, expected }) => {
    const { grokHome } = await liveFixture({
      updates: [{ timestamp: 1_784_887_200, params: { update } }],
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed.map(({ type, title, text }) => ({ type, title, text }))).toEqual([expected])
  })
})

describe('LiveMonitor agent state', () => {
  it.each([
    {
      name: 'an open permission prompt needs attention',
      events: [turnStarted, phaseChanged('permission_prompt')],
      expected: { phase: 'permission_prompt', state: 'attention', workingCount: 0, attentionCount: 1 },
    },
    {
      name: 'waiting_for_model in an open turn counts as waiting',
      events: [turnStarted, phaseChanged('waiting_for_model')],
      expected: { phase: 'waiting_for_model', state: 'waiting', workingCount: 1, attentionCount: 0 },
    },
    {
      name: 'a streaming phase in an open turn counts as working',
      events: [turnStarted, phaseChanged('streaming_text')],
      expected: { phase: 'streaming_text', state: 'working', workingCount: 1, attentionCount: 0 },
    },
    {
      name: 'an ended turn drops back to idle despite a stale working phase',
      events: [turnStarted, phaseChanged('streaming_text'), turnEnded],
      expected: { phase: 'idle', state: 'idle', workingCount: 0, attentionCount: 0 },
    },
    {
      name: 'a working phase outside an open turn stays idle',
      events: [phaseChanged('streaming_text')],
      expected: { phase: 'streaming_text', state: 'idle', workingCount: 0, attentionCount: 0 },
    },
  ])('$name', async ({ events, expected }) => {
    const { grokHome } = await liveFixture({ events })

    const monitor = await startMonitor(grokHome)
    const snapshot = monitor.snapshot()

    expect({
      phase: snapshot.agents[0].phase,
      state: snapshot.agents[0].state,
      workingCount: snapshot.workingCount,
      attentionCount: snapshot.attentionCount,
    }).toEqual(expected)
  })
})

describe('LiveMonitor usage projection', () => {
  it('projects the latest usage_update and clamps context usage into 0..1', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: { update: { sessionUpdate: 'usage_update', used: 100, size: 400, cost: { amount: 0.01, currency: 'USD' } } },
        },
        {
          timestamp: 1_784_887_201,
          params: { update: { sessionUpdate: 'usage_update', used: 800, size: 400, cost: { amount: 0.25, currency: 'EUR' } } },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const agent = monitor.snapshot().agents[0]

    expect(agent).toMatchObject({
      contextUsed: 800,
      contextSize: 400,
      contextUsage: 1,
      costAmount: 0.25,
      costCurrency: 'EUR',
      costTelemetryAvailable: true,
    })
  })

  it('falls back to the session context usage and zero cost when no usage_update exists', async () => {
    const { grokHome } = await liveFixture({ signals: { contextWindowUsage: 25 } })

    const monitor = await startMonitor(grokHome)
    const agent = monitor.snapshot().agents[0]

    expect(agent).toMatchObject({
      contextUsed: 0,
      contextSize: 0,
      contextUsage: 0.25,
      costAmount: 0,
      costCurrency: '',
      costTelemetryAvailable: false,
    })
  })
})

describe('LiveMonitor snapshot details', () => {
  it('excludes active records with dead or missing process ids', async () => {
    const grokHome = await temporary('grok-ui-dead-pid-')
    const sessionId = 'live-session-1'
    const sessionDir = path.join(grokHome, 'sessions', '%2Ftmp%2Flive', sessionId)
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(path.join(grokHome, 'active_sessions.json'), JSON.stringify([
      { session_id: sessionId, pid: process.pid, cwd: '/tmp/live', opened_at: '2026-07-24T10:00:00.000Z' },
      { session_id: 'dead-session', pid: 0, cwd: '/tmp/live', opened_at: '2026-07-24T10:00:00.000Z' },
      { session_id: 'fractional-session', pid: 1.5, cwd: '/tmp/live', opened_at: '2026-07-24T10:00:00.000Z' },
      { session_id: '', pid: process.pid, cwd: '/tmp/live', opened_at: '2026-07-24T10:00:00.000Z' },
      'not a record',
    ]))
    await fs.writeFile(path.join(sessionDir, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/tmp/live' },
      generated_title: 'Only live session',
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:01:00.000Z',
    }))
    await fs.writeFile(path.join(sessionDir, 'signals.json'), '{}')

    const monitor = await startMonitor(grokHome)
    const snapshot = monitor.snapshot()

    expect(snapshot.connected).toBe(true)
    expect(snapshot.activeCount).toBe(1)
    expect(snapshot.agents.map((agent) => agent.id)).toEqual([sessionId])
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['an empty file', ''],
    ['an empty array', '[]'],
    ['a live record that is not wrapped in an array', JSON.stringify({
      session_id: 'live-session-1',
      pid: process.pid,
      cwd: '/tmp/live',
      opened_at: '2026-07-24T10:00:00.000Z',
    })],
  ])('reports zero agents when active_sessions.json holds %s', async (_label, contents) => {
    const { grokHome } = await liveFixture()
    await fs.writeFile(path.join(grokHome, 'active_sessions.json'), contents)

    const monitor = await startMonitor(grokHome)
    const snapshot = monitor.snapshot()

    expect(snapshot.activeCount).toBe(0)
    expect(snapshot.agents).toEqual([])
    expect(snapshot.connected).toBe(true)
  })

  it('uses the newest feed timestamp for updatedAt and shows the in-flight tool', async () => {
    const { grokHome } = await liveFixture({
      events: [
        turnStarted,
        phaseChanged('streaming_text'),
      ],
      updates: [
        {
          timestamp: 1_784_887_300,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-run', title: 'run_tests', status: 'in_progress' } },
        },
        {
          timestamp: 1_784_887_301,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-done', title: 'read_file', status: 'completed' } },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const agent = monitor.snapshot().agents[0]

    expect(agent.updatedAt).toBe(new Date(1_784_887_301 * 1_000).toISOString())
    expect(agent.currentTool).toBe('run_tests')
  })

  it.each([
    { name: 'a working turn whose only tool completed', events: [turnStarted, phaseChanged('streaming_text')], status: 'completed' },
    { name: 'a working turn whose only tool failed', events: [turnStarted, phaseChanged('tool_execution')], status: 'failed' },
    { name: 'an idle turn with a tool still in progress', events: [], status: 'in_progress' },
  ])('reports no current tool for $name', async ({ events, status }) => {
    const { grokHome } = await liveFixture({
      events,
      updates: [
        {
          timestamp: 1_784_887_300,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-only', title: 'read_file', status } },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)

    expect(monitor.snapshot().agents[0].currentTool).toBe('')
  })

  it('synthesizes a session row for a live session with no summary on disk', async () => {
    const grokHome = await temporary('grok-ui-fallback-')
    const sessionId = 'nosummary-session'
    const sessionDir = path.join(grokHome, 'sessions', '%2Fprivate%2Fws%2Fdeep', sessionId)
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(path.join(grokHome, 'active_sessions.json'), JSON.stringify([{
      session_id: sessionId,
      pid: process.pid,
      cwd: '/private/ws/deep',
      opened_at: '2026-07-24T09:30:00.000Z',
    }]))

    const monitor = await startMonitor(grokHome)
    const agent = monitor.snapshot().agents[0]

    expect(agent).toMatchObject({
      id: sessionId,
      title: `Live session ${sessionId.slice(0, 8)}`,
      cwd: '/private/ws/deep',
      workspace: 'deep',
      openedAt: '2026-07-24T09:30:00.000Z',
      updatedAt: '2026-07-24T09:30:00.000Z',
      model: 'unknown',
    })
  })
})

describe('LiveMonitor update parsing', () => {
  it('accepts bare update objects, arrays, and type-based records', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          update: { sessionUpdate: 'user_message_chunk', content: { text: 'bare update key' } },
        },
        JSON.stringify([
          {
            timestamp: 1_784_887_201,
            params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'array item' } } },
          },
        ]),
        {
          timestamp: 1_784_887_202,
          type: 'task_started', description: 'background task',
        },
        {
          timestamp: 1_784_887_203,
          params: { update: { tool_call_id: 'snake-1', type: 'tool_call', title: 'snake tool' } },
        },
        'plain text is ignored',
        JSON.stringify(42),
      ],
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed.map((item) => item.type)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(feed[0].text).toBe('bare update key')
    expect(feed[1].text).toBe('array item')
    expect(feed[2]).toMatchObject({ title: 'background task', type: 'tool' })
    expect(feed[3]).toMatchObject({ title: 'snake tool', type: 'tool' })
  })

  it('truncates feed text beyond the limit with an ellipsis and strips null bytes', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { text: 'z'.repeat(2_500) + String.fromCharCode(0) },
            },
          },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const text = monitor.snapshot().agents[0].feed[0].text

    expect(text.length).toBe(2_400)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toContain(String.fromCharCode(0))
  })

  it('only keeps the newest 50 feed items', async () => {
    const { grokHome } = await liveFixture({
      updates: Array.from({ length: 55 }, (_, index) => ({
        timestamp: 1_784_887_200 + index,
        params: { update: { sessionUpdate: 'tool_call', toolCallId: `tool-${index}` } },
      })),
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed).toHaveLength(50)
    expect(feed[0].id).toBe('tool-5')
    expect(feed.at(-1)?.id).toBe('tool-54')
  })
})

describe('LiveMonitor coercion boundaries', () => {
  it('treats update timestamps below ten billion as seconds and above as milliseconds', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 9_999_999_999,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'ts-seconds', title: 'seconds' } },
        },
        {
          timestamp: 10_000_000_000,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'ts-edge', title: 'edge' } },
        },
        {
          timestamp: 10_000_000_001,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'ts-millis', title: 'millis' } },
        },
        {
          timestamp: 'garbage',
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'ts-bad', title: 'bad' } },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed[0].timestamp).toBe(new Date(9_999_999_999 * 1_000).toISOString())
    expect(feed[1].timestamp).toBe(new Date(10_000_000_000 * 1_000).toISOString())
    expect(feed[2].timestamp).toBe(new Date(10_000_000_001).toISOString())
    expect(feed[3].timestamp).toBe(new Date(0).toISOString())
  })

  it('marks cost telemetry unavailable when the latest usage_update has an empty cost object', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: { update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.5, currency: 'USD' } } },
        },
        {
          timestamp: 1_784_887_201,
          params: { update: { sessionUpdate: 'usage_update', used: 50, size: 100, cost: {} } },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const agent = monitor.snapshot().agents[0]

    expect(agent).toMatchObject({
      contextUsed: 50,
      contextSize: 100,
      contextUsage: 0.5,
      costTelemetryAvailable: false,
      costAmount: 0,
      costCurrency: '',
    })
  })

  it('prefers the record cwd but falls back to the session cwd when empty', async () => {
    const grokHome = await temporary('grok-ui-cwd-preference-')
    const sessionId = 'cwd-session'
    const sessionDir = path.join(grokHome, 'sessions', '%2Ftmp%2Fsummary', sessionId)
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(path.join(grokHome, 'active_sessions.json'), JSON.stringify([{
      session_id: sessionId, pid: process.pid, cwd: '', opened_at: '2026-07-24T10:00:00.000Z',
    }]))
    await fs.writeFile(path.join(sessionDir, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/tmp/summary' },
      generated_title: 'Cwd session',
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:00:00.000Z',
    }))
    await fs.writeFile(path.join(sessionDir, 'signals.json'), '{}')

    const monitor = await startMonitor(grokHome)
    expect(monitor.snapshot().agents[0].cwd).toBe('/tmp/summary')

    await fs.writeFile(path.join(grokHome, 'active_sessions.json'), JSON.stringify([{
      session_id: sessionId, pid: process.pid, cwd: '/tmp/live-override', opened_at: '2026-07-24T10:00:00.000Z',
    }]))
    const second = await startMonitor(grokHome)
    expect(second.snapshot().agents[0].cwd).toBe('/tmp/live-override')
  })

  it('reads only the tail of an oversized updates file', async () => {
    const { grokHome, sessionDir } = await liveFixture()
    const stale = JSON.stringify({
      timestamp: 1_784_887_100,
      params: { update: { sessionUpdate: 'tool_call', toolCallId: 'stale-tool', title: 'old head' } },
    })
    const fresh = JSON.stringify({
      timestamp: 1_784_887_300,
      params: { update: { sessionUpdate: 'tool_call', toolCallId: 'fresh-tool', title: 'new tail' } },
    })
    const filler = 'x'.repeat(512 * 1024)
    await fs.writeFile(
      path.join(sessionDir, 'updates.jsonl'),
      `${stale}\n{"pad":"${filler}"}\n${fresh}`,
    )

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed.map((item) => item.id)).toEqual(['fresh-tool'])
  })
})

describe('LiveMonitor events', () => {
  function delay(milliseconds: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, milliseconds)
    return promise
  }

  // Poll for an emitted value, staying inside Vitest's 5 s test timeout so a
  // miss reports this message instead of a bare timeout.
  async function waitFor<T>(poll: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      const value = poll()
      if (value !== undefined) return value
      await delay(50)
    }
    throw new Error('Timed out waiting for live monitor event')
  }

  it('emits a live snapshot from the file watcher when a session update file changes', async () => {
    const { grokHome, sessionDir, sessionId } = await liveFixture()
    const monitor = await startMonitor(grokHome)
    // start() arms the 2 s liveness setInterval as its last step, so a refresh
    // driven by that poll cannot land before this mark plus 2 s.
    const startedAt = performance.now()
    // Let the native watcher arm before writing, as tree-watcher.test.ts does.
    await delay(150)

    const updates: Array<{ snapshot: LiveSnapshot; receivedAt: number }> = []
    monitor.on('live', (snapshot: LiveSnapshot) => updates.push({ snapshot, receivedAt: performance.now() }))
    const writtenAt = performance.now()
    await fs.appendFile(path.join(sessionDir, 'updates.jsonl'), `\n${JSON.stringify({
      timestamp: 1_784_887_400,
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'pushed' } } },
    })}`)

    const pushed = await waitFor(() =>
      updates.find(({ snapshot }) => snapshot.agents[0]?.feed.at(-1)?.text === 'pushed'))
    // Arriving this soon after the write rules out the liveness poll as the source.
    expect(pushed.receivedAt - writtenAt).toBeLessThan(1_500)
    expect(pushed.receivedAt - startedAt).toBeLessThan(2_000)
    expect(pushed.snapshot.connected).toBe(true)
    expect(pushed.snapshot.activeCount).toBe(1)
    expect(pushed.snapshot.agents[0].id).toBe(sessionId)
  })

  it('emits a dashboard with the new title when a session summary changes on disk', async () => {
    const { grokHome, sessionDir } = await liveFixture()
    const monitor = await startMonitor(grokHome)
    await delay(150)

    const dashboards: DashboardPayload[] = []
    monitor.on('dashboard', (dashboard) => dashboards.push(dashboard))
    await fs.writeFile(path.join(sessionDir, 'summary.json'), JSON.stringify({
      info: { id: 'live-session-1', cwd: '/tmp/live' },
      generated_title: 'Rewritten summary',
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:02:00.000Z',
    }))

    const dashboard = await waitFor(() => dashboards.find((payload) =>
      payload.sessions.some((session) => session.id === 'live-session-1' && session.title === 'Rewritten summary')))
    expect(dashboard.sessions.find((session) => session.id === 'live-session-1')?.title).toBe('Rewritten summary')
  })
})

describe('LiveMonitor feed item details', () => {
  it('keeps anonymous tool calls at the same instant as separate rows with distinct ids', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: { update: { sessionUpdate: 'tool_call', title: 'first anonymous' } },
        },
        {
          timestamp: 1_784_887_200,
          params: { update: { sessionUpdate: 'tool_call', title: 'second anonymous' } },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed.map((item) => item.title)).toEqual(['first anonymous', 'second anonymous'])
    expect(new Set(feed.map((item) => item.id)).size).toBe(2)
  })

  it('keeps the title and text of an earlier tool update when a later one has neither', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-text',
              title: 'writer',
              content: { text: 'draft body' },
            },
          },
        },
        {
          timestamp: 1_784_887_201,
          params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-text', status: 'completed' } },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)
    const feed = monitor.snapshot().agents[0].feed

    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({ title: 'writer', text: 'draft body', status: 'completed' })
  })

  it('takes a later descriptive title from a tool update', async () => {
    const { grokHome } = await liveFixture({
      updates: [
        {
          timestamp: 1_784_887_200,
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-rename', title: 'read_file' } },
        },
        {
          timestamp: 1_784_887_201,
          params: {
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-rename', description: 'Read project files' },
          },
        },
      ],
    })

    const monitor = await startMonitor(grokHome)

    expect(monitor.snapshot().agents[0].feed.map((item) => item.title)).toEqual(['Read project files'])
  })
})
