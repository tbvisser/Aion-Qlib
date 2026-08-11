import { useEffect, useState } from 'react'

import { api, type Run, type RunReport } from '@/lib/api'

/**
 * Reports for many runs at once, without a burst.
 *
 * `GET /runs/{id}/report` is not cheap: it calls `require_qlib()` and reads
 * mlflow artifacts off disk. ML Studio already fanned it out over every
 * succeeded run, and the backtest ledger is about to want the same thing, so
 * this is the shared version rather than the third copy.
 *
 * Three properties, each load-bearing:
 *
 * **Gated.** Four at a time. A hundred parallel requests against a degraded
 * backend is a hundred simultaneous 503s, which is worse than slow.
 *
 * **Per-run failure tolerated.** A run whose artifacts have been cleaned up
 * resolves to `null` and shows without metrics, rather than taking the table
 * down with it.
 *
 * **Cached at module level**, because a report never changes once the run has
 * finished — that is the whole meaning of "finished".
 */
const cache = new Map<string, RunReport | null>()
const inflight = new Map<string, Promise<RunReport | null>>()

const CONCURRENCY = 4

function fetchReport(id: string): Promise<RunReport | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null)
  let pending = inflight.get(id)
  if (!pending) {
    pending = api.runReport(id)
      .then((report) => {
        cache.set(id, report)
        return report
      })
      .catch(() => {
        // Cached as a null result on purpose: a run whose artifacts are gone
        // will not grow them back, and retrying on every render would hammer
        // the endpoint for an answer that cannot change.
        cache.set(id, null)
        return null
      })
      .finally(() => { inflight.delete(id) })
    inflight.set(id, pending)
  }
  return pending
}

/** Run reports keyed by id. Only succeeded runs are fetched. */
export function useRunReports(runs: readonly Run[]) {
  const [reports, setReports] = useState<Record<string, RunReport | null>>({})
  const [loading, setLoading] = useState(false)

  // Depend on the id list, not the array identity: the builder refetches
  // `/runs` on a timer and would otherwise restart this on every poll.
  const ids = runs.filter((r) => r.status === 'succeeded').map((r) => r.id).join(',')

  useEffect(() => {
    const wanted = ids ? ids.split(',') : []
    if (!wanted.length) return

    let cancelled = false
    setLoading(true)

    const run = async () => {
      const queue = [...wanted]
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const id = queue.shift()
          if (id === undefined || cancelled) return
          const report = await fetchReport(id)
          if (cancelled) return
          setReports((prev) => (prev[id] === report ? prev : { ...prev, [id]: report }))
        }
      })
      await Promise.all(workers)
      if (!cancelled) setLoading(false)
    }

    void run()
    return () => { cancelled = true }
  }, [ids])

  return { reports, loading }
}
