import {
  CatalogBrowser, type Column, type BrowserData, type BrowserQuery,
} from '@/components/database/CatalogBrowser'
import { Panel } from '@/components/ui/panel'
import { RosterStatTiles } from '@/components/roster/RosterStatTiles'
import { SourceBreakdownChart } from '@/components/roster/SourceBreakdownChart'
import { ProviderStatusPanel } from '@/components/roster/ProviderStatusPanel'
import type { RosterTabSpec } from '@/lib/roster'
import type { RegistryEntity, RegistrySummary, CatalogFacets } from '@/lib/api'

interface RosterCatalogDashboardProps {
  spec: RosterTabSpec
  summary: RegistrySummary
  columns: Column<RegistryEntity>[]
  useData: (query: BrowserQuery) => BrowserData<RegistryEntity>
  useFacets: (kind?: string) => CatalogFacets | null
  selected?: string
  onSelect?: (row: RegistryEntity) => void
  blurb?: React.ReactNode
  extra?: React.ReactNode
  refreshing?: boolean
  onRefresh?: () => void
}

export function RosterCatalogDashboard({
  spec,
  summary,
  columns,
  useData,
  useFacets,
  selected,
  onSelect,
  blurb,
  extra,
  refreshing,
  onRefresh,
}: RosterCatalogDashboardProps) {
  const kind = spec.kinds[0]
  const sources = spec.kinds.reduce<Record<string, number>>((acc, k) => {
    const collection = summary.collections.find((c) => c.kind === k)
    if (collection) {
      for (const [source, count] of Object.entries(collection.sources)) {
        if (count != null) acc[source] = (acc[source] ?? 0) + count
      }
    }
    return acc
  }, {})

  return (
    <div className="grid grid-cols-12 gap-4">
      <RosterStatTiles spec={spec} summary={summary} />

      <div className="col-span-12 md:col-span-5 lg:col-span-4">
        <Panel title="Source breakdown" hint="where the rows come from" className="h-full">
          <SourceBreakdownChart sources={sources} />
        </Panel>
      </div>

      <div className="col-span-12 md:col-span-7 lg:col-span-8">
        <ProviderStatusPanel
          providers={summary.providers}
          kinds={spec.kinds}
          ttlSeconds={summary.ttl_seconds}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      </div>

      {extra && <div className="col-span-12">{extra}</div>}

      <div className="col-span-12">
        <Panel title={spec.label} bodyClassName="p-0" flush>
          <div className="p-3">
            {blurb && <p className="mb-3 max-w-3xl text-caption text-muted-foreground">{blurb}</p>}
            <CatalogBrowser<RegistryEntity>
              kind={kind}
              columns={columns}
              useData={useData}
              useFacets={useFacets}
              sort="name"
              selected={selected}
              onSelect={onSelect}
              searchPlaceholder={spec.placeholder}
              emptyHint={<>Nothing reachable — check the source breakdown for which backend is down.</>}
            />
          </div>
        </Panel>
      </div>
    </div>
  )
}
