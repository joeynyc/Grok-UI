import { describe, expect, it } from 'vitest'
import {
  collectAttention,
  formatHash,
  NAV_GROUPS,
  navBadgeCount,
  parseHash,
} from './navigation'
import type { ControlSnapshot, LiveSnapshot } from './types'

function live(agents: LiveSnapshot['agents']): LiveSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    connected: true,
    activeCount: agents.length,
    workingCount: 0,
    attentionCount: agents.filter((agent) => agent.state === 'attention').length,
    agents,
  } as LiveSnapshot
}

describe('hash routes', () => {
  it('defaults an empty hash to Live', () => {
    expect(parseHash('')).toEqual({ view: 'live', sessionId: null })
    expect(parseHash('#')).toEqual({ view: 'live', sessionId: null })
    expect(parseHash('#/')).toEqual({ view: 'live', sessionId: null })
  })

  it('round-trips a view and an open session', () => {
    const route = { view: 'live' as const, sessionId: 'live-e2e-session' }
    expect(parseHash(formatHash(route))).toEqual(route)
    expect(formatHash({ view: 'control', sessionId: null })).toBe('#/control')
  })

  it('falls back to Live for unknown views and keeps the session id', () => {
    expect(parseHash('#/unknown/abc')).toEqual({ view: 'live', sessionId: 'abc' })
  })
})

describe('primary nav', () => {
  it('keeps Control, Activity, Library, Memory, and Themes off the primary rail', () => {
    const items = NAV_GROUPS.flatMap((group) => group.items)
    expect(items).toEqual([
      'live',
      'runs',
      'changes',
      'sessions',
      'overview',
      'usage',
      'fleet',
    ])
  })
})

describe('attention', () => {
  it('prefers a pending permission over a live attention agent', () => {
    const attention = collectAttention(
      live([
        {
          id: 'cli-agent',
          title: 'CLI session',
          cwd: '/tmp',
          workspace: 'tmp',
          openedAt: '',
          model: 'grok',
          state: 'attention',
          phase: 'waiting',
          pid: 1,
          turns: 1,
          toolCalls: 0,
          contextUsed: 0,
          contextSize: 0,
          contextUsage: 0,
          costAmount: 0,
          costCurrency: 'USD',
          currentTool: '',
          updatedAt: '',
          feed: [],
        } as unknown as LiveSnapshot['agents'][number],
      ]),
      {
        generatedAt: '',
        connected: true,
        starting: false,
        agentName: 'Grok',
        agentVersion: '1',
        error: '',
        sessions: [],
        permissions: [{
          id: 'perm-1',
          sessionId: 'managed-1',
          title: 'Write the verified fixture',
          toolKind: 'edit',
          toolCallId: 'tool-1',
          createdAt: '',
          options: [],
        }],
      } as unknown as ControlSnapshot,
    )

    expect(attention.primary).toEqual({
      kind: 'permission',
      sessionId: 'managed-1',
      title: 'Write the verified fixture',
    })
    expect(navBadgeCount('live', attention)).toBe(2)
    expect(navBadgeCount('control', attention)).toBe(0)
    expect(navBadgeCount('sessions', attention)).toBe(0)
  })
})
