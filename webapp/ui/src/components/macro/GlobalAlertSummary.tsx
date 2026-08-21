import { useMemo } from 'react'
import { Panel } from '@/components/ui/panel'
import type { MacroAlertPoint } from '@/lib/macroAlerts'

interface GlobalAlertSummaryProps {
  alerts: MacroAlertPoint[]
  loading?: boolean
}

function heatStyle(score: number): React.CSSProperties {
  return { backgroundColor: `hsl(17 50% 52% / ${0.35 + score * 0.55})` }
}

/**
 * Compact companion to the 3D globe: total release count, the hottest country,
 * and a heat-ranked list so the global data is readable at a glance.
 */
export function GlobalAlertSummary({ alerts, loading }: GlobalAlertSummaryProps) {
  const total = useMemo(() => alerts.reduce((sum, a) => sum + a.eventCount, 0), [alerts])
  const top = alerts[0]
  const hasData = alerts.length > 0

  return (
    <Panel
      title="Global alert summary"
      hint="Next 14 days"
      className="w-full"
      bodyClassName="p-0 overflow-hidden"
      loading={loading}
    >
      {loading ? (
        <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
          Loading summary…
        </div>
      ) : !hasData ? (
        <div className="flex h-32 items-center justify-center p-4 text-center text-xs text-muted-foreground">
          No upcoming releases to summarize.
        </div>
      ) : (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Total releases
              </div>
              <div className="text-lg font-semibold leading-tight">{total}</div>
            </div>
            <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Top country
              </div>
              <div className="truncate text-lg font-semibold leading-tight" title={top?.country}>
                {top?.country}
              </div>
            </div>
          </div>

          <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {alerts.slice(0, 12).map((a) => (
              <div
                key={a.country}
                className="group flex items-center gap-2 text-xs"
                title={`Top: ${a.topEvent}`}
              >
                <span className="w-7 shrink-0 font-medium">{a.country}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.round(a.score * 100)}%`,
                      ...heatStyle(a.score),
                    }}
                  />
                </div>
                <span className="w-5 shrink-0 text-right font-mono text-muted-foreground">
                  {a.eventCount}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  )
}
