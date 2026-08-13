import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * Quiet by design: only a headline print earns a pill — tagging every row
 * "standard" would make the tag itself noise.
 *
 * The shared `Badge` carries the shape; the hue is overridden to the release
 * identity hue because none of `Badge`'s variants is one. Deliberately not
 * `clay`: importance is who you are, not how you went, and clay is reserved
 * for a statistical verdict.
 */
export function ImportanceBadge({ tier, className }: {
  tier?: 'headline' | 'standard' | 'low'
  className?: string
}) {
  if (tier !== 'headline') return null
  return (
    <Badge className={cn('shrink-0 bg-type-release/15 text-type-release', className)}>
      headline
    </Badge>
  )
}
