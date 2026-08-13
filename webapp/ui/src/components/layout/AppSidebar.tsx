import { useCallback, useState } from 'react'
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed'
import { SidebarRail } from './SidebarRail'
import { SidebarPanel } from './SidebarPanel'
import type { SectionKey } from './NavItems'

/**
 * Sidebar in the Aion Platform's two-state form: a 64px icon rail that expands
 * to a 260px labeled panel. Collapsing is triggered by the header's panel
 * control — the wordmark beside it is a link home, as it reads.
 *
 * The nav search lives here rather than in the panel because the rail needs to
 * open it: clicking search while collapsed expands first, then focuses. Keeping
 * one piece of state above both halves is what makes that a single gesture.
 *
 * The platform's mobile off-canvas drawer is not ported — this app is
 * desktop-only, as it was before.
 */
export function AppSidebar({ activeSection }: { activeSection: SectionKey }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
  }, [])

  const openSearchFromRail = useCallback(() => {
    setCollapsed(false)
    setSearchOpen(true)
  }, [setCollapsed])

  return (
    <div data-testid="sidebar" className="flex h-full shrink-0">
      {collapsed ? (
        <SidebarRail
          activeSection={activeSection}
          onExpand={() => setCollapsed(false)}
          onSearch={openSearchFromRail}
        />
      ) : (
        <SidebarPanel
          activeSection={activeSection}
          onCollapse={() => {
            closeSearch()
            setCollapsed(true)
          }}
          searchOpen={searchOpen}
          query={query}
          onQueryChange={setQuery}
          onOpenSearch={() => setSearchOpen(true)}
          onCloseSearch={closeSearch}
        />
      )}
    </div>
  )
}
