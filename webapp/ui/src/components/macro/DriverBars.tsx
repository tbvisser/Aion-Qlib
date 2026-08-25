import {
  Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { MacroDriver } from '@/lib/api'


/**
 * Macro drivers ranked by |correlation| with the subject's daily returns.
 *
 * Rows with too few overlapping observations are still shown, marked and
 * sorted last — the backend deliberately reports them rather than shortening
 * the list, and dropping them here would undo that.
 */
export function DriverBars({ drivers, limit = 10 }: { drivers: MacroDriver[]; limit?: number }) {
  const usable = drivers.filter((d) => d.available && d.pearson != null).slice(0, limit)
  const thin = drivers.filter((d) => !d.available).slice(0, 4)

  if (!usable.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No macro series overlaps this window closely enough to correlate.
      </p>
    )
  }

  const data = usable.map((d) => ({ ...d, r: d.pearson as number }))

  return (
    <>
      <ResponsiveContainer width="100%" height={Math.max(200, data.length * 26 + 24)}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
          barCategoryGap="28%"
        >
          <XAxis
            type="number" domain={[-1, 1]} ticks={[-1, -0.5, 0, 0.5, 1]}
            tickLine={false} axisLine={false}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <YAxis
            type="category" dataKey="label" width={148}
            tickLine={false} axisLine={false}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8, fontSize: 11, fontFamily: 'IBM Plex Mono',
            }}
            formatter={(value: number, _n, item: { payload?: (typeof data)[number] }) => {
              const row = item?.payload
              if (!row) return [value.toFixed(3), '']
              const rho = row.spearman == null ? '—' : row.spearman.toFixed(3)
              const perSd = row.beta_per_sd == null ? '—' : `${row.beta_per_sd.toFixed(1)}bp/sd`
              return [`r ${value.toFixed(3)}   ρ ${rho}   ${perSd}   n ${row.n}`, row.label]
            }}
          />
          <ReferenceLine x={0} stroke="hsl(var(--border))" />
          <Bar dataKey="r" radius={[2, 2, 2, 2]} isAnimationActive={false}>
            {data.map((row) => (
              <Cell
                key={row.key}
                fill={row.r >= 0 ? 'hsl(var(--primary))' : 'hsl(var(--clay))'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <div className="mt-2 space-y-0.5 font-mono text-micro text-muted-foreground/70">
        <div>Pearson on overlapping daily changes. ρ is the rank correlation.</div>
        {thin.map((d) => (
          <div key={d.key}>
            <span className="text-clay">†</span> {d.label}: {d.reason}
          </div>
        ))}
      </div>
    </>
  )
}
