import type { SessionPlan, SessionPlanEntry, SessionTodo } from './types.js'

export function emptyPlan(): SessionPlan {
  return {
    status: 'none',
    title: '',
    markdown: '',
    entries: [],
    updatedAt: '',
  }
}

export function applyPlanUpdate(previous: SessionPlan | null, update: unknown): SessionPlan {
  const current = previous || emptyPlan()
  if (!update || typeof update !== 'object') return current
  const payload = update as Record<string, unknown>
  const kind = typeof payload.sessionUpdate === 'string' ? payload.sessionUpdate : ''
  if (kind === 'plan_removed') return { ...emptyPlan(), updatedAt: new Date().toISOString() }

  const entries = extractEntries(payload)
  const markdown = extractMarkdown(payload)
  const title = extractTitle(payload, entries)
  const next: SessionPlan = {
    status: reviewStatus(entries, markdown, kind),
    title,
    markdown,
    entries,
    updatedAt: new Date().toISOString(),
  }
  return next.entries.length || next.markdown ? next : { ...current, updatedAt: next.updatedAt }
}

export function todosFromPlan(plan: SessionPlan | null): SessionTodo[] {
  if (!plan) return []
  return plan.entries.map((entry, index) => ({
    id: entry.id || `todo-${index + 1}`,
    content: entry.content,
    status: todoStatus(entry.status),
  }))
}

function extractEntries(payload: Record<string, unknown>): SessionPlanEntry[] {
  const candidates = [
    payload.entries,
    isRecord(payload.plan) ? payload.plan.entries : null,
    isRecord(payload.plan) && isRecord(payload.plan.plan) ? payload.plan.plan.entries : null,
  ]
  for (const list of candidates) {
    if (!Array.isArray(list)) continue
    return list.flatMap((item, index) => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Record<string, unknown>
      const content = typeof entry.content === 'string' ? entry.content.trim() : ''
      if (!content) return []
      return [{
        id: typeof entry.id === 'string' && entry.id ? entry.id : `step-${index + 1}`,
        content: content.slice(0, 2_000),
        status: typeof entry.status === 'string' ? entry.status : 'pending',
        priority: typeof entry.priority === 'string' ? entry.priority : 'medium',
      }]
    })
  }
  return []
}

function extractMarkdown(payload: Record<string, unknown>): string {
  const plan = isRecord(payload.plan) ? payload.plan : payload
  if (plan.type === 'markdown' && typeof plan.content === 'string') return plan.content.slice(0, 20_000)
  if (typeof payload.content === 'string' && payload.sessionUpdate === 'plan_update') {
    return payload.content.slice(0, 20_000)
  }
  return ''
}

function extractTitle(payload: Record<string, unknown>, entries: SessionPlanEntry[]): string {
  if (typeof payload.title === 'string' && payload.title.trim()) return payload.title.trim().slice(0, 160)
  const plan = isRecord(payload.plan) ? payload.plan : null
  if (plan && typeof plan.title === 'string' && plan.title.trim()) return plan.title.trim().slice(0, 160)
  return entries[0]?.content.slice(0, 96) || 'Plan'
}

function reviewStatus(
  entries: SessionPlanEntry[],
  markdown: string,
  kind: string,
): SessionPlan['status'] {
  if (!entries.length && !markdown) return 'none'
  if (entries.some((entry) => entry.status === 'in_progress')) return 'planning'
  if (entries.length && entries.every((entry) => entry.status === 'completed')) return 'approved'
  if (kind === 'plan' || entries.every((entry) => entry.status === 'pending')) return 'review'
  return 'planning'
}

function todoStatus(status: string): SessionTodo['status'] {
  if (status === 'in_progress') return 'in_progress'
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return 'pending'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
