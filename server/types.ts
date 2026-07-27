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
  costTelemetryAvailable: boolean
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
  tokenTelemetryAvailable: boolean
  costAmount: number
  costCurrency: string
  costTelemetryAvailable: boolean
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
  processId: number
  starting: boolean
  reconnecting: boolean
  reconnectAttempt: number
  lastDisconnectedAt: string
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

export type RuntimeProcessState = 'running' | 'sleeping' | 'stopped' | 'zombie' | 'unknown'
export type RuntimeBindScope = 'loopback' | 'all' | 'lan' | 'unknown'
export type RuntimeServiceKind =
  | 'database'
  | 'cache'
  | 'queue'
  | 'emulator'
  | 'dev-server'
  | 'web'
  | 'other'
export type RuntimeTestStatus = 'running' | 'passed' | 'failed' | 'interrupted' | 'unknown'
export type ExternalCallCategory = 'network' | 'browser' | 'mcp' | 'cloud' | 'vcs'

export interface RuntimeRoot {
  pid: number
  managed: boolean
  sessionIds: string[]
  workspaces: string[]
}

export interface RuntimeProcess {
  pid: number
  parentPid: number
  rootPid: number
  depth: number
  name: string
  state: RuntimeProcessState
  elapsed: string
  sessionIds: string[]
  workspaces: string[]
  ports: number[]
}

export interface RuntimePort {
  pid: number
  port: number
  protocol: 'tcp'
  bind: RuntimeBindScope
}

export interface RuntimeService {
  id: string
  pid: number
  name: string
  kind: RuntimeServiceKind
  port: number
  bind: RuntimeBindScope
  status: 'listening' | 'running'
}

export interface RuntimeTestRun {
  id: string
  sessionId: string
  title: string
  framework: string
  status: RuntimeTestStatus
  startedAt: string
  updatedAt: string
  incomplete: boolean
}

export interface ExternalToolCall {
  id: string
  sessionId: string
  title: string
  category: ExternalCallCategory
  status: string
  updatedAt: string
}

export interface RuntimeSnapshot {
  generatedAt: string
  available: boolean
  partial: boolean
  error: string
  roots: RuntimeRoot[]
  processes: RuntimeProcess[]
  ports: RuntimePort[]
  services: RuntimeService[]
  tests: RuntimeTestRun[]
  externalCalls: ExternalToolCall[]
}

export type UsageSource = 'grok-reported' | 'derived' | 'incomplete' | 'unavailable'
export type UsageEntryKind = 'managed-session' | 'cli-session' | 'workflow-agent'
export type UsageGroupDimension = 'project' | 'model' | 'session' | 'agent'
export type UsagePeriod = '24h' | '7d' | '30d' | '90d' | 'all'
export type UsageScope = 'sessions' | 'workflow-agents' | 'all'

export interface UsageMetric {
  value: number | null
  source: UsageSource
}

export interface UsageCostMetric extends UsageMetric {
  currency: string
}

export interface UsageLedgerEntry {
  id: string
  kind: UsageEntryKind
  sessionId: string
  sessionTitle: string
  workflowId: string
  project: string
  cwd: string
  model: string
  agent: string
  startedAt: string
  updatedAt: string
  inputTokens: UsageMetric
  outputTokens: UsageMetric
  totalTokens: UsageMetric
  cost: UsageCostMetric
}

export interface UsageReportGroup {
  key: string
  label: string
  entries: number
  sessions: number
  inputTokens: UsageMetric
  outputTokens: UsageMetric
  totalTokens: UsageMetric
  costs: UsageCostMetric[]
  updatedAt: string
}

export interface UsageReport {
  generatedAt: string
  period: UsagePeriod
  scope: UsageScope
  from: string
  to: string
  groupBy: UsageGroupDimension
  entries: UsageLedgerEntry[]
  totals: UsageReportGroup
  groups: UsageReportGroup[]
  coverage: Record<UsageSource, number>
}

export type UsageBudgetDimension = 'global' | UsageGroupDimension
export type UsageBudgetMetric = 'tokens' | 'cost'

export interface UsageBudget {
  id: string
  dimension: UsageBudgetDimension
  key: string
  label: string
  metric: UsageBudgetMetric
  limit: number
  period: UsagePeriod
  currency: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface UsageBudgetAlert {
  id: string
  budgetId: string
  threshold: number
  observed: number
  limit: number
  source: UsageSource
  periodFrom: string
  createdAt: string
  acknowledgedAt: string
}

export interface UsageBudgetStatus {
  budget: UsageBudget
  observed: UsageMetric
  percent: number | null
  alertLevel: 'none' | 'warning' | 'exceeded' | 'unavailable'
  periodFrom: string
  periodTo: string
}

export interface UsageBudgetSnapshot {
  generatedAt: string
  statuses: UsageBudgetStatus[]
  alerts: UsageBudgetAlert[]
}

export type FleetTransportKind = 'direct' | 'tailscale' | 'ssh'
export type FleetHostStatus =
  | 'connecting'
  | 'healthy'
  | 'degraded'
  | 'stale'
  | 'offline'
  | 'incompatible'
  | 'unauthorized'
  | 'unavailable'
export type FleetFreshness = 'unknown' | 'fresh' | 'aging' | 'stale' | 'expired'
export type AgentCapability =
  | 'sessions.list'
  | 'sessions.detail'
  | 'workflows.list'
  | 'runtime.snapshot'
  | 'usage.report'

export interface FleetHostConfig {
  id: string
  label: string
  transport: FleetTransportKind
  baseUrl: string
  token: string
  sshTarget: string
  sshPort: number
  localPort: number
  remotePort: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface FleetHostPublicConfig extends Omit<FleetHostConfig, 'token'> {
  hasToken: boolean
}

export interface AgentHostIdentity {
  id: string
  label: string
  hostname: string
  platform: string
  arch: string
}

export interface AgentHello {
  protocolVersion: number
  protocolMin: number
  protocolMax: number
  generatedAt: string
  host: AgentHostIdentity
  grokUiVersion: string
  agentVersion: string
  grokVersion: string
  capabilities: AgentCapability[]
}

export interface AgentSnapshot {
  protocolVersion: number
  generatedAt: string
  host: AgentHostIdentity
  grokUiVersion: string
  agentVersion: string
  grokVersion: string
  capabilities: AgentCapability[]
  health: {
    status: 'healthy' | 'degraded'
    detail: string
  }
  sessions: SessionRow[]
  workflows: WorkflowRun[]
  runtime: RuntimeSnapshot | null
  usage: UsageReport | null
  sections: {
    sessions: 'available' | 'partial' | 'unavailable'
    workflows: 'available' | 'partial' | 'unavailable'
    runtime: 'available' | 'partial' | 'unavailable'
    usage: 'available' | 'partial' | 'unavailable'
  }
  truncated: {
    sessions: boolean
    workflows: boolean
    usageEntries: boolean
  }
}

export interface AgentSessionDetail {
  protocolVersion: number
  generatedAt: string
  hostId: string
  session: SessionRow
  transcript: LiveFeedItem[]
  live: LiveAgent | null
  control: Omit<ControlSession, 'workflows'> | null
  workflows: WorkflowRun[]
  managed: boolean
}

export interface FleetHostView {
  id: string
  label: string
  transport: FleetTransportKind
  status: FleetHostStatus
  statusDetail: string
  freshness: FleetFreshness
  latencyMs: number | null
  lastSeen: string
  lastAttemptAt: string
  consecutiveFailures: number
  host: AgentHostIdentity | null
  grokUiVersion: string
  agentVersion: string
  grokVersion: string
  capabilities: AgentCapability[]
  snapshot: AgentSnapshot | null
  config: FleetHostPublicConfig
}

export interface FleetSnapshot {
  generatedAt: string
  protocolVersion: number
  registryError: string
  pollIntervalMs: number
  staleAfterMs: number
  offlineAfterMs: number
  hosts: FleetHostView[]
  totals: {
    hosts: number
    healthy: number
    degraded: number
    stale: number
    offline: number
    sessions: number
    workflows: number
  }
}
