import { EntryList } from '@/components/agenda/EntryList'
import { Panel } from '@/components/ui/panel'
import { sortWithinDay, type AgendaEntry, type AgendaSelection } from '@/lib/agenda'
import { agendaDayLabel, isoWeekday } from '@/lib/macroFormat'

/**
 * The selected day's items — the calendar views' right-hand panel.
 *
 * Rows come from the shared `EntryList`, so every honesty rule the stream
 * follows (surprise needs both sides, month-end caveats, error hints) and the
 * inline card expansion behave identically here.
 */
export function DayDetail({
  date, entries, prevLastSeen, today, floor, selection, onSelect,
}: {
  date: string
  entries: AgendaEntry[]
  prevLastSeen: string | null
  today: string
  /** Oldest day the recency lanes still cover — see recencyFloor. */
  floor: string | null
  selection: AgendaSelection
  onSelect: (key: string) => void
}) {
  const sorted = sortWithinDay(entries)
  // Past days beyond the recency lanes' reach: only releases are dependable
  // there, and an empty panel must not read as "nothing happened".
  const beyondCoverage = date < today && (floor === null || date < floor)

  return (
    <Panel
      title={agendaDayLabel(date, today)}
      hint={isoWeekday(date)}
      actions={sorted.length > 0 ? (
        <span className="tnum font-mono text-[10px] text-muted-foreground/60">
          {sorted.length}
        </span>
      ) : undefined}
      flush
    >
      {/* Scrolls inside itself rather than growing the page. A US calendar day
          runs to forty prints, and an unbounded panel pushed the calendar this
          panel belongs to clean off the screen. */}
      <div className="max-h-[30rem] overflow-y-auto">
        {sorted.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Nothing recorded for this day.
          </p>
        ) : (
          <EntryList
            entries={sorted}
            prevLastSeen={prevLastSeen}
            today={today}
            selection={selection}
            onSelect={onSelect}
          />
        )}
        {beyondCoverage && (
          <p className="border-t border-border/30 px-3 py-2 text-[10px] text-muted-foreground/60">
            Only economic releases are shown this far back — the other lanes
            keep recent items only.
          </p>
        )}
      </div>
    </Panel>
  )
}
