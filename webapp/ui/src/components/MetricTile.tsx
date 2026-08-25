import { Card, CardContent } from '@/components/ui/card'
import { MicroLabel } from '@/components/ui/micro-label'
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
  label, value, text, digits = 2, percent, negative, bare, hero, tone: toneOverride, hint, className, suffix,
}: {
  label: string
  value?: number | null
  text?: string
  digits?: number
  percent?: boolean
  negative?: boolean
  /** Drop the card chrome; render as a bare label + value pair. */
  bare?: boolean
  /** The page-top size: value at text-2xl instead of text-lg. */
  hero?: boolean
  /** Overrides the sign-derived colour, for domain tone logic (metricTone). */
  tone?: 'positive' | 'negative' | 'neutral'
  hint?: string
  className?: string
  suffix?: string
}) {
  const suffix_ = suffix ?? ''
  const display =
    text ??
    (value == null || !Number.isFinite(value)
      ? '—'
      : percent
        ? `${(value * 100).toFixed(digits === 2 ? 1 : digits)}%${suffix_}`
        : `${value.toFixed(digits)}${suffix_}`)

  const tone =
    toneOverride != null
      ? toneOverride === 'positive'
        ? 'text-primary'
        : toneOverride === 'negative'
          ? 'text-clay'
          : ''
      : value == null || !Number.isFinite(value) || text
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
      <MicroLabel as="div" className="truncate" title={hint}>
        {label}
      </MicroLabel>
      <div className={cn('tnum mt-1 truncate font-mono', hero ? 'text-2xl' : 'text-lg', tone)}>{display}</div>
    </>
  )

  if (bare) return <div className={cn('min-w-0', className)}>{body}</div>
  return (
    <Card className={className}>
      <CardContent className="p-4">{body}</CardContent>
    </Card>
  )
}
