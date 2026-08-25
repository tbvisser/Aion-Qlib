import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The house empty state: a dashed border around the space the content would
 * occupy, and a sentence about how to fill it.
 *
 * Lifted verbatim from ArtifactsPage and ProjectsPage, which had the calmest
 * version of an idiom that existed in four shapes (dashed card, icon-in-square
 * — at two sizes on one page — bare paragraph, and a muted Notice standing in
 * for one). Dashed reads as "a place reserved", which is the honest claim; an
 * icon is allowed but optional because the sentence carries the meaning.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  /** One Button, already wired. */
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-dashed border-border/60 p-10 text-center', className)}>
      {Icon && <Icon className="mx-auto mb-3 h-5 w-5 text-muted-foreground/50" />}
      <p className="text-sm text-muted-foreground">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground/70">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}
