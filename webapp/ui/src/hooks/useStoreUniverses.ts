import { useEffect, useState } from 'react'

import { api, type StoreUniverse } from '@/lib/api'

/**
 * Every universe in one store, with its size and a few of its names.
 *
 * Keyed by store at module level, the `useTemplates` idiom: switching stores in
 * the form and switching back is an ordinary edit, and this answer only changes
 * when an ingest runs. Two components read it — the picker, to show counts and
 * a peek, and the summary, to say "the 500 names in top500" instead of a slug.
 *
 * Not cached on failure, so one lost request does not leave the picker
 * permanently undecorated.
 */
const cache = new Map<string, Promise<StoreUniverse[]>>()

export function loadStoreUniverses(store: string): Promise<StoreUniverse[]> {
  let inflight = cache.get(store)
  if (!inflight) {
    inflight = api.storeUniverses(store)
      .then((r) => r.universes)
      .catch((e) => {
        cache.delete(store)
        throw e
      })
    cache.set(store, inflight)
  }
  return inflight
}

export function useStoreUniverses(store: string) {
  const [universes, setUniverses] = useState<StoreUniverse[]>([])

  useEffect(() => {
    let cancelled = false
    setUniverses([])
    loadStoreUniverses(store)
      .then((u) => { if (!cancelled) setUniverses(u) })
      // A failure degrades to an undecorated list. Selection is never blocked
      // by a decoration.
      .catch(() => { if (!cancelled) setUniverses([]) })
    return () => { cancelled = true }
  }, [store])

  return universes
}

/** How many names are in one universe of one store, or null while unknown. */
export function useUniverseCount(store: string, universe: string): number | null {
  const universes = useStoreUniverses(store)
  return universes.find((u) => u.name === universe)?.count ?? null
}
