import { CalendarDays, CalendarRange } from 'lucide-react'
import type { ComponentType } from 'react'

import type { InboxView } from '@/lib/agenda'
import { cn } from '@/lib/utils'

const VIEWS: { value: InboxView; label: string; Icon: ComponentType<{ className?: string }> }[] = [
  { value: 'month', label: 'Month', Icon: CalendarDays },
  { value: 'week', label: 'Week', Icon: CalendarRange },
]

/** Month for the shape of the load, week for when in the day it lands. */
export function ViewToggle({ value, onChange }: {
  value: InboxView
  onChange: (next: InboxView) => void
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-border/50 p-0.5">
      {VIEWS.map(({ value: option, label, Icon }) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cn(
            'flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors',
            option === value
              ? 'bg-primary/10 text-foreground'
              : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}
