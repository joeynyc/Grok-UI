import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GrokStore } from './grok-store.js'
import { LiveMonitor } from './live-monitor.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ))
})

describe('GrokStore', () => {
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
      modelsUsed: ['grok-build'],
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
    expect(JSON.stringify(payload)).not.toContain('not parsed')
    expect(JSON.stringify(payload)).not.toContain('Private memory body')
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
    // updates.jsonl is not chokidar-watched (high churn); live feed refreshes
    // on the liveness timer. Append + wait for the next live emission.
    const nextSnapshotPromise = new Promise<ReturnType<LiveMonitor['snapshot']>>((resolve, reject) => {
      const retry = setInterval(() => void fs.appendFile(path.join(sessionDir, 'updates.jsonl'), pushedLine), 250)
      const timeout = setTimeout(() => {
        clearInterval(retry)
        reject(new Error('Live monitor did not emit after updates.jsonl append'))
      }, 10_000)
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
