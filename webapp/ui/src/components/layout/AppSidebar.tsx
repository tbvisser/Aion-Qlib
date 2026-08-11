import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed'
import { SidebarRail } from './SidebarRail'
import { SidebarPanel } from './SidebarPanel'
import type { SectionKey } from './NavItems'

/**
 * Sidebar in the Aion Platform's two-state form: a 64px icon rail that expands
 * to a 260px labeled panel. Collapsing is triggered by clicking the wordmark.
 *
 * The platform's mobile off-canvas drawer is not ported — this app is
 * desktop-only, as it was before.
 */
export function AppSidebar({ activeSection }: { activeSection: SectionKey }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed()

  return (
    <div data-testid="sidebar" className="flex h-full shrink-0">
      {collapsed ? (
        <SidebarRail activeSection={activeSection} onExpand={() => setCollapsed(false)} />
      ) : (
        <SidebarPanel activeSection={activeSection} onCollapse={() => setCollapsed(true)} />
      )}
    </div>
  )
}
