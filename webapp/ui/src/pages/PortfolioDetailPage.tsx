import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowUpRight, Landmark, Pencil, Plus, Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { AllocationDonut } from '@/components/portfolio/AllocationDonut'
import { HoldingsTable } from '@/components/portfolio/HoldingsTable'
import { NavChart } from '@/components/portfolio/NavChart'
import { PortfolioDialog } from '@/components/portfolio/PortfolioDialog'
import { usePortfolioNav, usePortfolios } from '@/hooks/usePortfolios'
import { formatIsoDate } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

export function PortfolioDetailPage() {
  const { portfolioId } = useParams<{ portfolioId: string }>()
  const navigate = useNavigate()
  const { portfolios, loading: listLoading, error: listError, save, remove } = usePortfolios()
  const [editing, setEditing] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const portfolio = portfolios.find((p) => p.id === portfolioId)

  if (listError) {
    return (
      <div className="p-6">
        <Notice tone="destructive">{listError}</Notice>
      </div>
    )
  }

  if (!portfolio && !listLoading) {
    return (
      <div className="p-6">
        <Notice tone="clay">Portfolio not found.</Notice>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate('/book')}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to book
        </Button>
      </div>
    )
  }

  if (!portfolio) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <>
      <PageHeader
        title={portfolio.name}
        description={`${portfolio.base_ccy} · benchmark ${portfolio.benchmark} · since ${formatIsoDate(portfolio.inception)} · ${portfolio.holdings.length} holdings · rebalance ${portfolio.rebalance}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/lab/database?tab=indicators">
                <Plus className="mr-1 h-3.5 w-3.5" /> Add indicator
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/macro?portfolio=${portfolio.id}`}>
                <Landmark className="mr-1 h-3.5 w-3.5" /> Macro desk
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setEditing(true); setDialogOpen(true) }}>
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Button>
            <Button
              variant={confirming ? 'destructive' : 'ghost'}
              size="sm"
              onClick={() => (confirming ? void handleDelete() : setConfirming(true))}
              onBlur={() => setConfirming(false)}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              {confirming ? 'Click again to delete' : 'Delete'}
            </Button>
          </div>
        }
      />

      <div className="p-6">
        {(portfolio.objective ?? '').trim() && (
          <p className="mb-2 max-w-3xl text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Objective:</span> {portfolio.objective}
          </p>
        )}
        {(portfolio.constraints ?? '').trim() && (
          <p className="mb-2 max-w-3xl text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Constraints:</span> {portfolio.constraints}
          </p>
        )}
        {portfolio.notes && (
          <p className="mb-5 max-w-2xl text-sm text-muted-foreground">{portfolio.notes}</p>
        )}

        <PortfolioBody portfolio={portfolio} />
      </div>

      <PortfolioDialog
        portfolio={editing ? portfolio : undefined}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={async (spec, id) => {
          await save(spec, id)
          setDialogOpen(false)
        }}
      />
    </>
  )

  async function handleDelete() {
    await remove(portfolio!.id)
    navigate('/book')
  }
}

function PortfolioBody({ portfolio }: { portfolio: import('@/lib/api').Portfolio }) {
  const { nav, strategies, error, loading } = usePortfolioNav(portfolio.id)
  const [showBenchmark, setShowBenchmark] = useState(true)
  const [showGross, setShowGross] = useState(false)

  if (error) {
    return <Notice tone="destructive">{error}</Notice>
  }

  if (!nav) {
    return <div className={cn('h-96 animate-subtle-pulse rounded-xl border border-border/50', loading && 'animate-subtle-pulse')} />
  }

  return (
    <div className={cn('space-y-5', loading && 'animate-subtle-pulse')}>
      {nav.unpriced.length > 0 && (
        <Notice tone="clay">
          {nav.unpriced.length} holding{nav.unpriced.length === 1 ? '' : 's'} could not be priced and{' '}
          {nav.unpriced.length === 1 ? 'is' : 'are'} excluded from this curve.
          <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
            {nav.unpriced.map((u) => (
              <li key={u.symbol}>{u.symbol} — {u.reason}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <MetricTile label="Total return" value={nav.metrics.total_return} percent />
        <MetricTile label="Annualised" value={nav.metrics.annualised_return} percent />
        <MetricTile label="Volatility" value={nav.metrics.annualised_vol} percent />
        <MetricTile label="Sharpe" value={nav.metrics.sharpe} digits={2} />
        <MetricTile label="Max drawdown" value={nav.metrics.max_drawdown} percent negative />
        <MetricTile label="Cost drag" value={nav.metrics.cost_drag} percent negative hint="Gross vs net curve" />
      </div>

      <Panel
        title="NAV"
        hint={`${formatIsoDate(nav.period.start)} → ${formatIsoDate(nav.period.end)} · ${nav.period.days.toLocaleString()} sessions · turnover ${nav.metrics.annual_turnover?.toFixed(2) ?? '—'}×/yr`}
        actions={
          <div className="flex items-center gap-4">
            <Toggle label="Benchmark" checked={showBenchmark} onChange={setShowBenchmark} />
            <Toggle label="Gross of costs" checked={showGross} onChange={setShowGross} />
          </div>
        }
      >
        <NavChart nav={nav} showBenchmark={showBenchmark} showGross={showGross} />
      </Panel>

      {nav.warnings.length > 0 && (
        <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
          {nav.warnings.map((w) => <li key={w}>· {w}</li>)}
        </ul>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_2fr]">
        <Panel title="Allocation">
          <AllocationDonut slices={nav.allocation} />
        </Panel>

        <Panel title="Holdings" bodyClassName="p-0 overflow-x-auto">
          <HoldingsTable rows={nav.contribution} />
        </Panel>
      </div>

      {portfolio.strategy_ids.length > 0 && (
        <Panel title="Linked strategies">
          <div className="space-y-1">
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
          </div>
        </Panel>
      )}
    </div>
  )
}

function MetricTile({
  label, value, digits = 2, percent, negative, hint,
}: {
  label: string
  value?: number | null
  digits?: number
  percent?: boolean
  negative?: boolean
  hint?: string
}) {
  const display = value == null || !Number.isFinite(value)
    ? '—'
    : percent
      ? `${(value * 100).toFixed(digits)}%`
      : value.toFixed(digits)

  const tone = value == null || !Number.isFinite(value)
    ? ''
    : negative
      ? 'text-clay'
      : value > 0
        ? 'text-primary'
        : value < 0
          ? 'text-clay'
          : ''

  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 shadow-sm">
      <div
        className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70"
        title={hint}
      >
        {label}
      </div>
      <div className={cn('tnum mt-1 text-xl font-semibold', tone)}>{display}</div>
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
