import { useEffect, useMemo, useState } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

// Copied verbatim from the Aion Platform's markets/DashboardMarketHoursWidget.tsx.
// Fully self-contained -- no API, no props; the only edit is the export name.

// Major exchange sessions, in local (IANA) time. Continuous-session model for v1.
// TODO: lunch breaks (TSE 11:30–12:30, HKEX 12:00–13:00) and market holidays are
// not modeled yet — acceptable for an at-a-glance widget.
type Exchange = {
  key: string
  city: string
  mic: string
  tz: string
  open: string // 'HH:MM' local
  close: string // 'HH:MM' local
  days: number[] // JS getDay() values; 1=Mon … 5=Fri
}

const EXCHANGES: Exchange[] = [
  { key: 'ny', city: 'New York', mic: 'NYSE', tz: 'America/New_York', open: '09:30', close: '16:00', days: [1, 2, 3, 4, 5] },
  { key: 'ln', city: 'London', mic: 'LSE', tz: 'Europe/London', open: '08:00', close: '16:30', days: [1, 2, 3, 4, 5] },
  { key: 'tk', city: 'Tokyo', mic: 'TSE', tz: 'Asia/Tokyo', open: '09:00', close: '15:30', days: [1, 2, 3, 4, 5] },
  { key: 'hk', city: 'Hong Kong', mic: 'HKEX', tz: 'Asia/Hong_Kong', open: '09:30', close: '16:00', days: [1, 2, 3, 4, 5] },
]

const WEEKDAY_TO_NUM: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

const MINS_PER_DAY = 24 * 60

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

type MarketStatus = {
  localTime: string
  isOpen: boolean
  /** e.g. "closes in 3h 12m" or "opens in 45m" */
  nextChange: string
}

/**
 * Derive the exchange-local wall-clock time and open/closed state from `now`.
 * Uses Intl.formatToParts (DST-safe) rather than raw Date math.
 */
export function computeMarketStatus(now: Date, ex: Exchange): MarketStatus {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ex.tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const weekdayNum = WEEKDAY_TO_NUM[get('weekday')] ?? 0
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  const localTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const nowMin = hour * 60 + minute

  const openMin = toMinutes(ex.open)
  const closeMin = toMinutes(ex.close)
  const isTradingDay = ex.days.includes(weekdayNum)
  const isOpen = isTradingDay && nowMin >= openMin && nowMin < closeMin

  let nextChange: string
  if (isOpen) {
    nextChange = `closes in ${formatDuration(closeMin - nowMin)}`
  } else if (isTradingDay && nowMin < openMin) {
    nextChange = `opens in ${formatDuration(openMin - nowMin)}`
  } else {
    // Roll forward to the next trading day's open.
    const minsUntilMidnight = MINS_PER_DAY - nowMin
    let total = 0
    for (let d = 1; d <= 7; d++) {
      const candidate = (weekdayNum + d) % 7
      if (ex.days.includes(candidate)) {
        total = minsUntilMidnight + (d - 1) * MINS_PER_DAY + openMin
        break
      }
    }
    nextChange = `opens in ${formatDuration(total)}`
  }

  return { localTime, isOpen, nextChange }
}

function MarketCell({ ex, now }: { ex: Exchange; now: Date }) {
  const { localTime, isOpen, nextChange } = computeMarketStatus(now, ex)
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-border/40 bg-card px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            isOpen ? 'bg-primary' : 'bg-muted-foreground/40',
          )}
        />
        <span className="text-xs font-medium text-foreground">{ex.city}</span>
      </div>
      <span className="font-mono text-sm tabular-nums text-foreground">{localTime}</span>
      <span
        className={cn(
          'text-[10px] font-semibold uppercase tracking-wide',
          isOpen ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
        )}
      >
        {isOpen ? 'Open' : 'Closed'}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{nextChange}</span>
    </div>
  )
}

export function MarketHoursWidget() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  const cells = useMemo(
    () => EXCHANGES.map((ex) => <MarketCell key={ex.key} ex={ex} now={now} />),
    [now],
  )

  return (
    <div className="animate-fade-in">
      <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Globe className="h-3.5 w-3.5" />
        Markets
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{cells}</div>
    </div>
  )
}
