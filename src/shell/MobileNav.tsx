import { ArrowRight, Menu } from 'lucide-react'
import { navBadgeCount, type AttentionState } from '../navigation'
import type { ViewId } from '../types'
import { MOBILE_NAV_IDS, NAV_ITEMS } from './nav'

export function MobileNav({
  active,
  attention,
  onNavigate,
  onMore,
  suspended,
}: {
  active: ViewId
  attention: AttentionState
  onNavigate: (view: ViewId) => void
  onMore: () => void
  suspended: boolean
}) {
  const primaryItems = NAV_ITEMS.filter((item) => MOBILE_NAV_IDS.includes(item.id))
  const moreActive = !MOBILE_NAV_IDS.includes(active)
  return (
    <nav
      className={`mobile-bottom-nav ${suspended ? 'is-suspended' : ''}`}
      aria-label="Mobile navigation"
      aria-hidden={suspended}
      inert={suspended}
    >
      {primaryItems.map((item) => {
        const Icon = item.icon
        const badge = navBadgeCount(item.id, attention)
        return (
          <button key={item.id} className={active === item.id ? 'is-active' : ''} onClick={() => onNavigate(item.id)}>
            <span className="mobile-nav-icon">
              <Icon size={18} />
              {badge > 0 && <i className="nav-badge-dot" aria-hidden="true" />}
            </span>
            <span>{item.label}</span>
          </button>
        )
      })}
      <button
        className={moreActive ? 'is-active' : ''}
        onClick={onMore}
        aria-controls="primary-navigation"
        aria-expanded={suspended}
      >
        <Menu size={18} />
        <span>More</span>
      </button>
    </nav>
  )
}

export function NeedsYouBar({
  attention,
  privacyMode,
  onOpen,
}: {
  attention: AttentionState
  privacyMode: boolean
  onOpen: () => void
}) {
  if (!attention.primary) return null
  const count = attention.permissionCount + attention.liveCount
  const title = privacyMode
    ? `${count} session${count === 1 ? '' : 's'} waiting for attention.`
    : attention.primary.title
  return (
    <button className="needs-you-bar" type="button" onClick={onOpen}>
      <span className="needs-you-pulse" aria-hidden="true" />
      <span>
        <small>Needs you</small>
        <strong>{title}</strong>
      </span>
      <em>{attention.primary.kind === 'permission' ? 'Review approval' : 'Open session'} <ArrowRight size={14} /></em>
    </button>
  )
}
