export type SessionStatus = 'live' | 'recent' | 'idle' | 'attention'

export interface SessionRow {
  id: string
  title: string
  summary: string
  cwd: string
  workspace: string
  createdAt: string
  updatedAt: string
  model: string
  agent: string
  reasoningEffort: string
  sandboxProfile: string
  messages: number
  chatMessages: number
  turns: number
  toolCalls: number
  errors: number
  filesTouched: number
  linesAdded: number
  linesRemoved: number
  durationSeconds: number
  contextUsage: number
  status: SessionStatus
  diskBytes: number
  archived: boolean
}

export interface ActivityDay {
  date: string
  label: string
  sessions: number
  turns: number
  toolCalls: number
  errors: number
  linesChanged: number
}

export interface RankedDatum {
  name: string
  value: number
}

export interface LibraryItem {
  name: string
  source: 'bundled' | 'user' | 'marketplace'
  kind: 'skill' | 'agent' | 'plugin'
}

export interface MemoryItem {
  name: string
  scope: string
  updatedAt: string
  bytes: number
}

export interface DashboardPayload {
  generatedAt: string
  grokHome: string
  version: string
  connected: boolean
  stats: {
    sessions: number
    workspaces: number
    turns: number
    toolCalls: number
    errors: number
    filesTouched: number
    linesChanged: number
    contextAverage: number
    dataBytes: number
    liveSessions: number
    memoryFiles: number
    skills: number
  }
  sessions: SessionRow[]
  activity: ActivityDay[]
  models: RankedDatum[]
  tools: RankedDatum[]
  workspaces: RankedDatum[]
  library: LibraryItem[]
  memory: MemoryItem[]
}

export type SetupCheckId = 'node' | 'cli' | 'auth' | 'state'
export type SetupCheckState = 'ready' | 'action'

export interface SetupCheck {
  id: SetupCheckId
  label: string
  state: SetupCheckState
  detail: string
  command: string
}

export interface SetupStatus {
  generatedAt: string
  ready: boolean
  checks: SetupCheck[]
}

export type LiveAgentState = 'working' | 'waiting' | 'idle' | 'attention'
export type LiveFeedType = 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'system'

export interface LiveFeedItem {
  id: string
  type: LiveFeedType
  title: string
  text: string
  status: string
  timestamp: string
}

export interface LiveAgent {
  id: string
  pid: number
  title: string
  cwd: string
  workspace: string
  openedAt: string
  updatedAt: string
  model: string
  phase: string
  state: LiveAgentState
  turns: number
  toolCalls: number
  contextUsage: number
  currentTool: string
  contextUsed: number
  contextSize: number
  costAmount: number
  costCurrency: string
  feed: LiveFeedItem[]
}

export interface LiveSnapshot {
  generatedAt: string
  connected: boolean
  activeCount: number
  workingCount: number
  attentionCount: number
  agents: LiveAgent[]
}

export type ControlSessionState = 'starting' | 'idle' | 'working' | 'attention' | 'stopping' | 'cancelled' | 'failed'
export type ControlCancellationStatus = 'none' | 'requested' | 'confirmed' | 'timed_out' | 'failed'
export type WorkflowRunStatus =
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'budget-limited'
  | 'interrupted'
  | 'unknown'
export type WorkflowControlAction = 'pause' | 'resume' | 'stop'

export interface WorkflowPhase {
  id: string
  label: string
  status: string
}

export interface WorkflowAgent {
  id: string
  label: string
  status: string
  detail: string
  phase: string
  model: string
  tokensUsed: number
  durationMs: number
  tokenTelemetryAvailable: boolean
}

export interface WorkflowRun {
  id: string
  controlHandle: string
  displayName: string
  sessionId: string
  objective: string
  foreground: boolean
  status: WorkflowRunStatus
  phases: WorkflowPhase[]
  currentPhase: string
  agentBudget: number
  agentsUsed: number
  agentsReserved: number
  agentsRemaining: number
  usageIncomplete: boolean
  activeAgents: number
  currentAgentLabel: string
  agents: WorkflowAgent[]
  totalTokens: number
  tokenTelemetryAvailable: boolean
  elapsedMs: number
  lastEvent: string
  lastEventDetail: string
  lastEventAt: string
  pauseMessage: string
  resultSummary: string
  updatedAt: string
  canPause: boolean
  canResume: boolean
  canStop: boolean
}

export interface ControlSession {
  id: string
  cwd: string
  title: string
  model: string
  state: ControlSessionState
  createdAt: string
  updatedAt: string
  lastPrompt: string
  stopReason: string
  error: string
  cancellationStatus: ControlCancellationStatus
  cancelRequestedAt: string
  cancelledAt: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costAmount: number
  costCurrency: string
  feed: LiveFeedItem[]
  workflows: WorkflowRun[]
}

export interface ControlPermissionOption {
  id: string
  name: string
  kind: string
}

export interface ControlPermission {
  id: string
  sessionId: string
  title: string
  toolKind: string
  toolCallId: string
  createdAt: string
  options: ControlPermissionOption[]
}

export interface ControlSnapshot {
  generatedAt: string
  connected: boolean
  starting: boolean
  agentName: string
  agentVersion: string
  error: string
  sessions: ControlSession[]
  workflows: WorkflowRun[]
  permissions: ControlPermission[]
}

export interface WorkspaceFileChange {
  path: string
  status: string
  staged: boolean
  additions: number
  deletions: number
}

export interface WorkspaceSnapshot {
  cwd: string
  repository: boolean
  root: string
  branch: string
  upstream: string
  ahead: number
  behind: number
  dirty: boolean
  files: WorkspaceFileChange[]
  additions: number
  deletions: number
  error: string
}

export interface WorkspaceChangeEvent {
  root: string
  generatedAt: string
}

export interface WorkspaceDiff {
  cwd: string
  path: string
  diff: string
  truncated: boolean
}

export interface SessionWorkbenchData {
  generatedAt: string
  session: SessionRow
  transcript: LiveFeedItem[]
  live: LiveAgent | null
  control: ControlSession | null
  permissions: ControlPermission[]
  managed: boolean
}
