import { describe, expect, it } from 'vitest'
import {
  clockTime,
  compactNumber,
  elapsed,
  formatBytes,
  formatNumber,
  shortDate,
  timeAgo,
} from './format'

const NOW = Date.parse('2026-09-12T15:00:00Z')
const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString()

describe('formatNumber', () => {
  it('keeps full digits below ten thousand and compacts above', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(9_876)).toBe('9,876')
    expect(formatNumber(10_000)).toBe('10K')
    expect(formatNumber(1_234_567)).toBe('1.2M')
  })
})

describe('compactNumber', () => {
  it('always compacts', () => {
    expect(compactNumber(950)).toBe('950')
    expect(compactNumber(1_200)).toBe('1.2K')
  })
})

describe('formatBytes', () => {
  it('picks the unit and rounds like the dashboard always has', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(12 * 1024)).toBe('12 KB')
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(formatBytes(2 ** 50)).toBe('1024.0 TB')
  })
})

describe('timeAgo', () => {
  it('steps through minutes, hours, and days', () => {
    expect(timeAgo(at(10_000), NOW)).toBe('just now')
    expect(timeAgo(at(5 * 60_000), NOW)).toBe('5m ago')
    expect(timeAgo(at(3 * 3_600_000), NOW)).toBe('3h ago')
    expect(timeAgo(at(2 * 86_400_000), NOW)).toBe('2d ago')
  })

  it('falls back to a short date after a week', () => {
    expect(timeAgo(at(9 * 86_400_000), NOW)).toBe('Sep 3')
  })

  it('never reports the future as ago', () => {
    expect(timeAgo(at(-60_000), NOW)).toBe('just now')
  })

  it('shows an em dash for missing or invalid stamps', () => {
    expect(timeAgo('', NOW)).toBe('—')
    expect(timeAgo('not a date', NOW)).toBe('—')
  })
})

describe('elapsed', () => {
  it('uses the terse instrument form', () => {
    expect(elapsed(at(1_000), NOW)).toBe('now')
    expect(elapsed(at(14 * 60_000), NOW)).toBe('14m')
    expect(elapsed(at(6 * 3_600_000), NOW)).toBe('6h')
    expect(elapsed(at(40 * 86_400_000), NOW)).toBe('40d')
    expect(elapsed('', NOW)).toBe('—')
    expect(elapsed('garbage', NOW)).toBe('—')
  })
})

describe('clockTime', () => {
  it('formats hours and minutes, optionally seconds, and guards bad input', () => {
    const stamp = '2026-09-12T09:41:07'
    expect(clockTime(stamp)).toBe(new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    expect(clockTime(stamp, true)).toBe(new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    expect(clockTime('')).toBe('—')
    expect(clockTime('nope')).toBe('—')
  })
})

describe('shortDate', () => {
  it('drops the year inside the current year and keeps it otherwise', () => {
    const now = new Date('2026-09-12T15:00:00')
    expect(shortDate('2026-03-04T12:00:00', now)).toBe('Mar 4')
    expect(shortDate('2025-03-04T12:00:00', now)).toBe('Mar 4, 2025')
    expect(shortDate('', now)).toBe('—')
  })
})
