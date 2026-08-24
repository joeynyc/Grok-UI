import { describe, expect, it } from 'vitest'
import { canLaunchSession, listResumable, uniqueWorkspaces } from './SessionLaunchForm'
import type { ControlSnapshot, DashboardPayload, LiveSnapshot, SessionRow } from '../types'

function session(id: string, cwd: string, archived = false): SessionRow {
  return {
    id,
    title: id,
    summary: '',
    cwd,
    workspace: cwd,
    createdAt: '',
    updatedAt: '',
    model: 'grok',
    agent: 'default',
    reasoningEffort: 'medium',
    sandboxProfile: 'default',
    messages: 0,
    chatMessages: 0,
    archived,
  } as SessionRow
}

function dashboard(sessions: SessionRow[]): DashboardPayload {
  return { sessions } as DashboardPayload
}

describe('session launch helpers', () => {
  it('deduplicates workspaces from live agents and recorded sessions', () => {
    expect(uniqueWorkspaces(
      dashboard([session('a', '/repo/alpha'), session('b', '/repo/alpha'), session('c', '/repo/beta')]),
      {
        agents: [{ cwd: '/repo/alpha' }, { cwd: '/repo/gamma' }],
      } as LiveSnapshot,
    )).toEqual(['/repo/alpha', '/repo/gamma', '/repo/beta'])
  })

  it('lists resumable sessions once and skips the archive', () => {
    const rows = listResumable(
      dashboard([
        session('cli', '/repo/cli'),
        session('managed', '/repo/managed'),
        session('old', '/repo/old', true),
      ]),
      {
        sessions: [{ id: 'managed', title: 'Managed', cwd: '/repo/managed' }],
      } as ControlSnapshot,
    )

    expect(rows.map((row) => row.id)).toEqual(['managed', 'cli'])
  })

  it('only launches when control is connected', () => {
    expect(canLaunchSession(null)).toBe(false)
    expect(canLaunchSession({ connected: false } as ControlSnapshot)).toBe(false)
    expect(canLaunchSession({ connected: true } as ControlSnapshot)).toBe(true)
  })
})
