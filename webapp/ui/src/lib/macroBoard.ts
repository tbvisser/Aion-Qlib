import type {
  MacroChangeUnit, MacroGroup, MacroSeriesResponse, MacroSnapshot, MacroUnit,
} from '@/lib/api'

/**
 * The 31 curated series, regrouped for a board that actually tiles.
 *
 * The registry's own seven groups hold 2-7 series each, which cannot fill a
 * rectangle at any column count — INFLATION (2) and CREDIT (2) left their cards
 * roughly three-quarters empty. These six hold 4-6 each and tile exactly at
 * both `md:grid-cols-2` (3x2) and `xl:grid-cols-3` (2x3).
 *
 * The mapping is declarative with two per-key overrides, and anything
 * unrecognised falls into a trailing `other` group. A series added to
 * `macro_registry.py` therefore appears here with no frontend change, and can
 * never silently vanish — which is the same rule the rail enforced, because a
 * shorter list would read as "this desk does not track the dollar".
 */
export type BoardGroupId =
  | 'rates' | 'curve_credit' | 'equities' | 'volatility'
  | 'commodities' | 'dollar_inflation' | 'other'

export type Horizon = '1d' | '1w' | '1m' | '1y'

export interface BoardRow {
  key: string
  label: string
  note: string
  unit: MacroUnit
  changeUnit: MacroChangeUnit
  available: boolean
  reason: string | null
  level: number | null
  change: number | null
  zscore: number | null
  spark: (number | null)[]
}

export interface BoardGroup {
  id: BoardGroupId
  label: string
  rows: BoardRow[]
}

const GROUP_ORDER: BoardGroupId[] = [
  'rates', 'curve_credit', 'equities', 'volatility',
  'commodities', 'dollar_inflation', 'other',
]

const GROUP_LABELS: Record<BoardGroupId, string> = {
  rates: 'Rates',
  curve_credit: 'Curve & credit',
  equities: 'Equities',
  volatility: 'Volatility',
  commodities: 'Commodities',
  dollar_inflation: 'Dollar & inflation',
  other: 'Other',
}

/** Registry group -> board group. */
const FROM_REGISTRY: Record<MacroGroup, BoardGroupId> = {
  rates: 'rates',
  credit: 'curve_credit',
  growth: 'equities',
  volatility: 'volatility',
  commodities: 'commodities',
  dollar: 'dollar_inflation',
  inflation: 'dollar_inflation',
}

/**
 * The only two series that move, and both moves are substantive.
 *
 * The slope pair are *spreads*, so they belong beside the other two spreads
 * rather than under five outright yields; and copper/gold is the log ratio of
 * the two commodities immediately above it.
 */
const OVERRIDES: Record<string, BoardGroupId> = {
  SLOPE_2S10S: 'curve_credit',
  SLOPE_3M10Y: 'curve_credit',
  COPPER_GOLD: 'commodities',
}

export function boardGroupFor(key: string, group: MacroGroup): BoardGroupId {
  return OVERRIDES[key] ?? FROM_REGISTRY[group] ?? 'other'
}

export function buildBoard(
  registry: MacroSeriesResponse | null,
  snapshot: MacroSnapshot | null,
  horizon: Horizon,
): BoardGroup[] {
  if (!registry) return []

  const rows = new Map(
    (snapshot?.rows ?? []).map((row) => [row.key, row] as const),
  )
  const buckets = new Map<BoardGroupId, BoardRow[]>()

  for (const group of registry.groups) {
    for (const series of group.series) {
      const snap = rows.get(series.key)
      const bucket = boardGroupFor(series.key, series.group)
      const list = buckets.get(bucket) ?? []
      list.push({
        key: series.key,
        label: series.label,
        note: series.note,
        unit: series.unit,
        changeUnit: series.change_unit,
        // A series with no data is kept and marked, never dropped.
        available: series.available,
        reason: series.reason,
        level: snap?.level ?? null,
        change: snap ? snap[`change_${horizon}` as const] : null,
        zscore: snap?.zscore ?? null,
        spark: snap?.spark ?? [],
      })
      buckets.set(bucket, list)
    }
  }

  return GROUP_ORDER
    .filter((id) => buckets.get(id)?.length)
    .map((id) => ({ id, label: GROUP_LABELS[id], rows: buckets.get(id) ?? [] }))
}
