import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Moon, Sun } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { UserMenu } from '@/components/UserMenu'
import { allNavSections, type NavItem, type NavSection, type SectionKey } from './NavItems'
import { cn } from '@/lib/utils'

interface SidebarPanelProps {
  activeSection: SectionKey
  onCollapse: () => void
}

/**
 * Expanded 260px sidebar. Structure, spacing and class strings are copied from
 * the Aion Platform's layout/SidebarPanel.tsx so the two render identically.
 *
 * Omitted from the original: the UserMenu, the admin "System" section and the
 * inbox unread badge, all of which need auth this app does not have. The
 * bottom container the UserMenu occupied holds the theme toggle instead.
 */
export function SidebarPanel({ activeSection, onCollapse }: SidebarPanelProps) {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()
  const { user, signOut, isAdmin } = useAuth()

  const handleSignOut = async () => {
    try {
      await signOut()
    } catch (err) {
      console.error('Sign out failed:', err)
    }
  }

  const handleNavClick = (event: MouseEvent<HTMLAnchorElement>, route: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(route)
  }

  const handleNavContextMenu = (event: MouseEvent<HTMLAnchorElement>, route: string) => {
    event.preventDefault()
    window.open(route, '_blank', 'noopener,noreferrer')
  }

  const renderNavRow = (item: NavItem) => {
    const Icon = item.icon
    const isActive = item.key === activeSection
    // Unbuilt destinations still render, still navigate and still open in a new
    // tab on right-click — they land on the placeholder, which says what the
    // page will be. Dimming plus the chip is the whole distinction; marking the
    // row disabled would kill hover and take the affordance with it.
    const isSoon = !item.built
    return (
      <a
        key={item.key}
        data-testid={`sidebar-nav-${item.key}`}
        href={item.route}
        onClick={(event) => handleNavClick(event, item.route)}
        onContextMenu={(event) => handleNavContextMenu(event, item.route)}
        className={cn(
          // `h-9` matches the rail's nav button height (which has no
          // text span to drive line-height) so icons sit at the same y
          // when toggling collapsed/expanded.
          'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
          isActive
            ? 'bg-foreground/[0.07] text-foreground font-medium'
            : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
          isSoon && 'opacity-50'
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {/* min-w-0 so the truncating label yields to the chip rather than
            pushing it out of the 260px panel. */}
        <span className="min-w-0 truncate">{item.label}</span>
        {isSoon && (
          <span
            data-testid="sidebar-nav-soon"
            className="ml-auto shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70"
          >
            Soon
          </span>
        )}
      </a>
    )
  }

  const renderSection = (section: NavSection) => (
    <nav key={section.heading} className="px-2 pt-2">
      <p
        data-testid="sidebar-section-heading"
        className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
      >
        {section.heading}
      </p>
      {section.items.map(renderNavRow)}
    </nav>
  )

  return (
    <div
      data-testid="sidebar-panel"
      className="flex w-[260px] flex-col border-r border-border/50 bg-[#F5F3EE] dark:bg-surface-1"
    >
      {/* Header: logo doubles as collapse toggle */}
      <div className="flex items-center justify-between border-b border-border/50 py-4 pl-[18px] pr-4">
        <button
          data-testid="sidebar-collapse"
          onClick={onCollapse}
          className="flex items-center justify-start transition-opacity hover:opacity-70"
          title="Collapse sidebar"
        >
          <img src="/brand/aion-wordmark-mint.svg" alt="AION" className="h-6" />
        </button>
      </div>

      {/* One unified, scrollable nav unit: every section shares a single
          background and scrolls together as one whole. */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {allNavSections.map(renderSection)}
      </div>

      {/* Bottom container: the platform's UserMenu, restored now that the app
          has auth. The menu carries the theme toggle in its popover; the bare
          toggle remains as a fallback for the (gated-away) signed-out state. */}
      <div className="border-t border-border/50 p-2">
        {user?.email ? (
          <UserMenu email={user.email} onSignOut={handleSignOut} isAdmin={isAdmin} />
        ) : (
          <button
            data-testid="theme-toggle"
            onClick={toggleTheme}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
            <span className="truncate">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
        )}
      </div>
    </div>
  )
}
