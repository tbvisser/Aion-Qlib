import { EntryList } from '@/components/agenda/EntryList'
import { Panel } from '@/components/ui/panel'
import { MicroLabel } from '@/components/ui/micro-label'
import { groupAgenda, type AgendaDay, type AgendaEntry, type AgendaSelection } from '@/lib/agenda'
import { agendaDayLabel } from '@/lib/macroFormat'

/**
 * The Agenda as a chronological stream: today, then what is coming, then back
 * through what happened.
 *
 * The two calendars answer "what shape is this month" and "when in the day".
 * This answers "what is next" — the question a list is simply better at, and
 * the one that needs no day to be picked first.
 *
 * The order is `groupAgenda`'s, which existed and was tested before this view
 * did: today is the anchor, upcoming days ascend from it, and past days descend
 * away. A flat ascending list opened a fortnight in the past, which is the
 * least useful thing the page could show first. The direction reverses once, so
 * it is announced — a reader watching dates climb and then fall with nothing
 * said would read it as a sorting bug.
 */
export function AgendaStream({
  entries, today, prevLastSeen, selection, onSelect, floor, query,
}: {
  /** Everything the filter and search admit, any order. */
  entries: AgendaEntry[]
  today: string
  prevLastSeen: string | null
  selection: AgendaSelection
  onSelect: (key: string) => void
  /** Oldest day the recency-bounded lanes reach; null when unbounded. */
  floor: string | null
  /** The active search, so an empty stream can say which of the two it is. */
  query: string
}) {
  const grouped = groupAgenda(entries, today)
  const total = entries.length

  const row = (day: AgendaDay) => (
    <DaySection
      key={day.date}
      day={day}
      today={today}
      prevLastSeen={prevLastSeen}
      selection={selection}
      onSelect={onSelect}
    />
  )

  return (
    <Panel
      title="Agenda"
      hint={total === 0 ? undefined : `${total} ${total === 1 ? 'item' : 'items'}`}
      flush
    >
      {total === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          {query ? <>Nothing matches “{query}”.</> : 'Nothing in this window.'}
        </p>
      ) : (
        <div>
          {row(grouped.today)}
          {grouped.upcoming.map(row)}
          {grouped.earlier.length > 0 && (
            <MicroLabel as="div" className="border-y border-border/50 bg-foreground/[0.02] px-3 py-1.5">
              Earlier
            </MicroLabel>
          )}
          {grouped.earlier.map(row)}
          {floor !== null && (
            <p className="border-t border-border/30 px-3 py-2 text-micro text-muted-foreground/60">
              Before {agendaDayLabel(floor, today)}, only economic releases are
              shown — the other lanes keep recent items only.
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}

function DaySection({ day, today, prevLastSeen, selection, onSelect }: {
  day: AgendaDay
  today: string
  prevLastSeen: string | null
  selection: AgendaSelection
  onSelect: (key: string) => void
}) {
  return (
    <section>
      {/* Sticky, so the day a row belongs to stays named while it scrolls. */}
      <header className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-border/50 bg-card/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex min-w-0 items-baseline gap-2">
          <h4 className="truncate font-mono text-micro uppercase tracking-wider text-foreground/80">
            {day.label}
          </h4>
          <span className="truncate text-micro text-muted-foreground/60">{day.weekday}</span>
        </div>
        {day.entries.length > 0 && (
          <span className="tnum shrink-0 font-mono text-micro text-muted-foreground/60">
            {day.entries.length}
          </span>
        )}
      </header>
      {day.entries.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Nothing recorded today.
        </p>
      ) : (
        <EntryList
          entries={day.entries}
          prevLastSeen={prevLastSeen}
          today={today}
          selection={selection}
          onSelect={onSelect}
        />
      )}
    </section>
  )
}
