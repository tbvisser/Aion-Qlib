import { useState } from 'react'
import { Building2, Check, LogOut, Moon, Plus, Sun, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/hooks/useTheme'
import { useOrg } from '@/hooks/useOrg'

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
  const { organizations, current, switchOrg, createOrg } = useOrg()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const onCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const org = await createOrg(name)
    setNewName('')
    setCreating(false)
    await switchOrg(org.id)
  }

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

        {/* Workspace. Lead with the name you are working in rather than the
            word "Organisation": which workspace your next strategy lands in is
            the fact that matters, and the label alone never told you. */}
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Workspace
        </div>
        {organizations.map((org) => (
          <Button
            key={org.id}
            variant="ghost"
            className="h-9 w-full justify-start gap-2.5 rounded-lg transition-colors hover:bg-accent/50"
            onClick={() => { if (org.id !== current?.id) void switchOrg(org.id) }}
          >
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{org.name}</span>
            {org.role !== 'member' && (
              <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                {org.role}
              </span>
            )}
            {org.id === current?.id && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
          </Button>
        ))}

        {creating ? (
          <div className="flex items-center gap-1 px-1 py-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onCreate()
                if (e.key === 'Escape') { setCreating(false); setNewName('') }
              }}
              placeholder="Workspace name"
              className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-sm outline-none focus:border-foreground/30"
            />
            <Button size="sm" className="h-8 shrink-0" onClick={() => void onCreate()}>
              Create
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            className="h-9 w-full justify-start gap-2.5 rounded-lg text-muted-foreground transition-colors hover:bg-accent/50"
            onClick={() => setCreating(true)}
          >
            <Plus className="h-4 w-4" />
            New workspace
          </Button>
        )}

        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2.5 rounded-lg transition-colors hover:bg-accent/50"
          onClick={() => { setPopoverOpen(false); navigate('/members') }}
        >
          <Users className="h-4 w-4 text-muted-foreground" />
          People
        </Button>

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
