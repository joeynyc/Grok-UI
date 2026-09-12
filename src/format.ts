// Shared number and time formatting for the dashboard. Every room that shows
// a count, a byte size, or a relative timestamp goes through these helpers so
// the same value reads the same way in every surface.

const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const integerFormat = new Intl.NumberFormat('en-US')

/** `1.2K`, `34M`: always compact, used where space is tight. */
export function compactNumber(value: number): string {
  return compactFormat.format(value)
}

/** Full digits below 10,000 (`9,876`), compact above (`12.3K`). */
export function formatNumber(value: number): string {
  return value >= 10_000 ? compactFormat.format(value) : integerFormat.format(value)
}

/** `0 B`, `512 B`, `12 KB`, `3.4 MB`. Non-finite and non-positive input reads as `0 B`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`
}

function parseStamp(value: string): number | null {
  if (!value) return null
  const stamp = new Date(value).getTime()
  return Number.isNaN(stamp) ? null : stamp
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`, then a short date. Invalid input reads as `—`. */
export function timeAgo(input: string, now = Date.now()): string {
  const stamp = parseStamp(input)
  if (stamp === null) return '—'
  const delta = Math.max(0, now - stamp)
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`
  return new Date(stamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Terse instrument form: `now`, `5m`, `3h`, `2d`. Invalid input reads as `—`. */
export function elapsed(input: string, now = Date.now()): string {
  const stamp = parseStamp(input)
  if (stamp === null) return '—'
  const delta = Math.max(0, now - stamp)
  if (delta < 60_000) return 'now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  return `${Math.floor(delta / 86_400_000)}d`
}

/** Wall-clock time in the viewer's locale, `09:41`. Invalid input reads as `—`. */
export function clockTime(input: string, seconds = false): string {
  const stamp = parseStamp(input)
  if (stamp === null) return '—'
  return new Date(stamp).toLocaleTimeString([], seconds
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' })
}

/** `Sep 12` this year, `Sep 12, 2025` otherwise. Invalid input reads as `—`. */
export function shortDate(input: string, now = new Date()): string {
  const stamp = parseStamp(input)
  if (stamp === null) return '—'
  const date = new Date(stamp)
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}
