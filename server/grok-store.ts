import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  ActivityDay,
  DashboardPayload,
  LibraryItem,
  MemoryItem,
  RankedDatum,
  SessionRow,
  SessionStatus,
} from './types.js'
import { SessionStateStore } from './session-state.js'

type Json = Record<string, unknown>

const DAY_MS = 86_400_000
const RECENT_MS = 24 * 60 * 60_000

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item]
    const obj = asObject(item)
    const name = asString(obj.name) || asString(obj.toolName) || asString(obj.id)
    return name ? [name] : []
  })
}

async function readJson(file: string): Promise<Json> {
  try {
    return asObject(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return {}
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function listFilesNamed(root: string, fileName: string, depth = 4): Promise<string[]> {
  const found: string[] = []
  async function walk(current: string, level: number) {
    if (level > depth) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full, level + 1)
      else if (entry.isFile() && entry.name === fileName) found.push(full)
    }))
  }
  await walk(root, 0)
  return found
}

// Installer/cache bulk under ~/.grok (bin, downloads, …) can dominate I/O when
// sizing the whole home. Skip those top-level dirs so dashboard rebuilds stay
// bounded to session/library data (keeps the event loop responsive under load).
const DIRECTORY_SIZE_SKIP = new Set([
  'bin',
  'downloads',
  'vendor',
  'marketplace-cache',
  'bundled',
  'node_modules',
  '.git',
])

async function directorySize(root: string, depth = 5): Promise<number> {
  let total = 0
  async function walk(current: string, level: number) {
    if (level > depth) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (level === 0 && DIRECTORY_SIZE_SKIP.has(entry.name)) return
        await walk(full, level + 1)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full)
          const allocatedBytes = Number(stat.blocks || 0) * 512
          total += allocatedBytes || stat.size
        } catch { /* file changed while scanning */ }
      }
    }))
  }
  await walk(root, 0)
  return total
}

function workspaceName(cwd: string): string {
  if (!cwd) return 'Unknown workspace'
  const base = path.basename(cwd)
  return base || cwd
}

function historicalStatusFor(updatedAt: string): SessionStatus {
  const age = Date.now() - new Date(updatedAt).getTime()
  if (age < RECENT_MS) return 'recent'
  return 'idle'
}

function rank(map: Map<string, number>, limit = 8): RankedDatum[] {
  return [...map.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit)
}

function normalizeDate(input: string): string {
  const date = new Date(input)
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

async function sessionFromSummary(summaryFile: string): Promise<{
  row: SessionRow
  tools: string[]
  models: string[]
}> {
  const sessionDir = path.dirname(summaryFile)
  const [summary, signals, bytes] = await Promise.all([
    readJson(summaryFile),
    readJson(path.join(sessionDir, 'signals.json')),
    directorySize(sessionDir, 2),
  ])
  const info = asObject(summary.info)
  const id = asString(info.id, path.basename(sessionDir))
  const cwd = asString(info.cwd)
  const updatedAt = normalizeDate(
    asString(summary.updated_at) || asString(summary.last_active_at) || asString(summary.created_at),
  )
  const createdAt = normalizeDate(asString(summary.created_at) || updatedAt)
  const title = asString(summary.generated_title)
    || asString(summary.session_summary).split('\n')[0]
    || `Session ${id.slice(0, 8)}`
  const errors = asNumber(signals.errorCount) + asNumber(signals.toolFailureCount)
  const linesAdded = asNumber(signals.agentLinesAdded)
  const linesRemoved = asNumber(signals.agentLinesRemoved)
  const rawContextUsage = asNumber(signals.contextWindowUsage)
  const models = asStringArray(signals.modelsUsed)
  const primaryModel = asString(signals.primaryModelId)
    || asString(summary.current_model_id)
    || models[0]
    || 'unknown'

  return {
    row: {
      id,
      title,
      summary: asString(summary.session_summary),
      cwd,
      workspace: workspaceName(cwd),
      createdAt,
      updatedAt,
      model: primaryModel,
      agent: asString(summary.agent_name, 'default'),
      reasoningEffort: asString(summary.reasoning_effort, 'default'),
      sandboxProfile: asString(summary.sandbox_profile, 'default'),
      messages: asNumber(summary.num_messages),
      chatMessages: asNumber(summary.num_chat_messages),
      turns: asNumber(signals.turnCount),
      toolCalls: asNumber(signals.toolCallCount),
      errors,
      filesTouched: asNumber(signals.totalFilesTouched),
      linesAdded,
      linesRemoved,
      durationSeconds: asNumber(signals.sessionDurationSeconds),
      contextUsage: Math.max(0, Math.min(1, rawContextUsage > 1 ? rawContextUsage / 100 : rawContextUsage)),
      status: historicalStatusFor(updatedAt),
      diskBytes: bytes,
      archived: false,
    },
    tools: asStringArray(signals.toolsUsed),
    models: models.length ? models : [primaryModel],
  }
}

async function collectLibrary(grokHome: string): Promise<LibraryItem[]> {
  const roots: Array<{ root: string; source: LibraryItem['source']; kind: LibraryItem['kind']; marker: string }> = [
    { root: path.join(grokHome, 'bundled', 'skills'), source: 'bundled', kind: 'skill', marker: 'SKILL.md' },
    { root: path.join(grokHome, 'skills'), source: 'user', kind: 'skill', marker: 'SKILL.md' },
    { root: path.join(grokHome, 'bundled', 'agents'), source: 'bundled', kind: 'agent', marker: '.md' },
    { root: path.join(grokHome, 'agents'), source: 'user', kind: 'agent', marker: '.md' },
  ]
  const items: LibraryItem[] = []

  for (const item of roots) {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(item.root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (item.kind === 'skill' && entry.isDirectory() && await exists(path.join(item.root, entry.name, item.marker))) {
        items.push({ name: entry.name, source: item.source, kind: item.kind })
      }
      if (item.kind === 'agent' && entry.isFile() && entry.name.endsWith(item.marker)) {
        items.push({ name: path.basename(entry.name, item.marker), source: item.source, kind: item.kind })
      }
    }
  }

  const pluginFiles = await listFilesNamed(path.join(grokHome, 'marketplace-cache'), 'plugin.json', 3)
  for (const file of pluginFiles) {
    const manifest = await readJson(file)
    const name = asString(manifest.name) || path.basename(path.dirname(file))
    if (!items.some((item) => item.kind === 'plugin' && item.name === name)) {
      items.push({ name, source: 'marketplace', kind: 'plugin' })
    }
  }

  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

async function collectMemory(grokHome: string): Promise<MemoryItem[]> {
  const memoryRoot = path.join(grokHome, 'memory')
  const files = await listFilesNamed(memoryRoot, 'MEMORY.md', 4)
  const sessionFiles = await listFilesNamed(memoryRoot, 'sessions', 0)
  void sessionFiles
  const mdFiles: string[] = [...files]

  async function findMarkdown(current: string, depth: number) {
    if (depth > 5) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await findMarkdown(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.md') && !mdFiles.includes(full)) mdFiles.push(full)
    }))
  }
  await findMarkdown(memoryRoot, 0)

  const items = await Promise.all(mdFiles.map(async (file): Promise<MemoryItem | null> => {
    try {
      const stat = await fs.stat(file)
      const relative = path.relative(memoryRoot, file)
      const pieces = relative.split(path.sep)
      return {
        name: relative,
        scope: pieces.length === 1 ? 'global' : pieces.includes('sessions') ? 'session' : 'workspace',
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      }
    } catch {
      return null
    }
  }))
  return items.filter((item): item is MemoryItem => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function buildActivity(sessions: SessionRow[], days = 14): ActivityDay[] {
  const byDate = new Map<string, ActivityDay>()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today.getTime() - index * DAY_MS)
    const key = date.toISOString().slice(0, 10)
    byDate.set(key, {
      date: key,
      label: date.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2),
      sessions: 0,
      turns: 0,
      toolCalls: 0,
      errors: 0,
      linesChanged: 0,
    })
  }
  for (const session of sessions) {
    const day = byDate.get(session.updatedAt.slice(0, 10))
    if (!day) continue
    day.sessions += 1
    day.turns += session.turns
    day.toolCalls += session.toolCalls
    day.errors += session.errors
    day.linesChanged += session.linesAdded + session.linesRemoved
  }
  return [...byDate.values()]
}

export class GrokStore {
  readonly grokHome: string
  private cache: { at: number; payload: DashboardPayload } | null = null
  private liveStatuses = new Map<string, Extract<SessionStatus, 'live' | 'attention'>>()

  constructor(
    grokHome = process.env.GROK_HOME || path.join(os.homedir(), '.grok'),
    private readonly sessionState?: SessionStateStore,
  ) {
    this.grokHome = path.resolve(grokHome)
  }

  invalidate(): void {
    this.cache = null
  }

  setLiveStatuses(statuses: Map<string, Extract<SessionStatus, 'live' | 'attention'>>): boolean {
    const unchanged = statuses.size === this.liveStatuses.size
      && [...statuses].every(([id, status]) => this.liveStatuses.get(id) === status)
    if (unchanged) return false
    this.liveStatuses = new Map(statuses)
    this.invalidate()
    return true
  }

  async dashboard(force = false): Promise<DashboardPayload> {
    // 5s cache — full rebuild walks sessions + library + memory + data size.
    // 2s was short enough that the live-monitor liveness timer kept the
    // event loop busy under multi-session load.
    if (!force && this.cache && Date.now() - this.cache.at < 5_000) return this.cache.payload

    const sessionsRoot = path.join(this.grokHome, 'sessions')
    const summaryFiles = await listFilesNamed(sessionsRoot, 'summary.json', 3)
    const [sessionData, library, memory, dataBytes, versionJson] = await Promise.all([
      Promise.all(summaryFiles.map(sessionFromSummary)),
      collectLibrary(this.grokHome),
      collectMemory(this.grokHome),
      directorySize(this.grokHome, 4),
      readJson(path.join(this.grokHome, 'version.json')),
    ])
    const sessions = sessionData.map((item) => {
      const row = this.sessionState?.apply(item.row) || item.row
      const liveStatus = this.liveStatuses.get(row.id)
      return liveStatus ? { ...row, status: liveStatus } : row
    })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const models = new Map<string, number>()
    const tools = new Map<string, number>()
    const workspaces = new Map<string, number>()

    sessionData.forEach(({ row, models: sessionModels, tools: sessionTools }) => {
      sessionModels.forEach((model) => models.set(model, (models.get(model) || 0) + 1))
      sessionTools.forEach((tool) => tools.set(tool, (tools.get(tool) || 0) + 1))
      workspaces.set(row.workspace, (workspaces.get(row.workspace) || 0) + 1)
    })

    const payload: DashboardPayload = {
      generatedAt: new Date().toISOString(),
      grokHome: this.grokHome,
      version: asString(versionJson.version) || asString(versionJson.current_version) || 'installed',
      connected: await exists(this.grokHome),
      stats: {
        sessions: sessions.length,
        workspaces: new Set(sessions.map((session) => session.cwd)).size,
        turns: sessions.reduce((sum, session) => sum + session.turns, 0),
        toolCalls: sessions.reduce((sum, session) => sum + session.toolCalls, 0),
        errors: sessions.reduce((sum, session) => sum + session.errors, 0),
        filesTouched: sessions.reduce((sum, session) => sum + session.filesTouched, 0),
        linesChanged: sessions.reduce((sum, session) => sum + session.linesAdded + session.linesRemoved, 0),
        contextAverage: sessions.length
          ? sessions.reduce((sum, session) => sum + session.contextUsage, 0) / sessions.length
          : 0,
        dataBytes,
        liveSessions: sessions.filter((session) => session.status === 'live' || session.status === 'attention').length,
        memoryFiles: memory.length,
        skills: library.filter((item) => item.kind === 'skill').length,
      },
      sessions,
      activity: buildActivity(sessions),
      models: rank(models),
      tools: rank(tools, 10),
      workspaces: rank(workspaces, 10),
      library,
      memory,
    }
    this.cache = { at: Date.now(), payload }
    return payload
  }

  async session(id: string): Promise<SessionRow | null> {
    const safeId = id.replace(/[^a-zA-Z0-9-]/g, '')
    if (safeId !== id) return null
    const payload = await this.dashboard()
    return payload.sessions.find((session) => session.id === id) || null
  }
}
