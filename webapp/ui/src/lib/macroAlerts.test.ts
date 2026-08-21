import { describe, expect, it, vi } from 'vitest'
import type { MacroCalendar, MacroRelease } from '@/lib/api'
import { aggregateAlerts } from '@/lib/macroAlerts'

vi.mock('@/lib/macroFormat', () => ({
  todayIso: () => '2026-08-21',
  daysBetween: (a: string, b: string) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000),
  addDaysIso: vi.fn(),
}))

function makeRelease(overrides: Partial<MacroRelease> & { date: string; country: string }): MacroRelease {
  const base: MacroRelease = {
    date: '2026-08-21',
    time: null,
    country: 'US',
    type: 'CPI',
    event_key: 'inflation_rate__yoy',
    period: null,
    comparison: null,
    actual: null,
    estimate: null,
    previous: null,
    surprise: null,
    change: null,
    change_percentage: null,
    importance: 'standard',
    is_forecast: false,
  }
  return { ...base, ...overrides }
}

function makeCalendar(upcoming: MacroRelease[]): MacroCalendar {
  return {
    available: true,
    fetched_at: '2026-08-21T00:00:00Z',
    age_seconds: 0,
    stale: false,
    past: [],
    upcoming,
  }
}

describe('aggregateAlerts', () => {
  it('returns an empty array when the calendar is unavailable', () => {
    expect(aggregateAlerts({ ...makeCalendar([]), available: false })).toEqual([])
  })

  it('drops events outside the horizon and before today', () => {
    const calendar = makeCalendar([
      makeRelease({ date: '2026-08-20', country: 'US', importance: 'headline' }),
      makeRelease({ date: '2026-09-06', country: 'US', importance: 'headline' }),
    ])
    expect(aggregateAlerts(calendar, 14)).toEqual([])
  })

  it('weights headline events more than standard events', () => {
    const calendar = makeCalendar([
      makeRelease({ date: '2026-08-22', country: 'US', importance: 'standard' }),
      makeRelease({ date: '2026-08-22', country: 'DE', importance: 'headline' }),
    ])
    const alerts = aggregateAlerts(calendar, 14)
    const us = alerts.find((a) => a.country === 'US')!
    const de = alerts.find((a) => a.country === 'DE')!
    expect(de.score).toBe(1)
    expect(us.score).toBeLessThan(de.score)
  })

  it('increases weight as the release gets closer', () => {
    const calendar = makeCalendar([
      makeRelease({ date: '2026-08-22', country: 'US', importance: 'standard' }),
      makeRelease({ date: '2026-09-04', country: 'DE', importance: 'standard' }),
    ])
    const alerts = aggregateAlerts(calendar, 14)
    const us = alerts.find((a) => a.country === 'US')!
    const de = alerts.find((a) => a.country === 'DE')!
    expect(us.score).toBe(1)
    expect(de.score).toBeLessThan(us.score)
  })

  it('normalizes so the top country scores 1', () => {
    const calendar = makeCalendar([
      makeRelease({ date: '2026-08-22', country: 'US', importance: 'headline' }),
      makeRelease({ date: '2026-08-22', country: 'JP', importance: 'standard' }),
    ])
    const alerts = aggregateAlerts(calendar, 14)
    expect(alerts[0].score).toBe(1)
    expect(alerts.every((a) => a.score >= 0 && a.score <= 1)).toBe(true)
  })

  it('drops countries with no centroid mapping', () => {
    const calendar = makeCalendar([
      makeRelease({ date: '2026-08-22', country: 'ZZ', importance: 'headline' }),
    ])
    expect(aggregateAlerts(calendar, 14)).toEqual([])
  })

  it('picks the highest-weight event as the top event', () => {
    const calendar = makeCalendar([
      makeRelease({ date: '2026-08-22', country: 'US', importance: 'standard', type: 'Retail Sales' }),
      makeRelease({ date: '2026-08-22', country: 'US', importance: 'headline', type: 'NFP' }),
    ])
    const us = aggregateAlerts(calendar, 14).find((a) => a.country === 'US')!
    expect(us.topEvent).toBe('NFP')
    expect(us.eventCount).toBe(2)
  })

  it('falls back to recent past events when no upcoming events exist', () => {
    const calendar = {
      ...makeCalendar([]),
      past: [
        makeRelease({ date: '2026-08-20', country: 'US', importance: 'headline', type: 'CPI' }),
        makeRelease({ date: '2026-08-18', country: 'DE', importance: 'standard', type: 'IFO' }),
      ],
    }
    const alerts = aggregateAlerts(calendar, 14)
    expect(alerts).toHaveLength(2)
    expect(alerts.every((a) => a.stale)).toBe(true)
    expect(alerts[0].country).toBe('US')
  })
})
