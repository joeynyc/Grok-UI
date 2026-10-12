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
  InspectSnapshot,
  ModelOption,
  PlanAction,
  SessionSlash,
} from './types'
import { readJsonResponse, requestJson } from './request'

// Calls that hand work to Grok carry no client deadline: the server keeps
// going after a timeout, so reporting failure would invite a duplicate send.
const WORK_STARTED = null
// Setup runs `grok version` (5s) then `grok models` (10s) on the server.
const SETUP_TIMEOUT_MS = 30_000

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
  return requestJson<DashboardPayload>(
    `/api/dashboard${force ? '?refresh=1' : ''}`,
    'Dashboard request failed',
    {
      headers: { Accept: 'application/json' },
    },
  )
}

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  return requestJson<LiveSnapshot>(
    '/api/live',
    'Live runtime request failed',
    {
      headers: { Accept: 'application/json' },
    },
  )
}

export async function getRuntimeSnapshot(force = false): Promise<RuntimeSnapshot> {
  return requestJson<RuntimeSnapshot>(
    `/api/runtime${force ? '?refresh=1' : ''}`,
    'Runtime intelligence request failed',
    {
      headers: { Accept: 'application/json' },
    },
  )
}

export async function getUsageReport(input: {
  period: UsagePeriod
  scope: UsageScope
  groupBy: UsageGroupDimension
}, signal?: AbortSignal): Promise<UsageReport> {
  const query = new URLSearchParams(input)
  return requestJson(
    `/api/usage?${query.toString()}`,
    'Usage ledger request failed',
    {
      signal,
      headers: { Accept: 'application/json' },
    },
  )
}

export async function getUsageBudgets(signal?: AbortSignal): Promise<UsageBudgetSnapshot> {
  return requestJson(
    '/api/usage/budgets',
    'Usage budgets request failed',
    { signal, headers: { Accept: 'application/json' } },
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
  return requestJson(
    '/api/usage/budgets',
    'Unable to save usage budget',
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
}

export async function deleteUsageBudget(id: string): Promise<void> {
  await requestJson(
    `/api/usage/budgets/${encodeURIComponent(id)}`,
    'Unable to delete usage budget',
    { method: 'DELETE' },
  )
}

export async function acknowledgeUsageAlert(id: string): Promise<UsageBudgetSnapshot> {
  return requestJson(
    `/api/usage/alerts/${encodeURIComponent(id)}/acknowledge`,
    'Unable to acknowledge usage alert',
    {
      method: 'POST',
      headers: { Accept: 'application/json' },
    },
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
    await readJsonResponse(response, 'Usage export failed')
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
  return requestJson(
    `/api/setup${force ? '?refresh=1' : ''}`,
    'Setup diagnostics request failed',
    {
      headers: { Accept: 'application/json' },
    },
    SETUP_TIMEOUT_MS,
  )
}

export async function getAuthStatus(): Promise<{ required: boolean; authenticated: boolean }> {
  return requestJson('/api/auth/status', 'Authentication check failed')
}

export async function login(token: string): Promise<void> {
  await requestJson(
    '/api/auth/login',
    'Sign in failed',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  )
}

export async function getControlSnapshot(): Promise<ControlSnapshot> {
  return requestJson('/api/control', 'Control channel request failed')
}

export async function createControlSession(input: {
  cwd: string
  prompt: string
  model?: string
  reasoningEffort?: string
  permissionMode?: string
  planMode?: boolean
  worktree?: boolean
}): Promise<ControlSession> {
  return requestJson(
    '/api/control/sessions',
    'Unable to create Grok session',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    WORK_STARTED,
  )
}

export async function listControlModels(): Promise<ModelOption[]> {
  const payload = await requestJson<{ models: ModelOption[] }>('/api/control/models', 'Unable to list models')
  return payload.models || []
}

export async function reviewControlPlan(
  sessionId: string,
  action: PlanAction,
  note = '',
): Promise<ControlSession> {
  return requestJson(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/plan`,
    'Unable to review plan',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, note }),
    },
    WORK_STARTED,
  )
}

export async function runControlCommand(
  sessionId: string,
  command: SessionSlash,
  argument = '',
): Promise<ControlSession> {
  return requestJson(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/command`,
    'Unable to run session command',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, argument }),
    },
    WORK_STARTED,
  )
}

export async function setControlMode(sessionId: string, modeId: string): Promise<ControlSession> {
  return requestJson(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/mode`,
    'Unable to set session mode',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modeId }),
    },
    WORK_STARTED,
  )
}

export async function inspectWorkspace(cwd: string): Promise<InspectSnapshot> {
  return requestJson(`/api/inspect?cwd=${encodeURIComponent(cwd)}`, 'Unable to inspect workspace')
}

export async function exportSessionMarkdown(sessionId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export`)
  if (!response.ok) throw new Error('Unable to export session.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${sessionId}.md`
  link.click()
  URL.revokeObjectURL(url)
}

export async function deleteRecordedSession(sessionId: string): Promise<void> {
  await requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    'Unable to delete session',
    {
      method: 'DELETE',
    },
  )
}

export async function promptControlSession(
  sessionId: string,
  input: { cwd: string; prompt: string },
): Promise<ControlSession> {
  return requestJson(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/prompt`,
    'Unable to send prompt',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    WORK_STARTED,
  )
}

export async function cancelControlSession(sessionId: string): Promise<void> {
  await requestJson(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/cancel`,
    'Unable to cancel session',
    {
      method: 'POST',
    },
    WORK_STARTED,
  )
}

export async function controlWorkflow(
  sessionId: string,
  workflowId: string,
  action: WorkflowControlAction,
): Promise<void> {
  await requestJson(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(workflowId)}`,
    `Unable to ${action} workflow`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
    WORK_STARTED,
  )
}

export async function resolveControlPermission(permissionId: string, optionId?: string): Promise<void> {
  await requestJson(
    `/api/control/permissions/${encodeURIComponent(permissionId)}`,
    'Unable to resolve permission',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId }),
    },
    WORK_STARTED,
  )
}

export async function getWorkspaceSnapshot(cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  return requestJson(`/api/workspace?cwd=${encodeURIComponent(cwd)}`, 'Workspace request failed', { signal })
}

export async function getWorkspaceDiff(cwd: string, file: string, signal?: AbortSignal): Promise<WorkspaceDiff> {
  return requestJson(
    `/api/workspace/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`,
    'Diff request failed',
    { signal },
  )
}

export async function getSessionWorkbench(sessionId: string, signal?: AbortSignal): Promise<SessionWorkbenchData> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/workbench`,
    'Session console request failed',
    {
      signal,
      headers: { Accept: 'application/json' },
    },
  )
}

export async function updateSession(
  sessionId: string,
  patch: { title?: string; archived?: boolean },
): Promise<SessionRow> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    'Unable to update session',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
}

export async function cancelWorkbenchSession(sessionId: string): Promise<void> {
  await requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
    'Unable to cancel session',
    {
      method: 'POST',
    },
    WORK_STARTED,
  )
}

export async function getFleetSnapshot(): Promise<FleetSnapshot> {
  return parseFleetSnapshot(await requestJson<unknown>(
    '/api/fleet',
    'Fleet registry request failed',
    { headers: { Accept: 'application/json' } },
  ))
}

export async function createFleetHost(input: FleetHostInput): Promise<FleetHostMutationResponse> {
  return parseFleetMutation(await requestJson<unknown>(
    '/api/fleet/hosts',
    'Unable to register host',
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  ))
}

export async function updateFleetHost(
  id: string,
  input: FleetHostInput,
): Promise<FleetHostMutationResponse> {
  return parseFleetMutation(await requestJson<unknown>(
    `/api/fleet/hosts/${encodeURIComponent(id)}`,
    'Unable to update host',
    {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  ))
}

export async function deleteFleetHost(id: string): Promise<void> {
  await requestJson(
    `/api/fleet/hosts/${encodeURIComponent(id)}`,
    'Unable to remove host',
    {
      method: 'DELETE',
    },
  )
}

export async function refreshFleetHost(id: string): Promise<FleetSnapshot> {
  return parseFleetSnapshot(await requestJson<unknown>(
    `/api/fleet/hosts/${encodeURIComponent(id)}/refresh`,
    'Unable to refresh host',
    {
      method: 'POST',
      headers: { Accept: 'application/json' },
    },
    20_000,
  ))
}

export async function getFleetSessionDetail(hostId: string, sessionId: string): Promise<AgentSessionDetail> {
  return parseFleetSessionDetail(await requestJson<unknown>(
    `/api/fleet/hosts/${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(sessionId)}`,
    'Remote session request failed',
    { headers: { Accept: 'application/json' } },
  ))
}

export async function getRemoteSession(
  hostId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<RemoteSessionSnapshot> {
  return parseRemoteSessionSnapshot(await requestJson(
    `/api/fleet/hosts/${encodeURIComponent(hostId)}/remote-sessions/${encodeURIComponent(sessionId)}`,
    'Remote session request failed',
    { signal, headers: { Accept: 'application/json' } },
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
  const receipt = parseRemoteCommandReceipt(await requestJson(
    url,
    fallback,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
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

export async function getSessionPreview(sessionId: string, signal?: AbortSignal): Promise<PreviewSnapshot> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/preview`,
    'Preview request failed',
    {
      signal,
      headers: { Accept: 'application/json' },
    },
  )
}

export async function startSessionPreview(sessionId: string): Promise<PreviewSnapshot> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/preview/start`,
    'Unable to start preview',
    {
      method: 'POST',
    },
    WORK_STARTED,
  )
}

export async function stopSessionPreview(sessionId: string): Promise<PreviewSnapshot> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/preview/stop`,
    'Unable to stop preview',
    {
      method: 'POST',
    },
    WORK_STARTED,
  )
}
