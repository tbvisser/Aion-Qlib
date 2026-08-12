/**
 * "16 minutes ago" — the stamp an index row carries beside its title.
 *
 * Distinct from `features/rag/lib/dates.ts#formatRelativeDay`, which buckets a
 * timestamp into Today / Yesterday for a list's day *headings*. That one groups;
 * this one dates a single row, and the two want different words for the same
 * instant. Both exist on purpose.
 *
 * Past a week the elapsed count stops being readable ("37 days ago" is a date
 * with extra steps), so it falls back to a calendar date — with the year only
 * once it stops being this one.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Pluralise without a library: `plural(1, 'minute')` -> "1 minute". */
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

export function formatRelativeStamp(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''

  const elapsed = now.getTime() - then.getTime()

  // A clock skewed a little into the future should read as "just now", not as a
  // negative count. Anything genuinely future-dated falls through to the date.
  if (elapsed < 0 && elapsed > -MINUTE) return 'just now'

  if (elapsed >= 0) {
    if (elapsed < MINUTE) return 'just now'
    if (elapsed < HOUR) return `${plural(Math.floor(elapsed / MINUTE), 'minute')} ago`
    if (elapsed < DAY) return `${plural(Math.floor(elapsed / HOUR), 'hour')} ago`
    if (elapsed < 7 * DAY) return `${plural(Math.floor(elapsed / DAY), 'day')} ago`
  }

  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}
