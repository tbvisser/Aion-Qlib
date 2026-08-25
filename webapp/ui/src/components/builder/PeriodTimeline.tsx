/**
 * Train, validate and test as a strip, over the store's own range.
 *
 * Lifted out of the strategy summary panel when the builder became a pipeline
 * — it was drawn in a different column from the six dates it depicts, which is
 * the wrong place for a picture whose whole job is to show whether those dates
 * are ordered sensibly. It sits in the Periods inspector now, immediately under
 * them. (That panel has since gone entirely; the cards say what it said.)
 *
 * The geometry is `lib/timeline`'s, pure and tested. Nothing here invents a
 * judgement: the overlap and clamp *sentences* are the server's words, shown
 * against the Periods card, and this only draws the shapes.
 */
import type { StrategyExplain, StrategySpec } from '@/lib/api'
import { timeline } from '@/lib/timeline'
import { cn } from '@/lib/utils'

const BAND_TONE: Record<string, string> = {
  train: 'bg-primary/25',
  valid: 'bg-muted-foreground/30',
  test: 'bg-primary/60',
}

export function PeriodTimeline({ spec, explain, className }: {
  spec: StrategySpec
  explain?: StrategyExplain
  className?: string
}) {
  const chart = timeline(spec, {
    calendarStart: explain?.calendar_start,
    calendarEnd: explain?.calendar_end,
    effectiveTestEnd: explain?.effective_test_end,
  })
  if (!chart) return null

  return (
    <div className={cn('space-y-2', className)}>
      <div className="relative h-8 overflow-hidden rounded-md bg-surface-2">
        {/* The store's own range, behind everything: a training window that
            starts before the data does is then visible as exactly that. */}
        {chart.coverage && (
          <div
            className="absolute inset-y-0 bg-foreground/[0.04]"
            style={{ left: `${chart.coverage.leftPct}%`, width: `${chart.coverage.widthPct}%` }}
          />
        )}

        {chart.bands.map((band) => (
          <div
            key={band.key}
            title={`${band.label}: ${band.start} → ${band.end}`}
            className={cn(
              'absolute inset-y-1 flex items-center justify-center overflow-hidden rounded-sm',
              BAND_TONE[band.key],
            )}
            style={{ left: `${band.leftPct}%`, width: `${band.widthPct}%` }}
          >
            <span className="truncate px-1 font-mono text-tiny uppercase tracking-wider text-foreground/70">
              {band.widthPct > 12 ? band.label : ''}
            </span>
          </div>
        ))}

        {/* The part of the test window the run will never reach. */}
        {chart.clamped && chart.clamped.widthPct > 0 && (
          <div
            className="absolute inset-y-1 rounded-sm border border-clay/60 bg-clay/20"
            style={{ left: `${chart.clamped.leftPct}%`, width: `${chart.clamped.widthPct}%` }}
            title="Past the store's last safely backtestable day — the run stops here"
          />
        )}

        {chart.markers.map((marker) => (
          <div
            key={marker.key}
            title={marker.label}
            className={cn('absolute inset-y-0 w-px',
                          marker.tone === 'clay' ? 'bg-clay' : 'bg-muted-foreground')}
            style={{ left: `${marker.pct}%` }}
          />
        ))}
      </div>

      <div className="flex items-baseline justify-between font-mono text-micro text-muted-foreground/70">
        <span>{chart.start}</span>
        {chart.clamped && <span className="text-clay">the run stops early</span>}
        <span>{chart.end}</span>
      </div>
    </div>
  )
}
