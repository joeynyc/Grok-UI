import { describe, expect, it } from 'vitest'
import { reconcileControlSnapshot } from './control-snapshot'
import type { ControlSession, ControlSnapshot } from './types'

function session(updatedAt: string, feedItems: number): ControlSession {
  return {
    id: 'managed-session',
    cwd: '/workspace',
    title: 'Managed session',
    model: 'grok',
    state: 'idle',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt,
    lastPrompt: '',
    stopReason: 'end_turn',
    error: '',
    cancellationStatus: 'none',
    cancelRequestedAt: '',
    cancelledAt: '',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    tokenTelemetryAvailable: true,
    costAmount: 0,
    costCurrency: '',
    costTelemetryAvailable: false,
    feed: Array.from({ length: feedItems }, (_, index) => ({
      id: `event-${index}`,
      type: 'assistant',
      title: 'Grok',
      text: `Update ${index}`,
      status: 'completed',
      timestamp: updatedAt,
    })),
    workflows: [],
  }
}

function snapshot(
  generatedAt: string,
  sessionUpdatedAt: string,
  feedItems: number,
): ControlSnapshot {
  return {
    generatedAt,
    connected: true,
    processId: 42,
    starting: false,
    reconnecting: false,
    reconnectAttempt: 0,
    lastDisconnectedAt: '',
    agentName: 'grok',
    agentVersion: '1',
    error: '',
    sessions: [session(sessionUpdatedAt, feedItems)],
    workflows: [],
    permissions: [],
  }
}

describe('reconcileControlSnapshot', () => {
  it('does not let an older refresh overwrite a newer streamed result', () => {
    const streamed = snapshot(
      '2026-07-30T00:00:02.000Z',
      '2026-07-30T00:00:02.000Z',
      3,
    )
    const staleRefresh = snapshot(
      '2026-07-30T00:00:01.000Z',
      '2026-07-30T00:00:01.000Z',
      1,
    )

    expect(reconcileControlSnapshot(streamed, staleRefresh)).toBe(streamed)
  })

  it('uses session progress when snapshots share a generated timestamp', () => {
    const timestamp = '2026-07-30T00:00:02.000Z'
    const completed = snapshot(timestamp, timestamp, 3)
    const stale = snapshot(timestamp, timestamp, 1)

    expect(reconcileControlSnapshot(completed, stale)).toBe(completed)
    expect(reconcileControlSnapshot(stale, completed)).toBe(completed)
  })

  it('accepts a newer snapshot even when bounded history becomes smaller', () => {
    const current = snapshot(
      '2026-07-30T00:00:01.000Z',
      '2026-07-30T00:00:01.000Z',
      3,
    )
    const newer = snapshot(
      '2026-07-30T00:00:02.000Z',
      '2026-07-30T00:00:02.000Z',
      1,
    )

    expect(reconcileControlSnapshot(current, newer)).toBe(newer)
  })
})
