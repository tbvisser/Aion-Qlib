/**
 * How well a factor predicts, rendered the same way everywhere it is asked.
 *
 * Three surfaces measure the same thing — the Databank, the Indicators detail
 * panel, and now the canvas — and each had its own copy of the tiles and its own
 * idea of what counts as signal. The thresholds live in `icVerdict.ts` so a test
 * can pin them; the pixels live here so the three cannot drift apart again.
 *
 * `MetricTile` is deliberately *not* reused for the figures. Its tone follows
 * sign (positive → primary, negative → clay), which is exactly wrong for an IC:
 * −0.05 is a good factor pointing the wrong way, not a loss.
 */
import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import type { FactorEvaluation } from '@/lib/api'
import { cn } from '@/lib/utils'
import { icRows, icTone } from './icVerdict'

const FONT_FAMILY = {
  mono: 'IBM Plex Mono',
  sans: "'Hanken Grotesk', system-ui, sans-serif",
}

const AXIS_TICK_FOR = (font: 'mono' | 'sans') => ({
  fontSize: 10, fontFamily: FONT_FAMILY[font], fill: 'hsl(var(--muted-foreground))',
})

export function IcMetrics({ result, compact, font = 'mono' }: {
  result: FactorEvaluation
  /** Two columns and smaller type, for a 288px rail. */
  compact?: boolean
  font?: 'sans' | 'mono'
}) {
  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4')}>
      {icRows(result).map((row) => {
        const tone = icTone(row.value, row.field)
        return (
          <div
            key={row.key}
            className="rounded-lg border border-border/50 p-2"
            data-testid={`ic-${row.key}`}
          >
            <div className={cn(
              'text-[10px] uppercase tracking-wider text-muted-foreground/70',
              font === 'sans' ? 'font-sans' : 'font-mono',
            )}>
              {row.label}
            </div>
            <div className={cn(
              'tnum mt-0.5',
              compact ? 'text-sm' : 'text-xl',
              tone === 'unknown' ? 'text-muted-foreground'
                : tone === 'strong' ? 'text-primary' : 'text-foreground',
              font === 'sans' ? 'font-sans' : 'font-mono',
            )}>
              {row.value == null ? '—' : row.value.toFixed(4)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function IcChart({ result, height = 220, font = 'mono' }: {
  result: FactorEvaluation
  height?: number
  font?: 'sans' | 'mono'
}) {
  const data = result.series.map((p) => ({ date: p.date.slice(0, 7), ic: p.ic ?? 0 }))
  if (!data.length) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        Nothing to plot — no month had enough names to correlate.
      </p>
    )
  }

  const axisTick = AXIS_TICK_FOR(font)

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
          <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} tick={axisTick} />
          <YAxis tickLine={false} axisLine={false} tick={axisTick} />
          <Tooltip
            cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 11,
              fontFamily: FONT_FAMILY[font],
            }}
            formatter={(v: number) => [v.toFixed(4), 'IC']}
          />
          <ReferenceLine y={0} stroke="hsl(var(--border))" />
          {/* Here the colouring *is* about sign: this is the chart's own axis,
              and a month whose IC went negative is a month it pointed down. */}
          <Bar dataKey="ic" radius={[2, 2, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.ic >= 0 ? 'hsl(var(--primary))' : 'hsl(var(--clay))'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className={cn('mt-2 text-[11px] text-muted-foreground', font === 'sans' ? 'font-sans' : 'font-mono')}>
        {result.observations.toLocaleString()} observations over{' '}
        {result.days.toLocaleString()} days · {result.horizon}d horizon
      </p>
    </>
  )
}
