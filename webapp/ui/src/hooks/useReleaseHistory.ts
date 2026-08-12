/**
 * Trailing prints of one indicator, for the release-detail history chart.
 *
 * Lazy on purpose: nothing fetches until a release entry is actually
 * selected, and a module-level cache means re-selecting the same indicator
 * never refetches within a session. No polling — the underlying cache has a
 * 6-hour TTL, so history only moves on a macro refresh.
 */
import { useEffect, useState } from 'react'

import { api, type MacroReleaseHistory } from '@/lib/api'

const cache = new Map<string, MacroReleaseHistory>()

export interface ReleaseHistoryState {
  data: MacroReleaseHistory | null
  loading: boolean
  error: string | null
}

export function useReleaseHistory(
  eventKey: string | null,
  country: string | null,
): ReleaseHistoryState {
  const key = eventKey ? `${eventKey}:${country ?? ''}` : null
  const [state, setState] = useState<ReleaseHistoryState>({
    data: key ? (cache.get(key) ?? null) : null,
    loading: false,
    error: null,
  })

  useEffect(() => {
    if (!key || !eventKey) {
      setState({ data: null, loading: false, error: null })
      return
    }
    const hit = cache.get(key)
    if (hit) {
      setState({ data: hit, loading: false, error: null })
      return
    }
    let cancelled = false
    setState({ data: null, loading: true, error: null })
    api
      .macroCalendarHistory({ event_key: eventKey, country: country ?? undefined })
      .then((body) => {
        cache.set(key, body)
        if (!cancelled) setState({ data: body, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ data: null, loading: false, error: String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key, eventKey, country])

  return state
}
