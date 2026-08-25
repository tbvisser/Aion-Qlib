import { useMemo, type MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PanelLeftOpen, Moon, Search, Sun } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/useAuth'
import { UserMenu } from '@/components/UserMenu'
import { useInbox } from '@/hooks/useInbox'
import { useTheme } from '@/hooks/useTheme'
import { allNavSections, codeNavSections, type NavItem, type SectionKey } from './NavItems'
import { SHELL_MODES, shellModeForPath } from './shellMode'
import { cn } from '@/lib/utils'

interface SidebarRailProps {
  activeSection: SectionKey
  onExpand: () => void
  /** Expand the rail and open the panel's nav search, in one click. */
  onSearch: () => void
}

// Layout note: collapsed nav items use square 36px hit targets, but keep the
// same left offset and icon padding as SidebarPanel so glyphs line up on toggle.
// Copied from the Aion Platform's layout/SidebarRail.tsx.
export function SidebarRail({ activeSection, onExpand, onSearch }: SidebarRailProps) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { theme, toggleTheme } = useTheme()
  const { user, signOut, isAdmin } = useAuth()
  const { unreadCount } = useInbox()

  // The rail has no "More" disclosure to hold the rest, so Code collapsed shows
  // its own rows first and then the platform's — narrowed, not cut off. Code
  // re-lists Artifacts and Inbox, so the second pass drops what the first
  // already showed: one glyph per destination, and one of each `data-testid`.
  const shellMode = shellModeForPath(pathname)
  const sections = useMemo(() => {
    if (shellMode !== 'code') return allNavSections
    const seen = new Set(codeNavSections.flatMap((s) => s.items.map((i) => i.key)))
    return [
      ...codeNavSections,
      ...allNavSections
        .map((section) => ({ ...section, items: section.items.filter((i) => !seen.has(i.key)) }))
        .filter((section) => section.items.length > 0),
    ]
  }, [shellMode])

  const handleSignOut = async () => {
    try {
      await signOut()
    } catch (err) {
      console.error('Sign out failed:', err)
    }
  }

  const handleNavClick = (event: MouseEvent<HTMLAnchorElement>, key: SectionKey, route: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    // Clicking the section you're already on expands the rail; anything else
    // navigates and stays collapsed.
    if (key === activeSection) {
      onExpand()
      return
    }
    navigate(route)
  }

  const handleNavContextMenu = (event: MouseEvent<HTMLAnchorElement>, route: string) => {
    event.preventDefault()
    window.open(route, '_blank', 'noopener,noreferrer')
  }

  const renderNavIcon = (item: NavItem) => {
    const Icon = item.icon
    const isActive = item.key === activeSection
    // 36px leaves no room for the panel's "Soon" chip, so collapsed rows carry
    // the same dimming and say it in the tooltip instead.
    const isSoon = !item.built
    const label = isSoon ? `${item.label} · Soon` : item.label
    return (
      <Tooltip key={item.key}>
        <TooltipTrigger asChild>
          <a
            data-testid={`sidebar-nav-${item.key}`}
            href={item.route}
            aria-label={label}
            onClick={(event) => handleNavClick(event, item.key, item.route)}
            onContextMenu={(event) => handleNavContextMenu(event, item.route)}
            className={cn(
              'relative flex h-9 w-9 items-center rounded-lg px-2.5 py-2 text-sm transition-colors',
              isActive
                ? 'bg-foreground/[0.07] text-foreground font-medium'
                : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
              isSoon && 'opacity-50'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.key === 'inbox' && unreadCount > 0 && (
              <span
                data-testid="sidebar-inbox-badge"
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-tiny font-medium text-primary-foreground"
              >
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </a>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        data-testid="sidebar-rail"
        className="flex w-16 flex-col border-r border-border/50 bg-surface-rail"
      >
        {/* Header: when collapsed the logo is replaced by an expand control
            that occupies the logo's exact 24x25 box, so toggling collapsed/
            expanded doesn't shift the alignment of the nav buttons below. */}
        {/* h-[68px] matches PageHeader's total (py-5 + text-lg line) so the
            sidebar border meets every page's header border. */}
        <div className="flex h-[68px] items-center border-b border-border/50 px-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="sidebar-expand"
                onClick={onExpand}
                aria-label="Expand sidebar"
                className="flex h-[25px] w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              >
                <PanelLeftOpen className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          </Tooltip>
        </div>

        {/* The panel's header controls, reduced to what fits in 64px: search
            (which expands first, since there is nowhere here to type) and the
            Home/Lab switch as two icons rather than a segmented control. */}
        <nav className="flex flex-col items-center gap-0.5 border-b border-border/50 px-2 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="sidebar-search-toggle"
                onClick={onSearch}
                aria-label="Search the nav"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
              >
                <Search className="h-4 w-4 shrink-0" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Search the nav</TooltipContent>
          </Tooltip>

          {SHELL_MODES.map((mode) => {
            const ModeIcon = mode.icon
            return (
              <Tooltip key={mode.value}>
                <TooltipTrigger asChild>
                  <button
                    data-testid={`sidebar-shell-${mode.value}`}
                    onClick={() => navigate(mode.route)}
                    aria-label={mode.label}
                    aria-pressed={shellMode === mode.value}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                      shellMode === mode.value
                        ? 'bg-foreground/[0.07] text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
                    )}
                  >
                    <ModeIcon className="h-4 w-4 shrink-0" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{mode.label}</TooltipContent>
              </Tooltip>
            )
          })}
        </nav>

        {/* One unified, scrollable nav unit — headings are omitted in the
            collapsed rail, so groups are separated by dividers and scroll
            together. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {sections.map((section, i) => (
            <nav
              key={section.heading}
              className={cn('px-2 py-2', i > 0 && 'border-t border-border/50')}
            >
              {section.items.map(renderNavIcon)}
            </nav>
          ))}
        </div>

        {/* Bottom container — same contents as SidebarPanel's: the UserMenu
            (compact, avatar-only) above the theme toggle. */}
        <div className="mt-auto border-t border-border/50 p-2">
          {user?.email && (
            <UserMenu
              email={user.email}
              onSignOut={handleSignOut}
              isAdmin={isAdmin}
              compact
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="theme-toggle"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
                className="flex h-9 w-9 items-center rounded-lg px-2.5 py-2 text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
              >
                {theme === 'dark' ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )
}
