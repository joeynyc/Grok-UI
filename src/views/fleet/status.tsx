import {
  AlertTriangle,
  Braces,
  Check,
  CircleOff,
  Clock3,
  KeyRound,
  LoaderCircle,
  Unplug,
  type LucideIcon,
} from 'lucide-react'
import { usePrivacy } from '../../privacy'
import type { FleetHostStatus, FleetHostView } from '../../types'
import { decimal, elapsedLabel, exactTime } from './model'

const STATUS_META: Record<FleetHostStatus, {
  label: string
  detail: string
  icon: LucideIcon
}> = {
  connecting: {
    label: 'Connecting',
    detail: 'Establishing the authenticated monitor link.',
    icon: LoaderCircle,
  },
  healthy: {
    label: 'Healthy',
    detail: 'Fresh telemetry is arriving inside the expected latency window.',
    icon: Check,
  },
  degraded: {
    label: 'Degraded',
    detail: 'The host is reachable, but some telemetry is delayed or incomplete.',
    icon: AlertTriangle,
  },
  stale: {
    label: 'Stale',
    detail: 'Showing the last known snapshot while the monitor link catches up.',
    icon: Clock3,
  },
  offline: {
    label: 'Offline',
    detail: 'The host is not reachable. Cached data is labeled as historical.',
    icon: Unplug,
  },
  incompatible: {
    label: 'Incompatible',
    detail: 'The host responded with an unsupported protocol version.',
    icon: Braces,
  },
  unauthorized: {
    label: 'Unauthorized',
    detail: 'The host responded, but rejected the configured credential.',
    icon: KeyRound,
  },
  unavailable: {
    label: 'Unavailable',
    detail: 'Monitoring data is not available from this host.',
    icon: CircleOff,
  },
}

export function FleetStatusBadge({
  status,
  compact = false,
}: {
  status: FleetHostStatus
  compact?: boolean
}) {
  const meta = STATUS_META[status] || STATUS_META.unavailable
  const Icon = meta.icon
  return (
    <span className={`fleet-status status-${status} ${compact ? 'is-compact' : ''}`} role="status">
      <Icon className={status === 'connecting' ? 'is-spinning' : ''} size={compact ? 12 : 13} />
      <span>{meta.label}</span>
    </span>
  )
}

export function HostStatusNarrative({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const meta = STATUS_META[host.status] || STATUS_META.unavailable
  const detail = privacy.enabled ? meta.detail : host.statusDetail || meta.detail
  return (
    <div className={`fleet-status-narrative status-${host.status}`} role="status" aria-live="polite">
      <div>
        <strong>{meta.label}</strong>
        <span>{detail}</span>
      </div>
      <div>
        <span>Last seen</span>
        <strong title={exactTime(host.lastSeen)}>{elapsedLabel(host.lastSeen)}</strong>
      </div>
      <div>
        <span>Latency</span>
        <strong>{host.latencyMs === null ? '—' : `${decimal.format(host.latencyMs)} ms`}</strong>
      </div>
      <div>
        <span>Freshness</span>
        <strong>{host.freshness}</strong>
      </div>
    </div>
  )
}
