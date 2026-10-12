import type { ActivityDay, SessionRow } from './types.js'

/** Local calendar key `YYYY-MM-DD`. Avoids UTC `toISOString().slice(0, 10)`. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function localDateKeyFromStamp(input: string): string {
  const date = new Date(input)
  return Number.isNaN(date.getTime()) ? '1970-01-01' : localDateKey(date)
}

/**
 * 14 local-calendar days ending today. Each session's lifetime totals land on
 * the day it was last updated — Grok does not expose per-day work.
 */
export function buildActivity(sessions: SessionRow[], days = 14, now = new Date()): ActivityDay[] {
  const byDate = new Map<string, ActivityDay>()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - index)
    const key = localDateKey(date)
    byDate.set(key, {
      date: key,
      label: date.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2),
      sessions: 0,
      turns: 0,
      toolCalls: 0,
      errors: 0,
      linesChanged: 0,
    })
  }
  for (const session of sessions) {
    const day = byDate.get(localDateKeyFromStamp(session.updatedAt))
    if (!day) continue
    day.sessions += 1
    day.turns += session.turns
    day.toolCalls += session.toolCalls
    day.errors += session.errors
    day.linesChanged += session.linesAdded + session.linesRemoved
  }
  return [...byDate.values()]
}
