import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeSessionFeed, SessionReader } from './session-reader.js'
import type { SessionRow } from './types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ))
})

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(directory)
  return directory
}

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-reader',
    title: 'Reader',
    summary: '',
    cwd: '/tmp/reader',
    workspace: 'reader',
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:01:00.000Z',
    model: 'grok-build',
    agent: 'default',
    reasoningEffort: 'medium',
    sandboxProfile: 'default',
    messages: 3,
    chatMessages: 2,
    turns: 1,
    toolCalls: 1,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: 60,
    contextUsage: 0.1,
    status: 'recent',
    diskBytes: 0,
    archived: false,
    ...overrides,
  }
}

async function writeUpdates(grokHome: string, session: SessionRow, lines: unknown[]): Promise<void> {
  const directory = path.join(grokHome, 'sessions', encodeURIComponent(session.cwd), session.id)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'updates.jsonl'),
    lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'),
  )
}

describe('SessionReader transcript updates', () => {
  it.each([
    { label: 'an ISO string', timestamp: '2026-07-24T10:00:01.500Z', expected: '2026-07-24T10:00:01.500Z' },
    { label: 'epoch seconds', timestamp: 1_784_887_200, expected: new Date(1_784_887_200 * 1_000).toISOString() },
    {
      label: 'the largest value still read as seconds',
      timestamp: 999_999_999_999,
      expected: new Date(999_999_999_999 * 1_000).toISOString(),
    },
    {
      label: 'the smallest value read as milliseconds',
      timestamp: 1_000_000_000_000,
      expected: new Date(1_000_000_000_000).toISOString(),
    },
    { label: 'epoch milliseconds', timestamp: 1_784_887_202_000, expected: new Date(1_784_887_202_000).toISOString() },
    { label: 'an unparseable string', timestamp: 'not-a-date', expected: '2026-07-24T10:00:00.000Z' },
    { label: 'a missing timestamp', timestamp: undefined, expected: '2026-07-24T10:00:00.000Z' },
  ])('normalizes $label to an ISO timestamp, falling back to the session creation time', async ({ timestamp, expected }) => {
    const grokHome = await temporary('grok-ui-timestamps-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      { timestamp, params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Stamped' } } } },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.timestamp)).toEqual([expected])
  })

  it('reads text from nested content parts and the uri fallback, and drops empty chunks', async () => {
    const grokHome = await temporary('grok-ui-content-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_200,
        params: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: [{ text: 'first part' }, { text: 'second part' }],
          },
        },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } } },
      },
      {
        timestamp: 1_784_887_202,
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'Thinking' } } },
      },
      {
        timestamp: 1_784_887_203,
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { uri: 'file:///tmp/notes.md' } },
        },
      },
      'this is not json and is ignored',
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => [item.type, item.text])).toEqual([
      ['user', 'first part\nsecond part'],
      ['thought', 'Thinking'],
      ['assistant', 'file:///tmp/notes.md'],
    ])
  })

  it.each([
    { length: 40_000, expected: 'x'.repeat(40_000) },
    { length: 40_001, expected: `${'x'.repeat(40_000)}\n\n[content truncated by Grok UI]` },
  ])('bounds feed item text of $length characters at 40,000 with a truncation marker', async ({ length, expected }) => {
    const grokHome = await temporary('grok-ui-bounded-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_200,
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x'.repeat(length) } },
        },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.text)).toEqual([expected])
  })
})

describe('SessionReader chat history fallback', () => {
  it('reads chat_history.jsonl when updates carry no user or assistant text', async () => {
    const grokHome = await temporary('grok-ui-history-')
    const session = sessionRow()
    const directory = path.join(grokHome, 'sessions', encodeURIComponent(session.cwd), session.id)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'updates.jsonl'), JSON.stringify({
      timestamp: 1_784_887_200,
      params: { update: { sessionUpdate: 'plan', entries: [{ content: 'Draft plan' }] } },
    }))
    await fs.writeFile(path.join(directory, 'chat_history.jsonl'), [
      { type: 'user', content: 'Original question' },
      { type: 'assistant', content: {} },
      { type: 'reasoning', content: [{ text: 'First thought' }, { text: 'Second thought' }] },
      { type: 'reasoning', content: {} },
      'corrupted line',
      { type: 'assistant', content: { text: 'Final answer' } },
      { type: 'user', content: '' },
    ].map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'))

    const transcript = await new SessionReader(grokHome).transcript(session)

    // History lines are stamped at the session creation time plus their line index in ms.
    const createdAt = new Date(session.createdAt).getTime()
    expect(transcript.map(({ type, title, text, timestamp }) => ({ type, title, text, timestamp }))).toEqual([
      { type: 'user', title: 'User message', text: 'Original question', timestamp: new Date(createdAt).toISOString() },
      {
        type: 'thought',
        title: 'Reasoning',
        text: 'First thought\nSecond thought',
        timestamp: new Date(createdAt + 2).toISOString(),
      },
      { type: 'assistant', title: 'Grok response', text: 'Final answer', timestamp: new Date(createdAt + 5).toISOString() },
    ])
  })

  it('prefers parsed updates over chat history when a real conversation exists', async () => {
    const grokHome = await temporary('grok-ui-updates-win-')
    const session = sessionRow()
    const directory = path.join(grokHome, 'sessions', encodeURIComponent(session.cwd), session.id)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'updates.jsonl'), JSON.stringify({
      timestamp: 1_784_887_200,
      params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Live question' } } },
    }))
    await fs.writeFile(path.join(directory, 'chat_history.jsonl'), JSON.stringify({
      type: 'user', content: 'Stale history question',
    }))

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.text)).toEqual(['Live question'])
  })

  it('finds the session directory through the legacy group layout', async () => {
    const grokHome = await temporary('grok-ui-group-lookup-')
    const session = sessionRow({ cwd: '/other/legacy-path' })
    const directory = path.join(grokHome, 'sessions', 'unrelated-group-name', session.id)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'updates.jsonl'), JSON.stringify({
      timestamp: 1_784_887_200,
      params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Found via group' } } },
    }))

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.text)).toEqual(['Found via group'])
  })

  it('returns an empty transcript when the session has no directory on disk', async () => {
    const grokHome = await temporary('grok-ui-missing-')
    const transcript = await new SessionReader(grokHome).transcript(sessionRow())
    expect(transcript).toEqual([])
  })
})

describe('SessionReader update kinds', () => {
  it('labels user, assistant, and thought chunks with stable display titles', async () => {
    const grokHome = await temporary('grok-ui-titles-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Question' } } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'Think' } } },
      },
      {
        timestamp: 1_784_887_202,
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Answer' } } },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => [item.type, item.title])).toEqual([
      ['user', 'User message'],
      ['thought', 'Reasoning'],
      ['assistant', 'Grok response'],
    ])
  })

  it('applies tool call and tool update titles and default statuses', async () => {
    const grokHome = await temporary('grok-ui-tool-kinds-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_199,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Go' } } },
      },
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1' } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-2' } },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.type)).toEqual(['user', 'tool', 'tool'])
    expect(transcript[1]).toMatchObject({
      title: 'Tool call', status: 'pending', id: expect.stringContaining('call-1'),
    })
    expect(transcript[2]).toMatchObject({
      title: 'Tool update', status: '', id: expect.stringContaining('call-2'),
    })
  })

  it('keeps separate tool calls without a toolCallId as individual rows', async () => {
    const grokHome = await temporary('grok-ui-tool-noid-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_199,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Go' } } },
      },
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'tool_call', title: 'first call' } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'tool_call', title: 'second call' } },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.title)).toEqual(['User message', 'first call', 'second call'])
    expect(transcript[1].id).not.toBe(transcript[2].id)
  })

  it('merges updates for one toolCallId without clearing a recorded status', async () => {
    const grokHome = await temporary('grok-ui-tool-status-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_199,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Go' } } },
      },
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', status: 'in_progress', title: 'run' } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'run tests' } },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript).toHaveLength(2)
    expect(transcript[1]).toMatchObject({ title: 'run tests', status: 'in_progress' })
  })

  it('projects plan and plan_update records with their entries or plan text', async () => {
    const grokHome = await temporary('grok-ui-plan-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_199,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Go' } } },
      },
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'plan', entries: [{ content: 'Step one' }, { content: 'Step two' }] } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'plan_update', plan: 'Updated plan body' } },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.type)).toEqual(['user', 'plan', 'plan'])
    expect(transcript[1]).toMatchObject({ title: 'Plan updated', text: 'Step one\nStep two' })
    expect(transcript[2]).toMatchObject({ title: 'Plan updated', text: 'Updated plan body' })
  })
})

describe('SessionReader coalescing', () => {
  it('merges adjacent chunks of the same type into one growing row', async () => {
    const grokHome = await temporary('grok-ui-coalesce-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'one ' } } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'two ' } } },
      },
      {
        timestamp: 1_784_887_202,
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'break' } } },
      },
      {
        timestamp: 1_784_887_203,
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'three ' } } },
      },
      {
        timestamp: 1_784_887_204,
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'four' } } },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => [item.type, item.text])).toEqual([
      ['user', 'one two '],
      ['thought', 'break'],
      ['assistant', 'three four'],
    ])
    expect(transcript[0].timestamp).toBe(new Date(1_784_887_201 * 1_000).toISOString())
    expect(transcript[2].timestamp).toBe(new Date(1_784_887_204 * 1_000).toISOString())
  })

  it('does not merge same-type chunks separated by another kind', async () => {
    const grokHome = await temporary('grok-ui-coalesce-gap-')
    const session = sessionRow()
    await writeUpdates(grokHome, session, [
      {
        timestamp: 1_784_887_200,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'first' } } },
      },
      {
        timestamp: 1_784_887_201,
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'gap' } } },
      },
      {
        timestamp: 1_784_887_202,
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'second' } } },
      },
    ])

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript.map((item) => item.text)).toEqual(['first', 'gap', 'second'])
  })

  it('caps the transcript at the newest 240 items', async () => {
    const grokHome = await temporary('grok-ui-cap-')
    const session = sessionRow()
    const lines = Array.from({ length: 242 }, (_, index) => ({
      timestamp: 1_784_887_200 + index,
      params: {
        update: index % 2 === 0
          ? { sessionUpdate: 'user_message_chunk', content: { text: `u${index}` } }
          : { sessionUpdate: 'agent_thought_chunk', content: { text: `t${index}` } },
      },
    }))
    await writeUpdates(grokHome, session, lines)

    const transcript = await new SessionReader(grokHome).transcript(session)

    expect(transcript).toHaveLength(240)
    expect(transcript[0].text).toBe('u2')
    expect(transcript.at(-1)?.text).toBe('t241')
  })
})

describe('mergeSessionFeed', () => {
  const item = (overrides: Record<string, unknown>) => ({
    id: 'item-1',
    type: 'assistant' as const,
    title: 'Grok response',
    text: 'hello',
    status: '',
    timestamp: '2026-07-24T10:00:00.000Z',
    ...overrides,
  })

  it.each([
    { legacy: 'user message chunk', type: 'user' as const, title: 'User message' },
    { legacy: 'agent message chunk', type: 'assistant' as const, title: 'Grok response' },
    { legacy: 'agent thought chunk', type: 'thought' as const, title: 'Reasoning' },
  ])('renames the legacy "$legacy" label to "$title"', ({ legacy, type, title }) => {
    const merged = mergeSessionFeed([item({ type, title: legacy, text: 'body' })])

    expect(merged.map((entry) => entry.title)).toEqual([title])
  })

  it('deduplicates text-less items on the trimmed title and status', () => {
    const merged = mergeSessionFeed([
      item({ id: 'a', type: 'tool', title: ' Read ', text: '', status: 'done' }),
      item({ id: 'b', type: 'tool', title: 'Read', text: '', status: 'done' }),
      item({ id: 'c', type: 'tool', title: 'Read', text: '', status: 'running' }),
    ])

    expect(merged.map((entry) => entry.id)).toEqual(['a', 'c'])
  })

  it('sorts merged items by timestamp and caps at the newest 240', () => {
    const items = Array.from({ length: 245 }, (_, index) => item({
      id: `i-${index}`,
      text: `body ${index}`,
      timestamp: new Date(1_784_887_200_000 - index * 1_000).toISOString(),
    }))

    const merged = mergeSessionFeed(items)

    expect(merged).toHaveLength(240)
    expect(merged[0].id).toBe('i-239')
    expect(merged.map((entry) => entry.id)).not.toContain('i-240')
    expect(merged.at(-1)?.id).toBe('i-0')
    expect(new Date(merged[0].timestamp).getTime())
      .toBeLessThan(new Date(merged.at(-1)!.timestamp).getTime())
  })
})
