/**
 * App-wide inbox state: the activity feed, the regime read and the unread
 * count derived from both.
 *
 * Lives in a context rather than a page hook because the sidebar badge has to
 * update while the user is anywhere else — the provider polls, everything
 * under it just reads. Poll failures keep the last good data (the RunsPage
 * convention: the API being briefly down should not blank a badge).
 *
 * Cadences: activity every 30s (jobs move in seconds), regime every 15min
 * (it moves at data-release granularity). The InboxPage layers its own 5s
 * refresh on top while mounted.
 */
import {
  createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState,
} from 'react'

import { api, ActivityItem, MacroRegimeResponse } from '@/lib/api'
import {
  computeUnread, extractLensStates, readLastSeen, readRegimeSeen,
  RegimeSeenMap, writeLastSeen, writeRegimeSeen,
} from '@/lib/inbox'

const ACTIVITY_POLL_MS = 30_000
const REGIME_POLL_MS = 15 * 60_000

interface InboxContextValue {
  items: ActivityItem[]
  regime: MacroRegimeResponse | null
  unreadCount: number
  /** Re-fetch the activity feed now (the InboxPage's 5s tick). */
  refresh: () => Promise<void>
  /** Mark everything current as seen; clears the badge. */
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
      // 200 (the endpoint's cap) rather than 50: the Inbox month grid reads
      // this feed, and 50 events can be less than a fortnight of history.
      const feed = await api.activity(200)
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

  useEffect(() => {
    void refresh()
    void refreshRegime()
    const activityTimer = setInterval(() => void refresh(), ACTIVITY_POLL_MS)
    const regimeTimer = setInterval(() => void refreshRegime(), REGIME_POLL_MS)
    return () => {
      clearInterval(activityTimer)
      clearInterval(regimeTimer)
    }
  }, [refresh, refreshRegime])

  const markSeen = useCallback(() => {
    const now = new Date().toISOString()
    writeLastSeen(now)
    setLastSeen(now)
    setRegimeSeen((prev) => {
      const current = extractLensStates(regime)
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
  }, [regime])

  const unreadCount = computeUnread(items, lastSeen, regime, regimeSeen)

  return (
    <InboxContext.Provider value={{ items, regime, unreadCount, refresh, markSeen }}>
      {children}
    </InboxContext.Provider>
  )
}

export function useInbox(): InboxContextValue {
  const context = useContext(InboxContext)
  if (!context) {
    throw new Error('useInbox must be used within an InboxProvider')
  }
  return context
}
