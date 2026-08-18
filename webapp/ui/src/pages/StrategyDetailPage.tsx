import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Brain, Calendar, Database, Landmark, Layers, Pencil, Play, Plus,
  SlidersHorizontal, Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { PageHeader } from '@/components/layout/PageHeader'
import { useStrategies } from '@/hooks/useStrategies'
import { api, type FeatureColumn, type StoredStrategy } from '@/lib/api'


export function StrategyDetailPage() {
  const { strategyId } = useParams<{ strategyId: string }>()
  const navigate = useNavigate()
  const { remove, getById } = useStrategies()

  const [strategy, setStrategy] = useState<StoredStrategy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!strategyId) return
    const fromList = getById(strategyId)
    if (fromList) {
      setStrategy(fromList)
      setLoading(false)
      return
    }
    setLoading(true)
    void api.getStrategy(strategyId)
      .then((s) => {
        setStrategy(s)
        setError(null)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Could not load strategy')
      })
      .finally(() => setLoading(false))
  }, [strategyId, getById])

  const featureCount = useMemo(
    () => strategy?.features?.length ?? 0,
    [strategy],
  )

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  }

  if (error) {
    return (
      <div className="p-6">
        <Notice tone="destructive">{error}</Notice>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate('/book?tab=strategies')}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to strategies
        </Button>
      </div>
    )
  }

  if (!strategy) {
    return (
      <div className="p-6">
        <Notice tone="clay">Strategy not found.</Notice>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate('/book?tab=strategies')}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to strategies
        </Button>
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title={strategy.name}
        description={`${strategy.model} · ${strategy.handler} · ${strategy.universe} · ${strategy.benchmark}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/lab/database?tab=indicators">
                <Plus className="mr-1 h-3.5 w-3.5" /> Add indicator
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/macro?strategy=${strategy.id}`}>
                <Landmark className="mr-1 h-3.5 w-3.5" /> Macro desk
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/lab/builder?strategy=${strategy.id}`}>
                <Pencil className="mr-1 h-3 w-3" /> Edit in builder
              </Link>
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
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 lg:col-span-4">
            <Panel title="Model & data">
              <dl className="space-y-2">
                <SpecRow icon={<Brain className="h-3.5 w-3.5" />} label="Model" value={strategy.model} />
                <SpecRow icon={<Layers className="h-3.5 w-3.5" />} label="Handler" value={strategy.handler} />
                <SpecRow icon={<Database className="h-3.5 w-3.5" />} label="Store" value={strategy.data_store} />
                <SpecRow icon={<SlidersHorizontal className="h-3.5 w-3.5" />} label="Universe" value={strategy.universe} />
                <SpecRow icon={<Landmark className="h-3.5 w-3.5" />} label="Benchmark" value={strategy.benchmark} />
              </dl>
            </Panel>
          </div>

          <div className="col-span-12 lg:col-span-4">
            <Panel title="Windows">
              <dl className="space-y-2">
                <SpecRow icon={<Calendar className="h-3.5 w-3.5" />} label="Train" value={`${strategy.train_start} → ${strategy.train_end}`} />
                <SpecRow icon={<Calendar className="h-3.5 w-3.5" />} label="Validation" value={`${strategy.valid_start} → ${strategy.valid_end}`} />
                <SpecRow icon={<Calendar className="h-3.5 w-3.5" />} label="Test" value={`${strategy.test_start} → ${strategy.test_end}`} />
              </dl>
            </Panel>
          </div>

          <div className="col-span-12 lg:col-span-4">
            <Panel title="Execution">
              <dl className="space-y-2">
                <SpecRow label="TopK" value={String(strategy.topk)} />
                <SpecRow label="Drop" value={String(strategy.n_drop)} />
                <SpecRow label="Open cost" value={`${(strategy.open_cost * 10000).toFixed(0)} bp`} />
                <SpecRow label="Close cost" value={`${(strategy.close_cost * 10000).toFixed(0)} bp`} />
                <SpecRow label="Min cost" value={`${(strategy.min_cost * 10000).toFixed(0)} bp`} />
                <SpecRow label="Limit threshold" value={strategy.limit_threshold == null ? '—' : String(strategy.limit_threshold)} />
              </dl>
            </Panel>
          </div>

          <div className="col-span-12">
            <Panel
              title="Signals"
              hint={featureCount === 0 ? 'handler default feature set' : `${featureCount} custom feature${featureCount === 1 ? '' : 's'} · ${strategy.feature_mode}`}
              actions={
                <Button variant="outline" size="sm" asChild>
                  <Link to="/lab/database?tab=indicators">
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add indicator
                  </Link>
                </Button>
              }
            >
              {featureCount === 0 ? (
                <div className="flex h-[120px] flex-col items-center justify-center gap-2 text-center">
                  <Layers className="h-6 w-6 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">Using the handler's default feature set.</p>
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/lab/database?tab=indicators">Browse indicators</Link>
                  </Button>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {strategy.features!.map((feature) => (
                    <FeatureCard key={feature.name} feature={feature} />
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div className="col-span-12">
            <Panel title="Runs" hint="backtests started from this strategy">
              <div className="flex h-[120px] flex-col items-center justify-center gap-2 text-center">
                <Play className="h-6 w-6 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">Run this strategy in ML Studio or the Strategy Builder.</p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/lab/ml-studio">ML Studio</Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/lab/builder?strategy=${strategy.id}`}>Strategy Builder</Link>
                  </Button>
                </div>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  )

  async function handleDelete() {
    await remove(strategy!.id)
    navigate('/book?tab=strategies')
  }
}

function SpecRow({
  icon, label, value,
}: {
  icon?: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </div>
      <span className="font-mono text-[11px]">{value}</span>
    </div>
  )
}

function FeatureCard({ feature }: { feature: FeatureColumn }) {
  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{feature.name}</span>
        </div>
      {feature.expression && (
        <code className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
          {feature.expression}
        </code>
      )}
    </div>
  )
}
