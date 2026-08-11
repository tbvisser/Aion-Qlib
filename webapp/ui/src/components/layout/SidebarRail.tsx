import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { PanelLeftOpen, Moon, Sun } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTheme } from '@/hooks/useTheme'
import { allNavSections, type NavItem, type SectionKey } from './NavItems'
import { cn } from '@/lib/utils'

interface SidebarRailProps {
  activeSection: SectionKey
  onExpand: () => void
}

// Layout note: collapsed nav items use square 36px hit targets, but keep the
// same left offset and icon padding as SidebarPanel so glyphs line up on toggle.
// Copied from the Aion Platform's layout/SidebarRail.tsx.
export function SidebarRail({ activeSection, onExpand }: SidebarRailProps) {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()

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
              'flex h-9 w-9 items-center rounded-lg px-2.5 py-2 text-sm transition-colors',
              isActive
                ? 'bg-foreground/[0.07] text-foreground font-medium'
                : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
              isSoon && 'opacity-50'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
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
        className="flex w-16 flex-col border-r border-border/50 bg-[#F5F3EE] dark:bg-surface-1"
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

        {/* One unified, scrollable nav unit — headings are omitted in the
            collapsed rail, so groups are separated by dividers and scroll
            together. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {allNavSections.map((section, i) => (
            <nav
              key={section.heading}
              className={cn('px-2 py-2', i > 0 && 'border-t border-border/50')}
            >
              {section.items.map(renderNavIcon)}
            </nav>
          ))}
        </div>

        {/* Theme toggle — same bottom container as SidebarPanel. */}
        <div className="mt-auto border-t border-border/50 p-2">
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
