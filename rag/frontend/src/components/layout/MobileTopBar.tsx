import type { ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { useMobileNav } from './MobileNavContext'

interface MobileTopBarProps {
  /** Optional page-specific actions rendered on the right (e.g. workspace toggle). */
  rightSlot?: ReactNode
}

// Mobile-only top bar (hidden at `lg+`). Rendered in-flow as the first child of
// each page root, so on desktop it's removed entirely and the layout is
// unchanged. Hosts the hamburger that opens the off-canvas nav drawer.
export function MobileTopBar({ rightSlot }: MobileTopBarProps) {
  const { setOpen } = useMobileNav()

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-2 lg:hidden">
      <button
        data-testid="mobile-nav-toggle"
        onClick={() => setOpen(true)}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      {rightSlot && <div className="ml-auto flex items-center gap-1">{rightSlot}</div>}
    </header>
  )
}
