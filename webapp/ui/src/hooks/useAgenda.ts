/**
 * Everything the Agenda page needs, assembled once.
 *
 * The page used to call seven hooks and derive eleven memos inline, which put
 * polling, cache-coverage arithmetic and layout in one 273-line component.
 * All of that lives here now; the page reads a view-model and renders it.
 *
 * **No page-level timer.** Cadence belongs to the provider, which now speeds up
 * on its own while work is in flight. The page used to layer a 5s tick of its
 * own on top of the provider's 30s one.
 *
 * **Two calendar fetches, deliberately.** The timeline needs the grid's span;
 * the summary needs the coming week. Those look like one query — the union of
 * the two spans — but `/api/macro/calendar` caps at 1000 rows and fills them
 * ascending, and the US tape prints about fourteen a day. Browse back to last
 * August and the union is over a year wide, so the cap is spent inside three
 * months and the far end comes back empty: the grid stays right and "next 7d"
 * silently reads 0. Two bounded windows, two right answers.
 */
import { useEffect, useMemo, useState } from 'react'

import { REBALANCE_LIMIT, useRebalanceFeed, useRunSignals, useThreadFeed } from '@/hooks/useAgendaFeeds'
import { ACTIVITY_LIMIT, useInbox } from '@/hooks/useInbox'
import {
  useAgendaCalendar, useAgendaWindowCalendar, useMacroRegimeHistory,
} from '@/hooks/useMacro'
import {
  buildAgendaEntries, filterEntries, gridRange, recencyFloor, resolveSelection,
  runStats30d, searchEntries, splitInFlight, summarizeDays, typeCounts, weekOf,
  AGENDA_FUTURE_DAYS, AGENDA_PAST_DAYS,
  type AgendaEntry, type AgendaFilter, type AgendaSelection, type AgendaType,
  type AgendaWindow, type DaySummary,
} from '@/lib/agenda'
import { agendaSummary, type SummaryRow } from '@/lib/agendaSummary'
import { clampMonth } from '@/lib/agendaUrl'
import type { ActivityItem, MacroCalendar } from '@/lib/api'
import { deriveRegimeFlips, readLastSeen } from '@/lib/inbox'
import { addDaysIso, addMonths, monthEndIso, monthOf, todayIso } from '@/lib/macroFormat'

/** How far past the current month the calendar is worth browsing. */
const FORWARD_MONTHS = 1
/** How far back navigation reaches when the cache does not say otherwise. */
const BACK_MONTHS = 12

export interface AgendaViewModel {
  today: string
  /** The month actually shown, after clamping to real coverage. */
  month: string
  minMonth: string
  maxMonth: string
  /** The navigable span as ISO days, for the week axis's arrows. */
  minDate: string
  maxDate: string
  /** Mon–Sun ISO dates of the week containing the selected day. */
  week: string[]
  /** Every entry in the window, before the filter and the search. */
  entries: AgendaEntry[]
  /** What the current filter and search admit — what the views render. */
  visible: AgendaEntry[]
  counts: Record<AgendaType, number>
  summaries: Map<string, DaySummary>
  dayEntries: AgendaEntry[]
  weekEntries: AgendaEntry[]
  selection: AgendaSelection
  /** Oldest day the recency-bounded lanes still cover; null when unbounded. */
  floor: string | null
  /** In-flight work — the Now panel, never a day group. */
  live: ActivityItem[]
  /** True while a macro refresh is already running. */
  macroRunning: boolean
  /** The At-a-glance rows. */
  summary: SummaryRow[]
  calendar: MacroCalendar | null
  unreadCount: number
  /**
   * The last-seen stamp as it was when the page opened. Frozen deliberately:
   * `markSeen` moves the stored stamp forward on arrival, and reading it live
   * would clear every unread tint in the same frame the reader arrived to see
   * them.
   */
  prevLastSeen: string | null
  markSeen: () => void
  refresh: () => Promise<void>
}

export function useAgenda({ monthCandidate, day, filter, query, entryKey }: {
  /** Shape-checked but unclamped — this hook owns the clamp. */
  monthCandidate: string
  day: string
  filter: AgendaFilter
  query: string
  entryKey: string | null
}): AgendaViewModel {
  const { items, unreadCount, capped, refresh, markSeen } = useInbox()
  const [prevLastSeen] = useState(() => readLastSeen())
  const { history: regimeHistory } = useMacroRegimeHistory(6)
  const signals = useRunSignals(items)
  const threads = useThreadFeed()
  const rebalances = useRebalanceFeed()

  // Once on arrival, once on leaving: arriving acknowledges what was already
  // there, leaving acknowledges whatever landed while the page was open. The
  // old page ran this on every `items` change, which rewrote localStorage on
  // every poll — `markSeen` is stable now, so the empty dep list is honest.
  useEffect(() => {
    markSeen()
    return () => markSeen()
  }, [markSeen])

  const today = todayIso()
  const currentMonth = monthOf(today)
  const maxMonth = addMonths(currentMonth, FORWARD_MONTHS)
  const floorMonth = addMonths(currentMonth, -BACK_MONTHS)

  // Clamped against the *static* bounds before anything is fetched. The
  // cache-aware floor below needs a calendar to exist, and a calendar needs a
  // window, so a candidate cannot wait for it: `?month=1999-01` used to be
  // fetched verbatim, which asked for a window starting in 1998 while the grid
  // beside it rendered a month from last year.
  const requested = clampMonth(monthCandidate, { minMonth: floorMonth, maxMonth })
  const grid = useMemo(() => gridRange(requested), [requested])

  // The union of what the grid shows and what the recency lanes cover. One
  // entry list then serves the grid, the week axis, the stream and the day
  // panel — the union matters so that today's work is still in the list while
  // another month is being browsed.
  const entryWindow: AgendaWindow = useMemo(() => {
    const past = addDaysIso(today, -AGENDA_PAST_DAYS)
    const future = addDaysIso(today, AGENDA_FUTURE_DAYS)
    return {
      from: grid.from < past ? grid.from : past,
      to: grid.to > future ? grid.to : future,
    }
  }, [grid, today])

  // The timeline's calendar. Ascending fill means the grid's own month is
  // always covered even when the window is wide enough to hit the row cap.
  const { calendar } = useAgendaWindowCalendar('US', entryWindow)
  // The summary's calendar: a small, fixed forward window, so the coming week
  // is never the part the cap cut off. See the note at the top of the file.
  const { calendar: forwardCalendar } = useAgendaCalendar()

  // Navigation reaches back a year, or only as far as the cache really goes —
  // a month with working arrows and provably no data is worse than no arrow.
  const minMonth = useMemo(() => {
    const cacheFrom = calendar?.cache_from ? monthOf(calendar.cache_from) : null
    return cacheFrom && cacheFrom > floorMonth ? cacheFrom : floorMonth
  }, [floorMonth, calendar?.cache_from])

  const month = clampMonth(requested, { minMonth, maxMonth })

  const flips = useMemo(
    () => (regimeHistory?.available ? deriveRegimeFlips(regimeHistory.months) : []),
    [regimeHistory],
  )

  const entries = useMemo(() => buildAgendaEntries({
    activity: items,
    calendar: calendar?.available
      ? { past: calendar.past, upcoming: calendar.upcoming, stale: calendar.stale }
      : null,
    flips,
    signals,
    threads,
    rebalances,
  }, today, entryWindow),
  [items, calendar, flips, signals, threads, rebalances, today, entryWindow])

  // Filter then search: the chips' counts describe the whole window, so they
  // must be taken before either narrowing.
  const visible = useMemo(
    () => searchEntries(filterEntries(entries, filter), query),
    [entries, filter, query],
  )
  const counts = useMemo(() => typeCounts(entries), [entries])

  // Counts and dots follow what is visible; heat is read from the full
  // population, so a trades-only month still shows which days were macro-loud.
  const summaries = useMemo(() => summarizeDays(visible, entries), [visible, entries])
  const floor = useMemo(() => recencyFloor(entries), [entries])

  const dayEntries = useMemo(
    () => visible.filter((entry) => entry.date === day),
    [visible, day],
  )
  const week = useMemo(() => weekOf(day), [day])
  const weekEntries = useMemo(
    () => visible.filter((entry) => entry.date >= week[0] && entry.date <= week[6]),
    [visible, week],
  )

  // An entry key is honoured only while its row is on screen, so a stale
  // ?entry= left over from another day, filter or search collapses to the day.
  // The stream shows every visible row, the calendars only the selected day's;
  // resolving against the wider set keeps a stream selection alive.
  const selection = useMemo(
    () => resolveSelection(entryKey, visible),
    [entryKey, visible],
  )

  const { live } = useMemo(() => splitInFlight(items), [items])
  const macroRunning = live.some((item) => item.kind === 'macro_refresh')
  const runStats = useMemo(() => runStats30d(items, today), [items, today])

  const summary = useMemo(() => agendaSummary({
    calendar: forwardCalendar,
    runStats,
    rebalances,
    month,
    unreadCount,
    activityCapped: capped,
    rebalanceLimit: REBALANCE_LIMIT,
    activityLimit: ACTIVITY_LIMIT,
    today,
  }), [forwardCalendar, runStats, rebalances, month, unreadCount, capped, today])

  return {
    today,
    month,
    minMonth,
    maxMonth,
    minDate: `${minMonth}-01`,
    maxDate: monthEndIso(maxMonth),
    week,
    entries,
    visible,
    counts,
    summaries,
    dayEntries,
    weekEntries,
    selection,
    floor,
    live,
    macroRunning,
    summary,
    calendar: calendar ?? null,
    unreadCount,
    prevLastSeen,
    markSeen,
    refresh,
  }
}

