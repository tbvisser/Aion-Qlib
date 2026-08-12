import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

import { MacroRefreshButton } from '@/components/MacroRefreshButton'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAgendaCalendar, useMonthCalendar } from '@/hooks/useMacro'
import { countByDate, gridRange, monthGridWeeks } from '@/lib/agenda'
import type { MacroRelease } from '@/lib/api'
import {
  addMonths, agendaDayLabel, daysBetween, monthLabel, monthOf, todayIso,
} from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

const HATCH = 'bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,hsl(var(--border)/0.25)_5px,hsl(var(--border)/0.25)_6px)]'

/**
 * The Dashboard's calendar corner: a compact month grid of economic releases.
 *
 * The trigger badge stays forward-only (releases in the next seven days) and
 * keeps its own narrow query, so browsing months in the popover never changes
 * what the badge promises. The month view fetches per viewed month, only
 * while the popover is open.
 */
export function AgendaWidget() {
  const { calendar: weekCalendar, refresh: refreshWeek } = useAgendaCalendar()
  const [open, setOpen] = useState(false)
  const today = todayIso()
  const currentMonth = monthOf(today)
  const [month, setMonth] = useState(currentMonth)
  const [selectedDay, setSelectedDay] = useState(today)

  const grid = useMemo(() => gridRange(month), [month])
  const { calendar, refresh } = useMonthCalendar(grid, 'US', open)

  const badgeCount = weekCalendar?.available
    ? weekCalendar.upcoming.filter((r) => daysBetween(today, r.date) <= 7).length
    : 0

  const releases = useMemo(
    () => (calendar?.available ? [...calendar.past, ...calendar.upcoming] : []),
    [calendar],
  )
  const perDay = useMemo(() => countByDate(releases), [releases])
  const dayReleases = useMemo(
    () => releases
      .filter((r) => r.date === selectedDay)
      .sort((a, b) => ((a.time ?? '') < (b.time ?? '') ? -1 : 1)),
    [releases, selectedDay],
  )

  const minMonth = useMemo(() => {
    const floor = addMonths(currentMonth, -12)
    const cacheFrom = calendar?.cache_from ? monthOf(calendar.cache_from) : null
    return cacheFrom && cacheFrom > floor ? cacheFrom : floor
  }, [currentMonth, calendar?.cache_from])
  const maxMonth = addMonths(currentMonth, 1)

  const label = badgeCount > 0
    ? `Economic calendar — ${badgeCount} releases in the next 7 days`
    : 'Economic calendar'

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          // Fresh look each time: current month, today selected, fresh badge.
          setMonth(currentMonth)
          setSelectedDay(today)
          void refreshWeek()
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="dashboard-calendar-collapsed"
          title={label}
          aria-label={label}
          className={cn(
            'relative flex h-10 w-10 items-center justify-center rounded-xl border border-border/50 bg-card text-muted-foreground transition-colors hover:text-foreground',
            badgeCount > 0 ? 'shadow-glow' : 'shadow-card',
          )}
        >
          <CalendarDays className="h-4 w-4" />
          {badgeCount > 0 && (
            <span
              data-testid="dashboard-calendar-count"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[9px] font-medium text-primary-foreground"
            >
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <div className="relative flex items-center justify-between gap-2 bg-foreground/[0.02] px-3 py-2">
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-primary/50 via-border to-transparent"
          />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {monthLabel(month)}
          </span>
          <div className="flex items-center gap-1">
            {calendar?.available && calendar.stale && (
              <span className="mr-1 font-mono text-[10px] text-clay">stale</span>
            )}
            <MiniNav
              disabled={month <= minMonth}
              label="Previous month"
              onClick={() => setMonth(addMonths(month, -1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </MiniNav>
            <MiniNav
              disabled={month >= maxMonth}
              label="Next month"
              onClick={() => setMonth(addMonths(month, 1))}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </MiniNav>
          </div>
        </div>

        <div className="p-3">
          {!calendar ? (
            <div className="h-40 animate-subtle-pulse" />
          ) : !calendar.available ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {calendar.reason ?? 'No economic calendar cached yet.'}
              </p>
              <MacroRefreshButton
                what="calendar"
                label="Fetch calendar"
                showProgress
                onFinished={() => void refresh()}
              />
            </div>
          ) : (
            <>
              <div className="mb-1 grid grid-cols-7">
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                  <div
                    key={`${d}${i}`}
                    className="text-center font-mono text-[9px] uppercase text-muted-foreground/50"
                  >
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border/50 bg-border/40">
                {monthGridWeeks(month).flat().map((date) => (
                  <MiniCell
                    key={date}
                    date={date}
                    inMonth={monthOf(date) === month}
                    isToday={date === today}
                    isSelected={date === selectedDay}
                    count={perDay.get(date) ?? 0}
                    onSelect={setSelectedDay}
                  />
                ))}
              </div>

              <div className="mt-3">
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {agendaDayLabel(selectedDay, today)}
                </div>
                {dayReleases.length === 0 ? (
                  <p className="py-1 text-xs text-muted-foreground">
                    No releases on this day.
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto">
                    {dayReleases.map((row, i) => (
                      <AgendaRow key={`${row.event_key}-${row.date}-${i}`} row={row} today={today} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="border-t border-border/50 px-3 py-2">
          <Link
            to="/macro"
            onClick={() => setOpen(false)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            Open Macro Desk <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function MiniNav({ disabled, label, onClick, children }: {
  disabled: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
        disabled ? 'opacity-40' : 'hover:bg-foreground/[0.04] hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function MiniCell({ date, inMonth, isToday, isSelected, count, onSelect }: {
  date: string
  inMonth: boolean
  isToday: boolean
  isSelected: boolean
  count: number
  onSelect: (iso: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(date)}
      aria-label={`${date}${count > 0 ? ` — ${count} releases` : ''}`}
      className={cn(
        'flex aspect-square flex-col items-center justify-center gap-0.5 bg-card transition-colors hover:bg-foreground/[0.04]',
        !inMonth && cn('text-muted-foreground/40', HATCH),
        isToday && !isSelected && 'ring-1 ring-inset ring-foreground/25',
        isSelected && 'ring-1 ring-inset ring-primary/60',
      )}
    >
      <span className={cn(
        'tnum font-mono text-[10px] leading-none',
        isToday ? 'font-medium text-primary'
          : inMonth ? 'text-foreground/80' : 'text-muted-foreground/40',
      )}>
        {Number(date.slice(8, 10))}
      </span>
      {/* Intensity ladder in a fixed-height slot so rows never jitter:
          1 = faint dot, 2–3 = glowing dot, 4+ = count pill. */}
      <span className="flex h-3 items-center">
        {count === 0 ? (
          <span className="h-1 w-1" />
        ) : count === 1 ? (
          <span className="h-1 w-1 rounded-full bg-type-release/60" />
        ) : count <= 3 ? (
          <span className="h-1 w-1 rounded-full bg-type-release shadow-[0_0_4px_hsl(var(--type-release)/0.7)]" />
        ) : (
          <span className="tnum rounded-sm bg-type-release/15 px-0.5 font-mono text-[8px] leading-3 text-type-release">
            {count}
          </span>
        )}
      </span>
    </button>
  )
}

const num = (v: number | null) => (v == null ? '—' : String(v))

/**
 * One release row. The desk's honesty rules hold: a surprise needs both
 * sides (backend-computed), and a past release with no actual reads
 * "awaiting", never zero.
 */
function AgendaRow({ row, today }: { row: MacroRelease; today: string }) {
  const awaiting = row.actual == null && row.date < today
  return (
    <div className="flex items-baseline gap-2 border-b border-border/30 py-1 text-xs last:border-0">
      <span className="tnum w-10 shrink-0 font-mono text-[11px] text-type-release">
        {row.time ?? '—'}
      </span>
      <span className="min-w-0 truncate">
        {row.type}
        {row.comparison && (
          <span className="ml-1 font-mono text-[9px] uppercase text-muted-foreground/60">
            {row.comparison}
          </span>
        )}
      </span>
      <span className="tnum ml-auto shrink-0 font-mono text-[11px]">
        {row.actual != null ? (
          <span className={cn(row.surprise != null
            && (row.surprise > 0 ? 'text-primary'
              : row.surprise < 0 ? 'text-clay' : 'text-muted-foreground'))}>
            {num(row.actual)}
          </span>
        ) : awaiting ? (
          <span className="text-muted-foreground/60">awaiting</span>
        ) : (
          <span className="text-muted-foreground">est {num(row.estimate)}</span>
        )}
      </span>
    </div>
  )
}
