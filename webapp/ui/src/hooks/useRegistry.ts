import { useCallback, useEffect, useRef, useState } from 'react'

import {
  api, type CatalogFacets, type CatalogQuery, type RegistryPage, type RegistrySummary,
  type RosterKind,
} from '@/lib/api'
import type { BrowserQuery } from '@/components/database/CatalogBrowser'

/**
 * The roster's data hooks — the registry twins of `useCatalog`.
 *
 * Same shape, same out-of-order guard, same debounce, because they are handed
 * to the same browser component and a difference between them would show up as
 * one page behaving oddly rather than as a type error.
 *
 * They are separate files rather than one parameterised module because the
 * *reason* they exist is different: the catalog talks to an index that answers
 * in a millisecond, the registry talks to four services behind a server-side
 * TTL. If either ever needs its own caching or retry policy, it has somewhere
 * to put it.
 */

const DEBOUNCE_MS = 200

export interface RegistrySearchState {
  page: RegistryPage | null
  loading: boolean
  error: string | null
}

export function useRegistrySearch(query: BrowserQuery): RegistrySearchState {
  const [page, setPage] = useState<RegistryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const key = JSON.stringify(query)
  const seq = useRef(0)
  const latest = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    setLoading(true)
    const timer = setTimeout(() => {
      api.registrySearch(JSON.parse(key) as CatalogQuery)
        .then((result) => {
          // Out-of-order guard: a slow "op" must not overwrite a fast
          // "options" and leave the table disagreeing with the box above it.
          if (mine < latest.current) return
          latest.current = mine
          setPage(result)
          setError(null)
          setLoading(false)
        })
        .catch((e: unknown) => {
          if (mine < latest.current) return
          latest.current = mine
          setError(e instanceof Error ? e.message : 'Search failed')
          setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [key])

  return { page, loading, error }
}

export function useRegistryFacets(kind?: string): CatalogFacets | null {
  const [facets, setFacets] = useState<CatalogFacets | null>(null)

  useEffect(() => {
    let cancelled = false
    // Cleared on a kind change: a facet rail describing the previous collection
    // offers filters that return nothing, as if they would work.
    setFacets(null)
    api.registryFacets(kind as RosterKind | undefined)
      .then((r) => { if (!cancelled) setFacets(r) })
      .catch(() => { if (!cancelled) setFacets(null) })
    return () => { cancelled = true }
  }, [kind])

  return facets
}

export interface RegistrySummaryState {
  summary: RegistrySummary | null
  loading: boolean
  error: string | null
  /** Re-read the summary without busting the server's cache. */
  reload: () => void
  /** Drop the server's TTL cache and re-fan-out. */
  refresh: () => Promise<void>
  refreshing: boolean
}

export function useRegistrySummary(): RegistrySummaryState {
  const [summary, setSummary] = useState<RegistrySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.registrySummary()
      .then((r) => { if (!cancelled) { setSummary(r); setError(null) } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read the roster')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      // The endpoint refreshes and returns the new summary in one call, so
      // there is no window where the page shows the old counts as if fresh.
      setSummary(await api.registryRefresh())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [])

  return { summary, loading, error, reload, refresh, refreshing }
}
