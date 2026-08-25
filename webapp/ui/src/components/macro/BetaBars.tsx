import {
  Bar, BarChart, Cell, ErrorBar, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { MacroFactorModel } from '@/lib/api'
import { isSignificant, significance } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

/**
 * Macro betas as a diverging bar, in basis points of daily return per one
 * standard deviation of the driver.
 *
 * Two encodings share two hues on purpose. **Sign is hue** (primary up, clay
 * down — the app's verdict palette). **Significance is fill**: a beta that is
 * not distinguishable from zero is drawn hollow and dashed in the *same* hue
 * rather than in a third colour, which would compete with the sign and make
 * both ambiguous. The whiskers are ±1 standard error, so a bar whose whisker
 * crosses the zero line is visibly the same bar that is drawn hollow.
 */
export function BetaBars({ model, height = 240 }: { model: MacroFactorModel; height?: number }) {
  const rows = model.rows
    .filter((r) => r.beta != null && Number.isFinite(r.beta))
    // Work in basis points: a raw daily beta of 0.0178 is unreadable.
    .map((r) => ({ ...r, bps: r.beta * 1e4, se_bps: (r.std_error ?? 0) * 1e4 }))
    .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps))

  if (!rows.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No betas were estimated over this window.
      </p>
    )
  }

  // Symmetric domain, so equal-and-opposite betas are equal bars, padded by
  // the widest whisker so no error bar is clipped.
  const bound = Math.max(...rows.map((r) => Math.abs(r.bps) + r.se_bps)) * 1.15 || 1

  return (
    <>
      <ResponsiveContainer width="100%" height={Math.max(height, rows.length * 30 + 24)}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
          barCategoryGap="30%"
        >
          <XAxis
            type="number"
            domain={[-bound, bound]}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => v.toFixed(0)}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={148}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8, fontSize: 11, fontFamily: 'IBM Plex Mono',
            }}
            formatter={(value: number, _name, item: { payload?: (typeof rows)[number] }) => {
              const row = item?.payload
              if (!row) return [`${value.toFixed(1)}bp`, '']
              return [
                `${value.toFixed(1)}bp ± ${row.se_bps.toFixed(1)}   t ${row.t_stat.toFixed(2)} ${significance(row.t_stat)}`,
                row.label,
              ]
            }}
          />
          <ReferenceLine x={0} stroke="hsl(var(--border))" />
          <Bar dataKey="bps" radius={[2, 2, 2, 2]} isAnimationActive={false}>
            {rows.map((row) => {
              const token = row.bps >= 0 ? '--primary' : '--clay'
              const sig = isSignificant(row.t_stat)
              return (
                <Cell
                  key={row.key}
                  fill={sig ? `hsl(var(${token}))` : `hsl(var(${token}) / 0.16)`}
                  stroke={sig ? undefined : `hsl(var(${token}) / 0.6)`}
                  strokeWidth={sig ? 0 : 1}
                  strokeDasharray={sig ? undefined : '3 2'}
                />
              )
            })}
            <ErrorBar
              dataKey="se_bps"
              direction="x"
              width={4}
              strokeWidth={1}
              stroke="hsl(var(--muted-foreground) / 0.7)"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* The numbers, because a bar cannot carry a t-statistic legibly. */}
      <div className="mt-3 border-t border-border/50 pt-1">
        {rows.map((row) => {
          const stars = significance(row.t_stat)
          return (
            <div
              key={row.key}
              data-testid={`beta-row-${row.key}`}
              className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1 last:border-0"
            >
              <span className="min-w-0 truncate font-mono text-label text-muted-foreground">
                {row.label}
                {row.vif != null && row.vif > 5 && (
                  <span className="ml-1 text-clay" title={`VIF ${row.vif.toFixed(1)}`}>†</span>
                )}
              </span>
              <span className="flex shrink-0 items-baseline gap-3">
                <span className={cn('tnum font-mono text-xs',
                  row.bps >= 0 ? 'text-primary' : 'text-clay')}>
                  {row.bps >= 0 ? '+' : ''}{row.bps.toFixed(1)}bp
                </span>
                <span className="tnum w-14 text-right font-mono text-label text-muted-foreground/70">
                  t {row.t_stat.toFixed(2)}
                </span>
                <span className={cn('w-7 text-right font-mono text-micro',
                  stars === 'ns' ? 'text-muted-foreground/50' : 'text-muted-foreground')}>
                  {stars}
                </span>
              </span>
            </div>
          )
        })}
      </div>

      <div className="mt-2 space-y-0.5 font-mono text-micro text-muted-foreground/70">
        <div>
          n {model.n} · R² {model.r_squared.toFixed(3)} ·{' '}
          {model.cov === 'hac'
            ? `Newey–West, ${model.hac_lags} lags`
            : 'plain OLS standard errors'}
        </div>
        <div>
          bp of daily return per +1sd move · hollow bars are not distinguishable from zero
        </div>
        {model.dropped.map((d) => (
          <div key={d.key} className="text-clay">dropped {d.key}: {d.reason}</div>
        ))}
        {model.warnings.map((w) => (
          <div key={w} className="text-clay">† {w}</div>
        ))}
      </div>
    </>
  )
}
