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
    costAmount: 0.02,
    costCurrency: 'USD',
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
            title: 'Read project',
            rawInput: { secret: 'do-not-expose' },
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
    expect(transcript[3]).toMatchObject({ title: 'Read project', status: 'pending' })
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
