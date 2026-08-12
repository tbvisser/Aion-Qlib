import { ChevronLeft, ChevronRight } from 'lucide-react'

import { NavButton } from '@/components/agenda/NavButton'
import { TYPE_STYLES } from '@/components/agenda/typeStyles'
import { Panel } from '@/components/ui/panel'
import type { AgendaEntry } from '@/lib/agenda'
import {
  assignLanes, axisBucket, clusterByStart, timelineItems,
  AXIS_END_MIN, AXIS_START_MIN, type TimelineCluster,
} from '@/lib/agendaTimeline'
import { addDaysIso, formatIsoDayMonth, isoWeekday } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

const HOUR_PX = 34
const AXIS_PX = ((AXIS_END_MIN - AXIS_START_MIN) / 60) * HOUR_PX
const LABEL_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22]
const CHIP_PX = 16

/**
 * One rule per hour. A background-image, so it survives tailwind-merge beside
 * the cell's background-colour — the same split MonthGrid's hatch relies on.
 */
const HOUR_RULES = 'bg-[repeating-linear-gradient(to_bottom,hsl(var(--border)/0.35)_0px,hsl(var(--border)/0.35)_1px,transparent_1px,transparent_34px)]'

const pad = (n: number) => String(n).padStart(2, '0')
const clockOf = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`
const topOf = (min: number) => ((min - AXIS_START_MIN) / 60) * HOUR_PX

interface DayLayout {
  date: string
  allDay: AgendaEntry[]
  early: AgendaEntry[]
  late: AgendaEntry[]
  clusters: { cluster: TimelineCluster; lane: number }[]
  laneCount: number
}

/**
 * Only prints with an honest wall clock reach the axis. Everything else —
 * month-end reads, threads, anything the backend never timed — sits in the
 * all-day band rather than being invented onto a plausible-looking hour.
 */
function layoutDay(date: string, entries: AgendaEntry[]): DayLayout {
  const { timed, allDay } = timelineItems(entries)
  const early: AgendaEntry[] = []
  const late: AgendaEntry[] = []
  const onAxis = timed.filter((item) => {
    const bucket = axisBucket(item.startMin)
    if (bucket === 'early') { early.push(item.entry); return false }
    if (bucket === 'late') { late.push(item.entry); return false }
    return true
  })

  const clusters = clusterByStart(onAxis)
  const laned = assignLanes(
    clusters.map((cluster) => ({ entry: cluster.entries[0], startMin: cluster.startMin })),
  )
  const laneOf = new Map(laned.map((item) => [item.startMin, item.lane]))

  return {
    date,
    allDay,
    early,
    late,
    clusters: clusters.map((cluster) => ({
      cluster,
      lane: laneOf.get(cluster.startMin) ?? 0,
    })),
    laneCount: Math.max(1, ...laned.map((item) => item.lane + 1)),
  }
}

/**
 * The week as a clock: seven columns over a 06:00–22:00 axis, so a glance
 * says when the week's load actually sits. Prints outside those hours keep
 * their own bands rather than being clamped onto the ends of the axis.
 */
export function WeekTimeline({
  week, entries, today, selectedDay, selectedKey,
  onSelectDay, onSelectEntry, onWeekChange, minDate, maxDate,
}: {
  week: string[]
  entries: AgendaEntry[]
  today: string
  selectedDay: string
  selectedKey: string | null
  onSelectDay: (iso: string) => void
  onSelectEntry: (key: string) => void
  onWeekChange: (anchor: string) => void
  minDate: string
  maxDate: string
}) {
  const byDay = new Map<string, AgendaEntry[]>()
  for (const entry of entries) {
    const bucket = byDay.get(entry.date)
    if (bucket) bucket.push(entry)
    else byDay.set(entry.date, [entry])
  }

  const days = week.map((date) => layoutDay(date, byDay.get(date) ?? []))
  const chipProps = { selectedKey, onSelectEntry, onSelectDay }

  return (
    <Panel
      title={`${formatIsoDayMonth(week[0])} – ${formatIsoDayMonth(week[6])}`}
      hint="Stacked prints share one block — pick a day to read every row below"
      flush
      actions={
        <div className="flex items-center gap-1">
          <NavButton
            label="Previous week"
            disabled={week[0] <= minDate}
            onClick={() => onWeekChange(addDaysIso(selectedDay, -7))}
          >
            <ChevronLeft className="h-4 w-4" />
          </NavButton>
          <NavButton
            label="Next week"
            disabled={week[6] >= maxDate}
            onClick={() => onWeekChange(addDaysIso(selectedDay, 7))}
          >
            <ChevronRight className="h-4 w-4" />
          </NavButton>
        </div>
      }
    >
      <div>
        <Band label="">
          {days.map((day) => (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelectDay(day.date)}
              className={cn(
                'flex flex-col items-center bg-card py-1 transition-colors hover:bg-foreground/[0.03]',
                day.date === selectedDay && 'ring-1 ring-inset ring-primary/70',
              )}
            >
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
                {isoWeekday(day.date)}
              </span>
              <span className={cn(
                'tnum font-mono text-[11px]',
                day.date === today ? 'font-medium text-primary' : 'text-foreground/80',
              )}>
                {Number(day.date.slice(8, 10))}
              </span>
            </button>
          ))}
        </Band>

        <GutterBand label="all day" days={days} pick={(d) => d.allDay} {...chipProps} />
        <GutterBand label={`pre ${pad(AXIS_START_MIN / 60)}`} days={days} pick={(d) => d.early} {...chipProps} />

        <div className="flex border-b border-border/30 last:border-0">
          <div className="relative w-14 shrink-0" style={{ height: AXIS_PX }}>
            {LABEL_HOURS.map((hour) => (
              <span
                key={hour}
                className="absolute right-1.5 -translate-y-1/2 font-mono text-[9px] text-muted-foreground/50"
                style={{ top: topOf(hour * 60) }}
              >
                {pad(hour)}
              </span>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-7 gap-px bg-border/40">
            {days.map((day) => (
              <div
                key={day.date}
                style={{ height: AXIS_PX }}
                className={cn(
                  'relative bg-card',
                  HOUR_RULES,
                  day.date === selectedDay && 'ring-1 ring-inset ring-primary/70',
                )}
              >
                {day.clusters.map(({ cluster, lane }) => (
                  <ClusterChip
                    key={cluster.startMin}
                    date={day.date}
                    cluster={cluster}
                    lane={lane}
                    laneCount={day.laneCount}
                    {...chipProps}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <GutterBand label={`post ${pad(AXIS_END_MIN / 60)}`} days={days} pick={(d) => d.late} {...chipProps} />
      </div>
    </Panel>
  )
}

/** The seven-column frame every band shares, with its own left-hand label. */
function Band({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex border-b border-border/30 last:border-0">
      <div className="w-14 shrink-0 whitespace-nowrap pr-1.5 pt-1 text-right font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">
        {label}
      </div>
      <div className="grid flex-1 grid-cols-7 gap-px bg-border/40">
        {children}
      </div>
    </div>
  )
}

/** An off-axis band — rendered only when some day in the week fills it. */
function GutterBand({ label, days, pick, selectedKey, onSelectEntry }: {
  label: string
  days: DayLayout[]
  pick: (day: DayLayout) => AgendaEntry[]
  selectedKey: string | null
  onSelectEntry: (key: string) => void
  onSelectDay: (iso: string) => void
}) {
  if (!days.some((day) => pick(day).length > 0)) return null
  return (
    <Band label={label}>
      {days.map((day) => (
        <div key={day.date} className="flex flex-col gap-px bg-card p-0.5">
          {pick(day).map((entry) => (
            <button
              key={entry.key}
              type="button"
              title={entry.title}
              onClick={() => onSelectEntry(entry.key)}
              className={cn(
                'block w-full truncate rounded px-1 text-left font-mono text-[9px] leading-[14px]',
                TYPE_STYLES[entry.type].chipBg,
                entry.key === selectedKey && 'ring-1 ring-inset ring-primary/70',
              )}
            >
              {entry.title}
            </button>
          ))}
        </div>
      ))}
    </Band>
  )
}

function ClusterChip({
  date, cluster, lane, laneCount, selectedKey, onSelectEntry, onSelectDay,
}: {
  date: string
  cluster: TimelineCluster
  lane: number
  laneCount: number
  selectedKey: string | null
  onSelectEntry: (key: string) => void
  onSelectDay: (iso: string) => void
}) {
  // A stack has no single entry to open, so it hands off to the day instead.
  const single = cluster.entries.length === 1 ? cluster.entries[0] : null
  const clock = clockOf(cluster.startMin)

  return (
    <button
      type="button"
      onClick={() => (single ? onSelectEntry(single.key) : onSelectDay(date))}
      title={single ? `${clock} ${single.title}` : `${cluster.entries.length} items at ${clock}`}
      style={{
        top: topOf(cluster.startMin),
        height: CHIP_PX,
        left: `${(lane / laneCount) * 100}%`,
        width: `calc(${100 / laneCount}% - 2px)`,
      }}
      className={cn(
        'absolute truncate rounded px-1 text-left font-mono text-[9px] leading-[15px]',
        TYPE_STYLES[cluster.entries[0].type].chipBg,
        single && single.key === selectedKey && 'ring-1 ring-inset ring-primary/70',
      )}
    >
      {single ? single.title : `${clock} · ${cluster.entries.length}`}
    </button>
  )
}
