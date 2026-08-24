import { AlertTriangle, CircleOff, Clock3, LoaderCircle, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FleetHostView } from '../../types'
import {
  elapsedLabel,
  sectionAvailability,
  type FleetSectionId,
} from './model'

export function SectionState({
  host,
  section,
  children,
}: {
  host: FleetHostView
  section: FleetSectionId
  children: ReactNode
}) {
  const availability = sectionAvailability(host, section)
  if (availability === 'available') return children
  if (availability === 'partial') {
    return (
      <>
        <div className="fleet-partial-note" role="status">
          <AlertTriangle size={14} />
          This host reported a partial {section} snapshot. Displayed values may be incomplete.
        </div>
        {children}
      </>
    )
  }
  if (availability === 'stale' && host.snapshot) {
    return (
      <>
        <div className="fleet-partial-note is-stale" role="status">
          <Clock3 size={14} />
          Cached {section} snapshot from {elapsedLabel(host.lastSeen)}. Values are not live.
        </div>
        {children}
      </>
    )
  }
  if (availability === 'connecting') {
    return (
      <div className="fleet-section-state is-connecting">
        <LoaderCircle className="is-spinning" size={25} />
        <strong>Connecting to host</strong>
        <span>This section will appear after the first authenticated snapshot arrives.</span>
      </div>
    )
  }
  const detail = availability === 'stale'
    ? 'The live link is unavailable. This section has no fresh snapshot to display.'
    : availability === 'unauthorized'
      ? 'The host rejected the configured monitor credential.'
      : availability === 'incompatible'
        ? 'This section uses a protocol version the central monitor cannot read.'
        : `The host agent did not advertise the ${section} capability.`
  return (
    <div className={`fleet-section-state is-${availability}`}>
      <CircleOff size={25} />
      <strong>{section[0].toUpperCase() + section.slice(1)} unavailable</strong>
      <span>{detail}</span>
    </div>
  )
}

export function FleetPanelEmpty({
  icon: Icon,
  title,
  copy,
}: {
  icon: LucideIcon
  title: string
  copy: string
}) {
  return (
    <div className="fleet-section-state">
      <Icon size={25} />
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  )
}
