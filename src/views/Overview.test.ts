import { describe, expect, it } from 'vitest'
import type { SessionRow } from '../types'
import { recentOverviewSessions } from './Overview'

function session(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 'session-1',
    title: 'Fixture',
    summary: '',
    cwd: '/tmp/demo',
    workspace: 'demo',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    model: 'grok-build',
    agent: 'default',
    reasoningEffort: 'default',
    sandboxProfile: 'default',
    messages: 0,
    chatMessages: 0,
    turns: 1,
    toolCalls: 2,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: 0,
    contextUsage: 0,
    status: 'idle',
    diskBytes: 0,
    archived: false,
    ...overrides,
  }
}

describe('recentOverviewSessions', () => {
  it('keeps sessions with turns or tools and skips empty archived rows', () => {
    const rows = [
      session({ id: 'work', title: 'Real work', turns: 1, toolCalls: 27 }),
      session({ id: 'empty', title: 'Session 01a0985a', turns: 0, toolCalls: 0 }),
      session({ id: 'archived', title: 'Old', turns: 8, archived: true }),
      session({ id: 'tools-only', title: 'Session abc', turns: 0, toolCalls: 3 }),
    ]
    expect(recentOverviewSessions(rows).map((item) => item.id)).toEqual(['work', 'tools-only'])
  })

  it('caps the glance list', () => {
    const rows = Array.from({ length: 8 }, (_, index) => session({ id: `s${index}`, turns: 1 }))
    expect(recentOverviewSessions(rows, 6)).toHaveLength(6)
  })
})
