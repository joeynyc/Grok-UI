import type {
  AgentSessionDetail,
  ControlSession,
  ControlSnapshot,
  DashboardPayload,
  FleetHostInput,
  FleetHostMutationResponse,
  FleetHostView,
  FleetSnapshot,
  PreviewSnapshot,
  SessionRow,
  SessionWorkbenchData,
  LiveSnapshot,
  RuntimeSnapshot,
  RemoteCommandReceipt,
  RemoteSessionSnapshot,
  SetupStatus,
  UsageGroupDimension,
  UsageBudget,
  UsageBudgetDimension,
  UsageBudgetMetric,
  UsageBudgetSnapshot,
  UsagePeriod,
  UsageReport,
  UsageScope,
  WorkflowControlAction,
  WorkspaceDiff,
  WorkspaceSnapshot,
} from './types'

const JSON_RESPONSE_CAP = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 12_000
const FLEET_HOST_CAP = 32
const FLEET_STATUSES = new Set([
  'connecting',
  'healthy',
  'degraded',
  'stale',
  'offline',
  'incompatible',
  'unauthorized',
  'unavailable',
])

async function json<T>(response: Response, fallback: string): Promise<T> {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > JSON_RESPONSE_CAP) throw new Error(`${fallback}: response exceeded the safe size limit`)
  const text = await response.text()
  if (text.length > JSON_RESPONSE_CAP) throw new Error(`${fallback}: response exceeded the safe size limit`)
  let payload: { error?: string } = {}
  try {
    payload = text ? JSON.parse(text) as { error?: string } : {}
  } catch {
    throw new Error(`${fallback}: invalid JSON response`)
  }
  if (!response.ok) throw new Error(payload.error || `${fallback} (${response.status})`)
  return payload as T
}

async function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1_000)} seconds`)
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseFleetHost(value: unknown): FleetHostView {
  const host = record(value)
  const config = record(host?.config)
  if (
    !host
    || typeof host.id !== 'string'
    || typeof host.label !== 'string'
    || !['direct', 'tailscale', 'ssh'].includes(String(host.transport))
    || !FLEET_STATUSES.has(String(host.status))
    || !config
    || 'token' in config
    || 'controlToken' in config
  ) {
    throw new Error('Fleet registry returned an invalid public host record')
  }
  const snapshot = record(host.snapshot)
  if (
    snapshot
    && (
      !Array.isArray(snapshot.sessions)
      || snapshot.sessions.length > 200
      || !Array.isArray(snapshot.managedSessionIds)
      || snapshot.managedSessionIds.length > 200
      || !Array.isArray(snapshot.workflows)
      || snapshot.workflows.length > 100
      || (record(snapshot.usage) && Array.isArray(record(snapshot.usage)?.entries)
        && (record(snapshot.usage)?.entries as unknown[]).length > 1_000)
    )
  ) {
    throw new Error('Fleet host snapshot exceeded the negotiated collection caps')
  }
  return host as unknown as FleetHostView
}

export function parseFleetSnapshot(value: unknown): FleetSnapshot {
  const snapshot = record(value)
  if (
    !snapshot
    || typeof snapshot.generatedAt !== 'string'
    || typeof snapshot.protocolVersion !== 'number'
    || typeof snapshot.registryError !== 'string'
    || !Array.isArray(snapshot.hosts)
    || snapshot.hosts.length > FLEET_HOST_CAP
    || !record(snapshot.totals)
  ) {
    throw new Error('Fleet registry returned an invalid snapshot')
  }
  return {
    ...(snapshot as unknown as FleetSnapshot),
    hosts: snapshot.hosts.map(parseFleetHost),
  }
}

function parseFleetMutation(value: unknown): FleetHostMutationResponse {
  const result = record(value)
  const publicHost = record(result?.host)
  if (
    !result
    || !publicHost
    || typeof publicHost.id !== 'string'
    || 'token' in publicHost
    || 'controlToken' in publicHost
  ) {
    throw new Error('Fleet registry returned an invalid mutation response')
  }
  return {
    host: publicHost as unknown as FleetHostMutationResponse['host'],
    fleet: parseFleetSnapshot(result.fleet),
  }
}

export function parseFleetSessionDetail(value: unknown): AgentSessionDetail {
  const detail = record(value)
  const session = record(detail?.session)
  const transcript = detail?.transcript
  const workflows = detail?.workflows
  if (
    !detail
    || typeof detail.protocolVersion !== 'number'
    || typeof detail.generatedAt !== 'string'
    || typeof detail.hostId !== 'string'
    || !session
    || typeof session.id !== 'string'
    || !Array.isArray(transcript)
    || transcript.length > 200
    || !Array.isArray(workflows)
    || workflows.length > 100
    || 'permissions' in detail
  ) {
    throw new Error('Remote session returned an invalid bounded detail record')
  }
  const unsafeTranscript = transcript.some((value) => {
    const item = record(value)
    return !item
      || typeof item.id !== 'string'
      || (typeof item.text === 'string' && item.text.length > 40_000)
  })
  const unsafeWorkflow = workflows.some((value) => {
    const workflow = record(value)
    return !workflow
      || typeof workflow.id !== 'string'
      || workflow.controlHandle !== ''
      || workflow.canPause === true
      || workflow.canResume === true
      || workflow.canStop === true
      || !Array.isArray(workflow.phases)
      || workflow.phases.length > 40
      || !Array.isArray(workflow.agents)
      || workflow.agents.length > 128
  })
  if (unsafeTranscript || unsafeWorkflow) {
    throw new Error('Remote session detail exceeded its read-only protocol bounds')
  }
  return detail as unknown as AgentSessionDetail
}

export function parseRemoteSessionSnapshot(value: unknown): RemoteSessionSnapshot {
  const snapshot = record(value)
  const session = record(snapshot?.session)
  const transcript = snapshot?.transcript
  const permissions = snapshot?.permissions
  const workflows = snapshot?.workflows
  if (
    !snapshot
    || typeof snapshot.protocolVersion !== 'number'
    || typeof snapshot.generatedAt !== 'string'
    || typeof snapshot.revision !== 'string'
    || typeof snapshot.hostId !== 'string'
    || !session
    || typeof session.id !== 'string'
    || !Array.isArray(transcript)
    || transcript.length > 200
    || !Array.isArray(permissions)
    || permissions.length > 50
    || !Array.isArray(workflows)
    || workflows.length > 100
    || 'token' in snapshot
    || 'controlToken' in snapshot
  ) {
    throw new Error('Remote session returned an invalid control snapshot')
  }
  const invalidPermission = permissions.some((value) => {
    const permission = record(value)
    return !permission
      || typeof permission.id !== 'string'
      || typeof permission.sessionId !== 'string'
      || !Array.isArray(permission.options)
      || permission.options.length > 20
  })
  if (invalidPermission) throw new Error('Remote permission list exceeded its protocol bounds')
  return snapshot as unknown as RemoteSessionSnapshot
}

function parseRemoteCommandReceipt(value: unknown): RemoteCommandReceipt {
  const receipt = record(value)
  if (
    !receipt
    || typeof receipt.commandId !== 'string'
    || !['session.create', 'session.prompt', 'session.interrupt', 'permission.resolve'].includes(String(receipt.kind))
    || !['accepted', 'completed', 'failed', 'unknown'].includes(String(receipt.status))
    || typeof receipt.sessionId !== 'string'
    || typeof receipt.error !== 'string'
  ) {
    throw new Error('Remote host returned an invalid command receipt')
  }
  return receipt as unknown as RemoteCommandReceipt
}

export async function getDashboard(force = false): Promise<DashboardPayload> {
  const response = await fetch(`/api/dashboard${force ? '?refresh=1' : ''}`, {
    headers: { Accept: 'application/json' },
  })
  return json<DashboardPayload>(response, 'Dashboard request failed')
}

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  const response = await fetch('/api/live', { headers: { Accept: 'application/json' } })
  return json<LiveSnapshot>(response, 'Live runtime request failed')
}

export async function getRuntimeSnapshot(force = false): Promise<RuntimeSnapshot> {
  const response = await fetch(`/api/runtime${force ? '?refresh=1' : ''}`, {
    headers: { Accept: 'application/json' },
  })
  return json<RuntimeSnapshot>(response, 'Runtime intelligence request failed')
}

export async function getUsageReport(input: {
  period: UsagePeriod
  scope: UsageScope
  groupBy: UsageGroupDimension
}): Promise<UsageReport> {
  const query = new URLSearchParams(input)
  return json(
    await fetch(`/api/usage?${query.toString()}`, {
      headers: { Accept: 'application/json' },
    }),
    'Usage ledger request failed',
  )
}

export async function getUsageBudgets(): Promise<UsageBudgetSnapshot> {
  return json(
    await fetch('/api/usage/budgets', { headers: { Accept: 'application/json' } }),
    'Usage budgets request failed',
  )
}

export async function saveUsageBudget(input: {
  id?: string
  dimension: UsageBudgetDimension
  key?: string
  label?: string
  metric: UsageBudgetMetric
  limit: number
  period: UsagePeriod
  currency?: string
  enabled?: boolean
}): Promise<{ budget: UsageBudget; snapshot: UsageBudgetSnapshot }> {
  return json(
    await fetch('/api/usage/budgets', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Unable to save usage budget',
  )
}

export async function deleteUsageBudget(id: string): Promise<void> {
  const response = await fetch(`/api/usage/budgets/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) await json(response, 'Unable to delete usage budget')
}

export async function acknowledgeUsageAlert(id: string): Promise<UsageBudgetSnapshot> {
  return json(
    await fetch(`/api/usage/alerts/${encodeURIComponent(id)}/acknowledge`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }),
    'Unable to acknowledge usage alert',
  )
}

export async function downloadUsageExport(input: {
  period: UsagePeriod
  scope: UsageScope
  groupBy: UsageGroupDimension
  format: 'json' | 'csv'
  privacy: boolean
}): Promise<void> {
  const query = new URLSearchParams({
    period: input.period,
    scope: input.scope,
    groupBy: input.groupBy,
    format: input.format,
    privacy: input.privacy ? '1' : '0',
  })
  const response = await fetch(`/api/usage/export?${query.toString()}`, {
    headers: { Accept: input.format === 'json' ? 'application/json' : 'text/csv' },
  })
  if (!response.ok) {
    await json(response, 'Usage export failed')
    return
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `grok-ui-usage.${input.format}`
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function getSetupStatus(force = false): Promise<SetupStatus> {
  return json(
    await fetch(`/api/setup${force ? '?refresh=1' : ''}`, {
      headers: { Accept: 'application/json' },
    }),
    'Setup diagnostics request failed',
  )
}

export async function getAuthStatus(): Promise<{ required: boolean; authenticated: boolean }> {
  return json(await fetch('/api/auth/status'), 'Authentication check failed')
}

export async function login(token: string): Promise<void> {
  await json(await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }), 'Sign in failed')
}

export async function getControlSnapshot(): Promise<ControlSnapshot> {
  return json(await fetch('/api/control'), 'Control channel request failed')
}

export async function createControlSession(input: {
  cwd: string
  prompt: string
  model?: string
  reasoningEffort?: string
}): Promise<ControlSession> {
  return json(await fetch('/api/control/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }), 'Unable to create Grok session')
}

export async function promptControlSession(
  sessionId: string,
  input: { cwd: string; prompt: string },
): Promise<ControlSession> {
  return json(await fetch(`/api/control/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }), 'Unable to send prompt')
}

export async function cancelControlSession(sessionId: string): Promise<void> {
  await json(await fetch(`/api/control/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
  }), 'Unable to cancel session')
}

export async function controlWorkflow(
  sessionId: string,
  workflowId: string,
  action: WorkflowControlAction,
): Promise<void> {
  await json(await fetch(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  ), `Unable to ${action} workflow`)
}

export async function resolveControlPermission(permissionId: string, optionId?: string): Promise<void> {
  await json(await fetch(`/api/control/permissions/${encodeURIComponent(permissionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ optionId }),
  }), 'Unable to resolve permission')
}

export async function getWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
  return json(
    await fetch(`/api/workspace?cwd=${encodeURIComponent(cwd)}`),
    'Workspace request failed',
  )
}

export async function getWorkspaceDiff(cwd: string, file: string): Promise<WorkspaceDiff> {
  return json(
    await fetch(`/api/workspace/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`),
    'Diff request failed',
  )
}

export async function getSessionWorkbench(sessionId: string): Promise<SessionWorkbenchData> {
  return json(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/workbench`, {
      headers: { Accept: 'application/json' },
    }),
    'Session console request failed',
  )
}

export async function updateSession(
  sessionId: string,
  patch: { title?: string; archived?: boolean },
): Promise<SessionRow> {
  return json(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }), 'Unable to update session')
}

export async function cancelWorkbenchSession(sessionId: string): Promise<void> {
  await json(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
  }), 'Unable to cancel session')
}

export async function getFleetSnapshot(): Promise<FleetSnapshot> {
  return parseFleetSnapshot(await json<unknown>(
    await boundedFetch('/api/fleet', { headers: { Accept: 'application/json' } }),
    'Fleet registry request failed',
  ))
}

export async function createFleetHost(input: FleetHostInput): Promise<FleetHostMutationResponse> {
  return parseFleetMutation(await json<unknown>(
    await boundedFetch('/api/fleet/hosts', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Unable to register host',
  ))
}

export async function updateFleetHost(
  id: string,
  input: FleetHostInput,
): Promise<FleetHostMutationResponse> {
  return parseFleetMutation(await json<unknown>(
    await boundedFetch(`/api/fleet/hosts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Unable to update host',
  ))
}

export async function deleteFleetHost(id: string): Promise<void> {
  const response = await boundedFetch(`/api/fleet/hosts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!response.ok) await json(response, 'Unable to remove host')
}

export async function refreshFleetHost(id: string): Promise<FleetSnapshot> {
  return parseFleetSnapshot(await json<unknown>(
    await boundedFetch(`/api/fleet/hosts/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }, 20_000),
    'Unable to refresh host',
  ))
}

export async function getFleetSessionDetail(hostId: string, sessionId: string): Promise<AgentSessionDetail> {
  return parseFleetSessionDetail(await json<unknown>(
    await boundedFetch(
      `/api/fleet/hosts/${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Accept: 'application/json' } },
    ),
    'Remote session request failed',
  ))
}

export async function getRemoteSession(
  hostId: string,
  sessionId: string,
): Promise<RemoteSessionSnapshot> {
  return parseRemoteSessionSnapshot(await json(
    await boundedFetch(
      `/api/fleet/hosts/${encodeURIComponent(hostId)}/remote-sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Accept: 'application/json' } },
    ),
    'Remote session request failed',
  ))
}

export function remoteSessionEventsUrl(hostId: string, sessionId: string): string {
  return `/api/fleet/hosts/${encodeURIComponent(hostId)}/remote-sessions/${encodeURIComponent(sessionId)}/events`
}

async function remoteCommand(
  url: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<RemoteCommandReceipt> {
  const receipt = parseRemoteCommandReceipt(await json(
    await boundedFetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    fallback,
  ))
  if (receipt.status === 'failed') throw new Error(receipt.error || fallback)
  return receipt
}

export async function startRemoteSession(hostId: string, input: {
  commandId: string
  expiresAt: string
  cwd: string
  prompt: string
  model?: string
  reasoningEffort?: string
}): Promise<RemoteCommandReceipt> {
  return remoteCommand(
    `/api/fleet/hosts/${encodeURIComponent(hostId)}/remote-sessions`,
    input,
    'Unable to start the remote session',
  )
}

export async function promptRemoteSession(
  hostId: string,
  sessionId: string,
  commandId: string,
  expiresAt: string,
  prompt: string,
): Promise<RemoteCommandReceipt> {
  return remoteCommand(
    `/api/fleet/hosts/${encodeURIComponent(hostId)}/remote-sessions/${encodeURIComponent(sessionId)}/prompt`,
    { commandId, expiresAt, prompt },
    'Unable to send the remote follow-up',
  )
}

export async function interruptRemoteSession(
  hostId: string,
  sessionId: string,
  commandId: string,
  expiresAt: string,
): Promise<RemoteCommandReceipt> {
  return remoteCommand(
    `/api/fleet/hosts/${encodeURIComponent(hostId)}/remote-sessions/${encodeURIComponent(sessionId)}/interrupt`,
    { commandId, expiresAt },
    'Unable to interrupt the remote turn',
  )
}

export async function resolveRemotePermission(
  hostId: string,
  sessionId: string,
  permissionId: string,
  commandId: string,
  expiresAt: string,
  optionId?: string,
): Promise<RemoteCommandReceipt> {
  return remoteCommand(
    `/api/fleet/hosts/${encodeURIComponent(hostId)}/remote-sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
    { commandId, expiresAt, optionId },
    'Unable to resolve the remote permission',
  )
}

export async function getSessionPreview(sessionId: string): Promise<PreviewSnapshot> {
  return json(
    await boundedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/preview`, {
      headers: { Accept: 'application/json' },
    }),
    'Preview request failed',
  )
}

export async function startSessionPreview(sessionId: string): Promise<PreviewSnapshot> {
  return json(await boundedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/preview/start`, {
    method: 'POST',
  }), 'Unable to start preview')
}

export async function stopSessionPreview(sessionId: string): Promise<PreviewSnapshot> {
  return json(await boundedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/preview/stop`, {
    method: 'POST',
  }), 'Unable to stop preview')
}
