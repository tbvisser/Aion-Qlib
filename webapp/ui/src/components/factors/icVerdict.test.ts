import { describe, expect, it } from 'vitest'

import type { FactorEvaluation } from '@/lib/api'
import { IC_STRONG, ICIR_STRONG, icRows, icTone, icVerdict, isStrong } from './icVerdict'

const evaluation = (ic: number | null, ir: number | null): FactorEvaluation => ({
  expression: '$close/Ref($close,20) - 1',
  universe: 'top500',
  horizon: 5,
  observations: 120_000,
  days: 500,
  ic: { mean: ic, std: 0.1, ir, positive_rate: 0.52 },
  rank_ic: { mean: ic, std: 0.1, ir, positive_rate: 0.52 },
  series: [],
  cumulative_ic: null,
})

describe('isStrong', () => {
  it('judges magnitude, not sign', () => {
    // A negative IC is a good factor pointing the wrong way — negate the
    // expression and it ranks correctly. A sign-based rule discards the most
    // useful result a search can return.
    expect(isStrong(0.05, 'mean')).toBe(true)
    expect(isStrong(-0.05, 'mean')).toBe(true)
    expect(isStrong(-0.5, 'ir')).toBe(true)
  })

  it('uses the right threshold per field', () => {
    expect(isStrong(IC_STRONG, 'mean')).toBe(true)
    expect(isStrong(IC_STRONG - 0.0001, 'mean')).toBe(false)
    // An IC-sized number would clear the IC bar but not the ICIR bar.
    expect(isStrong(0.05, 'ir')).toBe(false)
    expect(isStrong(ICIR_STRONG, 'ir')).toBe(true)
  })

  it('treats missing and non-finite as not strong', () => {
    expect(isStrong(null, 'mean')).toBe(false)
    expect(isStrong(undefined, 'mean')).toBe(false)
    expect(isStrong(NaN, 'mean')).toBe(false)
    expect(isStrong(Infinity, 'mean')).toBe(false)
  })
})

describe('icTone', () => {
  it('separates "we do not know" from "it is weak"', () => {
    // A null IC means the expression produced nothing to correlate — a
    // different problem from a factor that measured near zero.
    expect(icTone(null, 'mean')).toBe('unknown')
    expect(icTone(0.001, 'mean')).toBe('weak')
    expect(icTone(0.05, 'mean')).toBe('strong')
  })
})

describe('icVerdict', () => {
  it('explains an empty measurement rather than calling it weak', () => {
    const verdict = icVerdict(evaluation(null, null))!
    expect(verdict).toContain('No usable observations')
    expect(verdict).toContain('history')
  })

  it('says a near-zero IC is noise', () => {
    expect(icVerdict(evaluation(0.001, 0.5))).toContain('inside the noise')
  })

  it('flags a strong but unstable IC', () => {
    const verdict = icVerdict(evaluation(0.05, 0.05))!
    expect(verdict).toContain('unstable')
    expect(verdict).toContain('0.05')
  })

  it('tells you to negate a strong negative factor', () => {
    const verdict = icVerdict(evaluation(-0.05, -0.5))!
    expect(verdict).toContain('wrong way')
    expect(verdict).toContain('Negating')
  })

  it('says nothing when the result speaks for itself', () => {
    expect(icVerdict(evaluation(0.05, 0.5))).toBeNull()
  })
})

describe('icRows', () => {
  it('returns the four figures in one order for every surface', () => {
    const rows = icRows(evaluation(0.05, 0.5))
    expect(rows.map((r) => r.label)).toEqual(['IC', 'ICIR', 'Rank IC', 'Rank ICIR'])
    expect(rows.map((r) => r.field)).toEqual(['mean', 'ir', 'mean', 'ir'])
  })

  it('survives a response missing a whole stats block', () => {
    const partial = { ...evaluation(0.05, 0.5), rank_ic: undefined } as unknown as FactorEvaluation
    expect(icRows(partial).map((r) => r.value)).toEqual([0.05, 0.5, null, null])
  })
})
