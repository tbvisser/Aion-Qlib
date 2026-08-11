import { cn } from '@/lib/utils'

/**
 * A titled section, tighter than a Card.
 *
 * `Card` spends 76px of vertical chrome per panel (24px header top padding, a
 * `text-sm` title, 24px body padding twice over). This is the Aion Platform's
 * macro chrome instead: a 1px-separated header bar at `px-3 py-2` carrying the
 * title, a hint, and the panel's own control — 55px, and it means a section
 * does not also need a separate heading above it.
 *
 * Two deliberate divergences from the source. `bg-card` rather than
 * `surface-1`: they resolve to identical HSL in both modes and one colour
 * should not have two names. And `bg-foreground/[0.02]` rather than
 * `bg-primary/[0.04]`: a mint wash on twenty header bars spends the app's only
 * accent on structure, and mint has to stay available to mean *state*.
 */
export function Panel({
  title, hint, actions, flush, loading, className, bodyClassName, children,
  'data-testid': testId,
}: {
  title: string
  /** A one-line explanation, beside the title. */
  hint?: string
  /** The panel's own control, right-aligned in the bar. */
  actions?: React.ReactNode
  /** Body padding off, for tables that supply their own. */
  flush?: boolean
  loading?: boolean
  className?: string
  bodyClassName?: string
  children: React.ReactNode
  /** Same escape hatch `RailRow` and `Segmented` offer, for the same reason. */
  'data-testid'?: string
}) {
  return (
    <section
      data-testid={testId}
      className={cn(
        'overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/50 bg-foreground/[0.02] px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {title}
          </h3>
          {hint && (
            <span className="truncate text-[10px] text-muted-foreground/60">{hint}</span>
          )}
        </div>
        {actions}
      </header>
      <div
        className={cn(
          flush ? 'p-0' : 'p-3',
          loading && 'animate-subtle-pulse',
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  )
}
