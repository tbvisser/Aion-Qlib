/**
 * The Agenda's "At a glance" rows.
 *
 * Every number here has a source the reader can open below it, and the two
 * honesty rules the KPI tiles established travel with them:
 *
 * - **Unknowable reads as an em dash, never as a zero.** An uncached calendar
 *   does not mean no releases; a 30-day window with no finished runs does not
 *   mean none succeeded.
 * - **A capped feed says so.** `/api/activity` tops out at 200 events and each
 *   book returns its 5 most recent rebalances, so a figure that may have been
 *   truncated carries a footnote instead of quietly under-reporting.
 *
 * The caps are imported rather than restated. The tile row this replaces
 * hard-coded 200, 5 and 7 in a second place, and the two copies had already
 * drifted apart from the fetches that set them.
 */
import { AGENDA_FUTURE_DAYS } from './agenda'
import type { MacroCalendar, PortfolioRebalances } from './api'
import { daysBetween, monthLabel, todayIso } from './macroFormat'

export interface SummaryRow {
  label: string
  /** Already formatted — `'—'` where the answer is not knowable. */
  value: string
  /** The detail the value alone would hide. */
  sub?: string
  /** A coverage caveat: why this number might not be the whole story. */
  footnote?: string
}

export interface AgendaSummaryInput {
  /**
   * The **forward-only** calendar (today … today + 7), not the timeline's
   * window. The endpoint caps at 1000 rows filled ascending, so a window wide
   * enough to reach back a year has already spent the cap before it gets here
   * and would report 0 releases coming.
   */
  calendar: MacroCalendar | null
  runStats: { succeeded: number; failed: number }
  rebalances: PortfolioRebalances[]
  /** The month being viewed — the rebalance row counts that month, not today's. */
  month: string
  unreadCount: number
  /** True when the activity feed came back at its cap. */
  activityCapped: boolean
  /** The per-book rebalance limit, so the cap footnote can name it. */
  rebalanceLimit: number
  activityLimit: number
  today?: string
}

export function agendaSummary(input: AgendaSummaryInput): SummaryRow[] {
  const today = input.today ?? todayIso()
  return [
    releaseRow(input, today),
    backtestRow(input),
    rebalanceRow(input),
    unreadRow(input),
  ]
}

function releaseRow({ calendar }: AgendaSummaryInput, today: string): SummaryRow {
  const label = `Releases · next ${AGENDA_FUTURE_DAYS}d`
  if (!calendar?.available) {
    return { label, value: '—', footnote: 'calendar not cached yet' }
  }
  // Clipped rather than trusted: the fetch is bounded at today + 7, but the
  // row only ever promises what its label says.
  const forward = calendar.upcoming.filter((release) => {
    const away = daysBetween(today, release.date)
    return away >= 0 && away <= AGENDA_FUTURE_DAYS
  })
  const headline = forward.filter((release) => release.importance === 'headline').length
  return {
    label,
    value: String(forward.length),
    sub: headline > 0 ? `${headline} headline` : undefined,
    footnote: calendar.stale ? 'calendar may be behind' : undefined,
  }
}

function backtestRow({ runStats, activityCapped, activityLimit }: AgendaSummaryInput): SummaryRow {
  const total = runStats.succeeded + runStats.failed
  return {
    label: 'Backtests · 30d',
    value: total === 0 ? '—' : String(runStats.succeeded),
    sub: total === 0 ? 'none in window'
      : runStats.failed > 0 ? `${runStats.failed} failed`
        : 'all passed',
    footnote: activityCapped ? `last ${activityLimit} events` : undefined,
  }
}

function rebalanceRow(
  { rebalances, month, rebalanceLimit }: AgendaSummaryInput,
): SummaryRow {
  const inMonth = (date: string) => date.slice(0, 7) === month
  const events = rebalances.flatMap((book) => book.rebalances.filter((e) => inMonth(e.date)))
  const books = rebalances.filter((book) => book.rebalances.some((e) => inMonth(e.date))).length
  // A book whose whole reply landed in this month and came back full may have
  // had more: the limit, not the month, decided where its list stopped.
  const capped = rebalances.some((book) => book.rebalances.length >= rebalanceLimit
    && book.rebalances.every((e) => inMonth(e.date)))
  return {
    label: `Rebalances · ${monthLabel(month)}`,
    value: String(events.length),
    sub: rebalances.length > 0
      ? `${books} of ${rebalances.length} ${rebalances.length === 1 ? 'book' : 'books'}`
      : undefined,
    footnote: capped ? `${rebalanceLimit} most recent per book` : undefined,
  }
}

function unreadRow({ unreadCount }: AgendaSummaryInput): SummaryRow {
  return {
    label: 'Unread',
    value: String(unreadCount),
    sub: unreadCount === 0 ? 'all caught up' : undefined,
  }
}
