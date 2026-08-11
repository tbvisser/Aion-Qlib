import { describe, expect, it } from 'vitest'
import type { MacroRegimeResponse } from './api'
import { verdictSentence } from './regimeVerdict'
import { ribbonCells } from './regimeHistory'
import { playbookMatrix } from './playbook'
import { zMark } from './macroFormat'

function regime(over: Partial<MacroRegimeResponse> = {}): MacroRegimeResponse {
  return {
    as_of: '2026-08-07',
    quadrant: {
      label: 'Reflation', state: 'reflation',
      growth: { direction: 'rising', delta_6m: 0.3, delta_3m: 0.2, latest: 4.1,
                latest_date: '2026-08-07', source_key: 'unemployment_rate' },
      inflation: { direction: 'rising', delta_6m: 0.8, delta_3m: 0.2, latest: 3.5,
                   latest_date: '2026-07-14', source_key: 'inflation_rate__yoy' },
      growth_tilt: 0.1, tie_break_used: false, as_of: '2026-08-07', reason: null,
    },
    rate_cycle: {
      stage: 'Hold (post-cut trough)', state: 'hold_post_cut', source: 'US3M',
      front_end: 3.8, delta_3m: 0.11, delta_12m: -0.44, policy_rate: 3.75,
      policy_rate_date: '2026-07-29', front_end_vs_policy: 0.18,
      curve_spread: 0.85, inverted: false, as_of: '2026-08-07', reason: null,
    },
    risk: {
      label: 'Risk-On', state: 'risk_on', score: 0.5,
      components: [{ name: 'SPX 20d return', value: 2.4, vote: 1 }],
      missing: [], as_of: '2026-08-07', reason: null,
    },
    market: {
      state: 'rising_low', label: 'Rates up, vol low', rates: 'rising', vol: 'low',
      rates_momentum: 0.2, vol_z: -0.6, as_of: '2026-08-07', reason: null,
    },
    headline_readings: [], vintage: 'latest', available: true,
    reason: null, warnings: [],
    ...over,
  }
}

const unresolved = {
  label: null, state: 'unknown', reason: 'Not enough history.',
  growth: { direction: 'unknown', delta_6m: null, delta_3m: null, latest: null,
            latest_date: null, source_key: null },
  inflation: { direction: 'unknown', delta_6m: null, delta_3m: null, latest: null,
               latest_date: null, source_key: null },
  growth_tilt: null, tie_break_used: false, as_of: null,
} as MacroRegimeResponse['quadrant']

describe('verdictSentence', () => {
  it('leads with the quadrant when everything resolves', () => {
    const v = verdictSentence(regime())
    expect(v.headline).toBe('Reflation')
    expect(v.knownLenses).toBe(4)
    expect(v.sub).toContain('growth rising')
    expect(v.sub).toContain('inflation rising')
    expect(v.sub).toContain('risk on')
    expect(v.tone.band).toContain('amber')
  })

  it('says so rather than asserting when the quadrant is unresolved', () => {
    const v = verdictSentence(regime({ quadrant: unresolved }))
    expect(v.headline).toBe('Regime unresolved')
    expect(v.knownLenses).toBe(3)
    // The lenses that did resolve are still reported.
    expect(v.sub).toContain('policy')
  })

  it('omits an unresolved lens rather than printing "unknown"', () => {
    const v = verdictSentence(regime({
      risk: { ...regime().risk, label: 'unknown', state: 'unknown', score: null },
    }))
    expect(v.sub).not.toContain('unknown')
    expect(v.knownLenses).toBe(3)
  })

  it('asserts nothing when no lens resolves', () => {
    const v = verdictSentence(regime({
      quadrant: unresolved,
      rate_cycle: { ...regime().rate_cycle, stage: 'unknown', state: 'unknown' },
      risk: { ...regime().risk, label: 'unknown', state: 'unknown' },
      market: { ...regime().market, state: 'unknown', label: null },
    }))
    expect(v.headline).toBe('Regime unresolved')
    expect(v.sub).toBeNull()
    expect(v.knownLenses).toBe(0)
  })

  it('handles an unavailable payload and a null one', () => {
    expect(verdictSentence(null).headline).toBe('Regime unresolved')
    expect(verdictSentence(regime({ available: false })).knownLenses).toBe(0)
  })

  it('treats Transitional as a resolved state', () => {
    const v = verdictSentence(regime({
      quadrant: { ...regime().quadrant, label: 'Transitional', state: 'transitional' },
    }))
    expect(v.headline).toBe('Transitional')
    expect(v.tone.band).toContain('slate')
    expect(v.knownLenses).toBe(4)
  })

  it('never leaks null or undefined into the output', () => {
    for (const v of [verdictSentence(null), verdictSentence(regime()),
                     verdictSentence(regime({ quadrant: unresolved }))]) {
      expect(v.headline).not.toMatch(/null|undefined/)
      if (v.sub) expect(v.sub).not.toMatch(/null|undefined/)
    }
  })
})

describe('ribbonCells', () => {
  const month = (m: string, q: string | null) => ({
    month: m, quadrant: q, quadrant_state: q?.toLowerCase() ?? null,
    rate_stage: 'Hiking', risk: 'Risk-On', market: 'rising_low',
  })

  it('labels the year on January and on the first cell only', () => {
    const cells = ribbonCells([
      month('2024-11', 'Reflation'), month('2024-12', 'Reflation'),
      month('2025-01', 'Goldilocks'), month('2025-02', 'Goldilocks'),
    ])
    expect(cells.map((c) => c.yearLabel)).toEqual(['2024', null, '2025', null])
  })

  it('is not fooled by a YYYY-MM-01 serialisation', () => {
    // `endsWith('-01')` on a full date is true every month and would print the
    // year 24 times. Slicing to YYYY-MM is what prevents that.
    const cells = ribbonCells([
      { ...month('2024-11-01', 'Reflation') },
      { ...month('2024-12-01', 'Reflation') },
    ])
    expect(cells.map((c) => c.yearLabel)).toEqual(['2024', null])
  })

  it('draws a gap as a gap rather than shifting later cells', () => {
    const cells = ribbonCells([month('2025-01', 'Reflation'), month('2025-03', 'Goldilocks')])
    expect(cells.map((c) => c.month)).toEqual(['2025-01', '2025-02', '2025-03'])
    expect(cells[1].missing).toBe(true)
    expect(cells[2].quadrant).toBe('Goldilocks')
  })

  it('marks exactly one cell current', () => {
    const cells = ribbonCells([month('2025-01', 'Reflation'), month('2025-02', 'Goldilocks')])
    expect(cells.filter((c) => c.current)).toHaveLength(1)
    expect(cells[cells.length - 1].current).toBe(true)
  })

  it('never writes the string "null" into a tooltip', () => {
    for (const cell of ribbonCells([month('2025-01', null)])) {
      expect(cell.title).not.toContain('null')
      expect(cell.title).toContain('unresolved')
    }
  })

  it('is empty for an empty history', () => {
    expect(ribbonCells([])).toEqual([])
  })
})

describe('playbookMatrix', () => {
  const cell = (key: string, ret: number | null, thin = false) => ({
    key, label: key, ann_return: ret, ann_vol: 0.1, sharpe: 1, hit_rate: 0.6,
    n: 100, thin, reason: null,
  })

  it('aligns a state missing an asset to the right column', () => {
    // states[].assets[] is not guaranteed to be the same list per state; a
    // shifted row attributes every number to the wrong asset.
    const matrix = playbookMatrix({
      lens: 'quadrant', label: 'Q', caveat: 'c', available: true, reason: null,
      window: { start: 'a', end: 'b', days: 1 }, unclassified: 0,
      assets: [{ key: 'GSPC', label: 'Equities' }, { key: 'DXY', label: 'Dollar' }],
      warnings: [],
      states: [
        { state: 'reflation', label: 'Reflation', days: 10, episodes: 2, share: 0.5,
          current: true, first: null, last: null, median_episode_days: 5, runs: [],
          assets: [cell('DXY', 0.2)] },
      ],
    })
    expect(matrix.assets.map((a) => a.key)).toEqual(['GSPC', 'DXY'])
    expect(matrix.rows[0].cells[0]).toBeNull()
    expect(matrix.rows[0].cells[1]?.key).toBe('DXY')
  })

  it('keeps a thin cell and its number', () => {
    const matrix = playbookMatrix({
      lens: 'quadrant', label: 'Q', caveat: 'c', available: true, reason: null,
      window: null, unclassified: 0, assets: [{ key: 'GSPC', label: 'Equities' }],
      warnings: [],
      states: [{ state: 'stagflation', label: 'Stagflation', days: 90, episodes: 1,
                 share: 1, current: false, first: null, last: null,
                 median_episode_days: 90, runs: [{ start: 'a', end: 'b', label: 's' }],
                 assets: [cell('GSPC', 0.5, true)] }],
    })
    expect(matrix.rows[0].cells[0]?.thin).toBe(true)
    expect(matrix.rows[0].cells[0]?.ann_return).toBe(0.5)
    expect(matrix.rows[0].runsTitle).toContain('1 episode')
  })

  it('is empty for a null or unavailable payload', () => {
    expect(playbookMatrix(null).rows).toEqual([])
    expect(playbookMatrix({ available: false } as never).rows).toEqual([])
  })
})

describe('zMark', () => {
  it('has strict boundaries at 1.5 and 2.5 sigma', () => {
    expect(zMark(1.4999)).toBeNull()
    expect(zMark(1.5)?.level).toBe('high')
    expect(zMark(2.4999)?.level).toBe('high')
    expect(zMark(2.5)?.level).toBe('extreme')
  })

  it('is symmetric in sign', () => {
    expect(zMark(-2.6)).toEqual({ level: 'extreme', sign: -1 })
    expect(zMark(2.6)).toEqual({ level: 'extreme', sign: 1 })
  })

  it('marks nothing for an unscored or ordinary series', () => {
    for (const z of [null, undefined, NaN, Infinity, 0, 1.2, -1.2]) {
      expect(zMark(z as never)).toBeNull()
    }
  })
})
