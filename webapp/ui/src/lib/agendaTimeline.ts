/**
 * Pure layout math for the week timeline — kept DOM-free so lane assignment
 * and axis bucketing are testable without rendering.
 *
 * Wall clocks are taken only where honestly known: a release's cached `time`
 * string verbatim, or the local clock of an activity timestamp (the same
 * clocks `AgendaEntryRow` already shows). Anything without either goes to the
 * all-day lane — nothing is ever invented onto the axis.
 */
import type { AgendaEntry } from './agenda'

/** The visible axis: 06:00–22:00. Outside prints collapse into gutters. */
export const AXIS_START_MIN = 6 * 60
export const AXIS_END_MIN = 22 * 60

export interface TimelineItem {
  entry: AgendaEntry
  /** Minutes since midnight of the entry's wall clock. */
  startMin: number
}

export interface DayTimeline {
  timed: TimelineItem[]
  allDay: AgendaEntry[]
}

function minutesOf(entry: AgendaEntry): number | null {
  if (entry.time) {
    const match = /^(\d{1,2}):(\d{2})/.exec(entry.time)
    return match ? Number(match[1]) * 60 + Number(match[2]) : null
  }
  if (entry.timestamp) {
    const at = new Date(entry.timestamp)
    if (Number.isNaN(at.getTime())) return null
    return at.getHours() * 60 + at.getMinutes()
  }
  return null
}

export function timelineItems(entries: AgendaEntry[]): DayTimeline {
  const timed: TimelineItem[] = []
  const allDay: AgendaEntry[] = []
  for (const entry of entries) {
    const startMin = minutesOf(entry)
    if (startMin === null) allDay.push(entry)
    else timed.push({ entry, startMin })
  }
  timed.sort((a, b) => a.startMin - b.startMin || a.entry.key.localeCompare(b.entry.key))
  return { timed, allDay }
}

export function axisBucket(startMin: number): 'early' | 'axis' | 'late' {
  if (startMin < AXIS_START_MIN) return 'early'
  if (startMin >= AXIS_END_MIN) return 'late'
  return 'axis'
}

export interface TimelineCluster {
  startMin: number
  entries: AgendaEntry[]
}

/**
 * A macro morning drops twenty prints on the same minute, and twenty chips at
 * one y-offset is a smear rather than a chart. Identical start times collapse
 * into a single block that reports its own size — nothing is hidden, because
 * the day panel still lists every row underneath.
 */
export function clusterByStart(timed: TimelineItem[]): TimelineCluster[] {
  const byMin = new Map<number, AgendaEntry[]>()
  for (const item of timed) {
    const bucket = byMin.get(item.startMin)
    if (bucket) bucket.push(item.entry)
    else byMin.set(item.startMin, [item.entry])
  }
  return [...byMin.entries()]
    .map(([startMin, entries]) => ({ startMin, entries }))
    .sort((a, b) => a.startMin - b.startMin)
}

export interface LaneItem extends TimelineItem {
  lane: number
}

/**
 * Greedy lane assignment: two items closer than `slotMin` minutes overlap
 * visually, so they may not share a lane. A lane is reused the moment it
 * frees up, keeping the column as narrow as the day allows.
 */
export function assignLanes(timed: TimelineItem[], slotMin = 30): LaneItem[] {
  const laneFreeAt: number[] = []
  return [...timed]
    .sort((a, b) => a.startMin - b.startMin || a.entry.key.localeCompare(b.entry.key))
    .map((item) => {
      let lane = laneFreeAt.findIndex((freeAt) => item.startMin >= freeAt)
      if (lane === -1) {
        lane = laneFreeAt.length
        laneFreeAt.push(0)
      }
      laneFreeAt[lane] = item.startMin + slotMin
      return { ...item, lane }
    })
}
