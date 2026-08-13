import type {
  CatalogCollection, CatalogEntity, CatalogFacetValue, CatalogHarvestRecord,
  CatalogKind, CatalogSource, CatalogSummary,
} from '@/lib/api'

/**
 * The Database page's pure functions: what a sub-tab is, how a uid reads, and
 * what a collection's freshness line says.
 *
 * Kept out of the components for the reason every other `lib/*.ts` here is —
 * these are the parts worth pinning with a test, and a vitest that has to mount
 * a table to check a label is a worse test.
 */

// --- sub-tabs -------------------------------------------------------------

/**
 * A sub-tab is not one-to-one with a catalog kind, and forcing it to be would
 * get two things wrong. Operators are the grammar an indicator is written in,
 * so they sit in that tab rather than in one of their own; Documents is a
 * collection with no catalog rows at all, because documents live in Supabase
 * under RLS and are federated in from the browser at query time.
 *
 * `kinds` is what `tabCount` sums, so it has to be exactly what the tab's
 * browser queries -- a label promising 689 rows over a table showing 639 is a
 * miscount, not a rounding.
 */
export type DatabaseTab =
  | 'overview' | 'alphas' | 'indicators' | 'backtests'
  | 'documents' | 'instruments' | 'macro' | 'graph'

export interface TabSpec {
  tab: DatabaseTab
  label: string
  /** The catalog kinds this tab browses. Empty when it has none of its own. */
  kinds: CatalogKind[]
  /** True while the tab is a placeholder, so the shell can dim it. */
  soon?: boolean
}

export const DATABASE_TABS: readonly TabSpec[] = [
  { tab: 'overview', label: 'Overview', kinds: [] },
  { tab: 'alphas', label: 'Alphas', kinds: ['alpha'] },
  { tab: 'indicators', label: 'Indicators', kinds: ['indicator', 'operator'] },
  { tab: 'backtests', label: 'Backtests', kinds: ['backtest'], soon: true },
  { tab: 'documents', label: 'Documents', kinds: [], soon: true },
  { tab: 'instruments', label: 'Instruments', kinds: ['instrument', 'universe'], soon: true },
  { tab: 'macro', label: 'Macro', kinds: ['macro_series'], soon: true },
  { tab: 'graph', label: 'Graph', kinds: [], soon: true },
]

const TAB_KEYS = new Set(DATABASE_TABS.map((t) => t.tab))

/**
 * Which sub-tab a `?tab=` names. Falls back to Overview rather than throwing,
 * so an old bookmark or a hand-typed URL lands somewhere real.
 */
export function tabFromParam(raw: string | null | undefined): DatabaseTab {
  return raw && TAB_KEYS.has(raw as DatabaseTab) ? (raw as DatabaseTab) : 'overview'
}

/**
 * Where a folded-in route should land. Every destination the Database absorbed
 * keeps working: the old path redirects here rather than 404-ing, and arrives
 * on the tab that took over its job.
 */
const ROUTE_TABS: Array<[string, DatabaseTab]> = [
  ['/lab/alpha-zoo', 'alphas'],
  ['/factors', 'alphas'],
  ['/lab/databank', 'alphas'],
  ['/indicators', 'indicators'],
  ['/runs', 'backtests'],
  ['/documents', 'documents'],
  ['/corpus', 'documents'],
  ['/markets', 'instruments'],
  ['/data', 'instruments'],
  ['/macro', 'macro'],
  ['/explorer', 'graph'],
]

export function tabForLegacyRoute(pathname: string): DatabaseTab | null {
  const hit = ROUTE_TABS.find(
    ([route]) => pathname === route || pathname.startsWith(`${route}/`),
  )
  return hit ? hit[1] : null
}

// --- uids -----------------------------------------------------------------

export interface ParsedUid {
  kind: string
  source: string
  localId: string
}

/**
 * Split `<kind>:<source>:<local_id>`. The local id may itself contain colons
 * (`alpha158.KMID` will not, but a future instrument uid could), so only the
 * first two separators are structural.
 */
export function parseUid(uid: string): ParsedUid | null {
  const first = uid.indexOf(':')
  const second = uid.indexOf(':', first + 1)
  if (first < 1 || second < first + 2 || second === uid.length - 1) return null
  return {
    kind: uid.slice(0, first),
    source: uid.slice(first + 1, second),
    localId: uid.slice(second + 1),
  }
}

/** What a source badge says. The upstream's own name, not ours. */
export const SOURCE_LABELS: Record<CatalogSource, string> = {
  qlib: 'qlib',
  curated: 'Curated',
  // "Vibe Zoo" on the Database, where every vibe row is an alpha from the zoo;
  // the roster's vibe rows are skills, teams and tools, so the label is the
  // sidecar's name rather than one of its collections.
  vibe: 'Vibe',
  aion: 'Aion',
  eodhd: 'EODHD',
  rag: 'RAG',
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source as CatalogSource] ?? source
}

/**
 * A family's display name, preferring the label the harvester carried over the
 * raw key. `anomaly` is a key; "Academic anomalies" is what the YAML calls it,
 * and re-deriving that in the UI would be a second place for it to drift.
 */
export function familyLabel(entity: Pick<CatalogEntity, 'family' | 'payload'>): string {
  const carried = entity.payload?.family_label
  if (typeof carried === 'string' && carried) return carried
  return entity.family ?? '—'
}

// --- freshness ------------------------------------------------------------

export type Freshness =
  | { state: 'never'; detail: string }
  | { state: 'ok'; detail: string }
  | { state: 'degraded'; detail: string }

/**
 * What a collection's status line says, and it has to distinguish three cases a
 * single "last updated" would blur: never harvested, harvested cleanly, and
 * harvested-but-failed. The third is the one that matters — those rows are the
 * *previous* run's, and calling them fresh would be a lie.
 */
export function freshness(
  harvester: string,
  records: CatalogHarvestRecord[],
): Freshness {
  const record = records.find((r) => r.harvester === harvester)
  if (!record) return { state: 'never', detail: 'Never harvested' }
  if (record.error) {
    return {
      state: 'degraded',
      detail: `Last run failed — showing the previous harvest. ${record.error}`,
    }
  }
  return { state: 'ok', detail: `${record.count.toLocaleString()} rows` }
}

/** Total across the kinds a tab browses, for the count beside its label. */
export function tabCount(spec: TabSpec, collections: CatalogCollection[]): number {
  return spec.kinds.reduce(
    (sum, kind) => sum + (collections.find((c) => c.kind === kind)?.count ?? 0),
    0,
  )
}

/**
 * The per-source breakdown a collection card shows, biggest first.
 *
 * Sorted by count rather than by source name because the question the card
 * answers is "where did these come from", and the largest contributor is the
 * answer most of the time.
 */
export function sourceBreakdown(collection: CatalogCollection): CatalogFacetValue[] {
  return Object.entries(collection.sources)
    .map(([value, count]) => ({ value, count: count ?? 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/**
 * One sentence for the Overview header.
 *
 * Says the degraded count out loud when there is one. A summary that reports
 * only the total reads as complete whether or not half the sources failed, and
 * "919 indexed" beside a dead sidecar is the exact claim this must not make.
 */
export function summaryLine(summary: CatalogSummary): string {
  if (!summary.indexed) {
    return 'Nothing indexed yet. Reindex to build the catalog from every source.'
  }
  const rows = `${summary.total.toLocaleString()} rows across ${summary.collections.length} collections`
  const links = summary.links ? `, ${summary.links.toLocaleString()} links` : ''
  if (summary.degraded.length) {
    const which = summary.degraded.join(', ')
    return `${rows}${links}. ${summary.degraded.length} source${
      summary.degraded.length > 1 ? 's' : ''
    } failed on the last run (${which}) — those collections are showing older rows.`
  }
  return `${rows}${links}.`
}
