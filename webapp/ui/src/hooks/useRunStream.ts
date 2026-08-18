import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Run, type RunReport } from '@/lib/api'
import { streamSSE } from '@/lib/authFetch'

/** Lines kept client-side. Older output is dropped and never re-fetched. */
const LOG_LIMIT = 600

export interface RunStream {
  run: Run | null
  log: string[]
  report: RunReport | null
  cancel: () => void
  cancelling: boolean
  /** The event stream is down and retrying. The run itself is unaffected. */
  stalled: boolean
}

/**
 * Follows one run: its status, its log, and — once it succeeds — its report.
 *
 * The backend already streams all three over SSE, so this polls nothing. It is
 * shared by the Runs page and the builder's run dock precisely so the two can
 * never disagree about what a run is doing.
 *
 * @param runId  the run to follow, or null to follow nothing
 * @param onFinish called once the run reaches a terminal status, and after a
 *   cancel — the caller usually refreshes a list with it
 * @param seed a Run the caller already has (the one `startRun` returned), shown
 *   immediately so the first paint is the real status rather than "Loading…"
 */
export function useRunStream(
  runId: string | null,
  onFinish?: () => void,
  seed?: Run | null,
): RunStream {
  const [run, setRun] = useState<Run | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [report, setReport] = useState<RunReport | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [stalled, setStalled] = useState(false)

  // Held in a ref so a caller re-creating the callback — which happens whenever
  // the builder saves a strategy — cannot tear down a live EventSource and wipe
  // the log buffer mid-run. Only the run id may do that.
  const finishRef = useRef(onFinish)
  finishRef.current = onFinish

  useEffect(() => {
    // Seeded only when it is the run being asked for: a stale seed from a
    // previous run must not flash while the new one loads.
    setRun(seed && seed.id === runId ? seed : null)
    setLog([])
    setReport(null)
    setCancelling(false)
    if (!runId) return

    let cancelled = false
    setStalled(false)
    void api.getRun(runId).then((r) => !cancelled && setRun(r)).catch(() => undefined)

    // How many log lines we already hold. The stream is resumed from this
    // offset on every reconnect — restarting at line 0, against a client that
    // appends, showed up as a duplicated log after any network hiccup.
    let offset = 0
    let controller: AbortController | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let done = false

    // Read over `fetch` rather than with EventSource. EventSource cannot send
    // an Authorization header, and /api/runs/:id/events now requires one — an
    // EventSource here would connect and then silently deliver nothing, which
    // looks exactly like a backtest that has stopped making progress.
    // Reconnection was already hand-rolled below, so nothing is lost.
    const connect = () => {
      if (cancelled || done) return
      const ac = new AbortController()
      controller = ac

      const onEvent = (event: string, raw: string) => {
        if (event === 'log') {
          const data = JSON.parse(raw)
          if (typeof data.offset === 'number') offset = data.offset
          attempt = 0
          setStalled(false)
          setLog((prev) => [...prev, ...data.lines].slice(-LOG_LIMIT))
        } else if (event === 'status') {
          attempt = 0
          setStalled(false)
          setRun(JSON.parse(raw))
        } else if (event === 'done') {
          const finished: Run = JSON.parse(raw)
          done = true
          setRun(finished)
          setStalled(false)
          ac.abort()
          controller = null
          finishRef.current?.()
          if (finished.status === 'succeeded') {
            void api.runReport(runId).then((r) => !cancelled && setReport(r)).catch(() => undefined)
          }
        }
      }

      // A dead stream used to leave a phase spinning forever with nothing said.
      // Retry with a backoff, and tell the caller while it is down — a stalled
      // connection and a slow backtest look identical otherwise.
      const fail = () => {
        controller = null
        if (cancelled || done) return
        setStalled(true)
        attempt += 1
        retry = setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 15000))
      }

      void streamSSE(`/runs/${runId}/events?offset=${offset}`, {
        signal: ac.signal,
        onEvent,
      })
        // A clean end without a `done` frame still means the connection
        // dropped, so it reconnects the same way an error does.
        .then(() => { if (!ac.signal.aborted) fail() })
        .catch(() => { if (!ac.signal.aborted) fail() })
    }

    connect()

    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      controller?.abort()
    }
    // `seed` is read once per run id on purpose — it is a first-paint value, not
    // a subscription. Re-running the effect when the caller's object identity
    // changes would tear down a live stream mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  // A run that had already finished before this mounted emits no 'done'.
  useEffect(() => {
    if (!runId || run?.status !== 'succeeded' || report) return
    let cancelled = false
    void api.runReport(runId).then((r) => !cancelled && setReport(r)).catch(() => undefined)
    return () => { cancelled = true }
  }, [run?.status, report, runId])

  const cancel = useCallback(() => {
    if (!runId) return
    setCancelling(true)
    void api.cancelRun(runId)
      .then(() => finishRef.current?.())
      .catch(() => undefined)
      .finally(() => setCancelling(false))
  }, [runId])

  return { run, log, report, cancel, cancelling, stalled }
}

/** True while a run can still change on its own. */
export function isActive(run: Run | null | undefined): boolean {
  return run?.status === 'running' || run?.status === 'queued'
}
