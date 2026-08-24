import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const REMOTE_COMMAND_STORE_VERSION = 1
export const MAX_REMOTE_COMMAND_RECORDS = 1_000
export const MAX_REMOTE_COMMAND_AUDIT_RECORDS = 1_000
export const MAX_REMOTE_COMMAND_TTL_MS = 15 * 60 * 1_000
const REMOTE_COMMAND_LOCK_WAIT_MS = 30_000
const REMOTE_COMMAND_LOCK_RETRY_MS = 20
const REMOTE_COMMAND_ORPHAN_GRACE_MS = 1_000

export type RemoteCommandOutcome = 'accepted' | 'executing' | 'completed' | 'failed' | 'unknown'

export interface RemoteCommandResult {
  outcome: Exclude<RemoteCommandOutcome, 'accepted' | 'executing'>
  result?: unknown
  error?: string
}

export interface RemoteCommandRecord {
  commandId: string
  kind: string
  target: string
  actorFingerprint: string
  payloadFingerprint: string
  acceptedAt: string
  expiresAt: string
  updatedAt: string
  outcome: RemoteCommandOutcome
  result?: unknown
  error?: string
}

export interface RemoteCommandAuditRecord {
  commandId: string
  kind: string
  target: string
  actorFingerprint: string
  timestamp: string
  outcome: RemoteCommandOutcome
}

interface PersistedState {
  version: number
  commands: RemoteCommandRecord[]
  audit: RemoteCommandAuditRecord[]
}

export interface RemoteCommandRequest {
  commandId: string
  kind: string
  target: string
  actorFingerprint: string
  expiresAt: string
  payload: unknown
}

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function now(): string { return new Date().toISOString() }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Produces a stable representation without retaining the original payload. */
function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

export function payloadFingerprint(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex')
}

function emptyState(): PersistedState { return { version: REMOTE_COMMAND_STORE_VERSION, commands: [], audit: [] } }

function trimState(state: PersistedState): void {
  const timestamp = Date.now()
  state.commands = state.commands.filter((command) => Date.parse(command.expiresAt) > timestamp)
  state.audit = state.audit.slice(-MAX_REMOTE_COMMAND_AUDIT_RECORDS)
}

function errorCode(error: unknown): string {
  return isPlainObject(error) && typeof error.code === 'string' ? error.code : ''
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class RemoteCommandStore {
  private state: PersistedState | undefined
  private loadPromise: Promise<PersistedState> | undefined
  private persistQueue: Promise<void> = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<RemoteCommandResult>>()

  constructor(private readonly stateDirectory: string) {}

  private get stateFile(): string { return path.join(this.stateDirectory, 'remote-commands.json') }
  private get lockFile(): string { return path.join(this.stateDirectory, '.remote-commands.lock') }

  private load(): Promise<PersistedState> {
    if (this.state) return Promise.resolve(this.state)
    if (!this.loadPromise) this.loadPromise = this.loadState()
    return this.loadPromise
  }

  private async loadState(): Promise<PersistedState> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.stateFile, 'utf8'))
      if (!isPlainObject(raw) || raw.version !== REMOTE_COMMAND_STORE_VERSION || !Array.isArray(raw.commands) || !Array.isArray(raw.audit)) {
        throw new Error('Invalid remote command state')
      }
      this.state = { version: REMOTE_COMMAND_STORE_VERSION, commands: raw.commands as RemoteCommandRecord[], audit: raw.audit as RemoteCommandAuditRecord[] }
      // An operation may have run before a restart. It must never be replayed.
      let changed = false
      for (const command of this.state.commands) {
        if (command.outcome === 'accepted' || command.outcome === 'executing') {
          command.outcome = 'unknown'
          command.updatedAt = now()
          this.audit(command, 'unknown')
          changed = true
        }
      }
      const commandCount = this.state.commands.length
      const auditCount = this.state.audit.length
      trimState(this.state)
      changed ||= commandCount !== this.state.commands.length || auditCount !== this.state.audit.length
      if (changed) await this.persist()
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error
      this.state = emptyState()
    }
    return this.state
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(this.stateDirectory, 0o700)
    const token = randomUUID()
    const deadline = Date.now() + REMOTE_COMMAND_LOCK_WAIT_MS
    while (true) {
      try {
        const handle = await fs.open(this.lockFile, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({
            token,
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }))
          await handle.sync()
        } finally {
          await handle.close()
        }
        return async () => {
          try {
            const owner = JSON.parse(await fs.readFile(this.lockFile, 'utf8')) as {
              token?: unknown
            }
            if (owner.token === token) await fs.unlink(this.lockFile)
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error
          }
        }
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }

      let removeOrphan = false
      try {
        const [raw, stat] = await Promise.all([
          fs.readFile(this.lockFile, 'utf8'),
          fs.stat(this.lockFile),
        ])
        const owner = JSON.parse(raw) as { pid?: unknown }
        const pid = typeof owner.pid === 'number' ? owner.pid : 0
        removeOrphan = pid > 0
          ? !processIsAlive(pid)
          : Date.now() - stat.mtimeMs >= REMOTE_COMMAND_ORPHAN_GRACE_MS
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        try {
          const stat = await fs.stat(this.lockFile)
          removeOrphan = Date.now() - stat.mtimeMs >= REMOTE_COMMAND_ORPHAN_GRACE_MS
        } catch (statError) {
          if (errorCode(statError) === 'ENOENT') continue
          throw statError
        }
      }
      if (removeOrphan) {
        try {
          await fs.unlink(this.lockFile)
          continue
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue
          throw error
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('Remote command store is busy; retry without changing the command ID.')
      }
      await delay(REMOTE_COMMAND_LOCK_RETRY_MS)
    }
  }

  private audit(command: RemoteCommandRecord, outcome: RemoteCommandOutcome): void {
    this.state!.audit.push({ commandId: command.commandId, kind: command.kind, target: command.target, actorFingerprint: command.actorFingerprint, timestamp: now(), outcome })
  }

  private async persist(): Promise<void> {
    const write = async () => {
      const state = this.state!
      trimState(state)
      await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
      await fs.chmod(this.stateDirectory, 0o700)
      const temporary = path.join(this.stateDirectory, `.remote-commands.${process.pid}.${randomUUID()}.tmp`)
      await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await fs.chmod(temporary, 0o600)
      await fs.rename(temporary, this.stateFile)
      await fs.chmod(this.stateFile, 0o600)
    }
    const queued = this.persistQueue.then(write, write)
    this.persistQueue = queued.catch(() => {})
    await queued
  }

  async execute(request: RemoteCommandRequest, operation: () => Promise<unknown>): Promise<RemoteCommandResult> {
    const release = await this.acquireLock()
    try {
      // Another process may have completed a command since this instance last
      // loaded the store. Always reconcile from the durable file under the lock.
      this.state = undefined
      this.loadPromise = undefined
      return await this.executeLocked(request, operation)
    } finally {
      await release()
    }
  }

  private async executeLocked(
    request: RemoteCommandRequest,
    operation: () => Promise<unknown>,
  ): Promise<RemoteCommandResult> {
    if (!COMMAND_ID.test(request.commandId)) throw new Error('Invalid commandId')
    const state = await this.load()
    const fingerprint = payloadFingerprint(request.payload)
    const existing = state.commands.find((command) => command.commandId === request.commandId)
    if (existing) {
      if (
        existing.payloadFingerprint !== fingerprint
        || existing.kind !== request.kind
        || existing.target !== request.target
        || existing.actorFingerprint !== request.actorFingerprint
        || existing.expiresAt !== request.expiresAt
      ) {
        throw new Error('commandId was previously used for a different command')
      }
      if (existing.outcome === 'completed') return { outcome: 'completed', result: existing.result }
      if (existing.outcome === 'failed') return { outcome: 'failed', error: existing.error }
      if (existing.outcome === 'unknown') return { outcome: 'unknown' }
      return this.inFlight.get(request.commandId) ?? { outcome: 'unknown' }
    }

    const expiration = Date.parse(request.expiresAt)
    const timestampMs = Date.now()
    if (!Number.isFinite(expiration) || expiration <= timestampMs) {
      throw new Error('Remote command has expired.')
    }
    if (expiration > timestampMs + MAX_REMOTE_COMMAND_TTL_MS) {
      throw new Error('Remote command expiry exceeds the allowed delivery window.')
    }
    trimState(state)
    if (state.commands.length >= MAX_REMOTE_COMMAND_RECORDS) {
      throw new Error('Remote command capacity is temporarily exhausted.')
    }
    const timestamp = now()
    const command: RemoteCommandRecord = { commandId: request.commandId, kind: request.kind, target: request.target, actorFingerprint: request.actorFingerprint, payloadFingerprint: fingerprint, acceptedAt: timestamp, expiresAt: request.expiresAt, updatedAt: timestamp, outcome: 'accepted' }
    state.commands.push(command)
    this.audit(command, 'accepted')
    // Start and register this promise before its first await. A concurrent retry can
    // therefore join the in-flight command while acceptance is being persisted.
    const execution = this.persist().then(() => this.run(command, operation))
    this.inFlight.set(request.commandId, execution)
    try { return await execution } finally { this.inFlight.delete(request.commandId) }
  }

  private async run(command: RemoteCommandRecord, operation: () => Promise<unknown>): Promise<RemoteCommandResult> {
    command.outcome = 'executing'
    command.updatedAt = now()
    this.audit(command, 'executing')
    await this.persist()
    try {
      command.result = await operation()
      command.outcome = 'completed'
      command.updatedAt = now()
      this.audit(command, 'completed')
      await this.persist()
      return { outcome: 'completed', result: command.result }
    } catch {
      // Provider and ACP errors can contain prompts, paths, or tool context.
      // Persist and return only a stable public failure description.
      command.error = 'Remote command failed on the host.'
      command.outcome = 'failed'
      command.updatedAt = now()
      this.audit(command, 'failed')
      await this.persist()
      return { outcome: 'failed', error: command.error }
    }
  }
}
