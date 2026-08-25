import { useMemo, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { Activity, Play, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { useIndicatorBars } from '@/hooks/useIndicatorBars'
import { computeRSI } from '@/lib/indicators'
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

export function RsiIndicator() {
  const [symbol, setSymbol] = useState('SPY')
  const [period, setPeriod] = useState('14')
  const [runSymbol, setRunSymbol] = useState('SPY')
  const { bars, loading, error } = useIndicatorBars(runSymbol, 365)

  const rsi = useMemo(() => {
    const p = Number(period)
    if (!Number.isFinite(p) || p < 2) return []
    return computeRSI(bars, p)
  }, [bars, period])

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
            <Label className="text-micro uppercase tracking-wider text-muted-foreground">Period</Label>
            <Input
              type="number"
              min={2}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-20 text-sm"
            />
          </div>

          <Button
            onClick={() => setRunSymbol(symbol)}
            disabled={loading}
            size="sm"
            className="ml-auto gap-1.5"
          >
            {loading ? <Activity className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </div>
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto bg-muted/20 p-6">
        {error && <Notice tone="destructive" className="mb-4">{error}</Notice>}

        {!loading && !error && rsi.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border/50 bg-background shadow-sm">
              <Activity className="h-8 w-8 opacity-30" />
            </div>
            <p className="text-sm font-medium">Enter a symbol and run the RSI model</p>
            <p className="mt-1 max-w-sm text-center text-label opacity-70">
              The Relative Strength Index measures speed and magnitude of recent price changes.
            </p>
          </div>
        )}

        {rsi.length > 0 && (
          <div className="grid gap-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Current RSI" value={rsi[rsi.length - 1].rsi.toFixed(2)} />
              <StatCard
                label="Signal"
                value={rsi[rsi.length - 1].rsi > 70 ? 'Overbought' : rsi[rsi.length - 1].rsi < 30 ? 'Oversold' : 'Neutral'}
                tone={rsi[rsi.length - 1].rsi > 70 ? 'clay' : rsi[rsi.length - 1].rsi < 30 ? 'primary' : 'muted'}
              />
              <StatCard label="Data points" value={rsi.length.toString()} />
            </div>

            <Panel title="RSI" hint={`${period}-period Wilder's RSI`}>
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={rsi} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
                  <defs>
                    <linearGradient id="rsiFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                  <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={28} tick={AXIS_TICK} />
                  <YAxis domain={[0, 100]} tickLine={false} axisLine={false} tick={AXIS_TICK} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [v.toFixed(2), 'RSI']} />
                  <ReferenceLine y={70} stroke="hsl(var(--clay))" strokeDasharray="4 4" />
                  <ReferenceLine y={30} stroke="hsl(var(--primary))" strokeDasharray="4 4" />
                  <ReferenceLine y={50} stroke="hsl(var(--border))" />
                  <Area
                    type="monotone"
                    dataKey="rsi"
                    stroke="hsl(var(--primary))"
                    strokeWidth={1.5}
                    fill="url(#rsiFill)"
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}
      </main>
    </div>
  )
}

function StatCard({
  label,
  value,
  tone = 'muted',
}: {
  label: string
  value: string
  tone?: 'primary' | 'clay' | 'muted'
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 shadow-sm">
      <div className="text-micro uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold tnum',
          tone === 'primary' && 'text-primary',
          tone === 'clay' && 'text-clay',
        )}
      >
        {value}
      </div>
    </div>
  )
}
