/**
 * App-wide inbox state: the activity feed, the regime read and the unread
 * count derived from both.
 *
 * Lives in a context rather than a page hook because the sidebar badge has to
 * update while the user is anywhere else — the provider polls, everything
 * under it just reads. Poll failures keep the last good data (the RunsPage
 * convention: the API being briefly down should not blank a badge).
 *
 * Cadences: regime every 15min (it moves at data-release granularity), and
 * activity **adaptively** — every 5s while anything is in flight, every 30s
 * once the desk is quiet. The Agenda page used to layer its own 5s timer on
 * top of a flat 30s one here, which meant two timers racing and a page that
 * had to be mounted for the badge to keep up. Liveness is the real signal, so
 * it drives the cadence instead.
 */
import {
  createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'

import { splitInFlight } from '@/lib/agenda'
import { api, ActivityItem, MacroRegimeResponse } from '@/lib/api'
import {
  computeUnread, extractLensStates, readLastSeen, readRegimeSeen,
  RegimeSeenMap, writeLastSeen, writeRegimeSeen,
} from '@/lib/inbox'

const IDLE_POLL_MS = 30_000
const LIVE_POLL_MS = 5_000
const REGIME_POLL_MS = 15 * 60_000

/**
 * The endpoint's own cap (`/api/activity` refuses more), re-exported so the
 * summary row that footnotes a truncated feed names the same number the fetch
 * asked for rather than a second copy of it.
 */
export const ACTIVITY_LIMIT = 200

interface InboxContextValue {
  items: ActivityItem[]
  regime: MacroRegimeResponse | null
  unreadCount: number
  /** True when the feed came back at its cap — history may be incomplete. */
  capped: boolean
  /** Re-fetch the activity feed now, after an action that changes it. */
  refresh: () => Promise<void>
  /**
   * Mark everything current as seen; clears the badge. Stable across renders,
   * so a caller can mark on mount and on unmount with an empty dep list.
   */
  markSeen: () => void
}

const InboxContext = createContext<InboxContextValue | null>(null)

export function InboxProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [regime, setRegime] = useState<MacroRegimeResponse | null>(null)
  const [lastSeen, setLastSeen] = useState<string | null>(() => readLastSeen())
  const [regimeSeen, setRegimeSeen] = useState<RegimeSeenMap>(() => readRegimeSeen())

  // The pollers write through a ref so a re-render never tears down the
  // intervals, and unmount stops state writes.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      // The cap rather than the default 50: the Agenda's month grid reads this
      // feed, and 50 events can be less than a fortnight of history.
      const feed = await api.activity(ACTIVITY_LIMIT)
      if (alive.current) setItems(feed.items)
    } catch {
      /* keep last good data */
    }
  }, [])

  const refreshRegime = useCallback(async () => {
    try {
      const read = await api.macroRegime()
      if (alive.current) setRegime(read)
    } catch {
      /* keep last good data */
    }
  }, [])

  // Anything queued or running means the numbers on screen are still moving.
  const hasLive = useMemo(() => splitInFlight(items).live.length > 0, [items])

  useEffect(() => {
    void refreshRegime()
    const regimeTimer = setInterval(() => void refreshRegime(), REGIME_POLL_MS)
    return () => clearInterval(regimeTimer)
  }, [refreshRegime])

  // Re-armed when liveness changes, so a job starting speeds the feed up and
  // the last one finishing slows it back down.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), hasLive ? LIVE_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [refresh, hasLive])

  // `regime` is read through a ref so `markSeen` keeps one identity for the
  // life of the provider: the Agenda marks on mount and on unmount, and a
  // callback that changed with every poll would fire it on every tick instead
  // — which is exactly how this used to rewrite localStorage every 5 seconds.
  const regimeRef = useRef(regime)
  regimeRef.current = regime

  const markSeen = useCallback(() => {
    const now = new Date().toISOString()
    writeLastSeen(now)
    setLastSeen(now)
    setRegimeSeen((prev) => {
      const current = extractLensStates(regimeRef.current)
      // Keep the previous acknowledgement where the lens is currently
      // unreadable — otherwise a flaky read would silently reset the baseline.
      const next: RegimeSeenMap = {
        quadrant: current.quadrant ?? prev.quadrant,
        rate_cycle: current.rate_cycle ?? prev.rate_cycle,
        risk: current.risk ?? prev.risk,
        market: current.market ?? prev.market,
      }
      writeRegimeSeen(next)
      return next
    })
  }, [])

  const unreadCount = computeUnread(items, lastSeen, regime, regimeSeen)
  const capped = items.length >= ACTIVITY_LIMIT

  const value = useMemo(
    () => ({ items, regime, unreadCount, capped, refresh, markSeen }),
    [items, regime, unreadCount, capped, refresh, markSeen],
  )

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): InboxContextValue {
  const context = useContext(InboxContext)
  if (!context) {
    throw new Error('useInbox must be used within an InboxProvider')
  }
  return context
}
