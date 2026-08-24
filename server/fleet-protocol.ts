import type {
  AgentCapability,
  AgentHello,
  AgentHostIdentity,
  AgentSessionDetail,
  AgentSnapshot,
  ControlPermission,
  ControlSession,
  LiveAgent,
  LiveFeedItem,
  RuntimeSnapshot,
  RemoteSessionSnapshot,
  RemoteCommandReceipt,
  SessionRow,
  UsageLedgerEntry,
  UsageMetric,
  UsageReport,
  WorkflowAgent,
  WorkflowPhase,
  WorkflowRun,
} from './types.js'

export const FLEET_PROTOCOL_VERSION = 1
export const FLEET_PROTOCOL_MIN = 1
export const FLEET_PROTOCOL_MAX = 1
export const MAX_AGENT_BODY_BYTES = 2 * 1024 * 1024
export const MAX_AGENT_SESSIONS = 200
export const MAX_AGENT_WORKFLOWS = 100
export const MAX_AGENT_TRANSCRIPT_ITEMS = 200
export const MAX_AGENT_USAGE_ENTRIES = 1_000
export const MAX_AGENT_CAPABILITIES = 16

const CAPABILITIES = new Set<AgentCapability>([
  'sessions.list',
  'sessions.detail',
  'workflows.list',
  'runtime.snapshot',
  'usage.report',
  'remote.sessions',
  'remote.sessions.create',
  'remote.sessions.prompt',
  'remote.sessions.interrupt',
  'remote.permissions.resolve',
])

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : {}
}

function text(value: unknown, limit = 512): string {
  return typeof value === 'string'
    ? value.replace(/\u0000/g, '').slice(0, limit)
    : ''
}

function finite(value: unknown, fallback = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback
}

function integer(value: unknown, fallback = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  return Math.floor(finite(value, fallback, maximum))
}

function date(value: unknown): string {
  const parsed = new Date(typeof value === 'string' ? value : '')
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

function bool(value: unknown): boolean {
  return value === true
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback
}

function capabilities(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((item) =>
    typeof item === 'string' && CAPABILITIES.has(item as AgentCapability)
      ? [item as AgentCapability]
      : []))]
    .slice(0, MAX_AGENT_CAPABILITIES)
}

export function normalizeHostIdentity(value: unknown): AgentHostIdentity {
  const item = record(value)
  return {
    id: text(item.id, 128),
    label: text(item.label, 160),
    hostname: text(item.hostname, 255),
    platform: text(item.platform, 40),
    arch: text(item.arch, 40),
  }
}

export function normalizeAgentHello(value: unknown): AgentHello {
  const item = record(value)
  const protocolVersion = integer(item.protocolVersion, 0, 1_000)
  const protocolMin = integer(item.protocolMin, protocolVersion, 1_000)
  const protocolMax = integer(item.protocolMax, protocolVersion, 1_000)
  if (!protocolVersion || protocolMin > protocolMax) throw new Error('Invalid agent protocol envelope.')
  return {
    protocolVersion,
    protocolMin,
    protocolMax,
    generatedAt: date(item.generatedAt),
    host: normalizeHostIdentity(item.host),
    grokUiVersion: text(item.grokUiVersion, 80),
    agentVersion: text(item.agentVersion, 80),
    grokVersion: text(item.grokVersion, 80),
    capabilities: capabilities(item.capabilities),
  }
}

function feedItem(value: unknown): LiveFeedItem {
  const item = record(value)
  return {
    id: text(item.id, 256),
    type: oneOf(item.type, ['user', 'assistant', 'thought', 'tool', 'plan', 'system'] as const, 'system'),
    title: text(item.title, 240),
    text: text(item.text, 40_000),
    status: text(item.status, 80),
    timestamp: date(item.timestamp),
  }
}

export function normalizeSession(value: unknown): SessionRow {
  const item = record(value)
  return {
    id: text(item.id, 160),
    title: text(item.title, 240),
    summary: text(item.summary, 4_000),
    cwd: text(item.cwd, 2_048),
    workspace: text(item.workspace, 256),
    createdAt: date(item.createdAt),
    updatedAt: date(item.updatedAt),
    model: text(item.model, 256),
    agent: text(item.agent, 256),
    reasoningEffort: text(item.reasoningEffort, 80),
    sandboxProfile: text(item.sandboxProfile, 160),
    messages: integer(item.messages, 0),
    chatMessages: integer(item.chatMessages, 0),
    turns: integer(item.turns, 0),
    toolCalls: integer(item.toolCalls, 0),
    errors: integer(item.errors, 0),
    filesTouched: integer(item.filesTouched, 0),
    linesAdded: integer(item.linesAdded, 0),
    linesRemoved: integer(item.linesRemoved, 0),
    durationSeconds: finite(item.durationSeconds, 0),
    contextUsage: Math.min(finite(item.contextUsage, 0), 1),
    status: oneOf(item.status, ['live', 'recent', 'idle', 'attention'] as const, 'idle'),
    diskBytes: integer(item.diskBytes, 0),
    archived: bool(item.archived),
  }
}

function workflowPhase(value: unknown): WorkflowPhase {
  const item = record(value)
  return {
    id: text(item.id, 160),
    label: text(item.label, 240),
    status: text(item.status, 80),
  }
}

function workflowAgent(value: unknown): WorkflowAgent {
  const item = record(value)
  return {
    id: text(item.id, 160),
    label: text(item.label, 240),
    status: text(item.status, 80),
    detail: text(item.detail, 2_000),
    phase: text(item.phase, 160),
    model: text(item.model, 256),
    tokensUsed: finite(item.tokensUsed, 0),
    durationMs: finite(item.durationMs, 0),
    tokenTelemetryAvailable: bool(item.tokenTelemetryAvailable),
  }
}

export function stripRemoteWorkflow(value: unknown): WorkflowRun {
  const item = record(value)
  const phases = Array.isArray(item.phases) ? item.phases.slice(0, 100).map(workflowPhase) : []
  const agents = Array.isArray(item.agents) ? item.agents.slice(0, 1_024).map(workflowAgent) : []
  return {
    id: text(item.id, 160),
    controlHandle: '',
    displayName: text(item.displayName, 240),
    sessionId: text(item.sessionId, 160),
    objective: text(item.objective, 4_000),
    foreground: bool(item.foreground),
    status: oneOf(
      item.status,
      ['running', 'paused', 'failed', 'completed', 'cancelled', 'budget-limited', 'interrupted', 'unknown'] as const,
      'unknown',
    ),
    phases,
    currentPhase: text(item.currentPhase, 160),
    agentBudget: integer(item.agentBudget, 0),
    agentsUsed: integer(item.agentsUsed, 0),
    agentsReserved: integer(item.agentsReserved, 0),
    agentsRemaining: integer(item.agentsRemaining, 0),
    usageIncomplete: bool(item.usageIncomplete),
    activeAgents: integer(item.activeAgents, 0),
    currentAgentLabel: text(item.currentAgentLabel, 240),
    agents,
    totalTokens: finite(item.totalTokens, 0),
    tokenTelemetryAvailable: bool(item.tokenTelemetryAvailable),
    elapsedMs: finite(item.elapsedMs, 0),
    lastEvent: text(item.lastEvent, 240),
    lastEventDetail: text(item.lastEventDetail, 2_000),
    lastEventAt: date(item.lastEventAt),
    pauseMessage: text(item.pauseMessage, 2_000),
    resultSummary: text(item.resultSummary, 4_000),
    updatedAt: date(item.updatedAt),
    canPause: false,
    canResume: false,
    canStop: false,
  }
}

function usageMetric(value: unknown): UsageMetric {
  const item = record(value)
  const numeric = typeof item.value === 'number' && Number.isFinite(item.value) && item.value >= 0
    ? item.value
    : null
  return {
    value: numeric,
    source: oneOf(
      item.source,
      ['grok-reported', 'derived', 'incomplete', 'unavailable'] as const,
      numeric === null ? 'unavailable' : 'incomplete',
    ),
  }
}

function usageEntry(value: unknown): UsageLedgerEntry {
  const item = record(value)
  return {
    id: text(item.id, 200),
    kind: oneOf(item.kind, ['managed-session', 'cli-session', 'workflow-agent'] as const, 'cli-session'),
    sessionId: text(item.sessionId, 160),
    sessionTitle: text(item.sessionTitle, 240),
    workflowId: text(item.workflowId, 160),
    project: text(item.project, 256),
    cwd: text(item.cwd, 2_048),
    model: text(item.model, 256),
    agent: text(item.agent, 256),
    startedAt: date(item.startedAt),
    updatedAt: date(item.updatedAt),
    inputTokens: usageMetric(item.inputTokens),
    outputTokens: usageMetric(item.outputTokens),
    totalTokens: usageMetric(item.totalTokens),
    cost: {
      ...usageMetric(item.cost),
      currency: text(record(item.cost).currency, 16).toUpperCase(),
    },
  }
}

export function normalizeUsageReport(value: unknown): UsageReport | null {
  if (!value || typeof value !== 'object') return null
  const item = record(value)
  const entries = Array.isArray(item.entries)
    ? item.entries.slice(0, MAX_AGENT_USAGE_ENTRIES).map(usageEntry)
    : []
  const groups = Array.isArray(item.groups) ? item.groups.slice(0, 500) : []
  const normalizeGroup = (value: unknown) => {
    const group = record(value)
    const costs = Array.isArray(group.costs)
      ? group.costs.slice(0, 16).map((cost) => ({
        ...usageMetric(cost),
        currency: text(record(cost).currency, 16).toUpperCase(),
      }))
      : []
    return {
      key: text(group.key, 2_048),
      label: text(group.label, 256),
      entries: integer(group.entries, 0),
      sessions: integer(group.sessions, 0),
      inputTokens: usageMetric(group.inputTokens),
      outputTokens: usageMetric(group.outputTokens),
      totalTokens: usageMetric(group.totalTokens),
      costs,
      updatedAt: date(group.updatedAt),
    }
  }
  const coverage = record(item.coverage)
  return {
    generatedAt: date(item.generatedAt),
    period: oneOf(item.period, ['24h', '7d', '30d', '90d', 'all'] as const, '30d'),
    scope: oneOf(item.scope, ['sessions', 'workflow-agents', 'all'] as const, 'sessions'),
    from: date(item.from),
    to: date(item.to),
    groupBy: oneOf(item.groupBy, ['project', 'model', 'session', 'agent'] as const, 'project'),
    entries,
    totals: normalizeGroup(item.totals),
    groups: groups.map(normalizeGroup),
    coverage: {
      'grok-reported': integer(coverage['grok-reported'], 0),
      derived: integer(coverage.derived, 0),
      incomplete: integer(coverage.incomplete, 0),
      unavailable: integer(coverage.unavailable, 0),
    },
  }
}

function normalizeRuntime(value: unknown): RuntimeSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const item = record(value)
  const roots = Array.isArray(item.roots) ? item.roots.slice(0, 160).map((value) => {
    const root = record(value)
    return {
      pid: integer(root.pid, 0),
      managed: bool(root.managed),
      sessionIds: Array.isArray(root.sessionIds)
        ? root.sessionIds.slice(0, 80).map((id) => text(id, 160))
        : [],
      workspaces: Array.isArray(root.workspaces)
        ? root.workspaces.slice(0, 80).map((workspace) => text(workspace, 2_048))
        : [],
    }
  }) : []
  const processes = Array.isArray(item.processes) ? item.processes.slice(0, 160).map((value) => {
    const process = record(value)
    return {
      pid: integer(process.pid),
      parentPid: integer(process.parentPid),
      rootPid: integer(process.rootPid),
      depth: integer(process.depth, 0, 8),
      name: text(process.name, 80),
      state: oneOf(process.state, ['running', 'sleeping', 'stopped', 'zombie', 'unknown'] as const, 'unknown'),
      elapsed: text(process.elapsed, 24),
      sessionIds: Array.isArray(process.sessionIds)
        ? process.sessionIds.slice(0, 80).map((id) => text(id, 160))
        : [],
      workspaces: Array.isArray(process.workspaces)
        ? process.workspaces.slice(0, 80).map((workspace) => text(workspace, 2_048))
        : [],
      ports: Array.isArray(process.ports)
        ? process.ports.slice(0, 80).map((port) => integer(port, 0, 65_535)).filter(Boolean)
        : [],
    }
  }) : []
  const ports = Array.isArray(item.ports) ? item.ports.slice(0, 160).map((value) => {
    const port = record(value)
    return {
      pid: integer(port.pid),
      port: integer(port.port, 0, 65_535),
      protocol: 'tcp' as const,
      bind: oneOf(port.bind, ['loopback', 'all', 'lan', 'unknown'] as const, 'unknown'),
    }
  }) : []
  const services = Array.isArray(item.services) ? item.services.slice(0, 160).map((value) => {
    const service = record(value)
    return {
      id: text(service.id, 200),
      pid: integer(service.pid),
      name: text(service.name, 160),
      kind: oneOf(
        service.kind,
        ['database', 'cache', 'queue', 'emulator', 'dev-server', 'web', 'other'] as const,
        'other',
      ),
      port: integer(service.port, 0, 65_535),
      bind: oneOf(service.bind, ['loopback', 'all', 'lan', 'unknown'] as const, 'unknown'),
      status: oneOf(service.status, ['listening', 'running'] as const, 'running'),
    }
  }) : []
  const tests = Array.isArray(item.tests) ? item.tests.slice(0, 80).map((value) => {
    const test = record(value)
    return {
      id: text(test.id, 200),
      sessionId: text(test.sessionId, 160),
      title: text(test.title, 180),
      framework: text(test.framework, 80),
      status: oneOf(test.status, ['running', 'passed', 'failed', 'interrupted', 'unknown'] as const, 'unknown'),
      startedAt: date(test.startedAt),
      updatedAt: date(test.updatedAt),
      incomplete: bool(test.incomplete),
    }
  }) : []
  const externalCalls = Array.isArray(item.externalCalls)
    ? item.externalCalls.slice(0, 80).map((value) => {
      const call = record(value)
      return {
        id: text(call.id, 200),
        sessionId: text(call.sessionId, 160),
        title: text(call.title, 180),
        category: oneOf(call.category, ['network', 'browser', 'mcp', 'cloud', 'vcs'] as const, 'network'),
        status: text(call.status, 80),
        updatedAt: date(call.updatedAt),
      }
    })
    : []
  return {
    generatedAt: date(item.generatedAt),
    available: bool(item.available),
    partial: bool(item.partial),
    error: text(item.error, 500),
    roots,
    processes,
    ports,
    services,
    tests,
    externalCalls,
  }
}

export function normalizeAgentSnapshot(value: unknown): AgentSnapshot {
  const item = record(value)
  const protocolVersion = integer(item.protocolVersion, 0, 1_000)
  if (!protocolVersion) throw new Error('Invalid agent snapshot envelope.')
  const sessionsInput = Array.isArray(item.sessions) ? item.sessions : []
  const workflowsInput = Array.isArray(item.workflows) ? item.workflows : []
  const usageInput = normalizeUsageReport(item.usage)
  const sections = record(item.sections)
  const truncated = record(item.truncated)
  return {
    protocolVersion,
    generatedAt: date(item.generatedAt),
    host: normalizeHostIdentity(item.host),
    grokUiVersion: text(item.grokUiVersion, 80),
    agentVersion: text(item.agentVersion, 80),
    grokVersion: text(item.grokVersion, 80),
    capabilities: capabilities(item.capabilities),
    managedSessionIds: Array.isArray(item.managedSessionIds)
      ? item.managedSessionIds.slice(0, MAX_AGENT_SESSIONS)
        .map((id) => text(id, 160))
        .filter(Boolean)
      : [],
    health: {
      status: oneOf(record(item.health).status, ['healthy', 'degraded'] as const, 'degraded'),
      detail: text(record(item.health).detail, 500),
    },
    sessions: sessionsInput.slice(0, MAX_AGENT_SESSIONS).map(normalizeSession).filter((session) => session.id),
    workflows: workflowsInput.slice(0, MAX_AGENT_WORKFLOWS).map(stripRemoteWorkflow).filter((workflow) => workflow.id),
    runtime: normalizeRuntime(item.runtime),
    usage: usageInput,
    sections: {
      sessions: oneOf(sections.sessions, ['available', 'partial', 'unavailable'] as const, 'unavailable'),
      workflows: oneOf(sections.workflows, ['available', 'partial', 'unavailable'] as const, 'unavailable'),
      runtime: oneOf(sections.runtime, ['available', 'partial', 'unavailable'] as const, 'unavailable'),
      usage: oneOf(sections.usage, ['available', 'partial', 'unavailable'] as const, 'unavailable'),
    },
    truncated: {
      sessions: bool(truncated.sessions) || sessionsInput.length > MAX_AGENT_SESSIONS,
      workflows: bool(truncated.workflows) || workflowsInput.length > MAX_AGENT_WORKFLOWS,
      usageEntries: bool(truncated.usageEntries)
        || Boolean(usageInput && Array.isArray(record(item.usage).entries)
          && (record(item.usage).entries as unknown[]).length > MAX_AGENT_USAGE_ENTRIES),
    },
  }
}

function scopeId(hostId: string, value: string): string {
  return value ? `${hostId}:${value}` : ''
}

export function hostScopeSnapshot(hostId: string, snapshot: AgentSnapshot): AgentSnapshot {
  const sessions = snapshot.sessions.map((session) => ({ ...session, id: scopeId(hostId, session.id) }))
  const managedSessionIds = snapshot.managedSessionIds.map((id) => scopeId(hostId, id))
  const workflows = snapshot.workflows.map((workflow) => ({
    ...workflow,
    id: scopeId(hostId, workflow.id),
    sessionId: scopeId(hostId, workflow.sessionId),
  }))
  const runtime = snapshot.runtime ? {
    ...snapshot.runtime,
    roots: snapshot.runtime.roots.map((root) => ({
      ...root,
      sessionIds: root.sessionIds.map((id) => scopeId(hostId, id)),
    })),
    processes: snapshot.runtime.processes.map((process) => ({
      ...process,
      sessionIds: process.sessionIds.map((id) => scopeId(hostId, id)),
    })),
    tests: snapshot.runtime.tests.map((test) => ({
      ...test,
      id: scopeId(hostId, test.id),
      sessionId: scopeId(hostId, test.sessionId),
    })),
    externalCalls: snapshot.runtime.externalCalls.map((call) => ({
      ...call,
      id: scopeId(hostId, call.id),
      sessionId: scopeId(hostId, call.sessionId),
    })),
  } : null
  const usage = snapshot.usage ? {
    ...snapshot.usage,
    entries: snapshot.usage.entries.map((entry) => ({
      ...entry,
      id: scopeId(hostId, entry.id),
      sessionId: scopeId(hostId, entry.sessionId),
      workflowId: scopeId(hostId, entry.workflowId),
    })),
  } : null
  return { ...snapshot, sessions, managedSessionIds, workflows, runtime, usage }
}

export function unscopedId(hostId: string, value: string): string {
  const prefix = `${hostId}:`
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw new Error('Resource ID does not belong to the selected fleet host.')
  }
  return value.slice(prefix.length)
}

function safeControlSession(value: unknown): Omit<ControlSession, 'workflows'> | null {
  if (!value || typeof value !== 'object') return null
  const item = record(value)
  return {
    id: text(item.id, 160),
    cwd: text(item.cwd, 2_048),
    title: text(item.title, 240),
    model: text(item.model, 256),
    state: oneOf(item.state, ['starting', 'idle', 'working', 'attention', 'stopping', 'cancelled', 'failed'] as const, 'idle'),
    createdAt: date(item.createdAt),
    updatedAt: date(item.updatedAt),
    lastPrompt: '',
    stopReason: text(item.stopReason, 160),
    error: text(item.error, 500),
    cancellationStatus: oneOf(item.cancellationStatus, ['none', 'requested', 'confirmed', 'timed_out', 'failed'] as const, 'none'),
    cancelRequestedAt: item.cancelRequestedAt ? date(item.cancelRequestedAt) : '',
    cancelledAt: item.cancelledAt ? date(item.cancelledAt) : '',
    inputTokens: finite(item.inputTokens, 0),
    outputTokens: finite(item.outputTokens, 0),
    totalTokens: finite(item.totalTokens, 0),
    tokenTelemetryAvailable: bool(item.tokenTelemetryAvailable),
    costAmount: finite(item.costAmount, 0),
    costCurrency: text(item.costCurrency, 16).toUpperCase(),
    costTelemetryAvailable: bool(item.costTelemetryAvailable),
    feed: Array.isArray(item.feed)
      ? item.feed.slice(-MAX_AGENT_TRANSCRIPT_ITEMS).map(feedItem)
      : [],
  }
}

function safeLiveAgent(value: unknown): LiveAgent | null {
  if (!value || typeof value !== 'object') return null
  const item = record(value)
  return {
    id: text(item.id, 160),
    pid: integer(item.pid),
    title: text(item.title, 240),
    cwd: text(item.cwd, 2_048),
    workspace: text(item.workspace, 256),
    openedAt: date(item.openedAt),
    updatedAt: date(item.updatedAt),
    model: text(item.model, 256),
    phase: text(item.phase, 160),
    state: oneOf(item.state, ['working', 'waiting', 'idle', 'attention'] as const, 'idle'),
    turns: integer(item.turns),
    toolCalls: integer(item.toolCalls),
    contextUsage: Math.min(finite(item.contextUsage, 0), 1),
    currentTool: text(item.currentTool, 240),
    contextUsed: finite(item.contextUsed, 0),
    contextSize: finite(item.contextSize, 0),
    costAmount: finite(item.costAmount, 0),
    costCurrency: text(item.costCurrency, 16).toUpperCase(),
    costTelemetryAvailable: bool(item.costTelemetryAvailable),
    feed: Array.isArray(item.feed) ? item.feed.slice(-MAX_AGENT_TRANSCRIPT_ITEMS).map(feedItem) : [],
  }
}

export function normalizeAgentSessionDetail(value: unknown): AgentSessionDetail {
  const item = record(value)
  return {
    protocolVersion: integer(item.protocolVersion, 0, 1_000),
    generatedAt: date(item.generatedAt),
    hostId: text(item.hostId, 128),
    session: normalizeSession(item.session),
    transcript: Array.isArray(item.transcript)
      ? item.transcript.slice(-MAX_AGENT_TRANSCRIPT_ITEMS).map(feedItem)
      : [],
    live: safeLiveAgent(item.live),
    control: safeControlSession(item.control),
    workflows: Array.isArray(item.workflows)
      ? item.workflows.slice(0, MAX_AGENT_WORKFLOWS).map(stripRemoteWorkflow)
      : [],
    managed: bool(item.managed),
  }
}

function safePermission(value: unknown): ControlPermission | null {
  const item = record(value)
  const id = text(item.id, 256)
  const sessionId = text(item.sessionId, 160)
  if (!id || !sessionId) return null
  return {
    id,
    sessionId,
    title: text(item.title, 240),
    toolKind: text(item.toolKind, 80),
    toolCallId: text(item.toolCallId, 256),
    createdAt: date(item.createdAt),
    options: Array.isArray(item.options)
      ? item.options.slice(0, 20).flatMap((value) => {
        const option = record(value)
        const optionId = text(option.id, 160)
        return optionId ? [{
          id: optionId,
          name: text(option.name, 160),
          kind: text(option.kind, 80),
        }] : []
      })
      : [],
  }
}

export function normalizeRemoteSessionSnapshot(value: unknown): RemoteSessionSnapshot {
  const item = record(value)
  const detail = normalizeAgentSessionDetail(item)
  return {
    ...detail,
    revision: text(item.revision, 128),
    permissions: Array.isArray(item.permissions)
      ? item.permissions.slice(0, 50)
        .map(safePermission)
        .filter((permission): permission is ControlPermission => permission !== null)
      : [],
  }
}

export function normalizeRemoteCommandReceipt(value: unknown): RemoteCommandReceipt {
  const item = record(value)
  const commandId = text(item.commandId, 128)
  const kinds = ['session.create', 'session.prompt', 'session.interrupt', 'permission.resolve'] as const
  const statuses = ['accepted', 'completed', 'failed', 'unknown'] as const
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(commandId)
    || !kinds.includes(item.kind as typeof kinds[number])
    || !statuses.includes(item.status as typeof statuses[number])
  ) {
    throw new Error('Remote host returned an invalid command receipt.')
  }
  const sessionId = text(item.sessionId, 160)
  if (sessionId && !/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)) {
    throw new Error('Remote host returned an invalid command receipt.')
  }
  return {
    commandId,
    kind: item.kind as typeof kinds[number],
    status: item.status as typeof statuses[number],
    createdAt: date(item.createdAt),
    updatedAt: date(item.updatedAt),
    sessionId,
    error: text(item.error, 500),
  }
}

export function protocolCompatible(hello: AgentHello): boolean {
  return hello.protocolMin <= FLEET_PROTOCOL_MAX && hello.protocolMax >= FLEET_PROTOCOL_MIN
}
