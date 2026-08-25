import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, CandlestickChart, BarChart3, LineChart, AreaChart, Activity,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { PriceChart, type ChartType } from '@/components/PriceChart'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Notice } from '@/components/ui/notice'
import type { SegmentedOption } from '@/components/ui/segmented'
import { api, type AssetClassKey, type Bar, type Instrument } from '@/lib/api'
import { useHealth } from '@/hooks/useHealth'
import { cn } from '@/lib/utils'
import { DataSourcesPanel } from '@/components/markets/DataSourcesPanel'
import { ChartOverlaysPanel } from '@/components/markets/ChartOverlaysPanel'
import { useChartOverlays } from '@/hooks/useChartOverlays'

const RANGES = [
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
  { label: '5Y', days: 365 * 5 },
  { label: 'Max', days: 0 },
] as const

const CHART_TYPES: readonly SegmentedOption<ChartType>[] = [
  { value: 'candles', label: '', icon: CandlestickChart, title: 'Candles' },
  { value: 'bars', label: '', icon: BarChart3, title: 'OHLC Bars' },
  { value: 'line', label: '', icon: LineChart, title: 'Line' },
  { value: 'area', label: '', icon: AreaChart, title: 'Area' },
  { value: 'heikin-ashi', label: '', icon: Activity, title: 'Heikin-Ashi' },
]

const CLASS_LABELS: Record<AssetClassKey, string> = {
  equity: 'Equities',
  etf: 'ETFs',
  crypto: 'Crypto',
  fx: 'FX',
  index: 'Indices',
}
const CLASS_ORDER: AssetClassKey[] = ['equity', 'etf', 'crypto', 'fx', 'index']

/** How many rows we render. Beyond this the list stops being browsable anyway. */
const PAGE = 200

function startFor(days: number, floor?: string): string | undefined {
  if (!days) return floor
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

export function MarketsPage() {
  const { health } = useHealth(0)
  const [classes, setClasses] = useState<{ asset_class: AssetClassKey; count: number }[]>([])
  const [activeClass, setActiveClass] = useState<AssetClassKey | ''>('')
  const [rows, setRows] = useState<Instrument[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Instrument | null>(null)
  const [bars, setBars] = useState<Bar[]>([])
  const [rangeDays, setRangeDays] = useState<number>(365)
  const [adjusted, setAdjusted] = useState(false)
  const [chartType, setChartType] = useState<ChartType>('candles')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rangeStart = useMemo(
    () => startFor(rangeDays, health?.qlib.start_date),
    [rangeDays, health?.qlib.start_date],
  )

  useEffect(() => {
    api.assetClasses()
      .then((r) => setClasses(r.classes.slice().sort(
        (a, b) => CLASS_ORDER.indexOf(a.asset_class) - CLASS_ORDER.indexOf(b.asset_class),
      )))
      .catch(() => setClasses([]))
  }, [])

  // Debounced, race-guarded search. The previous page fired an un-cancelled
  // request per keystroke, so a slow early response could overwrite a newer one.
  const reqId = useRef(0)
  useEffect(() => {
    const mine = ++reqId.current
    const timer = window.setTimeout(() => {
      api.instruments({ search, asset_class: activeClass, limit: PAGE })
        .then((r) => {
          if (mine !== reqId.current) return
          setRows(r.instruments)
          setTotal(r.total)
          // Re-select when the current pick falls out of the filtered list, so
          // the chart can never show a symbol the list doesn't contain.
          setSelected((prev) =>
            prev && r.instruments.some((i) => i.symbol === prev.symbol)
              ? prev
              : r.instruments[0] ?? null,
          )
        })
        .catch((e) => { if (mine === reqId.current) setError(e.message) })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [search, activeClass])

  const loadBars = useCallback(async () => {
    if (!selected) return
    setLoading(true)
    setError(null)
    try {
      const r = await api.bars(selected.symbol, {
        start: rangeStart,
        adjusted: selected.store === 'qlib' ? adjusted : undefined,
      })
      setBars(r.bars)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load bars')
      setBars([])
    } finally {
      setLoading(false)
    }
  }, [selected, rangeStart, adjusted])

  useEffect(() => { void loadBars() }, [loadBars])

  const {
    library,
    libraryLoading,
    groupedRuns,
    runsLoading,
    selectedIndicators,
    selectedRuns,
    indicatorData,
    signals,
    dataLoading: overlaysLoading,
    error: overlaysError,
    toggleIndicator,
    toggleRun,
  } = useChartOverlays(selected?.symbol ?? '', rangeStart, selected?.store ?? 'market')

  const stats = useMemo(() => summarise(bars), [bars])
  const backtestable = selected?.store === 'qlib'
  const overlayDisabled = selected?.store !== 'qlib'

  return (
    <>
      <PageHeader
        title="Markets"
        description="Browse equities, ETFs, crypto, FX and indices — search by ticker or name."
      />

      <div className="flex min-h-0 flex-1">
        {/* Instrument rail */}
        <div className="flex w-72 shrink-0 flex-col border-r border-border/50">
          <div className="flex flex-wrap gap-1 border-b border-border/50 px-3 pb-2 pt-3">
            <ClassTab label="All" active={activeClass === ''} onClick={() => setActiveClass('')} />
            {classes.map((c) => (
              <ClassTab
                key={c.asset_class}
                label={CLASS_LABELS[c.asset_class] ?? c.asset_class}
                count={c.count}
                active={activeClass === c.asset_class}
                onClick={() => setActiveClass(c.asset_class)}
              />
            ))}
          </div>

          <div className="border-b border-border/50 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ticker or name"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {rows.map((item) => (
              <button
                key={`${item.asset_class}:${item.symbol}`}
                onClick={() => setSelected(item)}
                className={cn(
                  'block w-full rounded-md px-2.5 py-1.5 text-left transition-colors',
                  item.symbol === selected?.symbol
                    ? 'bg-foreground/[0.07] text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
                )}
              >
                <div className="font-mono text-xs">{item.symbol}</div>
                <div className="truncate text-label text-muted-foreground/70">{item.name}</div>
              </button>
            ))}
            {!rows.length && (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">No matches.</p>
            )}
          </div>

          {/* Truncation is stated, not hidden — the old page silently capped at 300. */}
          {total > rows.length && (
            <div className="border-t border-border/50 px-3 py-2 font-mono text-micro text-muted-foreground/70">
              showing {rows.length.toLocaleString()} of {total.toLocaleString()} — refine search
            </div>
          )}
        </div>

        {/* Chart */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
          {/* Header */}
          <div className="mb-2 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">
                {selected?.symbol ?? '—'}
              </h2>
              <p className="truncate text-sm text-foreground/80">{selected?.name}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {backtestable && (
                <Segmented
                  value={adjusted ? 'adjusted' : 'raw'}
                  options={[
                    { value: 'raw', label: 'Raw' },
                    { value: 'adjusted', label: 'Adjusted' },
                  ]}
                  onChange={(v) => setAdjusted(v === 'adjusted')}
                />
              )}

              <Segmented
                value={(RANGES.find((r) => r.days === rangeDays) ?? RANGES[0]).label}
                options={RANGES.map((r) => ({ value: r.label, label: r.label }))}
                onChange={(label) => {
                  const range = RANGES.find((r) => r.label === label)
                  if (range) setRangeDays(range.days)
                }}
              />

              <Segmented<ChartType>
                size="sm"
                value={chartType}
                options={CHART_TYPES}
                onChange={setChartType}
              />
            </div>
          </div>

          {/* Subtitle / quick stats */}
          <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="text-label text-muted-foreground">
              {!selected
                ? 'Select an instrument'
                : selected.store === 'market'
                  ? `${CLASS_LABELS[selected.asset_class]} — chart only`
                  : adjusted
                    ? 'Back-adjusted · model price'
                    : 'Raw traded price'}
            </p>
            {stats && (
              <div className="ml-auto flex flex-wrap items-center gap-3 font-mono text-label">
                <span className="text-muted-foreground/60">Last</span>
                <span className="tnum">{stats.last}</span>
                <span className={cn('tnum', stats.returnTone === 'up' && 'text-primary', stats.returnTone === 'down' && 'text-clay')}>
                  {stats.periodReturn}
                </span>
                <span className="text-muted-foreground/60">σ</span>
                <span className="tnum">{stats.vol}</span>
              </div>
            )}
          </div>

          {(error || overlaysError) && (
            <Notice tone="destructive" className="mb-3 shrink-0">
              {error ?? overlaysError}
            </Notice>
          )}

          {/* Chart fills remaining height */}
          <Card className="flex min-h-[300px] flex-1 flex-col">
            <CardContent className={cn('flex min-h-0 flex-1 p-1', (loading || overlaysLoading) && 'animate-subtle-pulse')}>
              {bars.length ? (
                <PriceChart
                  bars={bars}
                  chartType={chartType}
                  indicators={indicatorData}
                  signals={signals}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {loading ? 'Loading…' : 'No bars for this range.'}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Bottom studies drawer */}
          <div className="mt-3 shrink-0 space-y-3">
            {overlayDisabled && selected && (
              <p className="text-label text-muted-foreground">
                Indicators and model signals are only available for qlib-backed instruments.
              </p>
            )}
            <ChartOverlaysPanel
              library={library}
              libraryLoading={libraryLoading}
              groupedRuns={groupedRuns}
              runsLoading={runsLoading}
              selectedIndicators={selectedIndicators}
              selectedRuns={selectedRuns}
              onToggleIndicator={toggleIndicator}
              onToggleRun={toggleRun}
              disabled={overlayDisabled}
            />
            <DataSourcesPanel />
          </div>
        </div>
      </div>
    </>
  )
}

function ClassTab({
  label, count, active, onClick,
}: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full px-2.5 py-1 text-label font-medium transition-colors',
        active
          ? 'bg-foreground/[0.07] text-foreground'
          : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
      )}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1 font-mono text-micro text-muted-foreground/60">{count}</span>
      )}
    </button>
  )
}

function summarise(bars: Bar[]) {
  const closes = bars.map((b) => b.close).filter((c): c is number => c != null)
  if (closes.length < 2) return null

  const first = closes[0]
  const last = closes[closes.length - 1]
  const ret = last / first - 1

  const rets = bars.map((b) => b.change).filter((c): c is number => c != null)
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1)
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)
  const vol = Math.sqrt(variance * 252)

  return {
    last: last < 1 ? last.toPrecision(4) : last.toLocaleString(undefined, { maximumFractionDigits: 2 }),
    periodReturn: `${(ret * 100).toFixed(1)}%`,
    returnTone: (ret >= 0 ? 'up' : 'down') as 'up' | 'down',
    vol: `${(vol * 100).toFixed(1)}%`,
    count: String(bars.length),
  }
}
