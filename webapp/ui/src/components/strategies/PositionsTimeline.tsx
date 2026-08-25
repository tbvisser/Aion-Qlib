import { useEffect, useMemo, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, ComposedChart, Legend, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MetricTile } from '@/components/MetricTile'
import { api, type PositionHistory, type PositionTrade } from '@/lib/api'
import { cn } from '@/lib/utils'

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
 * Visualise the actual positions a strategy held over time.
 *
 * Reads the position history that qlib wrote during the backtest, so this is
 * not an estimate from turnover: it is the long/short exposure, the number of
 * open positions, and the inferred open/close/adjust events day by day.
 */
export function PositionsTimeline({ runId }: { runId: string }) {
  const [history, setHistory] = useState<PositionHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(false)
    api.runPositions(runId)
      .then((r) => { if (live) setHistory(r) })
      .catch(() => { if (live) setError(true) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [runId])

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          Loading position history…
        </CardContent>
      </Card>
    )
  }

  if (error || !history) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-4 text-sm text-muted-foreground">
          No position history recorded for this run.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <PositionSummary history={history} />
      <ExposureChart history={history} />
      <PositionCountChart history={history} />
      <TradeTimeline history={history} />
      <LatestHoldings history={history} />
    </div>
  )
}

function PositionSummary({ history }: { history: PositionHistory }) {
  const { daily, trades } = history
  const avgCount = daily.length
    ? daily.reduce((a, b) => a + b.position_count, 0) / daily.length
    : 0
  const opens = trades.filter((t) => t.direction === 'open').length
  const closes = trades.filter((t) => t.direction === 'close').length
  const avgLong = daily.length
    ? daily.reduce((a, b) => a + (b.long_exposure ?? 0), 0) / daily.length
    : 0
  const avgGross = daily.length
    ? daily.reduce((a, b) => a + (b.gross_exposure ?? 0), 0) / daily.length
    : 0

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <MetricTile label="Avg positions" value={avgCount} digits={0} />
      <MetricTile label="Avg long exposure" value={avgLong} percent />
      <MetricTile label="Avg gross exposure" value={avgGross} percent />
      <MetricTile label="Open events" value={opens} digits={0} />
      <MetricTile label="Close events" value={closes} digits={0} />
    </div>
  )
}

function ExposureChart({ history }: { history: PositionHistory }) {
  const data = useMemo(() => {
    return history.daily.map((d) => ({
      date: d.date,
      Long: d.long_exposure ?? 0,
      Short: -(d.short_exposure ?? 0),
      Net: d.net_exposure ?? 0,
      Gross: d.gross_exposure ?? 0,
    }))
  }, [history])

  if (data.length < 2) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Exposure over time</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
            <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tick={AXIS_TICK} />
            <YAxis
              yAxisId="left"
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <Tooltip {...TOOLTIP} formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, '']} />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="Long"
              stackId="exposure"
              stroke="hsl(var(--primary))"
              fill="hsl(var(--primary) / 0.18)"
              strokeWidth={1.2}
            />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="Short"
              stackId="exposure"
              stroke="hsl(var(--clay))"
              fill="hsl(var(--clay) / 0.18)"
              strokeWidth={1.2}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="Net"
              stroke="hsl(var(--foreground))"
              strokeWidth={1.6}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

function PositionCountChart({ history }: { history: PositionHistory }) {
  const data = useMemo(() =>
    history.daily.map((d) => ({ date: d.date, count: d.position_count })),
  [history])

  if (data.length < 2) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Open positions</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
            <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tick={AXIS_TICK} />
            <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} />
            <Tooltip {...TOOLTIP} formatter={(v: number) => [v, 'Positions']} />
            <Area
              type="stepAfter"
              dataKey="count"
              stroke="hsl(var(--primary))"
              fill="hsl(var(--primary) / 0.12)"
              strokeWidth={1.6}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

function TradeTimeline({ history }: { history: PositionHistory }) {
  const [filter, setFilter] = useState<'all' | 'open' | 'close' | 'adjust'>('all')
  const data = useMemo(() => {
    const trades = filter === 'all'
      ? history.trades
      : history.trades.filter((t) => t.direction === filter)
    return trades
      .map((t) => ({ ...t, x: t.date, y: t.delta ?? 0 }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [history, filter])

  const grouped = useMemo(() => {
    const byDate = new Map<string, { open: number; close: number; adjust: number }>()
    for (const t of history.trades) {
      const row = byDate.get(t.date) ?? { open: 0, close: 0, adjust: 0 }
      row[t.direction] += 1
      byDate.set(t.date, row)
    }
    return [...byDate.entries()]
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [history])

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm">Trade events</CardTitle>
          <div className="flex items-center gap-1">
            {(['all', 'open', 'close', 'adjust'] as const).map((key) => (
              <Button
                key={key}
                variant={filter === key ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-label capitalize"
                onClick={() => setFilter(key)}
              >
                {key}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {grouped.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={grouped} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tick={AXIS_TICK} />
                <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} />
                <Tooltip {...TOOLTIP} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
                <Area type="step" dataKey="open" stackId="trades" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.2)" />
                <Area type="step" dataKey="close" stackId="trades" stroke="hsl(var(--clay))" fill="hsl(var(--clay) / 0.2)" />
                <Area type="step" dataKey="adjust" stackId="trades" stroke="hsl(var(--muted-foreground))" fill="hsl(var(--muted-foreground) / 0.15)" />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground">No trade events recorded.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent events ({data.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table containerClassName="max-h-60 overflow-y-auto" className="text-xs">
            <TableHead>
              <tr>
                <TableHeader className="py-1.5 pr-3">Date</TableHeader>
                <TableHeader className="py-1.5 pr-3">Instrument</TableHeader>
                <TableHeader className="py-1.5 pr-3">Dir</TableHeader>
                <TableHeader numeric className="py-1.5 pr-3">Δ</TableHeader>
              </tr>
            </TableHead>
            <TableBody>
              {data.slice(-50).reverse().map((t) => (
                <TableRow key={`${t.date}-${t.instrument}`} className="hover:bg-foreground/[0.02]">
                  <TableCell className="py-1.5 pr-3 font-mono text-micro">{t.date}</TableCell>
                  <TableCell className="py-1.5 pr-3 font-mono">{t.instrument}</TableCell>
                  <TableCell className="py-1.5 pr-3">
                    <DirectionBadge direction={t.direction} />
                  </TableCell>
                  <TableCell numeric className={cn('py-1.5 pr-3', (t.delta ?? 0) > 0 ? 'text-primary' : 'text-clay')}>
                    {t.delta == null ? '—' : `${(t.delta * 100).toFixed(1)}%`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function DirectionBadge({ direction }: { direction: PositionTrade['direction'] }) {
  const map = {
    open: 'bg-primary/15 text-primary',
    close: 'bg-clay/15 text-clay',
    adjust: 'bg-muted-foreground/15 text-muted-foreground',
  }
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-micro font-medium uppercase', map[direction])}>
      {direction}
    </span>
  )
}

function LatestHoldings({ history }: { history: PositionHistory }) {
  const { latest } = history
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Latest holdings · {latest.date}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table className="text-xs">
          <TableHead>
            <tr>
              <TableHeader>#</TableHeader>
              <TableHeader>Instrument</TableHeader>
              <TableHeader numeric>Weight</TableHeader>
            </tr>
          </TableHead>
          <TableBody>
            {latest.top.map((row, i) => (
              <TableRow key={row.instrument} className="hover:bg-foreground/[0.02]">
                <TableCell className="py-1.5 pr-4 font-mono text-micro text-muted-foreground">{i + 1}</TableCell>
                <TableCell className="py-1.5 pr-4 font-mono">{row.instrument}</TableCell>
                <TableCell numeric className={cn('py-1.5 pr-4', (row.weight ?? 0) < 0 ? 'text-clay' : '')}>
                  {row.weight == null ? '—' : `${(row.weight * 100).toFixed(2)}%`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
