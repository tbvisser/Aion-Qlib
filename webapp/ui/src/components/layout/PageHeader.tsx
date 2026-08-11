import type { ReactNode } from 'react'

/** Consistent page title block: title, one-line explanation, right-side actions. */
export function PageHeader({
  title,
  titleSlot,
  description,
  actions,
}: {
  title: string
  /**
   * Rendered in place of the heading text.
   *
   * For a page whose subject is a named thing the user owns — the builder's
   * strategy — where the name is the title *and* the field you edit it in.
   */
  titleSlot?: ReactNode
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 px-6 py-5">
      <div className="min-w-0">
        {titleSlot ?? <h1 className="text-lg font-semibold tracking-tight">{title}</h1>}
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
