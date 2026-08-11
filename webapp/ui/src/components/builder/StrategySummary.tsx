/**
 * What this strategy does, as sentences and a picture.
 *
 * This replaces the raw qrun YAML as the builder's lead explanation of itself.
 * The YAML is still one click away behind `Config` — nothing about what runs is
 * hidden — but it is a reference, not an answer, and it was standing where the
 * answer should be.
 *
 * The prose comes from `lib/strategySummary` and the geometry from
 * `lib/timeline`, both pure and both tested. Neither invents a sentence the
 * server owns: window overlaps and the end-date clamp are the server's words,
 * shown in `Alerts`, and the timeline draws only the shapes.
 */
import { Panel } from '@/components/ui/panel'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import type { StrategyCoverage, StrategyExplain, StrategySpec } from '@/lib/api'
import { summarise } from '@/lib/strategySummary'
import { timeline } from '@/lib/timeline'
import { cn } from '@/lib/utils'

const BAND_TONE: Record<string, string> = {
  train: 'bg-primary/25',
  valid: 'bg-muted-foreground/30',
  test: 'bg-primary/60',
}

export function StrategySummary({ spec, explain, universeCount, coverage }: {
  spec: StrategySpec
  explain?: StrategyExplain
  universeCount?: number | null
  /** For the proxy footnote — see `CoverageBanner` for why it lives here. */
  coverage?: StrategyCoverage
}) {
  const clauses = summarise(spec, explain, universeCount)
  const chart = timeline(spec, {
    calendarStart: explain?.calendar_start,
    calendarEnd: explain?.calendar_end,
    effectiveTestEnd: explain?.effective_test_end,
  })

  return (
    <Panel
      title="What this does"
      hint="assembled from the spec, not from the YAML"
      data-testid="strategy-summary"
    >
      <TooltipProvider delayDuration={300}>
        <div className="space-y-2">
          {clauses.map((clause) => (
            clause.detail ? (
              <Tooltip key={clause.key}>
                <TooltipTrigger asChild>
                  <p className="cursor-help text-[13px] leading-relaxed decoration-border decoration-dotted underline-offset-4 hover:underline">
                    {clause.text}
                  </p>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <span className="font-mono text-[11px]">{clause.detail}</span>
                </TooltipContent>
              </Tooltip>
            ) : (
              <p key={clause.key} className="text-[13px] leading-relaxed">{clause.text}</p>
            )
          ))}
        </div>
      </TooltipProvider>

      {/* A column that computes but is not what it is called. A footnote rather
          than a banner: both stores carry one, so an alert would be permanent
          and therefore ignored — but it does change what the features mean, so
          it belongs under the sentence describing them. */}
      {Object.values(coverage?.proxy_columns ?? {}).map((sentence) => (
        <p key={sentence} className="mt-3 border-t border-border/50 pt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          {sentence}
        </p>
      ))}

      {chart && (
        <div className="mt-5 space-y-2">
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
                <span className="truncate px-1 font-mono text-[9px] uppercase tracking-wider text-foreground/70">
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

          <div className="flex items-baseline justify-between font-mono text-[10px] text-muted-foreground/70">
            <span>{chart.start}</span>
            {chart.clamped && <span className="text-clay">the run stops early</span>}
            <span>{chart.end}</span>
          </div>
        </div>
      )}
    </Panel>
  )
}
