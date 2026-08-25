import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, BrainCircuit, Database, Dices, Plus, Sparkles, TrendingUp } from 'lucide-react'

import { MacdIndicator } from '@/components/indicators/MacdIndicator'
import { MarkovIndicator } from '@/components/indicators/MarkovIndicator'
import { MonteCarloIndicator } from '@/components/indicators/MonteCarloIndicator'
import { RsiIndicator } from '@/components/indicators/RsiIndicator'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { cn } from '@/lib/utils'

export type IndicatorTab = 'overview' | 'markov' | 'rsi' | 'macd' | 'monte-carlo'

interface TabSpec {
  tab: IndicatorTab
  label: string
  soon?: boolean
}

const INDICATOR_TABS: readonly TabSpec[] = [
  { tab: 'overview', label: 'Overview' },
  { tab: 'markov', label: 'Markov' },
  { tab: 'rsi', label: 'RSI' },
  { tab: 'macd', label: 'MACD' },
  { tab: 'monte-carlo', label: 'Monte Carlo' },
]

const TAB_KEYS = new Set(INDICATOR_TABS.map((t) => t.tab))

export function tabFromParam(raw: string | null | undefined): IndicatorTab {
  return raw && TAB_KEYS.has(raw as IndicatorTab) ? (raw as IndicatorTab) : 'overview'
}

/**
 * Indicators workspace: a single page where users create, browse and run
 * quantitative indicators. Each indicator gets its own sub-tab in `?tab=`.
 *
 * The page is separate from the Database's "Indicators" catalog tab, but links
 * to it so built indicators can be stored and discovered alongside alphas.
 */
export function IndicatorsPage() {
  const [params, setParams] = useSearchParams()
  const tab = tabFromParam(params.get('tab'))
  const [showCreate, setShowCreate] = useState(false)

  const setTab = useCallback(
    (next: IndicatorTab) => {
      setParams(
        (prev) => {
          const updated = new URLSearchParams(prev)
          updated.set('tab', next)
          return updated
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const options = useMemo(
    () =>
      INDICATOR_TABS.map((spec) => ({
        value: spec.tab,
        label: spec.label,
        title: spec.soon ? `${spec.label} — coming soon` : undefined,
      })),
    [],
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Indicators"
        description="Build and run quantitative indicators. Each indicator is its own tab; results can be saved to the database catalog."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setShowCreate((s) => !s)}>
            <Plus className="h-3.5 w-3.5" />
            Create indicator
          </Button>
        }
      />

      <div className="shrink-0 border-b border-border/50 bg-background/80 px-6 py-3 backdrop-blur">
        <Segmented value={tab} options={options} onChange={setTab} buttonClassName="font-sans" />
      </div>

      {showCreate && tab === 'overview' && (
        <div className="shrink-0 border-b border-border/50 bg-muted/30 px-6 py-3">
          <CreateIndicatorPrompt
            onMarkov={() => setTab('markov')}
            onRsi={() => setTab('rsi')}
            onMacd={() => setTab('macd')}
            onMonteCarlo={() => setTab('monte-carlo')}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/20">
        {tab === 'overview' && (
          <OverviewTab
            onOpenMarkov={() => setTab('markov')}
            onOpenRsi={() => setTab('rsi')}
            onOpenMacd={() => setTab('macd')}
            onOpenMonteCarlo={() => setTab('monte-carlo')}
          />
        )}
        {tab === 'markov' && <MarkovIndicator />}
        {tab === 'rsi' && <RsiIndicator />}
        {tab === 'macd' && <MacdIndicator />}
        {tab === 'monte-carlo' && <MonteCarloIndicator />}
      </div>
    </div>
  )
}

function OverviewTab({
  onOpenMarkov,
  onOpenRsi,
  onOpenMacd,
  onOpenMonteCarlo,
}: {
  onOpenMarkov: () => void
  onOpenRsi: () => void
  onOpenMacd: () => void
  onOpenMonteCarlo: () => void
}) {
  return (
    <div className="p-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <IndicatorCard
          title="Markov Chain Regime Analyzer"
          description="Estimate regime transition probabilities and produce walk-forward bull/bear/flat signals."
          icon={<BrainCircuit className="h-5 w-5" />}
          action="Open Markov"
          onClick={onOpenMarkov}
        />
        <IndicatorCard
          title="RSI"
          description="Relative Strength Index — momentum oscillator measuring speed and magnitude of price moves."
          icon={<Activity className="h-5 w-5" />}
          action="Open RSI"
          onClick={onOpenRsi}
        />
        <IndicatorCard
          title="MACD"
          description="Moving Average Convergence Divergence — trend-following momentum indicator."
          icon={<TrendingUp className="h-5 w-5" />}
          action="Open MACD"
          onClick={onOpenMacd}
        />
        <IndicatorCard
          title="Monte Carlo"
          description="Project forward price paths and probability cones via geometric Brownian motion."
          icon={<Dices className="h-5 w-5" />}
          action="Open Monte Carlo"
          onClick={onOpenMonteCarlo}
        />
        <IndicatorCard
          title="Create a new indicator"
          description="Add a custom indicator built from expressions, regime rules or external data."
          icon={<Plus className="h-5 w-5" />}
          action="Coming soon"
          soon
        />
        <a
          href="/lab/database?tab=indicators"
          className="group flex flex-col justify-between rounded-xl border border-border/50 bg-card p-4 shadow-sm transition-colors hover:border-border hover:bg-muted/30"
        >
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-medium">Indicator catalog</h3>
              <p className="mt-1 text-label text-muted-foreground">
                Browse saved indicators in the database — alphas, operators and stored factor expressions.
              </p>
            </div>
            <Database className="h-5 w-5 text-muted-foreground transition-colors group-hover:text-foreground" />
          </div>
          <span className="mt-4 inline-flex items-center gap-1 text-label font-medium text-primary">
            Open database <Sparkles className="h-3 w-3" />
          </span>
        </a>
      </div>
    </div>
  )
}

function IndicatorCard({
  title,
  description,
  icon,
  action,
  onClick,
  soon,
}: {
  title: string
  description: string
  icon: ReactNode
  action: string
  onClick?: () => void
  soon?: boolean
}) {
  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      onClick={onClick}
      className={cn(
        'flex flex-col justify-between rounded-xl border border-border/50 bg-card p-4 shadow-sm',
        onClick && 'cursor-pointer transition-colors hover:border-border hover:bg-muted/30',
        soon && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-1 text-label text-muted-foreground">{description}</p>
        </div>
        <div className="text-muted-foreground">{icon}</div>
      </div>
      <span
        className={cn(
          'mt-4 inline-flex items-center gap-1 text-label font-medium',
          soon ? 'text-muted-foreground' : 'text-primary',
        )}
      >
        {action}
      </span>
    </Wrapper>
  )
}

function CreateIndicatorPrompt({
  onMarkov,
  onRsi,
  onMacd,
  onMonteCarlo,
}: {
  onMarkov: () => void
  onRsi: () => void
  onMacd: () => void
  onMonteCarlo: () => void
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">Choose an indicator type to start from.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onMarkov}>
          Markov regime
        </Button>
        <Button size="sm" variant="outline" onClick={onRsi}>
          RSI
        </Button>
        <Button size="sm" variant="outline" onClick={onMacd}>
          MACD
        </Button>
        <Button size="sm" variant="outline" onClick={onMonteCarlo}>
          Monte Carlo
        </Button>
        <Button size="sm" variant="outline" disabled>
          Custom expression
        </Button>
      </div>
    </div>
  )
}

