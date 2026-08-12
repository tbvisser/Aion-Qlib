import type { MouseEvent, ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { brand } from '@/lib/brand'
import { navItems, type SectionKey } from './NavItems'
import { UserMenu } from '@/components/UserMenu'
import { cn } from '@/lib/utils'

interface SidebarPanelProps {
  activeSection: SectionKey
  onCollapse: () => void
  children: ReactNode
  /** When true the panel fills its container (drawer) and shows a close button. */
  mobile?: boolean
}

export function SidebarPanel({ activeSection, onCollapse, children, mobile = false }: SidebarPanelProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, signOut, isAdmin } = useAuth()
  const { theme } = useTheme()

  const openRouteInNewTab = (route: string) => {
    window.open(route, '_blank', 'noopener,noreferrer')
  }

  const handleLogoContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    openRouteInNewTab('/chat')
  }

  const handleNavClick = (event: MouseEvent<HTMLAnchorElement>, key: SectionKey, route: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    // On mobile, any nav tap also dismisses the drawer (covers the chat no-op
    // case where the route doesn't change and the close-on-route effect won't fire).
    if (mobile) onCollapse()
    if (key === 'chat' && location.pathname.startsWith('/chat')) return
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
    <div
      data-testid="sidebar-panel"
      className={cn(
        'flex flex-col border-r border-border/50 bg-[#F6F6F7] dark:bg-surface-1',
        mobile ? 'w-full' : 'w-[260px]'
      )}
    >
      {/* Header: logo doubles as collapse toggle */}
      <div className="flex items-center justify-between border-b border-border/50 p-4">
        <button
          data-testid="sidebar-collapse"
          onClick={onCollapse}
          onContextMenu={handleLogoContextMenu}
          className="transition-opacity hover:opacity-70"
          title={mobile ? 'Close menu' : 'Collapse sidebar'}
        >
          <img src={theme === 'dark' ? brand.logoDark : brand.logo} alt={brand.name} className="h-8" />
        </button>
        {mobile && (
          <button
            data-testid="mobile-nav-close"
            onClick={onCollapse}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label="Close navigation menu"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Nav rows */}
      <nav className="px-2 pt-2">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = item.key === activeSection
          return (
            <a
              key={item.key}
              data-testid={`sidebar-nav-${item.key}`}
              href={item.route}
              onClick={(event) => handleNavClick(event, item.key, item.route)}
              onContextMenu={(event) => handleNavContextMenu(event, item.route)}
              className={cn(
                // `h-9` matches the rail's nav button height (which has no
                // text span to drive line-height) so icons sit at the same y
                // when toggling collapsed/expanded.
                'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </a>
          )
        })}
      </nav>

      {/* Section content slot */}
      <div className="mt-2 flex-1 min-h-0 overflow-y-auto border-t border-border/50 pt-2">
        {children}
      </div>

      {/* User menu */}
      <div className="mt-auto border-t border-border/50 p-2">
        {user?.email && (
          <UserMenu email={user.email} onSignOut={handleSignOut} isAdmin={isAdmin} />
        )}
      </div>
    </div>
  )
}
