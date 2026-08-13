/**
 * The Agenda's URL state: `?type=`, `?view=`, `?month=`, `?day=`, `?entry=`
 * and `?q=`.
 *
 * Lives here rather than in the page for the same reason every other agenda
 * rule does — it is string arithmetic with edge cases (a hand-edited month, a
 * cache that starts later than the navigable floor, a stale entry key), and
 * vitest can pin it where JSX cannot.
 *
 * Two conventions the whole module keeps:
 *
 * - **Anything unrecognised repairs to the default** rather than throwing or
 *   rendering an empty page. A URL is user input.
 * - **Defaults are never written.** A param only appears once it differs from
 *   what the page would show anyway, so the common case has a clean URL and
 *   "is this the default view?" is answerable by looking at it.
 */
import type { AgendaFilter } from './agenda'
import { monthOf, todayIso } from './macroFormat'

/**
 * Month is the calendar overview, week the intraday axis, agenda the
 * chronological stream. Month stays the default: the shape of the load across
 * a month is the one thing no other page in the app shows, and the stream is
 * one click away for whoever wants a flat list instead.
 */
export type AgendaView = 'month' | 'week' | 'agenda'

const VIEWS: ReadonlySet<string> = new Set<AgendaView>(['month', 'week', 'agenda'])

const FILTERS: ReadonlySet<string> = new Set<AgendaFilter>([
  'all', 'release', 'process', 'trade', 'message', 'notification',
])

const MONTH_RE = /^\d{4}-\d{2}$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export const DEFAULT_VIEW: AgendaView = 'month'
export const DEFAULT_FILTER: AgendaFilter = 'all'

export interface AgendaParams {
  filter: AgendaFilter
  view: AgendaView
  /**
   * The month asked for, shape-checked but **not** yet clamped: the navigable
   * floor depends on the calendar's real coverage, which is not known until
   * that month's range has been fetched. Pass this through `clampMonth` once
   * the bounds are in.
   */
  monthCandidate: string
  day: string
  /** Honoured only while its row is on screen — see `resolveSelection`. */
  entryKey: string | null
  query: string
}

export function resolveView(raw: string | null): AgendaView {
  return raw && VIEWS.has(raw) ? (raw as AgendaView) : DEFAULT_VIEW
}

export function resolveFilter(raw: string | null): AgendaFilter {
  return raw && FILTERS.has(raw) ? (raw as AgendaFilter) : DEFAULT_FILTER
}

export function readAgendaParams(
  params: URLSearchParams,
  today: string = todayIso(),
): AgendaParams {
  const rawMonth = params.get('month')
  const rawDay = params.get('day')
  return {
    filter: resolveFilter(params.get('type')),
    view: resolveView(params.get('view')),
    monthCandidate: rawMonth && MONTH_RE.test(rawMonth) ? rawMonth : monthOf(today),
    day: rawDay && DAY_RE.test(rawDay) ? rawDay : today,
    entryKey: params.get('entry'),
    query: params.get('q') ?? '',
  }
}

/**
 * The month actually shown. `minMonth` is the cache's real reach, so a URL
 * pointing before the data exists lands on the earliest month that has any
 * rather than on an empty grid with working arrows.
 */
export function clampMonth(
  candidate: string,
  bounds: { minMonth: string; maxMonth: string },
): string {
  if (candidate < bounds.minMonth) return bounds.minMonth
  if (candidate > bounds.maxMonth) return bounds.maxMonth
  return candidate
}

/**
 * Apply param updates, deleting on `null`. Callers pass `null` for anything
 * that has fallen back to its default — see `orDefault`.
 */
export function agendaPatch(
  params: URLSearchParams,
  updates: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
  }
  return next
}

/** `null` when the value is the default, so `agendaPatch` drops the param. */
export function orDefault<T extends string>(value: T, fallback: T): T | null {
  return value === fallback ? null : value
}
