import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  FleetHostConfig,
  FleetHostPublicConfig,
  FleetTransportKind,
} from './types.js'

export const MAX_FLEET_HOSTS = 32
const REGISTRY_VERSION = 1
const SSH_TARGET = /^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9._-]+$/

interface PersistedFleetRegistry {
  version: 1
  hosts: FleetHostConfig[]
}

export interface FleetHostInput {
  label?: unknown
  transport?: unknown
  baseUrl?: unknown
  token?: unknown
  controlToken?: unknown
  controlEnabled?: unknown
  sshTarget?: unknown
  sshPort?: unknown
  localPort?: unknown
  remotePort?: unknown
  enabled?: unknown
}

function cleanText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, limit) : ''
}

function port(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback
}

function transport(value: unknown): FleetTransportKind {
  if (value === 'direct' || value === 'tailscale' || value === 'ssh') return value
  throw new Error('Transport must be direct, tailscale, or ssh.')
}

function directUrl(input: unknown): string {
  const value = cleanText(input, 2_048)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Direct agent URL is invalid.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Direct agent URL must use http or https.')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Agent URL must contain only scheme, host, and port.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('Direct transport is limited to loopback addresses.')
  }
  return url.origin
}

function tailscaleIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  return parts.length === 4
    && parts.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && parts[0] === 100
    && parts[1] >= 64
    && parts[1] <= 127
}

function tailscaleUrl(input: unknown): string {
  const value = cleanText(input, 2_048)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Tailscale agent URL is invalid.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Tailscale agent URL must use http or https.')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Agent URL must contain only scheme, host, and port.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    !hostname.endsWith('.ts.net')
    && !tailscaleIpv4(hostname)
    && !hostname.startsWith('fd7a:115c:a1e0:')
  ) {
    throw new Error('Tailscale transport requires a .ts.net name or Tailscale IP address.')
  }
  return url.origin
}

function normalizedHost(
  input: FleetHostInput,
  previous?: FleetHostConfig,
  now = new Date().toISOString(),
): FleetHostConfig {
  const kind = input.transport === undefined && previous ? previous.transport : transport(input.transport)
  const label = input.label === undefined && previous
    ? previous.label
    : cleanText(input.label, 160)
  if (!label) throw new Error('Host label is required.')
  const token = input.token === undefined && previous
    ? previous.token
    : cleanText(input.token, 4_096)
  if (!token) throw new Error('A dedicated host-agent token is required.')
  const controlToken = input.controlToken === undefined && previous
    ? previous.controlToken
    : cleanText(input.controlToken, 4_096)
  const controlEnabled = input.controlEnabled === undefined
    ? previous?.controlEnabled === true
    : input.controlEnabled === true
  if (controlEnabled && !controlToken) {
    throw new Error('A separate remote-control token is required when remote sessions are enabled.')
  }
  if (controlEnabled && controlToken === token) {
    throw new Error('Remote control must use a token separate from the read-only agent token.')
  }

  let baseUrl = ''
  let sshTarget = ''
  let sshPort = 22
  let localPort = 0
  let remotePort = 4311
  if (kind === 'direct') {
    baseUrl = directUrl(input.baseUrl === undefined && previous ? previous.baseUrl : input.baseUrl)
  } else if (kind === 'tailscale') {
    baseUrl = tailscaleUrl(input.baseUrl === undefined && previous ? previous.baseUrl : input.baseUrl)
  } else {
    sshTarget = input.sshTarget === undefined && previous
      ? previous.sshTarget
      : cleanText(input.sshTarget, 255)
    if (!SSH_TARGET.test(sshTarget)) throw new Error('SSH target is invalid.')
    sshPort = port(input.sshPort === undefined && previous ? previous.sshPort : input.sshPort, 22)
    localPort = port(input.localPort === undefined && previous ? previous.localPort : input.localPort, 0)
    remotePort = port(input.remotePort === undefined && previous ? previous.remotePort : input.remotePort, 4311)
    if (!localPort) throw new Error('SSH transport requires a fixed loopback local port.')
  }
  return {
    id: previous?.id || crypto.randomUUID(),
    label,
    transport: kind,
    baseUrl,
    token,
    controlToken,
    controlEnabled,
    sshTarget,
    sshPort,
    localPort,
    remotePort,
    enabled: input.enabled === undefined ? previous?.enabled !== false : input.enabled !== false,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  }
}

function normalizePersistedHost(value: unknown): FleetHostConfig | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<FleetHostConfig>
  const id = cleanText(item.id, 128)
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return null
  try {
    const normalized = normalizedHost({
      label: item.label,
      transport: item.transport,
      baseUrl: item.baseUrl,
      token: item.token,
      controlToken: item.controlToken,
      controlEnabled: item.controlEnabled,
      sshTarget: item.sshTarget,
      sshPort: item.sshPort,
      localPort: item.localPort,
      remotePort: item.remotePort,
      enabled: item.enabled,
    }, undefined, typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString())
    return {
      ...normalized,
      id,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : normalized.createdAt,
    }
  } catch {
    return null
  }
}

export function publicHostConfig(host: FleetHostConfig): FleetHostPublicConfig {
  const { token: _token, controlToken: _controlToken, ...safe } = host
  return {
    ...safe,
    hasToken: Boolean(host.token),
    hasControlToken: Boolean(host.controlToken),
  }
}

function sortedHosts(hosts: Map<string, FleetHostConfig>): FleetHostConfig[] {
  return [...hosts.values()]
    .map((host) => ({ ...host }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
}

function assertUniqueSshPorts(hosts: Map<string, FleetHostConfig>): void {
  const ports = new Set<number>()
  hosts.forEach((host) => {
    if (!host.enabled || host.transport !== 'ssh') return
    if (ports.has(host.localPort)) {
      throw new Error(`Enabled SSH hosts must use unique local tunnel ports; ${host.localPort} is already registered.`)
    }
    ports.add(host.localPort)
  })
}

export class FleetRegistryStore {
  readonly directory: string
  readonly file: string
  private hosts = new Map<string, FleetHostConfig>()
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()
  private lastWriteError: unknown = null
  private loadError = ''

  constructor(directory = process.env.GROK_UI_STATE_DIR || path.join(os.homedir(), '.grok-ui')) {
    this.directory = path.resolve(directory)
    this.file = path.join(this.directory, 'fleet.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PersistedFleetRegistry>
      if (parsed.version !== REGISTRY_VERSION) throw new Error('Unsupported fleet registry version.')
      const normalized = Array.isArray(parsed.hosts)
        ? parsed.hosts.map(normalizePersistedHost)
        : []
      if (normalized.some((host) => host === null)) throw new Error('Fleet registry contains an invalid host.')
      const hosts = normalized.filter((host): host is FleetHostConfig => host !== null)
      const candidate = new Map(hosts.slice(0, MAX_FLEET_HOSTS).map((host) => [host.id, host]))
      assertUniqueSshPorts(candidate)
      this.hosts = candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.hosts = new Map()
      if (code !== 'ENOENT') {
        this.loadError = 'Fleet registry could not be loaded; the existing file was preserved.'
      }
    }
    this.loaded = true
  }

  get error(): string {
    return this.loadError
  }

  list(): FleetHostConfig[] {
    return sortedHosts(this.hosts)
  }

  get(id: string): FleetHostConfig | null {
    const host = this.hosts.get(id)
    return host ? { ...host } : null
  }

  async create(input: FleetHostInput): Promise<FleetHostConfig> {
    return this.mutate((hosts) => {
      if (hosts.size >= MAX_FLEET_HOSTS) {
        throw new Error(`Fleet registry is limited to ${MAX_FLEET_HOSTS} hosts.`)
      }
      const host = normalizedHost(input)
      hosts.set(host.id, host)
      return { ...host }
    })
  }

  async update(id: string, input: FleetHostInput): Promise<FleetHostConfig> {
    return this.mutate((hosts) => {
      const existing = hosts.get(id)
      if (!existing) throw new Error('Fleet host was not found.')
      const host = normalizedHost(input, existing)
      hosts.set(id, host)
      return { ...host }
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((hosts) => hosts.delete(id))
  }

  async flush(): Promise<void> {
    await this.writeQueue
    if (this.lastWriteError) throw this.lastWriteError
  }

  private async mutate<T>(
    change: (hosts: Map<string, FleetHostConfig>) => T,
  ): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      this.assertWritable()
      const next = new Map(this.hosts)
      const result = change(next)
      assertUniqueSshPorts(next)
      await this.persist(next)
      this.hosts = next
      return result
    })
    this.writeQueue = operation.then(
      () => {
        this.lastWriteError = null
      },
      (error) => {
        this.lastWriteError = error
      },
    )
    return operation
  }

  private async persist(hosts: Map<string, FleetHostConfig>): Promise<void> {
    const state: PersistedFleetRegistry = {
      version: REGISTRY_VERSION,
      hosts: sortedHosts(hosts),
    }
    const snapshot = JSON.stringify(state, null, 2)
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await fs.chmod(this.directory, 0o700)
    const temporary = path.join(this.directory, `.fleet.${process.pid}.${Date.now()}.tmp`)
    let renamed = false
    try {
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.file)
      renamed = true
    } finally {
      if (!renamed) await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  private assertWritable(): void {
    if (this.loadError) throw new Error(this.loadError)
  }
}
