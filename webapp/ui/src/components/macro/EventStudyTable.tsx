import type { MacroEventRow } from '@/lib/api'
import { significance } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

/**
 * What the subject did around each repeated economic release.
 *
 * `car_0_1` is the cumulative abnormal return over the release day and the
 * next session — the standard post-release drift read. The hit-rate meter is
 * `foreground` opacity, not a verdict hue, with a hairline at 50% so
 * "better than a coin flip" is visible without colouring it good or bad.
 */
export function EventStudyTable({
  events, selected, onSelect,
}: {
  events: MacroEventRow[]
  selected: string | null
  onSelect: (eventKey: string | null) => void
}) {
  if (!events.length) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No release type has enough dated observations inside this window to study.
      </p>
    )
  }

  return (
    <>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border/50 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <th className="py-1 pr-2 font-normal">Release</th>
            <th className="py-1 pr-2 text-right font-normal">n</th>
            <th className="py-1 pr-2 text-right font-normal">CAR 0..+1</th>
            <th className="py-1 pr-2 text-right font-normal">t</th>
            <th className="py-1 font-normal">Hit rate</th>
          </tr>
        </thead>
        <tbody>
          {events.map((row) => {
            const active = row.event_key === selected
            const car = row.car_0_1
            const hit = row.hit_rate ?? 0
            return (
              <tr
                key={row.event_key}
                data-testid={`event-row-${row.event_key}`}
                onClick={() => onSelect(active ? null : row.event_key)}
                className={cn(
                  'cursor-pointer border-b border-border/30 last:border-0',
                  active ? 'bg-foreground/[0.07]' : 'hover:bg-foreground/[0.04]',
                )}
              >
                <td className="py-1.5 pr-2 text-xs">{row.type}</td>
                <td className="tnum py-1.5 pr-2 text-right font-mono text-[11px] text-muted-foreground">
                  {row.n}
                </td>
                <td className={cn('tnum py-1.5 pr-2 text-right font-mono text-xs',
                  car == null ? '' : car > 0 ? 'text-primary' : 'text-clay')}>
                  {car == null ? '—' : `${car > 0 ? '+' : ''}${(car * 1e4).toFixed(0)}bp`}
                </td>
                <td className="tnum py-1.5 pr-2 text-right font-mono text-[11px] text-muted-foreground">
                  {row.t?.toFixed(2) ?? '—'}
                  <span className={cn('ml-1',
                    significance(row.t) === 'ns' && 'text-muted-foreground/40')}>
                    {significance(row.t)}
                  </span>
                </td>
                <td className="py-1.5">
                  <div className="flex items-center gap-1.5">
                    <div className="relative h-1 w-16 rounded-full bg-foreground/10">
                      <div
                        className="h-1 rounded-full bg-foreground/45"
                        style={{ width: `${(hit * 100).toFixed(0)}%` }}
                      />
                      {/* The coin-flip line. */}
                      <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/30" />
                    </div>
                    <span className="tnum font-mono text-[10px] text-muted-foreground">
                      {row.hit_rate == null ? '—' : `${(hit * 100).toFixed(0)}%`}
                    </span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
        Abnormal return against the window's mean, cumulated over the release day
        and the next session. Click a row to mark those dates on the curve.
      </p>
    </>
  )
}
