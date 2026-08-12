import { describe, expect, it } from 'vitest'
import { formatRelativeStamp } from './time'

// A fixed "now" so the fallback-to-date cases can't drift across a year
// boundary mid-suite. Every case below is expressed relative to it.
//
// Built from local components, not a `Z` string: the fallback formats through
// `toLocaleDateString`, so a UTC instant near midnight would name a different
// day depending on the runner's timezone. Midday local is the same date
// everywhere.
const NOW = new Date(2026, 7, 12, 12, 0, 0)

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelativeStamp', () => {
  it('calls anything under a minute "just now"', () => {
    expect(formatRelativeStamp(ago(0), NOW)).toBe('just now')
    expect(formatRelativeStamp(ago(59_000), NOW)).toBe('just now')
  })

  it('counts minutes, then hours, then days', () => {
    expect(formatRelativeStamp(ago(16 * MINUTE), NOW)).toBe('16 minutes ago')
    expect(formatRelativeStamp(ago(18 * HOUR), NOW)).toBe('18 hours ago')
    expect(formatRelativeStamp(ago(4 * DAY), NOW)).toBe('4 days ago')
  })

  it('does not pluralise a count of one', () => {
    expect(formatRelativeStamp(ago(MINUTE), NOW)).toBe('1 minute ago')
    expect(formatRelativeStamp(ago(HOUR), NOW)).toBe('1 hour ago')
    expect(formatRelativeStamp(ago(DAY), NOW)).toBe('1 day ago')
  })

  it('switches to a calendar date past a week', () => {
    // "37 days ago" is a date with extra steps.
    expect(formatRelativeStamp(ago(9 * DAY), NOW)).toBe('Aug 3')
    expect(formatRelativeStamp(ago(30 * DAY), NOW)).toBe('Jul 13')
  })

  it('adds the year only once it stops being this one', () => {
    const lastJuly = new Date(2025, 6, 29, 12, 0, 0).toISOString()
    expect(formatRelativeStamp(lastJuly, NOW)).toBe('Jul 29, 2025')
  })

  it('reads a slightly skewed clock as "just now" rather than a negative count', () => {
    expect(formatRelativeStamp(new Date(NOW.getTime() + 30_000).toISOString(), NOW)).toBe('just now')
  })

  it('gives an unparseable stamp nothing to render', () => {
    expect(formatRelativeStamp('not-a-date', NOW)).toBe('')
  })
})
