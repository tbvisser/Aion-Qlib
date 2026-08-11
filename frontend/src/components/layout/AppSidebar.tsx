import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed'
import { useIsMobile } from '@/hooks/useIsMobile'
import { SidebarRail } from './SidebarRail'
import { SidebarPanel } from './SidebarPanel'
import { useMobileNav } from './MobileNavContext'
import type { SectionKey } from './NavItems'

interface AppSidebarProps {
  activeSection: SectionKey
  children: ReactNode
}

export function AppSidebar({ activeSection, children }: AppSidebarProps) {
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const isMobile = useIsMobile()
  const { open, setOpen } = useMobileNav()
  const location = useLocation()

  // Close the drawer whenever the route changes (e.g. a nav item or list item
  // was tapped). No-op on desktop.
  useEffect(() => {
    setOpen(false)
  }, [location.pathname, location.search, setOpen])

  // Close the drawer on Escape.
  useEffect(() => {
    if (!isMobile || !open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isMobile, open, setOpen])

  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        <div
          data-testid="mobile-nav-backdrop"
          className={`fixed inset-0 z-50 bg-black/50 transition-opacity lg:hidden ${
            open ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
        {/* Off-canvas drawer */}
        <div
          data-testid="mobile-nav-drawer"
          className={`fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] transition-transform duration-200 ease-out lg:hidden ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <SidebarPanel activeSection={activeSection} onCollapse={() => setOpen(false)} mobile>
            {children}
          </SidebarPanel>
        </div>
      </>
    )
  }

  return (
    <div data-testid="sidebar" className="flex h-full shrink-0">
      {collapsed ? (
        <SidebarRail activeSection={activeSection} onExpand={() => setCollapsed(false)} />
      ) : (
        <SidebarPanel activeSection={activeSection} onCollapse={() => setCollapsed(true)}>
          {children}
        </SidebarPanel>
      )}
    </div>
  )
}
