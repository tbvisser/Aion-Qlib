import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { PriceChart } from '@/components/PriceChart'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, type AssetClassKey, type Bar, type Instrument } from '@/lib/api'
import { useHealth } from '@/hooks/useHealth'
import { cn } from '@/lib/utils'
import { DataSourcesPanel } from '@/components/markets/DataSourcesPanel'

const RANGES = [
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
  { label: '5Y', days: 365 * 5 },
  { label: 'Max', days: 0 },
] as const

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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        start: startFor(rangeDays, health?.qlib.start_date),
        adjusted: selected.store === 'qlib' ? adjusted : undefined,
      })
      setBars(r.bars)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load bars')
      setBars([])
    } finally {
      setLoading(false)
    }
  }, [selected, rangeDays, adjusted, health?.qlib.start_date])

  useEffect(() => { void loadBars() }, [loadBars])

  const stats = useMemo(() => summarise(bars), [bars])
  const backtestable = selected?.store === 'qlib'

  return (
    <>
      <PageHeader
        title="Markets"
        description="Browse equities, ETFs, crypto, FX and indices — search by ticker or name."
        actions={
          backtestable && (
            <div className="flex items-center gap-1 rounded-lg border border-border/50 p-0.5">
              {(['Raw', 'Adjusted'] as const).map((label, i) => (
                <button
                  key={label}
                  onClick={() => setAdjusted(i === 1)}
                  className={cn(
                    'rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors',
                    adjusted === (i === 1)
                      ? 'bg-foreground/[0.07] text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )
        }
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
                <div className="truncate text-[11px] text-muted-foreground/70">{item.name}</div>
              </button>
            ))}
            {!rows.length && (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">No matches.</p>
            )}
          </div>

          {/* Truncation is stated, not hidden — the old page silently capped at 300. */}
          {total > rows.length && (
            <div className="border-t border-border/50 px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
              showing {rows.length.toLocaleString()} of {total.toLocaleString()} — refine search
            </div>
          )}
        </div>

        {/* Chart */}
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-mono text-xl font-semibold tracking-tight">
                {selected?.symbol ?? '—'}
              </h2>
              <p className="truncate text-sm text-foreground/80">{selected?.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {!selected
                  ? ''
                  : selected.store === 'market'
                    ? `${CLASS_LABELS[selected.asset_class]} — as traded. Charting only: not available to factors or backtests.`
                    : adjusted
                      ? 'Back-adjusted and rebased — the series a model trains on.'
                      : 'Raw traded price ($close / $factor).'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/50 p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.label}
                  onClick={() => setRangeDays(r.days)}
                  className={cn(
                    'rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors',
                    rangeDays === r.days
                      ? 'bg-foreground/[0.07] text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <Card className="mb-4 border-destructive/40">
              <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
            </Card>
          )}

          {stats && (
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Last" value={stats.last} />
              <Stat label="Period return" value={stats.periodReturn} tone={stats.returnTone} />
              <Stat label="Ann. vol" value={stats.vol} />
              <Stat label="Bars" value={stats.count} />
            </div>
          )}

          <Card>
            <CardContent className={cn('p-2', loading && 'animate-subtle-pulse')}>
              {bars.length ? (
                <PriceChart bars={bars} />
              ) : (
                <div className="py-24 text-center text-sm text-muted-foreground">
                  {loading ? 'Loading…' : 'No bars for this range.'}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="mt-4">
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
        'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'bg-foreground/[0.07] text-foreground'
          : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
      )}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1 font-mono text-[10px] text-muted-foreground/60">{count}</span>
      )}
    </button>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      <div
        className={cn(
          'tnum font-mono text-lg',
          tone === 'up' && 'text-primary',
          tone === 'down' && 'text-clay',
        )}
      >
        {value}
      </div>
    </div>
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
