/**
 * How long a backtest takes on this machine, learned from the ones that ran.
 *
 * A sweep is the first surface that asks the user to commit to several runs at
 * once, so it owes them a number. There is no server-side estimate and there
 * should not be one — how long a run takes depends on this laptop, this store
 * and this handler, and the run index already records the only honest answer:
 * how long the last several actually took.
 *
 * The median rather than the mean, because a single run that sat queued behind
 * an afternoon of other work would drag an average into fiction.
 */
import type { Run } from './api'

/**
 * Milliseconds a typical run took, or `null` when nothing can be said.
 *
 * Measured from `started_at`, not `created_at`: `MAX_CONCURRENT_RUNS` is 1, so
 * `created_at` includes however long the run sat in the queue behind somebody
 * else's. That queue time is real, but it belongs to the *sweep's* arithmetic
 * (runs × duration), not to the duration of one run — counting it in both
 * places would double it.
 *
 * Only succeeded runs count. A failure usually dies in seconds, and letting
 * those into the sample makes a sweep look far cheaper than it is.
 */
export function medianDuration(runs: readonly Run[]): number | null {
  const spans = runs
    .filter((run) => run.status === 'succeeded' && run.started_at && run.finished_at)
    .map((run) => Date.parse(run.finished_at!) - Date.parse(run.started_at!))
    // A clock change, a hand-edited meta file or a resumed run can produce a
    // negative or absurd span. Dropping them beats reporting one.
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b)

  if (!spans.length) return null

  const mid = Math.floor(spans.length / 2)
  return spans.length % 2 ? spans[mid] : Math.round((spans[mid - 1] + spans[mid]) / 2)
}

/**
 * A duration as someone would say it out loud.
 *
 * Rounded deliberately coarsely — this is an estimate built from a handful of
 * samples, and "about 12 minutes" claims exactly as much as it knows, where
 * "11m 47s" claims a precision the median does not have.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds}s`

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}
