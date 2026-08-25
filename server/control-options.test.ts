import { describe, expect, it } from 'vitest'
import {
  launchMeta,
  parseExitPlanRequest,
  parsePermissionMode,
  planActionPrompt,
  planExitVerdict,
  slashPrompt,
} from './control-options.js'

describe('launch options', () => {
  it('maps permission and plan flags into ACP meta', () => {
    expect(launchMeta({
      cwd: '/repo',
      prompt: 'go',
      permissionMode: 'always-approve',
      planMode: true,
      worktree: true,
      model: 'grok-e2e',
    })).toMatchObject({
      clientIdentifier: 'grok-ui',
      modelId: 'grok-e2e',
      yoloMode: true,
      autoMode: false,
      planMode: true,
      worktree: true,
    })
    expect(parsePermissionMode('auto')).toBe('auto')
    expect(parsePermissionMode('nope')).toBe('ask')
  })

  it('builds plan and slash prompts', () => {
    expect(planActionPrompt('approve')).toContain('Approve')
    expect(planActionPrompt('request-changes', 'keep tests')).toContain('keep tests')
    expect(() => planActionPrompt('comment')).toThrow(/comment/)
    expect(slashPrompt('create-workflow', 'review the branch')).toBe('/create-workflow review the branch')
    expect(slashPrompt('compact')).toBe('/compact')
    expect(planExitVerdict('approve')).toBe('approved')
    expect(planExitVerdict('quit')).toBe('abandoned')
    expect(planExitVerdict('request-changes')).toBe('rejected')
    expect(parseExitPlanRequest({
      sessionId: 'sess-1',
      planContent: 'Ship the fixture',
    })).toEqual({ sessionId: 'sess-1', plan: 'Ship the fixture' })
  })
})
