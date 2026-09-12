import {
  Activity,
  Blocks,
  BrainCircuit,
  Command,
  Gauge,
  GitCompareArrows,
  Layers3,
  Network,
  Palette,
  Radio,
  WalletCards,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { ViewId } from '../types'

export interface NavItem {
  id: ViewId
  index: string
  label: string
  eyebrow: string
  icon: LucideIcon
  shortcut: string
}

// Indices follow rail display order (01 to 07), then the off-rail rooms.
// Each room hero carries the same number; keep them in sync.
export const NAV_ITEMS: NavItem[] = [
  { id: 'live', index: '01', label: 'Live', eyebrow: 'Runtime', icon: Radio, shortcut: '1' },
  { id: 'control', index: '08', label: 'Control', eyebrow: 'Operate', icon: Command, shortcut: '8' },
  { id: 'runs', index: '02', label: 'Runs', eyebrow: 'Orchestrate', icon: Workflow, shortcut: '2' },
  { id: 'changes', index: '03', label: 'Changes', eyebrow: 'Inspect', icon: GitCompareArrows, shortcut: '3' },
  { id: 'overview', index: '05', label: 'Overview', eyebrow: 'Command', icon: Gauge, shortcut: '5' },
  { id: 'sessions', index: '04', label: 'Sessions', eyebrow: 'Archive', icon: Layers3, shortcut: '4' },
  { id: 'activity', index: '09', label: 'Activity', eyebrow: 'Signals', icon: Activity, shortcut: '9' },
  { id: 'usage', index: '06', label: 'Usage', eyebrow: 'Ledger', icon: WalletCards, shortcut: '6' },
  { id: 'fleet', index: '07', label: 'Fleet', eyebrow: 'Monitor', icon: Network, shortcut: '7' },
  { id: 'library', index: '10', label: 'Library', eyebrow: 'Capability', icon: Blocks, shortcut: 'l' },
  { id: 'memory', index: '11', label: 'Memory', eyebrow: 'Recall', icon: BrainCircuit, shortcut: 'm' },
  { id: 'themes', index: '12', label: 'Themes', eyebrow: 'Appearance', icon: Palette, shortcut: 't' },
]

export const MOBILE_NAV_IDS: ViewId[] = ['live', 'runs', 'sessions', 'fleet']

export function navItem(id: ViewId): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.id === id)
}
