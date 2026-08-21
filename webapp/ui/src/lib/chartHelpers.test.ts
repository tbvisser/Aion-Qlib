import { describe, expect, it } from 'vitest'
import { toHeikinAshi, withAlpha } from './chartHelpers'

describe('toHeikinAshi', () => {
  it('computes Heikin-Ashi candles', () => {
    const bars = [
      { time: '2024-01-01', open: 10, high: 12, low: 9, close: 11 },
      { time: '2024-01-02', open: 11, high: 14, low: 10, close: 13 },
    ]
    const ha = toHeikinAshi(bars)

    // First bar: open stays the raw open, close is average of OHLC.
    expect(ha[0]).toEqual({
      time: '2024-01-01',
      open: 10,
      high: 12,
      low: 9,
      close: 10.5,
    })

    // Second bar: open is midpoint of previous HA open/close.
    expect(ha[1].open).toBe((10 + 10.5) / 2)
    expect(ha[1].close).toBe((11 + 14 + 10 + 13) / 4)
    expect(ha[1].high).toBe(Math.max(14, ha[1].open, ha[1].close))
    expect(ha[1].low).toBe(Math.min(10, ha[1].open, ha[1].close))
  })

  it('skips incomplete bars', () => {
    const bars = [
      { time: '2024-01-01', open: 10, high: 12, low: null, close: 11 },
      { time: '2024-01-02', open: 11, high: 14, low: 10, close: 13 },
    ]
    const ha = toHeikinAshi(bars)
    expect(ha).toHaveLength(1)
    expect(ha[0].time).toBe('2024-01-02')
  })
})

describe('withAlpha', () => {
  it('adds an alpha channel to an hsl string', () => {
    expect(withAlpha('hsl(150 80% 50%)', 0.35)).toBe('hsl(150 80% 50% / 0.35)')
  })
})
