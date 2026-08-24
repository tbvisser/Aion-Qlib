import { describe, expect, it } from 'vitest'

import { computeDemoMarkov } from './markovDemo'

describe('computeDemoMarkov', () => {
  it('produces a complete MarkovAnalyzeResponse shape for SPY', () => {
    const result = computeDemoMarkov({
      symbol: 'SPY',
      window: 20,
      bull: 0.02,
      bear: -0.02,
      lookback: 252,
    })

    expect(result.symbol).toBe('SPY')
    expect(result.source).toBe('demo')
    expect(['Bull', 'Bear', 'Sideways']).toContain(result.current_state)
    expect(result.transition_matrix).toHaveLength(3)
    expect(Object.keys(result.forecasts)).toContain('1')
    expect(Object.keys(result.stationary_distribution)).toEqual(['Bull', 'Bear', 'Sideways'])
    expect(result.equity_curve.length).toBeGreaterThan(0)
    expect(result.signal_series.length).toBeGreaterThan(0)
    expect(result.latest_signal.signal).not.toBeNull()
    expect(result.backtest.n_days).toBeGreaterThan(0)
  })

  it('returns the same regime counts as signal states', () => {
    const result = computeDemoMarkov({ symbol: 'QQQ', window: 20, bull: 0.02, bear: -0.02, lookback: 252 })
    const total = Object.values(result.regime_counts).reduce((s, v) => s + v, 0)
    expect(total).toBeGreaterThan(0)
    expect(result.signal_series.every((s) => ['Bull', 'Bear', 'Sideways'].includes(s.state))).toBe(true)
  })
})
