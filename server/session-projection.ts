import path from 'node:path'
import type { ControlSession, LiveAgent, SessionRow } from './types.js'

function elapsedSeconds(startedAt: string, now: number): number {
  const started = new Date(startedAt).getTime()
  return Number.isFinite(started) ? Math.max(0, (now - started) / 1_000) : 0
}

export function controlSessionRow(
  session: ControlSession,
  now = Date.now(),
): SessionRow {
  return {
    id: session.id,
    title: session.title,
    summary: '',
    cwd: session.cwd,
    workspace: path.basename(session.cwd) || session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model || 'Grok default',
    agent: 'Grok UI',
    reasoningEffort: 'default',
    sandboxProfile: 'native permissions',
    messages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    chatMessages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    turns: session.feed.filter((item) => item.type === 'user').length,
    toolCalls: session.feed.filter((item) => item.type === 'tool').length,
    errors: session.state === 'failed' ? 1 : 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: elapsedSeconds(session.createdAt, now),
    contextUsage: 0,
    status: session.state === 'attention'
      ? 'attention'
      : session.state === 'working' || session.state === 'starting' ? 'live' : 'recent',
    diskBytes: 0,
    archived: false,
  }
}

export function liveAgentRow(
  session: LiveAgent,
  now = Date.now(),
): SessionRow {
  return {
    id: session.id,
    title: session.title,
    summary: '',
    cwd: session.cwd,
    workspace: session.workspace,
    createdAt: session.openedAt,
    updatedAt: session.updatedAt,
    model: session.model,
    agent: 'Grok CLI',
    reasoningEffort: 'default',
    sandboxProfile: 'CLI process',
    messages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    chatMessages: session.feed.filter((item) => item.type === 'user' || item.type === 'assistant').length,
    turns: session.turns,
    toolCalls: session.toolCalls,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: elapsedSeconds(session.openedAt, now),
    contextUsage: session.contextUsage,
    status: session.state === 'attention'
      ? 'attention'
      : session.state === 'working' || session.state === 'waiting' ? 'live' : 'recent',
    diskBytes: 0,
    archived: false,
  }
}
