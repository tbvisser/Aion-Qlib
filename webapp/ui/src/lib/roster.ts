import type { CatalogCollection, RegistryProvider, RegistrySummary, RosterKind } from '@/lib/api'

/**
 * Agents & Skills: the pure functions behind the page.
 *
 * The Database's twin, and deliberately so — `lib/catalog.ts` next door has the
 * same shape for the same reasons. What differs is what "fresh" means: the
 * catalog is a rebuildable index whose collections can be *stale*, while the
 * roster federates live and its collections can be *unreachable*. Those are
 * different words on screen, so they are different functions here.
 */

export type RosterTab = 'overview' | 'swarms' | 'agents' | 'skills' | 'tools' | 'authored'

export interface RosterTabSpec {
  tab: RosterTab
  label: string
  /** The kinds this tab browses. Empty when it browses none of them. */
  kinds: RosterKind[]
  /** Placeholder for the search box, since "expression" means nothing here. */
  placeholder?: string
}

export const ROSTER_TABS: readonly RosterTabSpec[] = [
  { tab: 'overview', label: 'Overview', kinds: [] },
  {
    tab: 'swarms', label: 'Swarms', kinds: ['swarm'],
    placeholder: 'Search teams — try risk, or crypto',
  },
  {
    tab: 'agents', label: 'Agents', kinds: ['agent'],
    placeholder: 'Search agents — try earnings, or premarket',
  },
  {
    tab: 'skills', label: 'Skills', kinds: ['skill'],
    placeholder: 'Search skills — try options, or on-chain',
  },
  {
    tab: 'tools', label: 'Tools', kinds: ['tool'],
    placeholder: 'Search tools — try market, or backtest',
  },
  // Not a catalog kind: these are the user's own Supabase rows, per-user and
  // editable, reached with a JWT the server-side providers cannot hold. Same
  // seam the Database has with Documents.
  { tab: 'authored', label: 'Your Skills', kinds: [] },
]

const TAB_KEYS = new Set(ROSTER_TABS.map((t) => t.tab))

/** Which sub-tab a `?tab=` names. Total, so an old bookmark lands somewhere real. */
export function rosterTabFromParam(raw: string | null | undefined): RosterTab {
  return raw && TAB_KEYS.has(raw as RosterTab) ? (raw as RosterTab) : 'overview'
}

export function rosterTabSpec(tab: RosterTab): RosterTabSpec {
  return ROSTER_TABS.find((t) => t.tab === tab) ?? ROSTER_TABS[0]
}

/** Total across the kinds a tab browses, for the count beside its label. */
export function rosterTabCount(spec: RosterTabSpec, collections: CatalogCollection[]): number {
  return spec.kinds.reduce(
    (sum, kind) => sum + (collections.find((c) => c.kind === kind)?.count ?? 0),
    0,
  )
}

// --- provider state -------------------------------------------------------

export type ProviderState =
  | { state: 'ok'; detail: string }
  | { state: 'stale'; detail: string }
  | { state: 'down'; detail: string }

/**
 * What a provider's status line says.
 *
 * Three cases, and collapsing any two of them loses something a person needs:
 *
 * - **ok** — fetched, N rows.
 * - **stale** — the last fetch failed but earlier rows are still on screen.
 *   Better than empty, worse than fresh, and the only honest word for it.
 * - **down** — failed with nothing cached. The collection really is empty, and
 *   saying "0 skills" without saying why would be a lie by omission.
 */
export function providerState(provider: RegistryProvider): ProviderState {
  if (!provider.error) {
    return { state: 'ok', detail: `${provider.count.toLocaleString()} rows` }
  }
  if (provider.stale) {
    return {
      state: 'stale',
      detail: `Unreachable — showing ${provider.count.toLocaleString()} rows from the last successful fetch. ${provider.error}`,
    }
  }
  return { state: 'down', detail: `Unreachable, and nothing cached. ${provider.error}` }
}

/** The per-source breakdown a collection card shows, biggest first. */
export function rosterBreakdown(collection: CatalogCollection): { value: string; count: number }[] {
  return Object.entries(collection.sources)
    .map(([value, count]) => ({ value, count: count ?? 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/**
 * One sentence for the Overview header.
 *
 * Names the unreachable providers rather than reporting only a total. "220
 * across 4 collections" beside a dead sidecar reads as complete when half the
 * rows are missing, and that is exactly the claim this must not make.
 */
export function rosterSummaryLine(summary: RegistrySummary): string {
  const base = `${summary.total.toLocaleString()} across ${summary.collections.length} collections, federated live from ${countBackends(summary)} backends.`
  if (!summary.degraded.length) return base

  const down = summary.providers.filter((p) => p.error)
  const lost = down.filter((p) => !p.stale).length
  const which = down.map((p) => p.label).join(', ')
  const tail = lost
    ? ` ${lost} of them ${lost === 1 ? 'has' : 'have'} nothing cached, so ${lost === 1 ? 'its rows are' : 'their rows are'} missing entirely.`
    : ' Their rows are from an earlier fetch.'
  return `${base} ${down.length} unreachable (${which}).${tail}`
}

function countBackends(summary: RegistrySummary): number {
  return new Set(summary.providers.map((p) => p.source)).size
}
