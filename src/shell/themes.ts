export type ThemeId = 'operator' | 'event-horizon' | 'minimal-calm'

export const DEFAULT_THEME: ThemeId = 'event-horizon'

export const THEME_COLORS: Record<ThemeId, string> = {
  operator: '#090a08',
  'event-horizon': '#03050a',
  'minimal-calm': '#f7f7f4',
}

export const THEMES: Array<{
  id: ThemeId
  name: string
  eyebrow: string
  description: string
}> = [
  {
    id: 'operator',
    name: 'Operator',
    eyebrow: 'Original system',
    description: 'Carbon black, signal lime, and the precision grid that launched Grok UI.',
  },
  {
    id: 'event-horizon',
    name: 'Event Horizon',
    eyebrow: 'Deep-space system',
    description: 'A cinematic red singularity, cold starlight, and glassy command surfaces.',
  },
  {
    id: 'minimal-calm',
    name: 'Minimal Calm',
    eyebrow: 'Quiet control room',
    description: 'Stone surfaces, sage signals, and restrained motion for focused sessions.',
  },
]

// Presentation preferences live in localStorage. Every reader tolerates a
// missing or blocked storage so the dashboard still renders in private tabs.

export function storedTheme(): ThemeId {
  try {
    const stored = localStorage.getItem('grok-ui-theme')
    return THEMES.some((theme) => theme.id === stored) ? stored as ThemeId : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function storedPrivacy(): boolean {
  try {
    return localStorage.getItem('grok-ui-privacy') === 'on'
  } catch {
    return false
  }
}
