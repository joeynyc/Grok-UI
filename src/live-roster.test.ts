import { describe, expect, it } from 'vitest'
import { buildRoster, groupedRoster, peekText, permissionsForSession, shouldShowFirstRun } from './live-roster'
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

  it('puts a session with a pending permission in Needs input', () => {
    const rows = buildRoster(null, {
      sessions: [{
        id: 'lane',
        title: 'Lane',
        cwd: '/repo',
        state: 'working',
        parentSessionId: '',
        feed: [],
        workflows: [],
      }],
      permissions: [{ sessionId: 'lane', title: 'Write the file' }],
    } as unknown as ControlSnapshot)

    expect(groupedRoster(rows)[0]).toMatchObject({ id: 'attention', label: 'Needs input' })
    expect(permissionsForSession({
      permissions: [{ sessionId: 'lane', title: 'Write the file' }, { sessionId: 'other' }],
    } as ControlSnapshot, 'lane')).toHaveLength(1)
  })

  it('keeps setup-needed first-run even when leftover managed lanes exist', () => {
    expect(shouldShowFirstRun({
      setupReady: false,
      hasRoster: true,
      archivedSessions: 0,
    })).toBe(true)
    expect(shouldShowFirstRun({
      setupReady: true,
      hasRoster: true,
      archivedSessions: 0,
    })).toBe(false)
    expect(shouldShowFirstRun({
      setupReady: true,
      hasRoster: false,
      archivedSessions: 0,
    })).toBe(true)
  })
})

describe('peekText', () => {
  it('flattens Markdown into prose for the roster peek', () => {
    const input = '## Summary\n\n**Branch:** `main` - working tree *clean*.\n\n| Commit | Message |\n|---|---|\n| `0c3e7ef` | control: confirm |\n\n- run `git pull --rebase`\n- then push'
    expect(peekText(input)).toBe(
      'Summary Branch: main - working tree clean. Commit · Message 0c3e7ef · control: confirm run git pull --rebase then push',
    )
  })

  it('keeps plain text and bounds the length', () => {
    expect(peekText('Hello there')).toBe('Hello there')
    expect(peekText('x'.repeat(500), 40)).toHaveLength(40)
    expect(peekText('x'.repeat(500), 40).endsWith('…')).toBe(true)
  })
})
