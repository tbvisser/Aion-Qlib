import { ChevronLeft, ChevronRight } from 'lucide-react'

import { NavButton } from '@/components/inbox/NavButton'
import { heatStripClass, TYPE_STYLES } from '@/components/inbox/typeStyles'
import { Panel } from '@/components/ui/panel'
import {
  heatTier, monthGridWeeks, type AgendaType, type DaySummary,
} from '@/lib/agenda'
import { addMonths, monthLabel, monthOf } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

const WEEKDAY_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Display order = the adjacency order the palette was validated in. */
const DOT_ORDER: AgendaType[] = ['trade', 'release', 'message', 'notification', 'process']

/** A faint hatch for out-of-month cells, Edgewonk-style. */
const HATCH = 'bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,hsl(var(--border)/0.25)_6px,hsl(var(--border)/0.25)_7px)]'

/**
 * The Edgewonk-style month calendar. Cells tint by the day's *outcome* —
 * destructive wash when anything failed, primary when work succeeded —
 * because that is the verdict this desk actually has; there is no daily P&L
 * to paint. Count, mix bar and tint describe the same filtered population the
 * day-detail panel lists; the heat band is the exception — it reports the
 * day's whole macro load, so a trades-only view still shows the loud days.
 */
export function MonthGrid({
  month, today, selected, summaries, onSelectDay, onMonthChange, minMonth, maxMonth,
}: {
  month: string
  today: string
  selected: string
  summaries: Map<string, DaySummary>
  onSelectDay: (iso: string) => void
  onMonthChange: (month: string) => void
  minMonth: string
  maxMonth: string
}) {
  const weeks = monthGridWeeks(month)

  return (
    <Panel
      title={monthLabel(month)}
      flush
      actions={
        <div className="flex items-center gap-1">
          <NavButton
            label="Previous month"
            disabled={month <= minMonth}
            onClick={() => onMonthChange(addMonthsClamped(month, -1, minMonth, maxMonth))}
          >
            <ChevronLeft className="h-4 w-4" />
          </NavButton>
          <NavButton
            label="Next month"
            disabled={month >= maxMonth}
            onClick={() => onMonthChange(addMonthsClamped(month, 1, minMonth, maxMonth))}
          >
            <ChevronRight className="h-4 w-4" />
          </NavButton>
        </div>
      }
    >
      <div className="grid grid-cols-7 border-b border-border/50 bg-foreground/[0.02] py-1.5">
        {WEEKDAY_HEAD.map((day) => (
          <div
            key={day}
            className="text-center font-mono text-[9px] uppercase tracking-widest text-muted-foreground/80"
          >
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px bg-border/60">
        {weeks.flat().map((date) => (
          <DayCell
            key={date}
            date={date}
            inMonth={monthOf(date) === month}
            isToday={date === today}
            isSelected={date === selected}
            summary={summaries.get(date)}
            onSelect={onSelectDay}
          />
        ))}
      </div>

      <p className="border-t border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground/60">
        Releases cover the viewed month; processes, trades, messages and
        notifications show recent history only.
      </p>
    </Panel>
  )
}

function addMonthsClamped(month: string, n: number, min: string, max: string): string {
  const next = addMonths(month, n)
  return next < min ? min : next > max ? max : next
}

/** The day's composition, widest type first, for the bottom mix bar. */
function typeMix(byType: Record<AgendaType, number>): { type: AgendaType; count: number }[] {
  return DOT_ORDER
    .filter((type) => byType[type] > 0)
    .map((type) => ({ type, count: byType[type] }))
}

function DayCell({ date, inMonth, isToday, isSelected, summary, onSelect }: {
  date: string
  inMonth: boolean
  isToday: boolean
  isSelected: boolean
  summary: DaySummary | undefined
  onSelect: (iso: string) => void
}) {
  const outcome = inMonth ? summary?.runOutcome ?? null : null
  const heat = inMonth ? heatTier(summary?.heat ?? 0) : 0
  const count = summary?.count ?? 0
  const mix = summary && count > 0 ? typeMix(summary.byType) : []

  return (
    <button
      type="button"
      onClick={() => onSelect(date)}
      aria-label={`${date}${count > 0 ? ` — ${count} items` : ''}`}
      className={cn(
        'relative flex min-h-[104px] flex-col bg-card p-2 text-left transition-colors hover:bg-foreground/[0.03]',
        !inMonth && cn('text-muted-foreground/40', HATCH),
        // Verdict washes — background-color only, so the hatch (a
        // background-image) always survives tailwind-merge.
        outcome === 'failed' && 'bg-destructive/[0.12]',
        outcome === 'succeeded' && 'bg-primary/[0.10]',
        isToday && !isSelected
          && 'ring-1 ring-inset ring-primary/70 shadow-[inset_0_0_12px_hsl(var(--primary)/0.12)]',
        // Ring only — a selected failed day must keep its red wash.
        isSelected && 'ring-2 ring-inset ring-primary/80',
      )}
    >
      {heat > 0 && (
        // Macro-heat strip: its own element, never a bg-* class on the cell —
        // the verdict wash owns background-color and the hatch owns
        // background-image, and neither may be merged away. Top edge is the
        // day's whole macro load; the bottom bar is this view's mix. Two
        // questions, two positions — they are not duplicates of each other.
        <span
          aria-hidden
          className={cn('absolute inset-x-0 top-0 h-[2px]', heatStripClass(heat))}
        />
      )}
      {outcome !== null && (
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0 left-0 w-0.5',
            outcome === 'failed' ? 'bg-destructive/60' : 'bg-primary/60',
          )}
        />
      )}

      <span className="flex items-baseline justify-between gap-1">
        <span className={cn(
          'tnum font-mono text-[11px] leading-none',
          isToday ? 'font-medium text-primary'
            : inMonth ? 'text-foreground/80' : 'text-muted-foreground/40',
        )}>
          {Number(date.slice(8, 10))}
        </span>
        {count > 0 && (
          <span className="tnum font-mono text-[10px] leading-none text-muted-foreground/50">
            {count}
          </span>
        )}
      </span>

      {/* The day's one headline, or nothing. An ordinary day staying silent is
          what lets a named day carry weight — labelling all thirty would put
          the wallpaper back. */}
      <span className="flex flex-1 items-center justify-center px-0.5">
        {summary?.marquee && (
          <span className={cn(
            'line-clamp-2 text-center text-[11px] font-medium leading-tight',
            inMonth ? 'text-foreground/85' : 'text-muted-foreground/40',
          )}>
            {summary.marquee}
            {summary.marqueeMore > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {' '}+{summary.marqueeMore}
              </span>
            )}
          </span>
        )}
      </span>

      {/* Fixed-height slot whether or not it is filled, so rows never jitter.
          The 2px gaps are surface showing through — never borders. */}
      <span aria-hidden className="flex h-1 w-full gap-[2px]">
        {mix.map(({ type, count: n }) => (
          <span
            key={type}
            style={{ flexGrow: n, flexBasis: 0 }}
            className={cn('rounded-[1px]', TYPE_STYLES[type].dot)}
          />
        ))}
      </span>
    </button>
  )
}
