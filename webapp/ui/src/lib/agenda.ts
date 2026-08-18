/**
 * The Agenda: five item types, one day-grouped timeline.
 *
 * Pure assembly over already-fetched sources, kept out of the page so vitest
 * can pin the rules. Two deliberate day conventions live here:
 *
 * - Calendar-dated things (releases, rebalances, signal dates) use their ISO
 *   date verbatim — never parsed through `new Date` (macroFormat's rule).
 * - Instants (a job's finished_at, a thread's updated_at) are bucketed onto
 *   the *viewer-local* day via `isoToLocalDay`, consistent with `todayIso()`
 *   being viewer-local. This differs from the old History panel, which sliced
 *   the UTC string.
 *
 * Regime flips are month-end reads and are pinned to their month's end (or
 * today, for the current month) with `monthGranular` set — the UI must carry
 * the caveat, never a fabricated intra-month timestamp.
 */
import type {
  ActivityItem, MacroRelease, PortfolioRebalances, RunStatus,
} from './api'
import type { RegimeFlip } from './inbox'
import { REGIME_LENS_LABELS } from './inbox'
import {
  addDaysIso, agendaDayLabel, isoToLocalDay, isoWeekday, mondayIndex,
  monthEndIso, todayIso,
} from './macroFormat'

export type AgendaType = 'release' | 'process' | 'trade' | 'message' | 'notification'

export const AGENDA_PAST_DAYS = 14
export const AGENDA_FUTURE_DAYS = 7

export interface SignalSnapshot {
  runId: string
  runTitle: string
  date: string
  top: { instrument: string; score: number | null }[]
}

export interface ThreadSummary {
  id: string
  title: string
  updated_at: string
}

export type AgendaPayload =
  | { kind: 'release'; release: MacroRelease }
  | { kind: 'activity'; item: ActivityItem }
  | { kind: 'signal'; signal: SignalSnapshot }
  | { kind: 'rebalance'; portfolioId: string; turnover: number | null }
  | { kind: 'thread'; threadId: string }
  | { kind: 'note'; note: 'flip' | 'restart' | 'stale'; flip?: RegimeFlip }

export interface AgendaEntry {
  key: string
  /** Grouping day, YYYY-MM-DD. */
  date: string
  /** Wall-clock only when honestly known (releases). */
  time: string | null
  /** Full ISO instant, for intra-day order and the unread rule. */
  timestamp: string | null
  type: AgendaType
  title: string
  detail?: string
  status?: RunStatus
  href?: string
  monthGranular?: boolean
  payload: AgendaPayload
}

export interface AgendaSources {
  activity: ActivityItem[]
  calendar: { past: MacroRelease[]; upcoming: MacroRelease[]; stale: boolean } | null
  flips: RegimeFlip[]
  signals: SignalSnapshot[]
  threads: ThreadSummary[]
  rebalances: PortfolioRebalances[]
}

const LIVE: ReadonlySet<RunStatus> = new Set(['running', 'queued'])

/** Inclusive ISO-date span an agenda view covers. */
export interface AgendaWindow {
  from: string
  to: string
}

export function defaultWindow(today: string = todayIso()): AgendaWindow {
  return {
    from: addDaysIso(today, -AGENDA_PAST_DAYS),
    to: addDaysIso(today, AGENDA_FUTURE_DAYS),
  }
}

/** In-flight work lives in the Now strip, never in a day group. */
export function splitInFlight(items: ActivityItem[]): {
  live: ActivityItem[]
  done: ActivityItem[]
} {
  return {
    live: items.filter((i) => LIVE.has(i.status)),
    done: items.filter((i) => !LIVE.has(i.status)),
  }
}

function inWindow(date: string, window: AgendaWindow): boolean {
  return date >= window.from && date <= window.to
}

function prettyState(state: string): string {
  return state.replace(/_/g, ' ')
}

export function buildAgendaEntries(
  sources: AgendaSources,
  today: string = todayIso(),
  window: AgendaWindow = defaultWindow(today),
): AgendaEntry[] {
  const entries: AgendaEntry[] = []

  // Finished work: ingest/macro jobs are plumbing (process); runs are the
  // outcome the desk actually trades on (trade).
  for (const item of splitInFlight(sources.activity).done) {
    const stamp = item.finished_at ?? item.created_at ?? item.started_at
    if (stamp === null) continue
    const day = isoToLocalDay(stamp)
    if (!inWindow(day, window)) continue
    entries.push({
      key: `act:${item.id}`,
      date: day,
      time: null,
      timestamp: stamp,
      type: item.kind === 'run' ? 'trade' : 'process',
      title: item.title,
      detail: item.error ?? undefined,
      status: item.status,
      href: item.kind === 'run' ? `/runs/${item.source_id}` : undefined,
      payload: { kind: 'activity', item },
    })
    if (item.restart_required) {
      entries.push({
        key: `note:restart:${item.id}`,
        date: day,
        time: null,
        timestamp: stamp,
        type: 'notification',
        title: 'Restart the API to load the new store',
        detail: 'The store was rebuilt, but this API process still serves the old one.',
        payload: { kind: 'note', note: 'restart' },
      })
    }
  }

  if (sources.calendar) {
    for (const release of [...sources.calendar.past, ...sources.calendar.upcoming]) {
      if (!inWindow(release.date, window)) continue
      entries.push({
        key: `rel:${release.event_key ?? release.type}:${release.country}:${release.date}:${release.time ?? ''}`,
        date: release.date,
        time: release.time,
        timestamp: null,
        type: 'release',
        title: release.type ?? release.event_key ?? 'release',
        detail: release.country ?? undefined,
        payload: { kind: 'release', release },
      })
    }
    if (sources.calendar.stale) {
      entries.push({
        key: 'note:stale',
        date: today,
        time: null,
        timestamp: null,
        type: 'notification',
        title: 'The economic-calendar cache is stale',
        detail: 'Refresh macro data to bring it current.',
        payload: { kind: 'note', note: 'stale' },
      })
    }
  }

  for (const signal of sources.signals) {
    if (!inWindow(signal.date, window)) continue
    entries.push({
      key: `sig:${signal.runId}`,
      date: signal.date,
      time: null,
      timestamp: null,
      type: 'trade',
      title: `Signals · ${signal.runTitle}`,
      detail: signal.top
        .slice(0, 5)
        .map((t) => t.instrument)
        .join(' · '),
      href: `/runs/${signal.runId}`,
      payload: { kind: 'signal', signal },
    })
  }

  for (const book of sources.rebalances) {
    for (const event of book.rebalances) {
      if (!inWindow(event.date, window)) continue
      entries.push({
        key: `reb:${book.portfolio_id}:${event.date}`,
        date: event.date,
        time: null,
        timestamp: null,
        type: 'trade',
        title: `${book.name} rebalanced to target`,
        detail: event.turnover != null
          ? `${book.rebalance} rule · turnover ${(event.turnover * 100).toFixed(1)}%`
          : `${book.rebalance} rule`,
        href: `/book/portfolios/${book.portfolio_id}`,
        payload: { kind: 'rebalance', portfolioId: book.portfolio_id, turnover: event.turnover },
      })
    }
  }

  for (const thread of sources.threads) {
    const day = isoToLocalDay(thread.updated_at)
    if (!inWindow(day, window)) continue
    entries.push({
      key: `msg:${thread.id}`,
      date: day,
      time: null,
      timestamp: thread.updated_at,
      type: 'message',
      title: thread.title || 'Untitled chat',
      href: `/chats/${thread.id}`,
      payload: { kind: 'thread', threadId: thread.id },
    })
  }

  // Only flips of the current or previous month are still news. A flip is a
  // month-end read: pin it to its month's end, or to today while the month is
  // still open — never an invented intra-month instant.
  const thisMonth = today.slice(0, 7)
  const prevMonth = addDaysIso(`${thisMonth}-01`, -1).slice(0, 7)
  for (const flip of sources.flips) {
    if (flip.month !== thisMonth && flip.month !== prevMonth) continue
    const monthEnd = monthEndIso(flip.month)
    entries.push({
      key: `note:flip:${flip.month}:${flip.lens}`,
      date: monthEnd > today ? today : monthEnd,
      time: null,
      timestamp: null,
      type: 'notification',
      title: `${REGIME_LENS_LABELS[flip.lens]}: ${prettyState(flip.from)} → ${prettyState(flip.to)}`,
      detail: `Regime flip, month-end read (${flip.month})`,
      monthGranular: true,
      payload: { kind: 'note', note: 'flip', flip },
    })
  }

  return entries
}

export interface AgendaDay {
  date: string
  label: string
  weekday: string
  entries: AgendaEntry[]
}

export function sortWithinDay(entries: AgendaEntry[]): AgendaEntry[] {
  return [...entries].sort((a, b) => {
    if (a.time !== null && b.time !== null && a.time !== b.time) {
      return a.time < b.time ? -1 : 1
    }
    if (a.time !== null && b.time === null) return -1
    if (a.time === null && b.time !== null) return 1
    if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
      return a.timestamp < b.timestamp ? -1 : 1
    }
    if (a.timestamp !== null && b.timestamp === null) return -1
    if (a.timestamp === null && b.timestamp !== null) return 1
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

/**
 * Today (always present, even empty — the agenda's anchor), then upcoming
 * days ascending, then past days descending. Empty non-today days are
 * omitted rather than rendered as noise.
 */
export function groupAgenda(entries: AgendaEntry[], today: string = todayIso()): {
  today: AgendaDay
  upcoming: AgendaDay[]
  earlier: AgendaDay[]
} {
  const byDay = new Map<string, AgendaEntry[]>()
  for (const entry of entries) {
    const bucket = byDay.get(entry.date) ?? []
    bucket.push(entry)
    byDay.set(entry.date, bucket)
  }

  const day = (date: string): AgendaDay => ({
    date,
    label: agendaDayLabel(date, today),
    weekday: isoWeekday(date),
    entries: sortWithinDay(byDay.get(date) ?? []),
  })

  const dates = [...byDay.keys()]
  return {
    today: day(today),
    upcoming: dates.filter((d) => d > today).sort().map(day),
    earlier: dates.filter((d) => d < today).sort().reverse().map(day),
  }
}

export type AgendaFilter = 'all' | AgendaType

export function filterEntries(entries: AgendaEntry[], filter: AgendaFilter): AgendaEntry[] {
  return filter === 'all' ? entries : entries.filter((e) => e.type === filter)
}

/**
 * Narrow by free text over what the row actually shows — its title and its
 * detail line. Deliberately not the payload: matching a run id or a country
 * code the reader cannot see would return rows with no visible reason for
 * being there. An empty or blank query is not a filter, and returns the input
 * untouched rather than nothing.
 */
export function searchEntries(entries: AgendaEntry[], query: string): AgendaEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => entry.title.toLowerCase().includes(needle)
    || (entry.detail?.toLowerCase().includes(needle) ?? false))
}

export function typeCounts(entries: AgendaEntry[]): Record<AgendaType, number> {
  const counts: Record<AgendaType, number> = {
    release: 0, process: 0, trade: 0, message: 0, notification: 0,
  }
  for (const entry of entries) counts[entry.type] += 1
  return counts
}

/**
 * Unread applies only to what feeds the sidebar badge — finished work and
 * notifications. Tinting a release or a chat thread would promise a tracking
 * the badge does not do.
 */
export function entryUnread(entry: AgendaEntry, prevLastSeen: string | null): boolean {
  if (entry.payload.kind !== 'activity' && entry.payload.kind !== 'note') return false
  if (prevLastSeen === null) return true
  return entry.timestamp !== null && entry.timestamp > prevLastSeen
}

// -- month grid ------------------------------------------------------------

/**
 * Monday-first weeks covering `month`: 4–6 rows of 7 ISO dates, including the
 * out-of-month cells that square the grid. Pure string/UTC arithmetic.
 */
export function monthGridWeeks(month: string): string[][] {
  const first = `${month}-01`
  const last = monthEndIso(month)
  let cursor = addDaysIso(first, -mondayIndex(first))
  const weeks: string[][] = []
  while (cursor <= last) {
    const week: string[] = []
    for (let i = 0; i < 7; i += 1) {
      week.push(cursor)
      cursor = addDaysIso(cursor, 1)
    }
    weeks.push(week)
  }
  return weeks
}

/** The inclusive span the grid actually shows — out-of-month cells included. */
export function gridRange(month: string): AgendaWindow {
  const weeks = monthGridWeeks(month)
  return { from: weeks[0][0], to: weeks[weeks.length - 1][6] }
}

/** Mon–Sun ISO dates of the week containing `dateIso`. */
export function weekOf(dateIso: string): string[] {
  const monday = addDaysIso(dateIso, -mondayIndex(dateIso))
  return Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i))
}

/**
 * The heat ladder: 0 quiet, 1 a print or two, 2 a real slate, 3 a headline
 * day (one headline print alone reaches tier 2, plus anything else tops out).
 */
export function heatTier(heat: number): 0 | 1 | 2 | 3 {
  if (heat <= 0) return 0
  if (heat <= 2) return 1
  if (heat <= 5) return 2
  return 3
}

/**
 * What the detail panel is looking at: the whole selected day, or one entry on
 * it. The view mode and the rest of the URL state live in `lib/agendaUrl` —
 * this is the half that can only be resolved against the rows on screen.
 */
export type AgendaSelection = { kind: 'day' } | { kind: 'entry'; entryKey: string }

/**
 * A selected entry only lives as long as its row does: changing the day or the
 * type filter can retire a key, and a selection pointing at a row that is no
 * longer on screen would strand an orphan detail card. Resolving against the
 * visible rows keeps the URL from outliving what it names.
 */
export function resolveSelection(
  entryKey: string | null,
  visible: AgendaEntry[],
): AgendaSelection {
  if (entryKey && visible.some((entry) => entry.key === entryKey)) {
    return { kind: 'entry', entryKey }
  }
  return { kind: 'day' }
}

export interface DaySummary {
  count: number
  byType: Record<AgendaType, number>
  /**
   * Verdict of the day's finished work — any failed activity item wins over
   * any succeeded one. Only activity entries vote: a release or a signal is
   * not an outcome, and must never tint a cell.
   */
  runOutcome: 'failed' | 'succeeded' | null
  /**
   * Importance-weighted release load — "how loud is the macro tape today",
   * not "how busy am I". Headline prints weigh 3, the rest 1; only releases
   * contribute, so a day of failed backtests never reads as a hot macro day.
   */
  heat: number
  /**
   * The one thing worth naming on this day, or null when nothing is. Only
   * headline prints earn it, so the month reads as a few marked days rather
   * than thirty identical labels.
   */
  marquee: string | null
  /** Distinct other headline names sharing the day — the marquee's "+N". */
  marqueeMore: number
}

/** Earliest by clock, then by key — a stable pick among equals. */
function leadOf(entries: AgendaEntry[]): AgendaEntry {
  return [...entries].sort(
    (a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.key.localeCompare(b.key),
  )[0]
}

/**
 * Counts, dots and the run verdict describe `entries` — whatever the type
 * filter currently admits. Heat is drawn from `heatFrom` instead, defaulting
 * to the same list: the macro load of a day is a fact about the calendar, not
 * about the filter, so a trades-only view still shows which days were loud.
 * A day can therefore carry heat with no visible rows at all.
 */
export function summarizeDays(
  entries: AgendaEntry[],
  heatFrom: AgendaEntry[] = entries,
): Map<string, DaySummary> {
  const out = new Map<string, DaySummary>()
  const byDay = new Map<string, AgendaEntry[]>()
  const blank = (): DaySummary => ({
    count: 0,
    byType: { release: 0, process: 0, trade: 0, message: 0, notification: 0 },
    runOutcome: null,
    heat: 0,
    marquee: null,
    marqueeMore: 0,
  })

  for (const entry of entries) {
    const summary = out.get(entry.date) ?? blank()
    summary.count += 1
    summary.byType[entry.type] += 1
    if (entry.payload.kind === 'activity') {
      const status = entry.payload.item.status
      if (status === 'failed') summary.runOutcome = 'failed'
      else if (status === 'succeeded' && summary.runOutcome !== 'failed') {
        summary.runOutcome = 'succeeded'
      }
    }
    out.set(entry.date, summary)

    const bucket = byDay.get(entry.date)
    if (bucket) bucket.push(entry)
    else byDay.set(entry.date, [entry])
  }

  // The marquee runs off the filtered list, so a trades-only view names a
  // trade. Days that exist only because of heat are never visited here, and
  // correctly keep a null marquee — they have no visible rows to name.
  for (const [date, summary] of out) {
    const dayEntries = byDay.get(date) ?? []
    const heads = dayEntries.filter(
      (e) => e.payload.kind === 'release' && e.payload.release.importance === 'headline',
    )
    if (heads.length > 0) {
      summary.marquee = leadOf(heads).title
      // Duplicate titles are the norm rather than the exception: the desk's
      // headline list is keyed on the comparison-qualified slug, so the MoM
      // and YoY cuts of one print are two rows under one name. Count names,
      // not rows, or a single print reads as a crowd.
      summary.marqueeMore = new Set(heads.map((e) => e.title)).size - 1
    } else if (!dayEntries.some((e) => e.payload.kind === 'release')) {
      // No releases in view at all: name whatever the day does have, so a
      // filtered month does not go silent everywhere.
      summary.marquee = dayEntries.length > 0 ? leadOf(dayEntries).title : null
    }
  }

  for (const entry of heatFrom) {
    if (entry.payload.kind !== 'release') continue
    const summary = out.get(entry.date) ?? blank()
    summary.heat += entry.payload.release.importance === 'headline' ? 3 : 1
    out.set(entry.date, summary)
  }
  return out
}

/**
 * The oldest day any recency-bounded lane (everything except releases) still
 * covers. Days before this are not provably empty — the feeds simply do not
 * reach back that far, and the UI must say so rather than imply silence.
 */
export function recencyFloor(entries: AgendaEntry[]): string | null {
  let floor: string | null = null
  for (const entry of entries) {
    if (entry.payload.kind === 'release') continue
    if (floor === null || entry.date < floor) floor = entry.date
  }
  return floor
}

/** Per-day counts for a dated list — the popover grid's dot markers. */
export function countByDate(rows: { date: string }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of rows) out.set(row.date, (out.get(row.date) ?? 0) + 1)
  return out
}

/** Terminal backtest outcomes over the trailing 30 viewer-local days. */
export function runStats30d(
  items: ActivityItem[],
  today: string = todayIso(),
): { succeeded: number; failed: number } {
  const floor = addDaysIso(today, -30)
  let succeeded = 0
  let failed = 0
  for (const item of items) {
    if (item.kind !== 'run') continue
    const stamp = item.finished_at ?? item.created_at
    if (stamp === null || isoToLocalDay(stamp) < floor) continue
    if (item.status === 'succeeded') succeeded += 1
    else if (item.status === 'failed') failed += 1
  }
  return { succeeded, failed }
}
