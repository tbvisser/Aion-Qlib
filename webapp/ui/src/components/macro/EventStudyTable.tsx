import type { MacroEventRow } from '@/lib/api'
import { significance } from '@/lib/macroFormat'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
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
      <Table>
        <TableHead>
          <tr>
            <TableHeader>Release</TableHeader>
            <TableHeader numeric>n</TableHeader>
            <TableHeader numeric>CAR 0..+1</TableHeader>
            <TableHeader numeric>t</TableHeader>
            <TableHeader>Hit rate</TableHeader>
          </tr>
        </TableHead>
        <TableBody>
          {events.map((row) => {
            const active = row.event_key === selected
            const car = row.car_0_1
            const hit = row.hit_rate ?? 0
            return (
              <TableRow
                key={row.event_key}
                data-testid={`event-row-${row.event_key}`}
                onClick={() => onSelect(active ? null : row.event_key)}
                className={cn(active && 'bg-foreground/[0.07]')}
              >
                <TableCell className="text-xs">{row.type}</TableCell>
                <TableCell numeric className="font-mono text-label text-muted-foreground">
                  {row.n}
                </TableCell>
                <TableCell
                  numeric
                  className={cn('font-mono text-xs',
                    car == null ? '' : car > 0 ? 'text-primary' : 'text-clay')}
                >
                  {car == null ? '—' : `${car > 0 ? '+' : ''}${(car * 1e4).toFixed(0)}bp`}
                </TableCell>
                <TableCell numeric className="font-mono text-label text-muted-foreground">
                  {row.t?.toFixed(2) ?? '—'}
                  <span className={cn('ml-1',
                    significance(row.t) === 'ns' && 'text-muted-foreground/40')}>
                    {significance(row.t)}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <div className="relative h-1 w-16 rounded-full bg-foreground/10">
                      <div
                        className="h-1 rounded-full bg-foreground/45"
                        style={{ width: `${(hit * 100).toFixed(0)}%` }}
                      />
                      {/* The coin-flip line. */}
                      <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/30" />
                    </div>
                    <span className="tnum font-mono text-micro text-muted-foreground">
                      {row.hit_rate == null ? '—' : `${(hit * 100).toFixed(0)}%`}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <p className="mt-2 font-mono text-micro text-muted-foreground/70">
        Abnormal return against the window's mean, cumulated over the release day
        and the next session. Click a row to mark those dates on the curve.
      </p>
    </>
  )
}
