import { useEffect, useMemo, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, ComposedChart, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MicroLabel } from '@/components/ui/micro-label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MetricTile } from '@/components/MetricTile'
import { PositionsTimeline } from '@/components/strategies/PositionsTimeline'
import { api, type MacroLinkage, type RunReport, type StoredStrategy } from '@/lib/api'
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

const TOOLTIP = {
  contentStyle: {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 11,
    fontFamily: 'IBM Plex Mono',
  },
} as const

/**
 * A dense, macro-desk view of one strategy run.
 *
 * Intended for the dedicated strategy detail page: every number the engine
 * emitted, plus derived rolling metrics and a turnover ladder, so a reader can
 * fully zoom in without leaving the page.
 */
export function StrategyMacroReport({
  report,
  strategy,
}: {
  report: RunReport
  strategy: StoredStrategy
}) {
  const [showAllTrades, setShowAllTrades] = useState(false)
  const excess = report.risk['excess_return_with_cost'] ?? {}
  const curves = mergeCurves(Object.fromEntries(
    Object.keys(CURVE_STYLE).map((key) => [key, report.curves[key as keyof RunReport['curves']]]),
  ))
  const drawdown = report.curves.drawdown ?? []
  const months = monthlyReturns(report.curves.excess ?? report.curves.strategy ?? [])
  const sanity = sanityOf(report)
  const derived = report.derived
  const ts = report.trade_summary

  const daily = report.daily ?? {}
  const rolling = useRollingMetrics(daily)
  const trades = useTradeActivity(daily, ts?.estimated_trades)
  const annualTurnover = ts?.annual_turnover ?? (trades.avgTurnover == null ? null : trades.avgTurnover * 252)

  return (
    <div className="space-y-8">
      {sanity.implausible && (
        <div className="space-y-2 rounded-lg border border-clay/40 bg-clay/5 px-4 py-3">
          <div className="font-mono text-micro uppercase tracking-wider text-clay">
            Implausible result
          </div>
          <div className="text-body-sm text-muted-foreground">
            The run finished cleanly, but these numbers cannot be read as a result.
          </div>
          <ul className="space-y-1">
            {sanity.reasons.map((reason) => (
              <li key={reason} className="text-body-sm leading-snug text-muted-foreground">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <HeroBanner report={report} strategy={strategy} />

      <section>
        <SectionTitle n="01" title="Performance summary" caption="net of cost vs benchmark" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <MetricTile label="Ann. excess return" value={excess['annualized_return']} percent />
          <MetricTile label="Information ratio" value={excess['information_ratio']} digits={3} />
          <MetricTile label="Max drawdown" value={excess['max_drawdown']} percent negative />
          <MetricTile label="Volatility" value={excess['std']} percent negative />
          <MetricTile label="Sharpe" value={sharpe(excess)} digits={2} />
          <MetricTile label="Sortino" value={derived?.sortino} digits={2} />
          <MetricTile label="Calmar" value={calmar(excess)} digits={2} />
          <MetricTile label="Win rate" value={derived?.win_rate} percent />
          <MetricTile label="Profit factor" value={derived?.profit_factor} digits={2} />
          <MetricTile label="Skew" value={derived?.skew} digits={3} />
          <MetricTile label="Excess kurt" value={derived?.excess_kurt} digits={3} />
          <MetricTile label="Downside vol" value={derived?.downside_vol} percent negative />
        </div>
      </section>

      <section>
        <SectionTitle n="02" title="Signal quality" caption="prediction-target relationship" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <MetricTile label="IC" value={report.metrics['IC']} digits={4} />
          <MetricTile label="Rank IC" value={report.metrics['Rank IC']} digits={4} />
          <MetricTile label="ICIR" value={report.metrics['ICIR']} digits={4} />
          <MetricTile label="Ann. turnover" value={annualTurnover} digits={2} suffix="×" />
          <MetricTile label="Est. trades" value={trades.estimatedTrades} digits={0} />
          <MetricTile label="Trading days" value={ts?.trading_days ?? report.period?.days} digits={0} />
        </div>
      </section>

      {curves.length > 0 && (
        <section>
          <SectionTitle n="03" title="Equity & drawdown" caption="cumulative, compounded daily" />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Panel label="Strategy vs benchmark vs excess">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={curves} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tick={AXIS_TICK} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK}
                         tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                  <Tooltip {...TOOLTIP} formatter={(v: number, name: string) => [`${(v * 100).toFixed(2)}%`, name]} />
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
            <Panel label="Drawdown">
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={drawdown} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tick={AXIS_TICK} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK}
                         tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                  <Tooltip {...TOOLTIP} formatter={(v: number) => [`${(v * 100).toFixed(2)}%`, 'Drawdown']} />
                  <Area type="monotone" dataKey="value" stroke="hsl(var(--clay))"
                        fill="hsl(var(--clay) / 0.15)" strokeWidth={1.6} />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        </section>
      )}

      {rolling.length > 0 && (
        <section>
          <SectionTitle n="04" title="Rolling metrics" caption="63-day window, annualised" />
          <Panel label="Rolling IR & volatility">
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={rolling} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tick={AXIS_TICK} />
                <YAxis yAxisId="left" tickLine={false} axisLine={false} tick={AXIS_TICK} />
                <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} tick={AXIS_TICK}
                       tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                <Tooltip {...TOOLTIP} formatter={(v: number, name: string) =>
                  [name === 'Volatility' ? `${(v * 100).toFixed(1)}%` : v.toFixed(2), name]} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
                <Line yAxisId="left" type="monotone" dataKey="ir" name="Rolling IR" stroke="hsl(var(--primary))" dot={false} strokeWidth={1.6} />
                <Area yAxisId="right" type="monotone" dataKey="vol" name="Volatility" stroke="hsl(var(--clay))" fill="hsl(var(--clay) / 0.12)" strokeWidth={1.6} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>
        </section>
      )}

      {trades.turnoverDays.length > 0 && (
        <section>
          <SectionTitle n="05" title="Trade activity" caption="daily turnover is the honest proxy qlib provides" />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm">Turnover ladder</CardTitle>
                {trades.turnoverDays.length > 50 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-label"
                    onClick={() => setShowAllTrades((v) => !v)}
                  >
                    {showAllTrades ? 'Show top 50' : `Show all ${trades.turnoverDays.length}`}
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <Table className="text-xs">
                  <TableHead>
                    <tr>
                      <TableHeader>Date</TableHeader>
                      <TableHeader numeric>Turnover</TableHeader>
                      <TableHeader numeric>Est. round-trips</TableHeader>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {trades.turnoverDays.slice(0, showAllTrades ? undefined : 50).map((row) => (
                      <TableRow key={row.date} className="hover:bg-foreground/[0.02]">
                        <TableCell className="py-1.5 pr-4 font-mono text-micro">{row.date}</TableCell>
                        <TableCell numeric className="py-1.5 pr-4">{(row.turnover * 100).toFixed(2)}%</TableCell>
                        <TableCell numeric className="py-1.5 pr-4 text-muted-foreground">{row.roundTrips}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <div className="space-y-3">
              <MetricTile label="Active days" value={trades.activeDays} digits={0} />
              <MetricTile label="Avg daily turnover" value={trades.avgTurnover} percent />
              <MetricTile label="Max daily turnover" value={trades.maxTurnover} percent />
              <MetricTile label="Est. total trades" value={trades.estimatedTrades} digits={0} />
            </div>
          </div>
        </section>
      )}

      {months.length > 0 && (
        <section>
          <SectionTitle n="06" title="Monthly returns" caption="excess of benchmark, net of cost" />
          <MonthlyTable rows={months} />
        </section>
      )}

      <section>
        <SectionTitle n="07" title="Indicators" caption="execution and fill-rate diagnostics" />
        <IndicatorTable report={report} annualTurnover={annualTurnover} estimatedTrades={trades.estimatedTrades} />
      </section>

      <section>
        <SectionTitle n="08" title="Position history" caption="open/closed positions during the backtest" />
        <PositionsTimeline runId={report.run.id} />
      </section>

      <section>
        <SectionTitle n="09" title="Latest signals" caption="what the model ranked highest today" />
        <Positions runId={report.run.id} />
      </section>

      <section>
        <SectionTitle n="10" title="Strategy specification" caption="the logic behind the run" />
        <SpecTable strategy={strategy} />
      </section>

      <section>
        <SectionTitle n="11" title="Macro attribution" caption="sensitivities to the macro desk basket" />
        <MacroAttribution runId={report.run.id} />
      </section>
    </div>
  )
}

function MacroAttribution({ runId }: { runId: string }) {
  const [data, setData] = useState<MacroLinkage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(false)
    api.macroLinkage('run', runId, { cov: 'hac' })
      .then((r) => { if (live) setData(r) })
      .catch(() => { if (live) setError(true) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [runId])

  if (loading) return <p className="text-label text-muted-foreground">Loading macro attribution…</p>
  if (error || !data) return <p className="text-label text-muted-foreground">No macro attribution available for this run.</p>

  const drivers = data.drivers
    .filter((d) => d.available && (d.pearson != null || d.spearman != null))
    .slice(0, 8)
  const betas = data.betas?.rows.slice(0, 8) ?? []
  const regimes = data.regimes?.buckets.filter((b) => b.days > 0).slice(0, 6) ?? []

  return (
    <div className="space-y-4">
      {drivers.length > 0 && (
        <Panel label="Top macro drivers">
          <Table className="text-xs">
            <TableHead>
              <tr>
                <TableHeader>Driver</TableHeader>
                <TableHeader numeric>Pearson</TableHeader>
                <TableHeader numeric>Spearman</TableHeader>
                <TableHeader numeric>Beta / sd</TableHeader>
              </tr>
            </TableHead>
            <TableBody>
              {drivers.map((d) => (
                <TableRow key={d.key} className="hover:bg-foreground/[0.02]">
                  <TableCell className="py-1.5 pr-4">{d.label} <span className="text-micro text-muted-foreground">({d.group})</span></TableCell>
                  <TableCell numeric className={cn('py-1.5 pr-4', tone(d.pearson))}>{fmt4(d.pearson)}</TableCell>
                  <TableCell numeric className={cn('py-1.5 pr-4', tone(d.spearman))}>{fmt4(d.spearman)}</TableCell>
                  <TableCell numeric className={cn('py-1.5 pr-4', tone(d.beta_per_sd))}>{fmt4(d.beta_per_sd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}

      {betas.length > 0 && (
        <Panel label="Factor-model betas">
          <Table className="text-xs">
            <TableHead>
              <tr>
                <TableHeader>Factor</TableHeader>
                <TableHeader numeric>Beta</TableHeader>
                <TableHeader numeric>t-stat</TableHeader>
                <TableHeader numeric>p-value</TableHeader>
                <TableHeader numeric>VIF</TableHeader>
              </tr>
            </TableHead>
            <TableBody>
              {betas.map((b) => (
                <TableRow key={b.key} className="hover:bg-foreground/[0.02]">
                  <TableCell className="py-1.5 pr-4">{b.label} <span className="text-micro text-muted-foreground">({b.group})</span></TableCell>
                  <TableCell numeric className={cn('py-1.5 pr-4', tone(b.beta))}>{fmt4(b.beta)}</TableCell>
                  <TableCell numeric className="py-1.5 pr-4 text-muted-foreground">{fmt4(b.t_stat)}</TableCell>
                  <TableCell numeric className="py-1.5 pr-4 text-muted-foreground">{fmt4(b.p_value)}</TableCell>
                  <TableCell numeric className="py-1.5 pr-4 text-muted-foreground">{b.vif == null ? '—' : b.vif.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}

      {regimes.length > 0 && (
        <Panel label="Performance by macro regime">
          <Table className="text-xs">
            <TableHead>
              <tr>
                <TableHeader>Regime</TableHeader>
                <TableHeader numeric>Days</TableHeader>
                <TableHeader numeric>Ann. return</TableHeader>
                <TableHeader numeric>Ann. vol</TableHeader>
                <TableHeader numeric>Sharpe</TableHeader>
              </tr>
            </TableHead>
            <TableBody>
              {regimes.map((b) => (
                <TableRow key={b.regime} className="hover:bg-foreground/[0.02]">
                  <TableCell className="py-1.5 pr-4">{b.label}</TableCell>
                  <TableCell numeric className="py-1.5 pr-4 text-muted-foreground">{b.days}</TableCell>
                  <TableCell numeric className={cn('py-1.5 pr-4', tone(b.ann_return))}>{fmtPct(b.ann_return)}</TableCell>
                  <TableCell numeric className="py-1.5 pr-4 text-muted-foreground">{fmtPct(b.ann_vol)}</TableCell>
                  <TableCell numeric className="py-1.5 pr-4 text-muted-foreground">{fmt4(b.sharpe)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </div>
  )
}

function tone(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return ''
  return value > 0 ? 'text-primary' : value < 0 ? 'text-clay' : ''
}

function fmt4(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(4)
}

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function HeroBanner({ report, strategy }: { report: RunReport; strategy: StoredStrategy }) {
  const excess = report.risk['excess_return_with_cost'] ?? {}
  const ann = excess['annualized_return']
  const ir = excess['information_ratio']
  const dd = excess['max_drawdown']
  const vol = excess['std']
  const ts = report.trade_summary
  const period = report.period

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="border-b border-border/50 bg-muted/30 px-5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Latest run</div>
            <div className="text-lg">{report.run.name}</div>
          </div>
          <div className="font-mono text-label text-muted-foreground">
            {strategy.model} · {strategy.handler} · {strategy.universe} · vs {strategy.benchmark}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px divide-y divide-border/50 border-b border-border/50 bg-border/30 lg:grid-cols-6 lg:divide-y-0">
        <HeroMetric label="Ann. return" value={ann} percent large />
        <HeroMetric label="Information ratio" value={ir} digits={3} large />
        <HeroMetric label="Max drawdown" value={dd} percent negative large />
        <HeroMetric label="Volatility" value={vol} percent negative large />
        <HeroMetric label="Turnover" value={ts?.annual_turnover} suffix="×" digits={2} />
        <HeroMetric label="Period" text={period ? `${period.start} → ${period.end}` : '—'} />
      </div>
    </div>
  )
}

/** MetricTile in the report's flush grid cell — same formatting, same tones. */
function HeroMetric({
  label, value, text, digits = 2, percent, negative, suffix, large,
}: {
  label: string
  value?: number | null
  text?: string
  digits?: number
  percent?: boolean
  negative?: boolean
  suffix?: string
  large?: boolean
}) {
  return (
    <MetricTile
      bare
      label={label}
      value={value}
      text={text}
      digits={digits}
      percent={percent}
      negative={negative}
      suffix={suffix}
      hero={large}
      className="bg-card px-5 py-4"
    />
  )
}

function SectionTitle({ n, title, caption }: { n: string; title: string; caption?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-3 border-b border-border/40 pb-2">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-muted font-mono text-micro text-muted-foreground/70">
        {n}
      </span>
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {caption && <span className="min-w-0 truncate text-label text-muted-foreground">{caption}</span>}
    </div>
  )
}

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <MicroLabel as="div" className="mb-1">
        {label}
      </MicroLabel>
      {children}
    </div>
  )
}

function sharpe(excess: Record<string, number | null>): number | null {
  const ann = excess['annualized_return']
  const vol = excess['std']
  if (ann == null || vol == null || vol === 0) return null
  return ann / vol
}

function calmar(excess: Record<string, number | null>): number | null {
  const ann = excess['annualized_return']
  const dd = excess['max_drawdown']
  if (ann == null || dd == null || dd >= 0) return null
  return ann / Math.abs(dd)
}

function useRollingMetrics(daily: NonNullable<RunReport['daily']>) {
  return useMemo(() => {
    const rets = daily['return'] ?? []
    const bench = daily['bench'] ?? []
    const cost = daily['cost'] ?? []
    if (!rets.length) return []

    const byDate = new Map<string, { r: number; b: number; c: number }>()
    for (const p of rets) if (p.value != null) byDate.set(p.date, { r: p.value, b: 0, c: 0 })
    for (const p of bench) if (p.value != null) byDate.get(p.date) && (byDate.get(p.date)!.b = p.value)
    for (const p of cost) if (p.value != null) byDate.get(p.date) && (byDate.get(p.date)!.c = p.value)

    const rows = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const window = 63
    const out: { date: string; ir: number | null; vol: number | null }[] = []
    for (let i = 0; i < rows.length; i++) {
      if (i < window - 1) {
        out.push({ date: rows[i][0], ir: null, vol: null })
        continue
      }
      const slice = rows.slice(i - window + 1, i + 1).map(([, v]) => v.r - v.c - v.b)
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length
      const std = Math.sqrt(variance)
      out.push({
        date: rows[i][0],
        ir: std > 0 ? (mean / std) * Math.sqrt(252) : null,
        vol: std * Math.sqrt(252),
      })
    }
    return out
  }, [daily])
}

function useTradeActivity(daily: NonNullable<RunReport['daily']>, estimatedTrades?: number) {
  return useMemo(() => {
    const turnover = daily['turnover'] ?? []
    const days = turnover
      .filter((p): p is { date: string; value: number } => p.value != null && p.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((p) => ({
        date: p.date,
        turnover: p.value,
        roundTrips: Math.max(1, Math.round(p.value * 2)),
      }))
    const activeDays = days.length
    const values = turnover.map((p) => p.value).filter((v): v is number => v != null)
    const avgTurnover = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
    const maxTurnover = values.length ? Math.max(...values) : null
    const totalTrades = estimatedTrades ?? (values.length
      ? values.reduce((a, b) => a + Math.max(1, Math.round(b * 2)), 0)
      : null)
    return { turnoverDays: days, activeDays, avgTurnover, maxTurnover, estimatedTrades: totalTrades }
  }, [daily, estimatedTrades])
}

function MonthlyTable({ rows }: { rows: ReturnType<typeof monthlyReturns> }) {
  const peak = Math.max(...rows.flatMap((r) => r.months.map((m) => Math.abs(m.value))), 0.0001)
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse font-mono text-xs">
        <thead>
          <tr className="text-muted-foreground/70">
            <th className="px-2 py-1.5 text-left font-normal uppercase tracking-wider">Year</th>
            {MONTHS.map((m) => <th key={m} className="px-2 py-1.5 text-right font-normal">{m}</th>)}
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
                        background: `hsl(var(--${v >= 0 ? 'primary' : 'clay'}) / ${(0.08 + 0.32 * Math.min(1, Math.abs(v) / peak)).toFixed(3)})`,
                      }}
                    >
                      {v == null ? '' : (v * 100).toFixed(1)}
                    </td>
                  )
                })}
                <td className={cn('tnum px-2 py-1.5 text-right font-medium', row.total >= 0 ? 'text-primary' : 'text-clay')}>
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

function IndicatorTable({ report, annualTurnover, estimatedTrades }: { report: RunReport; annualTurnover: number | null; estimatedTrades: number | null }) {
  const risk = report.risk['excess_return_with_cost'] ?? {}
  const rows = [
    { label: 'Ann. return', value: risk['annualized_return'], percent: true },
    { label: 'Information ratio', value: risk['information_ratio'], digits: 3 },
    { label: 'Max drawdown', value: risk['max_drawdown'], percent: true, negative: true },
    { label: 'Volatility', value: risk['std'], percent: true, negative: true },
    { label: 'IC', value: report.metrics['IC'], digits: 4 },
    { label: 'Rank IC', value: report.metrics['Rank IC'], digits: 4 },
    { label: 'ICIR', value: report.metrics['ICIR'], digits: 4 },
    { label: 'Annual turnover', value: annualTurnover, digits: 2, suffix: '×' },
    { label: 'Est. trades', value: estimatedTrades, digits: 0 },
    { label: 'Trading days', value: report.trade_summary?.trading_days ?? report.period?.days, digits: 0 },
  ]
  for (const [key, value] of Object.entries(report.indicators ?? {})) {
    rows.push({ label: key, value, digits: 4 })
  }
  return (
    <Table className="text-xs">
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.label} className="hover:bg-foreground/[0.02]">
            <TableCell className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70">
              {r.label}
            </TableCell>
            <TableCell numeric className={cn(r.negative ? 'text-clay' : '')}>
              {formatValue(r.value, r.percent, r.digits, r.suffix)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function formatValue(value: number | null | undefined, percent?: boolean, digits = 2, suffix?: string): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const s = suffix ?? ''
  if (percent) return formatRunPercent(value, digits === 2 ? 1 : digits) + s
  return value.toFixed(digits) + s
}

function Positions({ runId }: { runId: string }) {
  const [data, setData] = useState<{ date: string; top: { instrument: string; score: number | null }[] } | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    api.runPredictions(runId)
      .then((r) => live && setData(r))
      .catch(() => live && setError(true))
    return () => { live = false }
  }, [runId])

  if (error) return <p className="text-label text-muted-foreground">No predictions recorded.</p>
  if (!data) return <p className="text-label text-muted-foreground">Loading positions…</p>
  if (!data.top.length) return <p className="text-label text-muted-foreground">Nothing scored on {data.date}.</p>

  return (
    <div className="rounded-lg border border-border/50">
      <MicroLabel as="div" className="border-b border-border/50 px-3 py-2">
        {data.date} · top {data.top.length}
      </MicroLabel>
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

function SpecTable({ strategy }: { strategy: StoredStrategy }) {
  const rows = [
    { label: 'Model', value: strategy.model },
    { label: 'Feature set', value: strategy.handler },
    { label: 'Universe', value: strategy.universe },
    { label: 'Store', value: strategy.data_store },
    { label: 'Benchmark', value: strategy.benchmark },
    { label: 'Top K / drop', value: `${strategy.topk} / ${strategy.n_drop}` },
    { label: 'Open / close cost', value: `${(strategy.open_cost * 100).toFixed(2)}% / ${(strategy.close_cost * 100).toFixed(2)}%` },
    { label: 'Account', value: strategy.account.toLocaleString() },
    { label: 'Train', value: `${strategy.train_start} → ${strategy.train_end}` },
    { label: 'Validate', value: `${strategy.valid_start} → ${strategy.valid_end}` },
    { label: 'Test', value: `${strategy.test_start} → ${strategy.test_end}` },
    { label: 'Origin', value: strategy.origin },
  ]
  return (
    <div className="space-y-4">
      {strategy.description && (
        <p className="max-w-3xl text-sm text-muted-foreground">{strategy.description}</p>
      )}
      <Table className="text-xs">
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.label} className="hover:bg-foreground/[0.02]">
              <TableCell className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70">
                {r.label}
              </TableCell>
              <TableCell className="text-right">{r.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {strategy.features && strategy.features.length > 0 && (
        <div>
          <MicroLabel as="div" className="mb-2">
            Custom features ({strategy.feature_mode})
          </MicroLabel>
          <div className="space-y-1">
            {strategy.features.map((f) => (
              <div key={f.name} className="rounded border border-border/50 px-3 py-1.5 font-mono text-xs">
                <span className="font-medium">{f.name}</span>{' '}
                <span className="text-muted-foreground">= {f.expression}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
