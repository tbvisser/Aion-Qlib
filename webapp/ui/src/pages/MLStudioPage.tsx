import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart3, Boxes, Inbox, Info, Target, Timer,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ComingSoon } from '@/components/ComingSoon'
import { Panel } from '@/components/ui/panel'
import { Button } from '@/components/ui/button'
import { RunCompareModal } from '@/components/runs/RunCompareModal'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { TrainPanel } from '@/components/mlstudio/TrainPanel'
import { LeaderboardPanel } from '@/components/mlstudio/LeaderboardPanel'
import { TopRunsCurveChart } from '@/components/mlstudio/TopRunsCurveChart'
import { TopRunsMetricsChart } from '@/components/mlstudio/TopRunsMetricsChart'
import { TopRunsRadarChart } from '@/components/mlstudio/TopRunsRadarChart'
import { ModelHandlerHeatmap } from '@/components/mlstudio/ModelHandlerHeatmap'
import { useRunReports } from '@/hooks/useRunReports'
import { api, type ModelsResponse, type Run, type RunReport } from '@/lib/api'
import {
  formatRunPercent, metricRow, metricTone, rankValue,
} from '@/lib/runMetrics'
import { cn } from '@/lib/utils'

interface Row {
  run: Run
  report: RunReport | null
}

/** Statuses a run can still move out of. */
const IN_FLIGHT = new Set(['queued', 'running'])

/** How often to re-read the index while something is still going. */
const POLL_MS = 3000

const MICRO = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70'

/**
 * ML Studio: a single-tab dashboard for comparing learners.
 *
 * The Strategy Builder answers "what should this trade?". This page answers
 * "which learner should trade it?" — so it leads with the top performers,
 * visualises them across several chart types, and keeps the sweep controls
 * close at hand.
 */
export function MLStudioPage() {
  const [models, setModels] = useState<ModelsResponse | null>(null)
  /** Every run, at every status. The leaderboard filters; the strip does not. */
  const [allRuns, setAllRuns] = useState<Run[]>([])
  /** Runs ticked for side-by-side comparison. */
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)

  const refreshRuns = useCallback(async () => {
    try {
      setAllRuns((await api.listRuns(500)).runs)
    } catch {
      /* the index is a convenience; a failure must not empty the page */
    }
  }, [])

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined)
    void refreshRuns()
  }, [refreshRuns])

  const inFlight = allRuns.filter((r) => IN_FLIGHT.has(r.status))

  /**
   * Poll while anything is unfinished, and stop when nothing is.
   */
  useEffect(() => {
    if (!inFlight.length) return
    const timer = setInterval(() => void refreshRuns(), POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight.length, refreshRuns])

  const runs = allRuns.filter((r) => r.status === 'succeeded')

  const { reports } = useRunReports(runs)

  const rows: Row[] = runs.map((run) => ({ run, report: reports[run.id] ?? null }))
  const ranked = [...rows].sort(
    (a, b) => rankValue(metricRow(b.run, b.report)) - rankValue(metricRow(a.run, a.report)))

  const topFive = useMemo(() => ranked.slice(0, 5), [ranked])
  const top = useMemo(() => (ranked.length ? { run: ranked[0].run, report: ranked[0].report, row: metricRow(ranked[0].run, ranked[0].report) } : null), [ranked])
  const bestIc = useMemo(() => {
    const ics = ranked.map(({ report }) => report?.metrics['IC']).filter((v): v is number => v != null && Number.isFinite(v))
    return ics.length ? Math.max(...ics) : null
  }, [ranked])

  const togglePick = (runId: string) => {
    setPicked((prev) => prev.includes(runId) ? prev.filter((x) => x !== runId) : [...prev, runId])
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PageHeader
        title="ML Studio"
        description="Compare learners, rank every finished run, and launch sweeps from one dashboard."
      />

      <div className="grid grid-cols-12 gap-4 p-6">
        {/* ── KPI tiles ──────────────────────────────────────────────────── */}
        <StatTile
          className="col-span-6 lg:col-span-3"
          icon={<BarChart3 className="h-4 w-4" />}
          label="Finished runs"
          value={runs.length}
        />
        <StatTile
          className="col-span-6 lg:col-span-3"
          icon={<Timer className="h-4 w-4" />}
          label="In flight"
          value={inFlight.length}
          statusDot={inFlight.length > 0 ? 'active' : undefined}
        />
        <StatTile
          className="col-span-6 lg:col-span-3"
          icon={<Boxes className="h-4 w-4" />}
          label="Models available"
          value={models?.models.length ?? 0}
        />
        <StatTile
          className="col-span-6 lg:col-span-3"
          icon={<Target className="h-4 w-4" />}
          label="Best IC"
          value={bestIc == null ? '—' : bestIc.toFixed(4)}
        />

        {/* ── Top performer ──────────────────────────────────────────────── */}
        <div className="col-span-12 lg:col-span-8">
          <Panel
            title="Top performer"
            hint={top ? `ranked by information ratio · ${top.row.period ? `${top.row.period.start} → ${top.row.period.end}` : 'no period'}` : 'no finished runs'}
            className="relative h-full min-h-[360px] overflow-hidden"
            bodyClassName="relative"
          >
            <div className="bg-grid-fine absolute inset-0 opacity-20" />

            {top ? (
              <div className="relative flex h-full flex-col justify-between gap-4">
                <div className="border-l-2 border-primary/40 pl-3">
                  <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                    {top.row.label}
                  </h2>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    IR {formatRunPercent(top.row.ir ?? 0, 3, false)}
                    {top.row.annualised != null && ` · ann. excess ${formatRunPercent(top.row.annualised)}`}
                    {top.report?.period && ` · ${top.report.period.days} days`}
                  </p>
                </div>

                {/* Spec strip — what this learner actually traded. */}
                <SpecStrip run={top.run} />

                {/* Primary metrics. */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <HeroMetric label="Ann. excess" value={top.row.annualised} percent metric="annualised" />
                  <HeroMetric label="Max drawdown" value={top.row.maxDrawdown} percent metric="maxDrawdown" />
                  <HeroMetric label="Volatility" value={top.row.volatility} percent metric="volatility" />
                  <HeroMetric label="IR" value={top.row.ir} digits={3} metric="annualised" />
                </div>

                {/* Secondary signal metrics. */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <HeroMetric label="IC" value={top.report?.metrics['IC'] ?? null} digits={4} metric="annualised" />
                  <HeroMetric label="Rank IC" value={top.report?.metrics['Rank IC'] ?? null} digits={4} metric="annualised" />
                  <HeroMetric label="ICIR" value={top.report?.metrics['ICIR'] ?? null} digits={4} metric="annualised" />
                  <HeroMetric label="Period" text={top.report?.period ? `${top.report.period.days}d` : '—'} />
                </div>
              </div>
            ) : (
              <div className="relative flex h-full flex-col items-center justify-center gap-2 text-center">
                <Inbox className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm font-medium text-muted-foreground">No finished runs yet</p>
                <p className="max-w-[280px] text-[11px] leading-relaxed text-muted-foreground/60">
                  Train a saved strategy against one or more learners and the best result will headline this tile.
                </p>
              </div>
            )}
          </Panel>
        </div>

        {/* ── Leaderboard ────────────────────────────────────────────────── */}
        <div className="col-span-12 lg:col-span-4">
          <LeaderboardPanel
            rows={rows}
            limit={8}
            picked={picked}
            onTogglePick={togglePick}
          />
        </div>

        {/* ── Sweep controls ─────────────────────────────────────────────── */}
        <div className="col-span-12">
          <TrainPanel runs={allRuns} onLaunched={refreshRuns} />
        </div>

        {/* ── Chart grid ─────────────────────────────────────────────────── */}
        <div className="col-span-12 lg:col-span-8">
          <Panel title="Top 5 equity curves" hint="excess return, net of cost" className="h-full">
            <TopRunsCurveChart runs={topFive.map((r) => r.run)} reports={reports} height={300} />
          </Panel>
        </div>

        <div className="col-span-12 lg:col-span-4">
          <Panel title="Top 5 metrics" hint="IR, return, drawdown" className="h-full">
            <TopRunsMetricsChart runs={topFive.map((r) => r.run)} reports={reports} height={300} />
          </Panel>
        </div>

        <div className="col-span-12 lg:col-span-8">
          <Panel title="Model × feature heatmap" hint="best IR per learner × handler" className="h-full">
            <ModelHandlerHeatmap runs={runs} reports={reports} />
          </Panel>
        </div>

        <div className="col-span-12 lg:col-span-4">
          <Panel title="Radar comparison" hint="top 5 runs, normalized" className="h-full">
            <TopRunsRadarChart runs={topFive.map((r) => r.run)} reports={reports} height={300} />
          </Panel>
        </div>

        {/* ── Compare runs (square tile) ─────────────────────────────────── */}
        <div className="col-span-12 md:col-span-6">
          <Panel
            title="Compare runs"
            hint={`${picked.length} selected`}
            className="h-full min-h-[220px]"
            actions={(
              <Button
                size="sm"
                variant="outline"
                disabled={picked.length < 2}
                onClick={() => setComparing(true)}
              >
                Compare {picked.length > 0 ? picked.length : ''}
              </Button>
            )}
          >
            {ranked.length <= 1 ? (
              <p className="text-xs text-muted-foreground">
                Finish at least two runs to compare them side-by-side.
              </p>
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex flex-wrap gap-1.5">
                  {ranked.slice(0, 10).map(({ run }) => {
                    const on = picked.includes(run.id)
                    return (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => togglePick(run.id)}
                        className={cn(
                          'rounded-md border px-2 py-1 text-[11px] transition-colors',
                          on
                            ? 'border-primary/50 bg-primary/10 text-foreground'
                            : 'border-border/50 text-muted-foreground hover:border-primary/30 hover:text-foreground',
                        )}
                      >
                        {run.name}
                      </button>
                    )
                  })}
                </div>
                {picked.length > 0 && (
                  <div className="mt-auto pt-3">
                    <div className="text-[10px] text-muted-foreground/70">
                      {picked.length} run{picked.length === 1 ? '' : 's'} selected for comparison
                    </div>
                  </div>
                )}
              </div>
            )}
          </Panel>
        </div>

        {/* ── In-flight (square tile) ────────────────────────────────────── */}
        <div className="col-span-12 md:col-span-6">
          <Panel
            title="In flight"
            hint={inFlight.length > 0 ? `${inFlight.length} not finished` : 'nothing running'}
            className="h-full min-h-[220px]"
          >
            {inFlight.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                <Info className="h-5 w-5 text-muted-foreground/40" />
                <p>No runs are queued or running.</p>
                <p className="max-w-[220px] text-[10px] leading-relaxed text-muted-foreground/60">
                  Start a sweep and active runs will appear here with live status.
                </p>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {inFlight.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center gap-2 rounded-lg border border-border/50 bg-foreground/[0.02] px-3 py-2"
                  >
                    <RunStatusIcon status={run.status} />
                    <div className="min-w-0 flex-1">
                      <Link to={`/runs/${run.id}`} className="block truncate text-[11px] hover:text-primary">
                        {run.name}
                      </Link>
                      <span className="font-mono text-[9px] text-muted-foreground/70">
                        {run.status} · {run.phase}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* ── Available models ───────────────────────────────────────────── */}
        <div className="col-span-12">
          <Panel title="Available models" hint="installed learners">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {models?.models.map((m) => (
                <div
                  key={m.id}
                  className="rounded-lg border border-border/50 bg-foreground/[0.02] p-3 transition-colors hover:border-primary/30"
                >
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{m.class}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Only models whose dependencies are installed are offered. The PyTorch
              benchmarks (GRU, LSTM, Transformer, TFT…) need the <span className="font-mono">rl</span>{' '}
              extras — install them and they can be added here.
            </p>
          </Panel>
        </div>

        <div className="col-span-12">
          <ComingSoon phase="ML Studio">
            Today: sweep a saved strategy across models and feature sets, rank every finished run,
            and compare the top learners visually. Still to come — hyperparameter search, early
            stopping, and persisting trained models for inference on new data.
          </ComingSoon>
        </div>
      </div>

      {comparing && (
        <RunCompareModal
          open
          onClose={() => setComparing(false)}
          runs={runs.filter((r) => picked.includes(r.id))}
        />
      )}
    </div>
  )
}

function SpecStrip({ run }: { run: Run }) {
  const items = [
    { label: 'Model', value: run.model ?? '—' },
    { label: 'Features', value: run.handler ?? '—' },
    { label: 'Universe', value: run.universe ?? '—' },
    { label: 'Benchmark', value: run.benchmark ?? '—' },
    { label: 'Store', value: run.data_store ?? '—' },
    run.topk != null && { label: 'TopK', value: String(run.topk) },
    run.n_drop != null && { label: 'Drop', value: String(run.n_drop) },
    (run.open_cost != null || run.close_cost != null) && {
      label: 'Costs',
      value: `${((run.open_cost ?? 0) * 10000).toFixed(0)}/${((run.close_cost ?? 0) * 10000).toFixed(0)} bp`,
    },
  ].filter(Boolean) as { label: string; value: string }[]

  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map(({ label, value }) => (
        <div
          key={label}
          className="flex items-center gap-1.5 rounded-md border border-border/50 bg-foreground/[0.02] px-2 py-1"
          title={`${label}: ${value}`}
        >
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">{label}</span>
          <span className="tnum max-w-[120px] truncate text-[11px] font-medium text-foreground">{value}</span>
        </div>
      ))}
    </div>
  )
}

function StatTile({ icon, label, value, statusDot, className }: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  statusDot?: 'active'
  className?: string
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-xl border border-border/50 bg-card p-4 shadow-sm transition-shadow hover:shadow-card',
      className,
    )}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-foreground/[0.02] text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className={MICRO}>{label}</div>
          {statusDot === 'active' && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          )}
        </div>
        <div className="tnum text-xl font-semibold">{value}</div>
      </div>
    </div>
  )
}

function HeroMetric({ label, value, text, percent, digits, metric }: {
  label: string
  value?: number | null
  text?: string
  percent?: boolean
  digits?: number
  metric?: 'annualised' | 'maxDrawdown' | 'volatility'
}) {
  const display = text ?? (
    value == null ? '—'
      : percent ? formatRunPercent(value, digits ?? 1)
        : value.toFixed(digits ?? 3)
  )
  const tone = metric && value != null ? metricTone(metric, value) : null
  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
      <div className={MICRO}>{label}</div>
      <div className={cn(
        'tnum mt-1 text-xl font-semibold',
        tone === 'positive' ? 'text-primary'
          : tone === 'negative' ? 'text-clay'
            : 'text-foreground',
      )}>
        {display}
      </div>
    </div>
  )
}
