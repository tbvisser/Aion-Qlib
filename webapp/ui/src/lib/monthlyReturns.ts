/**
 * A cumulative return curve, taken apart into calendar months.
 *
 * The one thing to get right is that the served curves are *geometric*:
 * `api/results.py` builds every one of them as `(1 + r).cumprod() - 1`. So a
 * month's return is the ratio of the two wealth levels that bracket it,
 *
 *     (1 + c_end) / (1 + c_prevEnd) - 1
 *
 * and not `c_end - c_prevEnd`. The difference is small enough over a month to
 * look plausible and large enough over three years to be wrong, which is
 * exactly the kind of number nobody catches by reading it — hence the test.
 */
import type { CurvePoint } from '@/lib/api'

export interface MonthCell {
  /** 0-11, matching the column index in the table. */
  month: number
  /** Fractional return over the month, e.g. 0.058 for +5.8%. */
  value: number
}

export interface YearRow {
  year: number
  months: MonthCell[]
  /** The year's compounded return across the months it has. */
  total: number
}

/**
 * @param curve a cumulative return curve, ascending by date, values fractional
 * @returns one row per calendar year the curve touches, ascending
 */
export function monthlyReturns(curve: CurvePoint[]): YearRow[] {
  // Last observation of each month, in order. `YYYY-MM` sorts lexically the
  // same way it sorts chronologically, which is why this needs no date parsing.
  const monthEnd = new Map<string, number>()
  for (const point of curve) {
    if (point.value == null) continue
    const key = point.date.slice(0, 7)
    if (key.length !== 7) continue
    monthEnd.set(key, point.value)
  }

  const keys = [...monthEnd.keys()].sort()
  if (!keys.length) return []

  const rows = new Map<number, MonthCell[]>()
  // The month before the first one we have is the baseline: the curve starts at
  // whatever the first bar returned, not at zero, so seeding with 0 would fold
  // the first bar's return into the first month — which is where it belongs.
  let previous = 0

  for (const key of keys) {
    const wealth = monthEnd.get(key)!
    const value = (1 + wealth) / (1 + previous) - 1
    previous = wealth

    const year = Number(key.slice(0, 4))
    const month = Number(key.slice(5, 7)) - 1
    const list = rows.get(year) ?? []
    list.push({ month, value })
    rows.set(year, list)
  }

  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, months]) => ({
      year,
      months,
      total: months.reduce((acc, m) => (1 + acc) * (1 + m.value) - 1, 0),
    }))
}
