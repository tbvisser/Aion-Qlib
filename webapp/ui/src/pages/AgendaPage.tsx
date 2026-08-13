import { useState } from 'react'
import { CalendarDays, CalendarRange, List } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'

import { MacroRefreshButton } from '@/components/MacroRefreshButton'
import { RefreshDataDialog } from '@/components/RefreshDataDialog'
import { AgendaFilterChips } from '@/components/agenda/AgendaFilterChips'
import { AgendaStream } from '@/components/agenda/AgendaStream'
import { AtAGlance } from '@/components/agenda/AtAGlance'
import { DayDetail } from '@/components/agenda/DayDetail'
import { MonthGrid } from '@/components/agenda/MonthGrid'
import { NowStrip } from '@/components/agenda/NowStrip'
import { OutlookPanel } from '@/components/agenda/OutlookPanel'
import { WeekTimeline } from '@/components/agenda/WeekTimeline'
import { IndexHeader } from '@/components/layout/IndexHeader'
import { Notice } from '@/components/ui/notice'
import { Segmented, type SegmentedOption } from '@/components/ui/segmented'
import { useAgenda } from '@/hooks/useAgenda'
import {
  agendaPatch, orDefault, readAgendaParams,
  DEFAULT_FILTER, DEFAULT_VIEW, type AgendaView,
} from '@/lib/agendaUrl'
import { monthOf } from '@/lib/macroFormat'

const VIEWS: readonly SegmentedOption<AgendaView>[] = [
  { value: 'month', label: 'Month', icon: CalendarDays, title: 'The shape of the month' },
  { value: 'week', label: 'Week', icon: CalendarRange, title: 'When in the day things land' },
  { value: 'agenda', label: 'Agenda', icon: List, title: 'Everything in order' },
]

/**
 * The Agenda: releases, processes, trades, messages and notifications on one
 * timeline, in three readings of it.
 *
 * The page is a shell. Every fact comes from `useAgenda`, every rule from
 * `lib/agenda*`, and what is left here is layout: a header, one control bar,
 * and a frame of two columns.
 *
 * The frame is deliberately stable. The aside — at a glance, what is running,
 * the selected day — holds its place in all three views, and only the primary
 * column swaps. An earlier version stacked a notice, a Now strip, a KPI row and
 * a control bar above the calendar and moved the day panel between two
 * different places depending on the view, so switching views relaid out the
 * whole page and the calendar started below the fold.
 */
export function AgendaPage() {
  const [params, setParams] = useSearchParams()
  const { filter, view, monthCandidate, day, entryKey, query } = readAgendaParams(params)
  const [searchOpen, setSearchOpen] = useState(() => query !== '')

  const agenda = useAgenda({ monthCandidate, day, filter, query, entryKey })
  const { today, month, live, calendar } = agenda
  const currentMonth = monthOf(today)

  const patch = (updates: Record<string, string | null>) => {
    setParams(agendaPatch(params, updates), { replace: true })
  }

  const selectDay = (iso: string) => {
    patch({
      day: orDefault(iso, today),
      // Clicking an out-of-month cell hops the calendar to that month.
      month: orDefault(monthOf(iso), currentMonth),
      // The old day's entry key means nothing here.
      entry: null,
    })
  }

  // Clicking the open row again closes its card.
  const selectEntry = (key: string) => {
    const open = agenda.selection.kind === 'entry' && agenda.selection.entryKey === key
    patch({ entry: open ? null : key })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IndexHeader
        title="Agenda"
        description="Releases, processes, trades, messages and notifications, day by day."
        search={{
          value: query,
          onChange: (next) => patch({ q: next, entry: null }),
          open: searchOpen,
          onOpenChange: setSearchOpen,
          placeholder: 'Search the agenda…',
        }}
        actions={
          <>
            <MacroRefreshButton
              disabled={agenda.macroRunning}
              onFinished={() => void agenda.refresh()}
            />
            <RefreshDataDialog onFinished={() => void agenda.refresh()} />
          </>
        }
      />

      {/* Full width, matching the header's own px-6 bleed: a centred column
          here left the header spanning the pane above an off-centre body. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="space-y-4">
          {/* Briefing row: AI outlook plus the key numbers. The calendar detail
              moves below so the first thing the reader sees is "what matters". */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_340px] lg:items-start">
            <OutlookPanel anchor={day} />
            <AtAGlance rows={agenda.summary} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <AgendaFilterChips
              value={filter}
              counts={agenda.counts}
              onChange={(next) => patch({
                type: orDefault(next, DEFAULT_FILTER),
                entry: null,
              })}
            />
            <Segmented
              value={view}
              options={VIEWS}
              onChange={(next) => patch({ view: orDefault(next, DEFAULT_VIEW) })}
              data-testid="agenda-view"
            />
          </div>

          {/* An uncached calendar is the one banner that earns full width: the
              month grid is empty without it, so this is the page's subject
              rather than an aside to it. */}
          {calendar && !calendar.available && (
            <Notice tone="clay">
              <p>{calendar.reason ?? 'No economic calendar cached yet.'}</p>
              <div className="pt-2">
                <MacroRefreshButton
                  what="calendar"
                  label="Fetch calendar"
                  showProgress
                  onFinished={() => void agenda.refresh()}
                />
              </div>
            </Notice>
          )}

          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-4">
            <div className="min-w-0">
              {view === 'month' ? (
                <MonthGrid
                  month={month}
                  today={today}
                  selected={day}
                  summaries={agenda.summaries}
                  onSelectDay={selectDay}
                  onMonthChange={(next) => patch({ month: orDefault(next, currentMonth) })}
                  minMonth={agenda.minMonth}
                  maxMonth={agenda.maxMonth}
                />
              ) : view === 'week' ? (
                <WeekTimeline
                  week={agenda.week}
                  entries={agenda.weekEntries}
                  today={today}
                  selectedDay={day}
                  selectedKey={agenda.selection.kind === 'entry'
                    ? agenda.selection.entryKey : null}
                  onSelectDay={selectDay}
                  onSelectEntry={selectEntry}
                  onWeekChange={selectDay}
                  minDate={agenda.minDate}
                  maxDate={agenda.maxDate}
                />
              ) : (
                <AgendaStream
                  entries={agenda.visible}
                  today={today}
                  prevLastSeen={agenda.prevLastSeen}
                  selection={agenda.selection}
                  onSelect={selectEntry}
                  floor={agenda.floor}
                  query={query}
                />
              )}
            </div>

            <aside className="mt-4 space-y-4 lg:mt-0">
              <NowStrip live={live} onChanged={() => void agenda.refresh()} />
              {/* The stream already groups by day, so a day panel beside it
                  would be the same rows twice. */}
              {view !== 'agenda' && (
                <DayDetail
                  date={day}
                  entries={agenda.dayEntries}
                  prevLastSeen={agenda.prevLastSeen}
                  today={today}
                  floor={agenda.floor}
                  selection={agenda.selection}
                  onSelect={selectEntry}
                />
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
