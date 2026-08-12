import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api, type CountryIndicators, type MacroCalendar, type MacroCurveResponse,
  type MacroLinkage, type MacroPlaybookResponse, type MacroRegimeHistory,
  type MacroRegimeResponse, type MacroSeriesData, type MacroSeriesResponse,
  type MacroSnapshot, type MacroSubjectKind, type PlaybookLens,
} from '@/lib/api'
import { addDaysIso, todayIso } from '@/lib/macroFormat'

/**
 * Macro data hooks.
 *
 * All follow `useHealth`'s shape — `{ data, error, loading, refresh }`, plain
 * fetch, no query library — because that is the convention every other page
 * here already uses.
 */

function useResource<T>(load: () => Promise<T>, deps: unknown[], enabled = true) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const reqId = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setData(null)
      setLoading(false)
      return
    }
    const id = ++reqId.current
    setLoading(true)
    try {
      const next = await load()
      // Race guard: a slow earlier response must not overwrite a newer one.
      if (id !== reqId.current) return
      setData(next)
      setError(null)
    } catch (err) {
      if (id !== reqId.current) return
      setError(err instanceof Error ? err.message : 'Request failed')
      setData(null)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { data, error, loading, refresh }
}

export function useMacroRegistry() {
  const { data, error, loading } = useResource<MacroSeriesResponse>(
    () => api.macroSeries(), [],
  )
  return { registry: data, error, loading }
}

export function useMacroSnapshot() {
  const { data, error, loading, refresh } = useResource<MacroSnapshot>(
    () => api.macroSnapshot(), [],
  )
  return { snapshot: data, error, loading, refresh }
}

export function useMacroCurve(compare?: string) {
  const { data, error, loading } = useResource<MacroCurveResponse>(
    () => api.macroCurve({ compare }), [compare],
  )
  return { curve: data, error, loading }
}

export function useMacroCalendar(country: string) {
  const { data, error, loading } = useResource<MacroCalendar>(
    () => api.macroCalendar({ country }), [country],
  )
  return { calendar: data, error, loading }
}

const AGENDA_POLL_MS = 15 * 60_000

/**
 * The forward-looking slice of the calendar, for the Dashboard agenda and the
 * Inbox's "this week" panel.
 *
 * `from: today` matters: the backend sorts ascending and applies `limit` at
 * the far end, so the desk's default −21d window would spend the budget on
 * last week. 15-minute refresh — the cache is file-backed and moves at data
 * -release granularity, so anything faster is just load.
 *
 * `to` is bounded and the limit generous for the same reason the sibling
 * hooks are: US releases run about fourteen a day, so an unbounded window on
 * a small budget spends it inside three days and every consumer counting
 * "the next seven days" reports the cap instead of the count.
 */
export function useAgendaCalendar(country = 'US') {
  const { data, error, loading, refresh } = useResource<MacroCalendar>(
    () => api.macroCalendar({
      from: todayIso(), to: addDaysIso(todayIso(), 7), country, limit: 1000,
    }), [country],
  )
  useEffect(() => {
    const id = setInterval(() => void refresh(), AGENDA_POLL_MS)
    return () => clearInterval(id)
  }, [refresh])
  return { calendar: data, error, loading, refresh }
}

/**
 * The Inbox agenda's calendar. Without a window: two weeks back through a
 * week ahead. With one (the month grid's visible range): that exact span —
 * releases are the one lane that can be fetched month-complete for any month.
 * The generous limit means no realistic window is ever truncated.
 */
export function useInboxCalendar(
  country = 'US',
  window?: { from: string; to: string },
) {
  const from = window?.from ?? addDaysIso(todayIso(), -14)
  const to = window?.to ?? addDaysIso(todayIso(), 7)
  const { data, error, loading, refresh } = useResource<MacroCalendar>(
    () => api.macroCalendar({ from, to, country, limit: 1000 }),
    [country, from, to],
  )
  useEffect(() => {
    const id = setInterval(() => void refresh(), AGENDA_POLL_MS)
    return () => clearInterval(id)
  }, [refresh])
  return { calendar: data, error, loading, refresh }
}

/**
 * A single month's releases for the Dashboard popover grid, fetched only
 * while the popover is open (`enabled`), keyed on the viewed month.
 */
export function useMonthCalendar(
  window: { from: string; to: string },
  country = 'US',
  enabled = true,
) {
  const { data, error, loading, refresh } = useResource<MacroCalendar>(
    () => api.macroCalendar({ from: window.from, to: window.to, country, limit: 1000 }),
    // `enabled` must be a dep: useResource captures it in its refresh
    // closure, so an enabled flip that doesn't rebuild the callback would
    // never fetch — the popover would sit on its placeholder forever.
    [window.from, window.to, country, enabled],
    enabled,
  )
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => void refresh(), AGENDA_POLL_MS)
    return () => clearInterval(id)
  }, [refresh, enabled])
  return { calendar: data, error, loading, refresh }
}

export function useCountryIndicators(country: string) {
  const { data, error, loading } = useResource<CountryIndicators>(
    () => api.macroIndicators(country), [country],
  )
  return { indicators: data, error, loading }
}

export function useMacroLinkage(subject: { kind: MacroSubjectKind; id: string } | null) {
  const { data, error, loading } = useResource<MacroLinkage>(
    () => api.macroLinkage(subject!.kind, subject!.id),
    [subject?.kind, subject?.id],
    Boolean(subject),
  )
  return { linkage: data, error, loading }
}

/**
 * Several series at once, cached per (key, start).
 *
 * The cache is what makes deselecting and reselecting a series free, which
 * matters because the rail is a toggle list and users sweep through it.
 */
export function useMacroSeriesData(keys: string[], start?: string) {
  const [series, setSeries] = useState<MacroSeriesData[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const cache = useRef(new Map<string, MacroSeriesData>())
  const reqId = useRef(0)
  const signature = keys.join(',')

  useEffect(() => {
    const wanted = signature ? signature.split(',') : []
    if (!wanted.length) {
      setSeries([])
      setLoading(false)
      return
    }
    const id = ++reqId.current
    let cancelled = false
    setLoading(true)

    void (async () => {
      try {
        const loaded = await Promise.all(
          wanted.map(async (key) => {
            const cacheKey = `${key}|${start ?? ''}`
            const hit = cache.current.get(cacheKey)
            if (hit) return hit
            const fetched = await api.macroSeriesData(key, { start })
            cache.current.set(cacheKey, fetched)
            return fetched
          }),
        )
        if (cancelled || id !== reqId.current) return
        setSeries(loaded)
        setError(null)
      } catch (err) {
        if (cancelled || id !== reqId.current) return
        setError(err instanceof Error ? err.message : 'Could not load series')
      } finally {
        if (!cancelled && id === reqId.current) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [signature, start])

  return { series, error, loading }
}

export function useMacroRegime() {
  const { data, error, loading, refresh } = useResource<MacroRegimeResponse>(
    () => api.macroRegime(), [],
  )
  return { regime: data, error, loading, refresh }
}

export function useMacroRegimeHistory(months = 24) {
  const { data, error, loading } = useResource<MacroRegimeHistory>(
    () => api.macroRegimeHistory(months), [months],
  )
  return { history: data, error, loading }
}

export function useMacroPlaybook(lens: PlaybookLens) {
  const { data, error, loading } = useResource<MacroPlaybookResponse>(
    () => api.macroPlaybook(lens), [lens],
  )
  return { playbook: data, error, loading }
}
