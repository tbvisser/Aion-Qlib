import { AlertTriangle, Check, CircleSlash, RefreshCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { sourceLabel } from '@/lib/catalog'
import {
  ROSTER_TABS, providerState, rosterBreakdown, rosterSummaryLine, rosterTabCount,
  type RosterTab,
} from '@/lib/roster'
import type { RegistrySummary } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * What the platform can do, where each piece comes from, and what is reachable.
 *
 * The Database's Overview answers "is the index fresh". This one answers a
 * harder question, because nothing here is stored: every row on screen is one
 * HTTP call away from vanishing. So the provider table is the point of the tab,
 * and it distinguishes three states rather than two — reachable, unreachable
 * but showing cached rows, and unreachable with nothing to show. A single red
 * dot for the last two would hide whether the numbers above are real.
 */
export function RosterOverview({
  summary, onRefresh, refreshing, onOpenTab,
}: {
  summary: RegistrySummary
  onRefresh: () => void
  refreshing: boolean
  onOpenTab: (tab: RosterTab) => void
}) {
  const collections = ROSTER_TABS.filter((spec) => spec.kinds.length)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-sm text-muted-foreground">{rosterSummaryLine(summary)}</p>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refreshing && 'animate-spin')} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {summary.degraded.length > 0 && (
        <Notice tone="clay">
          {summary.providers.filter((p) => p.error).map((p) => (
            <div key={p.name}>
              <span className="font-medium">{p.label}</span> — {providerState(p).detail}
            </div>
          ))}
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {collections.map((spec) => {
          const count = rosterTabCount(spec, summary.collections)
          const breakdown = spec.kinds.flatMap((kind) => {
            const collection = summary.collections.find((c) => c.kind === kind)
            return collection ? rosterBreakdown(collection) : []
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
                  <span className="font-mono text-lg tabular-nums">
                    {count.toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {breakdown.length ? breakdown.map((entry) => (
                    <Badge key={entry.value} variant="outline" className="font-normal">
                      {sourceLabel(entry.value)} {entry.count.toLocaleString()}
                    </Badge>
                  )) : (
                    <span className="text-[11px] text-muted-foreground/70">Unreachable</span>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          Backends
        </div>
        <div className="overflow-hidden rounded-lg border border-border/50">
          <table className="w-full border-collapse text-left">
            <tbody>
              {summary.providers.map((provider) => {
                const state = providerState(provider)
                return (
                  <tr key={provider.name} className="border-b border-border/30 last:border-0">
                    <td className="px-3 py-2">
                      <div className="text-[12px]">{provider.label}</div>
                      <div className="font-mono text-[10px] text-muted-foreground/70">
                        {provider.name} · {sourceLabel(provider.source)}
                        {provider.remote ? ' · over the network' : ' · in process'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-[11px]',
                          state.state === 'down' ? 'text-destructive'
                            : state.state === 'stale' ? 'text-clay'
                              : 'text-muted-foreground',
                        )}
                      >
                        {state.state === 'ok' ? <Check className="h-3 w-3" />
                          : state.state === 'stale' ? <AlertTriangle className="h-3 w-3" />
                            : <CircleSlash className="h-3 w-3" />}
                        {state.detail}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          {/* The one thing a live-federated page must say out loud, or someone
              will wonder why a service they just restarted has not appeared. */}
          Nothing here is stored. Each backend is re-read at most once every{' '}
          {summary.ttl_seconds} seconds; Refresh drops that cache.
        </p>
      </div>
    </div>
  )
}
