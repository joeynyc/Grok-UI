import { describe, expect, it } from 'vitest'
import { usageExport } from './usage-export.js'
import type { UsageLedgerEntry, UsageReport } from './types.js'

function ledgerEntry(overrides: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    id: 'usage:entry-1',
    kind: 'managed-session',
    sessionId: 'session-secret-1',
    sessionTitle: 'Secret launch plan',
    workflowId: 'workflow-secret-1',
    project: 'secret-project',
    cwd: '/private/secret-project',
    model: 'grok-build',
    agent: 'builder-7',
    startedAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T11:00:00.000Z',
    inputTokens: { value: 1_000, source: 'grok-reported' },
    outputTokens: { value: 500, source: 'derived' },
    totalTokens: { value: 1_500, source: 'grok-reported' },
    cost: { value: 0.42, source: 'derived', currency: 'USD' },
    ...overrides,
  }
}

function report(entries: UsageLedgerEntry[]): UsageReport {
  return {
    generatedAt: '2026-07-26T12:00:00.000Z',
    period: 'all',
    scope: 'all',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-26T12:00:00.000Z',
    groupBy: 'project',
    entries,
    totals: {
      key: '*',
      label: 'All usage',
      entries: entries.length,
      sessions: entries.length,
      inputTokens: { value: null, source: 'unavailable' },
      outputTokens: { value: null, source: 'unavailable' },
      totalTokens: { value: null, source: 'unavailable' },
      costs: [],
      updatedAt: '2026-07-26T12:00:00.000Z',
    },
    groups: [],
    coverage: { 'grok-reported': 0, derived: 0, incomplete: 0, unavailable: 0 },
  }
}

describe('usageExport privacy redaction', () => {
  it('aliases every identifier while keeping public telemetry and timestamps', () => {
    const { body, contentType, extension } = usageExport(report([ledgerEntry()]), 'json', true)
    expect(contentType).toBe('application/json; charset=utf-8')
    expect(extension).toBe('json')

    const exported = JSON.parse(body)
    expect(exported.privacyApplied).toBe(true)
    expect(exported.entries).toHaveLength(1)
    const redacted = exported.entries[0]

    expect(redacted.id).toMatch(/^usage:private-[a-z0-9]{3}$/)
    expect(redacted.sessionId).toMatch(/^session-[a-z0-9]{3}$/)
    expect(redacted.sessionTitle).toMatch(/^Session [A-Z0-9]{3}$/)
    expect(redacted.workflowId).toMatch(/^workflow-[a-z0-9]{3}$/)
    expect(redacted.project).toMatch(/^Workspace [A-Z0-9]{3}$/)
    expect(redacted.cwd).toMatch(/^~\/workspace-[a-z0-9]{3}$/)
    expect(redacted.agent).toBe('builder-7')

    expect(body).not.toContain('secret')
    expect(redacted.totalTokens).toEqual({ value: 1_500, source: 'grok-reported' })
    expect(redacted.cost).toMatchObject({ value: 0.42, currency: 'USD' })
    expect(redacted.startedAt).toBe('2026-07-24T10:00:00.000Z')
  })

  it('aliases the agent only for workflow-agent entries', () => {
    const workflowAgent = ledgerEntry({ id: 'usage:a', kind: 'workflow-agent', agent: 'private-builder' })
    const managedSession = ledgerEntry({ id: 'usage:b', kind: 'managed-session', agent: 'private-builder' })

    const exported = JSON.parse(usageExport(report([workflowAgent, managedSession]), 'json', true).body)

    expect(exported.entries[0].agent).toMatch(/^Agent [A-Z0-9]{3}$/)
    expect(exported.entries[1].agent).toBe('private-builder')
    expect(JSON.stringify(exported.entries[0])).not.toContain('private-builder')
  })

  it('derives aliases deterministically and gives different sessions different aliases', () => {
    const first = ledgerEntry({ id: 'usage:one', sessionId: 'session-alpha' })
    const second = ledgerEntry({ id: 'usage:two', sessionId: 'session-beta', project: 'other-project', cwd: '/private/other' })

    const exported = JSON.parse(usageExport(report([first, second]), 'json', true).body)
    const again = JSON.parse(usageExport(report([first, second]), 'json', true).body)

    expect(exported.entries[0].sessionId).toBe(again.entries[0].sessionId)
    expect(exported.entries[0].sessionId).not.toBe(exported.entries[1].sessionId)
    expect(exported.entries[0].project).not.toBe(exported.entries[1].project)
    expect(exported.entries[0].id).not.toBe(exported.entries[1].id)
  })

  it('falls back to the entry id and project for aliases when session id and cwd are empty', () => {
    const sparse = (id: string, project: string) => ledgerEntry({ id, project, sessionId: '', cwd: '' })

    const exported = JSON.parse(usageExport(report([
      sparse('usage:one', 'alpha-project'),
      sparse('usage:two', 'beta-project'),
      sparse('usage:three', 'alpha-project'),
    ]), 'json', true).body)
    const [one, two, three] = exported.entries

    expect(new Set([one.sessionId, two.sessionId, three.sessionId]).size).toBe(3)
    expect(one.cwd).toBe(three.cwd)
    expect(one.project).toBe(three.project)
    expect(one.cwd).not.toBe(two.cwd)
    expect(one.project).not.toBe(two.project)
  })

  it('leaves identifiers untouched when privacy is off', () => {
    const exported = JSON.parse(usageExport(report([ledgerEntry()]), 'json', false).body)

    expect(exported.privacyApplied).toBe(false)
    expect(exported.entries[0]).toMatchObject({
      id: 'usage:entry-1',
      sessionId: 'session-secret-1',
      sessionTitle: 'Secret launch plan',
      project: 'secret-project',
      cwd: '/private/secret-project',
    })
  })
})

describe('usageExport CSV output', () => {
  it('quotes and escapes cells containing separators without changing plain values', () => {
    const messy = ledgerEntry({
      sessionTitle: 'Launch, "phase 2"',
      project: 'multi\nline',
      cwd: '/plain/path',
    })

    const { body, contentType, extension } = usageExport(report([messy]), 'csv', false)
    expect(contentType).toBe('text/csv; charset=utf-8')
    expect(extension).toBe('csv')

    const lines = body.split('\n')
    expect(lines[0].split(',')).toEqual([
      'kind', 'session_id', 'session_title', 'workflow_id', 'project', 'cwd', 'model', 'agent',
      'started_at', 'updated_at', 'input_tokens', 'input_source', 'output_tokens', 'output_source',
      'total_tokens', 'total_source', 'cost', 'currency', 'cost_source',
    ])
    expect(lines.slice(1).join('\n')).toContain('"Launch, ""phase 2"""')
    expect(lines.slice(1).join('\n')).toContain('"multi\nline"')
    expect(lines.slice(1).join('\n')).toContain(',/plain/path,')
    expect(lines.at(-1)).toContain(',grok-build,')
  })
})

describe('usageExport entry cap', () => {
  it.each([
    { count: 1, truncated: false, exported: 1 },
    { count: 5_000, truncated: false, exported: 5_000 },
    { count: 5_001, truncated: true, exported: 5_000 },
  ])('exports $exported of $count entries with truncated $truncated', ({ count, truncated, exported }) => {
    const entries = Array.from({ length: count }, (_, index) =>
      ledgerEntry({ id: `usage:capped-${index}`, sessionId: `session-${index}` }))

    const json = JSON.parse(usageExport(report(entries), 'json', false).body)
    expect(json.truncated).toBe(truncated)
    expect(json.entries).toHaveLength(exported)
    expect(json.entries.at(-1).id).toBe(`usage:capped-${exported - 1}`)

    const csv = usageExport(report(entries), 'csv', false)
    expect(csv.body.split('\n')).toHaveLength(exported + 1)
  })
})

describe('usageExport edge cells', () => {
  it('writes an empty CSV cell for null metric values', () => {
    const entry = ledgerEntry({
      inputTokens: { value: null, source: 'unavailable' },
      cost: { value: null, source: 'unavailable', currency: '' },
    })

    const { body } = usageExport(report([entry]), 'csv', false)

    expect(body).not.toContain('null')
    const cells = body.split('\n')[1].split(',')
    expect(cells[10]).toBe('')
    expect(cells[16]).toBe('')
  })
})
