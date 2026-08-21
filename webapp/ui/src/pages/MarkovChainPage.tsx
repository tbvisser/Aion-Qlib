import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  Activity, ArrowRightLeft, BrainCircuit, Briefcase, Clock, Cpu, Layers, Play,
  Search, Sparkles, TrendingUp,
} from 'lucide-react'

import { Markov3DGraph } from '@/components/markov/Markov3DGraph'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { usePortfolios } from '@/hooks/usePortfolios'
import { useStrategies } from '@/hooks/useStrategies'
import {
  api, type Instrument, type MarkovAnalyzeResponse,
} from '@/lib/api'
import { computeDemoMarkov } from '@/lib/markovDemo'
import { cn } from '@/lib/utils'

type Source = 'assets' | 'strategies' | 'portfolios'
type Subject =
  | { kind: 'asset'; id: string; label: string; symbol: string }
  | { kind: 'strategy'; id: string; label: string; symbol: string }
  | { kind: 'portfolio'; id: string; label: string; symbol: string }

const FONT_FAMILY = {
  mono: 'IBM Plex Mono',
  sans: "'Hanken Grotesk', system-ui, sans-serif",
}

const AXIS_TICK = {
  fontSize: 10,
  fontFamily: FONT_FAMILY.mono,
  fill: 'hsl(var(--muted-foreground))',
}

const STATE_COLORS: Record<string, string> = {
  Bull: 'hsl(var(--primary))',
  Bear: 'hsl(var(--clay))',
  Sideways: 'hsl(var(--muted-foreground))',
}

const STATE_BG: Record<string, string> = {
  Bull: 'bg-primary/10 text-primary',
  Bear: 'bg-clay/10 text-clay',
  Sideways: 'bg-muted/50 text-muted-foreground',
}

const DEMO_ASSETS = [
  { symbol: 'SPY', label: 'S&P 500 ETF' },
  { symbol: 'QQQ', label: 'Nasdaq-100 ETF' },
  { symbol: 'IWM', label: 'Russell 2000 ETF' },
  { symbol: 'TLT', label: '20+ Year Treasuries' },
  { symbol: 'GLD', label: 'Gold ETF' },
  { symbol: 'VIX', label: 'VIX Index' },
  { symbol: 'AAPL', label: 'Apple' },
  { symbol: 'MSFT', label: 'Microsoft' },
  { symbol: 'NVDA', label: 'NVIDIA' },
  { symbol: 'TSLA', label: 'Tesla' },
]

export function MarkovChainPage() {
  const [source, setSource] = useState<Source>('assets')
  const [selected, setSelected] = useState<Subject[]>([])
  const [customSymbol, setCustomSymbol] = useState('')
  const [assetFilter, setAssetFilter] = useState('')
  const [window, setWindow] = useState('20')
  const [bull, setBull] = useState('0.02')
  const [bear, setBear] = useState('-0.02')
  const [lookback, setLookback] = useState('252')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Map<string, MarkovAnalyzeResponse>>(new Map())
  const [forceDemo, setForceDemo] = useState(false)

  const { saved: strategies } = useStrategies()
  const { portfolios } = usePortfolios()
  const [assets, setAssets] = useState<Instrument[]>([])
  const [assetsLoading, setAssetsLoading] = useState(false)

  useEffect(() => {
    if (source !== 'assets') return
    setAssetsLoading(true)
    api.instruments({ universe: 'top500', limit: 50 })
      .then((r) => setAssets(r.instruments.slice(0, 50)))
      .catch(() => setAssets([]))
      .finally(() => setAssetsLoading(false))
  }, [source])

  const subjects = useMemo<Subject[]>(() => {
    switch (source) {
      case 'assets':
        return [
          ...DEMO_ASSETS.map((a) => ({ kind: 'asset' as const, id: a.symbol, label: a.label, symbol: a.symbol })),
          ...assets.map((a) => ({ kind: 'asset' as const, id: a.symbol, label: a.name, symbol: a.symbol })),
        ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i)
      case 'strategies':
        return strategies.map((s) => ({
          kind: 'strategy' as const,
          id: s.id,
          label: s.name,
          symbol: s.benchmark,
        }))
      case 'portfolios':
        return portfolios.map((p) => ({
          kind: 'portfolio' as const,
          id: p.id,
          label: p.name,
          symbol: p.benchmark,
        }))
    }
  }, [source, assets, strategies, portfolios])

  const filteredSubjects = useMemo(() => {
    const q = assetFilter.trim().toLowerCase()
    if (!q) return subjects
    return subjects.filter((s) => s.label.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q))
  }, [subjects, assetFilter])

  const toggleSubject = useCallback((subject: Subject) => {
    setSelected((prev) => {
      const exists = prev.find((s) => s.id === subject.id)
      if (exists) return prev.filter((s) => s.id !== subject.id)
      if (prev.length >= 6) return prev
      return [...prev, subject]
    })
  }, [])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    const next = new Map<string, MarkovAnalyzeResponse>()
    const targets: Subject[] = selected.length ? [...selected] : []
    if (customSymbol.trim() && !targets.find((t) => t.symbol === customSymbol.toUpperCase())) {
      targets.push({
        kind: 'asset',
        id: `custom-${customSymbol.toUpperCase()}`,
        label: customSymbol.toUpperCase(),
        symbol: customSymbol.toUpperCase(),
      })
    }
    if (!targets.length) {
      setError('Select at least one asset, strategy or portfolio, or type a symbol.')
      setRunning(false)
      return
    }

    const params = {
      window: Number(window),
      bull: Number(bull),
      bear: Number(bear),
      lookback: Number(lookback),
    }

    await Promise.all(
      targets.map(async (subject) => {
        if (forceDemo) {
          next.set(subject.id, computeDemoMarkov({ symbol: subject.symbol, ...params }))
          return
        }
        try {
          const data = await api.markovAnalyze({
            symbol: subject.symbol,
            ...params,
          })
          next.set(subject.id, data)
        } catch (err) {
          // Gracefully fall back to synthetic demo data when live prices are unavailable.
          next.set(subject.id, computeDemoMarkov({ symbol: subject.symbol, ...params }))
        }
      }),
    )

    setResults(next)
    setRunning(false)
  }, [selected, customSymbol, window, bull, bear, lookback, forceDemo])

  const active = useMemo(() => {
    if (selected.length === 0) return null
    return results.get(selected[0].id) ?? null
  }, [selected, results])

  const hasDemoResults = useMemo(() => {
    return Array.from(results.values()).some((r) => r.source === 'demo')
  }, [results])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Markov Chain Regime Analyzer"
        description="Quantitative regime switching, transition probabilities and walk-forward signals."
        actions={
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 rounded-full border border-border/50 bg-background px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-border">
              <input
                type="checkbox"
                checked={forceDemo}
                onChange={(e) => setForceDemo(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-muted-foreground accent-primary"
              />
              <Sparkles className="h-3.5 w-3.5" />
              Demo data
            </label>
            <Button onClick={run} disabled={running} size="sm" className="gap-1.5">
              {running ? <Activity className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run{selected.length ? ` (${selected.length})` : ''}
            </Button>
          </div>
        }
      />

      {/* Toolbar */}
      <div className="shrink-0 border-b border-border/50 bg-background/80 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Source</Label>
            <Segmented
              value={source}
              onChange={(v) => {
                setSource(v as Source)
                setSelected([])
                setResults(new Map())
                setAssetFilter('')
              }}
              options={[
                { value: 'assets', label: 'Assets', icon: Layers },
                { value: 'strategies', label: 'Strategies', icon: Cpu },
                { value: 'portfolios', label: 'Portfolios', icon: Briefcase },
              ]}
              buttonClassName="font-sans"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Symbol</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={customSymbol}
                onChange={(e) => setCustomSymbol(e.target.value)}
                placeholder="e.g. SPY"
                className="w-36 pl-8 text-sm"
              />
            </div>
          </div>

          <Param label="Window" value={window} onChange={setWindow} width="w-20" />
          <Param label="Bull" value={bull} onChange={setBull} step={0.005} width="w-20" />
          <Param label="Bear" value={bear} onChange={setBear} step={0.005} width="w-20" />
          <Param label="Lookback" value={lookback} onChange={setLookback} width="w-24" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Selector rail */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-border/50 bg-background">
          <div className="border-b border-border/50 px-4 py-3">
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>
                {source === 'assets' && 'Assets'}
                {source === 'strategies' && 'Saved strategies'}
                {source === 'portfolios' && 'Portfolios'}
              </span>
              <span className="text-muted-foreground/60">{filteredSubjects.length}</span>
            </div>
            {source === 'assets' && (
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={assetFilter}
                  onChange={(e) => setAssetFilter(e.target.value)}
                  placeholder="Filter assets…"
                  className="h-8 pl-8 text-xs"
                />
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {assetsLoading && <div className="text-[11px] text-muted-foreground">Loading assets…</div>}

            <div className="space-y-1.5">
              {filteredSubjects.map((subject) => {
                const isSelected = selected.some((s) => s.id === subject.id)
                const hasResult = results.has(subject.id)
                return (
                  <button
                    key={subject.id}
                    type="button"
                    onClick={() => toggleSubject(subject)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-all',
                      isSelected
                        ? 'border-primary/50 bg-primary/[0.06] text-foreground shadow-sm'
                        : 'border-border/50 bg-background text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium">{subject.label}</div>
                      <div className="text-[10px] opacity-70">{subject.symbol}</div>
                    </div>
                    {hasResult && <TrendingUp className="ml-2 h-3.5 w-3.5 shrink-0 text-primary" />}
                  </button>
                )
              })}
            </div>

            {filteredSubjects.length === 0 && !assetsLoading && (
              <div className="py-8 text-center text-[11px] text-muted-foreground">
                {source === 'strategies' && 'No saved strategies yet.'}
                {source === 'portfolios' && 'No portfolios yet.'}
                {source === 'assets' && 'No assets match your filter.'}
              </div>
            )}
          </div>

          <div className="border-t border-border/50 p-3">
            <Notice tone="muted" className="text-[11px]">
              Observable Markov model: the next regime depends only on the current regime. Transition probabilities are
              re-estimated inside a rolling lookback window.
            </Notice>
          </div>
        </aside>

        {/* Main stage */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-muted/20 p-6">
          {error && <Notice tone="destructive" className="mb-4">{error}</Notice>}

          {hasDemoResults && (
            <div className="mb-4 rounded-lg border border-primary/20 bg-primary/[0.04] px-4 py-2.5 text-[12px] text-primary">
              Demo mode: live market data is unavailable for at least one selection, so a deterministic synthetic path
              is being used. Toggle “Demo data” to force this for every run.
            </div>
          )}

          {selected.length === 0 && !results.size && (
            <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border/50 bg-background shadow-sm">
                <BrainCircuit className="h-8 w-8 opacity-30" />
              </div>
              <p className="text-sm font-medium">Select instruments and run the regime model</p>
              <p className="mt-1 max-w-sm text-center text-[11px] opacity-70">
                Pick up to 6 assets, strategies or portfolios from the rail, or type a ticker above. The Markov engine
                will estimate the transition matrix and produce walk-forward signals.
              </p>
            </div>
          )}

          {active && (
            <div className="space-y-5">
              {selected.length > 1 && <ComparisonPanel selected={selected} results={results} />}

              <KpiOverview result={active} />

              <Panel title="3D transition graph" hint="Spatial view of regime transitions">
                <Markov3DGraph transition_matrix={active.transition_matrix} currentState={active.current_state} />
              </Panel>

              <div className="grid gap-5 lg:grid-cols-2">
                <TransitionMatrixPanel result={active} />
                <ForecastPanel result={active} />
              </div>

              <div className="grid gap-5 lg:grid-cols-3">
                <StationaryPanel result={active} />
                <BacktestPanel result={active} />
                <RegimeMixPanel result={active} />
              </div>

              <SignalHistoryPanel result={active} />
            </div>
          )}

          {selected.length === 0 && results.size === 1 && (
            <div className="space-y-5">
              <KpiOverview result={Array.from(results.values())[0]} />
              <div className="grid gap-5 lg:grid-cols-2">
                <TransitionMatrixPanel result={Array.from(results.values())[0]} />
                <ForecastPanel result={Array.from(results.values())[0]} />
              </div>
              <SignalHistoryPanel result={Array.from(results.values())[0]} />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function Param({
  label,
  value,
  onChange,
  step = 1,
  width,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  step?: number
  width?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('text-sm', width)}
      />
    </div>
  )
}

function getStateRow(result: MarkovAnalyzeResponse, state: string): Record<string, number> | null {
  const row = result.transition_matrix.find((r) => r.from === state)
  if (!row) return null
  return {
    Bull: (row.to.Bull ?? row.to.bull) || 0,
    Bear: (row.to.Bear ?? row.to.bear) || 0,
    Sideways: (row.to.Sideways ?? row.to.sideways) || 0,
  }
}

function KpiOverview({ result }: { result: MarkovAnalyzeResponse }) {
  const current = result.current_state
  const row = getStateRow(result, current)
  const stationary = result.stationary_distribution[current] ?? result.stationary_distribution[current.toLowerCase()] ?? null

  const persistence = row ? row[current] : 0
  const switching = 1 - persistence
  const recurrence = stationary && stationary > 0 ? 1 / stationary : null

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <KpiCard
        title="Current state"
        subtitle="Latest observable regime"
        accent={current === 'Bull' ? 'border-primary' : current === 'Bear' ? 'border-clay' : 'border-muted-foreground'}
        icon={Activity}
        value={
          <div
            className={cn(
              'text-4xl font-bold tracking-tight',
              current === 'Bull' && 'text-primary',
              current === 'Bear' && 'text-clay',
              current === 'Sideways' && 'text-muted-foreground',
            )}
          >
            {current}
          </div>
        }
      >
        <div className="space-y-1.5">
          {[
            { name: 'Bull', value: result.latest_signal.bull_prob ?? 0 },
            { name: 'Bear', value: result.latest_signal.bear_prob ?? 0 },
            { name: 'Sideways', value: result.latest_signal.sideways_prob ?? 0 },
          ].map((s) => (
            <div key={s.name} className="flex items-center gap-2 text-[11px]">
              <span
                className={cn(
                  'w-12 font-medium',
                  s.name === 'Bull' && 'text-primary',
                  s.name === 'Bear' && 'text-clay',
                )}
              >
                {s.name}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${s.value * 100}%`, backgroundColor: STATE_COLORS[s.name] }}
                />
              </div>
              <span className="w-10 text-right tnum text-muted-foreground">{fmtPct(s.value)}</span>
            </div>
          ))}
        </div>
      </KpiCard>

      <KpiCard
        title="Switching probability"
        subtitle="Chance to leave the current regime next step"
        accent="border-clay"
        icon={ArrowRightLeft}
        value={
          <div className={cn('text-4xl font-bold tracking-tight tnum', switching > 0.5 ? 'text-clay' : 'text-primary')}>
            {fmtPct(switching)}
          </div>
        }
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Stay in {current}</span>
            <span className="font-medium tnum">{fmtPct(persistence)}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: `${persistence * 100}%`, backgroundColor: STATE_COLORS[current] }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Switch</span>
            <span className="font-medium tnum text-clay">{fmtPct(switching)}</span>
          </div>
        </div>
      </KpiCard>

      <KpiCard
        title="Mean recurrence time"
        subtitle="Expected steps until return to current regime"
        accent="border-foreground"
        icon={Clock}
        value={
          <div className={cn('text-4xl font-bold tracking-tight tnum', recurrence == null && 'text-muted-foreground')}>
            {recurrence == null ? '∞' : `${recurrence.toFixed(0)}d`}
          </div>
        }
      >
        <div className="space-y-1.5">
          {Object.entries(result.stationary_distribution).map(([name, value]) => (
            <div key={name} className="flex items-center gap-2 text-[11px]">
              <span
                className={cn(
                  'w-12 font-medium capitalize',
                  name === 'Bull' && 'text-primary',
                  name === 'Bear' && 'text-clay',
                )}
              >
                {name}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(value ?? 0) * 100}%`, backgroundColor: STATE_COLORS[name] }}
                />
              </div>
              <span className="w-10 text-right tnum text-muted-foreground">{fmtPct(value ?? 0)}</span>
            </div>
          ))}
        </div>
      </KpiCard>
    </div>
  )
}

function KpiCard({
  title,
  subtitle,
  accent,
  icon: Icon,
  value,
  children,
}: {
  title: string
  subtitle: string
  accent: string
  icon: ComponentType<{ className?: string }>
  value: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl border border-border/50 bg-card p-4 shadow-sm', accent)}>
      <div className={cn('absolute left-0 top-0 h-1 w-full', accent.replace('border-', 'bg-'))} />
      <div className="flex items-start justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2">{value}</div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

function TransitionMatrixPanel({ result }: { result: MarkovAnalyzeResponse }) {
  return (
    <Panel title="Transition matrix" hint="P(next state | current state)" bodyClassName="p-0">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border/50 bg-foreground/[0.02] text-left text-muted-foreground">
            <th className="py-2.5 pl-4 pr-3 font-medium">From \ To</th>
            <th className="py-2.5 pr-3 font-medium">Bull</th>
            <th className="py-2.5 pr-3 font-medium">Bear</th>
            <th className="py-2.5 pr-4 font-medium">Sideways</th>
          </tr>
        </thead>
        <tbody>
          {result.transition_matrix.map((row) => (
            <tr key={row.from} className="border-b border-border/30">
              <td className="py-2.5 pl-4 pr-3 font-medium">
                <span className={cn('rounded px-1.5 py-0.5 text-[10px]', STATE_BG[row.from])}>{row.from}</span>
              </td>
              <td className="py-2.5 pr-3 tnum">{fmt(row.to.Bull ?? row.to.bull)}</td>
              <td className="py-2.5 pr-3 tnum">{fmt(row.to.Bear ?? row.to.bear)}</td>
              <td className="py-2.5 pr-4 tnum">{fmt(row.to.Sideways ?? row.to.sideways)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

function ForecastPanel({ result }: { result: MarkovAnalyzeResponse }) {
  return (
    <Panel title="Multi-step forecasts" hint="Chapman-Kolmogorov matrix powers">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border/50 text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Steps</th>
              <th className="py-2 pr-4 font-medium">Bull</th>
              <th className="py-2 pr-4 font-medium">Bear</th>
              <th className="py-2 pr-4 font-medium">Sideways</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(result.forecasts).map(([steps, probs]) => (
              <tr key={steps} className="border-b border-border/30">
                <td className="py-2 pr-4 font-medium tnum">{steps}</td>
                <td className="py-2 pr-4 tnum text-primary">{fmt(probs.bull)}</td>
                <td className="py-2 pr-4 tnum text-clay">{fmt(probs.bear)}</td>
                <td className="py-2 pr-4 tnum">{fmt(probs.sideways)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function StationaryPanel({ result }: { result: MarkovAnalyzeResponse }) {
  const data = Object.entries(result.stationary_distribution).map(([name, value]) => ({ name, value: value ?? 0 }))
  return (
    <Panel title="Stationary distribution" hint="Long-run regime proportions">
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
          <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tick={AXIS_TICK} />
          <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} domain={[0, 1]} />
          <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} contentStyle={tooltipStyle} formatter={(v: number) => [fmt(v), 'Probability']} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={STATE_COLORS[entry.name] ?? 'hsl(var(--primary))'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  )
}

function BacktestPanel({ result }: { result: MarkovAnalyzeResponse }) {
  const b = result.backtest
  return (
    <Panel title="Walk-forward backtest" hint="Position shifted one day forward" className="lg:col-span-1">
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Ann. return" value={b.annualized_return} fmt={(v) => `${(v * 100).toFixed(2)}%`} tone={v => v >= 0 ? 'primary' : 'clay'} />
        <Metric label="Sharpe" value={b.annualized_sharpe} fmt={(v) => v.toFixed(3)} />
        <Metric label="Max DD" value={b.max_drawdown} fmt={(v) => `${(v * 100).toFixed(2)}%`} tone={() => 'clay'} />
        <Metric label="Days" value={b.n_days} fmt={(v) => v.toLocaleString()} />
      </div>
      {result.equity_curve.length > 0 && (
        <ResponsiveContainer width="100%" height={130} className="mt-4">
          <LineChart data={result.equity_curve} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
            <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} tick={AXIS_TICK} />
            <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [v.toFixed(4), 'Equity']} />
            <ReferenceLine y={1} stroke="hsl(var(--border))" />
            <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Panel>
  )
}

function RegimeMixPanel({ result }: { result: MarkovAnalyzeResponse }) {
  const total = Object.values(result.regime_counts).reduce((s, v) => s + v, 0) || 1
  const data = Object.entries(result.regime_counts).map(([name, value]) => ({ name, value: (value / total) * 100 }))
  return (
    <Panel title="Regime mix" hint="Share of historical observations">
      <div className="space-y-3">
        {data.map((d) => (
          <div key={d.name}>
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="font-medium">{d.name}</span>
              <span className="tnum text-muted-foreground">{d.value.toFixed(1)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', d.name === 'Bull' && 'bg-primary', d.name === 'Bear' && 'bg-clay', d.name === 'Sideways' && 'bg-muted-foreground')}
                style={{ width: `${d.value}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function SignalHistoryPanel({ result }: { result: MarkovAnalyzeResponse }) {
  const data = result.signal_series
  return (
    <Panel title="Signal history" hint="Bull probability minus bear probability over time">
      {data.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No signal data.</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
            <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} tick={AXIS_TICK} />
            <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} domain={[-1, 1]} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [v.toFixed(3), 'Signal']} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <ReferenceLine y={0.3} stroke="hsl(var(--border) / 0.5)" strokeDasharray="4 4" />
            <ReferenceLine y={-0.3} stroke="hsl(var(--border) / 0.5)" strokeDasharray="4 4" />
            <Line type="monotone" dataKey="signal" stroke="hsl(var(--primary))" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Panel>
  )
}

function ComparisonPanel({
  selected,
  results,
}: {
  selected: Subject[]
  results: Map<string, MarkovAnalyzeResponse>
}) {
  return (
    <Panel title="Signal comparison" hint="Side-by-side across selections">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border/50 text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Symbol</th>
              <th className="py-2 pr-4 font-medium">Source</th>
              <th className="py-2 pr-4 font-medium">State</th>
              <th className="py-2 pr-4 font-medium">Signal</th>
              <th className="py-2 pr-4 font-medium">Position</th>
              <th className="py-2 pr-4 font-medium">Bull</th>
              <th className="py-2 pr-4 font-medium">Bear</th>
              <th className="py-2 pr-4 font-medium">Sharpe</th>
              <th className="py-2 pr-4 font-medium">Max DD</th>
              <th className="py-2 pr-4 font-medium">Ann. Return</th>
            </tr>
          </thead>
          <tbody>
            {selected.map((subject) => {
              const r = results.get(subject.id)
              if (!r) return null
              return (
                <tr key={subject.id} className="border-b border-border/30">
                  <td className="py-2 pr-4 font-medium">{subject.label}</td>
                  <td className="py-2 pr-4 tnum">{subject.symbol}</td>
                  <td className="py-2 pr-4">
                    <SourceBadge source={r.source} />
                  </td>
                  <td className="py-2 pr-4">
                    <StateBadge state={r.current_state} />
                  </td>
                  <td className={cn('py-2 pr-4 tnum font-medium', r.latest_signal.signal && r.latest_signal.signal > 0 ? 'text-primary' : 'text-clay')}>
                    {fmt(r.latest_signal.signal)}
                  </td>
                  <td className="py-2 pr-4">{positionLabel(r.latest_signal.position)}</td>
                  <td className="py-2 pr-4 tnum">{fmt(r.latest_signal.bull_prob)}</td>
                  <td className="py-2 pr-4 tnum">{fmt(r.latest_signal.bear_prob)}</td>
                  <td className="py-2 pr-4 tnum">{fmt(r.backtest.annualized_sharpe)}</td>
                  <td className="py-2 pr-4 tnum">
                    {r.backtest.max_drawdown == null ? '—' : `${(r.backtest.max_drawdown * 100).toFixed(1)}%`}
                  </td>
                  <td className="py-2 pr-4 tnum">
                    {r.backtest.annualized_return == null ? '—' : `${(r.backtest.annualized_return * 100).toFixed(2)}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function StateBadge({ state, large = false }: { state: string; large?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-2 py-0.5 font-medium',
        large ? 'text-sm' : 'text-[10px]',
        STATE_BG[state],
      )}
    >
      {state}
    </span>
  )
}

function SourceBadge({ source }: { source: string }) {
  const isDemo = source === 'demo'
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium',
        isDemo ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground',
      )}
    >
      {isDemo ? 'Demo' : 'Live'}
    </span>
  )
}

function Metric({
  label,
  value,
  fmt,
  tone,
}: {
  label: string
  value: number | null
  fmt: (v: number) => string
  tone?: (v: number) => 'primary' | 'clay' | 'muted'
}) {
  const v = value ?? null
  const color = v !== null && tone ? tone(v) : 'muted'
  return (
    <div className="rounded-lg border border-border/50 bg-background p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className={cn('mt-1 text-base font-medium tnum', color === 'primary' && 'text-primary', color === 'clay' && 'text-clay')}>
        {v == null ? '—' : fmt(v)}
      </div>
    </div>
  )
}

function positionLabel(position: number | null): string {
  if (position == null) return '—'
  if (position > 0.5) return 'Long'
  if (position < -0.5) return 'Short'
  return 'Flat'
}

function fmt(v: number | null): string {
  return v == null ? '—' : v.toFixed(4)
}

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

const tooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 11,
  fontFamily: FONT_FAMILY.mono,
}
