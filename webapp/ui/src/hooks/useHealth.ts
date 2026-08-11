import { useCallback, useEffect, useState } from 'react'
import { api, type Health } from '@/lib/api'

/**
 * Data-layer status, polled slowly.
 *
 * Every page needs to know whether qlib actually mounted a store and which one
 * — an empty chart because the US store hasn't been ingested yet must never be
 * indistinguishable from an empty chart because the query returned nothing.
 */
export function useHealth(pollMs = 30_000) {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setHealth(await api.health())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'API unreachable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (!pollMs) return
    const id = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(id)
  }, [refresh, pollMs])

  return { health, error, loading, refresh }
}
