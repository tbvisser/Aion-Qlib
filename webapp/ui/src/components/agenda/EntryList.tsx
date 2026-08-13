import { Fragment } from 'react'

import { AgendaEntryRow } from '@/components/agenda/AgendaEntryRow'
import { ReleaseDetailCard } from '@/components/agenda/ReleaseDetailCard'
import { TradeDetailCard } from '@/components/agenda/TradeDetailCard'
import { entryUnread, type AgendaEntry, type AgendaSelection } from '@/lib/agenda'

/**
 * A run of agenda rows, each able to open its detail card underneath itself.
 *
 * Shared by the day panel and the stream so the expansion behaves identically
 * in both — and so the "which entries have a card" decision lives in exactly
 * one place. The card opens under its own row rather than under the list: a
 * busy day runs to forty prints, and a card at the bottom of that reads as
 * nothing having happened at all.
 *
 * Entries arrive already sorted. Ordering is the caller's business — the day
 * panel sorts one day, the stream sorts within each of many.
 */
export function EntryList({ entries, prevLastSeen, today, selection, onSelect }: {
  entries: AgendaEntry[]
  prevLastSeen: string | null
  today: string
  selection: AgendaSelection
  onSelect: (key: string) => void
}) {
  const selectedKey = selection.kind === 'entry' ? selection.entryKey : null

  return (
    <>
      {entries.map((entry) => {
        const open = entry.key === selectedKey
        const detail = open ? entryDetail(entry, today) : null
        return (
          <Fragment key={entry.key}>
            <AgendaEntryRow
              entry={entry}
              unread={entryUnread(entry, prevLastSeen)}
              today={today}
              isSelected={open}
              onSelect={onSelect}
            />
            {detail && (
              // The house sub-block treatment, as used inside AlphaZoo's
              // expandable rows — not a card of its own.
              <div className="border-b border-border/30 px-3 py-3">
                <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-3">
                  {detail}
                </div>
              </div>
            )}
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * The card a selected entry opens, or null where the row is the whole story.
 * Only releases and trades have more to say; a process or a message would open
 * onto a placeholder, which is worse than not opening.
 */
export function entryDetail(entry: AgendaEntry, today: string) {
  const { payload } = entry
  if (payload.kind === 'release') {
    return <ReleaseDetailCard release={payload.release} today={today} />
  }
  if (payload.kind === 'signal' || payload.kind === 'rebalance') {
    return <TradeDetailCard entry={entry} payload={payload} />
  }
  return null
}

/** True when picking this row would open something. */
export function hasDetail(entry: AgendaEntry): boolean {
  const kind = entry.payload.kind
  return kind === 'release' || kind === 'signal' || kind === 'rebalance'
}
