import { Segmented } from '@/components/ui/segmented'
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
          <span className="font-mono text-[10px] text-clay">cache is stale</span>
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
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/50 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                <th className="py-1 pr-2 font-normal">Date</th>
                <th className="py-1 pr-2 font-normal">Release</th>
                {showActual && (
                  <th className="py-1 pr-2 text-right font-normal">Act</th>
                )}
                <th className="py-1 pr-2 text-right font-normal">Est</th>
                <th className="py-1 text-right font-normal">Prev</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 60).map((row, i) => (
                <Row key={`${row.event_key}-${row.date}-${i}`} row={row} today={today} showActual={showActual} />
              ))}
            </tbody>
          </table>
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
    <tr className="border-b border-border/30 last:border-0 hover:bg-foreground/[0.04]">
      <td className="tnum whitespace-nowrap py-1 pr-2 font-mono text-[11px] text-muted-foreground">
        {formatIsoDayMonth(row.date)}
      </td>
      <td className="py-1 pr-2 text-xs">
        <span className="truncate">{row.type}</span>
        {row.comparison && (
          <span className="ml-1 font-mono text-[9px] uppercase text-muted-foreground/60">
            {row.comparison}
          </span>
        )}
      </td>
      {showActual && (
        <td className={cn('tnum py-1 pr-2 text-right font-mono text-[11px]',
          surprise != null && (surprise > 0 ? 'text-primary' : surprise < 0 ? 'text-clay' : ''))}>
          {awaiting ? (
            <span className="text-muted-foreground/60">awaiting</span>
          ) : (
            num(row.actual)
          )}
        </td>
      )}
      <td className="tnum py-1 pr-2 text-right font-mono text-[11px] text-muted-foreground">
        {num(row.estimate)}
      </td>
      <td className="tnum py-1 text-right font-mono text-[11px] text-muted-foreground/60">
        {num(row.previous)}
      </td>
    </tr>
  )
}
