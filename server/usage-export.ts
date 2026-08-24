import type { UsageLedgerEntry, UsageReport } from './types.js'

export type UsageExportFormat = 'json' | 'csv'

const MAX_EXPORT_ENTRIES = 5_000

function alias(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(-3).toUpperCase().padStart(3, '0')
}

function redact(entry: UsageLedgerEntry): UsageLedgerEntry {
  const sessionAlias = alias(entry.sessionId || entry.id)
  const projectAlias = alias(entry.cwd || entry.project)
  const workflowAlias = entry.workflowId ? alias(entry.workflowId) : ''
  return {
    ...entry,
    id: `usage:private-${alias(entry.id).toLowerCase()}`,
    sessionId: `session-${sessionAlias.toLowerCase()}`,
    sessionTitle: `Session ${sessionAlias}`,
    workflowId: workflowAlias ? `workflow-${workflowAlias.toLowerCase()}` : '',
    project: `Workspace ${projectAlias}`,
    cwd: `~/workspace-${projectAlias.toLowerCase()}`,
    agent: entry.kind === 'workflow-agent' ? `Agent ${alias(entry.agent)}` : entry.agent,
  }
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function usageExport(
  report: UsageReport,
  format: UsageExportFormat,
  privacy: boolean,
): { body: string; contentType: string; extension: UsageExportFormat } {
  const entries = report.entries.slice(0, MAX_EXPORT_ENTRIES)
    .map((entry) => privacy ? redact(entry) : entry)
  if (format === 'json') {
    return {
      body: JSON.stringify({
        generatedAt: report.generatedAt,
        period: report.period,
        scope: report.scope,
        from: report.from,
        to: report.to,
        privacyApplied: privacy,
        truncated: report.entries.length > MAX_EXPORT_ENTRIES,
        entries,
      }, null, 2),
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
    }
  }

  const header = [
    'kind', 'session_id', 'session_title', 'workflow_id', 'project', 'cwd', 'model', 'agent',
    'started_at', 'updated_at', 'input_tokens', 'input_source', 'output_tokens', 'output_source',
    'total_tokens', 'total_source', 'cost', 'currency', 'cost_source',
  ]
  const rows = entries.map((entry) => [
    entry.kind,
    entry.sessionId,
    entry.sessionTitle,
    entry.workflowId,
    entry.project,
    entry.cwd,
    entry.model,
    entry.agent,
    entry.startedAt,
    entry.updatedAt,
    entry.inputTokens.value,
    entry.inputTokens.source,
    entry.outputTokens.value,
    entry.outputTokens.source,
    entry.totalTokens.value,
    entry.totalTokens.source,
    entry.cost.value,
    entry.cost.currency,
    entry.cost.source,
  ].map(csvCell).join(','))
  return {
    body: [header.join(','), ...rows].join('\n'),
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
  }
}
