import { Fragment } from 'react'

import { AgendaEntryRow } from '@/components/inbox/AgendaEntryRow'
import { ReleaseDetailCard } from '@/components/inbox/ReleaseDetailCard'
import { TradeDetailCard } from '@/components/inbox/TradeDetailCard'
import { Panel } from '@/components/ui/panel'
import {
  entryUnread, sortWithinDay, type AgendaEntry, type InboxSelection,
} from '@/lib/agenda'
import { agendaDayLabel, isoWeekday } from '@/lib/macroFormat'

/**
 * The selected day's items — Edgewonk's right-hand panel, but for a day.
 * Rows are the same AgendaEntryRow the timeline used, so every honesty rule
 * (surprise needs both sides, month-end caveats, error hints) carries over.
 * Picking a row drops its detail card underneath the list.
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
  selection: InboxSelection
  onSelect: (key: string) => void
}) {
  const sorted = sortWithinDay(entries)
  const selectedKey = selection.kind === 'entry' ? selection.entryKey : null
  const selectedEntry = selectedKey
    ? sorted.find((entry) => entry.key === selectedKey) ?? null
    : null
  // Only releases and trades have a card worth opening; the rest say all they
  // have to say in the row itself, so no placeholder panel is rendered.
  const detail = selectedEntry ? detailCard(selectedEntry, today) : null
  // Past days beyond the recency lanes' reach: only releases are dependable
  // there, and an empty panel must not read as "nothing happened".
  const beyondCoverage = date < today && (floor === null || date < floor)

  return (
    <Panel title={agendaDayLabel(date, today)} hint={isoWeekday(date)} flush>
      <div>
        {sorted.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            Nothing recorded for this day.
          </p>
        ) : (
          sorted.map((entry) => (
            // The card opens under its own row, not under the list: a busy day
            // runs to forty prints, and a card at the bottom of that reads as
            // nothing having happened at all.
            <Fragment key={entry.key}>
              <AgendaEntryRow
                entry={entry}
                unread={entryUnread(entry, prevLastSeen)}
                today={today}
                isSelected={entry.key === selectedKey}
                onSelect={onSelect}
              />
              {entry.key === selectedKey && detail && (
                <div className="border-b border-border/30 bg-background/40 p-2">
                  {detail}
                </div>
              )}
            </Fragment>
          ))
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

/** The card a selected entry opens, or null where the row is the whole story. */
function detailCard(entry: AgendaEntry, today: string) {
  const { payload } = entry
  if (payload.kind === 'release') {
    return <ReleaseDetailCard release={payload.release} today={today} />
  }
  if (payload.kind === 'signal' || payload.kind === 'rebalance') {
    return <TradeDetailCard entry={entry} payload={payload} />
  }
  return null
}
