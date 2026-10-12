import { describe, expect, it } from 'vitest'
import { buildActivity, localDateKey, localDateKeyFromStamp } from './activity.js'
import type { SessionRow } from './types.js'

function session(updatedAt: string, turns = 4): SessionRow {
  return {
    id: 'session-1',
    title: 'Fixture',
    summary: '',
    cwd: '/tmp/demo',
    workspace: 'demo',
    createdAt: updatedAt,
    updatedAt,
    model: 'grok-build',
    agent: 'default',
    reasoningEffort: 'default',
    sandboxProfile: 'default',
    messages: 0,
    chatMessages: 0,
    turns,
    toolCalls: 17,
    errors: 1,
    filesTouched: 3,
    linesAdded: 10,
    linesRemoved: 2,
    durationSeconds: 0,
    contextUsage: 0,
    status: 'idle',
    diskBytes: 0,
    archived: false,
  }
}

describe('localDateKey', () => {
  it('uses the runtime calendar date, not the UTC ISO prefix', () => {
    const evening = new Date()
    evening.setHours(23, 30, 0, 0)
    const utcPrefix = evening.toISOString().slice(0, 10)
    const local = localDateKey(evening)
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    if (utcPrefix !== local) {
      expect(localDateKeyFromStamp(evening.toISOString())).toBe(local)
      expect(localDateKeyFromStamp(evening.toISOString())).not.toBe(utcPrefix)
    }
  })
})

describe('buildActivity', () => {
  it('ends on the local today and includes a session updated now', () => {
    const now = new Date()
    const days = buildActivity([session(now.toISOString(), 4)], 14, now)
    expect(days).toHaveLength(14)
    expect(days.at(-1)?.date).toBe(localDateKey(now))
    expect(days.at(-1)).toMatchObject({
      sessions: 1,
      turns: 4,
      toolCalls: 17,
      errors: 1,
      linesChanged: 12,
    })
  })

  it('puts evening-local work on the local day even when UTC has rolled forward', () => {
    const now = new Date()
    now.setHours(23, 30, 0, 0)
    const days = buildActivity([session(now.toISOString(), 4)], 14, now)
    const local = localDateKey(now)
    const utc = now.toISOString().slice(0, 10)
    expect(days.find((day) => day.date === local)?.turns).toBe(4)
    if (utc !== local) {
      expect(days.find((day) => day.date === utc)?.turns || 0).toBe(0)
    }
  })

  it('leaves sessions last active before the window out of the matrix', () => {
    const now = new Date('2026-09-12T22:00:00')
    const stale = new Date(now)
    stale.setDate(now.getDate() - 20)
    const days = buildActivity([session(stale.toISOString(), 99)], 14, now)
    expect(days.every((day) => day.turns === 0)).toBe(true)
  })
})
