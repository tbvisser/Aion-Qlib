import { useState } from 'react'
import { LogOut, Moon, Sun } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/hooks/useTheme'

// Ported from Aion-RAG's components/UserMenu.tsx. `compact` renders only the
// avatar (for the 64px collapsed rail); the popover contents are identical.
interface UserMenuProps {
  email: string
  onSignOut: () => void
  isAdmin?: boolean
  compact?: boolean
}

function getInitials(email: string): string {
  const name = email.split('@')[0]
  const parts = name.split(/[._-]/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return name.slice(0, 2).toUpperCase()
}

function getDisplayName(email: string): string {
  const name = email.split('@')[0]
  return name
    .split(/[._-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getAvatarColor(email: string): string {
  const colors = [
    'bg-gradient-to-br from-orange-400 to-orange-600',
    'bg-gradient-to-br from-blue-400 to-blue-600',
    'bg-gradient-to-br from-emerald-400 to-emerald-600',
    'bg-gradient-to-br from-violet-400 to-violet-600',
    'bg-gradient-to-br from-pink-400 to-pink-600',
    'bg-gradient-to-br from-amber-400 to-amber-600',
    'bg-gradient-to-br from-rose-400 to-rose-600',
    'bg-gradient-to-br from-indigo-400 to-indigo-600',
  ]
  let hash = 0
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
}

export function UserMenu({ email, onSignOut, compact = false }: UserMenuProps) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const { theme, toggleTheme } = useTheme()

  const initials = getInitials(email)
  const displayName = getDisplayName(email)
  const avatarColor = getAvatarColor(email)

  const avatar = (
    <div
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${avatarColor} text-white text-xs font-semibold shadow-sm`}
    >
      {initials}
    </div>
  )

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            data-testid="user-menu"
            aria-label={displayName}
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-foreground/[0.04]"
          >
            {avatar}
          </button>
        ) : (
          <button
            data-testid="user-menu"
            className="flex h-9 w-full items-center gap-2.5 rounded-xl px-2 py-1 text-left transition-all duration-200 hover:bg-accent/50"
          >
            {avatar}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{displayName}</span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-56 border-border/50 bg-popover/95 p-1.5 backdrop-blur-sm"
        align="start"
        side="top"
      >
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
        <div className="my-1 h-px bg-border/50" />
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2.5 rounded-lg transition-colors hover:bg-accent/50"
          onClick={toggleTheme}
        >
          {theme === 'dark' ? (
            <Sun className="h-4 w-4 text-amber-400" />
          ) : (
            <Moon className="h-4 w-4 text-blue-400" />
          )}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </Button>
        <div className="my-1 h-px bg-border/50" />
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2.5 rounded-lg transition-colors hover:bg-destructive/10 hover:text-destructive"
          onClick={onSignOut}
        >
          <LogOut className="h-4 w-4" />
          Log out
        </Button>
      </PopoverContent>
    </Popover>
  )
}
