import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Columns2 } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ComingSoon } from '@/components/ComingSoon'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Panel } from '@/components/ui/panel'
import { Button } from '@/components/ui/button'
import { RunCompareModal } from '@/components/runs/RunCompareModal'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { TrainPanel } from '@/components/mlstudio/TrainPanel'
import { useRunReports } from '@/hooks/useRunReports'
import { api, type ModelsResponse, type Run, type RunReport } from '@/lib/api'
import { metricRow, rankValue } from '@/lib/runMetrics'
import { cn } from '@/lib/utils'

interface Row {
  run: Run
  report: RunReport | null
}

/** Statuses a run can still move out of. */
const IN_FLIGHT = new Set(['queued', 'running'])

/** How often to re-read the index while something is still going. */
const POLL_MS = 3000

/**
 * ML Studio: where a saved strategy meets a learner.
 *
 * The Strategy Builder answers "what should this trade?" and runs one backtest
 * to check. This page answers "which model should trade it?" — a question about
 * a strategy that already exists, and one that only means anything across
 * several attempts at once. So it holds the sweep, the installed models, and
 * every finished run ranked against the others.
 */
export function MLStudioPage() {
  const [models, setModels] = useState<ModelsResponse | null>(null)
  /** Every run, at every status. The leaderboard filters; the strip does not. */
  const [allRuns, setAllRuns] = useState<Run[]>([])
  const [loadingRuns, setLoadingRuns] = useState(true)
  /** Runs ticked for side-by-side comparison. */
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)

  const refreshRuns = useCallback(async () => {
    try {
      // Higher than the server's silent default of 100: a machine that has
      // been iterated on for a week reaches that, and a leaderboard missing
      // its early entries is not a leaderboard.
      setAllRuns((await api.listRuns(500)).runs)
    } catch {
      /* the index is a convenience; a failure must not empty the page */
    } finally {
      setLoadingRuns(false)
    }
  }, [])

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined)
    void refreshRuns()
  }, [refreshRuns])

  const inFlight = allRuns.filter((r) => IN_FLIGHT.has(r.status))

  /**
   * Poll while anything is unfinished, and stop when nothing is.
   *
   * A sweep queues runs that start `queued`, and the leaderboard shows only
   * succeeded ones — so without this, pressing Train visibly does nothing for
   * several minutes. The dependency is the *count*, not the array, so a poll
   * that changes nothing does not restart the timer.
   */
  useEffect(() => {
    if (!inFlight.length) return
    const timer = setInterval(() => void refreshRuns(), POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight.length, refreshRuns])

  const runs = allRuns.filter((r) => r.status === 'succeeded')

  // The same gated, cached fan-out the backtest ledger uses. This page owned
  // the original copy; sharing it is what keeps a degraded backend from being
  // hit by two independent bursts.
  const { reports, loading: loadingReports } = useRunReports(runs)
  const loading = loadingRuns || (loadingReports && !Object.keys(reports).length)

  const rows: Row[] = runs.map((run) => ({ run, report: reports[run.id] ?? null }))
  const ranked = [...rows].sort(
    (a, b) => rankValue(metricRow(b.run, b.report)) - rankValue(metricRow(a.run, a.report)))

  return (
    <>
      <PageHeader
        title="ML Studio"
        description="Train a saved strategy against several models and feature sets, and rank every finished run."
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <TrainPanel runs={allRuns} onLaunched={refreshRuns} />

          {inFlight.length > 0 && (
            <Panel
              title="In flight"
              hint={`${inFlight.length} not finished yet`}
              data-testid="in-flight"
            >
              <div className="space-y-1">
                {inFlight.map((run) => (
                  <div key={run.id} className="flex items-baseline gap-2 text-[12px]">
                    <RunStatusIcon status={run.status} className="self-center" />
                    <Link to={`/runs/${run.id}`} className="min-w-0 truncate hover:text-primary">
                      {run.name}
                    </Link>
                    {/* The server's own words. It says "Waiting for the running
                        backtest" for a queued run, which is the queue explaining
                        itself better than any sentence written here could. */}
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {run.phase}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-sm">Leaderboard</CardTitle>
              {/* Comparison is also reachable from the builder's ledger, but
                  that panel is canvas-only — and form mode is where most
                  strategies are built. */}
              <Button
                size="sm"
                variant="outline"
                disabled={picked.length < 2}
                onClick={() => setComparing(true)}
                title={picked.length < 2
                  ? 'Tick two or more runs to compare them'
                  : `Compare ${picked.length} runs`}
              >
                <Columns2 className="h-4 w-4" />
                Compare
              </Button>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="animate-subtle-pulse py-8 text-center text-sm text-muted-foreground">
                  Loading runs…
                </p>
              ) : ranked.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No completed runs yet. Build a strategy and run it — every finished backtest
                  lands here.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        <th className="py-2 pr-2 font-normal"><span className="sr-only">Compare</span></th>
                        <th className="py-2 pr-4 font-normal">Run</th>
                        <th className="py-2 pr-4 font-normal">Model</th>
                        <th className="py-2 pr-4 font-normal">Features</th>
                        <th className="py-2 pr-4 text-right font-normal">IC</th>
                        <th className="py-2 pr-4 text-right font-normal">ICIR</th>
                        <th className="py-2 pr-4 text-right font-normal">Ann. excess</th>
                        <th className="py-2 pr-4 text-right font-normal">IR</th>
                        <th className="py-2 text-right font-normal">Max DD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranked.map(({ run, report }) => {
                        const risk = report?.risk['excess_return_with_cost'] ?? {}
                        return (
                          <tr key={run.id} className="border-b border-border/30 last:border-0">
                            <td className="py-2.5 pr-2">
                              <input
                                type="checkbox"
                                aria-label={`Compare ${run.name}`}
                                checked={picked.includes(run.id)}
                                onChange={() => setPicked((prev) => prev.includes(run.id)
                                  ? prev.filter((x) => x !== run.id)
                                  : [...prev, run.id])}
                                className="accent-primary"
                              />
                            </td>
                            <td className="py-2.5 pr-4">
                              <Link to={`/runs/${run.id}`} className="hover:text-primary">
                                {run.name}
                              </Link>
                            </td>
                            <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                              {run.model}
                            </td>
                            <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                              {run.handler}
                            </td>
                            <Num value={report?.metrics['IC']} digits={4} />
                            <Num value={report?.metrics['ICIR']} digits={3} />
                            <Num value={risk['annualized_return']} percent />
                            <Num value={risk['information_ratio']} digits={3} />
                            <Num value={risk['max_drawdown']} percent />
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Available models</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {models?.models.map((m) => (
                <div key={m.id} className="rounded-lg border border-border/50 p-3">
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{m.class}</div>
                </div>
              ))}
              <p className="text-[11px] leading-relaxed text-muted-foreground sm:col-span-2">
                Only models whose dependencies are installed are offered. The PyTorch
                benchmarks (GRU, LSTM, Transformer, TFT…) need the <span className="font-mono">rl</span>{' '}
                extras — install them and they can be added here.
              </p>
            </CardContent>
          </Card>

          {comparing && (
            <RunCompareModal
              open
              onClose={() => setComparing(false)}
              runs={runs.filter((r) => picked.includes(r.id))}
            />
          )}

          <ComingSoon phase="ML Studio">
            Today: sweep a saved strategy across models and feature sets, and rank and compare
            every finished run. Still to come — hyperparameter search rather than a fixed
            configuration per model, early stopping, and keeping the trained model itself so it
            can be applied to new data without retraining.
          </ComingSoon>
        </div>
      </div>
    </>
  )
}

function Num({
  value, digits = 2, percent,
}: { value?: number | null; digits?: number; percent?: boolean }) {
  const text =
    value == null ? '—' : percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(digits)
  return (
    <td
      className={cn(
        'tnum py-2.5 pr-4 text-right font-mono text-xs',
        value == null ? 'text-muted-foreground' : value > 0 ? 'text-primary' : value < 0 ? 'text-clay' : '',
      )}
    >
      {text}
    </td>
  )
}
