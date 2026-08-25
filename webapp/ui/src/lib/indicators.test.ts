import { describe, expect, it } from 'vitest'
import { computeMACD, computeMonteCarlo, computeRSI, type Bar } from './indicators'

function barsFromCloses(closes: number[]): Bar[] {
  const base = new Date('2024-01-01').getTime()
  return closes.map((close, i) => {
    const date = new Date(base + i * 24 * 60 * 60 * 1000)
    return {
      time: date.toISOString().split('T')[0],
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      factor: null,
      change: i === 0 ? null : close - closes[i - 1],
    }
  })
}

describe('computeRSI', () => {
  it('returns an empty array when not enough data', () => {
    expect(computeRSI(barsFromCloses([1, 2, 3]), 14)).toEqual([])
  })

  it('returns RSI values between 0 and 100', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 10)
    const rsi = computeRSI(barsFromCloses(closes), 14)
    expect(rsi.length).toBeGreaterThan(0)
    for (const point of rsi) {
      expect(point.rsi).toBeGreaterThanOrEqual(0)
      expect(point.rsi).toBeLessThanOrEqual(100)
    }
  })

  it('trends toward 100 on a sustained upward move', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 2)
    const rsi = computeRSI(barsFromCloses(closes), 14)
    expect(rsi[rsi.length - 1].rsi).toBeGreaterThan(70)
  })
})

describe('computeMACD', () => {
  it('returns an empty array when not enough data', () => {
    expect(computeMACD(barsFromCloses([1, 2, 3, 4, 5]), 12, 26, 9)).toEqual([])
  })

  it('produces histogram = macd - signal', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 20)
    const macd = computeMACD(barsFromCloses(closes), 12, 26, 9)
    expect(macd.length).toBeGreaterThan(0)
    const last = macd[macd.length - 1]
    expect(last.histogram).toBeCloseTo(last.macd - last.signal, 10)
  })
})

describe('computeMonteCarlo', () => {
  it('returns null when not enough data', () => {
    expect(computeMonteCarlo(barsFromCloses([1, 2, 3]), 100, 30)).toBeNull()
  })

  it('generates the requested number of paths and days', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 10) * 2)
    const result = computeMonteCarlo(barsFromCloses(closes), 50, 20)
    expect(result).not.toBeNull()
    expect(result!.paths).toHaveLength(50)
    expect(result!.paths[0].values).toHaveLength(21) // today + 20 forward days
  })

  it('reports p05 <= mean <= p95 at each future step', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5)
    const result = computeMonteCarlo(barsFromCloses(closes), 200, 10)
    expect(result).not.toBeNull()
    const { p05, meanPath, p95 } = result!
    for (let i = 0; i < meanPath.values.length; i++) {
      expect(p05.values[i]).toBeLessThanOrEqual(meanPath.values[i])
      expect(meanPath.values[i]).toBeLessThanOrEqual(p95.values[i])
    }
  })
})
