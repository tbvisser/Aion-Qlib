import { MicroLabel } from '@/components/ui/micro-label'
import { cn } from '@/lib/utils'

export interface RosterStatTileProps {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  hint?: string
  /** `ok` steady mint · `active` pinging mint · `warning` pinging clay · `down` pinging red. */
  statusDot?: 'ok' | 'warning' | 'down' | 'active'
  className?: string
}

export function RosterStatTile({ icon, label, value, hint, statusDot, className }: RosterStatTileProps) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-xl border border-border/50 bg-card p-4 shadow-sm transition-shadow hover:shadow-card',
      className,
    )}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-foreground/[0.02] text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <MicroLabel as="div">{label}</MicroLabel>
          {statusDot && <StatusDot state={statusDot} />}
        </div>
        <div className="tnum text-xl font-semibold">{value}</div>
        {hint && <div className="truncate text-micro text-muted-foreground/60">{hint}</div>}
      </div>
    </div>
  )
}

// Token-only dots: healthy is the house mint, a degraded verdict is clay, a
// dead service is destructive — the notice.tsx three-tone doctrine, one pixel
// wide. `active` is "busy, and that is good news": mint, pinging.
function StatusDot({ state }: { state: 'ok' | 'warning' | 'down' | 'active' }) {
  return (
    <span className="relative flex h-2 w-2">
      {state === 'ok' && <span className="inline-flex h-2 w-2 rounded-full bg-primary" />}
      {state === 'active' && (
        <>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </>
      )}
      {state === 'warning' && (
        <>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-clay opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-clay" />
        </>
      )}
      {state === 'down' && (
        <>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
        </>
      )}
    </span>
  )
}
