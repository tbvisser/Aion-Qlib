import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, Moon, PanelLeftClose, Search, SlidersHorizontal, Sun, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useInbox } from '@/hooks/useInbox'
import { useTheme } from '@/hooks/useTheme'
import { UserMenu } from '@/components/UserMenu'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import {
  allNavSections,
  codeNavSections,
  moreNavSections,
  type NavItem,
  type NavSection,
  type SectionKey,
} from './NavItems'
import { SHELL_MODES, shellModeForPath, shellModeRoute, type ShellMode } from './shellMode'
import { cn } from '@/lib/utils'

interface SidebarPanelProps {
  activeSection: SectionKey
  onCollapse: () => void
  searchOpen: boolean
  query: string
  onQueryChange: (query: string) => void
  onOpenSearch: () => void
  onCloseSearch: () => void
}

/**
 * Expanded 260px sidebar. Structure, spacing and class strings are copied from
 * the Aion Platform's layout/SidebarPanel.tsx so the two render identically.
 *
 * Omitted from the original: the admin "System" section, which needs roles
 * this app does not have. The UserMenu and the inbox unread badge, both once
 * omitted for the same reason, are restored now that the app has auth and an
 * activity feed.
 *
 * Added since: a header row carrying the collapse and search controls beside
 * the wordmark, and the Home/Lab switch beneath it. The wordmark used to *be*
 * the collapse button, which meant the one element reading "go home" did the
 * opposite; collapsing now has its own control and says so.
 */
export function SidebarPanel({
  activeSection,
  onCollapse,
  searchOpen,
  query,
  onQueryChange,
  onOpenSearch,
  onCloseSearch,
}: SidebarPanelProps) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { theme, toggleTheme } = useTheme()
  const { user, signOut, isAdmin } = useAuth()
  const { unreadCount } = useInbox()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  const shellMode = shellModeForPath(pathname)
  const [moreOpen, setMoreOpen] = useState(false)

  // Search reaches every destination regardless of shell: narrowing the nav is
  // Code's job, but a search that could not find a page the app has would be a
  // search you have to remember the shape of the app to use.
  const base = useMemo(
    () => (shellMode === 'code' && !query.trim() ? codeNavSections : allNavSections),
    [shellMode, query],
  )

  // Filtering hides rows, never sections' identity: a section whose items all
  // fall away disappears with them rather than leaving an orphan heading.
  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return base
    return base
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => item.label.toLowerCase().includes(needle)),
      }))
      .filter((section) => section.items.length > 0)
  }, [base, query])

  // "More" only means anything in the Code shell, where the nav is short and
  // the rest of the platform is what is being held back.
  const showMore = shellMode === 'code' && !query.trim()

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
        {item.key === 'inbox' && unreadCount > 0 && (
          <span
            data-testid="sidebar-inbox-badge"
            className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
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

  const renderSection = (section: NavSection, options?: { hideHeading?: boolean }) => (
    <nav key={section.heading} className="px-2 pt-2">
      {!options?.hideHeading && (
        <p
          data-testid="sidebar-section-heading"
          className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
        >
          {section.heading}
        </p>
      )}
      {section.items.map(renderNavRow)}
    </nav>
  )

  return (
    <div
      data-testid="sidebar-panel"
      className="flex w-[260px] flex-col border-r border-border/50 bg-[#F5F3EE] dark:bg-surface-1"
    >
      {/* Header: the wordmark goes home; the two controls beside it collapse
          the panel and open the nav search. */}
      <div className="flex items-center justify-between border-b border-border/50 py-4 pl-[18px] pr-3">
        <a
          data-testid="sidebar-home"
          href="/dashboard"
          onClick={(event) => handleNavClick(event, '/dashboard')}
          onContextMenu={(event) => handleNavContextMenu(event, '/dashboard')}
          className="flex items-center justify-start transition-opacity hover:opacity-70"
          title="Aion home"
        >
          <img src="/brand/aion-wordmark-mint.svg" alt="AION" className="h-6" />
        </a>

        <div className="flex items-center gap-0.5">
          <button
            data-testid="sidebar-collapse"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            data-testid="sidebar-search-toggle"
            onClick={() => (searchOpen ? onCloseSearch() : onOpenSearch())}
            aria-label={searchOpen ? 'Close nav search' : 'Search the nav'}
            aria-expanded={searchOpen}
            title="Search the nav"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-foreground/[0.04] hover:text-foreground',
              searchOpen ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground',
            )}
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="px-2 pt-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              ref={searchRef}
              data-testid="sidebar-search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onCloseSearch()
              }}
              placeholder="Search the nav…"
              aria-label="Search the nav"
              className="h-8 pl-8 pr-8 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => onQueryChange('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Which half of the app you're in. A shortcut, not a filter — the nav
          below lists both halves either way. Hidden while searching, where the
          whole point is that the query reaches everything. */}
      {!searchOpen && (
        <div className="px-2 pt-2">
          <Segmented<ShellMode>
            data-testid="sidebar-shell-toggle"
            value={shellMode}
            stretch
            className="w-full"
            options={SHELL_MODES.map((mode) => ({
              value: mode.value,
              label: mode.label,
              icon: mode.icon,
              testId: `sidebar-shell-${mode.value}`,
            }))}
            onChange={(mode) => navigate(shellModeRoute(mode))}
          />
        </div>
      )}

      {/* One unified, scrollable nav unit: every section shares a single
          background and scrolls together as one whole. */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {/* The Code shell's list is short enough to read without a heading —
            "CODE" over three rows in a pane already labelled Code is noise. */}
        {sections.map((section) =>
          renderSection(section, { hideHeading: shellMode === 'code' && !query.trim() }),
        )}

        {sections.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Nothing matches “{query}”.
          </p>
        )}

        {showMore && (
          <>
            <nav className="px-2 pt-0.5">
              <button
                data-testid="sidebar-more"
                onClick={() => setMoreOpen((open) => !open)}
                aria-expanded={moreOpen}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
              >
                <ChevronDown
                  className={cn(
                    'h-4 w-4 shrink-0 transition-transform',
                    moreOpen ? 'rotate-0' : '-rotate-90',
                  )}
                />
                <span className="truncate">More</span>
              </button>
            </nav>
            {moreOpen && moreNavSections.map((section) => renderSection(section))}
          </>
        )}

        {/* Recents. The sessions themselves need a backend that isn't wired up
            yet, so this says what will fill it rather than pretending to be
            empty for the ordinary reason. */}
        {shellMode === 'code' && !query.trim() && (
          <div className="mt-4 px-2">
            <div className="flex items-center justify-between px-2.5 pb-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Recents
              </p>
              <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground/50" />
            </div>
            <p className="px-2.5 py-6 text-center text-xs text-muted-foreground/70">
              Sessions you start will show up here.
            </p>
          </div>
        )}
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
