import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { CurvePoint } from '@/lib/api'
import { decimate, mergeCurves } from '@/lib/curves'
import { formatIsoDate } from '@/lib/macroFormat'

const MAX_MARKERS = 80

/**
 * The subject's cumulative return with release dates marked.
 *
 * Vertical `ReferenceLine`s rather than `ReferenceDot`s: a dot needs a y value
 * at the event's date, and the curve only has business days, so a release on a
 * date the curve skips would place the dot at the wrong height. A line has no
 * such failure mode.
 */
export function EventOverlayChart({
  curves, markerDates, markerLabel, height = 240,
}: {
  curves: Partial<Record<'strategy' | 'nav' | 'benchmark', CurvePoint[]>>
  markerDates: string[]
  markerLabel: string
  height?: number
}) {
  const merged = mergeCurves(curves as Record<string, CurvePoint[] | undefined>)
  const rows = decimate(merged, 700, (r) => {
    const v = r.strategy ?? r.nav
    return typeof v === 'number' ? v : null
  })
  if (!rows.length) return null

  const onChart = new Set(rows.map((r) => String(r.date)))
  const usable = markerDates.filter((d) => onChart.has(d))
  const shown = usable.slice(0, MAX_MARKERS)
  const primaryKey = 'strategy' in curves ? 'strategy' : 'nav'

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
            tickLine={false} axisLine={false} width={48}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8, fontSize: 11, fontFamily: 'IBM Plex Mono',
            }}
            labelFormatter={(d) => formatIsoDate(String(d))}
            formatter={(v: number, name: string) => [`${(v * 100).toFixed(2)}%`, name]}
          />
          {shown.map((date) => (
            <ReferenceLine
              key={date}
              x={date}
              stroke="hsl(var(--muted-foreground) / 0.35)"
              strokeDasharray="2 3"
            />
          ))}
          {curves.benchmark?.length ? (
            <Line
              type="monotone" dataKey="benchmark" name="Benchmark"
              stroke="hsl(var(--muted-foreground))" strokeWidth={1.2}
              dot={false} isAnimationActive={false}
            />
          ) : null}
          <Line
            type="monotone" dataKey={primaryKey} name="Cumulative return"
            stroke="hsl(var(--primary))" strokeWidth={1.6}
            dot={false} isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 font-mono text-micro text-muted-foreground/70">
        {shown.length} {markerLabel} release{shown.length === 1 ? '' : 's'} marked
        {usable.length > shown.length && ` (capped at ${MAX_MARKERS} of ${usable.length})`}
      </p>
    </>
  )
}
