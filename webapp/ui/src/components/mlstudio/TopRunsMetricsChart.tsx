import { useMemo } from 'react'
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Run, RunReport } from '@/lib/api'
import { metricRow } from '@/lib/runMetrics'

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

export function TopRunsMetricsChart({
  runs, reports, height = 320,
}: {
  runs: readonly Run[]
  reports: Record<string, RunReport | null>
  height?: number
}) {
  const data = useMemo(() => {
    return runs.map((run) => {
      const row = metricRow(run, reports[run.id] ?? null)
      return {
        name: run.name,
        ir: row.ir ?? 0,
        return: row.annualised ?? 0,
        drawdown: row.maxDrawdown ?? 0,
      }
    })
  }, [runs, reports])

  if (!data.length) {
    return (
      <div className="flex h-[320px] items-center justify-center text-xs text-muted-foreground">
        No metrics to chart yet.
      </div>
    )
  }

  const formatPct = (v: number) => `${(v * 100).toFixed(0)}%`

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
        <CartesianGrid stroke="hsl(var(--border) / 0.35)" vertical={false} />
        <XAxis
          dataKey="name" tickLine={false} axisLine={false}
          tick={{ fontSize: 9, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          interval={0}
          angle={-20}
          textAnchor="end"
          height={60}
        />
        <YAxis
          tickLine={false} axisLine={false}
          tickFormatter={formatPct}
          tick={AXIS_TICK}
        />
        <Tooltip
          {...TOOLTIP}
          formatter={(v: number, name: string) => [formatPct(v), name]}
        />
        <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
        <Bar dataKey="ir" name="IR" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
        <Bar dataKey="return" name="Ann. excess" fill="hsl(var(--primary) / 0.6)" radius={[2, 2, 0, 0]} />
        <Bar dataKey="drawdown" name="Max DD" fill="hsl(var(--clay))" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
