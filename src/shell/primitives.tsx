import { Search, X, type LucideIcon } from 'lucide-react'
import type { SessionRow } from '../types'

/** Room hero: index badge, kicker, title, and one-line description. */
export function PageIntro({
  index,
  eyebrow,
  title,
  description,
}: {
  index: string
  eyebrow: string
  title: React.ReactNode
  description: string
}) {
  return (
    <header className="page-intro">
      <div className="intro-index">{index}</div>
      <div>
        <div className="kicker">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      <p>{description}</p>
      <div className="intro-rule"><span /></div>
    </header>
  )
}

export function Panel({
  index,
  title,
  meta,
  action,
  className = '',
  children,
}: {
  index: string
  title: string
  meta?: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <div>
          <span className="panel-index">{index}</span>
          <h2>{title}</h2>
        </div>
        <div className="panel-meta">
          {meta && <span>{meta}</span>}
          {action}
        </div>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="search-field">
      <Search size={17} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {value && <button onClick={() => onChange('')} aria-label="Clear search"><X size={15} /></button>}
      <kbd>/</kbd>
    </label>
  )
}

export function StatusGlyph({ status }: { status: SessionRow['status'] }) {
  return (
    <span className={`status-glyph status-${status}`} aria-label={status}>
      <span />
    </span>
  )
}

export function EmptyInline({ children }: { children: React.ReactNode }) {
  return <div className="empty-inline">{children}</div>
}

export function EmptyBlock({ icon: Icon, title, copy }: { icon: LucideIcon; title: string; copy: string }) {
  return <div className="empty-block"><Icon size={28} /><strong>{title}</strong><p>{copy}</p></div>
}
