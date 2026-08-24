import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Indicator, type IndicatorsResponse, type ModelsResponse, type PositionTrade, type Run } from '@/lib/api'

const OVERLAY_COLORS = [
  '#22c55e', // green
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#ec4899', // pink
]

const MAX_INDICATORS = 5
const MAX_RUNS = 3

export interface IndicatorOverlay {
  name: string
  color: string
  data: { time: string; value: number | null }[]
}

export interface SignalMarker {
  time: string
  direction: 'long' | 'short' | 'close'
  text?: string
}

export function useChartOverlays(
  symbol: string,
  start: string | undefined,
  store: 'qlib' | 'market',
) {
  const [library, setLibrary] = useState<IndicatorsResponse | null>(null)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  const [selectedIndicators, setSelectedIndicators] = useState<string[]>([])
  const [selectedRuns, setSelectedRuns] = useState<string[]>([])

  const [indicatorData, setIndicatorData] = useState<IndicatorOverlay[]>([])
  const [signals, setSignals] = useState<SignalMarker[]>([])
  const [dataLoading, setDataLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load the indicator library once.
  useEffect(() => {
    setLibraryLoading(true)
    api
      .indicators()
      .then(setLibrary)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load indicators'))
      .finally(() => setLibraryLoading(false))
  }, [])

  // Load models and finished runs once.
  useEffect(() => {
    setRunsLoading(true)
    Promise.all([
      api.models().then(setModels).catch(() => undefined),
      api
        .listRuns(500)
        .then((r) => setRuns(r.runs.filter((run) => run.status === 'succeeded')))
        .catch(() => undefined),
    ]).finally(() => setRunsLoading(false))
  }, [])

  const indicatorByName = useMemo(() => {
    const map = new Map<string, Indicator>()
    library?.indicators.forEach((i) => map.set(i.name, i))
    return map
  }, [library])

  // Evaluate selected indicators for the current symbol/range.
  useEffect(() => {
    if (!selectedIndicators.length || store !== 'qlib') {
      setIndicatorData([])
      return
    }
    const expressions = selectedIndicators
      .map((name) => indicatorByName.get(name)?.expression)
      .filter((e): e is string => Boolean(e))
    if (!expressions.length) return

    let cancelled = false
    setDataLoading(true)
    setError(null)
    api
      .features({ instruments: [symbol], fields: expressions, start })
      .then((res) => {
        if (cancelled) return
        const out: IndicatorOverlay[] = selectedIndicators.map((name, idx) => {
          const expression = expressions[idx]
          const colIndex = res.columns.indexOf(expression)
          const color = OVERLAY_COLORS[idx % OVERLAY_COLORS.length]
          return {
            name,
            color,
            data: res.rows.map((row) => ({
              time: row.date,
              value: colIndex >= 0 ? row.values[colIndex] ?? null : null,
            })),
          }
        })
        setIndicatorData(out)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to evaluate indicators')
        setIndicatorData([])
      })
      .finally(() => {
        if (!cancelled) setDataLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedIndicators, symbol, start, store, indicatorByName])

  // Fetch position/trade markers for selected runs.
  useEffect(() => {
    if (!selectedRuns.length) {
      setSignals([])
      return
    }
    let cancelled = false
    setDataLoading(true)
    setError(null)
    Promise.all(
      selectedRuns.map((runId) => api.runPositions(runId, { instrument: symbol })),
    )
      .then((results) => {
        if (cancelled) return
        const markers: SignalMarker[] = results
          .flatMap((res) =>
            res.trades
              .filter((t) => t.instrument.toUpperCase() === symbol.toUpperCase())
              .map((t) => tradeToMarker(t)),
          )
          .sort((a, b) => a.time.localeCompare(b.time))
        setSignals(markers)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load model signals')
        setSignals([])
      })
      .finally(() => {
        if (!cancelled) setDataLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedRuns, symbol])

  const toggleIndicator = useCallback((name: string) => {
    setSelectedIndicators((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name)
      if (prev.length >= MAX_INDICATORS) return prev
      return [...prev, name]
    })
  }, [])

  const toggleRun = useCallback((runId: string) => {
    setSelectedRuns((prev) => {
      if (prev.includes(runId)) return prev.filter((id) => id !== runId)
      if (prev.length >= MAX_RUNS) return prev
      return [...prev, runId]
    })
  }, [])

  const groupedRuns = useMemo(() => {
    const groups = new Map<string, Run[]>()
    models?.models.forEach((m) => groups.set(m.id, []))
    groups.set('other', [])
    runs.forEach((run) => {
      const key = run.model && groups.has(run.model) ? run.model : 'other'
      groups.get(key)!.push(run)
    })
    return Array.from(groups.entries())
      .filter(([, rs]) => rs.length)
      .map(([modelId, rs]) => ({
        modelId,
        label: models?.models.find((m) => m.id === modelId)?.label ?? modelId,
        runs: rs,
      }))
  }, [models, runs])

  return {
    library,
    libraryLoading,
    models,
    runs,
    groupedRuns,
    runsLoading,
    selectedIndicators,
    selectedRuns,
    indicatorData,
    signals,
    dataLoading,
    error,
    toggleIndicator,
    toggleRun,
  }
}

function tradeToMarker(t: PositionTrade): SignalMarker {
  if (t.direction === 'close' || (t.delta ?? 0) === 0) {
    return { time: t.date, direction: 'close' }
  }
  return { time: t.date, direction: t.delta! > 0 ? 'long' : 'short' }
}
