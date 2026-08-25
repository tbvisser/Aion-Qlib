import { createElement } from 'react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The app's micro label — the uppercase mono eyebrow that names a metric, a
 * table column, a panel section.
 *
 * Before this existed, the class string below was pasted verbatim at 106 call
 * sites, with ~90 near-miss variants (`/60` instead of `/70`, mono beside
 * sans) that were drift rather than decisions. A label is a place, not a
 * string: divergence now has to be spelled out in `className`, which makes it
 * reviewable.
 *
 * Sans, not mono — the sidebar's own section labels set the house voice for
 * chrome, and mono is reserved for data: figures, expressions, identifiers.
 */
export function MicroLabel({
  as = 'span',
  className,
  title,
  children,
}: {
  /** `th`, `h3`, `div`, `label`, `dt` at call sites today. */
  as?: 'span' | 'div' | 'th' | 'h3' | 'label' | 'dt'
  className?: string
  title?: string
  children: ReactNode
}) {
  return createElement(
    as,
    {
      title,
      className: cn(
        'text-micro uppercase tracking-wider text-muted-foreground/70',
        className,
      ),
    },
    children,
  )
}
