import type { ControlSnapshot } from './types'

function latestSessionUpdate(snapshot: ControlSnapshot): string {
  return snapshot.sessions.reduce(
    (latest, session) => session.updatedAt > latest ? session.updatedAt : latest,
    '',
  )
}

function feedItems(snapshot: ControlSnapshot): number {
  return snapshot.sessions.reduce((total, session) => total + session.feed.length, 0)
}

export function reconcileControlSnapshot(
  current: ControlSnapshot | null,
  incoming: ControlSnapshot,
): ControlSnapshot {
  if (!current) return incoming
  if (incoming.generatedAt > current.generatedAt) return incoming
  if (incoming.generatedAt < current.generatedAt) return current

  const currentSessionUpdate = latestSessionUpdate(current)
  const incomingSessionUpdate = latestSessionUpdate(incoming)
  if (incomingSessionUpdate > currentSessionUpdate) return incoming
  if (incomingSessionUpdate < currentSessionUpdate) return current

  return feedItems(incoming) < feedItems(current) ? current : incoming
}
