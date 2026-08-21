/**
 * Client-side Markov Chain engine used only for demo fallback.
 *
 * When the backend has no market data for a symbol (qlib store not mounted and
 * Yahoo unavailable), this module produces a deterministic synthetic price path
 * and runs the exact same observable Markov Chain math as
 * `webapp.api.markov_chain`. The result shape is identical to
 * `MarkovAnalyzeResponse` so the UI can render it without branching.
 */
import type { MarkovAnalyzeResponse } from '@/lib/api'

export interface MarkovParams {
  symbol: string
  window: number
  bull: number
  bear: number
  lookback: number
  steps?: number[]
}

const STATE_NAMES = ['Bull', 'Bear', 'Sideways'] as const

/** Deterministic hash so the same symbol always yields the same demo path. */
function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randn(rand: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Build a synthetic return series with persistent regimes so the demo looks real. */
function generateDemoReturns(symbol: string, n = 1500): { dates: string[]; returns: number[] } {
  const rand = mulberry32(hashString(symbol.toUpperCase()) + 7)
  const today = new Date()
  const dates: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    dates.push(formatDate(addDays(today, -i)))
  }

  // Hidden 3-state regime chain with strong persistence.
  const regimeP = [
    [0.96, 0.025, 0.015],
    [0.03, 0.94, 0.03],
    [0.04, 0.04, 0.92],
  ]
  const regimeMean = [0.0008, -0.0007, 0.0001]
  const regimeVol = [0.009, 0.018, 0.006]

  let state = 0
  const returns: number[] = []
  for (let i = 0; i < n; i++) {
    const r = rand()
    let cum = 0
    for (let j = 0; j < 3; j++) {
      cum += regimeP[state][j]
      if (r < cum) {
        state = j
        break
      }
    }
    returns.push(regimeMean[state] + regimeVol[state] * randn(rand))
  }

  return { dates, returns }
}

function labelStates(returns: number[], window: number, bull: number, bear: number): (number | null)[] {
  const states: (number | null)[] = new Array(returns.length).fill(null)
  let sum = 0
  for (let i = 0; i < returns.length; i++) {
    sum += returns[i]
    if (i >= window) sum -= returns[i - window]
    if (i >= window - 1) {
      if (sum > bull) states[i] = 0
      else if (sum < bear) states[i] = 1
      else states[i] = 2
    }
  }
  return states
}

function estimateTransitionMatrix(states: (number | null)[]): number[][] {
  const n = 3
  const counts = Array.from({ length: n }, () => Array(n).fill(0))
  for (let i = 0; i < states.length - 1; i++) {
    const a = states[i]
    const b = states[i + 1]
    if (a !== null && b !== null) counts[a][b] += 1
  }
  const P = Array.from({ length: n }, () => Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    const rowSum = counts[i].reduce((s, v) => s + v, 0)
    if (rowSum > 0) {
      for (let j = 0; j < n; j++) P[i][j] = counts[i][j] / rowSum
    } else {
      for (let j = 0; j < n; j++) P[i][j] = 1 / n
    }
  }
  return P
}

function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length
  const C = Array.from({ length: n }, () => Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      if (A[i][k] === 0) continue
      for (let j = 0; j < n; j++) {
        C[i][j] += A[i][k] * B[k][j]
      }
    }
  }
  return C
}

function matPow(P: number[][], power: number): number[][] {
  let R = P.map((row) => [...row])
  for (let i = 1; i < power; i++) {
    R = matMul(R, P)
  }
  return R
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let i = 0; i < n; i++) {
    let pivot = i
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r
    }
    ;[M[i], M[pivot]] = [M[pivot], M[i]]
    const piv = M[i][i]
    if (Math.abs(piv) < 1e-12) {
      // Singular → uniform fallback.
      return Array(n).fill(1 / n)
    }
    for (let c = i; c <= n; c++) M[i][c] /= piv
    for (let r = 0; r < n; r++) {
      if (r === i) continue
      const factor = M[r][i]
      for (let c = i; c <= n; c++) M[r][c] -= factor * M[i][c]
    }
  }
  return M.map((row) => row[n])
}

function stationaryDistribution(P: number[][]): number[] {
  const n = P.length
  const A = P[0].map((_, j) => P.map((row) => row[j])).map((col, j) =>
    col.map((v, i) => (i === j ? v - 1 : v))
  )
  A[n - 1] = Array(n).fill(1)
  const b = Array(n).fill(0)
  b[n - 1] = 1
  return solveLinear(A, b)
}

function positionFromSignal(signal: number, deadband = 0.1, saturate = 0.3): number {
  if (signal > saturate) return 1
  if (signal < -saturate) return -1
  if (Math.abs(signal) < deadband) return 0
  const sign = signal > 0 ? 1 : -1
  return sign * (Math.abs(signal) - deadband) / (saturate - deadband)
}

interface SignalPoint {
  date: string
  state: number
  signal: number
  position: number
  bull_prob: number
  bear_prob: number
  sideways_prob: number
}

function walkforwardSignals(
  dates: string[],
  _returns: number[],
  states: (number | null)[],
  lookback: number,
  deadband = 0.1,
  saturate = 0.3,
): SignalPoint[] {
  const signals: SignalPoint[] = []
  for (let i = lookback; i < states.length; i++) {
    const hist = states.slice(i - lookback, i)
    const P = estimateTransitionMatrix(hist)
    const current = states[i]
    if (current === null) continue
    const probs = P[current]
    const signal = probs[0] - probs[1]
    signals.push({
      date: dates[i],
      state: current,
      signal,
      position: positionFromSignal(signal, deadband, saturate),
      bull_prob: probs[0],
      bear_prob: probs[1],
      sideways_prob: probs[2],
    })
  }
  return signals
}

function clean(value: number | null): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value)) return null
  return value
}

export function computeDemoMarkov(params: MarkovParams): MarkovAnalyzeResponse {
  const { symbol, window, bull, bear, lookback } = params
  const steps = params.steps ?? [1, 5, 12, 24]
  const { dates, returns } = generateDemoReturns(symbol, lookback + window + 400)
  const states = labelStates(returns, window, bull, bear)

  const validStates = states.filter((s): s is number => s !== null)
  if (validStates.length === 0) {
    throw new Error('Not enough returns to estimate a transition matrix')
  }

  const P = estimateTransitionMatrix(states)
  const currentState = validStates[validStates.length - 1]

  const forecasts: Record<string, { bull: number | null; bear: number | null; sideways: number | null }> = {}
  for (const step of steps) {
    const Pn = matPow(P, step)
    const probs = Pn[currentState]
    forecasts[String(step)] = {
      bull: clean(probs[0]),
      bear: clean(probs[1]),
      sideways: clean(probs[2]),
    }
  }

  const pi = stationaryDistribution(P)
  const signalSeries = walkforwardSignals(dates, returns, states, lookback)

  let equityCurve: { date: string; equity: number | null }[] = []
  let backtestMetrics: {
    annualized_return: number | null
    annualized_sharpe: number | null
    max_drawdown: number | null
    n_days: number
  } = { annualized_return: null, annualized_sharpe: null, max_drawdown: null, n_days: 0 }

  if (signalSeries.length > 1) {
    const stratReturns: number[] = []
    const equityDates: string[] = []
    // signalSeries[k] corresponds to date index i = lookback + k.
    // Shift position by one day: position at i is applied to return at i+1.
    let equity = 1
    for (let k = 0; k < signalSeries.length - 1; k++) {
      const i = lookback + k
      const position = signalSeries[k].position
      const r = returns[i + 1]
      const sr = position * r
      stratReturns.push(sr)
      equity *= 1 + sr
      equityDates.push(dates[i + 1])
    }

    if (stratReturns.length > 0) {
      const mean = stratReturns.reduce((s, v) => s + v, 0) / stratReturns.length
      const std = Math.sqrt(stratReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / stratReturns.length)
      const runningMax: number[] = []
      let max = -Infinity
      let maxDd = 0
      let cum = 1
      for (const r of stratReturns) {
        cum *= 1 + r
        max = Math.max(max, cum)
        runningMax.push(max)
        maxDd = Math.min(maxDd, (cum - max) / max)
      }
      backtestMetrics = {
        annualized_return: clean(mean * 252),
        annualized_sharpe: clean(std === 0 ? null : (mean / std) * Math.sqrt(252)),
        max_drawdown: clean(maxDd),
        n_days: stratReturns.length,
      }
      equityCurve = equityDates.map((d, i) => {
        let cum = 1
        for (let j = 0; j <= i; j++) cum *= 1 + stratReturns[j]
        return { date: d, equity: clean(cum) }
      })
    }
  }

  const regimeCounts: Record<string, number> = { Bull: 0, Bear: 0, Sideways: 0 }
  for (const s of validStates) {
    regimeCounts[STATE_NAMES[s]] += 1
  }

  const latest = signalSeries[signalSeries.length - 1]

  return {
    symbol: symbol.toUpperCase(),
    as_of: dates[dates.length - 1],
    source: 'demo',
    parameters: { window, bull_threshold: bull, bear_threshold: bear, lookback },
    current_state: STATE_NAMES[currentState],
    transition_matrix: STATE_NAMES.map((from, i) => ({
      from,
      to: Object.fromEntries(STATE_NAMES.map((name, j) => [name, clean(P[i][j])])) as Record<string, number | null>,
    })),
    forecasts,
    stationary_distribution: {
      Bull: clean(pi[0]),
      Bear: clean(pi[1]),
      Sideways: clean(pi[2]),
    },
    regime_counts: regimeCounts,
    latest_signal: {
      date: latest?.date ?? null,
      signal: clean(latest?.signal ?? null),
      position: clean(latest?.position ?? null),
      bull_prob: clean(latest?.bull_prob ?? null),
      bear_prob: clean(latest?.bear_prob ?? null),
      sideways_prob: clean(latest?.sideways_prob ?? null),
    },
    backtest: backtestMetrics,
    equity_curve: equityCurve,
    signal_series: signalSeries.map((s) => ({
      date: s.date,
      state: STATE_NAMES[s.state],
      signal: clean(s.signal),
      position: clean(s.position),
    })),
  }
}
