import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  FLEET_PROTOCOL_VERSION,
  hostScopeSnapshot,
  normalizeAgentHello,
  normalizeAgentSessionDetail,
  normalizeAgentSnapshot,
  normalizeUsageReport,
  protocolCompatible,
  unscopedId,
} from './fleet-protocol.js'
import {
  DefaultFleetConnector,
  FleetConnectionError,
  type FleetConnector,
} from './fleet-connectors.js'
import { publicHostConfig, type FleetRegistryStore } from './fleet-registry.js'
import type {
  AgentHello,
  AgentSessionDetail,
  AgentSnapshot,
  FleetFreshness,
  FleetHostConfig,
  FleetHostStatus,
  FleetHostView,
  FleetSnapshot,
  UsageGroupDimension,
  UsagePeriod,
  UsageReport,
  UsageScope,
} from './types.js'

export const FLEET_POLL_INTERVAL_MS = 5_000
export const FLEET_STALE_AFTER_MS = 15_000
export const FLEET_OFFLINE_AFTER_MS = 45_000
export const FLEET_HIGH_LATENCY_MS = 1_500
export const FLEET_MAX_CONCURRENCY = 4
export const MAX_FLEET_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_BACKOFF_MS = 30_000

interface HostState {
  config: FleetHostConfig
  status: FleetHostStatus
  statusDetail: string
  latencyMs: number | null
  lastSeenMs: number
  lastAttemptMs: number
  consecutiveFailures: number
  hello: AgentHello | null
  snapshot: AgentSnapshot | null
  contentSignature: string
  configGeneration: number
  nextAttemptMs: number
  inFlight: Promise<void> | null
}

function iso(value: number): string {
  return value > 0 ? new Date(value).toISOString() : ''
}

function freshness(state: HostState, now: number): FleetFreshness {
  if (!state.lastSeenMs) return 'unknown'
  const age = Math.max(0, now - state.lastSeenMs)
  if (age < FLEET_POLL_INTERVAL_MS * 2) return 'fresh'
  if (age < FLEET_STALE_AFTER_MS) return 'aging'
  if (age < FLEET_OFFLINE_AFTER_MS) return 'stale'
  return 'expired'
}

function visibleStatus(state: HostState, now: number): FleetHostStatus {
  if (
    state.status === 'incompatible'
    || state.status === 'unauthorized'
    || state.status === 'unavailable'
    || state.status === 'connecting'
  ) return state.status
  const currentFreshness = freshness(state, now)
  if (currentFreshness === 'expired') return 'offline'
  if (currentFreshness === 'stale') return 'stale'
  return state.status
}

function degradedSnapshot(snapshot: AgentSnapshot, latencyMs: number): string {
  if (snapshot.health.status === 'degraded') return snapshot.health.detail || 'Host agent reported degraded health.'
  if (Object.values(snapshot.sections).some((section) => section !== 'available')) {
    return 'One or more host capabilities are partial or unavailable.'
  }
  if (Object.values(snapshot.truncated).some(Boolean)) return 'Host snapshot reached a safety cap.'
  if (latencyMs > FLEET_HIGH_LATENCY_MS) return `Host latency is ${latencyMs} ms.`
  return ''
}

function observedContentSignature(
  hello: AgentHello | null,
  snapshot: AgentSnapshot | null,
): string {
  const stableHello = hello ? { ...hello, generatedAt: '' } : null
  const stableRuntime = snapshot?.runtime
    ? { ...snapshot.runtime, generatedAt: '' }
    : snapshot?.runtime
  const stableUsage = snapshot?.usage
    ? { ...snapshot.usage, generatedAt: '', from: '', to: '' }
    : snapshot?.usage
  const stableSnapshot = snapshot
    ? {
        ...snapshot,
        generatedAt: '',
        runtime: stableRuntime,
        usage: stableUsage,
      }
    : null
  return crypto.createHash('sha256')
    .update(JSON.stringify({ hello: stableHello, snapshot: stableSnapshot }))
    .digest('base64url')
}

function initialState(config: FleetHostConfig, now: number): HostState {
  return {
    config,
    status: config.enabled ? 'connecting' : 'unavailable',
    statusDetail: config.enabled ? 'Waiting for the first host-agent sample.' : 'Host monitoring is disabled.',
    latencyMs: null,
    lastSeenMs: 0,
    lastAttemptMs: 0,
    consecutiveFailures: 0,
    hello: null,
    snapshot: null,
    contentSignature: '',
    configGeneration: 0,
    nextAttemptMs: now,
    inFlight: null,
  }
}

function compactAgentSnapshot(snapshot: AgentSnapshot, minimal: boolean): AgentSnapshot {
  const sessions = minimal
    ? []
    : snapshot.sessions.slice(0, 20).map((session) => ({ ...session, summary: '' }))
  const workflows = minimal
    ? []
    : snapshot.workflows.slice(0, 20).map((workflow) => ({
      ...workflow,
      phases: workflow.phases.slice(0, 12),
      agents: workflow.agents.slice(0, 8),
    }))
  const runtime = minimal || !snapshot.runtime ? null : {
    ...snapshot.runtime,
    roots: snapshot.runtime.roots.slice(0, 20),
    processes: snapshot.runtime.processes.slice(0, 20),
    ports: snapshot.runtime.ports.slice(0, 20),
    services: snapshot.runtime.services.slice(0, 20),
    tests: snapshot.runtime.tests.slice(0, 20),
    externalCalls: snapshot.runtime.externalCalls.slice(0, 20),
    partial: true,
  }
  const usage = snapshot.usage ? {
    ...snapshot.usage,
    entries: [],
    groups: minimal ? [] : snapshot.usage.groups.slice(0, 20),
  } : null
  return {
    ...snapshot,
    sessions,
    workflows,
    runtime,
    usage,
    health: {
      status: 'degraded',
      detail: 'The central fleet aggregate compacted this host at its browser safety cap.',
    },
    sections: {
      sessions: snapshot.sections.sessions === 'unavailable' ? 'unavailable' : 'partial',
      workflows: snapshot.sections.workflows === 'unavailable' ? 'unavailable' : 'partial',
      runtime: snapshot.sections.runtime === 'unavailable' ? 'unavailable' : 'partial',
      usage: snapshot.sections.usage === 'unavailable' ? 'unavailable' : 'partial',
    },
    truncated: {
      sessions: true,
      workflows: true,
      usageEntries: true,
    },
  }
}

export class FleetMonitor extends EventEmitter {
  private states = new Map<string, HostState>()
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private lastVisibilitySignature = ''
  private activeConnections = 0
  private connectionWaiters: Array<() => void> = []

  constructor(
    private readonly registry: FleetRegistryStore,
    private readonly connector: FleetConnector = new DefaultFleetConnector(),
    private readonly now: () => number = () => Date.now(),
    private readonly pollIntervalMs = FLEET_POLL_INTERVAL_MS,
  ) {
    super()
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.registry.load()
    this.syncRegistry()
    await this.refresh()
    this.timer = setInterval(() => void this.tick(), Math.min(1_000, this.pollIntervalMs))
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.connector.close?.()
  }

  syncRegistry(): void {
    const current = new Map(this.registry.list().map((host) => [host.id, host]))
    let changed = false
    this.states.forEach((_state, id) => {
      if (current.has(id)) return
      this.states.delete(id)
      this.connector.closeHost?.(id)
      changed = true
    })
    current.forEach((config, id) => {
      const previous = this.states.get(id)
      if (!previous) {
        this.states.set(id, initialState(config, this.now()))
        changed = true
        return
      }
      const registryChanged = previous.config.updatedAt !== config.updatedAt
        || previous.config.enabled !== config.enabled
        || previous.config.label !== config.label
      changed ||= registryChanged
      const connectionChanged = previous.config.transport !== config.transport
        || previous.config.baseUrl !== config.baseUrl
        || previous.config.token !== config.token
        || previous.config.sshTarget !== config.sshTarget
        || previous.config.sshPort !== config.sshPort
        || previous.config.localPort !== config.localPort
        || previous.config.remotePort !== config.remotePort
      const enabledChanged = previous.config.enabled !== config.enabled
      if (connectionChanged || enabledChanged) previous.configGeneration += 1
      previous.config = config
      if (connectionChanged) {
        this.connector.closeHost?.(id)
        previous.status = config.enabled ? 'connecting' : 'unavailable'
        previous.statusDetail = config.enabled
          ? 'Connection settings changed; waiting for a fresh sample.'
          : 'Host monitoring is disabled.'
        previous.nextAttemptMs = this.now()
        previous.consecutiveFailures = 0
      } else if (!config.enabled) {
        previous.status = 'unavailable'
        previous.statusDetail = 'Host monitoring is disabled.'
        this.connector.closeHost?.(id)
      } else if (previous.status === 'unavailable' && config.enabled) {
        previous.status = 'connecting'
        previous.statusDetail = 'Waiting for the first host-agent sample.'
        previous.nextAttemptMs = this.now()
      }
    })
    if (changed) this.emitSnapshot(true)
  }

  snapshot(): FleetSnapshot {
    const now = this.now()
    const hosts = [...this.states.values()]
      .map((state): FleetHostView => {
        const status = visibleStatus(state, now)
        return {
          id: state.config.id,
          label: state.config.label,
          transport: state.config.transport,
          status,
          statusDetail: status === 'stale'
            ? 'The last successful host sample is stale.'
            : status === 'offline' && state.lastSeenMs
              ? 'The host has exceeded the offline freshness threshold.'
              : state.statusDetail,
          freshness: freshness(state, now),
          latencyMs: state.latencyMs,
          lastSeen: iso(state.lastSeenMs),
          lastAttemptAt: iso(state.lastAttemptMs),
          consecutiveFailures: state.consecutiveFailures,
          host: state.hello?.host || state.snapshot?.host || null,
          grokUiVersion: state.hello?.grokUiVersion || state.snapshot?.grokUiVersion || '',
          agentVersion: state.hello?.agentVersion || state.snapshot?.agentVersion || '',
          grokVersion: state.hello?.grokVersion || state.snapshot?.grokVersion || '',
          capabilities: state.hello?.capabilities || state.snapshot?.capabilities || [],
          snapshot: state.snapshot,
          config: publicHostConfig(state.config),
        }
      })
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
    const result: FleetSnapshot = {
      generatedAt: new Date(now).toISOString(),
      protocolVersion: FLEET_PROTOCOL_VERSION,
      registryError: this.registry.error,
      pollIntervalMs: this.pollIntervalMs,
      staleAfterMs: FLEET_STALE_AFTER_MS,
      offlineAfterMs: FLEET_OFFLINE_AFTER_MS,
      hosts,
      totals: {
        hosts: hosts.length,
        healthy: hosts.filter((host) => host.status === 'healthy').length,
        degraded: hosts.filter((host) => host.status === 'degraded').length,
        stale: hosts.filter((host) => host.status === 'stale').length,
        offline: hosts.filter((host) => host.status === 'offline').length,
        sessions: hosts.reduce((sum, host) => sum + (host.snapshot?.sessions.length || 0), 0),
        workflows: hosts.reduce((sum, host) => sum + (host.snapshot?.workflows.length || 0), 0),
      },
    }
    let resultBytes = Buffer.byteLength(JSON.stringify(result))
    if (resultBytes <= MAX_FLEET_SNAPSHOT_BYTES) return result

    const candidates = hosts
      .filter((host) => host.snapshot)
      .sort((left, right) =>
        Buffer.byteLength(JSON.stringify(right.snapshot))
        - Buffer.byteLength(JSON.stringify(left.snapshot)))
    for (const host of candidates) {
      const before = Buffer.byteLength(JSON.stringify(host))
      host.snapshot = compactAgentSnapshot(host.snapshot!, false)
      host.status = 'degraded'
      host.statusDetail = 'Remote data was compacted to keep the fleet response within its safety cap.'
      resultBytes += Buffer.byteLength(JSON.stringify(host)) - before
      if (resultBytes <= MAX_FLEET_SNAPSHOT_BYTES) break
    }
    if (resultBytes > MAX_FLEET_SNAPSHOT_BYTES) {
      for (const host of candidates) {
        if (!host.snapshot) continue
        const before = Buffer.byteLength(JSON.stringify(host))
        host.snapshot = compactAgentSnapshot(host.snapshot, true)
        host.status = 'degraded'
        host.statusDetail = 'Remote data was compacted to keep the fleet response within its safety cap.'
        resultBytes += Buffer.byteLength(JSON.stringify(host)) - before
        if (resultBytes <= MAX_FLEET_SNAPSHOT_BYTES) break
      }
    }
    result.totals.healthy = hosts.filter((host) => host.status === 'healthy').length
    result.totals.degraded = hosts.filter((host) => host.status === 'degraded').length
    result.totals.sessions = hosts.reduce(
      (sum, host) => sum + (host.snapshot?.sessions.length || 0),
      0,
    )
    result.totals.workflows = hosts.reduce(
      (sum, host) => sum + (host.snapshot?.workflows.length || 0),
      0,
    )
    return result
  }

  async refresh(hostId?: string): Promise<FleetSnapshot> {
    this.syncRegistry()
    const candidates = [...this.states.values()]
      .filter((state) => state.config.enabled && (!hostId || state.config.id === hostId))
    if (hostId && !candidates.length) throw new Error('Fleet host was not found or is disabled.')
    await this.runBounded(candidates, (state) => this.poll(state, true))
    return this.snapshot()
  }

  async sessionDetail(hostId: string, sessionId: string): Promise<AgentSessionDetail> {
    const state = this.states.get(hostId)
    if (!state?.config.enabled) throw new Error('Fleet host was not found or is disabled.')
    const localId = unscopedId(hostId, sessionId)
    const value = await this.getJson(
      state.config,
      `/agent/v1/sessions/${encodeURIComponent(localId)}`,
    )
    const detail = normalizeAgentSessionDetail(value)
    detail.session.id = `${hostId}:${detail.session.id}`
    detail.hostId = hostId
    if (detail.live) detail.live.id = `${hostId}:${detail.live.id}`
    if (detail.control) detail.control.id = `${hostId}:${detail.control.id}`
    detail.workflows = detail.workflows.map((workflow) => ({
      ...workflow,
      id: `${hostId}:${workflow.id}`,
      sessionId: `${hostId}:${workflow.sessionId}`,
    }))
    return detail
  }

  async usage(
    hostId: string,
    period: UsagePeriod,
    scope: UsageScope,
    groupBy: UsageGroupDimension,
  ): Promise<UsageReport> {
    const state = this.states.get(hostId)
    if (!state?.config.enabled) throw new Error('Fleet host was not found or is disabled.')
    const query = new URLSearchParams({ period, scope, groupBy })
    const value = await this.getJson(state.config, `/agent/v1/usage?${query.toString()}`)
    const report = normalizeUsageReport(value)
    if (!report) throw new Error('Host agent did not return a usage report.')
    return {
      ...report,
      entries: report.entries.map((entry) => ({
        ...entry,
        id: `${hostId}:${entry.id}`,
        sessionId: `${hostId}:${entry.sessionId}`,
        workflowId: entry.workflowId ? `${hostId}:${entry.workflowId}` : '',
      })),
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    const due = [...this.states.values()]
      .filter((state) => state.config.enabled && !state.inFlight && state.nextAttemptMs <= now)
    if (due.length) await this.runBounded(due, (state) => this.poll(state, false))
    else this.emitSnapshot()
  }

  private async poll(state: HostState, force: boolean): Promise<void> {
    if (state.inFlight) {
      if (force) {
        const joined = state.inFlight
        const joinedGeneration = state.configGeneration
        await joined
        if (
          state.config.enabled
          && (
            state.configGeneration !== joinedGeneration
            || state.nextAttemptMs <= this.now()
          )
        ) {
          await this.poll(state, true)
        }
      }
      return
    }
    if (!force && state.nextAttemptMs > this.now()) return
    const operation = this.pollHost(state)
    state.inFlight = operation
    try {
      await operation
    } finally {
      if (state.inFlight === operation) state.inFlight = null
      this.emitSnapshot()
    }
  }

  private async pollHost(state: HostState): Promise<void> {
    const config = state.config
    const generation = state.configGeneration
    const isCurrent = () => state.configGeneration === generation && state.config.enabled
    state.lastAttemptMs = this.now()
    if (!state.lastSeenMs) {
      state.status = 'connecting'
      state.statusDetail = 'Connecting to the host agent.'
    }
    const startedAt = this.now()
    try {
      const hello = normalizeAgentHello(await this.getJson(config, '/agent/v1/hello'))
      if (!isCurrent()) return
      state.hello = hello
      state.contentSignature = observedContentSignature(hello, state.snapshot)
      if (!protocolCompatible(hello)) {
        state.status = 'incompatible'
        state.statusDetail = `Agent protocol ${hello.protocolMin}-${hello.protocolMax} is incompatible with ${FLEET_PROTOCOL_VERSION}.`
        state.consecutiveFailures = 0
        state.latencyMs = Math.max(0, this.now() - startedAt)
        state.nextAttemptMs = this.now() + this.pollIntervalMs
        return
      }
      const snapshot = normalizeAgentSnapshot(
        await this.getJson(config, '/agent/v1/snapshot'),
      )
      if (!isCurrent()) return
      if (snapshot.protocolVersion !== FLEET_PROTOCOL_VERSION) {
        state.status = 'incompatible'
        state.statusDetail = `Agent snapshot protocol ${snapshot.protocolVersion} is unsupported.`
        state.nextAttemptMs = this.now() + this.pollIntervalMs
        return
      }
      const receivedAt = this.now()
      const latency = Math.max(0, receivedAt - startedAt)
      const scoped = hostScopeSnapshot(config.id, snapshot)
      const degraded = degradedSnapshot(scoped, latency)
      state.snapshot = scoped
      state.contentSignature = observedContentSignature(hello, scoped)
      state.latencyMs = latency
      state.lastSeenMs = receivedAt
      state.consecutiveFailures = 0
      state.status = degraded ? 'degraded' : 'healthy'
      state.statusDetail = degraded
      state.nextAttemptMs = receivedAt + this.pollIntervalMs
    } catch (error) {
      if (!isCurrent()) return
      const failure = error instanceof FleetConnectionError
        ? error
        : new FleetConnectionError('malformed', 'Host agent returned an invalid protocol payload.')
      const failedAt = this.now()
      state.consecutiveFailures += 1
      state.statusDetail = failure.message
      if (failure.kind === 'unauthorized') state.status = 'unauthorized'
      else if (failure.kind === 'unavailable') state.status = 'unavailable'
      else if (failure.kind === 'malformed') state.status = state.lastSeenMs ? 'degraded' : 'unavailable'
      else if (!state.lastSeenMs) {
        state.status = state.consecutiveFailures >= 3 ? 'offline' : 'connecting'
      } else if (failedAt - state.lastSeenMs >= FLEET_OFFLINE_AFTER_MS) state.status = 'offline'
      else if (failedAt - state.lastSeenMs >= FLEET_STALE_AFTER_MS) state.status = 'stale'
      else state.status = 'degraded'
      const backoff = Math.min(
        this.pollIntervalMs * 2 ** Math.max(0, state.consecutiveFailures - 1),
        MAX_BACKOFF_MS,
      )
      state.nextAttemptMs = failedAt + backoff
    }
  }

  private async runBounded(
    states: HostState[],
    run: (state: HostState) => Promise<void>,
  ): Promise<void> {
    let index = 0
    const workers = Array.from(
      { length: Math.min(FLEET_MAX_CONCURRENCY, states.length) },
      async () => {
        while (index < states.length) {
          const state = states[index]
          index += 1
          await run(state)
        }
      },
    )
    await Promise.all(workers)
  }

  private async getJson(config: FleetHostConfig, fixedPath: string): Promise<unknown> {
    await new Promise<void>((resolve) => {
      if (this.activeConnections < FLEET_MAX_CONCURRENCY) {
        this.activeConnections += 1
        resolve()
        return
      }
      this.connectionWaiters.push(() => {
        this.activeConnections += 1
        resolve()
      })
    })
    try {
      return await this.connector.getJson(config, fixedPath)
    } finally {
      this.activeConnections -= 1
      this.connectionWaiters.shift()?.()
    }
  }

  private emitSnapshot(force = false): void {
    const now = this.now()
    const signature = [
      this.registry.error,
      ...[...this.states.values()].map((state) =>
        `${state.config.id}:${visibleStatus(state, now)}:${freshness(state, now)}:${state.contentSignature}`),
    ].join('|')
    if (!force && signature === this.lastVisibilitySignature) return
    this.lastVisibilitySignature = signature
    this.emit('fleet', this.snapshot())
  }
}
