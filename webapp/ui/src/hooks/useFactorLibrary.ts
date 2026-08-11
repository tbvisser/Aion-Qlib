import { useEffect, useState } from 'react'

import { api, type CatalogFactor, type FactorFamily, type Indicator } from '@/lib/api'
import { FALLBACK_FIELDS } from '@/lib/factorExpr/registry'

/**
 * The palette's two payloads, judged against a named store.
 *
 * Both endpoints take a `?store=`, and the canvas used to pass neither — so it
 * fell back to whichever store the API process happened to mount. Building a
 * `crypto_365` strategy showed a palette whose "no data" badges and dead-column
 * marks described the **us** store: every judgement on screen was about a store
 * the strategy would never touch.
 *
 * Keyed by store rather than fetched per mount, because switching stores in the
 * form and coming back to the canvas is a normal edit and each payload costs the
 * server a census plus a lower of the whole factor library. Not cached on
 * failure — the `useTemplates` rule — so one bad response does not leave the
 * palette permanently empty.
 *
 * The two are fetched and cached *together*. Resolving them separately lets a
 * store switch land the new catalog beside the old indicator list, which is a
 * palette describing two different stores at once.
 */
export interface FactorLibrary {
  catalog: CatalogFactor[]
  families: FactorFamily[]
  indicators: Indicator[]
  /** Bare column names, `$` stripped. `FALLBACK_FIELDS` when the API cannot say. */
  fields: string[]
  /** Whether `fields` came from the store or is the built-in guess. */
  served: boolean
}

const EMPTY: FactorLibrary = {
  catalog: [], families: [], indicators: [], fields: FALLBACK_FIELDS, served: false,
}

const cache = new Map<string, Promise<FactorLibrary>>()

export function loadFactorLibrary(store?: string): Promise<FactorLibrary> {
  const key = store ?? ''
  let inflight = cache.get(key)
  if (!inflight) {
    inflight = Promise.all([
      api.factorCatalog(store).catch(() => null),
      api.indicators(store).catch(() => null),
    ]).then(([catalog, indicators]) => {
      if (!catalog && !indicators) {
        // Both halves failed: this is the backend being down, not a store with
        // nothing in it. Refuse to cache it.
        cache.delete(key)
        return EMPTY
      }
      const fields = catalog?.fields.map((f) => f.replace(/^\$/, '')) ?? []
      return {
        catalog: catalog?.factors ?? [],
        // Served order and served labels: the palette must not invent either.
        families: catalog?.families ?? [],
        indicators: indicators?.indicators ?? [],
        fields: fields.length ? fields : FALLBACK_FIELDS,
        served: fields.length > 0,
      }
    })
    cache.set(key, inflight)
  }
  return inflight
}

export function useFactorLibrary(store?: string): FactorLibrary & { loading: boolean } {
  const [data, setData] = useState<FactorLibrary | null>(() => null)

  useEffect(() => {
    let cancelled = false
    // Cleared on a store change rather than left showing the previous store's
    // judgements while the new ones load. A stale "no data" badge is worse than
    // no badge: it is a claim about the wrong store, stated with confidence.
    setData(null)
    loadFactorLibrary(store)
      .then((r) => { if (!cancelled) setData(r) })
      .catch(() => { if (!cancelled) setData(EMPTY) })
    return () => { cancelled = true }
  }, [store])

  return { ...(data ?? EMPTY), loading: data === null }
}
