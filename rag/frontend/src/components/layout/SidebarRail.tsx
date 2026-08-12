import type { MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PanelLeftOpen } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/useAuth'
import { navItems, type SectionKey } from './NavItems'
import { UserMenu } from '@/components/UserMenu'
import { cn } from '@/lib/utils'

interface SidebarRailProps {
  activeSection: SectionKey
  onExpand: () => void
}

// Layout note: collapsed nav items use square 36px hit targets, but keep the
// same left offset and icon padding as SidebarPanel so glyphs line up on toggle.
export function SidebarRail({ activeSection, onExpand }: SidebarRailProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, signOut, isAdmin } = useAuth()

  const openRouteInNewTab = (route: string) => {
    window.open(route, '_blank', 'noopener,noreferrer')
  }

  const handleNavClick = (event: MouseEvent<HTMLAnchorElement>, key: SectionKey, route: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    if (key === 'chat' && activeSection === 'chat' && location.pathname !== '/chat') {
      navigate(route)
      return
    }
    if (key === activeSection) {
      onExpand()
      return
    }
    // Different-section clicks keep the rail collapsed and navigate.
    navigate(route)
  }

  const handleNavContextMenu = (event: MouseEvent<HTMLAnchorElement>, route: string) => {
    event.preventDefault()
    openRouteInNewTab(route)
  }

  const handleSignOut = async () => {
    try { await signOut() } catch (err) { console.error('Sign out failed:', err) }
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        data-testid="sidebar-rail"
        className="flex w-16 flex-col border-r border-border/50 bg-[#F6F6F7] dark:bg-surface-1"
      >
        {/* Header: when collapsed the logo is replaced by an expand control
            that occupies the logo's exact 24x25 box, so toggling collapsed/
            expanded doesn't shift the alignment of the nav buttons below. */}
        <div className="flex items-center border-b border-border/50 px-4 pb-[19px] pt-[20px]">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="sidebar-expand"
                onClick={onExpand}
                aria-label="Expand sidebar"
                className="flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                style={{ height: 25, width: 24 }}
              >
                <PanelLeftOpen className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          </Tooltip>
        </div>

        {/* Nav icons */}
        <nav className="px-2 pt-2">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = item.key === activeSection
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <a
                    data-testid={`sidebar-nav-${item.key}`}
                    href={item.route}
                    aria-label={item.label}
                    onClick={(event) => handleNavClick(event, item.key, item.route)}
                    onContextMenu={(event) => handleNavContextMenu(event, item.route)}
                    className={cn(
                      'flex h-9 w-9 items-center rounded-lg px-2.5 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-accent text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                  </a>
                </TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            )
          })}
        </nav>

        {/* Spacer pushes user menu to the bottom */}
        <div className="flex-1" />

        {/* User menu — same bottom container as SidebarPanel. */}
        <div className="mt-auto border-t border-border/50 p-2">
          {user?.email && (
            <UserMenu email={user.email} onSignOut={handleSignOut} isAdmin={isAdmin} />
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
