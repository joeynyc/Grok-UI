import { ArrowRight, Check } from 'lucide-react'
import { PageIntro } from '../shell/primitives'
import { THEMES, type ThemeId } from '../shell/themes'

export function ThemesView({
  active,
  onSelect,
}: {
  active: ThemeId
  onSelect: (theme: ThemeId) => void
}) {
  return (
    <>
      <PageIntro
        index="12"
        eyebrow="Visual systems"
        title={<>Choose your<br /><em>command atmosphere.</em></>}
        description="Switch the entire dashboard aesthetic without changing your data, sessions, or workflow. Your selection stays active on this device."
      />

      <section className="theme-grid section-gap" aria-label="Available themes">
        {THEMES.map((theme, index) => {
          const selected = theme.id === active
          return (
            <button
              className={`theme-card theme-card-${theme.id} ${selected ? 'is-selected' : ''}`}
              key={theme.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(theme.id)}
            >
              <span className="theme-preview" aria-hidden="true">
                <span className="theme-preview-rail" />
                <span className="theme-preview-stage">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="theme-card-copy">
                <span className="theme-card-index">
                  {String(index + 1).padStart(2, '0')} / {String(THEMES.length).padStart(2, '0')}
                </span>
                <span className="theme-card-eyebrow">{theme.eyebrow}</span>
                <strong>{theme.name}</strong>
                <small>{theme.description}</small>
              </span>
              <span className="theme-select-state">
                {selected ? <><Check size={14} /> Active theme</> : <>Apply theme <ArrowRight size={14} /></>}
              </span>
            </button>
          )
        })}
      </section>

      <section className="theme-note">
        <span>LOCAL PREFERENCE</span>
        <p>Themes are presentation-only and are stored in your browser. Grok session data never leaves the local dashboard.</p>
      </section>
    </>
  )
}
