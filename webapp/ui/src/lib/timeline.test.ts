import { describe, expect, it } from 'vitest'

import { timeline } from './timeline'

const WINDOWS = {
  train_start: '2010-01-04', train_end: '2019-12-31',
  valid_start: '2020-01-01', valid_end: '2021-12-31',
  test_start: '2022-01-01', test_end: '2023-12-31',
}

const band = (t: ReturnType<typeof timeline>, key: string) =>
  t!.bands.find((b) => b.key === key)!

describe('timeline', () => {
  it('lays the three bands out in order without gaps or overlap', () => {
    const t = timeline(WINDOWS)!
    expect(t.bands.map((b) => b.key)).toEqual(['train', 'valid', 'test'])

    const train = band(t, 'train')
    const valid = band(t, 'valid')
    const test = band(t, 'test')

    expect(train.leftPct).toBe(0)
    expect(train.leftPct + train.widthPct).toBeCloseTo(valid.leftPct, 1)
    expect(valid.leftPct + valid.widthPct).toBeCloseTo(test.leftPct, 1)
    expect(test.leftPct + test.widthPct).toBe(100)
  })

  it('measures distance rather than order', () => {
    // The point of parsing dates instead of comparing strings: ten years of
    // training and two of testing must not draw the same width.
    const t = timeline(WINDOWS)!
    expect(band(t, 'train').widthPct).toBeGreaterThan(band(t, 'test').widthPct * 3)
    expect(band(t, 'train').days).toBe(3648)
  })

  it('extends the axis to cover a store that starts before the spec', () => {
    const t = timeline(WINDOWS, { calendarStart: '2005-01-03', calendarEnd: '2026-07-31' })!
    expect(t.start).toBe('2005-01-03')
    expect(t.end).toBe('2026-07-31')
    // Training no longer starts at the left edge — there is data before it.
    expect(band(t, 'train').leftPct).toBeGreaterThan(0)
  })

  it('draws the store coverage as its own track', () => {
    const t = timeline(WINDOWS, { calendarStart: '2010-01-04', calendarEnd: '2026-07-31' })!
    expect(t.coverage).not.toBeNull()
    expect(t.coverage!.leftPct).toBe(0)
    expect(t.coverage!.widthPct).toBe(100)
  })

  it('has no coverage track when the store cannot say', () => {
    expect(timeline(WINDOWS)!.coverage).toBeNull()
    expect(timeline(WINDOWS, { calendarStart: '2010-01-04' })!.coverage).toBeNull()
  })

  it('marks the last safely backtestable day', () => {
    const t = timeline(WINDOWS, { calendarEnd: '2023-06-30' })!
    const marker = t.markers.find((m) => m.key === 'calendar-end')!
    expect(marker.tone).toBe('clay')
    expect(marker.pct).toBeGreaterThan(0)
    expect(marker.pct).toBeLessThan(100)
  })

  describe('the clamp', () => {
    it('returns the segment the run will not reach', () => {
      const t = timeline(
        { ...WINDOWS, test_end: '2026-12-31' },
        { calendarEnd: '2026-07-31', effectiveTestEnd: '2026-07-31' },
      )!
      expect(t.clamped).not.toBeNull()
      expect(t.clamped!.widthPct).toBeGreaterThan(0)
      // It sits at the far right, inside the test band.
      expect(t.clamped!.leftPct + t.clamped!.widthPct).toBeCloseTo(100, 5)
    })

    it('is absent when the end date is inside the calendar', () => {
      const t = timeline(WINDOWS, {
        calendarEnd: '2026-07-31', effectiveTestEnd: '2023-12-31',
      })!
      expect(t.clamped).toBeNull()
    })

    it('is absent when the server said nothing about it', () => {
      expect(timeline(WINDOWS, { calendarEnd: '2026-07-31' })!.clamped).toBeNull()
    })
  })

  describe('refusals and edge cases', () => {
    it('returns null rather than NaN geometry for an unparseable date', () => {
      expect(timeline({ ...WINDOWS, train_start: 'not-a-date' })).toBeNull()
      expect(timeline({ ...WINDOWS, test_end: '' })).toBeNull()
    })

    it('collapses an inverted window instead of drawing it backwards', () => {
      const t = timeline({ ...WINDOWS, test_start: '2023-12-31', test_end: '2022-01-01' })!
      expect(band(t, 'test').widthPct).toBe(0)
      expect(band(t, 'test').days).toBe(0)
    })

    it('survives a zero-width axis', () => {
      const same = {
        train_start: '2020-01-01', train_end: '2020-01-01',
        valid_start: '2020-01-01', valid_end: '2020-01-01',
        test_start: '2020-01-01', test_end: '2020-01-01',
      }
      const t = timeline(same)!
      expect(t.bands.every((b) => Number.isFinite(b.leftPct) && Number.isFinite(b.widthPct)))
        .toBe(true)
    })

    it('reports overlap as geometry, never as a sentence', () => {
      // The server owns the prose — a second voice would render twice and match
      // neither the tooltip nor the dedup.
      const overlapping = timeline({ ...WINDOWS, valid_start: '2019-06-01' })!
      expect(overlapping.overlapping).toBe(true)
      expect(timeline(WINDOWS)!.overlapping).toBe(false)

      const emitted = JSON.stringify(overlapping)
      expect(emitted).not.toMatch(/overlaps|optimistic|would be/i)
    })

    it('keeps every percentage within the axis', () => {
      const t = timeline({ ...WINDOWS, train_start: '1990-01-01', test_end: '2099-01-01' },
                         { calendarStart: '2010-01-04', calendarEnd: '2026-07-31' })!
      for (const b of t.bands) {
        expect(b.leftPct).toBeGreaterThanOrEqual(0)
        expect(b.leftPct + b.widthPct).toBeLessThanOrEqual(100.0001)
      }
    })
  })
})
