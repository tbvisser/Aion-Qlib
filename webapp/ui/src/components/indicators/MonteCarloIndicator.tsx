import { useMemo, useState } from 'react'
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { Dices, Play, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { useIndicatorBars } from '@/hooks/useIndicatorBars'
import { computeMonteCarlo, type MonteCarloResult } from '@/lib/indicators'
import { cn } from '@/lib/utils'

const AXIS_TICK = {
  fontSize: 10,
  fontFamily: "'IBM Plex Mono', monospace",
  fill: 'hsl(var(--muted-foreground))',
}

const tooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 11,
  fontFamily: "'IBM Plex Mono', monospace",
}

export function MonteCarloIndicator() {
  const [symbol, setSymbol] = useState('SPY')
  const [simulations, setSimulations] = useState('100')
  const [days, setDays] = useState('30')
  const [runSymbol, setRunSymbol] = useState('SPY')
  const { bars, loading, error } = useIndicatorBars(runSymbol, 365 * 2)

  const result = useMemo<MonteCarloResult | null>(() => {
    const s = Number(simulations)
    const d = Number(days)
    if (!Number.isFinite(s) || !Number.isFinite(d)) return null
    return computeMonteCarlo(bars, s, d)
  }, [bars, simulations, days])

  const chartData = useMemo(() => {
    if (!result) return []
    return result.meanPath.dates.map((date, i) => ({
      date,
      p05: result.p05.values[i],
      mean: result.meanPath.values[i],
      p95: result.p95.values[i],
    }))
  }, [result])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border/50 bg-background/80 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-micro uppercase tracking-wider text-muted-foreground">Symbol</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="e.g. SPY"
                className="w-36 pl-8 text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setRunSymbol(symbol)
                }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-micro uppercase tracking-wider text-muted-foreground">Simulations</Label>
            <Input type="number" min={10} value={simulations} onChange={(e) => setSimulations(e.target.value)} className="w-24 text-sm" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-micro uppercase tracking-wider text-muted-foreground">Days</Label>
            <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className="w-20 text-sm" />
          </div>

          <Button
            onClick={() => setRunSymbol(symbol)}
            disabled={loading}
            size="sm"
            className="ml-auto gap-1.5"
          >
            {loading ? <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </div>
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto bg-muted/20 p-6">
        {error && <Notice tone="destructive" className="mb-4">{error}</Notice>}

        {!loading && !error && !result && (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border/50 bg-background shadow-sm">
              <Dices className="h-8 w-8 opacity-30" />
            </div>
            <p className="text-sm font-medium">Run a Monte Carlo simulation</p>
            <p className="mt-1 max-w-sm text-center text-label opacity-70">
              Generate forward price paths using geometric Brownian motion and view probability cones.
            </p>
          </div>
        )}

        {result && (
          <div className="grid gap-5">
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard label="Current price" value={`$${result.currentPrice.toFixed(2)}`} />
              <StatCard label="Ann. return" value={`${(result.annualizedReturn * 100).toFixed(2)}%`} />
              <StatCard label="Ann. volatility" value={`${(result.annualizedVolatility * 100).toFixed(2)}%`} />
              <StatCard label="Mean forecast" value={`$${result.meanPath.values[result.meanPath.values.length - 1].toFixed(2)}`} />
            </div>

            <Panel title="Monte Carlo projection" hint={`${simulations} GBM paths, ${days} trading days`}>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
                  <defs>
                    <linearGradient id="mcBand" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} tick={AXIS_TICK} />
                  <YAxis domain={['auto', 'auto']} tickLine={false} axisLine={false} tick={AXIS_TICK} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`, '']} />
                  <ReferenceLine y={result.currentPrice} stroke="hsl(var(--border))" strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="p95" stroke="none" fill="url(#mcBand)" />
                  <Area type="monotone" dataKey="p05" stroke="none" fill="transparent" />
                  <Line type="monotone" dataKey="p95" stroke="hsl(var(--primary))" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="p05" stroke="hsl(var(--clay))" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="mean" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}
      </main>
    </div>
  )
}

function StatCard({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'primary' | 'clay' | 'muted' }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 shadow-sm">
      <div className="text-micro uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tnum', tone === 'primary' && 'text-primary', tone === 'clay' && 'text-clay')}>
        {value}
      </div>
    </div>
  )
}
