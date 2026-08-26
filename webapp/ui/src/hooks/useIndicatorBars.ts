import { useEffect, useState } from 'react'
import { api, type Bar, type BarsResponse } from '@/lib/api'

interface UseIndicatorBarsResult {
  bars: Bar[]
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Fetch daily bars for a single symbol, sorted ascending by time.
 *
 * The default lookback is ~1 year of trading days. Pass an explicit `days`
 * to fetch more or less history.
 */
export function useIndicatorBars(symbol: string, days = 365): UseIndicatorBarsResult {
  const [response, setResponse] = useState<BarsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchBars = () => {
    if (!symbol.trim()) {
      setResponse(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    const end = new Date().toISOString().split('T')[0]
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    api
      .bars(symbol.trim().toUpperCase(), { start, end, adjusted: true })
      .then((r) => {
        const sorted = [...r.bars].sort(
          (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
        )
        setResponse({ ...r, bars: sorted })
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load price data')
        setResponse(null)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchBars()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, days])

  return {
    bars: response?.bars ?? [],
    loading,
    error,
    refetch: fetchBars,
  }
}
