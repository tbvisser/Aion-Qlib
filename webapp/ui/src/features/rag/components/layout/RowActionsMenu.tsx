import type { ReactNode } from 'react'
import { MoreVertical } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface RowAction {
  label: string
  icon?: ReactNode
  onSelect: () => void
  destructive?: boolean
}

interface RowActionsMenuProps {
  actions: RowAction[]
  ariaLabel?: string
  className?: string
}

/**
 * Mobile-only ("⋯") overflow menu for list/tree rows. Touch devices can't
 * right-click, so this surfaces the same actions the desktop ContextMenu
 * offers. Rendered `lg:hidden` so the desktop experience is unchanged.
 */
export function RowActionsMenu({ actions, ariaLabel = 'Row actions', className }: RowActionsMenuProps) {
  if (actions.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          // Stop the row's own click/navigation from firing when opening the menu.
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground lg:hidden',
            className,
          )}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
        {actions.map((action, idx) => (
          <DropdownMenuItem
            key={idx}
            onClick={() => action.onSelect()}
            className={action.destructive ? 'text-destructive focus:text-destructive' : undefined}
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
