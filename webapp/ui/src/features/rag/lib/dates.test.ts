import { describe, expect, it } from 'vitest'
import { formatRelativeDay } from './dates'

// Build ISO strings relative to the machine's clock, since formatRelativeDay
// compares local calendar days rather than elapsed hours.
function daysAgo(n: number, hour = 12): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

describe('formatRelativeDay', () => {
  it('labels the current calendar day Today regardless of hour', () => {
    expect(formatRelativeDay(daysAgo(0, 0))).toBe('Today')
    expect(formatRelativeDay(daysAgo(0, 23))).toBe('Today')
  })

  it('labels the previous calendar day Yesterday', () => {
    expect(formatRelativeDay(daysAgo(1))).toBe('Yesterday')
  })

  it('falls back to a date for anything older', () => {
    const label = formatRelativeDay(daysAgo(10))
    expect(label).not.toBe('Today')
    expect(label).not.toBe('Yesterday')
    expect(label.length).toBeGreaterThan(0)
  })

  it('includes the year only when it is not the current year', () => {
    const old = formatRelativeDay('2019-03-05T12:00:00Z')
    expect(old).toContain('2019')
  })

  it('returns an empty string for garbage input', () => {
    expect(formatRelativeDay('not-a-date')).toBe('')
  })
})
