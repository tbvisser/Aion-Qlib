import type { CurvePoint } from '@/lib/api'

/**
 * The three curves a run report draws, and what each is called.
 *
 * Lives here rather than in `RunReportView` because the run comparison draws
 * the same strategy line for several runs at once and has to start from the
 * same green — a comparison of one run that looked different from the report
 * of that same run would read as a different measurement.
 *
 * `excess` is clay: it is the statistical verdict, net of cost, and it is the
 * number that decides whether the strategy was worth running.
 */
export const CURVE_STYLE: Record<string, { label: string; color: string }> = {
  strategy: { label: 'Strategy', color: 'hsl(var(--primary))' },
  benchmark: { label: 'Benchmark', color: 'hsl(var(--muted-foreground))' },
  excess: { label: 'Excess (net of cost)', color: 'hsl(var(--clay))' },
}

/**
 * Colours for overlaying several runs of the same strategy.
 *
 * Four, and the cap is enforced at the picker rather than here: past four,
 * distinguishable hues stop existing in this palette and the honest answer is
 * to make the reader deselect one rather than to invent a fifth colour that
 * belongs to no token.
 *
 * Entry 0 is deliberately `CURVE_STYLE.strategy.color`, so comparing a single
 * run shows the same green that run's own report showed.
 */
export const COMPARE_COLORS: string[] = [
  'hsl(var(--primary))',
  'hsl(var(--clay))',
  'hsl(var(--muted-foreground))',
  'hsl(var(--foreground))',
]

/**
 * Recharts wants one row per date with a column per series.
 *
 * Extracted from `RunReportView` because the portfolio NAV chart has the
 * identical problem, and a portfolio's `curves.nav` is deliberately the same
 * unit as a run's `curves.strategy`.
 *
 * A date present in only some series gets `null` for the others rather than
 * `undefined`: Recharts renders `null` as a break in the line, which is
 * correct, while `undefined` makes it interpolate straight across the gap as
 * though the data were there.
 */
export function mergeCurves(
  curves: Record<string, CurvePoint[] | undefined>,
): Record<string, string | number | null>[] {
  const keys = Object.keys(curves).filter((key) => curves[key]?.length)
  const byDate = new Map<string, Record<string, string | number | null>>()

  for (const key of keys) {
    for (const point of curves[key] ?? []) {
      const row = byDate.get(point.date) ?? { date: point.date }
      row[key] = point.value
      byDate.set(point.date, row)
    }
  }

  const rows = [...byDate.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  )
  for (const row of rows) {
    for (const key of keys) {
      if (!(key in row)) row[key] = null
    }
  }
  return rows
}

/**
 * Reduce a series to at most `target` points using Largest-Triangle-Three-
 * Buckets.
 *
 * A naive stride is not good enough here: on a 16-year daily VIX series it can
 * drop the March 2020 spike entirely, which is the one thing a reader is
 * looking for. LTTB keeps the points that carry the shape, including extremes,
 * and always keeps the first and last.
 */
export function decimate<T>(
  points: T[],
  target: number,
  getY: (point: T) => number | null,
): T[] {
  if (target < 3 || points.length <= target) return points

  const out: T[] = [points[0]]
  const bucketSize = (points.length - 2) / (target - 2)
  let anchor = 0

  for (let i = 0; i < target - 2; i += 1) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length - 1)

    // Mean of the *next* bucket, which forms the far vertex of the triangle.
    const nextStart = rangeEnd
    const nextEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, points.length)
    let avgX = 0
    let avgY = 0
    let counted = 0
    for (let j = nextStart; j < nextEnd; j += 1) {
      const y = getY(points[j])
      if (y == null || !Number.isFinite(y)) continue
      avgX += j
      avgY += y
      counted += 1
    }
    if (counted) {
      avgX /= counted
      avgY /= counted
    }

    const anchorY = getY(points[anchor]) ?? 0
    let best = rangeStart
    let bestArea = -1
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      const y = getY(points[j])
      // A null is a real gap. Keep it as a candidate so the break survives
      // decimation rather than being silently bridged.
      if (y == null || !Number.isFinite(y)) {
        best = j
        bestArea = Number.POSITIVE_INFINITY
        break
      }
      const area = Math.abs(
        (anchor - avgX) * (y - anchorY) - (anchor - j) * (avgY - anchorY),
      )
      if (area > bestArea) {
        bestArea = area
        best = j
      }
    }
    out.push(points[best])
    anchor = best
  }

  out.push(points[points.length - 1])
  return out
}
