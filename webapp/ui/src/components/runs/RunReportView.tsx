import { useEffect, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts'

import { api, type RunReport } from '@/lib/api'
import { CURVE_STYLE, mergeCurves } from '@/lib/curves'
import { monthlyReturns } from '@/lib/monthlyReturns'
import { formatRunPercent, sanityOf } from '@/lib/runMetrics'
import { cn } from '@/lib/utils'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const AXIS_TICK = {
  fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))',
}

/**
 * A finished run's numbers, read top to bottom.
 *
 * The sections are numbered because they answer questions in an order: did it
 * make money, what did the ride look like, when did it hurt, what was it
 * holding. Eight tiles and one chart made you assemble that yourself.
 *
 * There used to be a `compact` variant, for the builder's run dock. The dock is
 * gone — its ledger and log merged into `BacktestsPanel`, where a finished run
 * links to `RunReportModal` rather than trying to be a small copy of it — so
 * the folded-away variant went with it.
 */
export function RunReportView({ report, hidePerformance }: { report: RunReport; hidePerformance?: boolean }) {
  const excess = report.risk['excess_return_with_cost'] ?? {}
  // Only the three styled curves: `report.curves` also carries `net_of_cost`
  // and `drawdown`, which this chart does not draw and the legend does not name.
  const merged = mergeCurves(Object.fromEntries(
    Object.keys(CURVE_STYLE).map((key) => [key, report.curves[key as keyof RunReport['curves']]]),
  ))
  const drawdown = report.curves.drawdown ?? []
  const months = monthlyReturns(report.curves.excess ?? report.curves.strategy ?? [])

  const sanity = sanityOf(report)

  return (
    <div className="space-y-10">
      {/* Ahead of the numbers, not after them. Everything below this is
          arithmetic on a broken input, and a reader who scrolls the charts first
          has already drawn a conclusion. Clay rather than destructive: the run
          finished, so this is a verdict about the spec, not an error. */}
      {sanity.implausible && (
        <div className="space-y-2 rounded-lg border border-clay/40 bg-clay/5 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-clay">
            Implausible result
          </div>
          <div className="text-[13px] text-muted-foreground">
            The run finished cleanly, but these numbers cannot be read as a
            result. Everything below is arithmetic on the same input.
          </div>
          <ul className="space-y-1">
            {sanity.reasons.map((reason) => (
              <li key={reason} className="text-[13px] leading-snug text-muted-foreground">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hidePerformance && (
        <Section n="01" title="Performance" caption="engine-computed, net of cost">
          <div className="grid grid-cols-2 border-l border-t border-border/50 lg:grid-cols-4">
            <Metric label="Ann. excess return" value={excess['annualized_return']} percent />
            <Metric label="Information ratio" value={excess['information_ratio']} digits={3} />
            <Metric label="Max drawdown" value={excess['max_drawdown']} percent negative />
            <Metric label="Volatility" value={excess['std']} digits={4} />
            <Metric label="IC" value={report.metrics['IC']} digits={4} />
            <Metric label="Rank IC" value={report.metrics['Rank IC']} digits={4} />
            <Metric label="ICIR" value={report.metrics['ICIR']} digits={4} />
            <Metric
              label="Period"
              text={report.period ? `${report.period.start} → ${report.period.end}` : '—'}
              sub={report.period ? `${report.period.days} days` : undefined}
            />
          </div>
        </Section>
      )}

      {merged.length > 0 && (
        <Section
          n="02"
          title="Equity & drawdown"
          caption="cumulative, compounded from daily returns"
        >
          <Panel label="Equity">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={merged} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48}
                       tick={AXIS_TICK} />
                <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK}
                       tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                <Tooltip {...TOOLTIP} formatter={(v: number, name: string) =>
                  [`${(v * 100).toFixed(2)}%`, name]} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
                {Object.entries(CURVE_STYLE).map(([key, style]) =>
                  report.curves[key as keyof typeof report.curves]?.length ? (
                    <Line key={key} type="monotone" dataKey={key} name={style.label}
                          stroke={style.color} dot={false} strokeWidth={1.6} />
                  ) : null,
                )}
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          {drawdown.length > 0 && (
            <Panel label="Drawdown">
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={drawdown} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48}
                         tick={AXIS_TICK} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK}
                         tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                  <Tooltip {...TOOLTIP}
                           formatter={(v: number) => [`${(v * 100).toFixed(2)}%`, 'Drawdown']} />
                  <Area type="monotone" dataKey="value" stroke="hsl(var(--clay))"
                        fill="hsl(var(--clay) / 0.15)" strokeWidth={1.6} />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
          )}
        </Section>
      )}

      {months.length > 0 && (
        <Section n="03" title="Monthly returns" caption="excess of benchmark, net of cost">
          <MonthlyTable rows={months} />
        </Section>
      )}

      <Section
        n="04"
        title="Positions"
        caption="what the model ranked highest on the last scored date"
      >
        <Positions runId={report.run.id} />
      </Section>
    </div>
  )
}

const TOOLTIP = {
  contentStyle: {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 11,
    fontFamily: 'IBM Plex Mono',
  },
} as const

function Section({ n, title, caption, children }: {
  n: string
  title: string
  caption?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2.5">
        <span className="font-mono text-[11px] text-muted-foreground/50">{n}</span>
        <h3 className="text-base font-medium">{title}</h3>
        {caption && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{caption}</span>
        )}
      </div>
      {children}
    </section>
  )
}

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 rounded-lg border border-border/50 p-3">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      {children}
    </div>
  )
}

/**
 * One figure.
 *
 * Tone follows sign, except where a metric is negative by construction: a max
 * drawdown of -28% is the number, not a verdict, so `negative` marks it clay
 * without pretending a smaller loss is a win.
 */
function Metric({
  label, value, text, sub, digits = 2, percent, negative,
}: {
  label: string
  value?: number | null
  text?: string
  sub?: string
  digits?: number
  percent?: boolean
  negative?: boolean
}) {
  const display = text ?? (
    value == null ? '—'
      // Clamped past +/-1000%: the extra digits of a broken run are not precision.
      : percent ? formatRunPercent(value, 2, false)
        : value.toFixed(digits)
  )
  const tone =
    value == null || text ? ''
      : negative ? 'text-clay'
        : value > 0 ? 'text-primary'
          : value < 0 ? 'text-clay' : ''

  return (
    <div className="min-w-0 border-b border-r border-border/50 p-4">
      <div className="truncate font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground/70">
        {label}
      </div>
      <div className={cn('tnum mt-1.5 truncate font-mono text-xl', tone)}>{display}</div>
      {sub && <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function MonthlyTable({ rows }: { rows: ReturnType<typeof monthlyReturns> }) {
  // Shading is relative to the best and worst month in view, so a quiet
  // strategy is not rendered as a uniform grey sheet.
  const peak = Math.max(
    ...rows.flatMap((r) => r.months.map((m) => Math.abs(m.value))), 0.0001)

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse font-mono text-xs">
        <thead>
          <tr className="text-muted-foreground/70">
            <th className="px-2 py-1.5 text-left font-normal uppercase tracking-wider">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-2 py-1.5 text-right font-normal">{m}</th>
            ))}
            <th className="px-2 py-1.5 text-right font-normal uppercase tracking-wider">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const byMonth = new Map(row.months.map((m) => [m.month, m.value]))
            return (
              <tr key={row.year}>
                <td className="px-2 py-1.5 text-muted-foreground">{row.year}</td>
                {MONTHS.map((label, i) => {
                  const v = byMonth.get(i)
                  return (
                    <td
                      key={label}
                      className="tnum px-2 py-1.5 text-right"
                      style={v == null ? undefined : {
                        background: `hsl(var(--${v >= 0 ? 'primary' : 'clay'}) / ${
                          (0.08 + 0.32 * Math.min(1, Math.abs(v) / peak)).toFixed(3)})`,
                      }}
                    >
                      {v == null ? '' : (v * 100).toFixed(1)}
                    </td>
                  )
                })}
                <td className={cn('tnum px-2 py-1.5 text-right font-medium',
                                  row.total >= 0 ? 'text-primary' : 'text-clay')}>
                  {(row.total * 100).toFixed(1)}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The names the model ranked highest, last time it scored.
 *
 * This is not a trade blotter — qlib's backtest is cross-sectional and never
 * emits per-trade fills, so there is nothing to list one from. It is the
 * nearest honest thing: what the model would have you hold.
 */
function Positions({ runId }: { runId: string }) {
  const [data, setData] = useState<
    { date: string; top: { instrument: string; score: number | null }[] } | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    api.runPredictions(runId)
      .then((r) => live && setData(r))
      .catch(() => live && setError(true))
    return () => { live = false }
  }, [runId])

  if (error) return <p className="text-[11px] text-muted-foreground">No predictions recorded.</p>
  if (!data) return <p className="text-[11px] text-muted-foreground">Loading positions…</p>
  if (!data.top.length) {
    return <p className="text-[11px] text-muted-foreground">Nothing scored on {data.date}.</p>
  }

  return (
    <div className="rounded-lg border border-border/50">
      <div className="border-b border-border/50 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {data.date} · top {data.top.length}
      </div>
      {/* Fifty near-identical scores would otherwise be the longest thing in
          the report; it scrolls in place rather than pushing everything else
          off the end of a modal. */}
      <div className="max-h-80 divide-y divide-border/50 overflow-y-auto">
        {data.top.map((row, i) => (
          <div key={row.instrument} className="flex items-baseline gap-3 px-3 py-1.5 font-mono text-xs">
            <span className="tnum w-6 shrink-0 text-muted-foreground/70">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{row.instrument}</span>
            <span className="tnum shrink-0 text-muted-foreground">
              {row.score == null ? '—' : row.score.toFixed(4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

