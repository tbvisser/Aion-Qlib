/**
 * Whose this is, and who else can see it.
 *
 * Two facts the app had no way to express before everything became per-user:
 * that a record is yours, and that you have deliberately shared it with the
 * workspace. Both matter at a glance — a list mixing your drafts with a
 * colleague's shared work is confusing precisely when it looks uniform.
 *
 * Leads with the state, not the label: "Shared" and "From <colleague>" say what
 * you need, where a row reading "Visibility: org" would make you translate.
 * Private records show nothing at all — private is the default and the common
 * case, and a badge on every row would be noise rather than information.
 */
import { Lock, Users } from 'lucide-react'

import { useAuth } from '@/hooks/useAuth'

interface Owned {
  user_id?: string
  visibility?: 'private' | 'org'
}

/** True when the signed-in user may edit this record. */
export function useIsOwner(record: Owned | null | undefined): boolean {
  const { user } = useAuth()
  if (!record?.user_id || !user) return true // unknown ownership: do not disable
  return record.user_id === user.id
}

export function OwnershipBadge({
  record,
  className = '',
}: {
  record: Owned
  className?: string
}) {
  const { user } = useAuth()
  const mine = !record.user_id || record.user_id === user?.id
  const shared = record.visibility === 'org'

  if (mine && !shared) return null

  if (!mine) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ${className}`}
        title="Shared with your workspace by a colleague. You can read it and run it, but only its owner can change it."
      >
        <Users className="h-3 w-3" />
        From a colleague
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 ${className}`}
      title="Everyone in your workspace can see this. Only you can change it."
    >
      <Users className="h-3 w-3" />
      Shared
    </span>
  )
}

/** The toggle itself, for a menu or a detail header. */
export function ShareToggle({
  record,
  onChange,
  className = '',
}: {
  record: Owned
  onChange: (visibility: 'private' | 'org') => void
  className?: string
}) {
  const { user } = useAuth()
  const mine = !record.user_id || record.user_id === user?.id
  if (!mine) return null

  const shared = record.visibility === 'org'
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground ${className}`}
      onClick={() => onChange(shared ? 'private' : 'org')}
      title={
        shared
          ? 'Stop sharing this with your workspace'
          : 'Let everyone in your workspace see this'
      }
    >
      {shared ? <Users className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
      {shared ? 'Shared with workspace' : 'Private to you'}
    </button>
  )
}
