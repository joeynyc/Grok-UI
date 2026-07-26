import type {
  ControlSession,
  ControlSnapshot,
  DashboardPayload,
  SessionRow,
  SessionWorkbenchData,
  LiveSnapshot,
  RuntimeSnapshot,
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

async function json<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || `${fallback} (${response.status})`)
  return payload as T
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
