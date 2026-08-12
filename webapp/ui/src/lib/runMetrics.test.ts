import { describe, expect, it } from 'vitest'

import type { Run, RunReport } from './api'
import {
  best, changedSince, excessOf, featureSetOf, formatRunPercent, metricRow,
  metricTone, rankValue, runDiff, sanityOf, PLAUSIBLE_PERCENT,
} from './runMetrics'

const run = (id: string, extra: Partial<Run> = {}): Run => ({
  id,
  name: 'Momentum',
  kind: 'backtest',
  status: 'succeeded',
  phase: 'done',
  created_at: '2026-08-01T10:00:00Z',
  started_at: null,
  finished_at: null,
  exit_code: 0,
  error: null,
  experiment_name: `aion-${id}`,
  model: 'lightgbm',
  handler: 'Alpha158',
  universe: 'top500',
  benchmark: 'SPY',
  data_store: 'us',
  topk: 50,
  n_drop: 5,
  ...extra,
})

const report = (excess: Record<string, number | null>): RunReport => ({
  recorder_id: 'r1',
  experiment_name: 'aion-x',
  metrics: {},
  risk: { excess_return_with_cost: excess },
  curves: {},
  period: { start: '2022-01-03', end: '2023-12-29', days: 500 },
  run: run('x'),
})

describe('formatRunPercent', () => {
  /**
   * The whole point of the clamp is that it changes nothing for a run anyone
   * would want to read. If these drift, every normal backtest's display drifted.
   */
  it('formats an ordinary return exactly as it always did', () => {
    expect(formatRunPercent(0.124)).toBe('+12.4%')
    expect(formatRunPercent(-0.31)).toBe('-31.0%')
    expect(formatRunPercent(0)).toBe('0.0%')
  })

  it('keeps each surface\'s own digits and sign convention', () => {
    // The report view shows two decimals and no leading plus.
    expect(formatRunPercent(0.124, 2, false)).toBe('12.40%')
    // The compare table shows one and no plus.
    expect(formatRunPercent(0.124, 1, false)).toBe('12.4%')
  })

  /**
   * The ETH Breakout run: qlib reported an annualised excess return of 75,327,
   * which printed as `+7532752.7%` and broke the column it sat in. Six digits of
   * a broken number are not six digits of precision.
   */
  it('clamps a number that is not a result', () => {
    expect(formatRunPercent(75327.527354)).toBe('>1,000%')
    expect(formatRunPercent(-3.762962 * 1000)).toBe('<-1,000%')
  })

  it('clamps just outside the band and not just inside it', () => {
    expect(formatRunPercent(PLAUSIBLE_PERCENT / 100)).toBe('+1000.0%')
    expect(formatRunPercent((PLAUSIBLE_PERCENT + 1) / 100)).toBe('>1,000%')
  })
})

describe('sanityOf', () => {
  it('reads the backend\'s verdict', () => {
    const bad = { ...report({}), sanity: { implausible: true, reasons: ['nope'] } }
    expect(sanityOf(bad)).toEqual({ implausible: true, reasons: ['nope'] })
  })

  /**
   * A report built before the check existed was never judged, and "not judged"
   * must not render as a warning — an old run cannot suddenly grow a verdict
   * nobody computed for it.
   */
  it('treats an unjudged report as plausible rather than suspect', () => {
    expect(sanityOf(report({}))).toEqual({ implausible: false, reasons: [] })
    expect(sanityOf(null)).toEqual({ implausible: false, reasons: [] })
    expect(sanityOf(undefined)).toEqual({ implausible: false, reasons: [] })
  })
})

describe('featureSetOf', () => {
  /**
   * The defect this exists for: the ETH Breakout run set `feature_mode: replace`
   * with four custom factors, so Alpha158 was never loaded — and the panel said
   * "Feature set: Alpha158" anyway.
   */
  it('does not name the handler when the handler was replaced', () => {
    expect(featureSetOf(run('a', { feature_mode: 'replace', feature_count: 4 })))
      .toBe('4 custom columns')
    expect(featureSetOf(run('a', { feature_mode: 'replace', feature_count: 1 })))
      .toBe('1 custom column')
  })

  it('counts the additions when the handler was extended', () => {
    expect(featureSetOf(run('a', { feature_mode: 'extend', feature_count: 3 })))
      .toBe('Alpha158 + 3')
    expect(featureSetOf(run('a', { feature_mode: 'extend', feature_count: 0 })))
      .toBe('Alpha158')
  })

  /**
   * Runs launched before `feature_mode` was recorded. The handler name is all
   * that was written down, so it is the only honest answer — guessing a mode
   * would invent a fact about a finished run.
   */
  it('falls back to the handler when the mode was never recorded', () => {
    expect(featureSetOf(run('a'))).toBe('Alpha158')
    expect(featureSetOf(run('a', { handler: undefined }))).toBe('—')
  })
})

describe('metricRow', () => {
  it('reads the net-of-cost block, not the gross one', () => {
    // Gross of cost a high-turnover strategy can look excellent while losing
    // money. The report leads with the net block for that reason.
    const full: RunReport = {
      ...report({ information_ratio: 0.4 }),
      risk: {
        excess_return_with_cost: { information_ratio: 0.4 },
        excess_return_without_cost: { information_ratio: 1.9 },
      },
    }
    expect(metricRow(run('a'), full).ir).toBe(0.4)
  })

  it('survives a report with no risk block at all', () => {
    const row = metricRow(run('a'), null)
    expect(row).toMatchObject({ ir: null, annualised: null, maxDrawdown: null })
    expect(row.runId).toBe('a')
  })

  it('treats a non-finite metric as missing rather than as zero', () => {
    // A zero IR ranks above a negative one; NaN masquerading as zero would
    // promote a broken run over a merely bad one.
    const row = metricRow(run('a'), report({ information_ratio: NaN }))
    expect(row.ir).toBeNull()
  })

  it('carries the period through', () => {
    expect(metricRow(run('a'), report({})).period)
      .toMatchObject({ start: '2022-01-03', end: '2023-12-29' })
  })
})

describe('excessOf', () => {
  it('is an empty object rather than undefined', () => {
    expect(excessOf(null)).toEqual({})
    expect(excessOf(undefined)).toEqual({})
  })
})

describe('rankValue', () => {
  it('sinks a run with no metrics instead of ranking it as zero', () => {
    const withIr = metricRow(run('a'), report({ information_ratio: -0.5 }))
    const without = metricRow(run('b'), null)
    expect(rankValue(withIr)).toBeGreaterThan(rankValue(without))
  })
})

describe('best', () => {
  const rows = [
    metricRow(run('a'), report({
      information_ratio: 0.9, annualized_return: 0.12, max_drawdown: -0.30, std: 0.02,
    })),
    metricRow(run('b'), report({
      information_ratio: 0.4, annualized_return: 0.20, max_drawdown: -0.12, std: 0.05,
    })),
  ]

  it('picks the largest for a return-like column', () => {
    expect(best(rows, 'ir')).toBe('a')
    expect(best(rows, 'annualised')).toBe('b')
  })

  it('picks the smallest drawdown, by magnitude', () => {
    // Drawdown is negative, so a plain `>` would crown −0.30 — the worst run in
    // the table — as the winner.
    expect(best(rows, 'maxDrawdown')).toBe('b')
    expect(best(rows, 'volatility')).toBe('a')
  })

  it('ignores runs with nothing recorded', () => {
    expect(best([metricRow(run('a'), null), rows[0]], 'ir')).toBe('a')
    expect(best([metricRow(run('z'), null)], 'ir')).toBeNull()
    expect(best([], 'ir')).toBeNull()
  })
})

describe('metricTone', () => {
  it('colours a return by its sign', () => {
    expect(metricTone('ir', 1.24)).toBe('positive')
    expect(metricTone('ir', -0.4)).toBe('negative')
    expect(metricTone('annualised', 0.142)).toBe('positive')
  })

  it('treats a flat return as negative, not positive', () => {
    expect(metricTone('ir', 0)).toBe('negative')
  })

  /**
   * The rule most likely to be got wrong in the ledger. Drawdown is negative by
   * construction, so the sign rule would paint a run with *zero* drawdown mint
   * — the best possible outcome rendered as though it were the worst.
   */
  it('always reads drawdown and volatility as negative, whatever the sign', () => {
    expect(metricTone('maxDrawdown', -0.281)).toBe('negative')
    expect(metricTone('maxDrawdown', 0)).toBe('negative')
    expect(metricTone('volatility', 0.18)).toBe('negative')
  })

  it('is neutral when there is no number', () => {
    expect(metricTone('ir', null)).toBeNull()
    expect(metricTone('maxDrawdown', null)).toBeNull()
  })
})

describe('runDiff', () => {
  it('lists only what changed', () => {
    const rows = runDiff([run('a'), run('b', { model: 'xgboost', topk: 100 })])
    expect(rows.map((r) => r.field)).toEqual(['Model', 'Top K'])
    expect(rows[0].values).toEqual({ a: 'lightgbm', b: 'xgboost' })
  })

  it('is empty when the runs are identical in every recorded field', () => {
    expect(runDiff([run('a'), run('b')])).toEqual([])
  })

  it('needs at least two runs to have an opinion', () => {
    expect(runDiff([run('a')])).toEqual([])
    expect(runDiff([])).toEqual([])
  })

  it('shows a field an older run never recorded as an em dash, not as unchanged', () => {
    // "we did not record this" and "it was the same" are different claims, and
    // collapsing them would report a config change as no change.
    const old = run('a')
    delete (old as Partial<Run>).topk
    const rows = runDiff([old, run('b', { topk: 100 })])
    expect(rows).toHaveLength(1)
    expect(rows[0].values).toEqual({ a: '—', b: '100' })
  })

  it('compares more than two at once', () => {
    const rows = runDiff([
      run('a'), run('b', { model: 'xgboost' }), run('c', { model: 'catboost' }),
    ])
    expect(rows[0].values).toEqual({ a: 'lightgbm', b: 'xgboost', c: 'catboost' })
  })
})

describe('changedSince', () => {
  it('names the decisions that moved', () => {
    expect(changedSince(run('a'), run('b', { model: 'xgboost', n_drop: 20 })))
      .toBe('Model, Drop')
  })

  it('ignores identity and timing', () => {
    // A second attempt at the same spec has a new id, a new name-stamp and new
    // timestamps. None of those are a change to the strategy.
    expect(changedSince(run('a'), run('b', {
      created_at: '2026-08-02T10:00:00Z', status: 'failed', error: 'boom',
    }))).toBeNull()
  })

  it('has nothing to say about the first run', () => {
    expect(changedSince(undefined, run('a'))).toBeNull()
  })
})
