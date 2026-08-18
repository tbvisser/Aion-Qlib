import { useMemo } from 'react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Run, RunReport } from '@/lib/api'
import { COMPARE_COLORS } from '@/lib/curves'
import { formatIsoDate } from '@/lib/macroFormat'

const AXIS_TICK = {
  fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))',
}

const TOOLTIP = {
  contentStyle: {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 11,
    fontFamily: 'IBM Plex Mono',
  },
} as const

interface CurveRow {
  date: string
  [key: string]: string | number | null
}

export function TopRunsCurveChart({
  runs, reports, height = 320,
}: {
  runs: readonly Run[]
  reports: Record<string, RunReport | null>
  height?: number
}) {
  const { rows, keys } = useMemo(() => {
    const byDate = new Map<string, CurveRow>()
    const keys: string[] = []

    runs.forEach((run, i) => {
      const report = reports[run.id]
      const curve = report?.curves.excess
      if (!curve?.length) return
      const key = `run-${i}`
      keys.push(key)
      for (const point of curve) {
        const row = byDate.get(point.date) ?? { date: point.date }
        row[key] = point.value
        byDate.set(point.date, row)
      }
    })

    const rows = [...byDate.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)),
    )
    return { rows, keys }
  }, [runs, reports])

  if (!rows.length) {
    return (
      <div className="flex h-[320px] items-center justify-center text-xs text-muted-foreground">
        No equity curves available for the top runs.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border) / 0.35)" vertical={false} />
          <XAxis
            dataKey="date" tickLine={false} axisLine={false} minTickGap={56}
            tick={AXIS_TICK}
          />
          <YAxis
            tickLine={false} axisLine={false}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            tick={AXIS_TICK}
          />
          <Tooltip
            {...TOOLTIP}
            labelFormatter={(d) => formatIsoDate(String(d))}
            formatter={(v: number, name: string) => {
              const idx = Number(name.replace('run-', ''))
              const run = runs[idx]
              return [`${(v * 100).toFixed(2)}%`, run?.name ?? name]
            }}
          />
          {keys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              name={key}
              stroke={COMPARE_COLORS[i % COMPARE_COLORS.length]}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {runs.map((run, i) => (
          <div key={run.id} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: COMPARE_COLORS[i % COMPARE_COLORS.length] }}
            />
            <span className="max-w-[160px] truncate font-mono text-[10px] text-muted-foreground">
              {run.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
