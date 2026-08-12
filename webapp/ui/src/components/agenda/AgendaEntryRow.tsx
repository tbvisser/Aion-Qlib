import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import {
  Bell, CalendarClock, MessageSquare, RefreshCw, TrendingUp,
} from 'lucide-react'

import { ImportanceBadge } from '@/components/agenda/ImportanceBadge'
import { TYPE_STYLES } from '@/components/agenda/typeStyles'
import { RunStatusIcon, statusTextClass } from '@/components/runs/RunStatusIcon'
import { Badge } from '@/components/ui/badge'
import type { AgendaEntry, AgendaType } from '@/lib/agenda'
import type { MacroRelease } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Icon per type — the agenda's one legend. The hue comes from TYPE_STYLES
 * (identity); verdicts stay with `statusTextClass` and the surprise colours.
 */
const TYPE_ICON: Record<AgendaType, ComponentType<{ className?: string }>> = {
  release: CalendarClock,
  process: RefreshCw,
  trade: TrendingUp,
  message: MessageSquare,
  notification: Bell,
}

/** "…T10:35:59+00:00" → "10:35" for the row's right edge. */
function clock(iso: string | null): string | null {
  if (!iso) return null
  const at = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

const num = (v: number | null) => (v == null ? '—' : String(v))

export function AgendaEntryRow({ entry, unread, today, isSelected = false, onSelect }: {
  entry: AgendaEntry
  unread: boolean
  today: string
  isSelected?: boolean
  /** Omitted where rows are read-only — the row then stays a plain div. */
  onSelect?: (key: string) => void
}) {
  const Icon = TYPE_ICON[entry.type]
  const styles = TYPE_STYLES[entry.type]
  const selectable = onSelect != null

  // A row stays a div rather than a button: the title can hold a Link, and an
  // anchor nested in a button is invalid. role/tabIndex buy the keyboard back.
  return (
    <div
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? isSelected : undefined}
      onClick={selectable ? () => onSelect(entry.key) : undefined}
      onKeyDown={selectable
        ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(entry.key)
          }
        }
        : undefined}
      className={cn(
        'relative flex items-start gap-2.5 border-b border-border/30 px-3 py-2 last:border-0',
        unread && 'bg-primary/[0.06]',
        selectable && 'cursor-pointer transition-colors hover:bg-foreground/[0.03]',
        selectable && 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60',
        // A ring, never a bg-*: the unread tint owns the row's background.
        isSelected && 'ring-1 ring-inset ring-primary/50',
      )}
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.5', styles.rail)} />
      <span className="mt-0.5 flex shrink-0 items-center gap-1">
        <span className={cn('flex h-6 w-6 items-center justify-center rounded-md', styles.chipBg)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        {entry.payload.kind === 'activity' && (
          <RunStatusIcon status={entry.payload.item.status} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <Body entry={entry} today={today} />
      </div>
      <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
        {unread && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_5px_hsl(var(--primary)/0.6)]"
          />
        )}
        <span className="tnum font-mono text-[10px] text-muted-foreground/60">
          {entry.time ?? clock(entry.timestamp) ?? ''}
        </span>
      </span>
    </div>
  )
}

function TitleLine({ entry, children }: { entry: AgendaEntry; children?: React.ReactNode }) {
  const title = entry.href ? (
    // Navigating away should not also toggle the row's selection behind it.
    <Link
      to={entry.href}
      onClick={(event) => event.stopPropagation()}
      className="min-w-0 truncate transition-colors hover:text-primary"
    >
      {entry.title}
    </Link>
  ) : (
    <span className="min-w-0 truncate">{entry.title}</span>
  )
  return (
    <div className="flex items-baseline gap-2 text-sm">
      {title}
      {children}
    </div>
  )
}

function Body({ entry, today }: { entry: AgendaEntry; today: string }) {
  const { payload } = entry

  if (payload.kind === 'release') {
    return <ReleaseBody entry={entry} release={payload.release} today={today} />
  }

  if (payload.kind === 'activity') {
    const item = payload.item
    return (
      <>
        <TitleLine entry={entry}>
          <span className={cn('font-mono text-[10px] uppercase', statusTextClass(item.status))}>
            {item.status}
          </span>
        </TitleLine>
        {item.error && (
          <p className="text-xs text-destructive/90">
            {item.error}
            {item.error_hint && (
              <span className="text-muted-foreground"> — {item.error_hint}</span>
            )}
          </p>
        )}
      </>
    )
  }

  if (payload.kind === 'note') {
    return (
      <>
        <TitleLine entry={entry}>
          {entry.monthGranular && (
            <Badge variant="muted" className="shrink-0">month-end read</Badge>
          )}
        </TitleLine>
        {entry.detail && <p className="text-xs text-muted-foreground">{entry.detail}</p>}
      </>
    )
  }

  // signal · rebalance · thread: title plus a muted detail line.
  return (
    <>
      <TitleLine entry={entry} />
      {entry.detail && (
        <p className="truncate text-xs text-muted-foreground">{entry.detail}</p>
      )}
    </>
  )
}

/**
 * The desk's two honesty rules travel with the row: a surprise needs both
 * sides (the backend only fills `surprise` from actual − estimate), and a
 * past release with no actual reads "awaiting", never zero.
 *
 * Title above, figures below — the same two-line shape every other type uses.
 * These once shared one line with the country as a leading column, which held
 * up in a full-width panel and collapsed in a 340px one: "Core Inflation Rate"
 * truncated to "C…" while three figures kept their space beside it. The figures
 * are worth less than the name of the print.
 */
function ReleaseBody({ entry, release, today }: {
  entry: AgendaEntry
  release: MacroRelease
  today: string
}) {
  const awaiting = release.actual == null && release.date < today
  return (
    <>
      <TitleLine entry={entry}>
        {release.comparison && (
          <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/60">
            {release.comparison}
          </span>
        )}
        <ImportanceBadge tier={release.importance} />
      </TitleLine>
      <div className="flex items-baseline gap-2 font-mono text-[11px]">
        {release.country && (
          <span className="shrink-0 text-muted-foreground/70">{release.country}</span>
        )}
        {release.actual != null ? (
          <span
            className={cn('tnum', release.surprise != null
              && (release.surprise > 0 ? 'text-primary'
                : release.surprise < 0 ? 'text-clay' : 'text-muted-foreground'))}
          >
            act {num(release.actual)}
          </span>
        ) : awaiting ? (
          <span className="text-muted-foreground/60">awaiting</span>
        ) : null}
        <span className="tnum text-muted-foreground">est {num(release.estimate)}</span>
        <span className="tnum text-muted-foreground/60">prev {num(release.previous)}</span>
      </div>
    </>
  )
}
