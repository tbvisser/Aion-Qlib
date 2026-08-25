import { MicroLabel } from '@/components/ui/micro-label'
import type { MacroRegimeReport } from '@/lib/api'
import { formatPercent } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

/**
 * Performance across rates x volatility quadrants.
 *
 * Not a chart: four cells of numbers read better as a grid, and a chart would
 * only obscure them.
 *
 * The days-share bar under each cell is load-bearing honesty. A 2x2 grid
 * invites reading the four annualised returns as comparable, and a regime
 * observed for 40 days is not comparable to one observed for 900 — so the
 * sample size is always on screen next to the number.
 *
 * There is deliberately no max drawdown per cell: a drawdown across a
 * non-contiguous set of days is not a drawdown, and a plausible-looking number
 * would be read as one.
 */
export function RegimeGrid({ report }: { report: MacroRegimeReport }) {
  const total = report.buckets.reduce((sum, b) => sum + b.days, 0)

  return (
    <>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {report.buckets.map((bucket) => {
          const value = bucket.ann_return
          const tint =
            value == null
              ? undefined
              : `hsl(var(${value >= 0 ? '--primary' : '--clay'}) / ${Math.min(
                  0.2, 0.04 + Math.min(Math.abs(value), 1) * 0.16,
                ).toFixed(3)})`
          return (
            <div
              key={bucket.regime}
              data-testid={`regime-${bucket.regime}`}
              style={tint ? { backgroundColor: tint } : undefined}
              className="rounded-lg border border-border/50 p-3"
            >
              <MicroLabel as="div">
                {bucket.label}
              </MicroLabel>

              {value == null ? (
                <>
                  <div className="tnum mt-1 font-mono text-2xl text-muted-foreground">—</div>
                  <div className="mt-0.5 text-micro text-muted-foreground">
                    {bucket.reason}
                  </div>
                </>
              ) : (
                <>
                  <div className={cn('tnum mt-1 font-mono text-2xl',
                    value >= 0 ? 'text-primary' : 'text-clay')}>
                    {formatPercent(value, 1)}
                  </div>
                  <div className="mt-0.5 flex gap-3 font-mono text-micro text-muted-foreground">
                    <span>sharpe {bucket.sharpe?.toFixed(2) ?? '—'}</span>
                    <span>hit {bucket.hit_rate == null ? '—' : `${(bucket.hit_rate * 100).toFixed(0)}%`}</span>
                  </div>
                </>
              )}

              <div className="mt-2 h-0.5 w-full rounded-full bg-foreground/10">
                <div
                  className="h-0.5 rounded-full bg-foreground/25"
                  style={{ width: `${(bucket.share * 100).toFixed(1)}%` }}
                />
              </div>
              <div className="tnum mt-1 font-mono text-micro text-muted-foreground/70">
                {bucket.days}d · {(bucket.share * 100).toFixed(0)}% of the window
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-2 space-y-0.5 font-mono text-micro text-muted-foreground/70">
        <div>
          Rates: {report.rates_key} against itself {report.momentum} sessions ago.
          Vol: rolling z-score of log {report.vol_key} over {report.lookback} sessions.
        </div>
        <div>
          Annualised from each regime's own days ({total} classified) — not a
          contiguous period, so no drawdown is reported.
        </div>
        {report.unclassified > 0 && (
          <div className="text-clay">{report.unclassified} day(s) could not be classified.</div>
        )}
      </div>
    </>
  )
}
