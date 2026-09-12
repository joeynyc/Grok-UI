import { ChevronRight, X } from 'lucide-react'
import { useModalFocus } from '../hooks/useModalFocus'
import { NAV_GROUPS, navBadgeCount, type AttentionState } from '../navigation'
import type { ViewId } from '../types'
import packageJson from '../../package.json'
import { NAV_ITEMS } from './nav'
import { BrandLogo } from './screens'

export function Sidebar({
  active,
  connected,
  version,
  open,
  attention,
  onNavigate,
  onClose,
}: {
  active: ViewId
  connected: boolean
  version: string
  open: boolean
  attention: AttentionState
  onNavigate: (id: ViewId) => void
  onClose: () => void
}) {
  const dialogRef = useModalFocus<HTMLElement>(
    onClose,
    '.sidebar-close',
    undefined,
    open,
    false,
  )

  return (
    <>
      <button
        className={`nav-scrim ${open ? 'is-open' : ''}`}
        aria-label="Close navigation"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        className={`sidebar ${open ? 'is-open' : ''}`}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? 'true' : undefined}
        aria-label={open ? 'Navigation menu' : undefined}
        tabIndex={open ? -1 : undefined}
      >
        <div className="brand-lockup">
          <BrandLogo />
          <div>
            <div className="brand-word">GROK</div>
            <div className="brand-sub">Local command</div>
          </div>
          <button className="icon-button sidebar-close" onClick={onClose} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <nav className="primary-nav" id="primary-navigation" aria-label="Primary navigation">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.id}>
              <div className="rail-label">{group.label}</div>
              {group.items.map((id) => {
                const item = NAV_ITEMS.find((entry) => entry.id === id)
                if (!item) return null
                const Icon = item.icon
                const badge = navBadgeCount(item.id, attention)
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${active === item.id ? 'is-active' : ''}`}
                    onClick={() => onNavigate(item.id)}
                  >
                    <span className="nav-index">{item.index}</span>
                    <Icon size={17} strokeWidth={1.7} />
                    <span className="nav-copy">
                      <strong>{item.label}</strong>
                      <small>{item.eyebrow}</small>
                    </span>
                    {badge > 0
                      ? <span className="nav-badge" aria-label={`${badge} need${badge === 1 ? 's' : ''} input`}>{badge}</span>
                      : <ChevronRight className="nav-arrow" size={15} />}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="system-chip">
          <div className="system-chip-head">
            <span className={`status-dot ${connected ? 'is-live' : ''}`} />
            <span>{connected ? 'Grok linked' : 'Data offline'}</span>
          </div>
          <div className="system-chip-meta">
            <span>LOCAL FS</span>
            <span>v{version}</span>
          </div>
        </div>
        <div className="sidebar-foot">
          <span>UI / {packageJson.version}</span>
          <span>Local</span>
        </div>
      </aside>
    </>
  )
}
