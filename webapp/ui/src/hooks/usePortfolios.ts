import { useCallback, useEffect, useState } from 'react'
import {
  api, type LinkedStrategy, type Portfolio, type PortfolioNav, type PortfolioSpec,
} from '@/lib/api'

export function usePortfolios() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setPortfolios((await api.listPortfolios()).portfolios)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load portfolios')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async (spec: PortfolioSpec, id?: string) => {
    const saved = await api.savePortfolio(spec, id)
    await refresh()
    return saved
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await api.deletePortfolio(id)
    await refresh()
  }, [refresh])

  return { portfolios, error, loading, refresh, save, remove }
}

export function usePortfolioNav(id: string | null) {
  const [nav, setNav] = useState<PortfolioNav | null>(null)
  const [strategies, setStrategies] = useState<LinkedStrategy[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!id) {
      setNav(null)
      setStrategies([])
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        // The NAV is the page; linked strategies are a side panel, so a
        // failure there must not blank the curve.
        const report = await api.portfolioNav(id)
        if (cancelled) return
        setNav(report)
        setError(null)
        try {
          const linked = await api.portfolioStrategies(id)
          if (!cancelled) setStrategies(linked.strategies)
        } catch {
          if (!cancelled) setStrategies([])
        }
      } catch (err) {
        if (cancelled) return
        setNav(null)
        setError(err instanceof Error ? err.message : 'Could not price this portfolio')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [id])

  return { nav, strategies, error, loading }
}
