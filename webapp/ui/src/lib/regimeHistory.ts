import type { RegimeHistoryMonth } from '@/lib/api'

export interface RibbonCell {
  month: string
  quadrantState: string | null
  quadrant: string | null
  rateStage: string | null
  marketState: string | null
  riskLabel: string | null
  /** Set on January and on the first cell only. */
  yearLabel: string | null
  current: boolean
  /** A gap in the API's months, drawn as a gap rather than a shifted cell. */
  missing: boolean
  title: string
}

/** Every month between two `YYYY-MM` bounds, inclusive. */
function span(first: string, last: string): string[] {
  const [fy, fm] = first.split('-').map(Number)
  const [ly, lm] = last.split('-').map(Number)
  const out: string[] = []
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); ) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/**
 * The history payload as uniform ribbon cells.
 *
 * A month absent from the payload becomes a `missing` cell in the right slot
 * rather than being skipped, which would shift every later cell and silently
 * mislabel the timeline.
 *
 * The year label keys on a January suffix. That is only correct while `month`
 * is `YYYY-MM` — a `YYYY-MM-01` serialisation would make the test true for
 * every month, and the ribbon would print the year 24 times.
 */
export function ribbonCells(
  months: RegimeHistoryMonth[],
  opts: { asOf?: string } = {},
): RibbonCell[] {
  if (!months.length) return []

  const byMonth = new Map(months.map((m) => [m.month.slice(0, 7), m] as const))
  const keys = [...byMonth.keys()].sort()
  const all = span(keys[0], keys[keys.length - 1])
  const currentMonth = opts.asOf ? opts.asOf.slice(0, 7) : keys[keys.length - 1]

  return all.map((month, i) => {
    const row = byMonth.get(month)
    const [year, m] = month.split('-')
    const detail = row
      ? [
          row.quadrant ?? 'unresolved',
          row.rate_stage ?? 'unresolved',
          row.risk ?? 'unresolved',
          row.market ?? 'unresolved',
        ].join(' · ')
      : 'no data'
    return {
      month,
      quadrantState: row?.quadrant_state ?? null,
      quadrant: row?.quadrant ?? null,
      rateStage: row?.rate_stage ?? null,
      marketState: row?.market ?? null,
      riskLabel: row?.risk ?? null,
      yearLabel: m === '01' || i === 0 ? year : null,
      current: month === currentMonth,
      missing: !row,
      title: `${month} · ${detail}`,
    }
  })
}
