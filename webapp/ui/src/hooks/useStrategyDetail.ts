import { useEffect, useState } from 'react'

import { api, type Portfolio, type Run, type StoredStrategy } from '@/lib/api'

interface CacheEntry {
  strategy: StoredStrategy
  runs: Run[]
  portfolios: Portfolio[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

/**
 * Load a strategy, its runs and the portfolios that feed it.
 *
 * Caches the result for the session so navigating back to the detail page
 * does not flash a spinner every time. The cache is invalidated after one
 * minute, and a manual refresh (or re-running the strategy) re-fetches.
 */
export function useStrategyDetail(strategyId: string | undefined) {
  const [strategy, setStrategy] = useState<StoredStrategy | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    if (!strategyId) return
    setLoading(true)
    setError(null)
    try {
      const [s, r, p] = await Promise.all([
        api.getStrategy(strategyId),
        api.listRuns(1000).then((res) =>
          res.runs.filter((run) => run.strategy_id === strategyId)),
        api.listPortfolios().then((res) =>
          (res.portfolios ?? []).filter((portfolio) =>
            (portfolio.strategy_ids ?? []).includes(strategyId))),
      ])
      cache.set(strategyId, { strategy: s, runs: r, portfolios: p, fetchedAt: Date.now() })
      setStrategy(s)
      setRuns(r)
      setPortfolios(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load strategy')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!strategyId) return
    const cached = cache.get(strategyId)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setStrategy(cached.strategy)
      setRuns(cached.runs)
      setPortfolios(cached.portfolios)
      setLoading(false)
      return
    }
    void refresh()
  }, [strategyId])

  return {
    strategy,
    runs,
    portfolios,
    loading,
    error,
    refresh,
  }
}
