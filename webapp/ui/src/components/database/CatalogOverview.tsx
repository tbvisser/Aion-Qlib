import {
  AlertTriangle, Boxes, Check, Clock, Database, RefreshCw, Server,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { RosterStatTile } from '@/components/roster/RosterStatTile'
import { SourceBreakdownChart } from '@/components/roster/SourceBreakdownChart'
import { useReindex } from '@/hooks/useCatalog'
import {
  DATABASE_TABS, freshness, sourceBreakdown, sourceLabel, summaryLine, tabCount,
  type DatabaseTab,
} from '@/lib/catalog'
import { formatRelativeStamp } from '@/lib/time'
import type { CatalogHarvester, CatalogHarvestRecord, CatalogSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * What is indexed, where it came from, and how fresh it is.
 *
 * Mirrors the Agents & Skills overview layout: stat tiles across the top,
 * collection cards with source-breakdown charts on one row at wide widths,
 * and a harvester status panel beside a recent-harvests panel.
 *
 * The one thing this page must not do is report a total and stop. The catalog
 * harvests from a dozen sources, several of them across the network, and a
 * source that failed keeps its previous rows rather than emptying — which is
 * the right behaviour and an invisible one. So every collection card states its
 * freshness explicitly, and a failed harvest is called degraded rather than
 * shown as a slightly older timestamp.
 */
export function CatalogOverview({
  summary, onReload, onOpenTab,
}: {
  summary: CatalogSummary
  onReload: () => void
  onOpenTab: (tab: DatabaseTab) => void
}) {
  const { job, error, start } = useReindex(onReload)
  const running = Boolean(job) || Boolean(summary.running_job)

  const collections = DATABASE_TABS.filter((spec) => spec.kinds.length)
  const sourceSet = new Set(
    summary.collections.flatMap((c) => Object.keys(c.sources)),
  )
  const degradedCount = summary.degraded.length

  return (
    <div className="grid grid-cols-12 gap-4">
      {error && (
        <div className="col-span-12">
          <Notice tone="destructive">{error}</Notice>
        </div>
      )}

      {!summary.indexed && (
        <div className="col-span-12">
          <Notice tone="muted" icon={false}>
            The index is derived from sources that all still exist — nothing is lost by it
            being empty. Press Reindex to build it.
          </Notice>
        </div>
      )}

      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={<Boxes className="h-4 w-4" />}
        label="Total items"
        value={summary.total.toLocaleString()}
      />
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={<Database className="h-4 w-4" />}
        label="Collections"
        value={summary.collections.length.toLocaleString()}
      />
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={<Server className="h-4 w-4" />}
        label="Sources"
        value={sourceSet.size.toLocaleString()}
      />
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={
          !summary.indexed || degradedCount > 0
            ? <AlertTriangle className="h-4 w-4" />
            : <Check className="h-4 w-4" />
        }
        label={
          !summary.indexed
            ? 'Index status'
            : degradedCount > 0
              ? 'Degraded'
              : 'All fresh'
        }
        value={
          !summary.indexed
            ? 'empty'
            : degradedCount > 0
              ? `${degradedCount}`
              : 'ok'
        }
        statusDot={
          !summary.indexed || degradedCount > 0
            ? degradedCount > 0 ? 'down' : 'warning'
            : 'ok'
        }
      />

      <div className="col-span-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {collections.map((spec) => {
          const count = tabCount(spec, summary.collections)
          const breakdown = spec.kinds.flatMap((kind) => {
            const collection = summary.collections.find((c) => c.kind === kind)
            return collection ? sourceBreakdown(collection) : []
          })
          const sources = breakdown.reduce<Record<string, number>>((acc, entry) => {
            acc[entry.value] = entry.count
            return acc
          }, {})

          return (
            <button
              key={spec.tab}
              type="button"
              onClick={() => onOpenTab(spec.tab)}
              className="text-left"
            >
              <Panel
                title={spec.label}
                hint={`${count.toLocaleString()} items`}
                className="h-full transition-shadow hover:shadow-card"
              >
                <div className="space-y-3">
                  <div className="tnum text-3xl font-semibold">{count.toLocaleString()}</div>
                  <div className="h-[120px]">
                    <SourceBreakdownChart sources={sources} height={120} />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {breakdown.length ? breakdown.map((entry) => (
                      <span
                        key={entry.value}
                        className="inline-flex items-center rounded-md border border-border/50 bg-foreground/[0.02] px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {sourceLabel(entry.value)} {entry.count.toLocaleString()}
                      </span>
                    )) : (
                      <span className="text-[11px] text-muted-foreground/70">
                        {spec.soon ? 'Not harvested yet' : 'Empty'}
                      </span>
                    )}
                  </div>
                </div>
              </Panel>
            </button>
          )
        })}
      </div>

      <div className="col-span-12 lg:col-span-5">
        <RecentHarvestsPanel harvesters={summary.harvesters} harvests={summary.harvests} />
      </div>

      <div className="col-span-12 lg:col-span-7">
        <HarvesterStatusPanel
          summary={summary}
          running={running}
          onReindex={() => start()}
        />
      </div>

      <div className="col-span-12">
        <p className="text-[11px] text-muted-foreground/70">
          {summaryLine(summary)}
        </p>
      </div>
    </div>
  )
}

function RecentHarvestsPanel({
  harvesters, harvests,
}: {
  harvesters: CatalogHarvester[]
  harvests: CatalogHarvestRecord[]
}) {
  const sorted = [...harvesters]
    .map((harvester) => {
      const latest = [...harvests]
        .filter((r) => r.harvester === harvester.name)
        .sort(
          (a, b) =>
            new Date(b.finished_at ?? b.started_at).getTime() -
            new Date(a.finished_at ?? a.started_at).getTime(),
        )[0]
      return { ...harvester, latest }
    })
    .filter((h): h is typeof h & { latest: CatalogHarvestRecord } => Boolean(h.latest))
    .sort(
      (a, b) =>
        new Date(b.latest.finished_at ?? b.latest.started_at).getTime() -
        new Date(a.latest.finished_at ?? a.latest.started_at).getTime(),
    )

  return (
    <Panel title="Recent harvests" hint="when each source was last indexed">
      {sorted.length === 0 ? (
        <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
          No harvest history yet.
        </div>
      ) : (
        <div className="space-y-1">
          {sorted.map((harvester) => (
            <div
              key={harvester.name}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.02]"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <div className="min-w-0">
                  <div className="truncate text-[12px]">{harvester.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground/70">
                    {harvester.name} · {sourceLabel(harvester.source)}
                    {harvester.remote ? ' · remote' : ' · local'}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    harvester.latest.error
                      ? 'bg-destructive'
                      : 'bg-emerald-500',
                  )}
                />
                <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                  {formatRelativeStamp(harvester.latest.finished_at ?? harvester.latest.started_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function HarvesterStatusPanel({
  summary, running, onReindex,
}: {
  summary: CatalogSummary
  running: boolean
  onReindex: () => void
}) {
  const progress = summary.running_job?.progress

  return (
    <Panel
      title="Sources"
      hint="harvester status"
      actions={(
        <Button size="sm" variant="outline" disabled={running} onClick={onReindex}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', running && 'animate-spin')} />
          {running ? 'Reindexing…' : 'Reindex'}
        </Button>
      )}
    >
      {running && progress?.harvester && (
        <div className="mb-2 text-[11px] text-muted-foreground">
          {progress.harvester} · {progress.done}/{progress.total}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border/50">
        <table className="w-full border-collapse text-left">
          <tbody>
            {summary.harvesters.map((harvester) => {
              const state = freshness(harvester.name, summary.harvests)
              return (
                <tr key={harvester.name} className="border-b border-border/30 last:border-0">
                  <td className="px-3 py-2">
                    <div className="text-[12px]">{harvester.label}</div>
                    <div className="font-mono text-[10px] text-muted-foreground/70">
                      {harvester.name} · {sourceLabel(harvester.source)}
                      {harvester.remote ? ' · remote' : ' · local'}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-[11px]',
                        state.state === 'degraded' ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {state.state === 'degraded'
                        ? <AlertTriangle className="h-3 w-3" />
                        : state.state === 'ok' ? <Check className="h-3 w-3" /> : null}
                      {state.detail}
                    </span>
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
