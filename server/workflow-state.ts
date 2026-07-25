import type {
  WorkflowAgent,
  WorkflowControlAction,
  WorkflowPhase,
  WorkflowRun,
  WorkflowRunStatus,
} from './types.js'

type UnknownRecord = Record<string, unknown>

const CONTROL_HANDLE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function text(...values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string')
  return typeof value === 'string' ? value : ''
}

function number(...values: unknown[]): number | undefined {
  const value = values.find((item) => typeof item === 'number' || typeof item === 'string')
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function boolean(...values: unknown[]): boolean | undefined {
  const value = values.find((item) => typeof item === 'boolean')
  return typeof value === 'boolean' ? value : undefined
}

function normalizeStatus(value: string): WorkflowRunStatus {
  const normalized = value.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
  if (['running', 'active', 'in-progress', 'started', 'resumed'].includes(normalized)) return 'running'
  if (['paused', 'pause', 'waiting'].includes(normalized)) return 'paused'
  if (['failed', 'failure', 'error'].includes(normalized)) return 'failed'
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(normalized)) return 'completed'
  if (['cancelled', 'canceled', 'stopped', 'stop'].includes(normalized)) return 'cancelled'
  if (['budget-limited', 'budget-exhausted', 'agent-budget-exceeded'].includes(normalized)) return 'budget-limited'
  if (['interrupted', 'aborted'].includes(normalized)) return 'interrupted'
  return 'unknown'
}

function deriveStatus(update: UnknownRecord, existing?: WorkflowRun): WorkflowRunStatus {
  const explicit = normalizeStatus(text(
    update.status,
    update.state,
    update.outcome,
    update.run_status,
    update.runStatus,
  ))
  if (explicit !== 'unknown') return explicit

  const event = text(update.last_event, update.lastEvent, update.event).toLowerCase()
  if (event.includes('budget')) return 'budget-limited'
  if (event.includes('fail') || event.includes('error')) return 'failed'
  if (event.includes('pause')) return 'paused'
  if (event.includes('complete') || event.includes('success') || event.includes('finish')) return 'completed'
  if (event.includes('cancel') || event.includes('stop')) return 'cancelled'
  if (event.includes('resume') || event.includes('start') || event.includes('progress')) return 'running'
  if (text(update.pause_message, update.pauseMessage)) return 'paused'
  if (text(update.result_summary, update.resultSummary)) return 'completed'
  return existing?.status || 'running'
}

function normalizePhases(value: unknown, existing: WorkflowPhase[]): WorkflowPhase[] {
  if (!Array.isArray(value)) return existing
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return { id: item || `phase-${index + 1}`, label: item || `Phase ${index + 1}`, status: 'pending' }
    }
    const phase = record(item)
    const label = text(phase.label, phase.name, phase.title, phase.id) || `Phase ${index + 1}`
    return {
      id: text(phase.id, phase.phase_id, phase.phaseId, phase.name) || `phase-${index + 1}`,
      label,
      status: text(phase.status, phase.state) || 'pending',
    }
  })
}

function normalizeAgents(value: unknown, existing: WorkflowAgent[]): WorkflowAgent[] {
  if (!Array.isArray(value)) return existing
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return { id: item || `agent-${index + 1}`, label: item || `Agent ${index + 1}`, status: 'unknown', detail: '' }
    }
    const agent = record(item)
    const label = text(agent.label, agent.name, agent.title, agent.id) || `Agent ${index + 1}`
    return {
      id: text(agent.id, agent.agent_id, agent.agentId, agent.name) || `agent-${index + 1}`,
      label,
      status: text(agent.status, agent.state) || 'unknown',
      detail: text(agent.detail, agent.message, agent.current_task, agent.currentTask),
    }
  })
}

function controls(status: WorkflowRunStatus, controlHandle: string) {
  const controllable = CONTROL_HANDLE.test(controlHandle)
  return {
    canPause: controllable && status === 'running',
    canResume: controllable && (status === 'paused' || status === 'failed'),
    canStop: controllable && (status === 'running' || status === 'paused'),
  }
}

export function parseWorkflowNotification(
  value: unknown,
  existing?: WorkflowRun,
): { sessionId: string; run: WorkflowRun } | null {
  const envelope = record(value)
  const params = Object.keys(record(envelope.params)).length ? record(envelope.params) : envelope
  const updateEnvelope = Object.keys(record(params.update)).length ? record(params.update) : params
  const eventType = text(
    updateEnvelope.sessionUpdate,
    updateEnvelope.session_update,
    updateEnvelope.type,
    params.sessionUpdate,
    params.session_update,
  )
  if (eventType !== 'workflow_updated') return null

  const nested = record(updateEnvelope.workflow)
  const update = Object.keys(nested).length ? { ...updateEnvelope, ...nested } : updateEnvelope
  const sessionId = text(params.sessionId, params.session_id, update.sessionId, update.session_id)
    || existing?.sessionId
    || ''
  const runId = text(update.run_id, update.runId, update.id) || existing?.id || ''
  if (!sessionId || !runId) return null

  const timestamp = text(update.last_event_timestamp, update.lastEventTimestamp, update.updated_at, update.updatedAt)
    || new Date().toISOString()
  const explicitHandle = text(update.display_name, update.displayName, update.control_handle, update.controlHandle)
  const controlHandle = explicitHandle || existing?.controlHandle || ''
  const status = deriveStatus(update, existing)
  const phasesValue = update.phases
  const agentsValue = update.agents
  const run: WorkflowRun = {
    id: runId,
    controlHandle,
    displayName: explicitHandle || existing?.displayName || runId,
    sessionId,
    objective: text(update.objective) || existing?.objective || '',
    foreground: boolean(update.foreground) ?? existing?.foreground ?? false,
    status,
    phases: normalizePhases(phasesValue, existing?.phases || []),
    currentPhase: text(update.current_phase, update.currentPhase) || existing?.currentPhase || '',
    agentBudget: number(update.agent_budget, update.agentBudget) ?? existing?.agentBudget ?? 0,
    agentsUsed: number(update.agents_used, update.agentsUsed) ?? existing?.agentsUsed ?? 0,
    agentsReserved: number(update.agents_reserved, update.agentsReserved) ?? existing?.agentsReserved ?? 0,
    usageIncomplete: boolean(update.agent_usage_incomplete, update.agentUsageIncomplete)
      ?? existing?.usageIncomplete
      ?? false,
    activeAgents: number(update.active_agents, update.activeAgents) ?? existing?.activeAgents ?? 0,
    currentAgentLabel: text(update.current_agent_label, update.currentAgentLabel)
      || existing?.currentAgentLabel
      || '',
    agents: normalizeAgents(agentsValue, existing?.agents || []),
    lastEvent: text(update.last_event, update.lastEvent, update.event) || existing?.lastEvent || '',
    lastEventDetail: text(update.last_event_detail, update.lastEventDetail)
      || existing?.lastEventDetail
      || '',
    lastEventAt: text(update.last_event_timestamp, update.lastEventTimestamp)
      || existing?.lastEventAt
      || timestamp,
    pauseMessage: text(update.pause_message, update.pauseMessage) || existing?.pauseMessage || '',
    resultSummary: text(update.result_summary, update.resultSummary) || existing?.resultSummary || '',
    updatedAt: timestamp,
    ...controls(status, controlHandle),
  }
  return { sessionId, run }
}

export function workflowControlCommand(action: WorkflowControlAction, handle: string): string {
  if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Unsupported workflow action.')
  if (!CONTROL_HANDLE.test(handle)) throw new Error('Workflow does not expose a safe control handle.')
  return `/workflow ${action} ${handle}`
}

export function interruptRestoredWorkflow(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    status: run.status === 'running' || run.status === 'paused' ? 'interrupted' : run.status,
    canPause: false,
    canResume: false,
    canStop: false,
  }
}
