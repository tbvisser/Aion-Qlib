import { AlertTriangle, Check, CircleSlash, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { sourceLabel } from '@/lib/catalog'
import { providerState, type ProviderState } from '@/lib/roster'
import type { RegistryProvider, RosterKind } from '@/lib/api'
import { cn } from '@/lib/utils'

interface ProviderStatusPanelProps {
  providers: RegistryProvider[]
  kinds?: RosterKind[]
  ttlSeconds?: number
  refreshing?: boolean
  onRefresh?: () => void
}

export function ProviderStatusPanel({
  providers,
  kinds,
  ttlSeconds,
  refreshing,
  onRefresh,
}: ProviderStatusPanelProps) {
  const filtered = kinds?.length
    ? providers.filter((p) => kinds.includes(p.kind))
    : providers

  return (
    <Panel
      title="Backends"
      hint="live federation status"
      className="col-span-12 h-full"
      actions={onRefresh && (
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refreshing && 'animate-spin')} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      )}
    >
      <div className="overflow-hidden rounded-lg border border-border/50">
        <table className="w-full border-collapse text-left">
          <tbody>
            {filtered.map((provider) => {
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
                        stateClass(state),
                      )}
                    >
                      <StatusIcon state={state.state} />
                      {state.detail}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {ttlSeconds != null && (
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Nothing here is stored. Each backend is re-read at most once every{' '}
          {ttlSeconds} seconds; Refresh drops that cache.
        </p>
      )}
    </Panel>
  )
}

function stateClass(state: ProviderState) {
  if (state.state === 'down') return 'text-destructive'
  if (state.state === 'stale') return 'text-clay'
  return 'text-muted-foreground'
}

function StatusIcon({ state }: { state: ProviderState['state'] }) {
  if (state === 'ok') return <Check className="h-3 w-3" />
  if (state === 'stale') return <AlertTriangle className="h-3 w-3" />
  return <CircleSlash className="h-3 w-3" />
}
