import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * A tiny inline SVG line.
 *
 * Hand-rolled rather than Recharts on purpose: the series rail renders thirty-
 * odd of these at 56x16, and a ResponsiveContainer each would mean thirty
 * resize observers and thirty SVG trees for a glyph.
 *
 * Nulls break the line rather than being drawn through, so a gap in the data
 * looks like a gap.
 */
export function Sparkline({
  values,
  width = 56,
  height = 16,
  tone = 'neutral',
  className,
}: {
  values: (number | null)[]
  width?: number
  height?: number
  /** 'signed' colours by net direction over the window. */
  tone?: 'neutral' | 'signed'
  className?: string
}) {
  const id = useId()
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v))
  if (finite.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden />
  }

  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const span = max - min || 1
  const step = width / Math.max(values.length - 1, 1)
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2)

  // One <polyline> per unbroken run, so a null is a visible gap.
  const runs: string[] = []
  let current: string[] = []
  values.forEach((value, i) => {
    if (value == null || !Number.isFinite(value)) {
      if (current.length > 1) runs.push(current.join(' '))
      current = []
      return
    }
    current.push(`${(i * step).toFixed(2)},${y(value).toFixed(2)}`)
  })
  if (current.length > 1) runs.push(current.join(' '))

  const rising = finite[finite.length - 1] >= finite[0]
  const stroke =
    tone === 'signed'
      ? rising
        ? 'hsl(var(--primary))'
        : 'hsl(var(--clay))'
      : 'hsl(var(--foreground) / 0.45)'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden
    >
      {runs.map((points, i) => (
        <polyline
          key={`${id}-${i}`}
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}
