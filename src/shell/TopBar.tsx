import { Menu, Palette, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { timeAgo } from '../format'
import type { ViewId } from '../types'
import { navItem } from './nav'

export function TopBar({
  active,
  connected,
  generatedAt,
  refreshing,
  privacyMode,
  onMenu,
  onPalette,
  onRefresh,
  onOpenThemes,
  onTogglePrivacy,
}: {
  active: ViewId
  connected: boolean
  generatedAt?: string
  refreshing: boolean
  privacyMode: boolean
  onMenu: () => void
  onPalette: () => void
  onRefresh: () => void
  onOpenThemes: () => void
  onTogglePrivacy: () => void
}) {
  const activeItem = navItem(active)!
  return (
    <header className="topbar">
      <div className="topbar-title">
        <button className="icon-button mobile-menu" onClick={onMenu} aria-label="Open navigation">
          <Menu size={19} />
        </button>
        <span className="topbar-path">GROK /</span>
        <strong>{activeItem.label}</strong>
      </div>
      <div className="topbar-actions">
        <div className="sync-state">
          <span className={`status-dot ${connected ? 'is-live' : ''}`} />
          <span className="sync-copy">{connected ? 'Live updates' : 'Reconnecting'}</span>
          <span className="sync-time">{generatedAt ? timeAgo(generatedAt) : '—'}</span>
        </div>
        <button
          className={`privacy-toggle ${privacyMode ? 'is-active' : ''}`}
          type="button"
          aria-pressed={privacyMode}
          onClick={onTogglePrivacy}
          title={privacyMode ? 'Turn Privacy Mode off' : 'Hide local names, paths, and content'}
        >
          <ShieldCheck size={15} />
          <span>{privacyMode ? 'Privacy on' : 'Privacy'}</span>
        </button>
        <button
          className={`privacy-toggle ${active === 'themes' ? 'is-active' : ''}`}
          type="button"
          aria-pressed={active === 'themes'}
          onClick={onOpenThemes}
        >
          <Palette size={15} />
          <span>Themes</span>
        </button>
        <button className="command-trigger" onClick={onPalette}>
          <Search size={15} />
          <span>Jump anywhere</span>
          <kbd>⌘ K</kbd>
        </button>
        <button className="icon-button" onClick={onRefresh} aria-label="Refresh data">
          <RefreshCw className={refreshing ? 'is-spinning' : ''} size={17} />
        </button>
      </div>
    </header>
  )
}
