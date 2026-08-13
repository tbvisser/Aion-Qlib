import { useMemo } from 'react'
import {
  CartesianGrid, ComposedChart, Line, ReferenceDot, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'

import type { MacroRelease } from '@/lib/api'
import { SERIES_STROKES, formatIsoDate } from '@/lib/macroFormat'

/**
 * Trailing prints of one indicator: actual as the line, estimate as hollow
 * dots on the same (single-unit) axis. The next pending print carries only
 * its estimate marker — a null actual is a gap, never a plotted zero. The
 * print the user clicked is ringed so the chart answers "was this one
 * unusual" at a glance.
 */
export function ReleaseHistoryChart({ points, selectedDate, height = 180 }: {
  points: MacroRelease[]
  selectedDate: string
  height?: number
}) {
  const rows = useMemo(
    () => points.map((p) => ({ date: p.date, actual: p.actual, estimate: p.estimate })),
    [points],
  )
  const hasEstimates = rows.some((r) => r.estimate != null)
  const selected = rows.find((r) => r.date === selectedDate)
  const actualStroke = SERIES_STROKES[0].stroke

  return (
    <div>
      <div className="mb-1 flex items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/80">
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: actualStroke }} />
          actual
        </span>
        {hasEstimates && (
          <span className="flex items-center gap-1">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full border border-muted-foreground bg-card"
            />
            estimate
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
          <XAxis
            dataKey="date" tickLine={false} axisLine={false} minTickGap={40}
            tickFormatter={(d: string) => d.slice(2, 7)}
            tick={{ fontSize: 9, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <YAxis
            tickLine={false} axisLine={false} width={48} domain={['auto', 'auto']}
            tick={{ fontSize: 9, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8, fontSize: 11, fontFamily: 'IBM Plex Mono',
            }}
            labelFormatter={(d) => formatIsoDate(String(d))}
            formatter={(v: number, name: string) => [String(v), name]}
          />
          {hasEstimates && (
            <Line
              dataKey="estimate" name="est" stroke="none" connectNulls={false}
              isAnimationActive={false}
              dot={{
                r: 2.5, strokeWidth: 1.2,
                stroke: 'hsl(var(--muted-foreground))', fill: 'hsl(var(--card))',
              }}
            />
          )}
          <Line
            dataKey="actual" name="act" type="monotone" stroke={actualStroke}
            strokeWidth={1.6} connectNulls={false} isAnimationActive={false}
            dot={{ r: 2, fill: actualStroke, strokeWidth: 0 }}
          />
          {selected && selected.actual != null && (
            <ReferenceDot
              x={selected.date} y={selected.actual} r={5}
              fill="none" stroke={actualStroke} strokeWidth={1.5}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
