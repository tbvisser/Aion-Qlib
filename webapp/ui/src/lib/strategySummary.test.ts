import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY, type StrategyExplain } from './api'
import { summarise } from './strategySummary'

const EXPLAIN: StrategyExplain = {
  label: {
    expression: 'Ref($close, -2)/Ref($close, -1) - 1',
    name: 'LABEL0',
    horizon_days: 2,
    holding_days: 1,
  },
  calendar_start: '2010-01-04',
  calendar_end: '2026-07-31',
  effective_test_end: DEFAULT_STRATEGY.test_end,
}

const text = (clauses: ReturnType<typeof summarise>, key: string) =>
  clauses.find((c) => c.key === key)?.text ?? ''

const keys = (clauses: ReturnType<typeof summarise>) => clauses.map((c) => c.key)

describe('summarise', () => {
  describe('the prediction target', () => {
    it('does not call it a two-day return', () => {
      // It is the return *between* two future closes: two days of look-ahead,
      // one session of exposure. "2-day return" is the habitual shorthand and
      // states something the config does not do.
      const target = text(summarise(DEFAULT_STRATEGY, EXPLAIN), 'target')
      expect(target).toContain('one session of exposure')
      expect(target).toContain('two days ahead')
      expect(target).not.toMatch(/2-day return|two-day return/i)
    })

    it('carries the raw expression as the detail', () => {
      const clause = summarise(DEFAULT_STRATEGY, EXPLAIN).find((c) => c.key === 'target')!
      expect(clause.detail).toBe('Ref($close, -2)/Ref($close, -1) - 1')
    })

    it('is omitted entirely when the server cannot say', () => {
      // Not defaulted. A confident wrong sentence about what a model predicts
      // is worse than no sentence.
      expect(keys(summarise(DEFAULT_STRATEGY))).not.toContain('target')
      expect(keys(summarise(DEFAULT_STRATEGY, { ...EXPLAIN, label: null })))
        .not.toContain('target')
    })

    it('generalises rather than hardcoding the bundled handlers', () => {
      const weekly = summarise(DEFAULT_STRATEGY, {
        ...EXPLAIN,
        label: { expression: 'x', name: 'L', horizon_days: 6, holding_days: 5 },
      })
      expect(text(weekly, 'target')).toContain('5-session return')
      expect(text(weekly, 'target')).toContain('6 days ahead')
    })
  })

  describe('features', () => {
    it('says the handler stands alone when there are no custom columns', () => {
      expect(text(summarise(DEFAULT_STRATEGY, EXPLAIN), 'model'))
        .toContain("Alpha158’s own 158 factors")
    })

    it('distinguishes extending from replacing', () => {
      const features = [
        { name: 'A', expression: '$close' },
        { name: 'B', expression: '$open' },
      ]
      const extended = summarise(
        { ...DEFAULT_STRATEGY, features, feature_mode: 'extend' }, EXPLAIN)
      const replaced = summarise(
        { ...DEFAULT_STRATEGY, features, feature_mode: 'replace' }, EXPLAIN)

      expect(text(extended, 'model')).toContain('plus 2 custom columns')
      expect(text(replaced, 'model')).toContain('replacing')
      expect(text(replaced, 'model')).not.toContain('plus')
    })

    it('gets the singular right', () => {
      const one = summarise(
        { ...DEFAULT_STRATEGY, features: [{ name: 'A', expression: '$close' }] }, EXPLAIN)
      expect(text(one, 'model')).toContain('1 custom column')
      expect(text(one, 'model')).not.toContain('columns')
    })
  })

  describe('the windows', () => {
    it('says where the run really stops when the end date is clamped', () => {
      const clauses = summarise(
        { ...DEFAULT_STRATEGY, test_end: '2026-12-31' },
        { ...EXPLAIN, effective_test_end: '2026-07-31' },
      )
      expect(text(clauses, 'windows')).toContain('The run stops at 2026-07-31')
      expect(clauses.find((c) => c.key === 'windows')!.detail)
        .toBe('you asked for 2026-12-31')
    })

    it('says nothing extra when the window fits', () => {
      const clauses = summarise(DEFAULT_STRATEGY, EXPLAIN)
      expect(text(clauses, 'windows')).not.toContain('The run stops at')
    })
  })

  describe('cost', () => {
    it('is in basis points, with the round trip spelled out', () => {
      const cost = text(summarise(DEFAULT_STRATEGY, EXPLAIN), 'cost')
      expect(cost).toContain('5 bps to open')
      expect(cost).toContain('15 bps to close')
      expect(cost).toContain('20 bps round trip')
    })

    it('names the currency and groups the account digits', () => {
      const cost = text(summarise(DEFAULT_STRATEGY, EXPLAIN), 'cost')
      expect(cost).toContain('USD 5 per trade')
      expect(cost).toContain('USD 100,000,000')
    })
  })

  describe('limit_threshold', () => {
    it('appears only when set, since there is no control for it', () => {
      // A spec carrying one came from a template or the assistant. Without this
      // clause it is invisible everywhere except the raw YAML.
      expect(keys(summarise(DEFAULT_STRATEGY, EXPLAIN))).not.toContain('limit')

      const limited = summarise(
        { ...DEFAULT_STRATEGY, limit_threshold: 0.095 }, EXPLAIN)
      expect(keys(limited)).toContain('limit')
      expect(text(limited, 'limit')).toContain('9.5%')
      expect(text(limited, 'limit')).toContain('China')
    })
  })

  it('always answers the six questions that do not depend on the server', () => {
    expect(keys(summarise(DEFAULT_STRATEGY)))
      .toEqual(['universe', 'model', 'windows', 'portfolio', 'cost', 'benchmark'])
  })

  it('states the universe size when it is known and omits it when not', () => {
    expect(text(summarise(DEFAULT_STRATEGY, EXPLAIN, 500), 'universe'))
      .toContain('the 500 names in top500')
    // Not "the 0 names in top500": a count that has not arrived yet must not
    // read as a universe that is empty.
    expect(text(summarise(DEFAULT_STRATEGY, EXPLAIN), 'universe'))
      .toContain('Ranked across the top500')
    expect(text(summarise(DEFAULT_STRATEGY, EXPLAIN, 0), 'universe'))
      .not.toContain('0 names')
  })
})
