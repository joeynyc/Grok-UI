import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { GrokStore } from './grok-store.js'
import type {
  LiveAgent,
  LiveAgentState,
  LiveFeedItem,
  LiveFeedType,
  LiveSnapshot,
  SessionRow,
} from './types.js'

type Json = Record<string, unknown>

interface ActiveSessionRecord {
  session_id: string
  pid: number
  cwd: string
  opened_at: string
}

interface ParsedUpdate {
  update: Json
  timestamp: string
}

interface LiveUsage {
  contextUsed: number
  contextSize: number
  costAmount: number
  costCurrency: string
  costTelemetryAvailable: boolean
}

const MAX_TAIL_BYTES = 512 * 1024
const MAX_FEED_ITEMS = 50
const WORKING_PHASES = new Set([
  'waiting_for_model',
  'streaming_reasoning',
  'streaming_text',
  'tool_execution',
])

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function timestampString(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000
    return new Date(milliseconds).toISOString()
  }
  return new Date(0).toISOString()
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
  const object = asObject(value)
  return asString(object.text)
    || asString(object.content)
    || (Array.isArray(object.content) ? contentText(object.content) : '')
}

function compactText(value: string, limit = 2_400): string {
  const cleaned = value.replace(/\u0000/g, '').trim()
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function tailLines(file: string, maxBytes = MAX_TAIL_BYTES): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(file, 'r')
    const stat = await handle.stat()
    const length = Math.min(stat.size, maxBytes)
    if (!length) return []
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, stat.size - length)
    const text = buffer.toString('utf8')
    const lines = text.split('\n').filter(Boolean)
    if (stat.size > maxBytes) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    await handle?.close()
  }
}

function parseUpdates(lines: string[]): ParsedUpdate[] {
  const parsed: ParsedUpdate[] = []
  for (const line of lines) {
    try {
      const root = JSON.parse(line)
      const roots = Array.isArray(root) ? root : [root]
      for (const item of roots) {
        const object = asObject(item)
        const params = asObject(object.params)
        const candidate = params.update ?? object.update ?? object
        const updates = Array.isArray(candidate) ? candidate : [candidate]
        for (const update of updates) {
          const normalized = asObject(update)
          if (!asString(normalized.sessionUpdate) && !asString(normalized.type)) continue
          parsed.push({
            update: normalized,
            timestamp: timestampString(object.timestamp),
          })
        }
      }
    } catch {
      // Ignore an incomplete final line while Grok is appending.
    }
  }
  return parsed
}

function updateTypeToFeed(type: string): LiveFeedType | null {
  if (type === 'user_message_chunk') return 'user'
  if (type === 'agent_message_chunk') return 'assistant'
  if (type === 'agent_thought_chunk') return 'thought'
  if (type === 'tool_call' || type === 'tool_call_update' || type.startsWith('task_')) return 'tool'
  if (type === 'plan') return 'plan'
  if (type === 'turn_completed') return 'system'
  return null
}

function feedFromUpdates(updates: ParsedUpdate[]): LiveFeedItem[] {
  const feed: LiveFeedItem[] = []
  const tools = new Map<string, LiveFeedItem>()

  updates.forEach(({ update, timestamp }, index) => {
    const updateType = asString(update.sessionUpdate) || asString(update.type)
    const type = updateTypeToFeed(updateType)
    if (!type) return
    const toolId = asString(update.toolCallId) || asString(update.tool_call_id)
    const status = asString(update.status)
    const title = asString(update.title)
      || asString(update.description)
      || (type === 'system' ? 'Turn completed' : updateType.replaceAll('_', ' '))
    const text = compactText(contentText(update.content)
      || asString(update.command)
      || asString(update.stop_reason)
      || asString(update.kind))
    const id = toolId || `${timestamp}:${index}:${updateType}`

    if (type === 'tool' && toolId) {
      const existing = tools.get(toolId)
      if (existing) {
        existing.title = title || existing.title
        existing.text = text || existing.text
        existing.status = status || existing.status
        existing.timestamp = timestamp || existing.timestamp
        return
      }
    }

    const item: LiveFeedItem = { id, type, title, text, status, timestamp }
    feed.push(item)
    if (type === 'tool' && toolId) tools.set(toolId, item)
  })

  return feed.slice(-MAX_FEED_ITEMS)
}

function usageFromUpdates(updates: ParsedUpdate[]): LiveUsage {
  const usage = [...updates].reverse().find(({ update }) => asString(update.sessionUpdate) === 'usage_update')?.update
  if (!usage) {
    return {
      contextUsed: 0,
      contextSize: 0,
      costAmount: 0,
      costCurrency: '',
      costTelemetryAvailable: false,
    }
  }
  const cost = asObject(usage.cost)
  return {
    contextUsed: asNumber(usage.used),
    contextSize: asNumber(usage.size),
    costAmount: asNumber(cost.amount),
    costCurrency: asString(cost.currency),
    costTelemetryAvailable: Object.keys(cost).length > 0,
  }
}

function latestPhase(lines: string[]): { phase: string; state: LiveAgentState; timestamp: string } {
  let phase = 'idle'
  let state: LiveAgentState = 'idle'
  let timestamp = new Date(0).toISOString()
  let turnOpen = false

  for (const line of lines) {
    try {
      const event = asObject(JSON.parse(line))
      const type = asString(event.type)
      timestamp = timestampString(event.ts) || timestamp
      if (type === 'turn_started') turnOpen = true
      if (type === 'turn_ended') {
        turnOpen = false
        phase = 'idle'
      }
      if (type === 'phase_changed') phase = asString(event.phase, phase)
    } catch {
      // Ignore an incomplete final line.
    }
  }

  if (turnOpen && phase === 'permission_prompt') state = 'attention'
  else if (turnOpen && WORKING_PHASES.has(phase)) state = phase === 'waiting_for_model' ? 'waiting' : 'working'
  return { phase, state, timestamp }
}

async function findSessionDirectory(sessionsRoot: string, sessionId: string): Promise<string | null> {
  let groups: Dirent[]
  try {
    groups = await fs.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const candidate = path.join(sessionsRoot, group.name, sessionId)
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate
    } catch {
      // Continue to the next workspace group.
    }
  }
  return null
}

function fallbackSession(record: ActiveSessionRecord): SessionRow {
  return {
    id: record.session_id,
    title: `Live session ${record.session_id.slice(0, 8)}`,
    summary: '',
    cwd: record.cwd,
    workspace: path.basename(record.cwd) || record.cwd,
    createdAt: record.opened_at,
    updatedAt: record.opened_at,
    model: 'unknown',
    agent: 'default',
    reasoningEffort: 'default',
    sandboxProfile: 'default',
    messages: 0,
    chatMessages: 0,
    turns: 0,
    toolCalls: 0,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: 0,
    contextUsage: 0,
    status: 'live',
    diskBytes: 0,
    archived: false,
  }
}

export class LiveMonitor extends EventEmitter {
  private watcher: FSWatcher | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private dashboardTimer: NodeJS.Timeout | null = null
  private livenessTimer: NodeJS.Timeout | null = null
  private current: LiveSnapshot = {
    generatedAt: new Date().toISOString(),
    connected: false,
    activeCount: 0,
    workingCount: 0,
    attentionCount: 0,
    agents: [],
  }

  constructor(private readonly store: GrokStore) {
    super()
  }

  async start(): Promise<void> {
    await this.refresh()
    this.watcher = chokidar.watch([
      path.join(this.store.grokHome, 'active_sessions.json'),
      path.join(this.store.grokHome, 'sessions'),
      path.join(this.store.grokHome, 'memory'),
      path.join(this.store.grokHome, 'skills'),
      path.join(this.store.grokHome, 'agents'),
    ], {
      ignoreInitial: true,
      ignored: [
        /[/\\]terminal[/\\]/,
        /[/\\]rewind_points/,
        /[/\\]chat_history/,
      ],
    })
    this.watcher.on('all', (_event, changedPath) => {
      this.scheduleRefresh()
      if (/(summary\.json|signals\.json|active_sessions\.json|MEMORY\.md|SKILL\.md)$/.test(changedPath)) {
        this.scheduleDashboard()
      }
    })
    await new Promise<void>((resolve) => this.watcher?.once('ready', () => resolve()))
    this.livenessTimer = setInterval(() => this.scheduleRefresh(), 2_000)
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.dashboardTimer) clearTimeout(this.dashboardTimer)
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
    await this.watcher?.close()
    this.watcher = null
  }

  snapshot(): LiveSnapshot {
    return this.current
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh(), 80)
  }

  private scheduleDashboard() {
    if (this.dashboardTimer) clearTimeout(this.dashboardTimer)
    this.dashboardTimer = setTimeout(async () => {
      try {
        const dashboard = await this.store.dashboard(true)
        this.emit('dashboard', dashboard)
      } catch {
        // The next write will retry.
      }
    }, 450)
  }

  private async refresh(): Promise<void> {
    const activeValue = await readJson(path.join(this.store.grokHome, 'active_sessions.json'))
    const activeRecords = Array.isArray(activeValue)
      ? activeValue.map((item) => asObject(item)).map((item): ActiveSessionRecord => ({
        session_id: asString(item.session_id),
        pid: asNumber(item.pid),
        cwd: asString(item.cwd),
        opened_at: asString(item.opened_at),
      })).filter((item) => item.session_id && processAlive(item.pid))
      : []
    const dashboard = await this.store.dashboard()
    const sessionsRoot = path.join(this.store.grokHome, 'sessions')
    const agents = await Promise.all(activeRecords.map(async (record): Promise<LiveAgent> => {
      const session = dashboard.sessions.find((item) => item.id === record.session_id) || fallbackSession(record)
      const directory = await findSessionDirectory(sessionsRoot, record.session_id)
      const [eventLines, updateLines] = directory
        ? await Promise.all([
          tailLines(path.join(directory, 'events.jsonl'), 192 * 1024),
          tailLines(path.join(directory, 'updates.jsonl')),
        ])
        : [[], []]
      const phase = latestPhase(eventLines)
      const parsedUpdates = parseUpdates(updateLines)
      const feed = feedFromUpdates(parsedUpdates)
      const usage = usageFromUpdates(parsedUpdates)
      const currentTool = phase.state === 'idle'
        ? ''
        : [...feed].reverse().find((item) =>
          item.type === 'tool' && !['completed', 'failed'].includes(item.status),
        )?.title || ''
      const updatedAt = feed.at(-1)?.timestamp || session.updatedAt || phase.timestamp
      return {
        id: record.session_id,
        pid: record.pid,
        title: session.title,
        cwd: record.cwd || session.cwd,
        workspace: session.workspace,
        openedAt: record.opened_at,
        updatedAt,
        model: session.model,
        phase: phase.phase,
        state: phase.state,
        turns: session.turns,
        toolCalls: session.toolCalls,
        contextUsage: usage.contextSize
          ? Math.max(0, Math.min(1, usage.contextUsed / usage.contextSize))
          : session.contextUsage,
        currentTool,
        ...usage,
        feed,
      }
    }))

    this.current = {
      generatedAt: new Date().toISOString(),
      connected: true,
      activeCount: agents.length,
      workingCount: agents.filter((agent) => agent.state === 'working' || agent.state === 'waiting').length,
      attentionCount: agents.filter((agent) => agent.state === 'attention').length,
      agents,
    }
    this.emit('live', this.current)
    const resolvedStatuses = new Map<string, 'live' | 'attention'>(
      agents.map((agent) => [agent.id, agent.state === 'attention' ? 'attention' : 'live']),
    )
    const liveStatusesChanged = this.store.setLiveStatuses(resolvedStatuses)
    if (liveStatusesChanged) this.emit('dashboard', await this.store.dashboard(true))
  }
}
