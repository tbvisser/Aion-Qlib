/** Midnight of the calendar day `date` falls on, in the viewer's local zone. */
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * A timestamp as the day it happened: 'Today', 'Yesterday', or a short date.
 *
 * The year is dropped for the current year — 'Mar 5' in 2026, 'Mar 5, 2025'
 * before that — so the common case stays short while older rows stay
 * unambiguous. Comparison is by local calendar day, not elapsed hours, so
 * 23:59 and 00:01 land on the labels a reader expects. Intl does the
 * formatting; no date library.
 */
export function formatRelativeDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const daysAgo = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / MS_PER_DAY)
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}
