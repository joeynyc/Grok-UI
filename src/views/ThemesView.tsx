import { ArrowRight, Check } from 'lucide-react'
import type { HeroDensity } from '../shell/hero'
import { PageIntro } from '../shell/primitives'
import { THEMES, type ThemeId } from '../shell/themes'

const HERO_DENSITIES: Array<{ id: HeroDensity; name: string; description: string }> = [
  { id: 'full', name: 'Full', description: 'Large title and description at the top of each room.' },
  { id: 'compact', name: 'Compact', description: 'One line per room so tables, rosters, and diffs start higher.' },
]

export function ThemesView({
  active,
  onSelect,
  heroDensity,
  onHeroDensity,
}: {
  active: ThemeId
  onSelect: (theme: ThemeId) => void
  heroDensity: HeroDensity
  onHeroDensity: (density: HeroDensity) => void
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

      <section className="preference-row section-gap" aria-labelledby="hero-density-heading">
        <div>
          <span className="kicker">Room headers</span>
          <h2 id="hero-density-heading">How much header<br /><em>each room shows.</em></h2>
          <p>Every room header carries the same toggle. This choice is stored on this device.</p>
        </div>
        <div className="preference-options" role="group" aria-label="Room header density">
          {HERO_DENSITIES.map((option) => {
            const selected = option.id === heroDensity
            return (
              <button
                key={option.id}
                type="button"
                className={`preference-option ${selected ? 'is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => onHeroDensity(option.id)}
              >
                <span className={`preference-preview preference-preview-${option.id}`} aria-hidden="true">
                  <i /><i /><i />
                </span>
                <strong>{option.name}</strong>
                <small>{option.description}</small>
                {selected && <span className="preference-state"><Check size={13} /> Active</span>}
              </button>
            )
          })}
        </div>
      </section>

      <section className="theme-note">
        <span>LOCAL PREFERENCE</span>
        <p>Themes and header density are presentation-only and are stored in your browser. Grok session data never leaves the local dashboard.</p>
      </section>
    </>
  )
}
