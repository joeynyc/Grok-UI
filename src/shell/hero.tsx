import { createContext, useContext } from 'react'

// Room heroes come in two densities. Full is the editorial header with the
// large title and description; compact folds it to one line so the roster,
// tables, and diffs start near the top. The choice is a device preference,
// like the theme, and every hero carries a toggle for it.

export type HeroDensity = 'full' | 'compact'

export const HERO_STORAGE_KEY = 'grok-ui-hero'

export function storedHeroDensity(): HeroDensity {
  try {
    return localStorage.getItem(HERO_STORAGE_KEY) === 'compact' ? 'compact' : 'full'
  } catch {
    return 'full'
  }
}

interface HeroDensityValue {
  density: HeroDensity
  setDensity: (density: HeroDensity) => void
}

const HeroDensityContext = createContext<HeroDensityValue>({
  density: 'full',
  setDensity: () => {},
})

export function HeroDensityProvider({
  density,
  onChange,
  children,
}: {
  density: HeroDensity
  onChange: (density: HeroDensity) => void
  children: React.ReactNode
}) {
  return (
    <HeroDensityContext.Provider value={{ density, setDensity: onChange }}>
      {children}
    </HeroDensityContext.Provider>
  )
}

export function useHeroDensity(): HeroDensityValue & { toggle: () => void } {
  const value = useContext(HeroDensityContext)
  return {
    ...value,
    toggle: () => value.setDensity(value.density === 'compact' ? 'full' : 'compact'),
  }
}
