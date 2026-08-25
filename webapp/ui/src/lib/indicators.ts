import type { Bar } from '@/lib/api'
export type { Bar }

export interface RsiPoint {
  time: string
  rsi: number
}

/**
 * Wilder's RSI over closing prices.
 *
 * @param bars sorted ascending by time
 * @param period lookback window (default 14)
 */
export function computeRSI(bars: Bar[], period = 14): RsiPoint[] {
  if (bars.length < period + 1) return []
  const closes = bars.map((b) => b.close).filter((c): c is number => c != null)
  if (closes.length < period + 1) return []

  const result: RsiPoint[] = []
  let avgGain = 0
  let avgLoss = 0

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) avgGain += change
    else avgLoss -= change
  }
  avgGain /= period
  avgLoss /= period

  const firstIndex = bars.findIndex((b) => b.close === closes[period])
  result.push({ time: bars[firstIndex].time, rsi: rsiFromAverages(avgGain, avgLoss) })

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    const barIndex = bars.findIndex((b) => b.close === closes[i])
    result.push({ time: bars[barIndex].time, rsi: rsiFromAverages(avgGain, avgLoss) })
  }

  return result
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export interface MacdPoint {
  time: string
  macd: number
  signal: number
  histogram: number
}

/**
 * MACD with EMA-based signal line.
 *
 * @param bars sorted ascending by time
 * @param fast fast EMA period (default 12)
 * @param slow slow EMA period (default 26)
 * @param signal signal-line EMA period (default 9)
 */
export function computeMACD(
  bars: Bar[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdPoint[] {
  const closes = bars.map((b) => b.close).filter((c): c is number => c != null)
  if (closes.length < slow + signal) return []

  const fastEMA = ema(closes, fast)
  const slowEMA = ema(closes, slow)
  const macdLine = fastEMA.map((v, i) => v - slowEMA[i])

  const firstValid = macdLine.findIndex((v) => !Number.isNaN(v))
  const validMacd = macdLine.slice(firstValid)
  const validSignal = ema(validMacd, signal)
  const signalLine = new Array(macdLine.length).fill(NaN)
  validSignal.forEach((v, i) => {
    signalLine[firstValid + i] = v
  })

  const result: MacdPoint[] = []
  for (let i = 0; i < macdLine.length; i++) {
    if (Number.isNaN(macdLine[i]) || Number.isNaN(signalLine[i])) continue
    const barIndex = bars.findIndex((b) => b.close === closes[i])
    result.push({
      time: bars[barIndex].time,
      macd: macdLine[i],
      signal: signalLine[i],
      histogram: macdLine[i] - signalLine[i],
    })
  }
  return result
}

function ema(values: number[], period: number): number[] {
  if (values.length < period) return new Array(values.length).fill(NaN)
  const k = 2 / (period + 1)
  const out: number[] = new Array(values.length).fill(NaN)
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export interface MonteCarloPath {
  dates: string[]
  values: number[]
}

export interface MonteCarloResult {
  paths: MonteCarloPath[]
  meanPath: MonteCarloPath
  p05: MonteCarloPath
  p95: MonteCarloPath
  currentPrice: number
  annualizedReturn: number
  annualizedVolatility: number
}

/**
 * Geometric Brownian Motion Monte Carlo simulation.
 *
 * @param bars sorted ascending by time
 * @param simulations number of paths (default 100)
 * @param days forward projection in trading days (default 30)
 */
export function computeMonteCarlo(
  bars: Bar[],
  simulations = 100,
  days = 30,
): MonteCarloResult | null {
  const closes = bars.map((b) => b.close).filter((c): c is number => c != null)
  if (closes.length < 30 || simulations < 1 || days < 1) return null

  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]))
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length
  const std = Math.sqrt(variance)

  const lastPrice = closes[closes.length - 1]
  const lastDate = new Date(bars[bars.length - 1].time)

  const paths: MonteCarloPath[] = []
  for (let s = 0; s < simulations; s++) {
    const values: number[] = [lastPrice]
    const dates: string[] = [formatTradingDate(lastDate, 0)]
    let price = lastPrice
    for (let d = 1; d <= days; d++) {
      const z = boxMuller()
      price = price * Math.exp((mean - 0.5 * variance) + std * z)
      values.push(price)
      dates.push(formatTradingDate(lastDate, d))
    }
    paths.push({ dates, values })
  }

  const meanPath = percentilePath(paths, 0.5)
  const p05 = percentilePath(paths, 0.05)
  const p95 = percentilePath(paths, 0.95)

  const tradingDaysPerYear = 252
  return {
    paths,
    meanPath,
    p05,
    p95,
    currentPrice: lastPrice,
    annualizedReturn: mean * tradingDaysPerYear,
    annualizedVolatility: std * Math.sqrt(tradingDaysPerYear),
  }
}

function percentilePath(paths: MonteCarloPath[], q: number): MonteCarloPath {
  const days = paths[0].values.length
  const dates = paths[0].dates
  const values: number[] = []
  for (let d = 0; d < days; d++) {
    const dayValues = paths.map((p) => p.values[d]).sort((a, b) => a - b)
    const idx = Math.max(0, Math.min(dayValues.length - 1, Math.floor(q * dayValues.length)))
    values.push(dayValues[idx])
  }
  return { dates, values }
}

function boxMuller(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

function formatTradingDate(base: Date, offsetDays: number): string {
  const d = new Date(base)
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().split('T')[0]
}
