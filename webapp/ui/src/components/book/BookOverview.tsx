import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowUpRight, Briefcase, FolderKanban, Layers, Play,
  TrendingUp,
} from 'lucide-react'

import { Panel } from '@/components/ui/panel'
import { RosterStatTile } from '@/components/roster/RosterStatTile'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import type { Portfolio, Run, StoredStrategy } from '@/lib/api'
import { formatIsoDate } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

interface BookOverviewProps {
  portfolios: Portfolio[]
  strategies: StoredStrategy[]
  runs: Run[]
}

export function BookOverview({ portfolios, strategies, runs }: BookOverviewProps) {
  const totalHoldings = useMemo(
    () => portfolios.reduce((acc, p) => acc + p.holdings.length, 0),
    [portfolios],
  )

  const succeededRuns = useMemo(
    () => runs.filter((r) => r.status === 'succeeded'),
    [runs],
  )

  const latestRuns = useMemo(
    () => [...runs]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 5),
    [runs],
  )

  return (
    <div className="grid grid-cols-12 gap-4">
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={<Briefcase className="h-4 w-4" />}
        label="Portfolios"
        value={portfolios.length.toLocaleString()}
      />
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={<Layers className="h-4 w-4" />}
        label="Strategies"
        value={strategies.length.toLocaleString()}
      />
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={<FolderKanban className="h-4 w-4" />}
        label="Holdings"
        value={totalHoldings.toLocaleString()}
        hint="across all portfolios"
      />
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={<TrendingUp className="h-4 w-4" />}
        label="Finished runs"
        value={succeededRuns.length.toLocaleString()}
      />

      <div className="col-span-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <CollectionCard
          title="Portfolios"
          count={portfolios.length}
          href="/book?tab=portfolios"
          hint="asset allocation & NAV"
          icon={<Briefcase className="h-5 w-5" />}
          breakdown={[
            { label: 'with strategies', count: portfolios.filter((p) => p.strategy_ids.length > 0).length },
            { label: 'empty', count: portfolios.filter((p) => p.holdings.length === 0 && p.strategy_ids.length === 0).length },
          ]}
        />
        <CollectionCard
          title="Strategies"
          count={strategies.length}
          href="/book?tab=strategies"
          hint="saved model configs"
          icon={<Layers className="h-5 w-5" />}
          breakdown={[
            { label: 'custom features', count: strategies.filter((s) => s.features && s.features.length > 0).length },
            { label: 'handler default', count: strategies.filter((s) => !s.features || s.features.length === 0).length },
          ]}
        />
      </div>

      <div className="col-span-12 lg:col-span-5">
        <Panel title="Recent runs" hint="latest backtests & sweeps">
          {latestRuns.length === 0 ? (
            <div className="flex h-[140px] flex-col items-center justify-center gap-2 text-center">
              <Play className="h-6 w-6 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">No runs yet.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {latestRuns.map((run) => (
                <Link
                  key={run.id}
                  to={`/runs/${run.id}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.02]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <RunStatusIcon status={run.status} />
                    <div className="min-w-0">
                      <div className="truncate text-[12px]">{run.name}</div>
                      <div className="font-mono text-[10px] text-muted-foreground/70">
                        {run.model ?? '—'} · {run.universe ?? '—'}
                      </div>
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatIsoDate(run.created_at)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="col-span-12 lg:col-span-7">
        <Panel title="Quick links" hint="start here">
          <div className="grid gap-3 sm:grid-cols-2">
            <QuickLink
              to="/book?tab=portfolios"
              icon={<Briefcase className="h-4 w-4" />}
              label="Manage portfolios"
              description="View NAV curves, allocation and linked strategies."
            />
            <QuickLink
              to="/book?tab=strategies"
              icon={<Layers className="h-4 w-4" />}
              label="Browse strategies"
              description="Inspect saved strategies and open them in the builder."
            />
            <QuickLink
              to="/lab/database?tab=indicators"
              icon={<TrendingUp className="h-4 w-4" />}
              label="Find indicators"
              description="Search the indicator library and hand one to the builder."
            />
            <QuickLink
              to="/lab/ml-studio"
              icon={<Play className="h-4 w-4" />}
              label="Run in ML Studio"
              description="Sweep saved strategies across learners."
            />
          </div>
        </Panel>
      </div>
    </div>
  )
}

function CollectionCard({
  title, count, href, hint, icon, breakdown,
}: {
  title: string
  count: number
  href: string
  hint: string
  icon: React.ReactNode
  breakdown: { label: string; count: number }[]
}) {
  return (
    <Link to={href} className="text-left">
      <Panel
        title={title}
        hint={hint}
        className="h-full transition-shadow hover:shadow-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="tnum text-3xl font-semibold">{count.toLocaleString()}</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {breakdown.map((entry) => (
                <span
                  key={entry.label}
                  className="inline-flex items-center rounded-md border border-border/50 bg-foreground/[0.02] px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {entry.label} {entry.count.toLocaleString()}
                </span>
              ))}
            </div>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-foreground/[0.02] text-muted-foreground">
            {icon}
          </div>
        </div>
      </Panel>
    </Link>
  )
}

function QuickLink({
  to, icon, label, description,
}: {
  to: string
  icon: React.ReactNode
  label: string
  description: string
}) {
  return (
    <Link
      to={to}
      className={cn(
        'group flex items-start gap-3 rounded-lg border border-border/50 bg-foreground/[0.02] p-3 transition-colors',
        'hover:border-primary/30 hover:bg-foreground/[0.03]',
      )}
    >
      <div className="mt-0.5 text-muted-foreground transition-colors group-hover:text-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-sm font-medium">
          {label}
          <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </Link>
  )
}
