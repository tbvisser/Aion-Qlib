import type { ComponentType, ReactNode } from 'react'
import { CalendarClock, FlaskConical, Radio, Scale } from 'lucide-react'

import { AreaCurve, GaugeArc, Ring } from '@/components/inbox/TileVisuals'
import { countByDate } from '@/lib/agenda'
import type { MacroCalendar, PortfolioRebalances } from '@/lib/api'
import { addDaysIso, daysBetween, todayIso } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

/** The forward window the releases tile promises, in days. */
const FORWARD_DAYS = 7

/**
 * The Edgewonk-style KPI row, from real data only. Every number here has a
 * source the user can inspect below; anything unknowable shows an em dash
 * and, where useful, a footnote about coverage — never a fabricated zero.
 *
 * Each tile pairs its value with one chart glyph: a curve where the story is
 * change over time, a gauge or ring where it is a rate against a total, and
 * nothing at all on the one tile that is purely a status.
 */
export function StatCards({
  weekCalendar, runStats, activityCapped, rebalances, month, liveCount, unreadCount,
}: {
  /** The forward-only calendar (next 7d) — stable while browsing months. */
  weekCalendar: MacroCalendar | null
  runStats: { succeeded: number; failed: number }
  /** True when the activity feed hit its 200-event cap. */
  activityCapped: boolean
  rebalances: PortfolioRebalances[]
  /** The month whose rebalances are counted — the viewed month. */
  month: string
  liveCount: number
  unreadCount: number
}) {
  const today = todayIso()
  const upcoming = weekCalendar?.available
    ? weekCalendar.upcoming.filter((r) => daysBetween(today, r.date) <= FORWARD_DAYS)
    : null

  // One point per forward day, including the quiet ones — the curve's shape is
  // only honest if the empty days are in it.
  const perDay = upcoming ? countByDate(upcoming) : null
  const releaseCurve = perDay
    ? Array.from({ length: FORWARD_DAYS }, (_, i) => perDay.get(addDaysIso(today, i)) ?? 0)
    : []
  const headline = upcoming?.filter((r) => r.importance === 'headline').length ?? 0

  const monthEvents = rebalances.flatMap(
    (book) => book.rebalances.filter((e) => e.date.slice(0, 7) === month),
  )
  const booksThisMonth = rebalances.filter(
    (book) => book.rebalances.some((e) => e.date.slice(0, 7) === month),
  ).length
  const anyCapped = rebalances.some(
    (book) => book.rebalances.length >= 5
      && book.rebalances.every((e) => e.date.slice(0, 7) === month),
  )

  const runsTotal = runStats.succeeded + runStats.failed

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Releases · next 7d"
        value={upcoming === null ? '—' : String(upcoming.length)}
        sub={upcoming && headline > 0 ? `${headline} headline` : undefined}
        footnote={weekCalendar && !weekCalendar.available
          ? 'calendar not cached yet' : undefined}
        Icon={CalendarClock}
        chip="bg-type-release/10 text-type-release"
        visual={<AreaCurve values={releaseCurve} className="text-type-release" />}
      />
      <StatCard
        label="Backtests · 30d"
        value={runsTotal === 0 ? '—' : String(runStats.succeeded)}
        sub={runsTotal === 0 ? 'none in window'
          : runStats.failed > 0 ? `${runStats.failed} failed` : 'all passed'}
        footnote={activityCapped ? 'last 200 events' : undefined}
        Icon={FlaskConical}
        // Neutral chip on purpose: this tile's gauge already wears a verdict
        // colour, and an identity hue beside it would muddy both.
        chip="bg-foreground/[0.06] text-muted-foreground"
        visual={
          <GaugeArc
            value={runStats.succeeded}
            total={runsTotal}
            className={runStats.failed > 0 && runStats.succeeded === 0
              ? 'text-destructive' : 'text-primary'}
          />
        }
      />
      <StatCard
        label="Rebalances · this month"
        value={String(monthEvents.length)}
        sub={rebalances.length > 0
          ? `${booksThisMonth} of ${rebalances.length} books` : undefined}
        footnote={anyCapped ? '5 most recent per book' : undefined}
        Icon={Scale}
        chip="bg-type-trade/10 text-type-trade"
        visual={
          <Ring value={booksThisMonth} total={rebalances.length} className="text-type-trade" />
        }
      />
      <StatCard
        label="Now"
        value={String(liveCount)}
        sub={`${unreadCount} unread`}
        Icon={Radio}
        chip={cn('bg-primary/10 text-primary', liveCount > 0 && 'animate-subtle-pulse')}
        // A status tile: whether anything is moving is the whole message, and
        // a plot of "0" would be decoration.
        visual={
          <span
            aria-hidden
            className={cn(
              'mb-1 h-2.5 w-2.5 rounded-full',
              liveCount > 0
                ? 'animate-subtle-pulse bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]'
                : 'bg-foreground/15',
            )}
          />
        }
      />
    </div>
  )
}

function StatCard({ label, value, sub, footnote, Icon, chip, visual }: {
  label: string
  value: ReactNode
  /** One line under the value — the detail the value alone would hide. */
  sub?: string
  footnote?: string
  Icon: ComponentType<{ className?: string }>
  chip: string
  visual: ReactNode
}) {
  return (
    <div className="group relative rounded-xl border border-border/50 bg-card px-3.5 py-3 shadow-sm transition-shadow hover:shadow-card-hover">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {label}
        </span>
        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded', chip)}>
          <Icon className="h-3 w-3" />
        </span>
      </div>

      {/* Value left, glyph right — Edgewonk's tile shape. Proportional figures,
          not tnum: padding every digit to a zero's width makes a standalone
          display number read loose. */}
      <div className="mt-2.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[26px] font-semibold leading-none">{value}</div>
          {sub && (
            <div className="mt-1.5 truncate text-[11px] text-muted-foreground">{sub}</div>
          )}
        </div>
        <div className="flex shrink-0 items-end">{visual}</div>
      </div>

      {footnote && (
        <div className="mt-1.5 text-[10px] text-muted-foreground/60">{footnote}</div>
      )}
    </div>
  )
}
