import { useMemo } from 'react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { MacroSeriesData } from '@/lib/api'
import { decimate, mergeCurves } from '@/lib/curves'
import { SERIES_STROKES, formatIsoDate } from '@/lib/macroFormat'

export type SeriesMode = 'level' | 'indexed' | 'zscore'

const MAX_POINTS = 600

/**
 * Several macro series on one chart.
 *
 * Two problems, both solved here rather than in the chart library:
 *
 * **Units.** A 10Y yield at 4.2, DXY at 104 and VIX at 15 cannot share a linear
 * axis. `indexed` (100 at the first observation) and `zscore` make one shared
 * axis correct; `level` is only sensible for series that already agree, which
 * is why the mode is a visible control rather than a default.
 *
 * The legend is the chip row in the panel header, not a Recharts `<Legend>`:
 * the chips carry the same stroke swatch, add a remove control, and do not
 * cost ~28px of chart height or wrap unpredictably at six series.
 *
 * **Volume.** Six 16-year daily series is ~25k points. LTTB decimation to 600
 * per series keeps the shape — including spikes a naive stride would delete —
 * and keeps Recharts responsive.
 */
export function MacroSeriesChart({
  series, mode, height = 300,
}: {
  series: MacroSeriesData[]
  mode: SeriesMode
  height?: number
}) {
  const { rows, dropped } = useMemo(() => {
    const curves: Record<string, { date: string; value: number | null }[]> = {}
    let total = 0

    for (const s of series) {
      const points = s.points.filter((p) => p.value != null)
      if (!points.length) continue
      total += points.length

      let values = points
      if (mode === 'indexed') {
        const base = points[0].value as number
        values = base
          ? points.map((p) => ({ ...p, value: p.value == null ? null : (p.value / base) * 100 }))
          : points
      } else if (mode === 'zscore') {
        const nums = points.map((p) => p.value as number)
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length
        const sd = Math.sqrt(
          nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(nums.length - 1, 1),
        )
        values = sd
          ? points.map((p) => ({ ...p, value: p.value == null ? null : (p.value - mean) / sd }))
          : points.map((p) => ({ ...p, value: 0 }))
      }
      curves[s.key] = values
    }

    // Merge at full resolution, *then* decimate once.
    //
    // Decimating each series first is the obvious thing and it is wrong: LTTB
    // picks different dates for each series, so the merge produces one row per
    // union date with every other series null there. With connectNulls={false}
    // — which is right, because a null is a real gap — each line then renders
    // as disconnected vertical strokes instead of a line.
    const merged = mergeCurves(curves)
    const keys = Object.keys(curves)
    const thinned = decimate(merged, MAX_POINTS, (row) => {
      const first = row[keys[0]]
      return typeof first === 'number' ? first : null
    })

    return { rows: thinned, dropped: { total, shown: thinned.length * keys.length } }
  }, [series, mode])

  if (!series.length) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Pick series from the cross-asset board above, or use “add”.
      </p>
    )
  }

  const label = (key: string) => series.find((s) => s.key === key)?.label ?? key
  const format = (v: number) =>
    mode === 'zscore' ? `${v.toFixed(2)}σ` : mode === 'indexed' ? v.toFixed(0) : v.toFixed(2)

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
          <XAxis
            dataKey="date" tickLine={false} axisLine={false} minTickGap={56}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <YAxis
            tickLine={false} axisLine={false} width={52} tickFormatter={format}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8, fontSize: 11, fontFamily: 'IBM Plex Mono',
            }}
            labelFormatter={(d) => formatIsoDate(String(d))}
            formatter={(v: number, name: string) => [format(v), label(name)]}
          />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.key}
              stroke={SERIES_STROKES[i % SERIES_STROKES.length].stroke}
              strokeDasharray={SERIES_STROKES[i % SERIES_STROKES.length].strokeDasharray}
              strokeWidth={1.6}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <div className="mt-2 space-y-0.5 font-mono text-micro text-muted-foreground/70">
        {mode === 'level' && series.length > 1 && (
          <div className="text-clay">
            Levels share one axis — switch to indexed or z-score to compare series
            measured in different units.
          </div>
        )}
        {dropped.total > dropped.shown && (
          <div>{dropped.total.toLocaleString()} points → {dropped.shown.toLocaleString()} drawn</div>
        )}
        {series
          .filter((s) => s.substituted_from)
          .map((s) => (
            <div key={s.key} className="text-clay">
              {s.label} served from {s.substituted_from}
            </div>
          ))}
      </div>
    </>
  )
}
