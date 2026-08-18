import { useCallback, useEffect, useRef, useState } from 'react'

import { api, type CatalogFacets, type CatalogKind, type CatalogPage, type CatalogQuery, type CatalogSummary } from '@/lib/api'
import type { BrowserQuery } from '@/components/database/CatalogBrowser'

/**
 * The Database page's two data hooks.
 *
 * `useCatalogSearch` is the one with the interesting problem: the search box
 * fires a request per keystroke, and responses come back out of order. A slow
 * query for "mo" landing after a fast one for "momentum" would replace the right
 * results with stale ones — so every request carries a sequence number and a
 * response older than the one already shown is dropped rather than rendered.
 *
 * Results are held through a refetch instead of cleared. Blanking the table on
 * every keystroke makes a fast search flicker, and the row count is the thing
 * the user is watching change.
 */

const DEBOUNCE_MS = 200

export interface CatalogSearchState {
  page: CatalogPage | null
  loading: boolean
  error: string | null
  refetch: () => void
}

// Takes the browser's loosely-typed query rather than `CatalogQuery` so it can
// be handed to `CatalogBrowser` as its `useData`. The server validates `kind`
// against the indexed set and 400s on anything else, so the narrowing this
// gives up was never the thing keeping a bad kind out.
export function useCatalogSearch(query: BrowserQuery): CatalogSearchState {
  const [page, setPage] = useState<CatalogPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  // Serialised so the effect depends on the query's *value*, not on a fresh
  // object identity every render.
  const key = JSON.stringify(query)
  const seq = useRef(0)
  const latest = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    setLoading(true)
    // Debounced: `q` changes per keystroke, and the facet clicks that share this
    // hook are cheap enough to pay the same 200ms.
    const timer = setTimeout(() => {
      api.catalogSearch(JSON.parse(key) as CatalogQuery)
        .then((result) => {
          // Out-of-order guard. Without it a slow "mo" overwrites a fast
          // "momentum" and the table disagrees with the box above it.
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
  }, [key, nonce])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  return { page, loading, error, refetch }
}

export function useCatalogFacets(kind?: string): CatalogFacets | null {
  const [facets, setFacets] = useState<CatalogFacets | null>(null)

  useEffect(() => {
    let cancelled = false
    // Cleared on a kind change: a facet rail describing the previous collection
    // is a set of filters that return nothing, offered as if they would work.
    setFacets(null)
    api.catalogFacets(kind as CatalogKind | undefined)
      .then((r) => { if (!cancelled) setFacets(r) })
      .catch(() => { if (!cancelled) setFacets(null) })
    return () => { cancelled = true }
  }, [kind])

  return facets
}

export interface CatalogSummaryState {
  summary: CatalogSummary | null
  loading: boolean
  error: string | null
  reload: () => void
}

export function useCatalogSummary(): CatalogSummaryState {
  const [summary, setSummary] = useState<CatalogSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.catalogSummary()
      .then((r) => { if (!cancelled) { setSummary(r); setError(null) } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read the catalog')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  return { summary, loading, error, reload }
}

/**
 * Drive a reindex to completion, polling the job.
 *
 * Polled rather than streamed. The SSE endpoint exists and the ingest dialog
 * uses its equivalent, but a local reindex finishes in about three seconds —
 * an EventSource that outlives the job by more than it lives is more moving
 * parts than the thing is worth.
 */
export function useReindex(onDone: () => void) {
  const [job, setJob] = useState<CatalogSummary['running_job']>(null)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async (only?: string[]) => {
    setError(null)
    try {
      const { job_id } = await api.catalogReindex(only?.length ? { only } : {})
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const state = await api.catalogReindexJob(job_id)
        setJob(state)
        if (state.status !== 'running') {
          if (state.error) setError(state.error)
          setJob(null)
          onDone()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    } catch (e: unknown) {
      setJob(null)
      setError(e instanceof Error ? e.message : 'Reindex failed')
    }
  }, [onDone])

  return { job, error, start }
}
