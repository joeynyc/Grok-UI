import { describe, expect, it } from 'vitest'
import { transcriptMarkdown } from './session-transcript.js'
import type { SessionRow } from './types.js'

describe('transcript export', () => {
  it('writes a markdown transcript without inventing content', () => {
    const markdown = transcriptMarkdown(
      { id: 'sess-1', title: 'Launch', cwd: '/repo', model: 'grok-e2e', updatedAt: '2026-08-25T00:00:00.000Z' } as SessionRow,
      [{ id: '1', type: 'user', title: 'user', text: 'Fix the test', status: '', timestamp: '2026-08-25T00:00:00.000Z' }],
    )
    expect(markdown).toContain('# Launch')
    expect(markdown).toContain('Fix the test')
    expect(markdown).toContain('sess-1')
  })
})
