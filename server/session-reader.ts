import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { LiveFeedItem, SessionRow } from './types.js'

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 240
const MAX_ITEM_TEXT = 40_000

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timestamp(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value < 1_000_000_000_000 ? value * 1_000 : value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return fallback
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => contentText(item)).filter(Boolean).join('\n')
  }
  const item = object(value)
  return string(item.text) || string(item.content) || string(item.uri)
}

async function tailLines(file: string): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(file, 'r')
    const stat = await handle.stat()
    const length = Math.min(stat.size, MAX_SOURCE_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, stat.size - length)
    let text = buffer.toString('utf8')
    if (length < stat.size) text = text.slice(text.indexOf('\n') + 1)
    return text.split('\n').filter(Boolean)
  } catch {
    return []
  } finally {
    await handle?.close()
  }
}

function boundedText(value: string): string {
  if (value.length <= MAX_ITEM_TEXT) return value
  return `${value.slice(0, MAX_ITEM_TEXT)}\n\n[content truncated by Grok UI]`
}

type DiskFeedItem = LiveFeedItem & { toolCallId?: string }

function updateItem(line: string, index: number, fallback: string): DiskFeedItem | null {
  let record: Json
  try {
    record = object(JSON.parse(line))
  } catch {
    return null
  }
  const params = object(record.params)
  const update = object(params.update)
  const kind = string(update.sessionUpdate)
  const at = timestamp(record.timestamp, fallback)
  const base = {
    id: `disk:${index}:${at}:${kind}`,
    timestamp: at,
    status: string(update.status),
  }
  if (kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const text = boundedText(contentText(update.content))
    if (!text) return null
    return {
      ...base,
      type: kind === 'user_message_chunk'
        ? 'user'
        : kind === 'agent_message_chunk' ? 'assistant' : 'thought',
      title: kind === 'user_message_chunk'
        ? 'User message'
        : kind === 'agent_message_chunk' ? 'Grok response' : 'Reasoning',
      text,
    }
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolCallId = string(update.toolCallId)
    return {
      ...base,
      id: `disk:${toolCallId || index}:${at}:${kind}`,
      type: 'tool',
      title: string(update.title) || (kind === 'tool_call' ? 'Tool call' : 'Tool update'),
      text: '',
      status: string(update.status) || (kind === 'tool_call' ? 'pending' : ''),
      toolCallId: toolCallId || undefined,
    }
  }
  if (kind === 'plan' || kind === 'plan_update') {
    return {
      ...base,
      type: 'plan',
      title: 'Plan updated',
      text: boundedText(contentText(update.entries) || contentText(update.plan)),
    }
  }
  return null
}

function historyItem(line: string, index: number, fallback: string): LiveFeedItem | null {
  let record: Json
  try {
    record = object(JSON.parse(line))
  } catch {
    return null
  }
  const kind = string(record.type)
  const text = boundedText(contentText(record.content))
  const at = new Date(new Date(fallback).getTime() + index).toISOString()
  if (kind === 'user' && text) {
    return { id: `history:${index}:user`, type: 'user', title: 'User message', text, status: '', timestamp: at }
  }
  if (kind === 'assistant' && text) {
    return { id: `history:${index}:assistant`, type: 'assistant', title: 'Grok response', text, status: '', timestamp: at }
  }
  if (kind === 'reasoning' && text) {
    return { id: `history:${index}:reasoning`, type: 'thought', title: 'Reasoning', text, status: '', timestamp: at }
  }
  return null
}

function coalesce(items: DiskFeedItem[]): LiveFeedItem[] {
  const output: LiveFeedItem[] = []
  const toolRows = new Map<string, LiveFeedItem>()
  for (const item of items) {
    const previous = output.at(-1)
    if (
      previous
      && previous.type === item.type
      && previous.title === item.title
      && ['user', 'assistant', 'thought'].includes(item.type)
    ) {
      previous.text = boundedText(`${previous.text}${item.text}`)
      previous.timestamp = item.timestamp
      continue
    }
    const { toolCallId, ...row } = item
    if (item.type === 'tool' && toolCallId) {
      // Grok emits one tool_call followed by several tool_call_update records
      // for the same call. Show a single row that carries the most descriptive
      // title Grok has provided so far and the latest status.
      const existing = toolRows.get(toolCallId)
      if (existing) {
        if (row.title && row.title !== 'Tool update') existing.title = row.title
        if (row.status) existing.status = row.status
        existing.timestamp = row.timestamp
        continue
      }
      toolRows.set(toolCallId, row)
    }
    output.push(row)
  }
  return output.slice(-MAX_ITEMS)
}

export class SessionReader {
  constructor(private readonly grokHome: string) {}

  async transcript(session: SessionRow): Promise<LiveFeedItem[]> {
    const directory = await this.findDirectory(session)
    if (!directory) return []
    const updateLines = await tailLines(path.join(directory, 'updates.jsonl'))
    const updates = coalesce(updateLines
      .map((line, index) => updateItem(line, index, session.createdAt))
      .filter((item): item is LiveFeedItem => item !== null))
    if (updates.some((item) => item.type === 'user' || item.type === 'assistant')) return updates

    const historyLines = await tailLines(path.join(directory, 'chat_history.jsonl'))
    return historyLines
      .map((line, index) => historyItem(line, index, session.createdAt))
      .filter((item): item is LiveFeedItem => item !== null)
      .slice(-MAX_ITEMS)
  }

  private async findDirectory(session: SessionRow): Promise<string | null> {
    const root = path.join(this.grokHome, 'sessions')
    const direct = path.join(root, encodeURIComponent(session.cwd), session.id)
    try {
      if ((await fs.stat(direct)).isDirectory()) return direct
    } catch {
      // Fall through to bounded group lookup for older Grok encodings.
    }
    let groups: Dirent[]
    try {
      groups = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return null
    }
    for (const group of groups) {
      if (!group.isDirectory()) continue
      const candidate = path.join(root, group.name, session.id)
      try {
        if ((await fs.stat(candidate)).isDirectory()) return candidate
      } catch {
        // Keep looking.
      }
    }
    return null
  }
}

/** Labels written by earlier Grok UI versions, kept readable for sessions persisted before the rename. */
const LEGACY_TITLES: Record<string, string> = {
  'user message chunk': 'User message',
  'agent message chunk': 'Grok response',
  'agent thought chunk': 'Reasoning',
}

export function mergeSessionFeed(...feeds: LiveFeedItem[][]): LiveFeedItem[] {
  const seen = new Set<string>()
  return feeds.flat()
    .map((item) => LEGACY_TITLES[item.title] ? { ...item, title: LEGACY_TITLES[item.title] } : item)
    .filter((item) => {
      const key = item.text
        ? `${item.type}\u0000${item.text.trim()}`
        : `${item.type}\u0000${item.title.trim()}\u0000${item.status}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-MAX_ITEMS)
}
