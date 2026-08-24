import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ControlSnapshot,
  ExternalCallCategory,
  ExternalToolCall,
  LiveFeedItem,
  LiveSnapshot,
  RuntimeBindScope,
  RuntimePort,
  RuntimeProcess,
  RuntimeProcessState,
  RuntimeRoot,
  RuntimeService,
  RuntimeServiceKind,
  RuntimeSnapshot,
  RuntimeTestRun,
  RuntimeTestStatus,
} from './types.js'

const execFileAsync = promisify(execFile)
const MAX_PROCESSES = 160
const MAX_DEPTH = 8
const MAX_OUTPUT_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 1_500
const MAX_SIGNALS = 80
const RETAIN_SIGNAL_MS = 10 * 60_000

interface ProcessRecord {
  pid: number
  parentPid: number
  state: RuntimeProcessState
  elapsed: string
  name: string
}

interface RuntimeCommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<string>
}

interface ProjectedSignals {
  tests: RuntimeTestRun[]
  externalCalls: ExternalToolCall[]
}

interface SignalFeed {
  sessionId: string
  items: LiveFeedItem[]
}

class SystemCommandRunner implements RuntimeCommandRunner {
  async run(command: string, args: string[], timeoutMs: number): Promise<string> {
    try {
      const result = await execFileAsync(command, args, {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      })
      return result.stdout
    } catch (error) {
      const failure = error as { code?: number; stdout?: string }
      // lsof uses exit code 1 for a valid query with no matching listeners.
      if (command === 'lsof' && failure.code === 1 && typeof failure.stdout === 'string') {
        return failure.stdout
      }
      throw error
    }
  }
}

function safeName(value: string): string {
  const first = value.trim().split(/\s+/)[0] || 'process'
  return path.basename(first).replace(/[^\w.+-]/g, '').slice(0, 80) || 'process'
}

function safeTitle(value: string): string {
  const cleaned = value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 180)
}

function processState(value: string): RuntimeProcessState {
  const state = value.trim().charAt(0).toUpperCase()
  if (state === 'R') return 'running'
  if (state === 'S' || state === 'I' || state === 'D') return 'sleeping'
  if (state === 'T') return 'stopped'
  if (state === 'Z') return 'zombie'
  return 'unknown'
}

export function parseProcessTable(output: string): ProcessRecord[] {
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!match) return []
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) return []
    return [{
      pid,
      parentPid,
      state: processState(match[3]),
      elapsed: match[4].slice(0, 24),
      name: safeName(match[5]),
    }]
  })
}

function mergeRoots(roots: RuntimeRoot[]): RuntimeRoot[] {
  const merged = new Map<number, RuntimeRoot>()
  roots.forEach((root) => {
    if (!Number.isInteger(root.pid) || root.pid <= 0) return
    const existing = merged.get(root.pid)
    if (!existing) {
      merged.set(root.pid, {
        ...root,
        sessionIds: [...new Set(root.sessionIds)].slice(0, 80),
        workspaces: [...new Set(root.workspaces)].slice(0, 80),
      })
      return
    }
    existing.managed ||= root.managed
    existing.sessionIds = [...new Set([...existing.sessionIds, ...root.sessionIds])].slice(0, 80)
    existing.workspaces = [...new Set([...existing.workspaces, ...root.workspaces])].slice(0, 80)
  })
  return [...merged.values()].sort((left, right) => left.pid - right.pid)
}

export function selectProcessTree(records: ProcessRecord[], roots: RuntimeRoot[]): RuntimeProcess[] {
  const recordsByPid = new Map(records.map((record) => [record.pid, record]))
  const children = new Map<number, ProcessRecord[]>()
  records.forEach((record) => {
    const siblings = children.get(record.parentPid) || []
    siblings.push(record)
    children.set(record.parentPid, siblings)
  })
  children.forEach((items) => items.sort((left, right) => left.pid - right.pid))

  const selected = new Map<number, RuntimeProcess>()
  for (const root of mergeRoots(roots)) {
    const queue: Array<{ pid: number; depth: number }> = [{ pid: root.pid, depth: 0 }]
    const visited = new Set<number>()
    while (queue.length && selected.size < MAX_PROCESSES) {
      const current = queue.shift()!
      if (visited.has(current.pid) || current.depth > MAX_DEPTH) continue
      visited.add(current.pid)
      const record = recordsByPid.get(current.pid)
      if (!record) continue
      const existing = selected.get(current.pid)
      if (existing) {
        existing.sessionIds = [...new Set([...existing.sessionIds, ...root.sessionIds])].slice(0, 80)
        existing.workspaces = [...new Set([...existing.workspaces, ...root.workspaces])].slice(0, 80)
      } else {
        selected.set(current.pid, {
          pid: record.pid,
          parentPid: record.parentPid,
          rootPid: root.pid,
          depth: current.depth,
          name: record.name,
          state: record.state,
          elapsed: record.elapsed,
          sessionIds: [...root.sessionIds],
          workspaces: [...root.workspaces],
          ports: [],
        })
      }
      if (current.depth < MAX_DEPTH) {
        for (const child of children.get(current.pid) || []) {
          queue.push({ pid: child.pid, depth: current.depth + 1 })
        }
      }
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.rootPid - right.rootPid || left.depth - right.depth || left.pid - right.pid)
}

function bindScope(host: string): RuntimeBindScope {
  const normalized = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (normalized === '*' || normalized === '0.0.0.0' || normalized === '::') return 'all'
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') return 'loopback'
  if (
    /^10\./.test(normalized)
    || /^192\.168\./.test(normalized)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
    || /^fe80:/.test(normalized)
  ) return 'lan'
  return normalized ? 'unknown' : 'unknown'
}

function portFromAddress(value: string): { port: number; bind: RuntimeBindScope } | null {
  const cleaned = value.trim()
  const match = cleaned.match(/^(.*):(\d+)$/)
  if (!match) return null
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { port, bind: bindScope(match[1]) }
}

export function parseLsofPorts(output: string, allowedPids: Set<number>): RuntimePort[] {
  const ports: RuntimePort[] = []
  let pid = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      continue
    }
    if (!line.startsWith('n') || !allowedPids.has(pid)) continue
    const parsed = portFromAddress(line.slice(1))
    if (parsed) ports.push({ pid, protocol: 'tcp', ...parsed })
  }
  return dedupePorts(ports)
}

export function parseSsPorts(output: string, allowedPids: Set<number>): RuntimePort[] {
  const ports: RuntimePort[] = []
  for (const line of output.split('\n')) {
    const pidMatches = [...line.matchAll(/\bpid=(\d+)/g)].map((match) => Number(match[1]))
    const address = line.split(/\s+/).find((token) => portFromAddress(token))
    const parsed = address ? portFromAddress(address) : null
    if (!parsed) continue
    pidMatches.forEach((pid) => {
      if (allowedPids.has(pid)) ports.push({ pid, protocol: 'tcp', ...parsed })
    })
  }
  return dedupePorts(ports)
}

function dedupePorts(ports: RuntimePort[]): RuntimePort[] {
  return [...new Map(ports.map((port) => [`${port.pid}:${port.port}`, port])).values()]
    .sort((left, right) => left.port - right.port || left.pid - right.pid)
}

function knownService(name: string, port: number): { name: string; kind: RuntimeServiceKind } | null {
  const process = name.toLowerCase()
  const rules: Array<[RegExp, string, RuntimeServiceKind]> = [
    [/postgres|postmaster/, 'PostgreSQL', 'database'],
    [/mysqld|mariadb/, 'MySQL', 'database'],
    [/mongod/, 'MongoDB', 'database'],
    [/sqlite/, 'SQLite', 'database'],
    [/cockroach/, 'CockroachDB', 'database'],
    [/clickhouse/, 'ClickHouse', 'database'],
    [/neo4j/, 'Neo4j', 'database'],
    [/influxd/, 'InfluxDB', 'database'],
    [/redis|valkey/, 'Redis', 'cache'],
    [/memcached/, 'Memcached', 'cache'],
    [/rabbitmq/, 'RabbitMQ', 'queue'],
    [/kafka/, 'Kafka', 'queue'],
    [/\bnats/, 'NATS', 'queue'],
    [/localstack/, 'LocalStack', 'emulator'],
    [/firebase/, 'Firebase Emulator', 'emulator'],
    [/azurite/, 'Azurite', 'emulator'],
    [/supabase/, 'Supabase', 'emulator'],
    [/vite/, 'Vite', 'dev-server'],
    [/next/, 'Next.js', 'dev-server'],
    [/nuxt/, 'Nuxt', 'dev-server'],
    [/webpack/, 'Webpack', 'dev-server'],
    [/astro/, 'Astro', 'dev-server'],
    [/uvicorn|gunicorn|flask|django/, 'Python web service', 'dev-server'],
    [/rails|puma/, 'Rails', 'dev-server'],
  ]
  const processMatch = rules.find(([pattern]) => pattern.test(process))
  if (processMatch) return { name: processMatch[1], kind: processMatch[2] }

  const ports: Record<number, { name: string; kind: RuntimeServiceKind }> = {
    3000: { name: 'Web development server', kind: 'dev-server' },
    3306: { name: 'MySQL', kind: 'database' },
    4173: { name: 'Vite preview', kind: 'dev-server' },
    4310: { name: 'Grok UI', kind: 'web' },
    5432: { name: 'PostgreSQL', kind: 'database' },
    5672: { name: 'RabbitMQ', kind: 'queue' },
    6379: { name: 'Redis', kind: 'cache' },
    8000: { name: 'Local web service', kind: 'web' },
    8080: { name: 'Local web service', kind: 'web' },
    8123: { name: 'ClickHouse', kind: 'database' },
    9200: { name: 'Elasticsearch', kind: 'database' },
    27017: { name: 'MongoDB', kind: 'database' },
  }
  return ports[port] || null
}

export function classifyServices(processes: RuntimeProcess[], ports: RuntimePort[]): RuntimeService[] {
  const processByPid = new Map(processes.map((process) => [process.pid, process]))
  const services: RuntimeService[] = ports.map((port) => {
    const process = processByPid.get(port.pid)
    const classified = knownService(process?.name || '', port.port)
    return {
      id: `service:${port.pid}:${port.port}`,
      pid: port.pid,
      name: classified?.name || safeName(process?.name || 'Local service'),
      kind: classified?.kind || 'other',
      port: port.port,
      bind: port.bind,
      status: 'listening',
    }
  })
  processes.forEach((process) => {
    if (ports.some((port) => port.pid === process.pid)) return
    const classified = knownService(process.name, 0)
    if (!classified || !['database', 'cache', 'queue', 'emulator'].includes(classified.kind)) return
    services.push({
      id: `service:${process.pid}:${classified.kind}`,
      pid: process.pid,
      name: classified.name,
      kind: classified.kind,
      port: 0,
      bind: 'unknown',
      status: 'running',
    })
  })
  return services.slice(0, MAX_PROCESSES)
}

function testFramework(title: string): string {
  const normalized = title.toLowerCase()
  if (normalized.includes('vitest')) return 'Vitest'
  if (normalized.includes('jest')) return 'Jest'
  if (normalized.includes('playwright')) return 'Playwright'
  if (normalized.includes('pytest')) return 'pytest'
  if (normalized.includes('xcodebuild')) return 'XCTest'
  if (normalized.includes('swift test')) return 'Swift Testing'
  if (normalized.includes('cargo test')) return 'Cargo'
  if (normalized.includes('go test')) return 'Go'
  if (normalized.includes('rspec')) return 'RSpec'
  return 'Test command'
}

function isTestTitle(title: string): boolean {
  return /\b(test|tests|testing|vitest|jest|playwright|pytest|xcodebuild|rspec)\b/i.test(title)
}

function testStatus(status: string): RuntimeTestStatus {
  const normalized = status.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  if (['pending', 'in_progress', 'running', 'started'].includes(normalized)) return 'running'
  if (['completed', 'success', 'succeeded', 'passed', 'done'].includes(normalized)) return 'passed'
  if (['failed', 'failure', 'error'].includes(normalized)) return 'failed'
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(normalized)) return 'interrupted'
  return 'unknown'
}

function externalCategory(title: string): ExternalCallCategory | null {
  const normalized = title.toLowerCase()
  if (/\b(browser|chrome|safari|playwright)\b/.test(normalized)) return 'browser'
  if (/\b(mcp|model context protocol)\b/.test(normalized)) return 'mcp'
  if (/\b(github|gitlab|bitbucket|pull request|issue)\b/.test(normalized)) return 'vcs'
  if (/\b(aws|amazon web services|gcp|google cloud|azure|vercel|netlify|slack|notion)\b/.test(normalized)) return 'cloud'
  if (/\b(curl|wget|http|https|url|fetch|request|web search|search query|api)\b/.test(normalized)) return 'network'
  return null
}

function signalId(kind: string, sessionId: string, title: string): string {
  return `${kind}:${crypto.createHash('sha256').update(`${sessionId}\0${title.toLowerCase()}`).digest('base64url').slice(0, 20)}`
}

function signalFeeds(live: LiveSnapshot, control: ControlSnapshot): SignalFeed[] {
  return [
    ...live.agents.map((agent) => ({ sessionId: agent.id, items: agent.feed })),
    ...control.sessions.map((session) => ({ sessionId: session.id, items: session.feed })),
  ]
}

export function projectRuntimeSignals(live: LiveSnapshot, control: ControlSnapshot): ProjectedSignals {
  const tools = new Map<string, {
    sessionId: string
    title: string
    status: string
    startedAt: string
    updatedAt: string
  }>()
  for (const feed of signalFeeds(live, control)) {
    for (const item of feed.items) {
      if (item.type !== 'tool') continue
      const title = safeTitle(item.title)
      if (!title) continue
      const key = `${feed.sessionId}\0${title.toLowerCase()}`
      const existing = tools.get(key)
      const timestamp = item.timestamp || new Date(0).toISOString()
      if (!existing) {
        tools.set(key, {
          sessionId: feed.sessionId,
          title,
          status: item.status,
          startedAt: timestamp,
          updatedAt: timestamp,
        })
      } else {
        if (timestamp < existing.startedAt) existing.startedAt = timestamp
        if (timestamp >= existing.updatedAt) {
          existing.updatedAt = timestamp
          existing.status = item.status || existing.status
          existing.title = title
        }
      }
    }
  }

  const tests: RuntimeTestRun[] = []
  const externalCalls: ExternalToolCall[] = []
  tools.forEach((tool) => {
    if (isTestTitle(tool.title)) {
      const status = testStatus(tool.status)
      tests.push({
        id: signalId('test', tool.sessionId, tool.title),
        sessionId: tool.sessionId,
        title: tool.title,
        framework: testFramework(tool.title),
        status,
        startedAt: tool.startedAt,
        updatedAt: tool.updatedAt,
        incomplete: status === 'unknown' || status === 'interrupted',
      })
    }
    const category = externalCategory(tool.title)
    if (category) {
      externalCalls.push({
        id: signalId('external', tool.sessionId, tool.title),
        sessionId: tool.sessionId,
        title: tool.title,
        category,
        status: tool.status || 'unknown',
        updatedAt: tool.updatedAt,
      })
    }
  })
  return {
    tests: tests.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, MAX_SIGNALS),
    externalCalls: externalCalls
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_SIGNALS),
  }
}

function emptySnapshot(): RuntimeSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    available: true,
    partial: false,
    error: '',
    roots: [],
    processes: [],
    ports: [],
    services: [],
    tests: [],
    externalCalls: [],
  }
}

export class RuntimeInspector extends EventEmitter {
  private current = emptySnapshot()
  private live: LiveSnapshot = {
    generatedAt: new Date().toISOString(),
    connected: false,
    activeCount: 0,
    workingCount: 0,
    attentionCount: 0,
    agents: [],
  }
  private control: ControlSnapshot = {
    generatedAt: new Date().toISOString(),
    connected: false,
    processId: 0,
    starting: false,
    reconnecting: false,
    reconnectAttempt: 0,
    lastDisconnectedAt: '',
    agentName: '',
    agentVersion: '',
    error: '',
    sessions: [],
    workflows: [],
    permissions: [],
  }
  private refreshTimer: NodeJS.Timeout | null = null
  private interval: NodeJS.Timeout | null = null
  private refreshPromise: Promise<void> | null = null
  private retainedTests = new Map<string, RuntimeTestRun>()
  private retainedCalls = new Map<string, ExternalToolCall>()

  constructor(
    private readonly runner: RuntimeCommandRunner = new SystemCommandRunner(),
    private readonly platform = process.platform,
    private readonly intervalMs = 2_000,
    private readonly now: () => Date = () => new Date(),
  ) {
    super()
  }

  snapshot(): RuntimeSnapshot {
    return this.current
  }

  update(live: LiveSnapshot, control: ControlSnapshot): void {
    this.live = live
    this.control = control
    this.scheduleRefresh()
  }

  async start(): Promise<void> {
    await this.refresh()
    this.interval = setInterval(() => void this.refresh(), this.intervalMs)
    this.interval.unref()
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.interval) clearInterval(this.interval)
    this.refreshTimer = null
    this.interval = null
    await this.refreshPromise
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.refreshInternal().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, 100)
    this.refreshTimer.unref()
  }

  private roots(): RuntimeRoot[] {
    const roots: RuntimeRoot[] = this.live.agents.map((agent) => ({
      pid: agent.pid,
      managed: false,
      sessionIds: [agent.id],
      workspaces: [agent.cwd],
    }))
    if (this.control.processId) {
      roots.push({
        pid: this.control.processId,
        managed: true,
        sessionIds: this.control.sessions.map((session) => session.id),
        workspaces: this.control.sessions.map((session) => session.cwd),
      })
    }
    return mergeRoots(roots)
  }

  private retainSignals(signals: ProjectedSignals, now: string): ProjectedSignals {
    signals.tests.forEach((test) => this.retainedTests.set(test.id, test))
    signals.externalCalls.forEach((call) => this.retainedCalls.set(call.id, call))
    const cutoff = new Date(new Date(now).getTime() - RETAIN_SIGNAL_MS).toISOString()
    this.retainedTests.forEach((test, id) => {
      if (test.updatedAt < cutoff) this.retainedTests.delete(id)
      else if (!signals.tests.some((candidate) => candidate.id === id) && test.status === 'running') {
        this.retainedTests.set(id, {
          ...test,
          status: 'interrupted',
          updatedAt: now,
          incomplete: true,
        })
      }
    })
    this.retainedCalls.forEach((call, id) => {
      if (call.updatedAt < cutoff) this.retainedCalls.delete(id)
    })
    return {
      tests: [...this.retainedTests.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_SIGNALS),
      externalCalls: [...this.retainedCalls.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_SIGNALS),
    }
  }

  private async refreshInternal(): Promise<void> {
    const generatedAt = this.now().toISOString()
    const roots = this.roots()
    const signals = this.retainSignals(projectRuntimeSignals(this.live, this.control), generatedAt)
    if (this.platform === 'win32') {
      this.current = {
        ...emptySnapshot(),
        generatedAt,
        available: false,
        partial: true,
        error: 'Process and port inspection is not available on this platform.',
        roots,
        ...signals,
      }
      this.emit('runtime', this.current)
      return
    }

    let processes: RuntimeProcess[] = []
    let ports: RuntimePort[] = []
    let partial = false
    let error = ''
    try {
      const output = await this.runner.run(
        'ps',
        ['-axo', 'pid=,ppid=,state=,etime=,comm='],
        COMMAND_TIMEOUT_MS,
      )
      processes = selectProcessTree(parseProcessTable(output), roots)
    } catch {
      partial = true
      error = 'Process inspection is temporarily unavailable.'
    }

    if (processes.length) {
      const allowedPids = new Set(processes.map((process) => process.pid))
      const pidList = [...allowedPids].join(',')
      try {
        const output = await this.runner.run(
          'lsof',
          ['-nP', '-a', '-p', pidList, '-iTCP', '-sTCP:LISTEN', '-FpcPnT'],
          COMMAND_TIMEOUT_MS,
        )
        ports = parseLsofPorts(output, allowedPids)
      } catch {
        if (this.platform === 'linux') {
          try {
            const output = await this.runner.run('ss', ['-ltnpH'], COMMAND_TIMEOUT_MS)
            ports = parseSsPorts(output, allowedPids)
          } catch {
            partial = true
            error ||= 'Listening-port inspection is temporarily unavailable.'
          }
        } else {
          partial = true
          error ||= 'Listening-port inspection is temporarily unavailable.'
        }
      }
    }

    const portsByPid = new Map<number, number[]>()
    ports.forEach((port) => {
      const values = portsByPid.get(port.pid) || []
      values.push(port.port)
      portsByPid.set(port.pid, values)
    })
    processes = processes.map((process) => ({
      ...process,
      ports: [...new Set(portsByPid.get(process.pid) || [])].sort((left, right) => left - right),
    }))
    this.current = {
      generatedAt,
      available: !error || processes.length > 0,
      partial,
      error,
      roots,
      processes,
      ports,
      services: classifyServices(processes, ports),
      ...signals,
    }
    this.emit('runtime', this.current)
  }
}
