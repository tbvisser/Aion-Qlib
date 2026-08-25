import { AlertTriangle, Boxes, Check, Clock, Database, Server } from 'lucide-react'

import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { RosterStatTile } from '@/components/roster/RosterStatTile'
import { SourceBreakdownChart } from '@/components/roster/SourceBreakdownChart'
import { ProviderStatusPanel } from '@/components/roster/ProviderStatusPanel'
import { sourceLabel } from '@/lib/catalog'
import { formatRelativeStamp } from '@/lib/time'
import {
  ROSTER_TABS, rosterBreakdown, rosterSummaryLine, rosterTabCount,
  type RosterTab,
} from '@/lib/roster'
import type { RegistrySummary, RegistryProvider } from '@/lib/api'
import { cn } from '@/lib/utils'

export function RosterOverview({
  summary, onRefresh, refreshing, onOpenTab,
}: {
  summary: RegistrySummary
  onRefresh: () => void
  refreshing: boolean
  onOpenTab: (tab: RosterTab) => void
}) {
  const collections = ROSTER_TABS.filter((spec) => spec.kinds.length)
  const down = summary.providers.filter((p) => p.error && !p.stale).length
  const stale = summary.providers.filter((p) => p.error && p.stale).length
  const backendSet = new Set(summary.providers.map((p) => p.source))

  return (
    <div className="grid grid-cols-12 gap-4">
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
        label="Backends"
        value={backendSet.size.toLocaleString()}
        statusDot={down > 0 ? 'down' : stale > 0 ? 'warning' : 'ok'}
      />
      <RosterStatTile
        className="col-span-6 lg:col-span-3"
        icon={down > 0 ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
        label={down > 0 ? 'Unreachable' : stale > 0 ? 'Stale cache' : 'All reachable'}
        value={down > 0 || stale > 0 ? `${down + stale}` : 'ok'}
        statusDot={down > 0 ? 'down' : stale > 0 ? 'warning' : 'ok'}
      />

      {summary.degraded.length > 0 && (
        <div className="col-span-12">
          <Notice tone="clay">
            {summary.providers.filter((p) => p.error).map((p) => (
              <div key={p.name}>
                <span className="font-medium">{p.label}</span> — {p.error}
              </div>
            ))}
          </Notice>
        </div>
      )}

      {collections.map((spec) => {
        const count = rosterTabCount(spec, summary.collections)
        const breakdown = spec.kinds.flatMap((kind) => {
          const collection = summary.collections.find((c) => c.kind === kind)
          return collection ? rosterBreakdown(collection) : []
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
            className="col-span-12 md:col-span-6 xl:col-span-3 text-left"
          >
            <Panel
              title={spec.label}
              hint={`${count.toLocaleString()} items`}
              className="h-full transition-shadow hover:shadow-card"
            >
              <div className="space-y-3">
                <div className="tnum text-2xl font-semibold">{count.toLocaleString()}</div>
                <div className="h-[120px]">
                  <SourceBreakdownChart sources={sources} height={120} />
                </div>
                <div className="flex flex-wrap gap-1">
                  {breakdown.length ? breakdown.map((entry) => (
                    <span
                      key={entry.value}
                      className="inline-flex items-center rounded-md border border-border/50 bg-foreground/[0.02] px-1.5 py-0.5 text-micro text-muted-foreground"
                    >
                      {sourceLabel(entry.value)} {entry.count.toLocaleString()}
                    </span>
                  )) : (
                    <span className="text-label text-muted-foreground/70">Unreachable</span>
                  )}
                </div>
              </div>
            </Panel>
          </button>
        )
      })}

      <div className="col-span-12 lg:col-span-5">
        <RecentFetchesPanel providers={summary.providers} />
      </div>

      <div className="col-span-12 lg:col-span-7">
        <ProviderStatusPanel
          providers={summary.providers}
          ttlSeconds={summary.ttl_seconds}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      </div>

      <div className="col-span-12">
        <p className="text-label text-muted-foreground/70">
          {rosterSummaryLine(summary)}
        </p>
      </div>
    </div>
  )
}

function RecentFetchesPanel({ providers }: { providers: RegistryProvider[] }) {
  const sorted = [...providers]
    .filter((p) => p.fetched_at)
    .sort((a, b) => new Date(b.fetched_at!).getTime() - new Date(a.fetched_at!).getTime())

  return (
    <Panel title="Recent fetches" hint="when each backend was last reached">
      {sorted.length === 0 ? (
        <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
          No fetch history yet.
        </div>
      ) : (
        <div className="space-y-1">
          {sorted.map((provider) => (
            <div
              key={provider.name}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.02]"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <div className="min-w-0">
                  <div className="truncate text-caption">{provider.label}</div>
                  <div className="font-mono text-micro text-muted-foreground/70">
                    {sourceLabel(provider.source)}
                    {provider.remote ? ' · over the network' : ' · in process'}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    provider.error
                      ? provider.stale ? 'bg-clay' : 'bg-destructive'
                      : 'bg-primary',
                  )}
                />
                <span className="whitespace-nowrap text-label text-muted-foreground">
                  {formatRelativeStamp(provider.fetched_at!)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
