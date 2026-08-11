import { describe, expect, it } from 'vitest'
import {
  SERIES_STROKES, daysBetween, formatChange, formatIsoDate, formatLevel,
  isSignificant, significance, toneFor, zTint,
} from './macroFormat'
import { decimate, mergeCurves } from './curves'

describe('significance', () => {
  it('has boundaries exactly at the critical values', () => {
    expect(significance(2.58)).toBe('***')
    expect(significance(2.5799)).toBe('**')
    expect(significance(1.96)).toBe('**')
    expect(significance(1.9599)).toBe('*')
    expect(significance(1.65)).toBe('*')
    expect(significance(1.6499)).toBe('ns')
  })

  it('is symmetric in sign', () => {
    expect(significance(-2.6)).toBe('***')
    expect(significance(-0.2)).toBe('ns')
  })

  it('distinguishes "no estimate" from "not significant"', () => {
    expect(significance(null)).toBe('—')
    expect(significance(undefined)).toBe('—')
    expect(significance(NaN)).toBe('—')
    expect(significance(Infinity)).toBe('—')
    expect(significance(0)).toBe('ns')
  })

  it('isSignificant agrees with the 5% line', () => {
    expect(isSignificant(1.96)).toBe(true)
    expect(isSignificant(1.9)).toBe(false)
    expect(isSignificant(null)).toBe(false)
  })
})

describe('zTint', () => {
  it('returns no tint for null, so an unscored tile stays neutral', () => {
    expect(zTint(null)).toBeUndefined()
    expect(zTint(undefined)).toBeUndefined()
    expect(zTint(NaN)).toBeUndefined()
  })

  it('returns no tint near the mean rather than a faint colour', () => {
    expect(zTint(0)).toBeUndefined()
    expect(zTint(0.27)).toBeUndefined()
    expect(zTint(-0.27)).toBeUndefined()
    expect(zTint(0.29)).toBeDefined()
  })

  it('uses primary above the mean and clay below', () => {
    expect(zTint(2)).toContain('--primary')
    expect(zTint(-2)).toContain('--clay')
  })

  it('only ever emits token references, never a hex', () => {
    for (const z of [-4, -1, 1, 2, 9]) {
      expect(zTint(z)).toMatch(/^hsl\(var\(--(primary|clay)\) \/ [\d.]+\)$/)
    }
  })

  it('caps the alpha so an outlier cannot render an opaque block', () => {
    const alpha = (s: string) => Number(s.match(/\/ ([\d.]+)\)/)![1])
    expect(alpha(zTint(99)!)).toBeLessThanOrEqual(0.22)
  })
})

describe('series strokes', () => {
  it('never uses clay as a series identity', () => {
    // clay means "negative verdict" everywhere else; a line meaning "DXY"
    // drawn in clay would collide with that.
    for (const s of SERIES_STROKES) expect(s.stroke).not.toContain('clay')
  })

  it('contains no hardcoded hex colours', () => {
    for (const s of SERIES_STROKES) expect(s.stroke).not.toContain('#')
  })

  it('is distinguishable: every stroke+dash pair is unique', () => {
    const pairs = SERIES_STROKES.map((s) => `${s.stroke}|${s.strokeDasharray}`)
    expect(new Set(pairs).size).toBe(SERIES_STROKES.length)
  })
})

describe('toneFor', () => {
  it('colours by sign', () => {
    expect(toneFor(1)).toBe('text-primary')
    expect(toneFor(-1)).toBe('text-clay')
    expect(toneFor(0)).toBe('')
    expect(toneFor(null)).toBe('')
  })

  it('forces clay for values that are bad whatever their sign', () => {
    expect(toneFor(0.2, true)).toBe('text-clay')
  })
})

describe('formatting', () => {
  it('formats a yield change in basis points and a price change in percent', () => {
    expect(formatChange(4.2, 'bps')).toBe('+4.2bp')
    expect(formatChange(-4.2, 'bps')).toBe('-4.2bp')
    expect(formatChange(0.0123, 'log')).toBe('+1.23%')
    expect(formatChange(null, 'bps')).toBe('—')
  })

  it('formats levels by unit', () => {
    expect(formatLevel(4.651, 'percent')).toBe('4.65%')
    expect(formatLevel(7757.64, 'index')).toBe('7,758')
    expect(formatLevel(14.9, 'index')).toBe('14.90')
    expect(formatLevel(0.2254, 'log_ratio')).toBe('0.2254')
    expect(formatLevel(null, 'index')).toBe('—')
  })
})

describe('formatIsoDate', () => {
  it('does not shift the day west of Greenwich', () => {
    // new Date('2026-08-07') is UTC midnight; rendering it in a negative
    // offset prints the 6th. On a release calendar that is a wrong answer.
    const original = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      expect(formatIsoDate('2026-08-07')).toBe('07 Aug 2026')
      expect(formatIsoDate('2026-01-01')).toBe('01 Jan 2026')
    } finally {
      process.env.TZ = original
    }
  })

  it('tolerates a full timestamp and a missing value', () => {
    expect(formatIsoDate('2026-08-07 13:30:00')).toBe('07 Aug 2026')
    expect(formatIsoDate(null)).toBe('—')
    expect(formatIsoDate('')).toBe('—')
  })
})

describe('daysBetween', () => {
  it('counts calendar days without a timezone shift', () => {
    expect(daysBetween('2026-08-07', '2026-08-10')).toBe(3)
    expect(daysBetween('2026-08-10', '2026-08-07')).toBe(-3)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
  })
})

describe('mergeCurves', () => {
  it('produces one row per date with a column per series', () => {
    const rows = mergeCurves({
      nav: [{ date: '2024-01-02', value: 0.1 }, { date: '2024-01-03', value: 0.2 }],
      benchmark: [{ date: '2024-01-02', value: 0.05 }, { date: '2024-01-03', value: 0.06 }],
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ date: '2024-01-02', nav: 0.1, benchmark: 0.05 })
  })

  it('fills a missing date with null, not undefined', () => {
    // Recharts renders null as a break and interpolates across undefined.
    const rows = mergeCurves({
      nav: [{ date: '2024-01-02', value: 0.1 }, { date: '2024-01-03', value: 0.2 }],
      benchmark: [{ date: '2024-01-03', value: 0.06 }],
    })
    expect(rows[0].benchmark).toBeNull()
    expect('benchmark' in rows[0]).toBe(true)
  })

  it('sorts ascending and ignores empty series', () => {
    const rows = mergeCurves({
      nav: [{ date: '2024-01-03', value: 1 }, { date: '2024-01-02', value: 0 }],
      benchmark: [],
      excess: undefined,
    })
    expect(rows.map((r) => r.date)).toEqual(['2024-01-02', '2024-01-03'])
    expect('benchmark' in rows[0]).toBe(false)
  })
})

describe('decimate', () => {
  const y = (p: { v: number | null }) => p.v

  it('returns the input unchanged when it is already short enough', () => {
    const points = [{ v: 1 }, { v: 2 }, { v: 3 }]
    expect(decimate(points, 600, y)).toBe(points)
  })

  it('keeps the first and last points', () => {
    const points = Array.from({ length: 5000 }, (_, i) => ({ v: i }))
    const out = decimate(points, 600, y)
    expect(out).toHaveLength(600)
    expect(out[0]).toBe(points[0])
    expect(out[out.length - 1]).toBe(points[points.length - 1])
  })

  it('keeps a lone spike that a naive stride would drop', () => {
    // The March 2020 VIX problem in miniature.
    const points = Array.from({ length: 4000 }, () => ({ v: 15 }))
    points[1234] = { v: 82 }
    const out = decimate(points, 100, y)
    expect(out.some((p) => p.v === 82)).toBe(true)
    const strided = points.filter((_, i) => i % 40 === 0)
    expect(strided.some((p) => p.v === 82)).toBe(false)
  })

  it('preserves a null gap rather than bridging it', () => {
    const points: { v: number | null }[] = Array.from({ length: 2000 }, () => ({ v: 10 }))
    points[900] = { v: null }
    const out = decimate(points, 200, y)
    expect(out.some((p) => p.v === null)).toBe(true)
  })

  it('never turns a null into a zero', () => {
    const points: { v: number | null }[] = Array.from({ length: 1000 }, (_, i) =>
      i % 100 === 0 ? { v: null } : { v: 5 },
    )
    for (const p of decimate(points, 100, y)) {
      expect(p.v === null || p.v === 5).toBe(true)
    }
  })
})
