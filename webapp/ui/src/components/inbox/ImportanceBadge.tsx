import { cn } from '@/lib/utils'

/**
 * Quiet by design: only a headline print earns a pill — tagging every row
 * "standard" would make the tag itself noise. The hue is the release
 * identity hue, not a verdict colour: importance is who you are, not how
 * you went.
 */
export function ImportanceBadge({ tier, className }: {
  tier?: 'headline' | 'standard' | 'low'
  className?: string
}) {
  if (tier !== 'headline') return null
  return (
    <span
      className={cn(
        'shrink-0 rounded bg-type-release/15 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-type-release',
        className,
      )}
    >
      headline
    </span>
  )
}
