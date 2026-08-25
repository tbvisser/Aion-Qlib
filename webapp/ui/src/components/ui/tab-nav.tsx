import { cn } from '@/lib/utils'

/**
 * The sticky page-level tab bar — a whole page changing subject, not a panel
 * changing mode.
 *
 * Lifted verbatim from the identical private `TabNav` functions in
 * PortfoliosPage and RosterPage (MacroDesk carried a third, inline copy). It
 * sits under the PageHeader, sticks through scroll, and blurs what passes
 * beneath it. For a mode switch *inside* a panel, use `Segmented`; for
 * switching the two halves of a rail, `RailTabs` — see the doctrine notes in
 * those files. This is the third and outermost tier: tabs that own the page
 * body.
 */
export function TabNav<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: readonly { key: T; label: string; count?: number }[]
  active: T
  onChange: (tab: T) => void
  className?: string
}) {
  return (
    <div className={cn('sticky top-0 z-20 border-b border-border/50 bg-background/80 px-6 py-2 backdrop-blur', className)}>
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/50 p-0.5">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={cn(
              'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active === tab.key
                ? 'bg-foreground/[0.07] text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {typeof tab.count === 'number' && (
              <span className="ml-1.5 text-micro text-muted-foreground/70 tabular-nums">{tab.count}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
