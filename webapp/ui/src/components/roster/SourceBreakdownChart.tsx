import { useMemo } from 'react'
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { sourceLabel } from '@/lib/catalog'

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

interface SourceBreakdownChartProps {
  sources: Record<string, number>
  height?: number
}

export function SourceBreakdownChart({ sources, height = 180 }: SourceBreakdownChartProps) {
  const data = useMemo(() => {
    return Object.entries(sources)
      .map(([key, count]) => ({ name: sourceLabel(key), key, count: count ?? 0 }))
      .sort((a, b) => b.count - a.count)
  }, [sources])

  if (!data.length) {
    return (
      <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
        No source breakdown available.
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
        <CartesianGrid stroke="hsl(var(--border) / 0.35)" vertical={false} />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          interval={0}
          angle={-20}
          textAnchor="end"
          height={60}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
        />
        <Tooltip {...TOOLTIP} />
        <Bar dataKey="count" name="Items" fill="hsl(var(--primary) / 0.85)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
