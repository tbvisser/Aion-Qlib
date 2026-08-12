import { describe, expect, it } from 'vitest'

import type { CurvePoint, Run, RunReport } from './api'
import { previewTier } from './artifactPreview'

const run = (extra: Partial<Run> = {}): Run => ({
  id: 'r1',
  name: 'Momentum',
  kind: 'backtest',
  status: 'succeeded',
  phase: 'done',
  created_at: '2026-08-01T10:00:00Z',
  started_at: null,
  finished_at: null,
  exit_code: 0,
  error: null,
  experiment_name: 'aion-r1',
  model: 'lightgbm',
  handler: 'Alpha158',
  universe: 'top500',
  benchmark: 'SPY',
  data_store: 'us',
  topk: 50,
  n_drop: 5,
  ...extra,
})

const report = (extra: Partial<RunReport> = {}): RunReport => ({
  recorder_id: 'rec1',
  experiment_name: 'aion-r1',
  metrics: {},
  risk: {},
  curves: {},
  run: run(),
  ...extra,
})

const series = (values: (number | null)[]): CurvePoint[] =>
  values.map((value, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value }))

describe('previewTier: non-succeeded runs', () => {
  it('shows the status, without a hint for a run still going', () => {
    const tier = previewTier(run({ status: 'running' }), undefined)
    expect(tier).toEqual({ kind: 'status', status: 'running', hint: null })
  })

  it('prefers the diagnosed hint for a failure, falling back to the raw error', () => {
    const failed = run({ status: 'failed', error: 'Traceback…', error_hint: 'The run ran past the calendar.' })
    expect(previewTier(failed, undefined)).toEqual({
      kind: 'status',
      status: 'failed',
      hint: 'The run ran past the calendar.',
    })

    const raw = run({ status: 'failed', error: 'Traceback…', error_hint: null })
    expect(previewTier(raw, undefined)).toMatchObject({ kind: 'status', hint: 'Traceback…' })
  })
})

describe('previewTier: curve', () => {
  it('draws the excess curve when the report carries one', () => {
    const tier = previewTier(run(), report({ curves: { excess: series([0, 0.01, 0.02, 0.015]) } }))
    expect(tier.kind).toBe('curve')
    if (tier.kind !== 'curve') return
    expect(tier.values).toEqual([0, 0.01, 0.02, 0.015])
  })

  it('falls back to the strategy curve when excess is absent', () => {
    const tier = previewTier(run(), report({ curves: { strategy: series([0, 0.05, 0.03]) } }))
    expect(tier.kind).toBe('curve')
    if (tier.kind !== 'curve') return
    expect(tier.values).toEqual([0, 0.05, 0.03])
  })

  it('decimates a long series to card size', () => {
    const long = series(Array.from({ length: 500 }, (_, i) => i / 500))
    const tier = previewTier(run(), report({ curves: { excess: long } }))
    if (tier.kind !== 'curve') throw new Error(`expected curve, got ${tier.kind}`)
    expect(tier.values.length).toBeLessThanOrEqual(40)
    // LTTB always keeps the endpoints.
    expect(tier.values[0]).toBe(0)
    expect(tier.values[tier.values.length - 1]).toBe(499 / 500)
  })

  it('keeps nulls, so gaps in the data stay visible gaps', () => {
    const tier = previewTier(run(), report({ curves: { excess: series([0, null, 0.02, 0.03]) } }))
    if (tier.kind !== 'curve') throw new Error(`expected curve, got ${tier.kind}`)
    expect(tier.values).toContain(null)
  })

  it('carries the report metrics row alongside the curve', () => {
    const tier = previewTier(
      run(),
      report({
        curves: { excess: series([0, 0.01, 0.02]) },
        risk: { excess_return_with_cost: { information_ratio: 1.2, annualized_return: 0.15, max_drawdown: -0.08 } },
      }),
    )
    if (tier.kind !== 'curve') throw new Error(`expected curve, got ${tier.kind}`)
    expect(tier.row.ir).toBe(1.2)
    expect(tier.row.annualised).toBe(0.15)
  })

  it('refuses a curve with fewer than two finite points', () => {
    const tier = previewTier(run(), report({ curves: { excess: series([0.01, null, null]) } }))
    expect(tier.kind).not.toBe('curve')
  })
})

describe('previewTier: stats', () => {
  it('reads the summary snapshot while the report is still in flight', () => {
    const tier = previewTier(
      run({ summary: { information_ratio: 0.9, annualized_return: 0.12, max_drawdown: -0.1, std: 0.05 } }),
      undefined,
    )
    expect(tier.kind).toBe('stats')
    if (tier.kind !== 'stats') return
    expect(tier.row.ir).toBe(0.9)
  })

  it('uses report metrics when the report has numbers but no curves (snapshot fallback)', () => {
    const tier = previewTier(
      run(),
      report({ risk: { excess_return_with_cost: { information_ratio: 1.5, annualized_return: 0.2, max_drawdown: -0.05 } } }),
    )
    expect(tier.kind).toBe('stats')
    if (tier.kind !== 'stats') return
    expect(tier.row.ir).toBe(1.5)
  })
})

describe('previewTier: facts', () => {
  it('describes the run when nothing numeric was recorded', () => {
    const tier = previewTier(run(), null)
    expect(tier.kind).toBe('facts')
    if (tier.kind !== 'facts') return
    expect(tier.lines).toEqual([
      { label: 'Model', value: 'lightgbm' },
      { label: 'Features', value: 'Alpha158' },
      { label: 'Universe', value: 'top500' },
      { label: 'Benchmark', value: 'SPY' },
      { label: 'Portfolio', value: 'Top 50 · drop 5' },
    ])
  })

  it('omits fields the run never recorded', () => {
    const sparse = run({ model: undefined, universe: undefined, benchmark: undefined, topk: undefined, n_drop: undefined })
    const tier = previewTier(sparse, null)
    if (tier.kind !== 'facts') throw new Error(`expected facts, got ${tier.kind}`)
    expect(tier.lines).toEqual([{ label: 'Features', value: 'Alpha158' }])
  })

  it('still yields a line for a run with no metadata at all', () => {
    const bare = run({
      model: undefined,
      handler: undefined,
      universe: undefined,
      benchmark: undefined,
      topk: undefined,
      n_drop: undefined,
    })
    const tier = previewTier(bare, null)
    if (tier.kind !== 'facts') throw new Error(`expected facts, got ${tier.kind}`)
    expect(tier.lines.length).toBeGreaterThanOrEqual(1)
  })

  it('names the custom columns for a replace-mode run', () => {
    const replace = run({ feature_mode: 'replace', feature_count: 3, model: undefined, universe: undefined, benchmark: undefined, topk: undefined })
    const tier = previewTier(replace, null)
    if (tier.kind !== 'facts') throw new Error(`expected facts, got ${tier.kind}`)
    expect(tier.lines).toContainEqual({ label: 'Features', value: '3 custom columns' })
  })
})
