import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GrokStore } from './grok-store.js'
import { LiveMonitor } from './live-monitor.js'

const cleanup: string[] = []

type DashboardResult = Awaited<ReturnType<GrokStore['dashboard']>>

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function dashboardResult(label: string): DashboardResult {
  return { generatedAt: label, sessions: [] } as DashboardResult
}

function setDashboardBuilder(store: GrokStore, builder: () => Promise<DashboardResult>): void {
  (store as unknown as { buildDashboard: () => Promise<DashboardResult> }).buildDashboard = builder
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ))
})

describe('GrokStore', () => {
  it('coalesces concurrent cold dashboard builds and caches the result', async () => {
    const store = new GrokStore('/tmp/grok-hud-cold-build-test')
    const build = deferred<DashboardResult>()
    const payload = dashboardResult('cold')
    let builds = 0
    setDashboardBuilder(store, () => {
      builds += 1
      return build.promise
    })

    const first = store.dashboard()
    const second = store.dashboard()

    expect(builds).toBe(1)
    build.resolve(payload)
    await expect(Promise.all([first, second])).resolves.toEqual([payload, payload])
    expect(await store.dashboard()).toBe(payload)
    expect(builds).toBe(1)
  })

  it('bypasses a warm completed cache and coalesces concurrent forced builds', async () => {
    const store = new GrokStore('/tmp/grok-hud-forced-build-test')
    const warm = dashboardResult('warm')
    const refreshed = dashboardResult('refreshed')
    const refresh = deferred<DashboardResult>()
    let builds = 0
    setDashboardBuilder(store, () => {
      builds += 1
      return builds === 1 ? Promise.resolve(warm) : refresh.promise
    })

    expect(await store.dashboard()).toBe(warm)
    const first = store.dashboard(true)
    const second = store.dashboard(true)

    expect(builds).toBe(2)
    refresh.resolve(refreshed)
    await expect(Promise.all([first, second])).resolves.toEqual([refreshed, refreshed])
    expect(await store.dashboard()).toBe(refreshed)
    expect(builds).toBe(2)
  })

  it('expires a completed dashboard cache after two seconds', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      vi.setSystemTime(now)
      const store = new GrokStore('/tmp/grok-hud-cache-expiry-test')
      const first = dashboardResult('first')
      const second = dashboardResult('second')
      let builds = 0
      setDashboardBuilder(store, () => Promise.resolve(++builds === 1 ? first : second))

      expect(await store.dashboard()).toBe(first)
      vi.setSystemTime(now + 1_999)
      expect(await store.dashboard()).toBe(first)
      expect(builds).toBe(1)
      vi.setSystemTime(now + 2_000)
      expect(await store.dashboard()).toBe(second)
      expect(builds).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an older invalidated build overwrite a newer cached result', async () => {
    const store = new GrokStore('/tmp/grok-hud-invalidated-build-test')
    const older = deferred<DashboardResult>()
    const newer = deferred<DashboardResult>()
    const oldPayload = dashboardResult('old')
    const newPayload = dashboardResult('new')
    let builds = 0
    setDashboardBuilder(store, () => (++builds === 1 ? older.promise : newer.promise))

    const oldRequest = store.dashboard()
    store.invalidate()
    const newRequest = store.dashboard()

    expect(builds).toBe(2)
    newer.resolve(newPayload)
    await expect(newRequest).resolves.toBe(newPayload)
    older.resolve(oldPayload)
    await expect(oldRequest).resolves.toBe(oldPayload)
    expect(await store.dashboard()).toBe(newPayload)
    expect(builds).toBe(2)
  })

  it('keeps a newer build pending when an invalidated build rejects', async () => {
    const store = new GrokStore('/tmp/grok-hud-invalidated-rejection-test')
    const older = deferred<DashboardResult>()
    const newer = deferred<DashboardResult>()
    const payload = dashboardResult('new')
    const failure = new Error('obsolete build failed')
    let builds = 0
    setDashboardBuilder(store, () => (++builds === 1 ? older.promise : newer.promise))

    const oldRequest = store.dashboard()
    store.invalidate()
    const newRequest = store.dashboard()
    older.reject(failure)
    await expect(oldRequest).rejects.toBe(failure)
    const joinedRequest = store.dashboard()

    expect(builds).toBe(2)
    newer.resolve(payload)
    await expect(Promise.all([newRequest, joinedRequest])).resolves.toEqual([payload, payload])
    expect(await store.dashboard()).toBe(payload)
    expect(builds).toBe(2)
  })

  it('releases a failed build and allows a later request to retry', async () => {
    const store = new GrokStore('/tmp/grok-hud-failed-build-test')
    const payload = dashboardResult('retry')
    const failure = new Error('dashboard build failed')
    let builds = 0
    setDashboardBuilder(store, () => (++builds === 1 ? Promise.reject(failure) : Promise.resolve(payload)))

    await expect(store.dashboard()).rejects.toBe(failure)
    await expect(store.dashboard()).resolves.toBe(payload)
    expect(builds).toBe(2)
  })

  it('aggregates local session signals without reading conversation bodies', async () => {
    const grokHome = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-hud-test-'))
    cleanup.push(grokHome)
    const sessionDir = path.join(grokHome, 'sessions', '%2Ftmp%2Fdemo', 'session-1')
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(path.join(sessionDir, 'summary.json'), JSON.stringify({
      info: { id: 'session-1', cwd: '/tmp/demo' },
      generated_title: 'Build a local dashboard',
      session_summary: 'Metadata-only fixture',
      created_at: '2026-07-23T10:00:00.000Z',
      updated_at: '2026-07-24T10:00:00.000Z',
      current_model_id: 'grok-build',
      num_messages: 12,
      num_chat_messages: 8,
    }))
    await fs.writeFile(path.join(sessionDir, 'signals.json'), JSON.stringify({
      turnCount: 4,
      toolCallCount: 17,
      errorCount: 1,
      toolFailureCount: 2,
      contextWindowUsage: 42,
      totalFilesTouched: 3,
      agentLinesAdded: 120,
      agentLinesRemoved: 20,
      toolsUsed: ['read_file', 'write'],
      modelsUsed: ['grok-build', 'grok-build-fast'],
    }))
    await fs.writeFile(path.join(sessionDir, 'updates.jsonl'), '{"private":"not parsed"}\n')
    await fs.mkdir(path.join(grokHome, 'bundled', 'skills', 'design'), { recursive: true })
    await fs.writeFile(path.join(grokHome, 'bundled', 'skills', 'design', 'SKILL.md'), '# Design')
    await fs.mkdir(path.join(grokHome, 'memory'), { recursive: true })
    await fs.writeFile(path.join(grokHome, 'memory', 'MEMORY.md'), '# Private memory body')
    await fs.writeFile(path.join(grokHome, 'version.json'), JSON.stringify({ version: '0.2.test' }))

    const payload = await new GrokStore(grokHome).dashboard()

    expect(payload.version).toBe('0.2.test')
    expect(payload.stats).toMatchObject({
      sessions: 1,
      workspaces: 1,
      turns: 4,
      toolCalls: 17,
      errors: 3,
      filesTouched: 3,
      linesChanged: 140,
      skills: 1,
      memoryFiles: 1,
    })
    expect(payload.sessions[0]).toMatchObject({
      title: 'Build a local dashboard',
      model: 'grok-build',
      contextUsage: 0.42,
    })
    expect(payload.tools.map((item) => item.name)).toEqual(['read_file', 'write'])
    // One session, one primary model: secondary models do not inflate the mix.
    expect(payload.models).toEqual([{ name: 'grok-build', value: 1 }])
    expect(JSON.stringify(payload)).not.toContain('not parsed')
    expect(JSON.stringify(payload)).not.toContain('Private memory body')
  })

  it('places a just-updated session on the local calendar day in activity', async () => {
    const grokHome = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-hud-test-'))
    cleanup.push(grokHome)
    const now = new Date()
    const sessionDir = path.join(grokHome, 'sessions', '%2Ftmp%2Fdemo', 'session-today')
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(path.join(sessionDir, 'summary.json'), JSON.stringify({
      info: { id: 'session-today', cwd: '/tmp/demo' },
      generated_title: 'Today',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }))
    await fs.writeFile(path.join(sessionDir, 'signals.json'), JSON.stringify({
      turnCount: 4,
      toolCallCount: 7,
    }))

    const payload = await new GrokStore(grokHome).dashboard()
    const today = payload.activity.at(-1)
    expect(today?.turns).toBe(4)
    expect(today?.toolCalls).toBe(7)
    expect(today?.sessions).toBe(1)
  })

  it('rejects unsafe session identifiers', async () => {
    const grokHome = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-hud-test-'))
    cleanup.push(grokHome)
    const store = new GrokStore(grokHome)
    expect(await store.session('../auth.json')).toBeNull()
  })

  it('projects an active Grok process and structured updates into the live feed', async () => {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-hud-live-test-'))
    cleanup.push(testRoot)
    const grokHome = path.join(testRoot, '.grok')
    const sessionId = '019f-live-session'
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
    }))
    await fs.writeFile(path.join(sessionDir, 'events.jsonl'), [
      JSON.stringify({ type: 'turn_started', ts: '2026-07-24T10:01:01.000Z' }),
      JSON.stringify({ type: 'phase_changed', phase: 'streaming_text', ts: '2026-07-24T10:01:02.000Z' }),
    ].join('\n'))
    await fs.writeFile(path.join(sessionDir, 'updates.jsonl'), [
      JSON.stringify({
        method: 'session/update',
        timestamp: 1784887262,
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Streaming now' } } },
      }),
      JSON.stringify({
        method: 'session/update',
        timestamp: 1784887263,
        params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read project files' } },
      }),
    ].join('\n'))

    const store = new GrokStore(grokHome)
    const monitor = new LiveMonitor(store)
    await monitor.start()
    const snapshot = monitor.snapshot()
    const liveDashboard = await store.dashboard()
    const pushedLine = `\n${JSON.stringify({
      method: 'session/update',
      timestamp: 1784887264,
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pushed by watcher' } } },
    })}`
    const nextSnapshotPromise = new Promise<ReturnType<LiveMonitor['snapshot']>>((resolve, reject) => {
      const retry = setInterval(() => void fs.appendFile(path.join(sessionDir, 'updates.jsonl'), pushedLine), 250)
      const timeout = setTimeout(() => {
        clearInterval(retry)
        reject(new Error('Live watcher did not emit'))
      }, 5_000)
      monitor.once('live', (nextSnapshot) => {
        clearInterval(retry)
        clearTimeout(timeout)
        resolve(nextSnapshot)
      })
    })
    await fs.appendFile(path.join(sessionDir, 'updates.jsonl'), pushedLine)
    const pushedSnapshot = await nextSnapshotPromise
    await monitor.stop()

    expect(snapshot).toMatchObject({
      connected: true,
      activeCount: 1,
      workingCount: 1,
      attentionCount: 0,
    })
    expect(snapshot.agents[0]).toMatchObject({
      id: sessionId,
      state: 'working',
      phase: 'streaming_text',
      turns: 2,
      toolCalls: 3,
    })
    expect(liveDashboard.stats.liveSessions).toBe(1)
    expect(liveDashboard.sessions[0].status).toBe('live')
    expect(snapshot.agents[0].feed.map((item) => item.type)).toEqual(['assistant', 'tool'])
    expect(snapshot.agents[0].feed[0].timestamp).not.toBe('1970-01-01T00:00:00.000Z')
    expect(pushedSnapshot.agents[0].feed.at(-1)?.text).toBe('Pushed by watcher')
  })
})
