import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowUpRight, Landmark, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { MetricTile } from '@/components/MetricTile'
import { PageHeader } from '@/components/layout/PageHeader'
import { AllocationDonut } from '@/components/portfolio/AllocationDonut'
import { HoldingsTable } from '@/components/portfolio/HoldingsTable'
import { NavChart } from '@/components/portfolio/NavChart'
import { PortfolioDialog } from '@/components/portfolio/PortfolioDialog'
import { usePortfolioNav, usePortfolios } from '@/hooks/usePortfolios'
import { api, type Portfolio, type StoredStrategy } from '@/lib/api'
import { formatIsoDate } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

/**
 * Portfolios & Strategies.
 *
 * The rail carries both, which is why this lives at /book rather than being
 * called "Portfolios": the nav item has always promised both, and the
 * strategies half links out to the pages that already own them.
 */
export function PortfoliosPage() {
  const { portfolioId } = useParams()
  const navigate = useNavigate()
  const { portfolios, loading, error, save, remove } = usePortfolios()

  const [tab, setTab] = useState<'portfolios' | 'strategies'>('portfolios')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Portfolio | undefined>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [strategies, setStrategies] = useState<StoredStrategy[]>([])

  useEffect(() => {
    let cancelled = false
    void api.listStrategies()
      .then((r) => { if (!cancelled) setStrategies(r.strategies) })
      .catch(() => { if (!cancelled) setStrategies([]) })
    return () => { cancelled = true }
  }, [])

  const selectedId = portfolioId ?? portfolios[0]?.id ?? null
  const selected = portfolios.find((p) => p.id === selectedId) ?? null

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? portfolios.filter((p) => p.name.toLowerCase().includes(needle))
      : portfolios
  }, [portfolios, query])

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border/50">
        <div className="space-y-2 border-b border-border/50 p-3">
          <Segmented
            value={tab}
            options={[
              { value: 'portfolios', label: 'Portfolios' },
              { value: 'strategies', label: 'Strategies' },
            ]}
            onChange={(v) => setTab(v as typeof tab)}
            className="w-full"
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${tab}`}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <div className={cn('min-h-0 flex-1 overflow-y-auto', loading && 'animate-subtle-pulse')}>
          {tab === 'portfolios' ? (
            filtered.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">
                {portfolios.length === 0 ? 'No portfolios yet.' : 'No matches.'}
              </p>
            ) : filtered.map((portfolio) => (
              <button
                key={portfolio.id}
                type="button"
                data-testid={`portfolio-row-${portfolio.id}`}
                onClick={() => navigate(`/book/${portfolio.id}`)}
                className={cn(
                  'w-full border-b border-border/30 px-3 py-2 text-left transition-colors last:border-0',
                  portfolio.id === selectedId
                    ? 'bg-foreground/[0.07]'
                    : 'hover:bg-foreground/[0.04]',
                )}
              >
                <div className="truncate text-xs">{portfolio.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  <span>{portfolio.base_ccy}</span>
                  <span>·</span>
                  <span>{portfolio.holdings.length} holdings</span>
                  {portfolio.strategy_ids.length > 0 && (
                    <>
                      <span>·</span>
                      <span>{portfolio.strategy_ids.length} strategies</span>
                    </>
                  )}
                </div>
              </button>
            ))
          ) : (
            <StrategyList strategies={strategies} query={query} />
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageHeader
          title="Portfolios & Strategies"
          description="Real NAV from real bars, and the research behind it."
          actions={
            <Button
              size="sm"
              onClick={() => { setEditing(undefined); setDialogOpen(true) }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> New portfolio
            </Button>
          }
        />

        <div className="p-6 pt-0">
          {error ? (
            <Card className="border-destructive/40">
              <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
            </Card>
          ) : portfolios.length === 0 && !loading ? (
            <div className="rounded-xl border border-dashed border-border/60 p-10 text-center">
              <p className="text-sm text-muted-foreground">
                No portfolios yet. Create one, or run{' '}
                <code className="font-mono text-xs">
                  python -m webapp.scripts.seed_demo
                </code>{' '}
                for the demo book.
              </p>
            </div>
          ) : selected ? (
            <PortfolioDetail
              portfolio={selected}
              onEdit={() => { setEditing(selected); setDialogOpen(true) }}
              onDelete={async () => {
                await remove(selected.id)
                navigate('/book')
              }}
            />
          ) : null}
        </div>
      </div>

      <PortfolioDialog
        portfolio={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={async (spec, id) => {
          const saved = await save(spec, id)
          navigate(`/book/${saved.id}`)
        }}
      />
    </div>
  )
}

function StrategyList({ strategies, query }: { strategies: StoredStrategy[]; query: string }) {
  const needle = query.trim().toLowerCase()
  const rows = needle
    ? strategies.filter((s) => s.name.toLowerCase().includes(needle))
    : strategies

  if (!rows.length) {
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        {strategies.length === 0 ? 'No strategies saved yet.' : 'No matches.'}
      </p>
    )
  }
  return (
    <>
      {rows.map((strategy) => (
        <Link
          key={strategy.id}
          to={`/macro?strategy=${strategy.id}`}
          className="block border-b border-border/30 px-3 py-2 last:border-0 hover:bg-foreground/[0.04]"
        >
          <div className="truncate text-xs">{strategy.name}</div>
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {strategy.model} · {strategy.handler} · {strategy.universe}
          </div>
        </Link>
      ))}
    </>
  )
}

function PortfolioDetail({
  portfolio, onEdit, onDelete,
}: {
  portfolio: Portfolio
  onEdit: () => void
  onDelete: () => Promise<void>
}) {
  const { nav, strategies, error, loading } = usePortfolioNav(portfolio.id)
  const [showBenchmark, setShowBenchmark] = useState(true)
  const [showGross, setShowGross] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg">{portfolio.name}</h2>
          <p className="font-mono text-[11px] text-muted-foreground">
            {portfolio.base_ccy} · benchmark {portfolio.benchmark} ·{' '}
            since {formatIsoDate(portfolio.inception)} ·{' '}
            {portfolio.holdings.length} holdings · rebalance {portfolio.rebalance}
          </p>
          {portfolio.notes && (
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{portfolio.notes}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/macro?portfolio=${portfolio.id}`}
            className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Landmark className="h-3 w-3" /> Macro linkage
          </Link>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="mr-1 h-3 w-3" /> Edit
          </Button>
          <Button
            variant={confirming ? 'destructive' : 'ghost'}
            size="sm"
            onClick={() => (confirming ? void onDelete() : setConfirming(true))}
            onBlur={() => setConfirming(false)}
          >
            <Trash2 className="mr-1 h-3 w-3" />
            {confirming ? 'Click again to delete' : 'Delete'}
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : !nav ? (
        <div className="h-96 animate-subtle-pulse rounded-xl border border-border/50" />
      ) : (
        <div className={cn('space-y-5', loading && 'animate-subtle-pulse')}>
          {nav.unpriced.length > 0 && (
            <Card className="border-clay/40 bg-clay/5">
              <CardContent className="p-3 text-sm">
                <p className="font-medium">
                  {nav.unpriced.length} holding{nav.unpriced.length === 1 ? '' : 's'} could
                  not be priced and {nav.unpriced.length === 1 ? 'is' : 'are'} excluded from
                  this curve.
                </p>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {nav.unpriced.map((u) => (
                    <li key={u.symbol}>{u.symbol} — {u.reason}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
            <MetricTile label="Total return" value={nav.metrics.total_return} percent />
            <MetricTile label="Annualised" value={nav.metrics.annualised_return} percent />
            <MetricTile label="Volatility" value={nav.metrics.annualised_vol} percent />
            <MetricTile label="Sharpe" value={nav.metrics.sharpe} digits={2} />
            <MetricTile label="Max drawdown" value={nav.metrics.max_drawdown} percent negative />
            <MetricTile
              label="Cost drag"
              value={nav.metrics.cost_drag}
              percent
              negative
              hint="Difference between the gross and net curves"
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-sm">
                  NAV{nav.benchmark ? ` vs ${nav.benchmark}` : ''}
                </CardTitle>
                <div className="flex items-center gap-4">
                  <Toggle label="Benchmark" checked={showBenchmark} onChange={setShowBenchmark} />
                  <Toggle label="Gross of costs" checked={showGross} onChange={setShowGross} />
                </div>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground">
                {formatIsoDate(nav.period.start)} → {formatIsoDate(nav.period.end)} ·{' '}
                {nav.period.days.toLocaleString()} sessions ·{' '}
                turnover {nav.metrics.annual_turnover?.toFixed(2) ?? '—'}×/yr
              </p>
            </CardHeader>
            <CardContent>
              <NavChart nav={nav} showBenchmark={showBenchmark} showGross={showGross} />
            </CardContent>
          </Card>

          {nav.warnings.length > 0 && (
            <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
              {nav.warnings.map((w) => <li key={w}>· {w}</li>)}
            </ul>
          )}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_2fr]">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Allocation</CardTitle>
              </CardHeader>
              <CardContent>
                <AllocationDonut slices={nav.allocation} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Holdings</CardTitle>
              </CardHeader>
              <CardContent>
                <HoldingsTable rows={nav.contribution} />
              </CardContent>
            </Card>
          </div>

          {portfolio.strategy_ids.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Linked strategies</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {strategies.map((linked) => (
                  <div
                    key={linked.strategy_id}
                    className="flex items-center justify-between gap-2 border-b border-border/30 py-1.5 last:border-0"
                  >
                    <div className="min-w-0">
                      <span className="text-xs">
                        {linked.name ?? linked.strategy_id}
                      </span>
                      {linked.missing && (
                        <Badge variant="clay" className="ml-2">deleted</Badge>
                      )}
                      {linked.model && (
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                          {linked.model} · {linked.universe}
                        </span>
                      )}
                    </div>
                    {linked.latest_run ? (
                      <Link
                        to={`/runs/${linked.latest_run.id}`}
                        className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-primary hover:underline"
                      >
                        {linked.latest_run.status} <ArrowUpRight className="h-3 w-3" />
                      </Link>
                    ) : (
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        never run
                      </span>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

function Toggle({
  label, checked, onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
    </label>
  )
}
