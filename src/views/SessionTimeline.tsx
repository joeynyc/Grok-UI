import { ArrowDown, ChevronRight, Radio, ShieldAlert } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { clockTime } from '../format'
import { Markdown, renderInline } from '../markdown'
import { usePrivacy } from '../privacy'
import type { ControlPermission, LiveFeedItem } from '../types'

/**
 * Messages longer than this start collapsed so a pasted wall of text does not
 * bury the conversation. Grok's own replies get more room because they are
 * what the reader came for.
 */
const COLLAPSE = {
  user: { chars: 900, lines: 12 },
  assistant: { chars: 3_500, lines: 45 },
} as const

function isLong(text: string, type: LiveFeedItem['type']): boolean {
  const limit = type === 'assistant' || type === 'plan' ? COLLAPSE.assistant : COLLAPSE.user
  return text.length > limit.chars || text.split('\n').length > limit.lines
}

export function SessionTimeline({
  items,
  permissions,
  onDecide,
}: {
  items: LiveFeedItem[]
  permissions: ControlPermission[]
  onDecide: (permissionId: string, optionId?: string) => Promise<void>
}) {
  const privacy = usePrivacy()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const feedRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const toggle = (id: string) => setExpanded((current) => ({ ...current, [id]: !current[id] }))
  const scrollToLatest = useCallback(() => {
    const element = feedRef.current
    if (!element) return
    following.current = true
    element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
    setAtBottom(true)
  }, [])
  const onScroll = () => {
    const element = feedRef.current
    if (!element) return
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    setAtBottom(following.current)
  }

  useLayoutEffect(() => {
    if (following.current) scrollToLatest()
  }, [items, permissions, expanded, scrollToLatest])

  useLayoutEffect(() => {
    const element = feedRef.current
    if (!element) return
    // Markdown and streamed text can change height without adding an event.
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToLatest()
    })
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [items, permissions, scrollToLatest])
  return (
    <div className="workbench-timeline" ref={feedRef} onScroll={onScroll}>
      {permissions.map((permission) => (
        <article className="workbench-permission" key={permission.id}>
          <div><ShieldAlert size={18} /><span><small>PERMISSION REQUIRED</small><strong>{privacy.content(permission.title)}</strong></span></div>
          <div>
            {permission.options.map((option) => (
              <button
                key={option.id}
                className={option.kind.includes('reject') ? 'is-reject' : ''}
                onClick={() => void onDecide(permission.id, option.id)}
              >
                {option.name}
              </button>
            ))}
            <button className="is-reject" onClick={() => void onDecide(permission.id)}>Cancel turn</button>
          </div>
        </article>
      ))}
      {items.length ? items.map((item, index) => (
        <article className={`workbench-event event-${item.type}`} key={item.id}>
          <div className="workbench-event-rail">
            <span>{String(index + 1).padStart(3, '0')}</span>
            <i />
          </div>
          <div className="workbench-event-content">
            <header>
              <span>{item.type === 'assistant' ? 'GROK' : item.type.toUpperCase()}</span>
              <strong title={privacy.content(item.title)}>{renderInline(privacy.content(item.title))}</strong>
              {item.status && <em>{item.status}</em>}
              <time>{clockTime(item.timestamp)}</time>
            </header>
            {item.text && (
              <EventBody
                item={item}
                text={privacy.content(item.text)}
                expanded={Boolean(expanded[item.id])}
                pinned={index === items.length - 1}
                onToggle={() => toggle(item.id)}
              />
            )}
          </div>
        </article>
      )) : (
        <div className="workbench-empty">
          <div><Radio size={23} /><span /></div>
          <strong>No structured events recorded yet.</strong>
          <p>Send a follow-up below. New messages, reasoning, and tool calls will stream here.</p>
        </div>
      )}
      {!atBottom && (
        <button className="jump-latest" onClick={scrollToLatest}>
          <ArrowDown size={14} /> Latest
        </button>
      )}
    </div>
  )
}

function EventBody({
  item,
  text,
  expanded,
  pinned = false,
  onToggle,
}: {
  item: LiveFeedItem
  text: string
  expanded: boolean
  /** The newest event always shows in full; it is what the reader came to see. */
  pinned?: boolean
  onToggle: () => void
}) {
  const long = isLong(text, item.type) && !pinned
  const collapsed = long && !expanded
  const lineCount = text.split('\n').length
  const body = item.type === 'assistant' || item.type === 'plan'
    ? <Markdown className="workbench-event-body" text={text} />
    : <p className="workbench-event-body">{text}</p>
  return (
    <div className={`workbench-event-text ${collapsed ? 'is-collapsed' : ''}`}>
      {body}
      {long && (
        <button type="button" className="event-collapse" onClick={onToggle} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={13} /> : <ArrowDown size={13} className="is-flipped" />}
          {collapsed ? `Show all ${lineCount} lines` : 'Collapse'}
        </button>
      )}
    </div>
  )
}

