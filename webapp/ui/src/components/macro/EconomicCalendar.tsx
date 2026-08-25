import { Segmented } from '@/components/ui/segmented'
import { MicroLabel } from '@/components/ui/micro-label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import type { MacroCalendar, MacroRelease } from '@/lib/api'
import { formatIsoDayMonth, todayIso } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

const COUNTRIES = [
  { value: 'US', label: 'US' },
  { value: 'DE', label: 'DE' },
  { value: 'GB', label: 'GB' },
  { value: 'JP', label: 'JP' },
  { value: 'CN', label: 'CN' },
] as const

/**
 * Upcoming and recent economic releases.
 *
 * Two honesty rules live in the row renderer. A release with no `estimate`
 * shows `est —` and **no surprise arrow** — deriving a surprise from
 * `previous` would be a different statistic wearing the same label. And a past
 * release with no `actual` reads "awaiting", never zero.
 */
export function EconomicCalendar({
  calendar, country, onCountryChange, loading,
}: {
  calendar: MacroCalendar | null
  country: string
  onCountryChange: (country: string) => void
  loading?: boolean
}) {
  const today = todayIso()

  return (
    <div className={cn(loading && 'animate-subtle-pulse')}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Segmented
          value={country}
          options={COUNTRIES}
          onChange={onCountryChange}
          size="sm"
          data-testid="macro-calendar-country"
        />
        {calendar?.available && calendar.stale && (
          <span className="font-mono text-micro text-clay">cache is stale</span>
        )}
      </div>

      {!calendar ? (
        <div className="h-40" />
      ) : !calendar.available ? (
        <div className="rounded-lg border border-clay/40 bg-clay/5 p-3 text-sm">
          {calendar.reason ?? 'No economic calendar cached yet.'}
        </div>
      ) : (
        <div className="space-y-4">
          <Section
            title="Upcoming"
            rows={calendar.upcoming}
            today={today}
            empty={`No releases scheduled through ${formatIsoDayMonth(calendar.to)}.`}
          />
          <Section
            title="Recent"
            rows={[...calendar.past].reverse()}
            today={today}
            empty="No releases in the last three weeks."
            showActual
          />
        </div>
      )}
    </div>
  )
}

function Section({
  title, rows, today, empty, showActual,
}: {
  title: string
  rows: MacroRelease[]
  today: string
  empty: string
  showActual?: boolean
}) {
  return (
    <div>
      <MicroLabel as="div" className="mb-1">
        {title}
      </MicroLabel>
      {rows.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <Table>
            <TableHead>
              <tr>
                <TableHeader>Date</TableHeader>
                <TableHeader>Release</TableHeader>
                {showActual && (
                  <TableHeader numeric>Act</TableHeader>
                )}
                <TableHeader numeric>Est</TableHeader>
                <TableHeader numeric>Prev</TableHeader>
              </tr>
            </TableHead>
            <TableBody>
              {rows.slice(0, 60).map((row, i) => (
                <Row key={`${row.event_key}-${row.date}-${i}`} row={row} today={today} showActual={showActual} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

const num = (v: number | null) => (v == null ? '—' : String(v))

function Row({ row, today, showActual }: { row: MacroRelease; today: string; showActual?: boolean }) {
  // A surprise needs both sides. Never derived from `previous`.
  const surprise = row.actual != null && row.estimate != null ? row.actual - row.estimate : null
  const awaiting = showActual && row.actual == null && row.date < today

  return (
    <TableRow className="hover:bg-foreground/[0.04]">
      <TableCell className="whitespace-nowrap font-mono text-label text-muted-foreground">
        {formatIsoDayMonth(row.date)}
      </TableCell>
      <TableCell className="text-xs">
        <span className="truncate">{row.type}</span>
        {row.comparison && (
          <span className="ml-1 font-mono text-tiny uppercase text-muted-foreground/60">
            {row.comparison}
          </span>
        )}
      </TableCell>
      {showActual && (
        <TableCell
          numeric
          className={cn('font-mono text-label',
            surprise != null && (surprise > 0 ? 'text-primary' : surprise < 0 ? 'text-clay' : ''))}
        >
          {awaiting ? (
            <span className="text-muted-foreground/60">awaiting</span>
          ) : (
            num(row.actual)
          )}
        </TableCell>
      )}
      <TableCell numeric className="font-mono text-label text-muted-foreground">
        {num(row.estimate)}
      </TableCell>
      <TableCell numeric className="font-mono text-label text-muted-foreground/60">
        {num(row.previous)}
      </TableCell>
    </TableRow>
  )
}
