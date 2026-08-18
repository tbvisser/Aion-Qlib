import { cn } from '@/lib/utils'

const MICRO = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70'

export interface RosterStatTileProps {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  hint?: string
  statusDot?: 'ok' | 'warning' | 'down'
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
          <div className={MICRO}>{label}</div>
          {statusDot && <StatusDot state={statusDot} />}
        </div>
        <div className="tnum text-xl font-semibold">{value}</div>
        {hint && <div className="truncate text-[10px] text-muted-foreground/60">{hint}</div>}
      </div>
    </div>
  )
}

function StatusDot({ state }: { state: 'ok' | 'warning' | 'down' }) {
  return (
    <span className="relative flex h-2 w-2">
      {state === 'ok' && <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />}
      {state === 'warning' && (
        <>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
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
