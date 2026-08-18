import { useMemo } from 'react'
import {
  Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip,
} from 'recharts'
import type { Run, RunReport } from '@/lib/api'
import { COMPARE_COLORS } from '@/lib/curves'
import { metricRow } from '@/lib/runMetrics'

const TOOLTIP = {
  contentStyle: {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 11,
    fontFamily: 'IBM Plex Mono',
  },
} as const

const METRICS: { key: string; label: string; get: (run: Run, report: RunReport | null) => number | null }[] = [
  { key: 'ic', label: 'IC', get: (_, report) => report?.metrics['IC'] ?? null },
  { key: 'icir', label: 'ICIR', get: (_, report) => report?.metrics['ICIR'] ?? null },
  { key: 'ir', label: 'IR', get: (run, report) => metricRow(run, report).ir },
  { key: 'return', label: 'Ann. excess', get: (run, report) => metricRow(run, report).annualised },
  { key: 'drawdown', label: 'Max DD', get: (run, report) => {
    const dd = metricRow(run, report).maxDrawdown
    return dd == null ? null : -dd
  }},
]

export function TopRunsRadarChart({
  runs, reports, height = 320,
}: {
  runs: readonly Run[]
  reports: Record<string, RunReport | null>
  height?: number
}) {
  const data = useMemo(() => {
    const rawByMetric = METRICS.map((m) => ({
      ...m,
      values: runs.map((run) => m.get(run, reports[run.id] ?? null)),
    }))

    const scales = rawByMetric.map(({ values }) => {
      const finite = values.filter((v): v is number => v != null && Number.isFinite(v))
      const min = finite.length ? Math.min(...finite) : 0
      const max = finite.length ? Math.max(...finite) : 1
      const span = max - min || 1
      return { min, span }
    })

    return METRICS.map((m, mi) => {
      const row: Record<string, number | string> = { metric: m.label }
      runs.forEach((run, ri) => {
        const raw = m.get(run, reports[run.id] ?? null)
        const { min, span } = scales[mi]
        row[`run-${ri}`] = raw == null ? 0 : Math.max(0, Math.min(1, (raw - min) / span))
      })
      return row
    })
  }, [runs, reports])

  if (!data.length) {
    return (
      <div className="flex h-[320px] items-center justify-center text-xs text-muted-foreground">
        No data for radar comparison.
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
        <PolarGrid stroke="hsl(var(--border) / 0.5)" />
        <PolarAngleAxis
          dataKey="metric"
          tick={{ fontSize: 9, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
        />
        <PolarRadiusAxis angle={90} domain={[0, 1]} tick={false} axisLine={false} />
        <Tooltip
          {...TOOLTIP}
          formatter={(v: number, name: string) => {
            const idx = Number(name.replace('run-', ''))
            return [`${(v * 100).toFixed(0)}`, runs[idx]?.name ?? name]
          }}
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'IBM Plex Mono' }} />
        {runs.map((run, i) => (
          <Radar
            key={run.id}
            name={run.name}
            dataKey={`run-${i}`}
            stroke={COMPARE_COLORS[i % COMPARE_COLORS.length]}
            fill={COMPARE_COLORS[i % COMPARE_COLORS.length]}
            fillOpacity={0.12}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        ))}
      </RadarChart>
    </ResponsiveContainer>
  )
}
