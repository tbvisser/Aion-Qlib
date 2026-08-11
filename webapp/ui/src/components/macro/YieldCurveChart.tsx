import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { MacroCurveResponse } from '@/lib/api'
import { formatIsoDate } from '@/lib/macroFormat'

/**
 * The Treasury curve, and optionally the same curve on an earlier date.
 *
 * Recharts rather than lightweight-charts because the x axis is *tenor* — a
 * category, not time — which lightweight-charts cannot represent at all.
 */
export function YieldCurveChart({
  curve, height = 200,
}: {
  curve: MacroCurveResponse
  height?: number
}) {
  const compare = new Map(
    (curve.compare?.tenors ?? []).map((t) => [t.tenor, t.yield]),
  )
  const data = curve.current.tenors.map((t) => ({
    tenor: t.tenor,
    current: t.yield,
    compare: compare.get(t.tenor) ?? null,
  }))

  const missing = curve.current.tenors.filter((t) => t.yield == null).map((t) => t.tenor)
  const anyValue = data.some((d) => d.current != null || d.compare != null)

  // `domain={['dataMin - 0.2', ...]}` throws inside Recharts when every value
  // is null, so the empty case is handled before the chart is constructed.
  if (!anyValue) {
    return (
      <p className="py-10 text-center text-xs text-muted-foreground">
        No Treasury curve on {formatIsoDate(curve.current.date)}.
      </p>
    )
  }
  const slope = (() => {
    const ten = curve.current.tenors.find((t) => t.tenor === '10Y')?.yield
    const two = curve.current.tenors.find((t) => t.tenor === '2Y')?.yield
    if (ten == null || two == null) return null
    return (ten - two) * 100
  })()

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
          <XAxis
            dataKey="tenor" tickLine={false} axisLine={false}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <YAxis
            tickLine={false} axisLine={false} width={42}
            domain={['dataMin - 0.2', 'dataMax + 0.2']}
            tickFormatter={(v: number) => `${v.toFixed(1)}%`}
            tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))' }}
          />
          <Tooltip
            cursor={{ stroke: 'hsl(var(--border))' }}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8, fontSize: 11, fontFamily: 'IBM Plex Mono',
            }}
            formatter={(v: number, name: string) => [`${v.toFixed(3)}%`, name]}
          />
          {curve.compare && (
            <Line
              type="monotone" dataKey="compare" name={formatIsoDate(curve.compare.resolved_date)}
              stroke="hsl(var(--muted-foreground))" strokeDasharray="4 3"
              strokeWidth={1.4} dot={{ r: 2 }} connectNulls={false}
              isAnimationActive={false}
            />
          )}
          <Line
            type="monotone" dataKey="current" name={formatIsoDate(curve.current.resolved_date)}
            stroke="hsl(var(--primary))" strokeWidth={1.8} dot={{ r: 2.5 }}
            connectNulls={false} isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <div className="mt-2 space-y-0.5 font-mono text-[10px] text-muted-foreground">
        {slope != null && (
          <div>
            10Y−2Y{' '}
            <span className={slope >= 0 ? 'text-primary' : 'text-clay'}>
              {slope >= 0 ? '+' : ''}{slope.toFixed(0)}bp
            </span>
            {slope < 0 && ' — inverted'}
          </div>
        )}
        {curve.current.resolved_date !== curve.current.date && (
          <div>nearest trading day: {formatIsoDate(curve.current.resolved_date)}</div>
        )}
        {missing.length > 0 && (
          <div className="text-clay">
            no quote for {missing.join(', ')} on this date
          </div>
        )}
      </div>
    </>
  )
}
