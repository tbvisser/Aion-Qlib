/**
 * The Inbox agenda's secondary feeds: run signals, chat threads, portfolio
 * rebalances.
 *
 * Each degrades independently — the RAG backend being down, a book being
 * unpriceable or a run having recorded no predictions must cost the agenda
 * one lane, never the page. Errors are swallowed and the lane stays at its
 * last good value (the RunsPage convention).
 */
import { useEffect, useRef, useState } from 'react'

import { listThreads } from '@/features/rag/lib/api'
import { api, type ActivityItem, type PortfolioRebalances } from '@/lib/api'
import type { SignalSnapshot, ThreadSummary } from '@/lib/agenda'

const THREADS_POLL_MS = 5 * 60_000
const REBALANCE_POLL_MS = 15 * 60_000
const SIGNAL_RUNS = 5

/**
 * One signal snapshot per recent succeeded run — the model's top picks on the
 * prediction date. Fetched lazily and cached per run id: a run's predictions
 * never change after it finishes, so each id is fetched at most once. Runs
 * without predictions are skipped silently (normal for older runs).
 */
export function useRunSignals(items: ActivityItem[]): SignalSnapshot[] {
  const [signals, setSignals] = useState<SignalSnapshot[]>([])
  // null marks "fetched, nothing there" so failures are not retried per poll.
  const cache = useRef(new Map<string, SignalSnapshot | null>())

  const wanted = items
    .filter((i) => i.kind === 'run' && i.status === 'succeeded')
    .sort((a, b) => ((b.finished_at ?? '') < (a.finished_at ?? '') ? -1 : 1))
    .slice(0, SIGNAL_RUNS)
  const signature = wanted.map((i) => i.source_id).join(',')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      for (const run of wanted) {
        if (cache.current.has(run.source_id)) continue
        try {
          const pred = await api.runPredictions(run.source_id)
          cache.current.set(run.source_id, pred.top.length
            ? { runId: run.source_id, runTitle: run.title, date: pred.date, top: pred.top }
            : null)
        } catch {
          cache.current.set(run.source_id, null)
        }
      }
      if (cancelled) return
      setSignals(wanted
        .map((run) => cache.current.get(run.source_id))
        .filter((s): s is SignalSnapshot => Boolean(s)))
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return signals
}

/** Recent chat threads. An unreachable RAG backend keeps the last good list. */
export function useThreadFeed(): ThreadSummary[] {
  const [threads, setThreads] = useState<ThreadSummary[]>([])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      listThreads({ limit: 20 })
        .then((page) => {
          if (!cancelled) {
            setThreads(page.threads.map((t) => ({
              id: t.id, title: t.title, updated_at: t.updated_at,
            })))
          }
        })
        .catch(() => {
          /* lane stays at last good value */
        })
    }
    load()
    const id = setInterval(load, THREADS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return threads
}

/**
 * Recent rebalance events per book with a rebalance rule. The first load may
 * trigger a NAV compute per portfolio server-side; after that it is served
 * from the NAV cache. Books that fail to price answer softly (reason + empty
 * list) and simply contribute nothing.
 */
export function useRebalanceFeed(): PortfolioRebalances[] {
  const [books, setBooks] = useState<PortfolioRebalances[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { summaries } = await api.listPortfolios()
        const candidates = summaries.filter((s) => s.rebalance !== 'none')
        const settled = await Promise.allSettled(
          candidates.map((s) => api.portfolioRebalances(s.id, { limit: 5 })),
        )
        if (cancelled) return
        setBooks(settled
          .filter((r): r is PromiseFulfilledResult<PortfolioRebalances> =>
            r.status === 'fulfilled')
          .map((r) => r.value))
      } catch {
        /* lane stays at last good value */
      }
    }
    void load()
    const id = setInterval(() => void load(), REBALANCE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return books
}
