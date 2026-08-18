import { AlertTriangle, Boxes, Check, Layers, Server } from 'lucide-react'
import { RosterStatTile } from '@/components/roster/RosterStatTile'
import { rosterBreakdown, rosterTabCount, type RosterTabSpec } from '@/lib/roster'
import type { RegistrySummary } from '@/lib/api'

interface RosterStatTilesProps {
  spec: RosterTabSpec
  summary: RegistrySummary
}

export function RosterStatTiles({ spec, summary }: RosterStatTilesProps) {
  const count = rosterTabCount(spec, summary.collections)
  const breakdown = spec.kinds.flatMap((kind) => {
    const collection = summary.collections.find((c) => c.kind === kind)
    return collection ? rosterBreakdown(collection) : []
  })

  const sources = breakdown.length
  const topSource = breakdown[0]

  const backendSet = new Set(
    summary.providers
      .filter((p) => spec.kinds.length === 0 || spec.kinds.includes(p.kind))
      .map((p) => p.source),
  )
  const backends = backendSet.size

  const degraded = summary.providers.filter(
    (p) => (!spec.kinds.length || spec.kinds.includes(p.kind)) && p.error,
  )
  const down = degraded.filter((p) => !p.stale)
  const stale = degraded.filter((p) => p.stale)

  return (
    <div className="col-span-12 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <RosterStatTile
        icon={<Layers className="h-4 w-4" />}
        label={spec.label}
        value={count.toLocaleString()}
      />
      <RosterStatTile
        icon={<Boxes className="h-4 w-4" />}
        label="Sources"
        value={sources.toLocaleString()}
        hint={topSource ? `largest ${topSource.value} · ${topSource.count.toLocaleString()}` : undefined}
      />
      <RosterStatTile
        icon={<Server className="h-4 w-4" />}
        label="Backends"
        value={backends.toLocaleString()}
        statusDot={degraded.length > 0 ? 'warning' : 'ok'}
      />
      <RosterStatTile
        icon={degraded.length ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
        label={degraded.length ? (down.length ? 'Unreachable' : 'Stale cache') : 'All reachable'}
        value={degraded.length ? `${down.length + stale.length}` : 'ok'}
        statusDot={degraded.length ? (down.length ? 'down' : 'warning') : 'ok'}
      />
    </div>
  )
}
