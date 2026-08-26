import { useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Line, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { Play, Search, TrendingUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { useIndicatorBars } from '@/hooks/useIndicatorBars'
import { computeMACD } from '@/lib/indicators'

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

export function MacdIndicator() {
  const [symbol, setSymbol] = useState('SPY')
  const [fast, setFast] = useState('12')
  const [slow, setSlow] = useState('26')
  const [signal, setSignal] = useState('9')
  const [runSymbol, setRunSymbol] = useState('SPY')
  const { bars, loading, error } = useIndicatorBars(runSymbol, 365)

  const macd = useMemo(() => {
    const f = Number(fast)
    const s = Number(slow)
    const g = Number(signal)
    if (!Number.isFinite(f) || !Number.isFinite(s) || !Number.isFinite(g)) return []
    if (f < 1 || s < 1 || g < 1 || f >= s) return []
    return computeMACD(bars, f, s, g)
  }, [bars, fast, slow, signal])

  const last = macd[macd.length - 1]

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
            <Label className="text-micro uppercase tracking-wider text-muted-foreground">Fast</Label>
            <Input type="number" min={1} value={fast} onChange={(e) => setFast(e.target.value)} className="w-20 text-sm" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-micro uppercase tracking-wider text-muted-foreground">Slow</Label>
            <Input type="number" min={1} value={slow} onChange={(e) => setSlow(e.target.value)} className="w-20 text-sm" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-micro uppercase tracking-wider text-muted-foreground">Signal</Label>
            <Input type="number" min={1} value={signal} onChange={(e) => setSignal(e.target.value)} className="w-20 text-sm" />
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

        {!loading && !error && macd.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border/50 bg-background shadow-sm">
              <TrendingUp className="h-8 w-8 opacity-30" />
            </div>
            <p className="text-sm font-medium">Enter a symbol and run the MACD model</p>
            <p className="mt-1 max-w-sm text-center text-label opacity-70">
              MACD shows the relationship between two moving averages of a price.
            </p>
          </div>
        )}

        {macd.length > 0 && last && (
          <div className="grid gap-5">
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard label="MACD" value={last.macd.toFixed(4)} />
              <StatCard label="Signal" value={last.signal.toFixed(4)} />
              <StatCard label="Histogram" value={last.histogram.toFixed(4)} />
              <StatCard label="Data points" value={macd.length.toString()} />
            </div>

            <Panel title="MACD" hint={`${fast},${slow},${signal} EMA configuration`}>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={macd} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                  <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={28} tick={AXIS_TICK} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" />
                  <Bar dataKey="histogram" radius={[2, 2, 0, 0]}>
                    {macd.map((entry, i) => (
                      <Cell
                        key={`cell-${i}`}
                        fill={entry.histogram >= 0 ? 'hsl(var(--primary))' : 'hsl(var(--clay))'}
                      />
                    ))}
                  </Bar>
                  <Line type="monotone" dataKey="macd" stroke="hsl(var(--primary))" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="signal" stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}
      </main>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 shadow-sm">
      <div className="text-micro uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className="mt-1 text-2xl font-semibold tnum">{value}</div>
    </div>
  )
}
