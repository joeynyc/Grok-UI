import { describe, expect, it } from 'vitest'
import { buildRoster, groupedRoster } from './live-roster'
import type { ControlSnapshot, LiveSnapshot } from './types'

describe('live roster', () => {
  it('groups needs-input first and rolls children under a parent', () => {
    const rows = buildRoster(
      {
        agents: [
          { id: 'parent', title: 'Parent', cwd: '/repo', state: 'working', feed: [] },
          { id: 'child', title: 'Child', cwd: '/repo', state: 'waiting', feed: [] },
        ],
      } as unknown as LiveSnapshot,
      {
        sessions: [{
          id: 'parent',
          title: 'Parent',
          cwd: '/repo',
          state: 'working',
          parentSessionId: '',
          feed: [{ id: '1', type: 'assistant', title: 'hi', text: 'working', status: '', timestamp: '' }],
          workflows: [],
        }, {
          id: 'child',
          title: 'Child',
          cwd: '/repo',
          state: 'attention',
          parentSessionId: 'parent',
          feed: [],
          workflows: [],
        }],
        permissions: [],
      } as unknown as ControlSnapshot,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].children).toHaveLength(1)
    expect(groupedRoster(rows)[0].id).toBe('working')
  })
})
