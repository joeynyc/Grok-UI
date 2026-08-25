import type { LiveFeedItem, SessionRow } from './types.js'

export function transcriptMarkdown(session: SessionRow, items: LiveFeedItem[]): string {
  const lines = [
    `# ${session.title || session.id}`,
    '',
    `- Session: \`${session.id}\``,
    `- Workspace: \`${session.cwd}\``,
    `- Model: ${session.model || 'default'}`,
    `- Updated: ${session.updatedAt || 'unknown'}`,
    '',
  ]
  for (const item of items) {
    const heading = item.type === 'assistant' ? 'Grok' : item.type
    lines.push(`## ${heading}${item.title && item.title !== heading ? ` — ${item.title}` : ''}`)
    if (item.status) lines.push(`Status: ${item.status}`)
    if (item.timestamp) lines.push(`Time: ${item.timestamp}`)
    if (item.text) {
      lines.push('')
      lines.push(item.text)
    }
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}
