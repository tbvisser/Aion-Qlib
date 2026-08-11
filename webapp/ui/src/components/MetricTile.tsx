import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * One labelled figure.
 *
 * Extracted from RunReportView's `Metric` and MarketsPage's `Stat`, which were
 * near-identical, so the portfolio stat row does not become a third copy.
 *
 * `negative` forces clay whatever the sign — a drawdown of -18% and a
 * drawdown of 0% are both "the bad column", and colouring one green would be
 * a lie of emphasis.
 */
export function MetricTile({
  label, value, text, digits = 2, percent, negative, bare, hint, className,
}: {
  label: string
  value?: number | null
  text?: string
  digits?: number
  percent?: boolean
  negative?: boolean
  /** Drop the card chrome; render as a bare label + value pair. */
  bare?: boolean
  hint?: string
  className?: string
}) {
  const display =
    text ??
    (value == null || !Number.isFinite(value)
      ? '—'
      : percent
        ? `${(value * 100).toFixed(digits === 2 ? 1 : digits)}%`
        : value.toFixed(digits))

  const tone =
    value == null || !Number.isFinite(value) || text
      ? ''
      : negative
        ? 'text-clay'
        : value > 0
          ? 'text-primary'
          : value < 0
            ? 'text-clay'
            : ''

  const body = (
    <>
      <div
        className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70"
        title={hint}
      >
        {label}
      </div>
      <div className={cn('tnum mt-1 truncate font-mono text-lg', tone)}>{display}</div>
    </>
  )

  if (bare) return <div className={cn('min-w-0', className)}>{body}</div>
  return (
    <Card className={className}>
      <CardContent className="p-4">{body}</CardContent>
    </Card>
  )
}
