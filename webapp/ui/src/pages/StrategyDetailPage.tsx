import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Landmark, Loader2, Play, Pencil, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { StrategyMacroReport } from '@/components/strategies/StrategyMacroReport'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { api, type Portfolio, type Run, type RunReport, type StoredStrategy } from '@/lib/api'
import { formatIsoDate } from '@/lib/macroFormat'
import { metricRow } from '@/lib/runMetrics'
import { useRunReports } from '@/hooks/useRunReports'
import { useStrategyDetail } from '@/hooks/useStrategyDetail'
import { cn } from '@/lib/utils'

/**
 * Dedicated strategy detail page.
 *
 * This is the zoomed-in view reached from /book: full strategy metadata,
 * the latest run report with curves and positions, plus a history of every
 * backtest for this strategy.
 */
export function StrategyDetailPage() {
  const { strategyId } = useParams()
  const navigate = useNavigate()

  const {
    strategy,
    runs,
    portfolios,
    loading: loadingStrategy,
    error: strategyError,
    refresh,
  } = useStrategyDetail(strategyId)

  const { reports, loading: reportsLoading } = useRunReports(runs)

  const latestSucceeded = useMemo(
    () => runs.find((r) => r.status === 'succeeded'),
    [runs],
  )
  const latestReport: RunReport | null = latestSucceeded
    ? (reports[latestSucceeded.id] ?? null)
    : null

  if (loadingStrategy) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-subtle-pulse text-sm text-muted-foreground">Loading strategy…</div>
      </div>
    )
  }

  if (strategyError || !strategy) {
    return (
      <div className="p-6">
        <PageHeader title="Strategy" />
        <Card className="mt-4 border-destructive/40">
          <CardContent className="p-4 text-sm text-destructive">
            {strategyError || 'Strategy not found.'}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        title={strategy.name}
        description="Strategy detail, latest run and history."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loadingStrategy}
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', loadingStrategy && 'animate-spin')} /> Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/lab/builder?strategy=${encodeURIComponent(strategy.id)}`)}
            >
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                await api.startRun(strategy, strategy.id)
                await refresh()
              }}
            >
              <Play className="mr-1 h-3.5 w-3.5" /> Run
            </Button>
          </div>
        }
      />

      <div className="min-w-0 flex-1 overflow-y-auto p-6 pt-0">
        <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/book" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Portfolios & Strategies
          </Link>
          <span>/</span>
          <span className="font-mono">{strategy.id}</span>
        </div>

        <div className="space-y-6">
          <StrategyHeader strategy={strategy} />

          {reportsLoading && (
            <Card className="border-border/50">
              <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading latest run report…
              </CardContent>
            </Card>
          )}

          {latestReport && latestSucceeded && !reportsLoading && (
            <div className="space-y-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-medium">Latest run</h3>
                <Link
                  to={`/runs/${latestSucceeded.id}`}
                  className="font-mono text-[11px] text-primary hover:underline"
                >
                  {latestSucceeded.name} →
                </Link>
              </div>
              <StrategyMacroReport report={latestReport} strategy={strategy} />
            </div>
          )}

          {!latestReport && latestSucceeded && !reportsLoading && (
            <Card className="border-border/50">
              <CardContent className="p-4 text-sm text-muted-foreground">
                The latest run ({latestSucceeded.name}) finished but its report
                could not be loaded. If this is a fresh run, wait a few seconds
                and refresh the page.
              </CardContent>
            </Card>
          )}

          {!latestReport && runs.length > 0 && !latestSucceeded && !reportsLoading && (
            <Card className="border-border/50">
              <CardContent className="p-4 text-sm text-muted-foreground">
                Latest run has not produced a report yet. Click Run to generate one.
              </CardContent>
            </Card>
          )}

          {portfolios.length > 0 && (
            <LinkedPortfolios portfolios={portfolios} />
          )}

          {runs.length > 0 && (
            <RunHistory runs={runs} reports={reports} />
          )}
        </div>
      </div>
    </div>
  )
}

function LinkedPortfolios({ portfolios }: { portfolios: Portfolio[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Feeds portfolios</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {portfolios.map((portfolio) => (
          <div
            key={portfolio.id}
            className="flex items-center justify-between gap-2 border-b border-border/30 py-1.5 last:border-0"
          >
            <Link
              to={`/book/portfolios/${portfolio.id}`}
              className="text-xs hover:text-primary hover:underline"
            >
              {portfolio.name}
            </Link>
            <Link
              to={`/macro?portfolio=${portfolio.id}`}
              className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-primary"
            >
              <Landmark className="h-3 w-3" /> Macro
            </Link>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function StrategyHeader({ strategy }: { strategy: StoredStrategy }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg">{strategy.name}</h2>
            <Badge variant={strategy.origin === 'official' ? 'primary' : 'outline'}>
              {strategy.origin === 'official' ? 'Official' : 'Backtested'}
            </Badge>
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {strategy.model} · {strategy.handler} · {strategy.universe} · {strategy.data_store}
            {' · '}vs {strategy.benchmark}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetaTile label="Train" value={`${formatIsoDate(strategy.train_start)} → ${formatIsoDate(strategy.train_end)}`} />
        <MetaTile label="Validate" value={`${formatIsoDate(strategy.valid_start)} → ${formatIsoDate(strategy.valid_end)}`} />
        <MetaTile label="Test" value={`${formatIsoDate(strategy.test_start)} → ${formatIsoDate(strategy.test_end)}`} />
        <MetaTile label="Shape" value={`top ${strategy.topk} / drop ${strategy.n_drop}`} />
      </div>

      {strategy.description && (
        <p className="max-w-3xl text-sm text-muted-foreground">{strategy.description}</p>
      )}
    </div>
  )
}

function MetaTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className="mt-1 text-xs">{value}</div>
    </div>
  )
}

function RunHistory({ runs, reports }: { runs: Run[]; reports: Record<string, RunReport | null> }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Run history</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-muted-foreground/70">
                <th className="py-2 pr-4 font-mono font-normal uppercase tracking-wider">Status</th>
                <th className="py-2 pr-4 font-normal">Name</th>
                <th className="py-2 pr-4 font-mono font-normal uppercase tracking-wider">Period</th>
                <th className="py-2 pr-4 font-mono font-normal uppercase tracking-wider text-right">IR</th>
                <th className="py-2 pr-4 font-mono font-normal uppercase tracking-wider text-right">Ann. return</th>
                <th className="py-2 pr-4 font-mono font-normal uppercase tracking-wider text-right">Max DD</th>
                <th className="py-2 pr-4 font-mono font-normal uppercase tracking-wider text-right">Trades</th>
                <th className="py-2 pr-4 font-normal"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {runs.map((run) => {
                const report = reports[run.id]
                const row = metricRow(run, report ?? undefined)
                const ts = report?.trade_summary
                return (
                  <tr key={run.id} className="hover:bg-foreground/[0.02]">
                    <td className="py-2 pr-4">
                      <span className="flex items-center gap-1.5">
                        <RunStatusIcon status={run.status} />
                        <span className="font-mono text-[10px]">{run.status}</span>
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <Link to={`/runs/${run.id}`} className="hover:text-primary hover:underline">
                        {run.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 font-mono text-[10px] text-muted-foreground">
                      {row.period ? `${row.period.start} → ${row.period.end}` : '—'}
                    </td>
                    <td className={cn('tnum py-2 pr-4 text-right', tone(row.ir))}>
                      {row.ir == null ? '—' : row.ir.toFixed(3)}
                    </td>
                    <td className={cn('tnum py-2 pr-4 text-right', tone(row.annualised))}>
                      {row.annualised == null ? '—' : `${(row.annualised * 100).toFixed(1)}%`}
                    </td>
                    <td className={cn('tnum py-2 pr-4 text-right', row.maxDrawdown == null ? '' : 'text-clay')}>
                      {row.maxDrawdown == null ? '—' : `${(row.maxDrawdown * 100).toFixed(1)}%`}
                    </td>
                    <td className="tnum py-2 pr-4 text-right text-muted-foreground">
                      {ts?.estimated_trades ?? estimateTrades(report?.daily?.turnover) ?? '—'}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={async () => {
                          await api.deleteRun(run.id)
                          // Refresh handled by parent re-mount; simple reload here.
                          window.location.reload()
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function tone(value: number | null): string {
  if (value == null) return ''
  return value > 0 ? 'text-primary' : value < 0 ? 'text-clay' : ''
}

function estimateTrades(turnover?: { value: number | null }[]): number | null {
  if (!turnover?.length) return null
  const values = turnover.map((p) => p.value).filter((v): v is number => v != null)
  if (!values.length) return null
  return values.reduce((a, b) => a + Math.max(1, Math.round(b * 2)), 0)
}
