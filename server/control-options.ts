export type PermissionMode = 'ask' | 'auto' | 'always-approve'
export type PlanAction = 'approve' | 'request-changes' | 'comment' | 'quit'
export type SessionSlash = 'compact' | 'rewind' | 'fork' | 'view-plan' | 'create-workflow'

export interface LaunchOptions {
  cwd: string
  prompt: string
  model?: string
  reasoningEffort?: string
  permissionMode?: PermissionMode
  planMode?: boolean
  worktree?: boolean
}

export interface SessionMeta {
  clientIdentifier: 'grok-ui'
  modelId?: string
  reasoningEffort?: string
  yoloMode: boolean
  autoMode: boolean
  planMode: boolean
  worktree: boolean
}

const PERMISSION_MODES = new Set<PermissionMode>(['ask', 'auto', 'always-approve'])

export function parsePermissionMode(value: unknown): PermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as PermissionMode)
    ? value as PermissionMode
    : 'ask'
}

export function launchMeta(input: LaunchOptions): SessionMeta {
  const permissionMode = parsePermissionMode(input.permissionMode)
  return {
    clientIdentifier: 'grok-ui',
    modelId: input.model || undefined,
    reasoningEffort: input.reasoningEffort || undefined,
    yoloMode: permissionMode === 'always-approve',
    autoMode: permissionMode === 'auto',
    planMode: input.planMode === true,
    worktree: input.worktree === true,
  }
}

export function planActionPrompt(action: PlanAction, note = ''): string {
  const trimmed = note.trim()
  if (action === 'approve') return 'Approve the current plan and start building.'
  if (action === 'quit') return 'Quit plan mode without executing the plan.'
  if (action === 'request-changes') {
    if (!trimmed) throw new Error('Describe the changes the plan should make.')
    return `Request changes to the current plan:\n${trimmed}`
  }
  if (!trimmed) throw new Error('Add a comment on the plan.')
  return `Comment on the current plan:\n${trimmed}`
}

export function slashPrompt(command: SessionSlash, argument = ''): string {
  const trimmed = argument.trim()
  if (command === 'create-workflow') {
    if (!trimmed) throw new Error('Describe the workflow to create.')
    return `/create-workflow ${trimmed}`
  }
  if (command === 'compact') return trimmed ? `/compact ${trimmed}` : '/compact'
  if (command === 'rewind') return '/rewind'
  if (command === 'fork') return trimmed ? `/fork ${trimmed}` : '/fork'
  return '/view-plan'
}

export function parsePlanAction(value: unknown): PlanAction {
  if (value === 'approve' || value === 'request-changes' || value === 'comment' || value === 'quit') {
    return value
  }
  throw new Error('Plan action must be approve, request-changes, comment, or quit.')
}

export function parseSlash(value: unknown): SessionSlash {
  if (
    value === 'compact'
    || value === 'rewind'
    || value === 'fork'
    || value === 'view-plan'
    || value === 'create-workflow'
  ) {
    return value
  }
  throw new Error('Unknown session command.')
}
