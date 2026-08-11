import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { PortfolioNav } from '@/lib/api'
import { decimate, mergeCurves } from '@/lib/curves'
import { formatIsoDate } from '@/lib/macroFormat'

const STYLE: Record<string, { label: string; color: string; dash?: string }> = {
  nav: { label: 'NAV', color: 'hsl(var(--primary))' },
  benchmark: { label: 'Benchmark', color: 'hsl(var(--muted-foreground))' },
  gross: { label: 'Gross of costs', color: 'hsl(var(--foreground) / 0.5)', dash: '4 3' },
}

/**
 * NAV against its benchmark, with drawdown stacked beneath.
 *
 * The two charts share `syncId`, which gives Recharts a shared crosshair for
 * free, so hovering a date in either reads both.
 */
export function NavChart({
  nav, showBenchmark, showGross, height = 280,
}: {
  nav: PortfolioNav
  showBenchmark: boolean
  showGross: boolean
  height?: number
}) {
  const merged = mergeCurves({
    nav: nav.curves.nav,
    benchmark: showBenchmark ? nav.curves.benchmark : undefined,
    gross: showGross ? nav.curves.gross : undefined,
  })
  const rows = decimate(merged, 800, (r) => (typeof r.nav === 'number' ? r.nav : null))
  const drawdown = decimate(nav.curves.drawdown, 800, (p) => p.value)

  const axis = {
    fontSize: 10,
    fontFamily: 'IBM Plex Mono',
    fill: 'hsl(var(--muted-foreground))',
  }
  const tooltip = {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 11,
    fontFamily: 'IBM Plex Mono',
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} syncId="pf" margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={56} tick={axis} />
          <YAxis
            tickLine={false} axisLine={false} width={52}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            tick={axis}
          />
          <Tooltip
            contentStyle={tooltip}
            labelFormatter={(d) => formatIsoDate(String(d))}
            formatter={(v: number, name: string) => [
              `${(v * 100).toFixed(2)}%`, STYLE[name]?.label ?? name,
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }}
            formatter={(name: string) => STYLE[name]?.label ?? name}
          />
          {Object.entries(STYLE).map(([key, style]) =>
            rows.some((r) => r[key] != null) ? (
              <Line
                key={key} type="monotone" dataKey={key} name={key}
                stroke={style.color} strokeDasharray={style.dash}
                strokeWidth={key === 'nav' ? 1.8 : 1.3}
                dot={false} connectNulls={false} isAnimationActive={false}
              />
            ) : null,
          )}
        </LineChart>
      </ResponsiveContainer>

      <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        Drawdown
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <AreaChart data={drawdown} syncId="pf" margin={{ top: 2, right: 8, bottom: 4, left: -8 }}>
          <XAxis dataKey="date" hide />
          <YAxis
            tickLine={false} axisLine={false} width={52}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            tick={axis}
          />
          <Tooltip
            contentStyle={tooltip}
            labelFormatter={(d) => formatIsoDate(String(d))}
            formatter={(v: number) => [`${(v * 100).toFixed(2)}%`, 'Drawdown']}
          />
          <Area
            type="monotone" dataKey="value"
            stroke="hsl(var(--clay) / 0.5)" fill="hsl(var(--clay) / 0.18)"
            strokeWidth={1} isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </>
  )
}
