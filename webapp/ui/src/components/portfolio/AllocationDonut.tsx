import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { AllocationSlice } from '@/lib/api'

/**
 * Target allocation by asset class.
 *
 * A single-hue opacity ramp, not a categorical palette: the design system has
 * one accent, and `clay` is reserved for "this lost money" — a slice labelled
 * "Bonds" drawn in clay would collide with that everywhere else on the page.
 * Opacity alone is a weak discriminator, so the legend beside it carries the
 * label and the weight and is the primary read; the donut shows proportion.
 */
export function AllocationDonut({ slices }: { slices: AllocationSlice[] }) {
  const usable = slices.filter((s) => s.weight != null && Math.abs(s.weight) > 1e-9)
  if (!usable.length) {
    return <p className="py-8 text-center text-xs text-muted-foreground">No holdings.</p>
  }

  const data = usable.map((s) => ({ ...s, value: Math.abs(s.weight as number) }))
  const alpha = (i: number) => (0.92 - (i / Math.max(data.length - 1, 1)) * 0.7).toFixed(2)

  return (
    <div className="flex items-center gap-4">
      <div className="h-36 w-36 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data} dataKey="value" nameKey="label"
              innerRadius="58%" outerRadius="100%"
              stroke="hsl(var(--card))" strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={`hsl(var(--primary) / ${alpha(i)})`} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8, fontSize: 11, fontFamily: 'IBM Plex Mono',
              }}
              formatter={(v: number, name: string) => [`${(v * 100).toFixed(1)}%`, name]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        {data.map((slice, i) => (
          <div
            key={slice.asset_class}
            data-testid={`allocation-slice-${slice.asset_class}`}
            className="flex items-center gap-2"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: `hsl(var(--primary) / ${alpha(i)})` }}
            />
            <span className="min-w-0 flex-1 truncate text-xs">{slice.label}</span>
            <span className="tnum shrink-0 font-mono text-xs text-muted-foreground">
              {((slice.weight as number) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
