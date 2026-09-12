import { ChevronRight, Command, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePrivacy } from '../privacy'
import type { DashboardPayload, SessionRow, ViewId } from '../types'
import { NAV_ITEMS } from './nav'
import { EmptyInline } from './primitives'

export function CommandPalette({
  data,
  onClose,
  onNavigate,
  onSession,
}: {
  data: DashboardPayload | null
  onClose: () => void
  onNavigate: (view: ViewId) => void
  onSession: (session: SessionRow) => void
}) {
  const privacy = usePrivacy()
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const normalized = value.toLowerCase()
  const navResults = NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(normalized))
  const sessionResults = (data?.sessions || []).filter((session) =>
    !session.archived
    && [session.title, session.workspace, session.model].some((item) => item.toLowerCase().includes(normalized)),
  ).slice(0, 5)
  const results = [
    ...navResults.map((item) => ({ kind: 'nav' as const, item })),
    ...sessionResults.map((session) => ({ kind: 'session' as const, session })),
  ]

  useEffect(() => {
    setSelected(0)
  }, [value])

  const openResult = (index = selected) => {
    const result = results[index]
    if (!result) return
    if (result.kind === 'nav') onNavigate(result.item.id)
    else onSession(result.session)
  }

  return (
    <div className="palette-layer" role="dialog" aria-modal="true" aria-label="Command palette">
      <button className="palette-scrim" onClick={onClose} aria-label="Close command palette" />
      <div className="command-palette">
        <label>
          <Command size={18} />
          <input
            autoFocus
            value={value}
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-activedescendant={results[selected] ? `palette-result-${selected}` : undefined}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((index) => (index + 1) % Math.max(results.length, 1))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((index) => (index - 1 + results.length) % Math.max(results.length, 1))
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                openResult()
              }
            }}
            placeholder="Jump to a view or local session…"
          />
          <kbd>ESC</kbd>
        </label>
        <div className="palette-results" id="command-palette-results" role="listbox">
          {navResults.length > 0 && <div className="palette-label">Views</div>}
          {navResults.map((item, index) => {
            const Icon = item.icon
            return (
              <button
                id={`palette-result-${index}`}
                key={item.id}
                role="option"
                aria-selected={selected === index}
                className={selected === index ? 'is-selected' : ''}
                onMouseEnter={() => setSelected(index)}
                onClick={() => openResult(index)}
              >
                <Icon size={16} /><span><strong>{item.label}</strong><small>{item.eyebrow}</small></span><kbd>{item.shortcut}</kbd>
              </button>
            )
          })}
          {sessionResults.length > 0 && <div className="palette-label">Recent sessions</div>}
          {sessionResults.map((session, sessionIndex) => {
            const index = navResults.length + sessionIndex
            return (
              <button
                id={`palette-result-${index}`}
                key={session.id}
                role="option"
                aria-selected={selected === index}
                className={selected === index ? 'is-selected' : ''}
                onMouseEnter={() => setSelected(index)}
                onClick={() => openResult(index)}
              >
                <TerminalSquare size={16} />
                <span>
                  <strong>{privacy.sessionTitle(session.title, session.id)}</strong>
                  <small>{privacy.workspace(session.cwd)} · {session.model}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            )
          })}
          {!results.length && <EmptyInline>No matching destination.</EmptyInline>}
        </div>
        <footer><span>↑↓ Navigate</span><span>↵ Open</span><span>Local metadata only</span></footer>
      </div>
    </div>
  )
}
