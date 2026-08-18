import { AlertTriangle, Check, RefreshCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { useReindex } from '@/hooks/useCatalog'
import {
  DATABASE_TABS, freshness, sourceBreakdown, sourceLabel, summaryLine, tabCount,
  type DatabaseTab,
} from '@/lib/catalog'
import type { CatalogSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * What is indexed, where it came from, and how fresh it is.
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
  const running = Boolean(job)

  const collections = DATABASE_TABS.filter((spec) => spec.kinds.length)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-sm text-muted-foreground">{summaryLine(summary)}</p>
        <Button size="sm" variant="outline" disabled={running} onClick={() => start()}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', running && 'animate-spin')} />
          {running ? 'Reindexing…' : 'Reindex'}
        </Button>
      </div>

      {job?.progress?.harvester && (
        <div className="text-[11px] text-muted-foreground">
          {job.progress.harvester} · {job.progress.done}/{job.progress.total}
        </div>
      )}

      {error && <Notice tone="destructive">{error}</Notice>}

      {!summary.indexed && (
        <Notice tone="muted" icon={false}>
          The index is derived from sources that all still exist — nothing is lost by it
          being empty. Press Reindex to build it.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {collections.map((spec) => {
          const count = tabCount(spec, summary.collections)
          const breakdown = spec.kinds.flatMap((kind) => {
            const collection = summary.collections.find((c) => c.kind === kind)
            return collection ? sourceBreakdown(collection) : []
          })
          return (
            <Card
              key={spec.tab}
              onClick={() => onOpenTab(spec.tab)}
              className="cursor-pointer transition-colors hover:border-border"
            >
              <CardContent className="space-y-2 p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{spec.label}</span>
                  <span className="text-lg tabular-nums">
                    {count.toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {breakdown.length ? breakdown.map((entry) => (
                    <Badge key={entry.value} variant="outline" font="sans" className="font-normal">
                      {sourceLabel(entry.value)} {entry.count.toLocaleString()}
                    </Badge>
                  )) : (
                    <span className="text-[11px] text-muted-foreground/70">
                      {spec.soon ? 'Not harvested yet' : 'Empty'}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div>
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Sources
        </div>
        <div className="overflow-hidden rounded-lg border border-border/50">
          <table className="w-full border-collapse text-left">
            <tbody>
              {summary.harvesters.map((harvester) => {
                const state = freshness(harvester.name, summary.harvests)
                return (
                  <tr key={harvester.name} className="border-b border-border/30 last:border-0">
                    <td className="px-3 py-2">
                      <div className="text-[12px]">{harvester.label}</div>
                      <div className="text-[10px] text-muted-foreground/70">
                        {harvester.name} · {sourceLabel(harvester.source)}
                        {harvester.remote && ' · remote'}
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
      </div>
    </div>
  )
}
