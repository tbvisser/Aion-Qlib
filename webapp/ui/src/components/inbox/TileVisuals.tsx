import { cn } from '@/lib/utils'

/**
 * Glyph-scale chart marks for the KPI tiles.
 *
 * Hand-rolled SVG rather than Recharts, for the reason `components/Sparkline`
 * already documents: a ResponsiveContainer per glyph would mean a resize
 * observer and a full chart tree for something the size of a word.
 *
 * Every mark takes its hue from `currentColor`, so the caller sets it with a
 * `text-*` class and the same component serves any series.
 */

/**
 * A trend over time: 2px line above a 10% wash of its own hue, with an
 * end-dot on the latest point. The wash is a wash on purpose — a saturated
 * block at this size reads as a bar chart with one fat bar.
 */
export function AreaCurve({ values, className, width = 104, height = 34 }: {
  values: number[]
  className?: string
  width?: number
  height?: number
}) {
  const finite = values.filter((v) => Number.isFinite(v))
  // One point is a dot, not a trend; say nothing rather than draw a flat lie.
  if (finite.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden />
  }

  const TOP = 5
  const BOTTOM = 2
  const max = Math.max(...finite, 1)
  const step = width / (values.length - 1)
  const y = (v: number) => height - BOTTOM - (v / max) * (height - TOP - BOTTOM)
  const points = values.map((v, i) => [i * step, y(Number.isFinite(v) ? v : 0)] as const)

  const line = points.map(([x, py], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${py.toFixed(2)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  const [lastX, lastY] = points[points.length - 1]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <path d={area} fill="currentColor" fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Surface ring keeps the dot legible where it sits on the line. */}
      <circle cx={lastX} cy={lastY} r={3} fill="currentColor" stroke="hsl(var(--card))" strokeWidth={1.5} />
    </svg>
  )
}

/**
 * A rate against its own total, as a half-donut. The unfilled remainder is a
 * lighter step of the same track rather than empty space, so the reader sees
 * the whole scale and not just the part that happened to fill.
 */
export function GaugeArc({ value, total, className, size = 52, stroke = 6 }: {
  value: number
  total: number
  className?: string
  size?: number
  stroke?: number
}) {
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const sweep = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  const length = Math.PI * r
  const fraction = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0

  return (
    <svg
      width={size}
      height={cy + stroke / 2}
      viewBox={`0 0 ${size} ${cy + stroke / 2}`}
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <path
        d={sweep}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={stroke}
        strokeLinecap="round"
      />
      {fraction > 0 && (
        <path
          d={sweep}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${length * fraction} ${length}`}
        />
      )}
    </svg>
  )
}

/** The same part-of-whole idea closed into a full circle. */
export function Ring({ value, total, className, size = 34, stroke = 5 }: {
  value: number
  total: number
  className?: string
  size?: number
  stroke?: number
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const fraction = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={stroke}
      />
      {fraction > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * fraction} ${c}`}
          // Start at twelve o'clock rather than three.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  )
}
