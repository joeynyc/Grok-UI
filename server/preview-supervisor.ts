import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

export type PreviewStatus = 'idle' | 'starting' | 'running' | 'failed' | 'stopped'

export const PREVIEW_BIND_HOST = '127.0.0.1'
export const PREVIEW_PUBLIC_HOST = 'preview.localhost'

export interface PreviewSnapshot {
  sessionId: string
  cwd: string
  available: boolean
  status: PreviewStatus
  command: string
  args: string[]
  displayCommand: string
  port: number
  url: string
  startedAt: string
  updatedAt: string
  error: string
  logs: string[]
}

interface PreviewRecipe {
  command: string
  args: (port: number) => string[]
  displayCommand: string
}

interface PreviewEntry {
  snapshot: PreviewSnapshot
  process: ChildProcessWithoutNullStreams | null
  proxy: http.Server | null
  stopping: boolean
}

const MAX_PACKAGE_BYTES = 256 * 1024
const MAX_LOG_LINES = 200
const MAX_LOG_LINE_LENGTH = 2_000
const SENSITIVE_ENV_KEY = /(?:^|_)(?:GROK|XAI)(?:_|$)|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i
const STRIPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
])

function now(): string {
  return new Date().toISOString()
}

function cleanLogLine(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, MAX_LOG_LINE_LENGTH)
}

function previewEnvironment(port: number): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !SENSITIVE_ENV_KEY.test(key)),
  )

  return {
    ...inherited,
    BROWSER: 'none',
    HOST: PREVIEW_BIND_HOST,
    NO_COLOR: '1',
    PORT: String(port),
  }
}

function packageManager(files: Set<string>): string {
  if (files.has('pnpm-lock.yaml')) return 'pnpm'
  if (files.has('yarn.lock')) return 'yarn'
  if (files.has('bun.lock') || files.has('bun.lockb')) return 'bun'
  return 'npm'
}

function runArgs(manager: string, script: string, extra: string[]): string[] {
  if (manager === 'yarn') return [script, ...extra]
  return ['run', script, ...extra]
}

function previewUrl(port: number): string {
  return `http://${PREVIEW_PUBLIC_HOST}:${port}`
}

function forwardedHeaders(headers: http.IncomingHttpHeaders, targetPort: number): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || STRIPPED_HEADERS.has(key.toLowerCase())) continue
    forwarded[key] = value
  }
  forwarded.host = `${PREVIEW_BIND_HOST}:${targetPort}`
  return forwarded
}

async function previewRecipe(cwd: string): Promise<PreviewRecipe | null> {
  const packagePath = path.join(cwd, 'package.json')
  let stat
  try {
    stat = await fs.stat(packagePath)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) return null

  let manifest: {
    scripts?: Record<string, unknown>
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  try {
    manifest = JSON.parse(await fs.readFile(packagePath, 'utf8'))
  } catch {
    return null
  }

  const scripts = manifest.scripts || {}
  const script = typeof scripts.dev === 'string'
    ? 'dev'
    : typeof scripts.start === 'string'
      ? 'start'
      : ''
  if (!script) return null

  const files = new Set(await fs.readdir(cwd).catch(() => []))
  const manager = packageManager(files)
  const dependencies = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
  }
  const has = (name: string) => Object.hasOwn(dependencies, name)

  if (has('vite') || has('astro') || has('@sveltejs/kit')) {
    return {
      command: manager,
      args: (port) => runArgs(manager, script, ['--', '--host', PREVIEW_BIND_HOST, '--port', String(port)]),
      displayCommand: `${manager} ${runArgs(manager, script, ['--', '--host', PREVIEW_BIND_HOST, '--port', '<port>']).join(' ')}`,
    }
  }

  if (has('next')) {
    return {
      command: manager,
      args: (port) => runArgs(manager, script, ['--', '--hostname', PREVIEW_BIND_HOST, '--port', String(port)]),
      displayCommand: `${manager} ${runArgs(manager, script, ['--', '--hostname', PREVIEW_BIND_HOST, '--port', '<port>']).join(' ')}`,
    }
  }

  return {
    command: manager,
    args: () => runArgs(manager, script, []),
    displayCommand: `${manager} ${runArgs(manager, script, []).join(' ')} (best-effort HOST=${PREVIEW_BIND_HOST}, PORT=<port>)`,
  }
}

async function openPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, PREVIEW_BIND_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function listenProxy(targetPort: number): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      host: PREVIEW_BIND_HOST,
      port: targetPort,
      path: request.url,
      method: request.method,
      headers: forwardedHeaders(request.headers, targetPort),
    }, (incoming) => {
      response.writeHead(incoming.statusCode || 502, incoming.headers)
      incoming.pipe(response)
    })
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end('Preview upstream unavailable')
    })
    request.pipe(upstream)
  })

  server.on('upgrade', (request, socket, head) => {
    const headers = {
      ...forwardedHeaders(request.headers, targetPort),
      connection: 'Upgrade',
      upgrade: request.headers.upgrade || 'websocket',
    }
    const upstream = net.connect(targetPort, PREVIEW_BIND_HOST, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`))
        else if (value !== undefined) lines.push(`${key}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, PREVIEW_BIND_HOST, () => resolve(server))
  })
}

function proxyPort(server: http.Server): number {
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class PreviewSupervisor {
  private readonly entries = new Map<string, PreviewEntry>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly startupTimeoutMs = 25_000,
    private readonly pollIntervalMs = 200,
    private readonly terminateGraceMs = 1_500,
  ) {}

  async inspect(sessionId: string, cwd: string): Promise<PreviewSnapshot> {
    const existing = this.entries.get(sessionId)
    if (existing && path.resolve(existing.snapshot.cwd) === path.resolve(cwd)) {
      return this.copy(existing.snapshot)
    }
    const recipe = await previewRecipe(cwd)
    const timestamp = now()
    return {
      sessionId,
      cwd,
      available: Boolean(recipe),
      status: 'idle',
      command: recipe?.command || '',
      args: [],
      displayCommand: recipe?.displayCommand || '',
      port: 0,
      url: '',
      startedAt: '',
      updatedAt: timestamp,
      error: recipe ? '' : 'No supported package.json dev or start script was found.',
      logs: [],
    }
  }

  async start(sessionId: string, cwd: string): Promise<PreviewSnapshot> {
    return this.serialize(sessionId, () => this.startLocked(sessionId, cwd))
  }

  async stop(sessionId: string): Promise<PreviewSnapshot> {
    return this.serialize(sessionId, () => this.stopLocked(sessionId))
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(async (sessionId) => {
      const entry = this.entries.get(sessionId)
      if (!entry?.process && !entry?.proxy) return
      await this.stop(sessionId).catch(() => undefined)
    }))
  }

  private async startLocked(sessionId: string, cwd: string): Promise<PreviewSnapshot> {
    const existing = this.entries.get(sessionId)
    if (existing && ['starting', 'running'].includes(existing.snapshot.status)) {
      return this.copy(existing.snapshot)
    }
    if (existing) await this.terminate(existing)

    const recipe = await previewRecipe(cwd)
    if (!recipe) throw new Error('No supported package.json dev or start script was found.')

    const port = await openPort()
    const proxy = await listenProxy(port)
    const publicPort = proxyPort(proxy)
    const args = recipe.args(port)
    const timestamp = now()
    const snapshot: PreviewSnapshot = {
      sessionId,
      cwd,
      available: true,
      status: 'starting',
      command: recipe.command,
      args,
      displayCommand: `${recipe.command} ${args.join(' ')}`,
      port: publicPort,
      url: previewUrl(publicPort),
      startedAt: timestamp,
      updatedAt: timestamp,
      error: '',
      logs: [],
    }
    const child = spawn(recipe.command, args, {
      cwd,
      env: previewEnvironment(port),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const entry: PreviewEntry = { snapshot, process: child, proxy, stopping: false }
    this.entries.set(sessionId, entry)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.appendLogs(entry, chunk))
    child.stderr.on('data', (chunk: string) => this.appendLogs(entry, chunk))
    child.once('error', (error) => {
      if (this.entries.get(sessionId) !== entry) return
      entry.snapshot = {
        ...entry.snapshot,
        status: 'failed',
        updatedAt: now(),
        error: error.message,
      }
      void this.closeProxy(entry)
      entry.process = null
    })
    child.once('exit', (code, signal) => {
      if (this.entries.get(sessionId) !== entry) return
      const stopped = entry.stopping
      const existingFailure = entry.snapshot.status === 'failed' ? entry.snapshot.error : ''
      entry.snapshot = {
        ...entry.snapshot,
        status: stopped ? 'stopped' : 'failed',
        updatedAt: now(),
        error: stopped ? '' : existingFailure || `Preview process exited (${signal || code || 'unknown'}).`,
      }
      void this.closeProxy(entry)
      entry.process = null
    })
    void this.waitUntilReady(entry)
    return this.copy(snapshot)
  }

  private async stopLocked(sessionId: string): Promise<PreviewSnapshot> {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new Error('Preview is not running.')
    entry.stopping = true
    await this.terminate(entry)
    entry.snapshot = {
      ...entry.snapshot,
      status: 'stopped',
      updatedAt: now(),
      error: '',
    }
    return this.copy(entry.snapshot)
  }

  private async waitUntilReady(entry: PreviewEntry): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs
    while (
      Date.now() < deadline
      && entry.process
      && entry.snapshot.status === 'starting'
      && !entry.stopping
    ) {
      try {
        const response = await fetch(entry.snapshot.url, { signal: AbortSignal.timeout(800) })
        if (!response.ok) throw new Error(`Preview returned ${response.status}`)
        if (!entry.process || entry.stopping) return
        entry.snapshot = {
          ...entry.snapshot,
          status: 'running',
          updatedAt: now(),
          error: '',
        }
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      }
    }
    if (!entry.process || entry.stopping || entry.snapshot.status !== 'starting') return
    entry.snapshot = {
      ...entry.snapshot,
      status: 'failed',
      updatedAt: now(),
      error: `Preview did not respond within ${Math.round(this.startupTimeoutMs / 1_000)} seconds.`,
    }
    await this.terminate(entry)
  }

  private async terminate(entry: PreviewEntry): Promise<void> {
    await this.closeProxy(entry)
    const child = entry.process
    if (!child?.pid) {
      entry.process = null
      return
    }

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || !processAlive(child.pid!)) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
    })

    this.signal(child, 'SIGTERM')
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, this.terminateGraceMs)),
    ])
    if (entry.process?.pid && child.exitCode === null && child.signalCode === null) {
      this.signal(child, 'SIGKILL')
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, this.terminateGraceMs)),
      ])
    }
    entry.process = null
  }

  private async closeProxy(entry: PreviewEntry): Promise<void> {
    const proxy = entry.proxy
    entry.proxy = null
    if (!proxy) return
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }

  private serialize<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.locks.set(sessionId, next)
    void next.catch(() => undefined).finally(() => {
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId)
    })
    return next
  }

  private appendLogs(entry: PreviewEntry, chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map(cleanLogLine)
      .filter(Boolean)
    if (!lines.length) return
    entry.snapshot = {
      ...entry.snapshot,
      logs: [...entry.snapshot.logs, ...lines].slice(-MAX_LOG_LINES),
      updatedAt: now(),
    }
  }

  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal)
      } else {
        child.kill(signal)
      }
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }

  private copy(snapshot: PreviewSnapshot): PreviewSnapshot {
    return { ...snapshot, args: [...snapshot.args], logs: [...snapshot.logs] }
  }
}
