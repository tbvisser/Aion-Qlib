import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { MacroRefreshButton } from '@/components/MacroRefreshButton'
import { RefreshDataDialog } from '@/components/RefreshDataDialog'
import { AgendaFilterChips } from '@/components/inbox/AgendaFilterChips'
import { DayDetail } from '@/components/inbox/DayDetail'
import { MonthGrid } from '@/components/inbox/MonthGrid'
import { NowStrip } from '@/components/inbox/NowStrip'
import { StatCards } from '@/components/inbox/StatCards'
import { ViewToggle } from '@/components/inbox/ViewToggle'
import { WeekTimeline } from '@/components/inbox/WeekTimeline'
import { PageHeader } from '@/components/layout/PageHeader'
import { Notice } from '@/components/ui/notice'
import { useRebalanceFeed, useRunSignals, useThreadFeed } from '@/hooks/useAgendaFeeds'
import { useInbox } from '@/hooks/useInbox'
import {
  useAgendaCalendar, useInboxCalendar, useMacroRegimeHistory,
} from '@/hooks/useMacro'
import {
  buildAgendaEntries, filterEntries, gridRange, recencyFloor, resolveSelection,
  resolveView, runStats30d, splitInFlight, summarizeDays, typeCounts, weekOf,
  type AgendaFilter, type AgendaType,
} from '@/lib/agenda'
import { deriveRegimeFlips, readLastSeen } from '@/lib/inbox'
import {
  addDaysIso, addMonths, monthEndIso, monthOf, todayIso,
} from '@/lib/macroFormat'

const PAGE_POLL_MS = 5000

const FILTERS: ReadonlySet<string> = new Set<AgendaFilter>([
  'all', 'release', 'process', 'trade', 'message', 'notification',
])

/**
 * The Inbox as a trading-journal-style month calendar: an Edgewonk-like grid
 * of days — tinted by the day's run outcomes, dotted by item types — with a
 * KPI row above and the selected day's items beside it. In-flight work stays
 * pinned in the Now strip; unread is decided against the previous visit.
 */
export function InboxPage() {
  const { items, regime, unreadCount, refresh, markSeen } = useInbox()
  const [prevLastSeen] = useState(() => readLastSeen())
  const { history: regimeHistory } = useMacroRegimeHistory(6)
  const signals = useRunSignals(items)
  const threads = useThreadFeed()
  const rebalances = useRebalanceFeed()
  // Forward-only calendar for the KPI card — stable while browsing months.
  const { calendar: weekCalendar } = useAgendaCalendar()

  useEffect(() => {
    markSeen()
  }, [markSeen, items, regime])

  useEffect(() => {
    const id = setInterval(() => void refresh(), PAGE_POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const today = todayIso()
  const currentMonth = monthOf(today)
  const maxMonth = addMonths(currentMonth, 1)

  // URL state: ?type=, ?view=, ?month=YYYY-MM, ?day=YYYY-MM-DD, ?entry=<key> —
  // written only when they differ from the defaults, repaired when invalid.
  const [params, setParams] = useSearchParams()
  const patch = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    setParams(next, { replace: true })
  }

  const rawFilter = params.get('type') ?? 'all'
  const filter: AgendaFilter = FILTERS.has(rawFilter) ? (rawFilter as AgendaFilter) : 'all'

  const view = resolveView(params.get('view'))

  const rawMonth = params.get('month')
  const monthCandidate = rawMonth && /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : currentMonth

  const rawDay = params.get('day')
  const selectedDay = rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : today

  const grid = useMemo(() => gridRange(monthCandidate), [monthCandidate])
  const { calendar } = useInboxCalendar('US', grid)

  // The cache's real coverage tightens how far back navigation can go.
  const minMonth = useMemo(() => {
    const floor = addMonths(currentMonth, -12)
    const cacheFrom = calendar?.cache_from ? monthOf(calendar.cache_from) : null
    return cacheFrom && cacheFrom > floor ? cacheFrom : floor
  }, [currentMonth, calendar?.cache_from])
  const month = monthCandidate < minMonth ? minMonth
    : monthCandidate > maxMonth ? maxMonth : monthCandidate

  const flips = useMemo(
    () => (regimeHistory?.available ? deriveRegimeFlips(regimeHistory.months) : []),
    [regimeHistory],
  )

  // One entry list serves the grid, the detail panel and the KPI helpers:
  // the union of the visible grid range and the default recency window.
  const window = useMemo(() => ({
    from: grid.from < addDaysIso(today, -14) ? grid.from : addDaysIso(today, -14),
    to: grid.to > addDaysIso(today, 7) ? grid.to : addDaysIso(today, 7),
  }), [grid, today])

  const entries = useMemo(() => buildAgendaEntries({
    activity: items,
    calendar: calendar?.available
      ? { past: calendar.past, upcoming: calendar.upcoming, stale: calendar.stale }
      : null,
    flips,
    signals,
    threads,
    rebalances,
  }, today, window), [items, calendar, flips, signals, threads, rebalances, today, window])

  const filtered = useMemo(() => filterEntries(entries, filter), [entries, filter])
  const counts: Record<AgendaType, number> = useMemo(() => typeCounts(entries), [entries])
  // Counts and dots follow the filter; heat is read from the full population
  // so a trades-only month still shows which days were macro-loud.
  const summaries = useMemo(() => summarizeDays(filtered, entries), [filtered, entries])
  const floor = useMemo(() => recencyFloor(entries), [entries])
  const dayEntries = useMemo(
    () => filtered.filter((e) => e.date === selectedDay),
    [filtered, selectedDay],
  )
  // An entry key is only honoured while its row is actually on screen, so a
  // stale ?entry= left over from another day or filter collapses to the day.
  const selection = useMemo(
    () => resolveSelection(params.get('entry'), dayEntries),
    [params, dayEntries],
  )
  const week = useMemo(() => weekOf(selectedDay), [selectedDay])
  const weekEntries = useMemo(
    () => filtered.filter((e) => e.date >= week[0] && e.date <= week[6]),
    [filtered, week],
  )

  const { live } = splitInFlight(items)
  const macroRunning = live.some((i) => i.kind === 'macro_refresh')
  const stats = useMemo(() => runStats30d(items, today), [items, today])

  const selectDay = (iso: string) => {
    patch({
      day: iso === today ? null : iso,
      // Clicking an out-of-month cell hops the calendar to that month.
      month: monthOf(iso) === currentMonth ? null : monthOf(iso),
      // The old day's entry key means nothing here.
      entry: null,
    })
  }

  // Clicking the open row again closes its card.
  const selectEntry = (key: string) => {
    const open = selection.kind === 'entry' && selection.entryKey === key
    patch({ entry: open ? null : key })
  }

  // The same panel in both views — only where it sits on the page changes.
  const dayPanel = (
    <DayDetail
      date={selectedDay}
      entries={dayEntries}
      prevLastSeen={prevLastSeen}
      today={today}
      floor={floor}
      selection={selection}
      onSelect={selectEntry}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Inbox"
        description="One agenda: releases, processes, trades, messages and notifications, day by day."
        actions={
          <>
            <MacroRefreshButton disabled={macroRunning} onFinished={() => void refresh()} />
            <RefreshDataDialog onFinished={() => void refresh()} />
          </>
        }
      />

      {/* Full width, matching PageHeader's own px-6 bleed: a centred column
          here left the header spanning the pane above an off-centre body. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="space-y-4">
          {calendar && !calendar.available && (
            <Notice tone="clay">
              <p>{calendar.reason ?? 'No economic calendar cached yet.'}</p>
              <div className="pt-2">
                <MacroRefreshButton
                  what="calendar"
                  label="Fetch calendar"
                  showProgress
                  onFinished={() => void refresh()}
                />
              </div>
            </Notice>
          )}

          <NowStrip live={live} onChanged={() => void refresh()} />

          <StatCards
            weekCalendar={weekCalendar}
            runStats={stats}
            activityCapped={items.length >= 200}
            rebalances={rebalances}
            month={month}
            liveCount={live.length}
            unreadCount={unreadCount}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <AgendaFilterChips
              value={filter}
              counts={counts}
              onChange={(next) => patch({
                type: next === 'all' ? null : next,
                entry: null,
              })}
            />
            <ViewToggle
              value={view}
              onChange={(next) => patch({ view: next === 'month' ? null : next })}
            />
          </div>

          {/* The week axis needs the full width to stay legible, so the day
              panel drops below it instead of sharing the row. */}
          {view === 'month' ? (
            <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:gap-4 lg:space-y-0">
              <MonthGrid
                month={month}
                today={today}
                selected={selectedDay}
                summaries={summaries}
                onSelectDay={selectDay}
                onMonthChange={(next) => patch({ month: next === currentMonth ? null : next })}
                minMonth={minMonth}
                maxMonth={maxMonth}
              />
              {dayPanel}
            </div>
          ) : (
            <div className="space-y-4">
              <WeekTimeline
                week={week}
                entries={weekEntries}
                today={today}
                selectedDay={selectedDay}
                selectedKey={selection.kind === 'entry' ? selection.entryKey : null}
                onSelectDay={selectDay}
                onSelectEntry={selectEntry}
                onWeekChange={selectDay}
                minDate={`${minMonth}-01`}
                maxDate={monthEndIso(maxMonth)}
              />
              {dayPanel}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
