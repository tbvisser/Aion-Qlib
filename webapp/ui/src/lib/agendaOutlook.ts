/**
 * Helpers for the AI-generated Agenda outlook.
 *
 * The backend resolves a scope + anchor day into an inclusive date window, but
 * the UI still needs human labels ("Week of 12 Aug") and stable cache keys for
 * the hook.
 */
import { addDaysIso, formatIsoDayMonth, isoWeekday, monthLabel, monthOf } from './macroFormat'

export type OutlookScope = 'day' | 'week' | 'month'

export const OUTLOOK_SCOPES: readonly OutlookScope[] = ['day', 'week', 'month']

export function outlookScopeLabel(scope: OutlookScope): string {
  switch (scope) {
    case 'day': return 'Day'
    case 'week': return 'Week'
    case 'month': return 'Month'
  }
}

/**
 * A short label describing the window the selected day anchors for a scope.
 * The backend owns the real range; this is display only.
 */
export function outlookWindowLabel(scope: OutlookScope, anchor: string): string {
  if (scope === 'day') return formatIsoDayMonth(anchor)
  if (scope === 'month') return monthLabel(monthOf(anchor))
  // week: anchor may be any day; label from the Monday of that week.
  const monday = addDaysIso(anchor, -(weekdayIndex(anchor)))
  return `Week of ${formatIsoDayMonth(monday)}`
}

/** Monday-first weekday index, 0 = Monday … 6 = Sunday. */
function weekdayIndex(iso: string): number {
  const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(isoWeekday(iso))
  return idx < 0 ? 0 : idx
}

/** Stable key for deduping in-flight fetches. */
export function outlookCacheKey(scope: OutlookScope, anchor: string): string {
  return `${scope}:${anchor}`
}
