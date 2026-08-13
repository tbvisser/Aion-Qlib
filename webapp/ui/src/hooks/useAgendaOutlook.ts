import { useCallback, useEffect, useRef, useState } from 'react'

import { api, type AgendaOutlook } from '@/lib/api'
import { outlookCacheKey, type OutlookScope } from '@/lib/agendaOutlook'

interface OutlookState {
  data: AgendaOutlook | null
  loading: boolean
  error: string | null
}

const CACHE = new Map<string, AgendaOutlook>()

/**
 * Fetch and cache an AI outlook for a scope anchored on a selected day.
 *
 * The cache is in-memory only; the backend already caches generated summaries
 * in Postgres. This layer just prevents duplicate fetches when the user tabs
 * back and forth.
 *
 * State is keyed to (scope, anchor): switching scope or day resets the panel
 * to the cached value (if any) and starts a fresh fetch, so stale data from a
 * previous selection never lingers under a new label.
 */
export function useAgendaOutlook(scope: OutlookScope, anchor: string) {
  const key = outlookCacheKey(scope, anchor)
  const currentKey = useRef(key)

  const [state, setState] = useState<OutlookState>(() => ({
    data: CACHE.get(key) ?? null,
    loading: !CACHE.has(key),
    error: null,
  }))

  // When the key changes, reset to the cache entry for the new key (or a fresh
  // loading state) immediately rather than showing the previous key's data.
  if (key !== currentKey.current) {
    currentKey.current = key
    const cached = CACHE.get(key)
    setState({ data: cached ?? null, loading: !CACHE.has(key), error: null })
  }

  const load = useCallback(async (force = false) => {
    if (!force && CACHE.has(key)) {
      setState({ data: CACHE.get(key)!, loading: false, error: null })
      return
    }

    setState({ data: null, loading: true, error: null })
    try {
      const data = await api.agendaOutlook({ scope, date: anchor, force })
      CACHE.set(key, data)
      // Guard against a stale update if the scope/anchor changed mid-flight.
      if (currentKey.current === key) {
        setState({ data, loading: false, error: null })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load outlook'
      if (currentKey.current === key) {
        setState({ data: null, loading: false, error: message })
      }
    }
  }, [key, scope, anchor])

  useEffect(() => {
    void load()
  }, [load])

  const regenerate = useCallback(async () => {
    await load(true)
  }, [load])

  return {
    ...state,
    regenerate,
  }
}
