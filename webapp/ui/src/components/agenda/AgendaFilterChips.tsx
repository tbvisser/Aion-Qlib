import { TYPE_STYLES } from '@/components/agenda/typeStyles'
import type { AgendaFilter, AgendaType } from '@/lib/agenda'
import { cn } from '@/lib/utils'

const CHIPS: { value: AgendaFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'release', label: 'Releases' },
  { value: 'process', label: 'Processes' },
  { value: 'trade', label: 'Trades' },
  { value: 'message', label: 'Messages' },
  { value: 'notification', label: 'Notifications' },
]

/**
 * The agenda's type filter. Counts are computed before filtering, so a chip
 * always says how much of the feed it represents — a filter that hides its
 * own denominator reads as "there is nothing else".
 */
export function AgendaFilterChips({ value, counts, onChange }: {
  value: AgendaFilter
  counts: Record<AgendaType, number>
  onChange: (next: AgendaFilter) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CHIPS.map((chip) => {
        const count = chip.value === 'all' ? null : counts[chip.value]
        const active = chip.value === value
        return (
          <button
            key={chip.value}
            type="button"
            onClick={() => onChange(chip.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
              active
                ? chip.value === 'all'
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : TYPE_STYLES[chip.value].filterActive
                : 'border-border/50 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                chip.value === 'all' ? 'bg-foreground/40' : TYPE_STYLES[chip.value].dot,
              )}
            />
            {chip.label}
            {count !== null && count > 0 && (
              <span className="tnum font-mono text-micro text-muted-foreground/70">
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
